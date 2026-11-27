// Motor da Inteligência: só contas, sem tela e sem internet.
// Recebe os números do banco (rpc inteligencia_base) + cadastros do Painel e devolve previsões e sugestões.
// Nenhuma IA externa: cada sugestão vem de uma regra que dá para explicar em uma frase.

export const CFG_PADRAO = {
  ciclo_abastecimento: 3,   // de quantos em quantos dias a loja é abastecida
  prazo_fornecedor: 3,      // dias entre o pedido e a mercadoria chegar no CD
  ciclo_compra: 7,          // de quantos em quantos dias se faz compra
  seguranca: 2,             // dias de folga
  parado_dias: 30,          // sem venda há tantos dias = parado
  margem_alvo: 35,          // % de margem que o dono considera saudável
};

const DIA = 864e5;
const n = v => (v == null || v === '' ? 0 : +v);
const dt = s => new Date(s + 'T12:00:00');

export function analisar(base, cad, cfgIn = {}) {
  const cfg = { ...CFG_PADRAO, ...cfgIn };
  const hoje = dt(base.hoje);
  const lojas = cad.locais.filter(l => l.ativo !== false && l.tipo === 'loja');
  const cd = cad.locais.find(l => l.ativo !== false && l.tipo === 'cd');
  const prod = new Map(cad.produtos.map(p => [p.id, p]));
  const preco = new Map(cad.precos.map(p => [p.local_id + '|' + p.produto_id, p]));
  const custoNF = new Map((base.custos || []).map(c => [c.produto_id, c]));
  const custo = id => n(custoNF.get(id)?.custo) || n(prod.get(id)?.custo);

  // ---- histórico de cada loja: quantos dias de dados ela tem e o peso de cada dia da semana
  const infoLoja = new Map();
  for (const l of base.lojas || []) {
    const dias = Math.max(1, Math.round((hoje - dt(l.primeira)) / DIA) + 1);
    infoLoja.set(l.local_id, { dias: Math.min(dias, 90), primeira: l.primeira, tickets: n(l.tickets90) });
  }
  for (const [id, i] of infoLoja) {
    const sem = (base.semana || []).filter(s => s.local_id === id);
    const porDia = Array(7).fill(null);
    sem.forEach(s => { porDia[s.dow] = n(s.qtd) / Math.max(1, n(s.dias)); });
    const media = porDia.filter(v => v != null).reduce((a, b) => a + b, 0) / Math.max(1, porDia.filter(v => v != null).length);
    // só confia no dia da semana com 4 semanas ou mais de dados; fator entre 0,5 e 1,8 para não exagerar
    i.fator = porDia.map(v => (i.dias >= 28 && v != null && media > 0 ? Math.min(1.8, Math.max(0.5, v / media)) : 1));
  }

  // ---- saldo: o do PagNow quando a loja já tem movimento; senão a foto do SAC
  const saldoReal = new Map(), locComMov = new Set();
  for (const s of base.saldos || []) { saldoReal.set(s.local_id + '|' + s.produto_id, n(s.saldo)); locComMov.add(s.local_id); }
  const sac = cad.sacEstoque || null; // { data, itens: [[local_id, produto_id, qtd]] }
  const saldoSac = new Map((sac?.itens || []).map(([l, p, q]) => [l + '|' + p, n(q)]));
  const locSac = new Set((sac?.itens || []).map(x => x[0]));
  const saldoBruto = (l, p) => {
    const k = l + '|' + p;
    if (locComMov.has(l)) return { q: saldoReal.get(k) ?? 0, fonte: 'pagnow' };
    if (locSac.has(l)) { const q = saldoSac.get(k) ?? 0; return { q: Math.max(0, q), fonte: 'sac', negativo: q < 0 }; }
    return { q: null, fonte: null };
  };
  // confiança do estoque de cada local: entre os produtos que vendem ali, quantos têm saldo positivo.
  // Se menos da metade, o estoque não está sendo controlado (ex.: SAC só baixava a venda) e a previsão usa só o ritmo.
  const confianca = new Map();
  const saldoDe = (l, p) => {
    const s = saldoBruto(l, p);
    if (s.q != null && confianca.get(l)?.ok === false) return { q: null, fonte: 'incerto', bruto: s.q };
    return s;
  };

  // ---- ritmo de venda por loja e produto
  const vendas = new Map();
  for (const v of base.produtos || []) vendas.set(v.local_id + '|' + v.produto_id, v);
  const ritmo = (l, p) => {
    const v = vendas.get(l + '|' + p), i = infoLoja.get(l);
    if (!v || !i) return 0;
    const d = i.dias, r7 = n(v.q7) / Math.min(7, d), r28 = n(v.q28) / Math.min(28, d), r90 = n(v.q90) / Math.min(90, d);
    if (d < 7) return r90;
    if (d < 28) return 0.6 * r7 + 0.4 * r90;
    return 0.5 * r7 + 0.3 * r28 + 0.2 * r90;
  };
  // em quantos dias acaba, andando dia a dia com o peso do dia da semana
  const diasAte = (saldo, r, fator) => {
    if (r <= 0) return Infinity;
    if (saldo <= 0) return 0;
    let resto = saldo;
    for (let k = 1; k <= 120; k++) {
      const dow = new Date(hoje.getTime() + k * DIA).getDay();
      resto -= r * (fator ? fator[dow] : 1);
      if (resto <= 0) return k;
    }
    return 121;
  };

  const vendeEm = new Map();
  for (const v of base.produtos || []) if (n(v.q90) > 0) (vendeEm.get(v.local_id) ?? vendeEm.set(v.local_id, new Set()).get(v.local_id)).add(v.produto_id);
  const todosVendidos = new Set((base.produtos || []).filter(v => n(v.q90) > 0).map(v => v.produto_id));
  for (const l of cad.locais) {
    const alvo = l.tipo === 'cd' ? todosVendidos : (vendeEm.get(l.id) || new Set());
    let com = 0, tot = 0;
    for (const pid of alvo) { const s = saldoBruto(l.id, pid); if (s.q == null) continue; tot++; if (s.q > 0) com++; }
    if (tot) confianca.set(l.id, { ok: com / tot >= 0.5, com, tot });
  }

  // ---- curva ABC e frequência (rede toda) => "não pode faltar"
  const porProd = new Map();
  for (const v of base.produtos || []) {
    const a = (porProd.get(v.produto_id) ?? { bruto: 0, q90: 0, dias: 0, lojas: new Set(), ultima: null });
    a.bruto += n(v.bruto90); a.q90 += n(v.q90); a.dias = Math.max(a.dias, n(v.dias_com_venda)); a.lojas.add(v.local_id);
    if (!a.ultima || v.ultima > a.ultima) a.ultima = v.ultima;
    porProd.set(v.produto_id, a);
  }
  const totalBruto = [...porProd.values()].reduce((s, a) => s + a.bruto, 0);
  const diasRede = Math.max(1, ...[...infoLoja.values()].map(i => i.dias));
  let acum = 0;
  const abc = new Map();
  [...porProd.entries()].sort((a, b) => b[1].bruto - a[1].bruto).forEach(([id, a]) => {
    acum += a.bruto; abc.set(id, totalBruto && acum / totalBruto <= 0.8 ? 'A' : totalBruto && acum / totalBruto <= 0.95 ? 'B' : 'C');
  });
  const essenciaisMao = new Set(cfg.essenciais || []);
  const essencial = new Map();
  for (const [id, a] of porProd) {
    const motivos = [];
    if (abc.get(id) === 'A') motivos.push('está entre os que mais faturam');
    if (a.dias / diasRede >= 0.6) motivos.push('vende quase todo dia');
    if (essenciaisMao.has(id)) motivos.push('marcado por você');
    if (motivos.length) essencial.set(id, motivos);
  }
  for (const id of essenciaisMao) if (!essencial.has(id) && prod.has(id)) essencial.set(id, ['marcado por você']);

  // ---- previsão por loja
  const itensLoja = [];
  for (const l of lojas) {
    const i = infoLoja.get(l.id);
    const mix = cad.precos.filter(p => p.local_id === l.id && p.ativo_no_mix);
    for (const pl of mix) {
      const p = prod.get(pl.produto_id);
      if (!p || p.ativo === false) continue;
      const r = ritmo(l.id, p.id), s = saldoDe(l.id, p.id), v = vendas.get(l.id + '|' + p.id);
      const dias = s.q == null ? null : diasAte(s.q, r, i?.fator);
      const max = n(pl.estoque_max), min = n(pl.estoque_min);
      // parou de vender: vendia bem antes e zerou na última semana = provável falta na prateleira
      const dPrev = i ? Math.min(90, i.dias) - 7 : 0;
      const rPrev = v && dPrev >= 14 ? (n(v.q90) - n(v.q7)) / dPrev : 0;
      const sumiu = !!v && n(v.q7) === 0 && rPrev * 7 >= 3 && (s.q == null || s.q <= 0);
      let status = 'ok';
      if (sumiu) status = 'sumiu';
      else if (s.q == null) status = 'sem_saldo';
      else if (r > 0 && s.q <= 0) status = 'falta';
      else if (r > 0 && dias <= cfg.ciclo_abastecimento) status = 'acaba';
      else if (r === 0 && i && i.dias >= cfg.parado_dias && s.q > 0) status = 'parado';
      const alvo = Math.max(max, Math.ceil(r * (cfg.ciclo_abastecimento + cfg.seguranca)));
      // sem saldo confiável: repõe o que foi vendido no ciclo (modo "pelo que foi vendido")
      const levar = s.q == null ? Math.ceil((sumiu ? rPrev : r) * cfg.ciclo_abastecimento) : Math.max(0, Math.ceil(alvo - s.q));
      // aprende o mín/máx: falta antes do próximo abastecimento => sobe; sobra para mais de um mês => desce
      let ajuste = null;
      const ideal = Math.ceil(r * (cfg.ciclo_abastecimento + cfg.seguranca));
      if (r > 0 && max > 0 && ideal > max) ajuste = { tipo: 'subir', de: max, para: ideal };
      else if (r > 0 && max > 0 && i && i.dias >= 28 && max > r * 30 && max - Math.max(ideal, min) >= 3) ajuste = { tipo: 'descer', de: max, para: Math.max(ideal, min, 1) };
      else if (r > 0 && !max) ajuste = { tipo: 'definir', de: 0, para: Math.max(ideal, 1) };
      itensLoja.push({
        loja: l, p, r, rPrev, saldo: s.q, fonte: s.fonte, negativo: !!s.negativo, dias, status, min, max, levar, ajuste,
        quando: Number.isFinite(dias) && dias != null ? new Date(hoje.getTime() + dias * DIA) : null,
        preco: n(pl.preco), custo: custo(p.id), q90: n(v?.q90), ultima: v?.ultima || null,
        essencial: essencial.get(p.id) || null, abc: abc.get(p.id) || null,
      });
    }
  }

  // ---- CD: consumo da rede, cobertura e compra sugerida
  const compra = [];
  if (cd) {
    const consumo = new Map(), saldoLojas = new Map();
    for (const it of itensLoja) {
      consumo.set(it.p.id, (consumo.get(it.p.id) || 0) + it.r);
      saldoLojas.set(it.p.id, (saldoLojas.get(it.p.id) || 0) + Math.max(0, it.saldo || 0));
    }
    for (const [pid, r] of consumo) {
      if (r <= 0) continue;
      const p = prod.get(pid), s = saldoDe(cd.id, pid);
      if (s.fonte === 'incerto' || s.q == null) continue; // sem estoque confiável no CD não dá para sugerir compra
      const saldoCD = s.q;
      const cobre = diasAte(saldoCD, r, null);
      const alvo = r * (cfg.prazo_fornecedor + cfg.ciclo_compra + cfg.seguranca);
      const falta = alvo - saldoCD;
      const fator = Math.max(1, n(p.fator_embalagem) || 1);
      const urgente = cobre <= cfg.prazo_fornecedor + cfg.seguranca;
      if (falta <= 0 && !urgente) continue;
      const qtd = Math.max(fator, Math.ceil(Math.max(falta, 0) / fator) * fator);
      compra.push({
        p, r, saldoCD, saldoLojas: saldoLojas.get(pid) || 0, cobre, qtd, caixas: qtd / fator, fator,
        custo: custo(pid), valor: qtd * custo(pid), urgente, fonte: s.fonte,
        fornecedor: custoNF.get(pid)?.fornecedor || null, essencial: essencial.get(pid) || null,
      });
    }
    compra.sort((a, b) => (b.urgente - a.urgente) || (a.cobre - b.cobre) || (b.valor - a.valor));
  }

  // ---- parados e candidatos a sair do portfólio
  const parados = itensLoja.filter(x => x.status === 'parado').map(x => ({ ...x, preso: x.saldo * x.custo }));
  const semVendaRede = [];
  if (diasRede >= cfg.parado_dias) {
    const noMix = new Map();
    for (const it of itensLoja) {
      const a = (noMix.get(it.p.id) ?? { p: it.p, lojas: 0, saldo: 0, preso: 0, vendeu: false });
      a.lojas++; a.saldo += Math.max(0, it.saldo || 0); a.preso += Math.max(0, it.saldo || 0) * it.custo;
      if (it.q90 > 0) a.vendeu = true;
      noMix.set(it.p.id, a);
    }
    for (const a of noMix.values()) if (!a.vendeu) semVendaRede.push(a);
    semVendaRede.sort((a, b) => b.preso - a.preso);
  }

  // ---- margem dos que mais vendem (prepara a etapa 2)
  const margemBaixa = [];
  for (const [id, a] of porProd) {
    if (abc.get(id) !== 'A') continue;
    const pls = cad.precos.filter(x => x.produto_id === id && x.ativo_no_mix && n(x.preco) > 0);
    if (!pls.length) continue;
    const pm = pls.reduce((s, x) => s + n(x.preco), 0) / pls.length, c = custo(id);
    if (!c) continue;
    const m = (pm - c) / pm;
    if (m * 100 < cfg.margem_alvo) margemBaixa.push({ p: prod.get(id), margem: m, preco: pm, custo: c, bruto: a.bruto });
  }
  margemBaixa.sort((a, b) => b.bruto - a.bruto);

  // ---- resumo
  const falta = itensLoja.filter(x => x.status === 'falta');
  const sumiram = itensLoja.filter(x => x.status === 'sumiu');
  const acaba = itensLoja.filter(x => x.status === 'acaba');
  const ajustes = itensLoja.filter(x => x.ajuste);
  const perdaDia = falta.reduce((s, x) => s + x.r * x.preco, 0) + sumiram.reduce((s, x) => s + x.rPrev * x.preco, 0);
  const resumo = {
    vendas90: (base.produtos || []).reduce((s, v) => s + n(v.q90), 0),
    bruto90: totalBruto,
    lojasComDados: infoLoja.size,
    diasRede,
    falta: falta.length + sumiram.length, faltaEstoque: falta.length, sumiu: sumiram.length, faltaEssencial: falta.filter(x => x.essencial).length,
    acaba: acaba.length, acabaEssencial: acaba.filter(x => x.essencial).length,
    perdaDia,
    compraValor: compra.reduce((s, x) => s + x.valor, 0), compraItens: compra.length, compraUrgente: compra.filter(x => x.urgente).length,
    parado: parados.reduce((s, x) => s + x.preso, 0) + 0,
    paradoItens: parados.length,
    semVendaRede: semVendaRede.length,
    ajustes: ajustes.length,
    semSaldo: lojas.filter(l => !locComMov.has(l.id) && !locSac.has(l.id)).map(l => l.nome),
    incerto: cad.locais.filter(l => confianca.get(l.id)?.ok === false).map(l => ({ nome: l.nome, ...confianca.get(l.id) })),
    fonteSac: sac?.data || null,
  };

  return { cfg, hoje, lojas, cd, itensLoja, compra, parados, semVendaRede, margemBaixa, essencial, abc, resumo, infoLoja, ajustes, falta, acaba, sumiram, confianca };
}

