// Financeiro e dashboard do Início.
// Os números vêm somados pelo servidor (rpc financeiro_painel), então a tela fica leve mesmo com muitas lojas.
// As taxas são as que o dono informa em "Taxas" (estimativa); a taxa real de cada pagamento do Mercado Pago entra depois.

const TAXA_PADRAO = { debito: 1.99, credito: 4.98, pix: 0.99 };
const FORMAS = [['pix', 'Pix', '#00a888'], ['debito', 'Débito', '#338ced'], ['credito', 'Crédito', '#e76624']];
const PERIODOS = [['dia', 'Dia'], ['semana', 'Semana'], ['15d', '15 dias'], ['mes', 'Mês'], ['ano', 'Ano'], ['outro', 'Personalizado']];
const COR = { atual: '#338ced', ant: '#e76624', ano: '#00a888' };
const SEM = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

const F = { per: 'mes', loja: '', teste: false, de: '', ate: '', taxas: null, taxasSalvas: false, abc: 'bruto', abcTodos: false };

// ---------- datas ----------
const iso = d => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10); };
const meia = s => new Date(s + 'T00:00:00');
const mais = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const meses = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth() + n, 1), ult = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate(); x.setDate(Math.min(d.getDate(), ult)); x.setHours(d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()); return x; };
const dataBR = s => s.slice(8, 10) + '/' + s.slice(5, 7);
const porc = v => (v * 100).toFixed(1).replace('.', ',') + '%';
const txt = n => String(n).replace('.', ',');
const inteiro = n => Math.round(n).toLocaleString('pt-BR');

// período escolhido + período anterior + mesmo período do ano anterior (+ unidade cheia para o ritmo)
function periodo() {
  const agora = new Date(), hoje = meia(iso(agora)), am = mais(hoje, 1);
  let ini, fim = agora, unidade = null, rotAnt = 'período anterior', antIni, antFim;
  if (F.per === 'dia') { ini = hoje; unidade = am; rotAnt = 'ontem'; antIni = mais(ini, -1); antFim = new Date(agora.getTime() - 864e5); }
  else if (F.per === 'semana') { ini = mais(hoje, -((hoje.getDay() + 6) % 7)); unidade = mais(ini, 7); rotAnt = 'semana passada'; antIni = mais(ini, -7); antFim = new Date(agora.getTime() - 7 * 864e5); }
  else if (F.per === '15d') { ini = mais(hoje, -14); fim = am; rotAnt = '15 dias antes'; antIni = mais(ini, -15); antFim = ini; }
  else if (F.per === 'mes') { ini = new Date(hoje.getFullYear(), hoje.getMonth(), 1); unidade = meses(ini, 1); rotAnt = 'mês anterior'; antIni = meses(ini, -1); antFim = meses(agora, -1); }
  else if (F.per === 'ano') { ini = new Date(hoje.getFullYear(), 0, 1); unidade = new Date(hoje.getFullYear() + 1, 0, 1); rotAnt = null; }
  else {
    ini = F.de ? meia(F.de) : mais(hoje, -29); fim = F.ate ? mais(meia(F.ate), 1) : am;
    if (fim <= ini) fim = mais(ini, 1);
    if (fim - ini > 400 * 864e5) fim = mais(ini, 400);
    const d = fim - ini; antIni = new Date(ini.getTime() - d); antFim = ini;
  }
  const anoIni = meses(ini, -12), anoFim = meses(fim, -12);
  // unidade cheia (para projeção e curva do ritmo): o mês/semana/dia/ano anterior inteiro e o do ano passado
  let cheioAnt = null, cheioAno = null;
  if (unidade) {
    cheioAnt = F.per === 'ano' ? [meses(ini, -12), ini] : F.per === 'mes' ? [meses(ini, -1), ini] : [new Date(ini.getTime() - (unidade - ini)), ini];
    cheioAno = [meses(ini, -12), meses(unidade, -12)];
  }
  return { ini, fim, unidade, rotAnt, antIni, antFim, anoIni, anoFim, cheioAnt, cheioAno, agora };
}

const taxa = f => { const t = F.taxas?.[f]; return Number.isFinite(+t) ? +t : (TAXA_PADRAO[f] ?? 0); };

// soma as linhas do servidor no que a tela mostra (filtro de loja aqui, para trocar de loja sem nova consulta)
function somar(r, lojaId) {
  r = r || {};
  const ok = x => !lojaId || x.local_id === lojaId;
  const tot = { vendas: 0, bruto: 0, cmv: 0, itens: 0, semCusto: 0, taxas: 0, recebido: 0, estornado: 0, nEstorno: 0, compras: 0, notas: 0 };
  const dia = {}, loja = {}, forma = {}, hora = {}, prod = {};
  const d0 = k => (dia[k] ??= { vendas: 0, bruto: 0, cmv: 0, taxas: 0, compras: 0 });
  const l0 = k => (loja[k] ??= { vendas: 0, bruto: 0, cmv: 0, taxas: 0 });
  for (const x of (r.dias || []).filter(ok)) {
    tot.vendas += +x.vendas; tot.bruto += +x.bruto; tot.cmv += +x.cmv; tot.itens += +x.itens; tot.semCusto += +x.sem_custo;
    const d = d0(x.dia); d.vendas += +x.vendas; d.bruto += +x.bruto; d.cmv += +x.cmv;
    const l = l0(x.local_id); l.vendas += +x.vendas; l.bruto += +x.bruto; l.cmv += +x.cmv;
  }
  for (const x of (r.formas || []).filter(ok)) {
    const t = Math.round(+x.valor * taxa(x.forma) / 100);
    tot.taxas += t; tot.recebido += +x.valor; tot.estornado += +x.estornado; tot.nEstorno += +x.n_estorno;
    d0(x.dia).taxas += t; l0(x.local_id).taxas += t;
    const f = (forma[x.forma] ??= { n: 0, valor: 0, taxas: 0 }); f.n += +x.n; f.valor += +x.valor; f.taxas += t;
  }
  for (const x of (r.horas || []).filter(ok)) { const k = x.dow + '|' + x.hora, h = (hora[k] ??= { vendas: 0, bruto: 0 }); h.vendas += +x.vendas; h.bruto += +x.bruto; }
  for (const x of (r.produtos || []).filter(ok)) { const p = (prod[x.produto_id] ??= { qtd: 0, bruto: 0, cmv: 0 }); p.qtd += +x.qtd; p.bruto += +x.bruto; p.cmv += +x.cmv; }
  for (const x of (r.compras || []).filter(ok)) { tot.compras += +x.valor; tot.notas += +x.notas; d0(x.dia).compras += +x.valor; }
  tot.lucroBruto = tot.bruto - tot.cmv; tot.margemBruta = tot.bruto ? tot.lucroBruto / tot.bruto : 0;
  tot.resultado = tot.bruto - tot.cmv - tot.taxas; tot.margem = tot.bruto ? tot.resultado / tot.bruto : 0;
  tot.liquido = tot.bruto - tot.taxas; tot.markup = tot.cmv ? tot.bruto / tot.cmv : 0;
  tot.ticket = tot.vendas ? tot.bruto / tot.vendas : 0; tot.ipv = tot.vendas ? tot.itens / tot.vendas : 0;
  tot.taxaEf = tot.recebido ? tot.taxas / tot.recebido : 0;
  return { tot, dia, loja, forma, hora, prod };
}

async function buscar(C, P) {
  const { sb, S } = C, tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Fortaleza';
  const rpc = (a, b, det = false) => a && b && b > a ? sb.rpc('financeiro_painel', { p_empresa: S.emp.id, p_ini: a.toISOString(), p_fim: b.toISOString(), p_teste: F.teste, p_tz: tz, p_detalhe: det }) : Promise.resolve({ data: null });
  const [atual, ant, ano, cAnt, cAno] = await Promise.all([
    rpc(P.ini, P.fim, true), P.rotAnt ? rpc(P.antIni, P.antFim) : Promise.resolve({ data: null }), rpc(P.anoIni, P.anoFim),
    P.cheioAnt ? rpc(...P.cheioAnt) : Promise.resolve({ data: null }), P.cheioAno ? rpc(...P.cheioAno) : Promise.resolve({ data: null })]);
  if (atual.error) throw atual.error;
  return { atual: atual.data, ant: ant.error ? null : ant.data, ano: ano.error ? null : ano.data, cAnt: cAnt.error ? null : cAnt.data, cAno: cAno.error ? null : cAno.data };
}

