// "O que você quer fazer?": entende pedidos simples escritos em português e executa as tarefas do painel.
// Só regras (palavras e padrões); nenhuma IA externa. Tudo que grava pede confirmação e oferece "Desfazer".
let C;
const H = { hist: [] };

// ---------- texto ----------
const sem = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const limpa = s => sem(s).replace(/[^a-z0-9$%,./ -]+/g, ' ').replace(/\s+/g, ' ').trim();
const PARADAS = new Set(['o', 'a', 'os', 'as', 'de', 'do', 'da', 'dos', 'das', 'um', 'uma', 'para', 'pra', 'com', 'e', 'no', 'na', 'nos', 'nas', 'em', 'produto', 'produtos', 'item', 'por', 'favor', 'pf', 'quero', 'me', 'mostra', 'mostrar', 'ver', 'qual', 'quanto', 'quantos', 'quantas', 'esta', 'ta', 'tem', 'meu', 'minha']);
const palavras = s => limpa(s).replace(/[,.$%/]/g, ' ').split(' ').filter(w => w && !PARADAS.has(w));
const dinheiro = s => { const m = String(s).replace(/\s/g, '').match(/^r?\$?(\d{1,6})(?:[.,](\d{1,2}))?$/); if (!m) return null; return +m[1] * 100 + (m[2] ? +(m[2] + '0').slice(0, 2) : 0); };
const hojeISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const somaDias = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const dataBR = iso => new Date(iso + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '');

// ---------- busca no catálogo ----------
function acharProdutos(q, lim = 6) {
  const S = C.S, dig = String(q).replace(/\D/g, '');
  if (/^\d{8,14}$/.test(dig) && dig.length === String(q).replace(/\s/g, '').length) {
    const z = s => String(s || '').replace(/^0+/, ''), c = S.codigos.find(x => z(x.ean) === z(dig));
    const p = S.produtos.find(x => z(x.ean) === z(dig)) || (c && S.produtos.find(x => x.id === c.produto_id));
    return p ? [p] : [];
  }
  const qs = palavras(q); if (!qs.length) return [];
  const out = [];
  for (const p of S.produtos) {
    const ns = palavras(p.nome); let ok = 0;
    for (const w of qs) if (ns.some(n => n === w || (w.length >= 2 && n.startsWith(w)) || (/^\d+$/.test(w) && n.replace(/\D/g, '') === w))) ok++;
    if (ok === qs.length) out.push({ p, s: (p.ativo ? 0 : 100) + ns.length });
  }
  return out.sort((a, b) => a.s - b.s).slice(0, lim).map(x => x.p);
}
function acharLoja(t) {
  const n = limpa(t); if (!n) return null;
  return C.lojas().find(l => limpa(l.nome) === n) || C.lojas().find(l => palavras(l.nome).some(w => w.length > 2 && n.split(' ').includes(w))) || null;
}
// separa "... na Benvinda" do fim da frase
function tirarLoja(t) {
  const m = t.match(/^(.*?)\s+(?:n[oa]s?|em|d[oa])\s+(?:loja\s+)?([a-z0-9 ]+)$/);
  if (m) { const l = acharLoja(m[2]); if (l) return [m[1].trim(), l]; }
  return [t, null];
}

// ---------- intenções ----------
const TELAS = [
  [/configurar (minha )?loja|importar|planilha|xml|dicionario|organizar categorias|classificar|kit/, 'ag', 'Configurar minha loja'],
  [/venda|faturamento|faturei|vendi|estorn/, 'vend', 'Vendas'],
  [/estoque|repor|reposicao|abastec|saldo/, 'est', 'Estoque e reposição'],
  [/nota|nf-?e|xml de compra|lancar|entrada|fornecedor/, 'nf', 'Entrada de NF-e'],
  [/portfolio|mix/, 'pf', 'Portfólios'],
  [/caixa|tablet|aparelho|maquininha vinculada|ativacao/, 'cx', 'Caixas'],
  [/app|cliente|morador|qr da loja/, 'app', 'App do cliente'],
  [/anuncio|propaganda|oferta|campanha|midia/, 'ads', 'Anúncios'],
  [/video|camera|gravac/, 'vid', 'Vídeos'],
  [/config|mercado pago|maquininha|certificado|nfc-?e|nota do consumidor|markup|regra de preco|lgpd|cartaz/, 'cfg', 'Configurações'],
  [/produto|cadastro|catalogo|foto|ncm|preco/, 'prod', 'Produtos']
];
const EXEMPLOS = [
  'mudar o preço da coca lata para 5,90',
  'preço do bis xtra na Benvinda para 3,49',
  'quanto custa o guaraná 2l',
  'vendas de hoje',
  'vendas de ontem na Benvinda',
  'vendas da semana',
  'estoque da heineken',
  'o que repor na Benvinda',
  'desativar o produto pão de forma',
  'produtos sem foto',
  'produtos com margem abaixo de 25%',
  'markup para 80%',
  'cadastrar produto',
  'novo caixa',
  'lançar nota de compra',
  'configurar minha loja',
  'primeiros passos'
];

