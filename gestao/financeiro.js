// Financeiro (etapa 1): quanto entrou, quanto ficou com a maquininha, quanto custou a mercadoria e quanto sobrou.
// Os números vêm somados pelo servidor (rpc financeiro_resumo), então a tela fica leve mesmo com muitas lojas.
// As taxas são as que o dono informa aqui (estimativa); a taxa real de cada pagamento do Mercado Pago entra na etapa 3.

const TAXA_PADRAO = { debito: 1.99, credito: 4.98, pix: 0.99 };
const FORMAS = [['pix', 'Pix'], ['debito', 'Débito'], ['credito', 'Crédito']];
const NOME_FORMA = Object.fromEntries(FORMAS);
const PERIODOS = [['hoje', 'Hoje'], ['7d', '7 dias'], ['mes', 'Este mês'], ['mesant', 'Mês passado'], ['outro', 'Escolher datas']];

const F = { per: 'mes', loja: '', teste: false, de: '', ate: '', taxas: null };

const iso = d => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10); };
const meia = s => new Date(s + 'T00:00:00');
const mais = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const dataBR = s => s.slice(8, 10) + '/' + s.slice(5, 7);
const MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const porc = v => (v * 100).toFixed(1).replace('.', ',') + '%';
const txt = n => String(n).replace('.', ',');

function intervalo() {
  const hoje = meia(iso(new Date()));
  if (F.per === 'hoje') return [hoje, mais(hoje, 1)];
  if (F.per === '7d') return [mais(hoje, -6), mais(hoje, 1)];
  if (F.per === 'mes') return [new Date(hoje.getFullYear(), hoje.getMonth(), 1), mais(hoje, 1)];
  if (F.per === 'mesant') return [new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1), new Date(hoje.getFullYear(), hoje.getMonth(), 1)];
  const de = F.de ? meia(F.de) : mais(hoje, -29), ate = F.ate ? mais(meia(F.ate), 1) : mais(hoje, 1);
  return ate > de ? [de, ate] : [de, mais(de, 1)];
}

const taxa = f => { const t = F.taxas?.[f]; return Number.isFinite(+t) ? +t : (TAXA_PADRAO[f] ?? 0); };

// soma as linhas do servidor (dia × loja e dia × loja × forma) no que a tela mostra
function somar(r, lojaId) {
  const ok = x => !lojaId || x.local_id === lojaId;
  const dias = (r.dias || []).filter(ok), formas = (r.formas || []).filter(ok), compras = (r.compras || []).filter(ok);
  const tot = { vendas: 0, bruto: 0, cmv: 0, itens: 0, semCusto: 0, taxas: 0, estornado: 0, nEstorno: 0, compras: 0, notas: 0 };
  const dia = {}, loja = {}, forma = {};
  const d0 = k => (dia[k] ??= { vendas: 0, bruto: 0, cmv: 0, taxas: 0, compras: 0 });
  const l0 = k => (loja[k] ??= { vendas: 0, bruto: 0, cmv: 0, taxas: 0 });
  for (const x of dias) {
    tot.vendas += +x.vendas; tot.bruto += +x.bruto; tot.cmv += +x.cmv; tot.itens += +x.itens; tot.semCusto += +x.sem_custo;
    const d = d0(x.dia); d.vendas += +x.vendas; d.bruto += +x.bruto; d.cmv += +x.cmv;
    const l = l0(x.local_id); l.vendas += +x.vendas; l.bruto += +x.bruto; l.cmv += +x.cmv;
  }
  for (const x of formas) {
    const t = Math.round(+x.valor * taxa(x.forma) / 100);
    tot.taxas += t; tot.estornado += +x.estornado; tot.nEstorno += +x.n_estorno;
    d0(x.dia).taxas += t; l0(x.local_id).taxas += t;
    const f = (forma[x.forma] ??= { n: 0, valor: 0, taxas: 0, estornado: 0 }); f.n += +x.n; f.valor += +x.valor; f.taxas += t; f.estornado += +x.estornado;
  }
  for (const x of compras) { tot.compras += +x.valor; tot.notas += +x.notas; d0(x.dia).compras += +x.valor; }
  tot.liquido = tot.bruto - tot.taxas; tot.lucro = tot.bruto - tot.taxas - tot.cmv; tot.margem = tot.bruto ? tot.lucro / tot.bruto : 0;
  return { tot, dia, loja, forma };
}