async function lerTaxas(C) {
  if (F.taxas) return;
  const { data } = await C.sb.from('empresas').select('financeiro').eq('id', C.S.emp.id).maybeSingle();
  F.taxas = { ...TAXA_PADRAO, ...(data?.financeiro?.taxas || {}) }; F.taxasSalvas = !!data?.financeiro?.taxas;
}

// ---------- comparação ----------
function cmp(a, b, rot, { tipo = 'rs', inverso = false } = {}) {
  if (b == null || !rot) return '';
  let v, t;
  if (tipo === 'pp') { if (!b && !a) return ''; v = a - b; if (Math.abs(v) < .0005) v = 0; t = (v > 0 ? '+' : '') + (v * 100).toFixed(1).replace('.', ',') + ' p.p.'; }
  else { if (!b) return `<span class="fncmp"><em>sem base</em> vs ${rot}</span>`; v = (a - b) / Math.abs(b); t = (v >= 0 ? '+' : '') + porc(v); }
  const bom = Math.abs(v) < 1e-9 ? 'eq' : (v > 0) !== inverso ? 'up' : 'dn';
  return `<span class="fncmp ${bom}"><b>${t}</b> vs ${rot}</span>`;
}

// ---------- montagem ----------
function barraPeriodo(esc, ls) {
  return `<div class="fnbar">
    <div class="fnseg" role="tablist">${PERIODOS.map(([k, n]) => `<button class="${F.per === k ? 'on' : ''}" data-per="${k}">${n}</button>`).join('')}</div>
    <div class="fndatas" ${F.per === 'outro' ? '' : 'hidden'}><input type="date" id="fDe" value="${F.de}"><span class="mu">até</span><input type="date" id="fAte" value="${F.ate}"></div>
    <span class="fnquando mu sm" id="fQuando"></span><span class="sp"></span>
    ${ls.length > 1 ? `<select id="fLoja" style="width:200px"><option value="">Todas as lojas</option>${ls.map(l => `<option value="${l.id}" ${F.loja === l.id ? 'selected' : ''}>${esc(l.nome)}</option>`).join('')}</select>` : ''}
    <label class="chk"><input type="checkbox" id="fTeste" ${F.teste ? 'checked' : ''}> Incluir testes</label></div>`;
}
function ligarBarra(C, el, refazer) {
  const { $ } = C;
  el.querySelectorAll('[data-per]').forEach(b => b.onclick = () => { F.per = b.dataset.per; if (F.per === 'outro' && !F.de) { const h = meia(iso(new Date())); F.de = iso(mais(h, -29)); F.ate = iso(h); } refazer(); });
  const datas = () => { F.de = $('#fDe').value; F.ate = $('#fAte').value; if (F.de && F.ate && F.ate < F.de) F.ate = F.de; refazer(); };
  if ($('#fDe')) { $('#fDe').onchange = datas; $('#fAte').onchange = datas; }
  if ($('#fLoja')) $('#fLoja').onchange = e => { F.loja = e.target.value; refazer(); };
  $('#fTeste').onchange = e => { F.teste = e.target.checked; refazer(); };
}
const descrPeriodo = P => {
  const f = mais(P.fim, P.fim.getHours() || P.fim.getMinutes() ? 0 : -1), a = iso(P.ini), b = iso(f);
  return a === b ? `${dataBR(a)}/${a.slice(0, 4)}` : `${dataBR(a)} a ${dataBR(b)}/${b.slice(0, 4)}`;
};

function kpis(C, R, A, Y, P) {
  const $c = C.brl, T = R.tot, ra = P.rotAnt, ry = 'ano anterior';
  const k = (nome, valor, sub, chave, op = {}, cls = '') => `<div class="kpi fnk ${cls}"><span>${nome}</span><b class="num">${valor}</b><small class="fnsub">${sub || '&nbsp;'}</small>
     <div class="fncmps">${A ? cmp(T[chave], A.tot[chave], ra, op) : ''}${Y ? cmp(T[chave], Y.tot[chave], ry, op) : ''}</div></div>`;
  return `<div class="grid4 fnkpi">
    ${k('Faturamento', $c(T.bruto), `${inteiro(T.vendas)} ${T.vendas === 1 ? 'venda' : 'vendas'}`, 'bruto')}
    ${k('CPV', $c(T.cmv), 'custo do vendido' + (T.bruto ? ' · ' + porc(T.cmv / T.bruto) : ''), 'cmv', { inverso: true })}
    ${k('Lucro bruto', $c(T.lucroBruto), 'faturamento − CPV', 'lucroBruto')}
    ${k('Margem bruta', porc(T.margemBruta), T.markup ? `markup ${txt(T.markup.toFixed(2))}×` : '', 'margemBruta', { tipo: 'pp' })}
    ${k('Taxas', $c(T.taxas), T.recebido ? `taxa efetiva ${porc(T.taxaEf)}` : 'cartão e Pix', 'taxas', { inverso: true })}
    ${k('Resultado', $c(T.resultado), `após CPV e taxas · ${porc(T.margem)}`, 'resultado', {}, 'fnluc')}
    ${k('Ticket médio', $c(Math.round(T.ticket)), 'por venda', 'ticket')}
    ${k('Itens por venda', T.ipv ? txt(T.ipv.toFixed(1)) : '0', `${inteiro(T.itens)} itens vendidos`, 'ipv')}
  </div>`;
}

const skeleton = () => `<div class="grid4 fnkpi">${'<div class="kpi fnk"><span>&nbsp;</span><b><i class="sk" style="width:60%;height:22px"></i></b><small>&nbsp;</small><div class="fncmps"><i class="sk" style="width:80%"></i></div></div>'.repeat(8)}</div>`;

// ---------- Início ----------
export async function dashInicio(C, el) {
  const { esc, lojas } = C;
  await lerTaxas(C);
  const ls = lojas(); if (F.loja && !ls.some(l => l.id === F.loja)) F.loja = '';
  const refazer = () => dashInicio(C, el);
  el.innerHTML = `<div class="fnhead2"><h2>Resultado</h2>${barraPeriodo(esc, ls)}</div><div id="fCorpo">${skeleton()}</div>`;
  ligarBarra(C, el, refazer);
  const P = periodo(); el.querySelector('#fQuando').textContent = descrPeriodo(P);
  let D; try { D = await buscar(C, P); } catch (e) { el.querySelector('#fCorpo').innerHTML = `<p class="vazio">Não foi possível carregar o resultado: ${esc(e.message)}</p>`; return; }
  const Cp = el.querySelector('#fCorpo'); if (!Cp || !Cp.isConnected) return;
  const R = somar(D.atual, F.loja), A = D.ant ? somar(D.ant, F.loja) : null, Y = D.ano ? somar(D.ano, F.loja) : null;
  Cp.innerHTML = `${kpis(C, R, A, Y, P)}
    <div class="fnrow fnrow-ritmo">
     <section class="card fncard"><div class="fnch"><div><h2>Ritmo de vendas</h2><p class="mu sm">Faturamento acumulado, comparado com ${P.cheioAnt ? 'o ' + (P.rotAnt || 'ano anterior') + ' inteiro' : 'o período anterior'} e com o ano passado.</p></div><div class="fnleg" data-leg="ritmo"></div></div><div class="fnchart" data-ch="ritmo"></div></section>
     <section class="card fncard" data-ch="pace"></section>
    </div>
    <div class="fnrow fnrow-2">
     <section class="card fncard"><div class="fnch"><div><h2>Formas de pagamento</h2><p class="mu sm">Quanto entrou por cada forma e quanto fica de taxa.</p></div></div><div data-ch="formas"></div></section>
     <section class="card fncard"><div class="fnch"><div><h2>Lojas</h2><p class="mu sm">Faturamento e margem bruta de cada loja.</p></div></div><div data-ch="lojas"></div></section>
    </div>
    <section class="card fncard"><div class="fnch"><div><h2>Vendas por loja</h2><p class="mu sm">Faturamento de cada loja no período, ao lado do período anterior e do ano passado.</p></div><div class="fnleg" data-leg="ljcol"></div></div><div class="fnchart" data-ch="ljcol"></div></section>
    <div class="fnmais"><button class="btn" id="fAbrir">Abrir o financeiro completo</button><span class="mu sm">Curva ABC, CPV por dia, mapa de horários, fechamento e planilha.</span></div>`;
  desenhar(C, Cp, R, D, P, A, Y);
  Cp.querySelector('#fAbrir').onclick = () => C.ir('fin');
}