function entender(txt) {
  const n = limpa(txt);
  if (!n) return null;
  if (/primeir[oa]s? (acesso|passos)|assistente|instalar (a )?loja|comecar do zero/.test(n)) return { tipo: 'assistente' };
  if (/^(ajuda|help|\?|comandos|o que (voce|vc) faz|exemplos?)$/.test(n)) return { tipo: 'ajuda' };

  // preço: "mudar/trocar o preço da X para 5,90 (na loja)" | "preço da X para 5,90" | "X para 5,90"
  let m = n.match(/^(?:(?:mudar|muda|mude|trocar|troca|troque|alterar|altera|altere|colocar|coloca|coloque|botar|bota|deixar|deixa|ajustar|ajusta)\s+)?(?:o\s+)?(?:preco|valor)?\s*(?:d[oae]s?\s+)?(.+?)\s+(?:para|pra|por|=|a)\s+(r?\$?\s?\d{1,6}(?:[.,]\d{1,2})?)\s*(?:reais)?(?:\s+(?:n[oa]s?|em)\s+(?:loja\s+)?(.+))?$/);
  if (m && !/markup|margem/.test(n)) { const valor = dinheiro(m[2]); if (valor > 0) { let [prod, loja] = tirarLoja(m[1]); if (m[3]) loja = acharLoja(m[3]) || loja; return { tipo: 'preco', prod, valor, loja, todas: /todas/.test(m[3] || '') }; } }

  m = n.match(/markup\s*(?:para|pra|de|=|em)?\s*(\d{1,3})\s*%?/);
  if (m) return { tipo: 'markup', valor: +m[1] };

  m = n.match(/margem\s*(?:abaixo|menor|menos|inferior)\s*(?:de|que|a)?\s*(\d{1,2})\s*%?/);
  if (m) return { tipo: 'margem', valor: +m[1] };

  m = n.match(/produtos?\s+(?:sem|faltando)\s+(foto|imagem|preco|ncm)/);
  if (m) return { tipo: 'filtroProd', filtro: { foto: 'semfoto', imagem: 'semfoto', preco: 'sempreco', ncm: 'semncm' }[m[1]] };
  if (/produtos?\s+(inativos|desativados)/.test(n)) return { tipo: 'filtroProd', filtro: 'inativos' };

  if (/^(cadastrar|novo|criar|adicionar|incluir)\s+(um\s+)?produto/.test(n)) return { tipo: 'novoProduto', nome: n.replace(/^(cadastrar|novo|criar|adicionar|incluir)\s+(um\s+)?produto\s*/, '') };
  if (/(novo|ativar|instalar|adicionar)\s+(um\s+)?(novo\s+)?(caixa|tablet|aparelho)|codigo de ativacao|gerar codigo/.test(n)) return { tipo: 'novoCaixa' };

  m = n.match(/(venda|vendas|faturamento|faturei|vendi|vendeu|vendemos)(.*)$/);
  if (m && !/produto|estoque/.test(n)) return { tipo: 'vendas', ...periodo(m[2]) };

  m = n.match(/^(?:o que|oque|que)?\s*(?:preciso\s+)?(?:repor|reposicao|abastecer|esta faltando|falta)\s*(.*)$/);
  if (m) { const [, loja] = tirarLoja('x ' + m[1]); return { tipo: 'repor', loja: loja || acharLoja(m[1]) }; }

  m = n.match(/^(?:qual o\s+|ver o\s+|ver\s+)?(?:estoque|saldo)\s*(?:d[oae]s?\s+)?(.*)$/) || n.match(/^quant[oa]s?\s+(.+?)\s+(?:tem|temos|tenho|ha)(?:\s+(?:n[oa]s?|em)\s+(?:loja\s+)?(.+))?$/);
  if (m) { let [prod, loja] = tirarLoja(m[1] || ''); if (m[2]) loja = acharLoja(m[2]) || loja; if (!prod || acharLoja(prod)) return { tipo: 'repor', loja: loja || acharLoja(prod) }; return { tipo: 'estoque', prod, loja }; }

  m = n.match(/^(?:desativar|desative|inativar|tirar de venda|tira de venda|parar de vender|para de vender|esconder)\s+(?:o\s+)?(?:produto\s+)?(.+)$/);
  if (m && !/caixa|tablet|aparelho|cliente/.test(m[1])) return { tipo: 'ativo', ativo: false, prod: m[1] };
  m = n.match(/^(?:ativar|ative|reativar|reative|voltar a vender|volta a vender)\s+(?:o\s+)?(?:produto\s+)?(.+)$/);
  if (m && !/caixa|tablet|aparelho|cliente/.test(m[1])) return { tipo: 'ativo', ativo: true, prod: m[1] };

  m = n.match(/^(?:quanto custa|quanto ta|quanto esta|qual (?:o )?(?:preco|valor|custo|ncm|margem)|preco|valor|custo|margem|ncm|info|informacoes|ficha)\s+(?:d[oae]s?\s+)?(.+)$/);
  if (m) { const [prod, loja] = tirarLoja(m[1]); return { tipo: 'produto', prod, loja }; }

  for (const [re, tela, nome] of TELAS) if (re.test(n) && (/^(abrir|abre|ir|vai|ver|mostrar|mostra|tela|pagina|menu|entrar)\b/.test(n) || palavras(n).length <= 3)) return { tipo: 'tela', tela, nome };

  const ps = acharProdutos(n); if (ps.length) return { tipo: 'produto', prod: n };
  for (const [re, tela, nome] of TELAS) if (re.test(n)) return { tipo: 'tela', tela, nome };
  return { tipo: 'nao', texto: txt };
}
function periodo(t) {
  const n = limpa(t), [resto, loja] = tirarLoja('x ' + n), h = hojeISO();
  const lj = loja || (resto === 'x' ? null : acharLoja(n.replace(/^(de|do|da|na|no|em)\s+/, '')));
  let ini = h, fim = h, nome = 'hoje';
  if (/anteontem/.test(n)) { ini = fim = somaDias(h, -2); nome = 'anteontem'; }
  else if (/ontem/.test(n)) { ini = fim = somaDias(h, -1); nome = 'ontem'; }
  else if (/semana passada/.test(n)) { const d = new Date(h + 'T12:00:00').getDay(); fim = somaDias(h, -d - 1); ini = somaDias(fim, -6); nome = 'na semana passada'; }
  else if (/semana|7 dias/.test(n)) { ini = somaDias(h, -6); nome = 'nos últimos 7 dias'; }
  else if (/mes passado/.test(n)) { const d = new Date(h + 'T12:00:00'); const a = new Date(d.getFullYear(), d.getMonth() - 1, 1), b = new Date(d.getFullYear(), d.getMonth(), 0); ini = a.toISOString().slice(0, 10); fim = b.toISOString().slice(0, 10); nome = 'no mês passado'; }
  else if (/mes|30 dias/.test(n)) { ini = h.slice(0, 8) + '01'; nome = 'neste mês'; }
  else { const m = n.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/); if (m) { const a = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : h.slice(0, 4); ini = fim = `${a}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; nome = 'em ' + dataBR(ini); } }
  return { ini, fim, nome, loja: lj };
}

// ---------- execução ----------
async function executar(txt) {
  const it = entender(txt), R = C.$('#cmdRes'); if (!it) return;
  H.hist = [txt, ...H.hist.filter(x => x !== txt)].slice(0, 8);
  try { localStorage.setItem('beep-cmd-hist', JSON.stringify(H.hist)); } catch { }
  R.innerHTML = '<p class="mu sm">Um instante…</p>';
  try { await (ACOES[it.tipo] || ACOES.nao)(it, R); } catch (e) { R.innerHTML = cartao('Não deu certo', `<p class="mu">${C.esc(e.message)}</p>`); }
}
const cartao = (t, corpo, acoes = '') => `<div class="cmdcard"><h3>${t}</h3>${corpo}${acoes ? `<div class="row" style="margin-top:12px">${acoes}</div>` : ''}</div>`;
const ir = (tela, depois) => { C.fechar(); C.ir(tela); if (depois) setTimeout(depois, 350); };
function escolher(R, ps, titulo, fn) {
  const { esc, bonito } = C;
  R.innerHTML = cartao(titulo, `<p class="mu sm">Achei mais de um produto. Qual deles?</p><div class="cmdlist">${ps.map(p => `<button class="cmdopt" data-p="${p.id}"><b>${esc(bonito(p.nome))}</b><span class="mu sm num">${esc(p.ean || 'sem código')}${p.ativo ? '' : ' · desativado'}</span></button>`).join('')}</div>`);
  R.querySelectorAll('[data-p]').forEach(b => b.onclick = () => fn(C.S.produtos.find(p => p.id === b.dataset.p)));
}
function umProduto(R, q, titulo, fn) {
  const ps = acharProdutos(q);
  if (!ps.length) { R.innerHTML = cartao('Não achei esse produto', `<p class="mu">Nenhum produto com "${C.esc(q)}" no nome ou no código de barras.</p>`, `<button class="btn sm" data-go="prod">Abrir Produtos</button>`); ligarGo(R); return; }
  if (ps.length === 1) return fn(ps[0]);
  escolher(R, ps, titulo, fn);
}
function ligarGo(R) { R.querySelectorAll('[data-go]').forEach(b => b.onclick = () => ir(b.dataset.go)); }
const precosDe = pid => C.S.precos.filter(x => x.produto_id === pid);
const nomeLoja = id => C.S.locais.find(l => l.id === id)?.nome || '—';

const ACOES = {
  ajuda(it, R) {
    R.innerHTML = cartao('Peça do seu jeito', `<p class="mu sm">Escreva o que precisa, como falaria com alguém da loja. Alguns exemplos:</p><div class="cmdchips">${EXEMPLOS.map(e => `<button class="cmdchip" data-ex="${C.esc(e)}">${C.esc(e)}</button>`).join('')}</div>`);
    ligarEx(R);
  },
  nao(it, R) {
    const qs = palavras(it.texto), perto = EXEMPLOS.map(e => ({ e, s: palavras(e).filter(w => qs.some(q => w.startsWith(q.slice(0, 4)))).length })).filter(x => x.s).sort((a, b) => b.s - a.s).slice(0, 4).map(x => x.e);
    R.innerHTML = cartao('Não entendi esse pedido', `<p class="mu sm">Tente escrever de outro jeito${perto.length ? ', por exemplo:' : '. Veja exemplos em "ajuda".'}</p>${perto.length ? `<div class="cmdchips">${perto.map(e => `<button class="cmdchip" data-ex="${C.esc(e)}">${C.esc(e)}</button>`).join('')}</div>` : ''}`, `<button class="btn sm" data-ex="ajuda">Ver o que sei fazer</button>`);
    ligarEx(R);
  },
  assistente() { C.fechar(); C.abrirAssistente(); },
  tela(it) { ir(it.tela); C.toast('Abrindo ' + it.nome); },
  filtroProd(it) { C.setFiltroProd(it.filtro); ir('prod'); },
  novoProduto(it) { ir('prod', () => { C.novoProduto(); if (it.nome) { const f = document.querySelector('#prF [name=nome]'); if (f) f.value = C.bonito(it.nome); } }); },
  novoCaixa() { ir('cx', () => C.gerarCodigo()); },
  repor(it) { if (it.loja) C.setLocalEstoque(it.loja.id); ir('est'); },

  async vendas(it, R) {
    const { sb, S, esc, brl } = C, ini = new Date(it.ini + 'T00:00:00'), fim = new Date(new Date(it.fim + 'T00:00:00').getTime() + 864e5);
    let q = sb.from('vendas').select('local_id,total,status,teste').eq('empresa_id', S.emp.id).eq('status', 'paga').eq('teste', false).gte('finalizada_em', ini.toISOString()).lt('finalizada_em', fim.toISOString()).limit(10000);
    if (it.loja) q = q.eq('local_id', it.loja.id);
    const { data, error } = await q; if (error) throw error;
    const tot = data.reduce((s, v) => s + v.total, 0), por = {}; data.forEach(v => { (por[v.local_id] ??= { n: 0, t: 0 }); por[v.local_id].n++; por[v.local_id].t += v.total; });
    R.innerHTML = cartao(`Vendas ${esc(it.nome)}${it.loja ? ' na ' + esc(it.loja.nome) : ''}`, `<div class="cmdkpis"><div><span>Faturamento</span><b class="num">${brl(tot)}</b></div><div><span>Vendas</span><b class="num">${data.length}</b></div><div><span>Ticket médio</span><b class="num">${brl(data.length ? Math.round(tot / data.length) : 0)}</b></div></div>
      ${!it.loja && Object.keys(por).length > 1 ? `<table class="tbl" style="margin-top:10px"><tbody>${Object.entries(por).sort((a, b) => b[1].t - a[1].t).map(([l, x]) => `<tr><td>${esc(nomeLoja(l))}</td><td class="n num">${x.n}</td><td class="n num"><b>${brl(x.t)}</b></td></tr>`).join('')}</tbody></table>` : ''}
      <p class="mu sm" style="margin-top:8px">Só vendas pagas, sem as de teste${it.ini !== it.fim ? `, de ${dataBR(it.ini)} a ${dataBR(it.fim)}` : ''}.</p>`, `<button class="btn sm" id="cmdVer">Abrir Vendas</button>`);
    C.$('#cmdVer').onclick = () => { C.setDiaVendas(it.fim); ir('vend'); };
  },

  produto(it, R) {
    umProduto(R, it.prod, 'Qual produto?', p => fichaProduto(R, p, it.loja));
  },

  async estoque(it, R) {
    umProduto(R, it.prod, 'Estoque de qual produto?', async p => {
      const { sb, S, esc, bonito } = C;
      const { data, error } = await sb.from('saldos_estoque').select('local_id,saldo').eq('empresa_id', S.emp.id).eq('produto_id', p.id); if (error) throw error;
      const linhas = S.locais.filter(l => l.ativo && (!it.loja || l.id === it.loja.id)).map(l => { const s = data.find(x => x.local_id === l.id), pr = S.precos.find(x => x.produto_id === p.id && x.local_id === l.id); return { l, s: s ? +s.saldo : 0, min: pr?.estoque_min, max: pr?.estoque_max, mix: pr?.ativo_no_mix }; }).filter(x => x.s || x.mix || x.l.tipo !== 'loja');
      R.innerHTML = cartao(`Estoque · ${esc(bonito(p.nome))}`, `<table class="tbl"><thead><tr><th>Local</th><th class="n">Tem</th><th class="n">Mín.</th><th class="n">Máx.</th></tr></thead><tbody>${linhas.map(x => `<tr><td>${esc(x.l.nome)}${x.l.tipo === 'cd' ? ' <span class="pill">CD</span>' : ''}</td><td class="n num"><b>${x.s.toLocaleString('pt-BR')}</b>${x.min != null && x.s < +x.min ? ' <span class="pill warn">repor</span>' : ''}</td><td class="n num mu">${x.min ?? '—'}</td><td class="n num mu">${x.max ?? '—'}</td></tr>`).join('') || '<tr><td colspan="4" class="vazio">Sem estoque registrado.</td></tr>'}</tbody></table>`, `<button class="btn sm" data-go="est">Abrir Estoque</button>`);
      ligarGo(R);
    });
  },

  preco(it, R) {
    umProduto(R, it.prod, 'Mudar o preço de qual produto?', p => confirmarPreco(R, p, it.valor, it.loja));
  },

  ativo(it, R) {
    umProduto(R, it.prod, it.ativo ? 'Reativar qual produto?' : 'Desativar qual produto?', p => {
      const { esc, bonito } = C;
      if (!!p.ativo === it.ativo) { R.innerHTML = cartao(esc(bonito(p.nome)), `<p class="mu">Este produto já está ${it.ativo ? 'ativo' : 'desativado'}.</p>`); return; }
      R.innerHTML = cartao(`${it.ativo ? 'Reativar' : 'Desativar'} ${esc(bonito(p.nome))}?`, `<p class="mu sm">${it.ativo ? 'Ele volta a aparecer no cadastro e no caixa das lojas em que tem preço.' : 'Ele some do caixa de todas as lojas na próxima atualização. O histórico de vendas continua.'}</p>`, `<button class="btn sm" data-close-cmd>Cancelar</button><button class="btn sm pri" id="cmdOk">${it.ativo ? 'Reativar' : 'Desativar'}</button>`);
      ligarCancelar(R);
      C.$('#cmdOk').onclick = async () => {
        const { error } = await C.sb.from('produtos').update({ ativo: it.ativo, atualizado_em: new Date().toISOString() }).eq('id', p.id); if (error) throw error;
        await C.carregar();
        feito(R, `${bonito(p.nome)} ${it.ativo ? 'reativado' : 'desativado'}.`, async () => { await C.sb.from('produtos').update({ ativo: !it.ativo }).eq('id', p.id); await C.carregar(); });
      };
    });
  },

  markup(it, R) {
    const { esc, brl } = C, ant = C.regra(), nova = { ...ant, divisor: Math.round(1 / (1 + it.valor / 100) * 10000) / 10000 };
    if (C.S.papel !== 'dono') { R.innerHTML = cartao('Só o dono muda o markup', '<p class="mu">Peça para o dono da empresa.</p>'); return; }
    const ex = c => { const b = Math.ceil(c / nova.divisor), r = Math.floor(b / 100); let v = r * 100 + nova.terminacaoCentavos; if (v < b) v += 100; return v; };
    R.innerHTML = cartao(`Markup para ${it.valor}%?`, `<p class="mu sm">Hoje é ${Math.round((1 / ant.divisor - 1) * 100)}%. Vale para o preço sugerido de produtos novos (notas de compra e Configurar minha loja). Os preços atuais não mudam. Exemplo: custo ${brl(250)} → ${brl(ex(250))}.</p>`, `<button class="btn sm" data-close-cmd>Cancelar</button><button class="btn sm pri" id="cmdOk">Mudar markup</button>`);
    ligarCancelar(R);
    C.$('#cmdOk').onclick = async () => {
      const { error } = await C.sb.from('empresas').update({ regra_preco: nova }).eq('id', C.S.emp.id); if (error) throw error;
      C.S.emp.regra_preco = nova;
      feito(R, `Markup agora é ${esc(it.valor)}%.`, async () => { await C.sb.from('empresas').update({ regra_preco: ant }).eq('id', C.S.emp.id); C.S.emp.regra_preco = ant; });
    };
  },

  margem(it, R) {
    const { esc, bonito, brl, S } = C, lim = it.valor / 100;
    const lista = S.produtos.filter(p => p.ativo && p.custo > 0).map(p => { const ps = precosDe(p.id).filter(x => x.ativo_no_mix && x.preco > 0); if (!ps.length) return null; const pr = Math.min(...ps.map(x => x.preco)); return { p, pr, m: (pr - p.custo) / pr }; }).filter(x => x && x.m < lim).sort((a, b) => a.m - b.m);
    R.innerHTML = cartao(`Margem abaixo de ${it.valor}%: ${lista.length} produtos`, lista.length ? `<div class="cmdscroll"><table class="tbl"><thead><tr><th>Produto</th><th class="n">Custo</th><th class="n">Menor preço</th><th class="n">Margem</th></tr></thead><tbody>${lista.slice(0, 200).map(x => `<tr data-p="${x.p.id}" class="cmdrow"><td>${esc(bonito(x.p.nome))}</td><td class="n num">${brl(x.p.custo)}</td><td class="n num">${brl(x.pr)}</td><td class="n num"><span class="pill ${x.m < 0 ? 'bad' : 'warn'}">${Math.round(x.m * 100)}%</span></td></tr>`).join('')}</tbody></table></div><p class="mu sm">Toque num produto para ver e mudar o preço.</p>` : '<p class="mu">Nenhum produto com margem tão baixa.</p>');
    R.querySelectorAll('[data-p]').forEach(r => r.onclick = () => fichaProduto(R, S.produtos.find(p => p.id === r.dataset.p)));
  }
};

function fichaProduto(R, p, loja) {
  const { esc, bonito, brl } = C, ps = precosDe(p.id).filter(x => C.lojas().some(l => l.id === x.local_id) && (!loja || x.local_id === loja.id));
  R.innerHTML = cartao(esc(bonito(p.nome)), `<p class="mu sm num">${esc(p.ean || 'sem código de barras')} · custo ${brl(p.custo)} · NCM ${esc(p.ncm || 'falta')}${p.ativo ? '' : ' · <b style="color:#f87171">desativado</b>'}</p>
    <table class="tbl" style="margin-top:8px"><thead><tr><th>Loja</th><th class="n">Preço</th><th class="n">Margem</th><th></th></tr></thead><tbody>${ps.map(x => `<tr><td>${esc(nomeLoja(x.local_id))}</td><td class="n num"><b>${brl(x.preco)}</b></td><td class="n num mu">${p.custo > 0 ? Math.round((x.preco - p.custo) / x.preco * 100) + '%' : '—'}</td><td>${x.ativo_no_mix ? '<span class="pill ok">à venda</span>' : '<span class="pill">fora do mix</span>'}</td></tr>`).join('') || '<tr><td colspan="4" class="vazio">Sem preço em nenhuma loja.</td></tr>'}</tbody></table>
    <div class="row" style="margin-top:10px"><input id="cmdNovo" inputmode="decimal" placeholder="Novo preço, ex.: 5,90" style="max-width:200px"><button class="btn sm pri" id="cmdMudar">Mudar preço</button></div>`,
    `<button class="btn sm" id="cmdEst">Ver estoque</button><button class="btn sm" id="cmdEd">Abrir cadastro</button><button class="btn sm" id="cmdAt">${p.ativo ? 'Desativar' : 'Reativar'}</button>`);
  C.$('#cmdMudar').onclick = () => { const v = dinheiro(C.$('#cmdNovo').value.trim()); if (!(v > 0)) return C.toast('Digite o preço, ex.: 5,90'); confirmarPreco(R, p, v, loja); };
  C.$('#cmdNovo').onkeydown = e => { if (e.key === 'Enter') C.$('#cmdMudar').click(); };
  C.$('#cmdEst').onclick = () => ACOES.estoque({ prod: p.ean || p.nome, loja }, R).catch(() => { });
  C.$('#cmdEd').onclick = () => ir('prod', () => C.editarProduto(p.id));
  C.$('#cmdAt').onclick = () => ACOES.ativo({ ativo: !p.ativo, prod: p.ean || p.nome }, R);
}

function confirmarPreco(R, p, valor, loja) {
  const { esc, bonito, brl } = C, lojas = C.lojas().filter(l => !loja || l.id === loja.id);
  const atuais = precosDe(p.id).filter(x => lojas.some(l => l.id === x.local_id));
  const alvo = atuais.length ? atuais.map(x => x.local_id) : lojas.map(l => l.id);
  const abaixo = p.custo > 0 && valor <= p.custo;
  R.innerHTML = cartao(`${esc(bonito(p.nome))} por ${brl(valor)}?`, `<div class="cmdlist">${lojas.map(l => { const x = atuais.find(a => a.local_id === l.id); return `<label class="chk" style="justify-content:space-between"><span><input type="checkbox" data-l="${l.id}" ${alvo.includes(l.id) ? 'checked' : ''}> ${esc(l.nome)}</span><span class="num mu">${x ? brl(x.preco) + ' → ' : 'novo: '}<b style="color:var(--ink)">${brl(valor)}</b></span></label>`; }).join('')}</div>
    ${p.custo > 0 ? `<p class="sm ${abaixo ? '' : 'mu'}" style="margin-top:8px;${abaixo ? 'color:#f87171' : ''}">Custo ${brl(p.custo)} · margem ${Math.round((valor - p.custo) / valor * 100)}%${abaixo ? ' — abaixo do custo!' : ''}</p>` : ''}
    ${!atuais.length ? '<p class="mu sm">Este produto ainda não tem preço nessas lojas: ele entra à venda nelas.</p>' : ''}`, `<button class="btn sm" data-close-cmd>Cancelar</button><button class="btn sm pri" id="cmdOk">Mudar preço</button>`);
  ligarCancelar(R);
  C.$('#cmdOk').onclick = async () => {
    const sel = [...R.querySelectorAll('[data-l]:checked')].map(c => c.dataset.l); if (!sel.length) return C.toast('Marque ao menos uma loja');
    const antes = C.S.precos.filter(x => x.produto_id === p.id && sel.includes(x.local_id)).map(x => ({ ...x }));
    const agora = new Date().toISOString(), e = C.S.emp.id;
    const rows = sel.map(l => { const a = antes.find(x => x.local_id === l); return a ? { produto_id: p.id, local_id: l, empresa_id: e, preco: valor, atualizado_em: agora } : { produto_id: p.id, local_id: l, empresa_id: e, preco: valor, ativo_no_mix: true, estoque_min: 2, estoque_max: 8, atualizado_em: agora }; });
    const upd = rows.filter(r => antes.some(a => a.local_id === r.local_id)), ins = rows.filter(r => !antes.some(a => a.local_id === r.local_id));
    for (const r of upd) { const { error } = await C.sb.from('precos_local').update({ preco: r.preco, atualizado_em: agora }).eq('produto_id', p.id).eq('local_id', r.local_id); if (error) throw error; }
    if (ins.length) { const { error } = await C.sb.from('precos_local').insert(ins); if (error) throw error; }
    await C.carregar();
    feito(R, `${bonito(p.nome)} agora custa ${brl(valor)} em ${sel.length} ${sel.length === 1 ? 'loja' : 'lojas'}.`, async () => {
      for (const a of antes) await C.sb.from('precos_local').update({ preco: a.preco }).eq('produto_id', p.id).eq('local_id', a.local_id);
      if (ins.length) await C.sb.from('precos_local').delete().eq('produto_id', p.id).in('local_id', ins.map(r => r.local_id));
      await C.carregar();
    });
  };
}

function feito(R, msg, desfazer) {
  R.innerHTML = cartao('Pronto', `<p>${C.esc(msg)}</p>`, desfazer ? '<button class="btn sm" id="cmdUndo">Desfazer</button>' : '');
  if (desfazer) C.$('#cmdUndo').onclick = async () => { const b = C.$('#cmdUndo'); b.disabled = true; b.textContent = 'Desfazendo…'; try { await desfazer(); R.innerHTML = cartao('Desfeito', '<p class="mu">Voltou a ser como era.</p>'); } catch (e) { b.disabled = false; b.textContent = 'Tentar de novo'; C.toast(e.message); } };
  if (['ag', 'prod', 'est', 'vend'].includes(C.S.tela)) C.render();
}
function ligarCancelar(R) { R.querySelectorAll('[data-close-cmd]').forEach(b => b.onclick = () => { R.innerHTML = ''; C.$('#cmdIn').focus(); }); }
function ligarEx(R) { R.querySelectorAll('[data-ex]').forEach(b => b.onclick = () => { C.$('#cmdIn').value = b.dataset.ex; executar(b.dataset.ex); }); }

// ---------- janela ----------
export function abrirComando(ctx, inicial = '') {
  C = ctx; css();
  try { H.hist = JSON.parse(localStorage.getItem('beep-cmd-hist') || '[]'); } catch { H.hist = []; }
  C.modal(`<div class="cmdtop"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><input id="cmdIn" placeholder="O que você quer fazer? Ex.: mudar o preço da coca lata para 5,90" autocomplete="off" value="${C.esc(inicial)}"><kbd>Enter</kbd></div>
   <div id="cmdRes"></div>
   ${H.hist.length ? `<div class="cmdhist"><span class="mu sm">Recentes</span><div class="cmdchips">${H.hist.map(e => `<button class="cmdchip" data-ex="${C.esc(e)}">${C.esc(e)}</button>`).join('')}</div></div>` : ''}`);
  C.$('#modal').classList.add('wide', 'cmdmodal');
  const i = C.$('#cmdIn'); i.focus();
  i.onkeydown = e => { if (e.key === 'Enter' && i.value.trim()) executar(i.value.trim()); };
  ligarEx(C.$('#mbox'));
  if (inicial) executar(inicial); else ACOES.ajuda({}, C.$('#cmdRes'));
}
export { entender, acharProdutos };

function css() {
  if (document.getElementById('cmdCss')) return;
  const s = document.createElement('style'); s.id = 'cmdCss';
  s.textContent = `.cmdmodal{align-items:start;padding-top:9vh}.cmdmodal .card{width:min(760px,100%)!important}
.cmdtop{display:flex;align-items:center;gap:12px;padding:4px 6px 14px;border-bottom:1px solid var(--line);color:var(--mu)}
.cmdtop input{border:0!important;background:none!important;box-shadow:none!important;font-size:17px;padding:0!important;color:var(--ink)}
.cmdtop kbd{font:600 11px Inter,sans-serif;color:var(--mu);border:1px solid var(--line);border-radius:6px;padding:3px 6px}
.cmdcard{display:grid;gap:6px}.cmdcard h3{font-size:17px}
.cmdchips{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}.cmdchip{padding:7px 12px;border-radius:999px;background:var(--p2);border:1px solid var(--line);font-size:13px;color:var(--ink);text-align:left}.cmdchip:hover{border-color:var(--y)}
.cmdhist{border-top:1px solid var(--line);padding-top:12px}
.cmdlist{display:grid;gap:8px;margin-top:6px}.cmdopt{display:grid;gap:2px;text-align:left;padding:10px 12px;border-radius:12px;background:var(--p2);border:1px solid var(--line)}.cmdopt:hover{border-color:var(--y)}
.cmdkpis{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:6px}.cmdkpis div{background:var(--p2);border:1px solid var(--line);border-radius:12px;padding:10px 12px}.cmdkpis span{font-size:11px;color:var(--mu);font-weight:600;text-transform:uppercase;letter-spacing:.04em}.cmdkpis b{display:block;font:800 20px Manrope,Inter,sans-serif}
.cmdscroll{max-height:46vh;overflow:auto}.cmdrow{cursor:pointer}.cmdrow:hover{background:var(--p2)}
.navcmd{display:flex;align-items:center;gap:10px;margin:0 2px 14px;padding:10px 12px;border-radius:12px;border:1px solid var(--line);background:var(--p2);color:var(--mu);font-weight:500;font-size:14px;text-align:left}.navcmd:hover{border-color:var(--y);color:var(--ink)}.navcmd kbd{margin-left:auto;font:600 10px Inter,sans-serif;border:1px solid var(--line);border-radius:5px;padding:2px 5px}
@media(max-width:900px){.cmdkpis{grid-template-columns:1fr}.navcmd kbd{display:none}}`;
  document.head.appendChild(s);
}