const variacao = (a, b) => {
  if (!b) return '<small>&nbsp;</small>';
  const v = (a - b) / Math.abs(b);
  return `<small class="${v >= 0 ? 'up' : 'dn'}">${v >= 0 ? '+' : ''}${porc(v)} vs. anterior</small>`;
};

export async function telaFinanceiro(C) {
  const { sb, S, $, esc, brl, toast, modal, fechar, lojas } = C;
  const M = $('#main'), dono = S.papel === 'dono';
  if (!F.taxas) {
    const { data } = await sb.from('empresas').select('financeiro').eq('id', S.emp.id).maybeSingle();
    F.taxas = { ...TAXA_PADRAO, ...(data?.financeiro?.taxas || {}) };
    F.taxasSalvas = !!data?.financeiro?.taxas;
  }
  const ls = lojas();
  if (F.loja && !ls.some(l => l.id === F.loja)) F.loja = '';
  const [ini, fim] = intervalo();
  if (!F.de) { F.de = iso(ini); F.ate = iso(mais(fim, -1)); }

  M.innerHTML = `<div class="head"><div><h1>Financeiro</h1><p>Quanto entrou, quanto ficou com as taxas, quanto custou a mercadoria e quanto sobrou.</p></div>
    <div class="row">${dono ? '<button class="btn" id="fTaxas">Taxas</button>' : ''}<button class="btn" id="fCsv">Exportar planilha</button></div></div>
   <div class="fnbar">
    <div class="fnseg" role="tablist">${PERIODOS.map(([k, n]) => `<button class="${F.per === k ? 'on' : ''}" data-per="${k}">${n}</button>`).join('')}</div>
    <div class="fndatas" ${F.per === 'outro' ? '' : 'hidden'}><input type="date" id="fDe" value="${F.de}"><span class="mu">até</span><input type="date" id="fAte" value="${F.ate}"></div>
    <span class="sp"></span>
    <select id="fLoja" style="width:200px"><option value="">Todas as lojas</option>${ls.map(l => `<option value="${l.id}" ${F.loja === l.id ? 'selected' : ''}>${esc(l.nome)}</option>`).join('')}</select>
    <label class="chk"><input type="checkbox" id="fTeste" ${F.teste ? 'checked' : ''}> Incluir testes</label>
   </div>
   <div id="fCorpo"><div class="grid5 fnkpi">${'<div class="kpi"><span>&nbsp;</span><b><i class="sk" style="width:60%;height:22px"></i></b><small>&nbsp;</small></div>'.repeat(5)}</div></div>`;

  M.querySelectorAll('[data-per]').forEach(b => b.onclick = () => { F.per = b.dataset.per; if (F.per !== 'outro') { const [a, z] = intervalo(); F.de = iso(a); F.ate = iso(mais(z, -1)); } telaFinanceiro(C); });
  const datas = () => { F.de = $('#fDe').value; F.ate = $('#fAte').value; if (F.de && F.ate && F.ate < F.de) F.ate = F.de; telaFinanceiro(C); };
  $('#fDe').onchange = datas; $('#fAte').onchange = datas;
  $('#fLoja').onchange = e => { F.loja = e.target.value; telaFinanceiro(C); };
  $('#fTeste').onchange = e => { F.teste = e.target.checked; telaFinanceiro(C); };
  if (dono) $('#fTaxas').onclick = () => editarTaxas(C);

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Fortaleza';
  const dur = fim - ini, pIni = new Date(ini.getTime() - dur);
  const pedir = (a, b) => sb.rpc('financeiro_resumo', { p_empresa: S.emp.id, p_ini: a.toISOString(), p_fim: b.toISOString(), p_teste: F.teste, p_tz: tz });
  const [atual, ant] = await Promise.all([pedir(ini, fim), pedir(pIni, ini)]);
  const Cp = $('#fCorpo'); if (!Cp) return;
  if (atual.error) { Cp.innerHTML = `<p class="vazio">Não foi possível carregar: ${esc(atual.error.message)}</p>`; return; }
  const R = somar(atual.data, F.loja), P = ant.error ? null : somar(ant.data, F.loja).tot, T = R.tot;
  const $c = brl, nomeLoja = id => S.locais.find(l => l.id === id)?.nome || 'Loja removida';

  // dias do período (mostra também os dias sem venda, para o fechamento ficar completo)
  const nDias = Math.round(dur / 864e5), porMes = nDias > 62;
  const chave = d => porMes ? d.slice(0, 7) : d;
  const linhas = {};
  if (!porMes) for (let d = new Date(ini); d < fim; d = mais(d, 1)) linhas[iso(d)] = { vendas: 0, bruto: 0, cmv: 0, taxas: 0, compras: 0 };
  for (const [d, x] of Object.entries(R.dia)) { const k = chave(d), y = (linhas[k] ??= { vendas: 0, bruto: 0, cmv: 0, taxas: 0, compras: 0 }); for (const c in y) y[c] += x[c]; }
  const ordem = Object.keys(linhas).sort();
  const rotulo = k => porMes ? MES[+k.slice(5, 7) - 1] + '/' + k.slice(2, 4) : dataBR(k);
  const semana = k => porMes ? '' : ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][meia(k).getDay()];

  Cp.innerHTML = `
   <div class="grid5 fnkpi">
    <div class="kpi"><span>Faturamento</span><b class="num">${$c(T.bruto)}</b>${P ? variacao(T.bruto, P.bruto) : '<small>&nbsp;</small>'}</div>
    <div class="kpi"><span>Taxas</span><b class="num">${$c(T.taxas)}</b><small>${T.bruto ? porc(T.taxas / T.bruto) + ' do faturamento' : '&nbsp;'}</small></div>
    <div class="kpi"><span>Líquido a receber</span><b class="num">${$c(T.liquido)}</b><small>depois das taxas</small></div>
    <div class="kpi"><span>Custo da mercadoria</span><b class="num">${$c(T.cmv)}</b><small>${T.bruto ? porc(T.cmv / T.bruto) + ' do faturamento' : '&nbsp;'}</small></div>
    <div class="kpi fnluc"><span>Lucro</span><b class="num">${$c(T.lucro)}</b><small>margem ${porc(T.margem)}${P && P.bruto ? ` · antes ${porc(P.margem)}` : ''}</small></div>
   </div>
   ${T.semCusto ? `<div class="aviso" style="margin-top:14px"><span>${T.semCusto} ${T.semCusto === 1 ? 'item vendido estava' : 'itens vendidos estavam'} sem custo no cadastro. O lucro aparece maior do que o real até o custo ser preenchido (entra sozinho ao lançar a NF-e de compra).</span></div>` : ''}
   ${!F.taxasSalvas ? `<div class="aviso info" style="margin-top:14px"><span>As taxas estão no padrão (Pix ${txt(TAXA_PADRAO.pix)}%, débito ${txt(TAXA_PADRAO.debito)}%, crédito ${txt(TAXA_PADRAO.credito)}%). ${dono ? 'Confira as do seu plano no app do Mercado Pago e ajuste em <b>Taxas</b>.' : 'O dono pode ajustar em Taxas.'}</span></div>` : ''}

   <section class="card fncard"><div class="fnch"><div><h2>${porMes ? 'Mês a mês' : 'Dia a dia'}</h2><p class="mu sm">Cada barra é o faturamento, dividido em custo, taxas e lucro.</p></div>
    <div class="fnleg"><span><i style="background:var(--fn-custo)"></i>Custo</span><span><i style="background:var(--fn-taxa)"></i>Taxas</span><span><i style="background:var(--fn-lucro)"></i>Lucro</span></div></div>
    ${grafico(ordem, linhas, rotulo, $c, M.clientWidth)}</section>

   <div class="grid2 fn2" style="margin-top:16px">
    <div class="tblwrap"><table class="tbl"><thead><tr><th>Forma de pagamento</th><th class="n">Qtd.</th><th class="n">Recebido</th><th class="n hc">Taxa</th><th class="n">Líquido</th></tr></thead><tbody>
     ${FORMAS.filter(([k]) => R.forma[k]?.n).map(([k, n]) => { const f = R.forma[k]; return `<tr><td>${n} <span class="mu sm">${txt(taxa(k))}%</span></td><td class="n num">${f.n}</td><td class="n num">${$c(f.valor)}</td><td class="n num mu hc">${$c(f.taxas)}</td><td class="n num"><b>${$c(f.valor - f.taxas)}</b></td></tr>`; }).join('') || '<tr><td colspan="5" class="vazio">Sem pagamentos no período.</td></tr>'}
    </tbody>${T.vendas ? `<tfoot><tr><td>Total</td><td class="n num">${Object.values(R.forma).reduce((s, f) => s + f.n, 0)}</td><td class="n num">${$c(T.bruto)}</td><td class="n num hc">${$c(T.taxas)}</td><td class="n num">${$c(T.liquido)}</td></tr></tfoot>` : ''}</table></div>
    <div class="tblwrap"><table class="tbl"><thead><tr><th>Loja</th><th class="n hc">Vendas</th><th class="n">Faturamento</th><th class="n">Lucro</th><th class="n">Margem</th></tr></thead><tbody>
     ${Object.entries(R.loja).filter(([, x]) => x.vendas).sort((a, b) => b[1].bruto - a[1].bruto).map(([id, x]) => { const lu = x.bruto - x.taxas - x.cmv; return `<tr><td>${esc(nomeLoja(id))}</td><td class="n num hc">${x.vendas}</td><td class="n num">${$c(x.bruto)}</td><td class="n num"><b>${$c(lu)}</b></td><td class="n num">${x.bruto ? porc(lu / x.bruto) : '<span class="fnd">—</span>'}</td></tr>`; }).join('') || '<tr><td colspan="5" class="vazio">Sem vendas no período.</td></tr>'}
    </tbody></table></div>
   </div>

   <div class="fnres">
    <div><span>Ticket médio</span><b class="num">${$c(T.vendas ? Math.round(T.bruto / T.vendas) : 0)}</b></div>
    <div><span>Vendas</span><b class="num">${T.vendas.toLocaleString('pt-BR')}</b></div>
    <div><span>Itens vendidos</span><b class="num">${(+T.itens).toLocaleString('pt-BR')}</b></div>
    <div><span>Estornos</span><b class="num">${T.nEstorno ? $c(T.estornado) : '—'}</b>${T.nEstorno ? `<small>${T.nEstorno} ${T.nEstorno === 1 ? 'pagamento' : 'pagamentos'}</small>` : ''}</div>
    <div><span>Compras lançadas (NF-e)</span><b class="num">${T.notas ? $c(T.compras) : '—'}</b>${T.notas ? `<small>${T.notas} ${T.notas === 1 ? 'nota' : 'notas'}</small>` : ''}</div>
   </div>

   <h2 style="font-size:18px;margin:26px 0 12px">Fechamento ${porMes ? 'por mês' : 'por dia'}</h2>
   <div class="tblwrap"><table class="tbl fntab"><thead><tr><th>${porMes ? 'Mês' : 'Dia'}</th><th class="n hc">Vendas</th><th class="n">Faturamento</th><th class="n hm">Taxas</th><th class="n hm">Líquido</th><th class="n hm">Custo</th><th class="n">Lucro</th><th class="n">Margem</th><th class="n hm">Compras</th></tr></thead><tbody>
    ${ordem.slice().reverse().map(k => { const x = linhas[k], lu = x.bruto - x.taxas - x.cmv; if (!x.vendas && !x.compras) return `<tr class="fnzero"><td class="num"><b>${rotulo(k)}</b> <span class="mu sm">${semana(k)}</span></td><td colspan="8" class="sm">Sem vendas</td></tr>`;
    return `<tr class="${x.vendas ? '' : 'fnzero'}"><td class="num"><b>${rotulo(k)}</b> <span class="mu sm">${semana(k)}</span></td><td class="n num hc">${x.vendas}</td><td class="n num">${$c(x.bruto)}</td><td class="n num hm">${$c(x.taxas)}</td><td class="n num hm">${$c(x.bruto - x.taxas)}</td><td class="n num hm">${$c(x.cmv)}</td><td class="n num"><b>${$c(lu)}</b></td><td class="n num">${x.bruto ? porc(lu / x.bruto) : '<span class="fnd">—</span>'}</td><td class="n num hm">${x.compras ? $c(x.compras) : '<span class="fnd">—</span>'}</td></tr>`; }).join('') || '<tr><td colspan="9" class="vazio">Sem movimento no período.</td></tr>'}
   </tbody><tfoot><tr><td>Total</td><td class="n num hc">${T.vendas}</td><td class="n num">${$c(T.bruto)}</td><td class="n num hm">${$c(T.taxas)}</td><td class="n num hm">${$c(T.liquido)}</td><td class="n num hm">${$c(T.cmv)}</td><td class="n num">${$c(T.lucro)}</td><td class="n num">${T.bruto ? porc(T.margem) : '—'}</td><td class="n num hm">${T.notas ? $c(T.compras) : '—'}</td></tr></tfoot></table></div>
   <p class="mu sm" style="margin-top:10px">Só vendas pagas${F.teste ? ', incluindo as de teste' : ', sem as de teste'}. Taxas estimadas pelas taxas informadas em Taxas; o custo é o que estava no cadastro na hora de cada venda. Estornos contam no dia da venda original.</p>`;

  $('#fCsv').onclick = () => exportar(atual.data, F.loja, nomeLoja, ini, fim);
}