// ---------- Financeiro ----------
export async function telaFinanceiro(C) {
  const { S, $, esc, lojas } = C;
  const M = $('#main'), dono = S.papel === 'dono';
  await lerTaxas(C);
  const ls = lojas(); if (F.loja && !ls.some(l => l.id === F.loja)) F.loja = '';
  const refazer = () => telaFinanceiro(C);
  M.innerHTML = `<div class="head"><div><h1>Financeiro</h1><p>Faturamento, CPV, margem, taxas e resultado, comparados ao período anterior e ao ano passado.</p></div>
    <div class="row">${dono ? '<button class="btn" id="fTaxas">Taxas</button>' : ''}<button class="btn" id="fCsv">Exportar planilha</button></div></div>
    ${barraPeriodo(esc, ls)}<div id="fCorpo">${skeleton()}</div>`;
  ligarBarra(C, M, refazer);
  if (dono) $('#fTaxas').onclick = () => editarTaxas(C, refazer);
  const P = periodo(); $('#fQuando').textContent = descrPeriodo(P);
  let D; try { D = await buscar(C, P); } catch (e) { $('#fCorpo').innerHTML = `<p class="vazio">Não foi possível carregar: ${esc(e.message)}</p>`; return; }
  const Cp = $('#fCorpo'); if (!Cp || S.tela !== 'fin') return;
  const R = somar(D.atual, F.loja), A = D.ant ? somar(D.ant, F.loja) : null, Y = D.ano ? somar(D.ano, F.loja) : null, T = R.tot;
  const porHora = F.per === 'dia';
  Cp.innerHTML = `${kpis(C, R, A, Y, P)}
   ${T.semCusto ? `<div class="aviso" style="margin-top:14px"><span>${T.semCusto} ${T.semCusto === 1 ? 'item vendido estava' : 'itens vendidos estavam'} sem custo no cadastro. O CPV aparece menor e o lucro maior do que o real até o custo ser preenchido (entra sozinho ao lançar a NF-e de compra).</span></div>` : ''}
   ${!F.taxasSalvas ? `<div class="aviso info" style="margin-top:14px"><span>As taxas estão no padrão (Pix ${txt(TAXA_PADRAO.pix)}%, débito ${txt(TAXA_PADRAO.debito)}%, crédito ${txt(TAXA_PADRAO.credito)}%). ${dono ? 'Confira as do seu plano no Mercado Pago e ajuste em <b>Taxas</b>.' : 'O dono pode ajustar em Taxas.'}</span></div>` : ''}
   <div class="fnrow fnrow-ritmo">
    <section class="card fncard"><div class="fnch"><div><h2>Ritmo de vendas</h2><p class="mu sm">Faturamento acumulado, comparado com ${P.cheioAnt ? 'o ' + (P.rotAnt || 'ano anterior') + ' inteiro' : 'o período anterior'} e com o ano passado.</p></div><div class="fnleg" data-leg="ritmo"></div></div><div class="fnchart" data-ch="ritmo"></div></section>
    <section class="card fncard" data-ch="pace"></section>
   </div>
   <section class="card fncard"><div class="fnch"><div><h2>${porHora ? 'Faturamento por hora' : 'Composição do faturamento'}</h2><p class="mu sm">${porHora ? 'Quanto entrou em cada hora do dia.' : 'Cada coluna é o faturamento do dia, dividido em CPV, taxas e resultado.'}</p></div>
    ${porHora ? '' : '<div class="fnleg"><span><i style="background:var(--fn-custo)"></i>CPV</span><span><i style="background:var(--fn-taxa)"></i>Taxas</span><span><i style="background:var(--fn-lucro)"></i>Resultado</span></div>'}</div><div class="fnchart" data-ch="colunas"></div></section>
   <section class="card fncard"><div class="fnch"><div><h2>Vendas por loja</h2><p class="mu sm">Faturamento de cada loja no período, ao lado do período anterior e do ano passado.</p></div><div class="fnleg" data-leg="ljcol"></div></div><div class="fnchart" data-ch="ljcol"></div></section>
   <div class="fnrow fnrow-2">
    <section class="card fncard"><div class="fnch"><div><h2>Formas de pagamento</h2><p class="mu sm">Quanto entrou por cada forma e quanto fica de taxa.</p></div></div><div data-ch="formas"></div></section>
    <section class="card fncard"><div class="fnch"><div><h2>Lojas</h2><p class="mu sm">Faturamento e margem bruta de cada loja.</p></div></div><div data-ch="lojas"></div></section>
   </div>
   <section class="card fncard" id="fAbc"></section>
   <section class="card fncard"><div class="fnch"><div><h2>Mapa de horários</h2><p class="mu sm">Faturamento por dia da semana e hora. Ajuda a decidir reposição, limpeza e promoções.</p></div><div class="fnleg"><span class="fnescala"><em>menos</em><i></i><em>mais</em></span></div></div><div data-ch="mapa"></div></section>
   <h2 style="font-size:18px;margin:26px 0 12px">Fechamento</h2><div data-ch="fech"></div>
   <p class="mu sm" style="margin-top:10px">Só vendas pagas${F.teste ? ', incluindo as de teste' : ', sem as de teste'}. CPV é o custo que estava no cadastro na hora de cada venda. Taxas estimadas pelas taxas informadas em Taxas. Estornos contam no dia da venda original.${T.nEstorno ? ` Estornos no período: ${C.brl(T.estornado)} em ${T.nEstorno} ${T.nEstorno === 1 ? 'pagamento' : 'pagamentos'}.` : ''}${T.notas ? ` Compras lançadas por NF-e: ${C.brl(T.compras)} em ${T.notas} ${T.notas === 1 ? 'nota' : 'notas'}.` : ''}</p>`;
  desenhar(C, Cp, R, D, P, A, Y);
  abc(C, Cp.querySelector('#fAbc'), R);
  $('#fCsv').onclick = () => exportar(D.atual, F.loja, id => S.locais.find(l => l.id === id)?.nome || 'Loja removida', P);
}

// ---------- desenho dos gráficos ----------
function desenhar(C, Cp, R, D, P, A, Y) {
  const larg = el => Math.max(300, Math.floor(el.clientWidth || 600));
  const q = s => Cp.querySelector(`[data-ch="${s}"]`);
  if (q('ritmo')) ritmo(C, q('ritmo'), Cp.querySelector('[data-leg="ritmo"]'), D, P, larg(q('ritmo')));
  if (q('pace')) pace(C, q('pace'), R, D, P);
  if (q('colunas')) colunas(C, q('colunas'), R, P, larg(q('colunas')));
  if (q('formas')) formas(C, q('formas'), R);
  if (q('lojas')) lojasCh(C, q('lojas'), R);
  if (q('ljcol')) lojasCol(C, q('ljcol'), Cp.querySelector('[data-leg="ljcol"]'), R, A, Y, P, larg(q('ljcol')));
  if (q('mapa')) mapa(C, q('mapa'), R);
  if (q('fech')) fechamento(C, q('fech'), R, P);
  dicas(Cp);
}