// ---- frases do "O que fazer hoje" e do cérebro (ordem = urgência)
const nf = (v, c = 1) => (+v).toLocaleString('pt-BR', { maximumFractionDigits: c, minimumFractionDigits: 0 });
const SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
export const quandoTxt = (d, hoje) => {
  if (d == null) return '—';
  if (d === 0) return 'hoje';
  if (d === 1) return 'amanhã';
  if (d <= 6) return SEMANA[(hoje.getDay() + d) % 7];
  if (d > 120) return 'mais de 4 meses';
  return 'em ' + d + ' dias';
};
export const ritmoTxt = r => (r >= 1 ? nf(r, 1) + ' por dia' : r > 0 ? nf(r * 7, 1) + ' por semana' : 'sem venda');

export function insights(A, brl, bonito) {
  const out = [], nome = p => bonito(p.nome);
  const ess = A.falta.filter(x => x.essencial).sort((a, b) => b.r * b.preco - a.r * a.preco);
  for (const x of ess.slice(0, 3)) out.push({ nivel: 'bad', tipo: 'falta', titulo: `${nome(x.p)} está em falta na ${x.loja.nome}`, texto: `Vende ${ritmoTxt(x.r)} e não tem na prateleira. Perde cerca de ${brl(Math.round(x.r * x.preco))} por dia.`, ir: 'loja', loja: x.loja.id });
  const sum = A.sumiram.slice().sort((a, b) => (!!b.essencial - !!a.essencial) || (b.rPrev * b.preco - a.rPrev * a.preco));
  for (const x of sum.slice(0, 3)) out.push({ nivel: 'bad', tipo: 'falta', titulo: `${nome(x.p)} parou de vender na ${x.loja.nome}`, texto: `Vendia ${ritmoTxt(x.rPrev)} e não vendeu nada nos últimos 7 dias. Provável falta na prateleira: confira e leve ${nf(x.levar, 0)}.`, ir: 'loja', loja: x.loja.id });
  if (sum.length > 3) out.push({ nivel: 'bad', tipo: 'falta', titulo: `Mais ${sum.length - 3} produtos pararam de vender de repente`, texto: `Juntos vendiam cerca de ${brl(Math.round(sum.slice(3).reduce((s, x) => s + x.rPrev * x.preco, 0)))} por dia. Veja a lista de cada loja.`, ir: 'falta' });
  const outrasF = A.falta.filter(x => !x.essencial);
  if (outrasF.length) out.push({ nivel: 'bad', tipo: 'falta', titulo: `${outrasF.length} ${outrasF.length === 1 ? 'produto' : 'produtos'} em falta nas lojas`, texto: `Juntos, deixam de vender cerca de ${brl(Math.round(outrasF.reduce((s, x) => s + x.r * x.preco, 0)))} por dia.`, ir: 'falta' });
  const urg = A.compra.filter(x => x.urgente);
  for (const x of urg.slice(0, 2)) out.push({ nivel: 'warn', tipo: 'compra', titulo: `Compre ${nf(x.qtd, 0)} ${x.fator > 1 ? `(${nf(x.caixas, 0)} cx)` : 'un.'} de ${nome(x.p)}`, texto: x.saldoCD > 0 ? `O CD cobre só ${quandoTxt(x.cobre, A.hoje) === 'hoje' ? 'hoje' : x.cobre + ' dias'} e a rede vende ${ritmoTxt(x.r)}.` : `O CD está sem estoque e a rede vende ${ritmoTxt(x.r)}.`, ir: 'compra' });
  if (urg.length > 2) out.push({ nivel: 'warn', tipo: 'compra', titulo: `Pedido de compra sugerido: ${brl(Math.round(A.resumo.compraValor))}`, texto: `${A.resumo.compraItens} produtos, ${urg.length} com urgência. Já em caixas fechadas.`, ir: 'compra' });
  const ac = A.acaba.filter(x => x.essencial).sort((a, b) => a.dias - b.dias);
  for (const x of ac.slice(0, 3)) out.push({ nivel: 'warn', tipo: 'acaba', titulo: `${nome(x.p)} acaba ${quandoTxt(x.dias, A.hoje)} na ${x.loja.nome}`, texto: `Vende ${ritmoTxt(x.r)} e tem ${nf(x.saldo, 0)}. Leve ${nf(x.levar, 0)} no próximo abastecimento.`, ir: 'loja', loja: x.loja.id });
  const sub = A.ajustes.filter(x => x.ajuste.tipo === 'subir').sort((a, b) => b.r - a.r);
  if (sub.length) { const x = sub[0]; out.push({ nivel: 'info', tipo: 'minmax', titulo: `Máximo de ${nome(x.p)} está baixo na ${x.loja.nome}`, texto: `Vende ${ritmoTxt(x.r)}: com máximo ${nf(x.ajuste.de, 0)} falta antes do próximo abastecimento. Sugestão: ${nf(x.ajuste.para, 0)}.${sub.length > 1 ? ` Há mais ${sub.length - 1} assim.` : ''}`, ir: 'minmax' }); }
  if (A.resumo.parado > 0) out.push({ nivel: 'info', tipo: 'parado', titulo: `${brl(Math.round(A.resumo.parado))} parados em produtos que não vendem`, texto: `${A.resumo.paradoItens} itens nas prateleiras sem venda há ${A.cfg.parado_dias} dias ou mais. Vale promoção ou trocar de loja.`, ir: 'parado' });
  if (A.semVendaRede.length) out.push({ nivel: 'info', tipo: 'portfolio', titulo: `${A.semVendaRede.length} produtos não venderam em nenhuma loja`, texto: `Nos últimos ${Math.min(90, A.resumo.diasRede)} dias. São candidatos a sair do portfólio.`, ir: 'parado' });
  for (const x of A.margemBaixa.slice(0, 2)) out.push({ nivel: 'info', tipo: 'margem', titulo: `${nome(x.p)}: margem de ${nf(x.margem * 100, 0)}%`, texto: `Está entre os que mais vendem, mas abaixo da sua meta de ${A.cfg.margem_alvo}%. Custo ${brl(x.custo)}, preço médio ${brl(Math.round(x.preco))}.`, ir: 'margem' });
  return out;
}