// barras empilhadas em SVG: custo + taxas + lucro = faturamento
function grafico(ordem, linhas, rotulo, brl, larguraTela) {
  if (!ordem.length || !ordem.some(k => linhas[k].bruto)) return '<p class="vazio">Sem vendas no período.</p>';
  const W = Math.round(Math.max(340, Math.min(1000, (larguraTela || 1000) - 80))), H = W < 600 ? 200 : 220, pe = 46, pb = 26, pt = 8, max = Math.max(...ordem.map(k => linhas[k].bruto)) || 1;
  const passo = topo(max), esc = (H - pb - pt) / passo.max, n = ordem.length, larg = (W - pe) / n, bw = Math.max(2, Math.min(36, larg * .62));
  const cada = Math.ceil(n / (W < 600 ? 6 : 12));
  let s = '';
  for (let v = 0; v <= passo.max; v += passo.p) { const y = H - pb - v * esc; s += `<line x1="${pe}" x2="${W}" y1="${y}" y2="${y}" class="fngl"/><text x="${pe - 8}" y="${y + 4}" text-anchor="end" class="fnax">${curto(v)}</text>`; }
  ordem.forEach((k, i) => {
    const x = linhas[k], cx = pe + larg * i + larg / 2, lu = Math.max(0, x.bruto - x.taxas - x.cmv);
    let y = H - pb; const seg = (v, cls) => { if (v <= 0) return ''; const h = v * esc; y -= h; return `<rect x="${cx - bw / 2}" y="${y}" width="${bw}" height="${h}" class="${cls}"/>`; };
    s += `<g class="fnbarra"><title>${rotulo(k)}: faturamento ${brl(x.bruto)} · custo ${brl(x.cmv)} · taxas ${brl(x.taxas)} · lucro ${brl(x.bruto - x.taxas - x.cmv)}</title><rect x="${cx - larg / 2}" y="${pt}" width="${larg}" height="${H - pb - pt}" fill="transparent"/>${seg(x.cmv, 'fn-c')}${seg(x.taxas, 'fn-t')}${seg(lu, 'fn-l')}</g>`;
    if (i % cada === 0) s += `<text x="${cx}" y="${H - 6}" text-anchor="middle" class="fnax">${rotulo(k)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" class="fnsvg" role="img" aria-label="Faturamento por período">${s}</svg>`;
}
function topo(max) { const r = max / 4, m = 10 ** Math.floor(Math.log10(r)), p = [1, 2, 2.5, 5, 10].map(x => x * m).find(x => x >= r); return { p, max: Math.ceil(max / p) * p }; }
function curto(c) { const r = c / 100; return r >= 1000 ? 'R$ ' + txt(+(r / 1000).toFixed(1)) + ' mil' : 'R$ ' + Math.round(r); }

// planilha (abre no Excel em português: separador ; e vírgula decimal)
function exportar(r, lojaId, nomeLoja, ini, fim) {
  const ok = x => !lojaId || x.local_id === lojaId, num = c => ((+c || 0) / 100).toFixed(2).replace('.', ',');
  const k = x => x.dia + '|' + x.local_id, L = {};
  for (const x of (r.dias || []).filter(ok)) L[k(x)] = { dia: x.dia, loja: x.local_id, vendas: +x.vendas, bruto: +x.bruto, cmv: +x.cmv, f: {}, est: 0, compras: 0 };
  for (const x of (r.formas || []).filter(ok)) { const y = (L[k(x)] ??= { dia: x.dia, loja: x.local_id, vendas: 0, bruto: 0, cmv: 0, f: {}, est: 0, compras: 0 }); y.f[x.forma] = (y.f[x.forma] || 0) + +x.valor; y.est += +x.estornado; }
  for (const x of (r.compras || []).filter(ok)) { const y = (L[k(x)] ??= { dia: x.dia, loja: x.local_id, vendas: 0, bruto: 0, cmv: 0, f: {}, est: 0, compras: 0 }); y.compras += +x.valor; }
  const cab = ['Dia', 'Loja', 'Vendas', 'Faturamento', 'Pix', 'Débito', 'Crédito', 'Taxas', 'Líquido', 'Custo da mercadoria', 'Lucro', 'Margem %', 'Estornos', 'Compras NF-e'];
  const linhas = Object.values(L).sort((a, b) => a.dia.localeCompare(b.dia) || nomeLoja(a.loja).localeCompare(nomeLoja(b.loja))).map(y => {
    const t = FORMAS.reduce((s, [f]) => s + Math.round((y.f[f] || 0) * taxa(f) / 100), 0), lu = y.bruto - t - y.cmv;
    return [y.dia.split('-').reverse().join('/'), nomeLoja(y.loja), y.vendas, num(y.bruto), num(y.f.pix), num(y.f.debito), num(y.f.credito), num(t), num(y.bruto - t), num(y.cmv), num(lu), y.bruto ? (lu / y.bruto * 100).toFixed(1).replace('.', ',') : '', num(y.est), num(y.compras)];
  });
  const cel = v => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csv = '﻿' + [cab, ...linhas].map(l => l.map(cel).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `financeiro_${iso(ini)}_a_${iso(mais(fim, -1))}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function editarTaxas(C) {
  const { sb, S, $, toast, modal, fechar } = C;
  modal(`<h2>Taxas de pagamento</h2>
   <p class="mu sm">Informe as taxas do seu plano no Mercado Pago (aparecem no app ou no site do Mercado Pago, em taxas e prazos). Para o crédito, use a taxa à vista. Elas servem para calcular o líquido e o lucro.</p>
   <div class="fntx">${FORMAS.map(([k, n]) => `<label class="f">${n}<span class="fnpct"><input type="text" inputmode="decimal" data-tx="${k}" value="${txt(taxa(k))}"><i>%</i></span></label>`).join('')}</div>
   <p class="erro" id="txErro"></p>
   <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancelar</button><button class="btn pri" id="txOk">Salvar taxas</button></div>`);
  $('#txOk').onclick = async () => {
    const t = {};
    for (const i of document.querySelectorAll('[data-tx]')) {
      const v = parseFloat(i.value.replace(',', '.'));
      if (!Number.isFinite(v) || v < 0 || v > 20) { $('#txErro').textContent = 'Use um número entre 0 e 20 (ex.: 4,98).'; i.focus(); return; }
      t[i.dataset.tx] = Math.round(v * 100) / 100;
    }
    const b = $('#txOk'); b.disabled = true; b.textContent = 'Salvando…';
    const { data: atual } = await sb.from('empresas').select('financeiro').eq('id', S.emp.id).maybeSingle();
    const r = await sb.from('empresas').update({ financeiro: { ...(atual?.financeiro || {}), taxas: t } }).eq('id', S.emp.id).select('id');
    if (r.error || !r.data?.length) { b.disabled = false; b.textContent = 'Salvar taxas'; $('#txErro').textContent = 'Não foi possível salvar' + (r.error ? ': ' + r.error.message : ''); return; }
    F.taxas = t; F.taxasSalvas = true; fechar(); toast('Taxas salvas'); telaFinanceiro(C);
  };
}