// tooltip único: qualquer elemento com data-tip
function dicas(raiz) {
  let tip = document.getElementById('fnTip');
  if (!tip) { tip = document.createElement('div'); tip.id = 'fnTip'; tip.className = 'fntip'; document.body.appendChild(tip); }
  const mostrar = e => {
    const alvo = e.target.closest?.('[data-tip]');
    raiz.querySelectorAll('.fnhot').forEach(x => x !== alvo && x.classList.remove('fnhot'));
    if (!alvo) { tip.classList.remove('on'); return; }
    alvo.classList.add('fnhot'); tip.innerHTML = alvo.dataset.tip; tip.classList.add('on');
    const w = tip.offsetWidth, h = tip.offsetHeight; let x = e.clientX + 14, y = e.clientY - h - 12;
    if (x + w > innerWidth - 8) x = e.clientX - w - 14; if (y < 8) y = e.clientY + 16;
    tip.style.left = Math.max(8, x) + 'px'; tip.style.top = y + 'px';
  };
  raiz.addEventListener('mousemove', mostrar); raiz.addEventListener('click', mostrar);
  raiz.addEventListener('mouseleave', () => { tip.classList.remove('on'); raiz.querySelectorAll('.fnhot').forEach(x => x.classList.remove('fnhot')); });
}

function topo(max) { if (max <= 0) return { p: 100, max: 400 }; const r = max / 4, m = 10 ** Math.floor(Math.log10(r)), p = [1, 2, 2.5, 5, 10].map(x => x * m).find(x => x >= r); return { p, max: Math.ceil(max / p) * p }; }
function curto(c) { const r = c / 100; return r >= 1e6 ? 'R$ ' + txt(+(r / 1e6).toFixed(1)) + ' mi' : r >= 1000 ? 'R$ ' + txt(+(r / 1000).toFixed(1)) + ' mil' : 'R$ ' + Math.round(r); }
function eixoY(W, H, pe, pb, pt, max) {
  const t = topo(max), k = (H - pb - pt) / t.max; let s = '';
  for (let v = 0; v <= t.max + 1e-6; v += t.p) { const y = H - pb - v * k; s += `<line x1="${pe}" x2="${W}" y1="${y}" y2="${y}" class="fngl${v === 0 ? ' fnbase' : ''}"/><text x="${pe - 8}" y="${y + 4}" text-anchor="end" class="fnax">${curto(v)}</text>`; }
  return { s, k };
}

// acumulado por posição (hora para "Dia", dia para o resto)
function acumulado(r, ini, n, lojaId, porHora) {
  const v = new Array(n).fill(0); if (!r) return null;
  const ok = x => !lojaId || x.local_id === lojaId;
  if (porHora) for (const x of (r.horas || []).filter(ok)) { if (x.hora < n) v[x.hora] += +x.bruto; }
  else { const base = meia(iso(ini)); for (const x of (r.dias || []).filter(ok)) { const i = Math.round((meia(x.dia) - base) / 864e5); if (i >= 0 && i < n) v[i] += +x.bruto; } }
  for (let i = 1; i < n; i++) v[i] += v[i - 1];
  return v;
}

function ritmo(C, el, leg, D, P, W) {
  const porHora = F.per === 'dia', $c = C.brl;
  const fimUn = P.unidade || P.fim;
  const n = porHora ? 24 : Math.max(1, Math.round((meia(iso(mais(fimUn, -0.0001))) - meia(iso(P.ini))) / 864e5) + 1);
  const passou = porHora ? P.agora.getHours() + 1 : Math.min(n, Math.round((meia(iso(P.agora)) - meia(iso(P.ini))) / 864e5) + 1);
  const atual = acumulado(D.atual, P.ini, n, F.loja, porHora)?.slice(0, P.unidade ? passou : n);
  const ant = P.cheioAnt ? acumulado(D.cAnt, P.cheioAnt[0], n, F.loja, porHora) : acumulado(D.ant, P.antIni, n, F.loja, porHora);
  const ano = P.cheioAno ? acumulado(D.cAno, P.cheioAno[0], n, F.loja, porHora) : acumulado(D.ano, P.anoIni, n, F.loja, porHora);
  const rotA = P.cheioAnt ? (F.per === 'ano' ? 'Ano anterior' : F.per === 'mes' ? 'Mês anterior' : F.per === 'semana' ? 'Semana passada' : 'Ontem') : 'Período anterior';
  const series = [['atual', 'Atual', atual], ...(F.per === 'ano' ? [] : [['ant', rotA, ant]]), ['ano', F.per === 'ano' ? 'Ano anterior' : 'Ano passado', F.per === 'ano' ? ant : ano]].filter(s => s[2]);
  // projeção: segue o ritmo médio até o fim da unidade
  let proj = null;
  if (P.unidade && atual && atual.length && atual.length < n) { const frac = (P.agora - P.ini) / (P.unidade - P.ini), tot = atual[atual.length - 1]; if (frac > .05 && tot > 0) proj = tot / frac; }
  const max = Math.max(1, ...series.flatMap(s => s[2]), proj || 0);
  if (!series.some(s => s[2].some(v => v > 0))) { el.innerHTML = '<p class="vazio">Sem vendas para comparar neste período.</p>'; leg.innerHTML = ''; return; }
  const H = W < 560 ? 210 : 250, pe = 66, pb = 28, pt = 10, ax = eixoY(W, H, pe, pb, pt, max);
  const X = i => pe + 6 + (n === 1 ? 0 : i * (W - pe - 12) / (n - 1)), Y = v => H - pb - v * ax.k;
  const rotX = i => porHora ? i + 'h' : F.per === 'semana' ? SEM[(i + 1) % 7] : F.per === 'ano' ? null : String(+iso(mais(P.ini, i)).slice(8, 10));
  let s = ax.s;
  if (F.per === 'ano') { for (let m = 0; m < 12; m++) { const d = new Date(P.ini.getFullYear(), m, 1), i = Math.round((d - P.ini) / 864e5); s += `<text x="${X(i)}" y="${H - 8}" text-anchor="start" class="fnax">${MES[m]}</text>`; } }
  else { const cada = Math.ceil(n / (W < 560 ? 6 : 12)); for (let i = 0; i < n; i += cada) s += `<text x="${X(i)}" y="${H - 8}" text-anchor="middle" class="fnax">${rotX(i)}</text>`; }
  const linha = (arr, cor, cls) => `<path d="${arr.map((v, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1)).join('')}" fill="none" stroke="${cor}" class="${cls}"/>`;
  for (const [k, , arr] of series.slice().reverse()) s += linha(arr, COR[k], k === 'atual' ? 'fnln fnln-a' : 'fnln');
  if (atual && atual.length) {
    const i = atual.length - 1;
    if (proj) s += `<path d="M${X(i)} ${Y(atual[i])}L${X(n - 1)} ${Y(proj)}" fill="none" stroke="${COR.atual}" class="fnln fnproj"/><circle cx="${X(n - 1)}" cy="${Y(proj)}" r="4" fill="var(--p1)" stroke="${COR.atual}" stroke-width="2"/>`;
    s += `<circle cx="${X(i)}" cy="${Y(atual[i])}" r="4.5" fill="${COR.atual}" stroke="var(--p1)" stroke-width="2"/>`;
  }
  // colunas invisíveis com a dica de cada posição
  const cw = n === 1 ? W - pe : (W - pe - 12) / (n - 1);
  for (let i = 0; i < n; i++) {
    const quando = porHora ? `até ${i}h59` : F.per === 'ano' ? `até ${dataBR(iso(mais(P.ini, i)))}` : `até o dia ${rotX(i) || dataBR(iso(mais(P.ini, i)))}`;
    const tip = `<b>${quando}</b>` + series.map(([k, nm, arr]) => arr[i] != null ? `<span><i style="background:${COR[k]}"></i>${nm}<em>${$c(arr[i])}</em></span>` : '').join('') + (proj && i === n - 1 ? `<span><i class="fnpi"></i>Projeção<em>${$c(Math.round(proj))}</em></span>` : '');
    s += `<rect x="${X(i) - cw / 2}" y="${pt}" width="${cw}" height="${H - pb - pt}" class="fnhit" data-tip='${tip.replace(/'/g, '&#39;')}'/>`;
  }
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="fnsvg" role="img" aria-label="Faturamento acumulado">${s}</svg>`;
  leg.innerHTML = series.map(([k, nm, arr]) => `<span><i style="background:${COR[k]}"></i>${nm}</span>`).join('') + (proj ? '<span><i class="fnpi"></i>Projeção</span>' : '');
}

function pace(C, el, R, D, P) {
  const $c = C.brl, T = R.tot;
  const diasPassados = Math.max((Math.min(P.agora, P.fim) - P.ini) / 864e5, 1 / 24);
  const mediaDia = T.bruto / Math.max(diasPassados, F.per === 'dia' ? 1 : diasPassados);
  const A = D.ant ? somar(D.ant, F.loja).tot : null;
  const diasAnt = P.rotAnt ? Math.max((P.antFim - P.antIni) / 864e5, 1 / 24) : 0;
  const acel = A && A.bruto ? (T.bruto / diasPassados) / (A.bruto / diasAnt) - 1 : null;
  const nomeUn = { dia: 'do dia', semana: 'da semana', mes: 'do mês', ano: 'do ano' }[F.per];
  let corpo;
  if (P.unidade) {
    const frac = (P.agora - P.ini) / (P.unidade - P.ini), ref = D.cAnt ? somar(D.cAnt, F.loja).tot.bruto : 0;
    const proj = frac > .05 && T.bruto > 0 ? T.bruto / frac : null;
    const rotRef = F.per === 'ano' ? 'ano anterior inteiro' : F.per === 'mes' ? 'mês anterior inteiro' : F.per === 'semana' ? 'semana passada inteira' : 'ontem inteiro';
    const esc = Math.max(proj || 0, ref, T.bruto) * 1.08 || 1, pc = v => Math.min(100, v / esc * 100).toFixed(2) + '%';
    const dif = proj && ref ? proj / ref - 1 : null;
    corpo = `<div class="fnpace-n"><span>Projeção de fechamento ${nomeUn}</span><b class="num">${proj ? $c(Math.round(proj)) : '—'}</b>
       <small>${proj ? (dif != null ? `<span class="fncmp ${dif >= 0 ? 'up' : 'dn'}"><b>${dif >= 0 ? '+' : ''}${porc(dif)}</b> vs ${rotRef}</span>` : 'Sem base no período anterior') : 'Cedo demais para projetar com segurança.'}</small></div>
      <div class="fnmeter" aria-hidden="true"><i class="fnm-p" style="width:${pc(proj || 0)}"></i><i class="fnm-r" style="width:${pc(T.bruto)}"></i>${ref ? `<em class="fnm-ref" style="left:${pc(ref)}"></em>` : ''}</div>
      <div class="fnmeter-l"><span><i class="fnm-r"></i>Realizado ${$c(T.bruto)}</span>${proj ? `<span><i class="fnm-p"></i>Projeção</span>` : ''}${ref ? `<span><i class="fnm-ref"></i>${rotRef[0].toUpperCase() + rotRef.slice(1)} ${$c(ref)}</span>` : ''}</div>
      <div class="fnpace-g"><div><span>Decorrido</span><b class="num">${porc(Math.min(1, frac))}</b></div><div><span>${F.per === 'dia' ? 'Média por hora' : 'Média por dia'}</span><b class="num">${$c(Math.round(F.per === 'dia' ? T.bruto / Math.max(1, P.agora.getHours() + P.agora.getMinutes() / 60) : T.bruto / diasPassados))}</b></div>
      <div><span>Aceleração</span><b class="num ${acel == null ? '' : acel >= 0 ? 'fnup' : 'fndn'}">${acel == null ? '—' : (acel >= 0 ? '+' : '') + porc(acel)}</b><small>ritmo vs ${P.rotAnt || 'ano anterior'}</small></div></div>`;
  } else {
    corpo = `<div class="fnpace-n"><span>Média por dia</span><b class="num">${$c(Math.round(mediaDia))}</b><small>${inteiro(diasPassados)} dias no período</small></div>
      <div class="fnpace-g"><div><span>Vendas por dia</span><b class="num">${txt((T.vendas / diasPassados).toFixed(1))}</b></div><div><span>Resultado por dia</span><b class="num">${$c(Math.round(T.resultado / diasPassados))}</b></div>
      <div><span>Aceleração</span><b class="num ${acel == null ? '' : acel >= 0 ? 'fnup' : 'fndn'}">${acel == null ? '—' : (acel >= 0 ? '+' : '') + porc(acel)}</b><small>ritmo vs ${P.rotAnt}</small></div></div>`;
  }
  el.innerHTML = `<div class="fnch"><div><h2>Ritmo ${nomeUn || 'do período'}</h2><p class="mu sm">${P.unidade ? 'Se continuar no ritmo de agora, onde fecha.' : 'Média diária e aceleração em relação ao período anterior.'}</p></div></div>${corpo}`;
}

function colunas(C, el, R, P, W) {
  const $c = C.brl;
  if (F.per === 'dia') {
    const v = new Array(24).fill(0); for (const [k, x] of Object.entries(R.hora)) v[+k.split('|')[1]] += x.bruto;
    if (!v.some(Boolean)) { el.innerHTML = '<p class="vazio">Sem vendas hoje.</p>'; return; }
    const H = 200, pe = 66, pb = 26, pt = 8, ax = eixoY(W, H, pe, pb, pt, Math.max(...v)), lw = (W - pe) / 24, bw = Math.max(3, Math.min(28, lw * .66));
    let s = ax.s; v.forEach((x, i) => { const cx = pe + lw * i + lw / 2, h = x * ax.k; if (x) s += `<rect x="${cx - bw / 2}" y="${H - pb - h}" width="${bw}" height="${h}" rx="3" class="fn-a"/>`; if (i % (W < 560 ? 4 : 2) === 0) s += `<text x="${cx}" y="${H - 6}" text-anchor="middle" class="fnax">${i}h</text>`; s += `<rect x="${cx - lw / 2}" y="${pt}" width="${lw}" height="${H - pb - pt}" class="fnhit" data-tip="<b>${i}h às ${i}h59</b><span>Faturamento<em>${$c(x)}</em></span>"/>`; });
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="fnsvg">${s}</svg>`; return;
  }
  const nDias = Math.round((P.fim - P.ini) / 864e5), porMes = nDias > 62, lin = {};
  if (!porMes) for (let d = new Date(P.ini); d < P.fim; d = mais(d, 1)) lin[iso(d)] = { bruto: 0, cmv: 0, taxas: 0 };
  for (const [d, x] of Object.entries(R.dia)) { const k = porMes ? d.slice(0, 7) : d, y = (lin[k] ??= { bruto: 0, cmv: 0, taxas: 0 }); y.bruto += x.bruto; y.cmv += x.cmv; y.taxas += x.taxas; }
  const ordem = Object.keys(lin).sort(), rot = k => porMes ? MES[+k.slice(5, 7) - 1] + '/' + k.slice(2, 4) : dataBR(k);
  if (!ordem.some(k => lin[k].bruto)) { el.innerHTML = '<p class="vazio">Sem vendas no período.</p>'; return; }
  const H = W < 560 ? 200 : 230, pe = 66, pb = 26, pt = 8, ax = eixoY(W, H, pe, pb, pt, Math.max(...ordem.map(k => lin[k].bruto)));
  const n = ordem.length, lw = (W - pe) / n, bw = Math.max(3, Math.min(34, lw * .64)), cada = Math.ceil(n / (W < 560 ? 6 : 12));
  let s = ax.s;
  ordem.forEach((k, i) => {
    const x = lin[k], cx = pe + lw * i + lw / 2, res = Math.max(0, x.bruto - x.cmv - x.taxas); let y = H - pb;
    const seg = (v, cls) => { if (v <= 0) return ''; const h = Math.max(1, v * ax.k - 1.5); y -= h + 1.5; return `<rect x="${cx - bw / 2}" y="${y + 1.5}" width="${bw}" height="${h}" rx="2" class="${cls}"/>`; };
    s += `<g>${seg(x.cmv, 'fn-c')}${seg(x.taxas, 'fn-t')}${seg(res, 'fn-l')}</g>`;
    if (i % cada === 0) s += `<text x="${cx}" y="${H - 6}" text-anchor="middle" class="fnax">${rot(k)}</text>`;
    s += `<rect x="${cx - lw / 2}" y="${pt}" width="${lw}" height="${H - pb - pt}" class="fnhit" data-tip="<b>${rot(k)}</b><span>Faturamento<em>${$c(x.bruto)}</em></span><span><i style='background:var(--fn-custo)'></i>CPV<em>${$c(x.cmv)}</em></span><span><i style='background:var(--fn-taxa)'></i>Taxas<em>${$c(x.taxas)}</em></span><span><i style='background:var(--fn-lucro)'></i>Resultado<em>${$c(x.bruto - x.cmv - x.taxas)}</em></span><span>Margem bruta<em>${x.bruto ? porc((x.bruto - x.cmv) / x.bruto) : '—'}</em></span>"/>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="fnsvg" role="img" aria-label="Composição do faturamento">${s}</svg>`;
}

// pizza (rosca) das formas de pagamento, com a lista ao lado
function formas(C, el, R) {
  const $c = C.brl, itens = FORMAS.map(([k, nome, cor]) => { const f = R.forma[k] || { n: 0, valor: 0, taxas: 0 }; return { k, nome, cor, qtd: f.n, valor: f.valor, taxas: f.taxas }; }).filter(x => x.valor > 0);
  const tot = itens.reduce((s, x) => s + x.valor, 0);
  if (!tot) { el.innerHTML = '<p class="vazio">Sem pagamentos no período.</p>'; return; }
  const r = 78, rr = 52, cx = 90, cy = 90; let a0 = -Math.PI / 2, s = '';
  const pt = (a, rad) => [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
  for (const x of itens) {
    const ang = x.valor / tot * Math.PI * 2, a1 = a0 + ang, big = ang > Math.PI ? 1 : 0;
    const tip = `<b>${x.nome}</b><span>Pagamentos<em>${inteiro(x.qtd)}</em></span><span>Recebido<em>${$c(x.valor)}</em></span><span>Participação<em>${porc(x.valor / tot)}</em></span><span>Taxa (${txt(taxa(x.k))}%)<em>${$c(x.taxas)}</em></span>`;
    if (itens.length === 1) s += `<circle cx="${cx}" cy="${cy}" r="${(r + rr) / 2}" fill="none" stroke="${x.cor}" stroke-width="${r - rr}" data-tip="${tip}" class="fnfat"/>`;
    else { const [x0, y0] = pt(a0, r), [x1, y1] = pt(a1, r), [x2, y2] = pt(a1, rr), [x3, y3] = pt(a0, rr);
      s += `<path d="M${x0} ${y0}A${r} ${r} 0 ${big} 1 ${x1} ${y1}L${x2} ${y2}A${rr} ${rr} 0 ${big} 0 ${x3} ${y3}Z" fill="${x.cor}" stroke="var(--p1)" stroke-width="2.5" stroke-linejoin="round" data-tip="${tip}" class="fnfat"/>`; }
    a0 = a1;
  }
  s += `<text x="${cx}" y="${cy - 4}" text-anchor="middle" class="fndc-l">Recebido</text><text x="${cx}" y="${cy + 15}" text-anchor="middle" class="fndc-v">${curto(tot)}</text>`;
  el.innerHTML = `<div class="fndonut"><svg viewBox="0 0 180 180" class="fndsvg" role="img" aria-label="Formas de pagamento">${s}</svg>
    <table class="fnlista"><thead><tr><th></th><th class="n">Recebido</th><th class="n">Part.</th></tr></thead><tbody>
    ${itens.map(x => `<tr><td><i style="background:${x.cor}"></i>${x.nome}<small>${inteiro(x.qtd)} ${x.qtd === 1 ? 'pagamento' : 'pagamentos'} · taxa ${$c(x.taxas)}</small><small>líquido ${$c(x.valor - x.taxas)}</small></td><td class="n num"><b>${$c(x.valor)}</b></td><td class="n num">${porc(x.valor / tot)}</td></tr>`).join('')}
    </tbody><tfoot><tr><td>Total<small>taxas ${$c(R.tot.taxas)} · líquido ${$c(tot - R.tot.taxas)}</small></td><td class="n num">${$c(tot)}</td><td class="n num">100%</td></tr></tfoot></table></div>`;
}

// barras horizontais por loja (uma cor só: aqui a cor é tamanho, não identidade)
function lojasCh(C, el, R) {
  const $c = C.brl, nome = id => C.S.locais.find(l => l.id === id)?.nome || 'Loja removida';
  const ls = Object.entries(R.loja).filter(([, x]) => x.vendas).sort((a, b) => b[1].bruto - a[1].bruto);
  if (!ls.length) { el.innerHTML = '<p class="vazio">Sem vendas no período.</p>'; return; }
  const max = ls[0][1].bruto || 1;
  el.innerHTML = `<div class="fnlj">${ls.map(([id, x]) => { const mb = x.bruto ? (x.bruto - x.cmv) / x.bruto : 0;
    return `<div class="fnlj-r" data-tip="<b>${C.esc(nome(id))}</b><span>Faturamento<em>${$c(x.bruto)}</em></span><span>Vendas<em>${inteiro(x.vendas)}</em></span><span>CPV<em>${$c(x.cmv)}</em></span><span>Margem bruta<em>${porc(mb)}</em></span><span>Resultado após taxas<em>${$c(x.bruto - x.cmv - x.taxas)}</em></span>">
      <div class="fnlj-n"><b>${C.esc(nome(id))}</b><span class="mu sm">${inteiro(x.vendas)} ${x.vendas === 1 ? 'venda' : 'vendas'} · margem ${porc(mb)}</span></div>
      <div class="fnlj-b"><i style="width:${Math.max(1.5, x.bruto / max * 100).toFixed(2)}%"></i></div><b class="num fnlj-v">${$c(x.bruto)}</b></div>`; }).join('')}</div>`;
}

// colunas por loja: atual x período anterior x ano passado (mesma duração)
function lojasCol(C, el, leg, R, A, Y, P, W) {
  const $c = C.brl, nome = id => C.S.locais.find(l => l.id === id)?.nome || 'Loja removida';
  const ids = Object.keys(R.loja).filter(id => R.loja[id].vendas).sort((a, b) => R.loja[b].bruto - R.loja[a].bruto);
  if (!ids.length) { el.innerHTML = '<p class="vazio">Sem vendas no período.</p>'; if (leg) leg.innerHTML = ''; return; }
  const val = (X, id) => X && X.loja[id] ? X.loja[id].bruto : 0;
  const rotA = P.rotAnt ? P.rotAnt.charAt(0).toUpperCase() + P.rotAnt.slice(1) : 'Período anterior';
  const ser = [['atual', 'Atual', R], ...(A && F.per !== 'ano' ? [['ant', rotA, A]] : []), ...(Y ? [['ano', 'Ano passado', Y]] : [])];
  if (leg) leg.innerHTML = ser.map(([k, n]) => `<span><i style="background:${COR[k]}"></i>${n}</span>`).join('');
  const max = Math.max(1, ...ids.flatMap(id => ser.map(x => val(x[2], id))));
  const H = W < 560 ? 220 : 250, pe = 66, pb = 30, pt = 8, ax = eixoY(W, H, pe, pb, pt, max);
  const n = ids.length, lw = (W - pe) / n, gap = 2, bw = Math.max(6, Math.min(36, (lw * .72 - gap * (ser.length - 1)) / ser.length)), gw = bw * ser.length + gap * (ser.length - 1);
  const maxCh = Math.max(4, Math.floor(lw / 7.2));
  let s = ax.s;
  ids.forEach((id, i) => {
    const cx = pe + lw * i + lw / 2, x0 = cx - gw / 2, nm = nome(id);
    ser.forEach(([k, , X], j) => { const v = val(X, id), h = v * ax.k; if (h > 0) s += `<rect x="${(x0 + j * (bw + gap)).toFixed(1)}" y="${(H - pb - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="3" fill="${COR[k]}"/>`; });
    const curtoNm = nm.length > maxCh ? nm.slice(0, maxCh - 1) + '…' : nm;
    s += `<text x="${cx}" y="${H - 9}" text-anchor="middle" class="fnax">${C.esc(curtoNm)}</text>`;
    const at = val(R, id), linhas = ser.map(([k, rot, X]) => { const v = val(X, id), d = k !== 'atual' && v ? (at - v) / v : null; return `<span><i style='background:${COR[k]}'></i>${rot}<em>${$c(v)}${d == null ? '' : ` (${d >= 0 ? '+' : ''}${porc(d)})`}</em></span>`; }).join('');
    s += `<rect x="${cx - lw / 2}" y="${pt}" width="${lw}" height="${H - pb - pt}" class="fnhit" data-tip="<b>${C.esc(nm)}</b>${linhas}<span>Vendas<em>${inteiro(R.loja[id].vendas)}</em></span>"/>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="fnsvg" role="img" aria-label="Vendas por loja">${s}</svg>`;
}

function mapa(C, el, R) {
  const $c = C.brl, ordemDias = [1, 2, 3, 4, 5, 6, 0];
  const vals = Object.values(R.hora).map(x => x.bruto), max = Math.max(0, ...vals);
  if (!max) { el.innerHTML = '<p class="vazio">Sem vendas no período.</p>'; return; }
  let h = '<div class="fnmapa"><span></span>';
  for (let i = 0; i < 24; i++) h += `<span class="fnmh">${i % 3 === 0 ? i + 'h' : ''}</span>`;
  for (const d of ordemDias) {
    h += `<span class="fnmd">${SEM[d]}</span>`;
    for (let i = 0; i < 24; i++) { const x = R.hora[d + '|' + i]; const a = x ? .14 + .86 * x.bruto / max : 0;
      h += `<i ${x ? `style="background:rgba(51,140,237,${a.toFixed(3)})" data-tip="<b>${SEM[d]}, ${i}h às ${i}h59</b><span>Faturamento<em>${$c(x.bruto)}</em></span><span>Vendas<em>${inteiro(x.vendas)}</em></span>"` : ''}></i>`; }
  }
  el.innerHTML = h + '</div>';
}

function fechamento(C, el, R, P) {
  const $c = C.brl, T = R.tot;
  const nDias = Math.round((P.fim - P.ini) / 864e5), porMes = nDias > 62, lin = {};
  if (!porMes) for (let d = new Date(P.ini); d < P.fim; d = mais(d, 1)) lin[iso(d)] = { vendas: 0, bruto: 0, cmv: 0, taxas: 0, compras: 0 };
  for (const [d, x] of Object.entries(R.dia)) { const k = porMes ? d.slice(0, 7) : d, y = (lin[k] ??= { vendas: 0, bruto: 0, cmv: 0, taxas: 0, compras: 0 }); for (const c in y) y[c] += x[c]; }
  const ordem = Object.keys(lin).sort().reverse(), rot = k => porMes ? MES[+k.slice(5, 7) - 1] + '/' + k.slice(2, 4) : dataBR(k), sem = k => porMes ? '' : SEM[meia(k).getDay()];
  const d = '<span class="fnd">—</span>';
  el.innerHTML = `<div class="tblwrap"><table class="tbl fntab"><thead><tr><th>${porMes ? 'Mês' : 'Dia'}</th><th class="n hc">Vendas</th><th class="n">Faturamento</th><th class="n hm">CPV</th><th class="n hm">Lucro bruto</th><th class="n hm">Taxas</th><th class="n">Resultado</th><th class="n">Margem</th><th class="n hm">Compras</th></tr></thead><tbody>
    ${ordem.map(k => { const x = lin[k], lb = x.bruto - x.cmv, res = lb - x.taxas;
      if (!x.vendas && !x.compras) return `<tr class="fnzero"><td class="num"><b>${rot(k)}</b> <span class="mu sm">${sem(k)}</span></td><td colspan="8" class="sm">Sem vendas</td></tr>`;
      return `<tr><td class="num"><b>${rot(k)}</b> <span class="mu sm">${sem(k)}</span></td><td class="n num hc">${x.vendas}</td><td class="n num">${$c(x.bruto)}</td><td class="n num hm">${$c(x.cmv)}</td><td class="n num hm">${$c(lb)}</td><td class="n num hm">${$c(x.taxas)}</td><td class="n num"><b>${$c(res)}</b></td><td class="n num">${x.bruto ? porc(res / x.bruto) : d}</td><td class="n num hm">${x.compras ? $c(x.compras) : d}</td></tr>`; }).join('') || '<tr><td colspan="9" class="vazio">Sem movimento no período.</td></tr>'}
   </tbody><tfoot><tr><td>Total</td><td class="n num hc">${T.vendas}</td><td class="n num">${$c(T.bruto)}</td><td class="n num hm">${$c(T.cmv)}</td><td class="n num hm">${$c(T.lucroBruto)}</td><td class="n num hm">${$c(T.taxas)}</td><td class="n num">${$c(T.resultado)}</td><td class="n num">${T.bruto ? porc(T.margem) : '—'}</td><td class="n num hm">${T.notas ? $c(T.compras) : '—'}</td></tr></tfoot></table></div>`;
}

// ---------- curva ABC ----------
function abc(C, el, R) {
  const $c = C.brl, esc = C.esc, nome = id => { const p = C.S.produtos.find(x => x.id === id); return p ? C.bonito(p.nome) : 'Produto removido'; };
  const metr = { bruto: ['Faturamento', x => x.bruto, v => $c(v)], lucro: ['Lucro bruto', x => x.bruto - x.cmv, v => $c(v)], qtd: ['Quantidade', x => x.qtd, v => inteiro(v)] };
  const [rotM, val, fmt] = metr[F.abc];
  const lista = Object.entries(R.prod).map(([id, x]) => ({ id, ...x, v: Math.max(0, val(x)) })).sort((a, b) => b.v - a.v || b.bruto - a.bruto);
  const tot = lista.reduce((s, x) => s + x.v, 0);
  let acc = 0; for (const x of lista) { x.part = tot ? x.v / tot : 0; const antes = acc; acc += x.part; x.acum = acc; x.cl = antes < .8 ? 'A' : antes < .95 ? 'B' : 'C'; }
  const cnt = { A: 0, B: 0, C: 0 }, som = { A: 0, B: 0, C: 0 }; lista.forEach(x => { cnt[x.cl]++; som[x.cl] += x.part; });
  const cab = `<div class="fnch"><div><h2>Curva ABC dos produtos</h2><p class="mu sm">Poucos produtos fazem a maior parte do resultado. A: até 80% do total · B: até 95% · C: o restante.</p></div>
    <div class="fnseg fnseg-s">${Object.entries(metr).map(([k, [n]]) => `<button class="${F.abc === k ? 'on' : ''}" data-abc="${k}">${n}</button>`).join('')}</div></div>`;
  if (!lista.length || !tot) { el.innerHTML = cab + '<p class="vazio">Sem produtos vendidos no período.</p>'; ligar(); return; }
  el.innerHTML = cab + '<div class="fnabc"><div class="fnabc-c"></div><div class="fnabc-g"></div></div>';
  const W = Math.max(300, Math.floor(el.querySelector('.fnabc-g').clientWidth || 600)), H = W < 560 ? 210 : 240, pe = 44, pb = 30, pt = 10, n = lista.length;
  const X = f => pe + f * (W - pe - 8), Y = f => H - pb - f * (H - pb - pt);
  let s = '';
  const xA = cnt.A / n, xB = (cnt.A + cnt.B) / n;
  [['A', 0, xA], ['B', xA, xB], ['C', xB, 1]].forEach(([c, a, b]) => { if (b > a) s += `<rect x="${X(a)}" y="${pt}" width="${X(b) - X(a)}" height="${H - pb - pt}" class="fnab fnab-${c}"/><text x="${(X(a) + X(b)) / 2}" y="${H - pb - 10}" text-anchor="middle" class="fnab-t">${c}</text>`; });
  for (const f of [0, .25, .5, .75, 1]) s += `<line x1="${pe}" x2="${W - 8}" y1="${Y(f)}" y2="${Y(f)}" class="fngl${f === 0 ? ' fnbase' : ''}"/><text x="${pe - 8}" y="${Y(f) + 4}" text-anchor="end" class="fnax">${f * 100}%</text>`;
  for (const f of [.8, .95]) s += `<line x1="${pe}" x2="${W - 8}" y1="${Y(f)}" y2="${Y(f)}" class="fnref"/><text x="${pe + 8}" y="${Y(f) - 5}" text-anchor="start" class="fnax">${f * 100}% do total</text>`;
  for (const f of [0, .25, .5, .75, 1]) s += `<text x="${X(f)}" y="${H - 10}" text-anchor="${f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}" class="fnax">${f * 100}%${f === .5 ? ' dos produtos' : ''}</text>`;
  const pts = [[0, 0], ...lista.map((x, i) => [(i + 1) / n, x.acum])];
  s += `<path d="${pts.map(([a, b], i) => (i ? 'L' : 'M') + X(a).toFixed(1) + ' ' + Y(b).toFixed(1)).join('')}L${X(1)} ${Y(0)}Z" class="fnabarea"/>`;
  s += `<path d="${pts.map(([a, b], i) => (i ? 'L' : 'M') + X(a).toFixed(1) + ' ' + Y(b).toFixed(1)).join('')}" fill="none" stroke="${COR.atual}" class="fnln fnln-a"/>`;
  if (n <= 300) lista.forEach((x, i) => { const cx = X((i + 1) / n), cy = Y(x.acum); s += `<circle cx="${cx}" cy="${cy}" r="${n <= 40 ? 4 : 2.5}" fill="${COR.atual}" stroke="var(--p1)" stroke-width="1.5"/><circle cx="${cx}" cy="${cy}" r="10" class="fnhit" data-tip="<b>${i + 1}º · ${esc(nome(x.id))}</b><span>${rotM}<em>${fmt(x.v)}</em></span><span>Participação<em>${porc(x.part)}</em></span><span>Acumulado<em>${porc(x.acum)}</em></span><span>Classe<em>${x.cl}</em></span>"/>`; });
  const mostra = F.abcTodos ? lista : lista.slice(0, 20);
  el.innerHTML = cab + `<div class="fnabc">
     <div class="fnabc-c">${['A', 'B', 'C'].map(c => `<div class="fnabc-k fnabc-${c}"><span>Classe ${c}</span><b class="num">${cnt[c]} ${cnt[c] === 1 ? 'produto' : 'produtos'}</b><small>${porc(cnt[c] / n)} do mix · ${porc(som[c])} do ${rotM.toLowerCase()}</small></div>`).join('')}</div>
     <div class="fnabc-g"><svg viewBox="0 0 ${W} ${H}" class="fnsvg" role="img" aria-label="Curva ABC">${s}</svg></div></div>
    <div class="tblwrap" style="margin-top:14px"><table class="tbl fntab"><thead><tr><th class="n">#</th><th>Produto</th><th>Classe</th><th class="n hc">Qtd.</th><th class="n">Faturamento</th><th class="n hm">CPV</th><th class="n hm">Lucro bruto</th><th class="n">Margem</th><th class="n hc">Part.</th><th class="n hm">Acum.</th></tr></thead><tbody>
     ${mostra.map((x, i) => `<tr><td class="n num mu">${i + 1}</td><td>${esc(nome(x.id))}</td><td><span class="pill fncl-${x.cl}">${x.cl}</span></td><td class="n num hc">${inteiro(x.qtd)}</td><td class="n num">${$c(x.bruto)}</td><td class="n num hm">${$c(x.cmv)}</td><td class="n num hm">${$c(x.bruto - x.cmv)}</td><td class="n num">${x.bruto ? porc((x.bruto - x.cmv) / x.bruto) : '—'}</td><td class="n num hc">${porc(x.part)}</td><td class="n num hm">${porc(x.acum)}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="row" style="margin-top:10px">${lista.length > 20 ? `<button class="btn sm" id="fAbcTodos">${F.abcTodos ? 'Mostrar só os 20 primeiros' : `Ver todos os ${lista.length} produtos`}</button>` : ''}<button class="btn sm" id="fAbcCsv">Exportar curva ABC</button></div>`;
  ligar();
  el.querySelector('#fAbcTodos')?.addEventListener('click', () => { F.abcTodos = !F.abcTodos; abc(C, el, R); });
  el.querySelector('#fAbcCsv').onclick = () => {
    const num = c => ((+c || 0) / 100).toFixed(2).replace('.', ',');
    baixar(`curva_abc_${F.abc}.csv`, [['Posição', 'Produto', 'Classe', 'Quantidade', 'Faturamento', 'CPV', 'Lucro bruto', 'Margem %', 'Participação %', 'Acumulado %'],
      ...lista.map((x, i) => [i + 1, nome(x.id), x.cl, txt(+x.qtd), num(x.bruto), num(x.cmv), num(x.bruto - x.cmv), x.bruto ? txt(((x.bruto - x.cmv) / x.bruto * 100).toFixed(1)) : '', txt((x.part * 100).toFixed(2)), txt((x.acum * 100).toFixed(2))])]);
  };
  function ligar() { el.querySelectorAll('[data-abc]').forEach(b => b.onclick = () => { F.abc = b.dataset.abc; abc(C, el, R); }); }
}

// ---------- planilhas ----------
function baixar(nomeArq, linhas) {
  const cel = v => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csv = '﻿' + linhas.map(l => l.map(cel).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); a.download = nomeArq;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function exportar(r, lojaId, nomeLoja, P) {
  const ok = x => !lojaId || x.local_id === lojaId, num = c => ((+c || 0) / 100).toFixed(2).replace('.', ',');
  const k = x => x.dia + '|' + x.local_id, L = {}, novo = x => ({ dia: x.dia, loja: x.local_id, vendas: 0, bruto: 0, cmv: 0, f: {}, est: 0, compras: 0 });
  for (const x of (r.dias || []).filter(ok)) Object.assign((L[k(x)] ??= novo(x)), { vendas: +x.vendas, bruto: +x.bruto, cmv: +x.cmv });
  for (const x of (r.formas || []).filter(ok)) { const y = (L[k(x)] ??= novo(x)); y.f[x.forma] = (y.f[x.forma] || 0) + +x.valor; y.est += +x.estornado; }
  for (const x of (r.compras || []).filter(ok)) (L[k(x)] ??= novo(x)).compras += +x.valor;
  const linhas = Object.values(L).sort((a, b) => a.dia.localeCompare(b.dia) || nomeLoja(a.loja).localeCompare(nomeLoja(b.loja))).map(y => {
    const t = FORMAS.reduce((s, [f]) => s + Math.round((y.f[f] || 0) * taxa(f) / 100), 0), lb = y.bruto - y.cmv, res = lb - t;
    return [y.dia.split('-').reverse().join('/'), nomeLoja(y.loja), y.vendas, num(y.bruto), num(y.f.pix), num(y.f.debito), num(y.f.credito), num(y.cmv), num(lb), y.bruto ? txt((lb / y.bruto * 100).toFixed(1)) : '', num(t), num(res), num(y.est), num(y.compras)];
  });
  baixar(`financeiro_${iso(P.ini)}_a_${iso(mais(P.fim, -0.0001))}.csv`, [['Dia', 'Loja', 'Vendas', 'Faturamento', 'Pix', 'Débito', 'Crédito', 'CPV', 'Lucro bruto', 'Margem bruta %', 'Taxas', 'Resultado após taxas', 'Estornos', 'Compras NF-e'], ...linhas]);
}

function editarTaxas(C, depois) {
  const { sb, S, $, toast, modal, fechar } = C;
  modal(`<h2>Taxas de pagamento</h2>
   <p class="mu sm">Informe as taxas do seu plano no Mercado Pago (aparecem no app ou no site do Mercado Pago, em taxas e prazos). Para o crédito, use a taxa à vista. Elas servem para calcular o líquido e o resultado.</p>
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
    F.taxas = t; F.taxasSalvas = true; fechar(); toast('Taxas salvas'); depois();
  };
}
