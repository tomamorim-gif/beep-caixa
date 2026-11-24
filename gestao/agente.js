// Agente "Configurar minha loja": monta o cadastro a partir das notas de compra (XML) ou da planilha modelo.
// Funciona só por regras (dicionário de palavras, NCM, markup); nenhuma IA externa e nenhum dado sai do Beep.
// Nada é gravado antes da aprovação; cada aprovação vira um lote que pode ser desfeito.
import { DIC_PADRAO } from './agente-dicionario.js';

let C; // contexto do painel (sb, S, utilitários)
const A = { modo: null, origem: null, linhas: [], filtro: 'todos', busca: '', pag: 0, lojas: null, leitura: null, agente: null, lote: null };
const POR_PAG = 60;
const UN_OK = ['UN', 'KG', 'G', 'L', 'ML', 'CX', 'PCT', 'DZ', 'FD'];
const chaveRasc = () => 'beep-agente-' + C.S.emp.id;

// ---------- utilitários ----------
const sem = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const texto = s => ' ' + sem(s).replace(/[^a-z0-9&]+/g, ' ').trim() + ' ';
const soDig = v => String(v ?? '').replace(/\D/g, '');
const ncmOk = v => /^\d{8}$/.test(v || '');
const eanOk = v => { const d = soDig(v); return /^\d{8,14}$/.test(d) && !/^0+$/.test(d) ? d : null; };
const z = s => String(s || '').replace(/^0+/, '');
const num = v => { if (typeof v === 'number') return Number.isFinite(v) ? v : null; let s = String(v ?? '').trim().replace(/[^\d,.\-]/g, ''); if (!s) return null; if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); const n = Number(s); return Number.isFinite(n) ? n : null; };
const reais = c => c == null ? '' : (c / 100).toFixed(2).replace('.', ',');
const cent = v => { const n = num(v); return n == null || n < 0 ? null : Math.round(n * 100); };
const markup = () => { const d = C.regra().divisor || 0.57; return 1 / d - 1; };
const pctTxt = m => (m * 100).toFixed(0) + '%';
const dataHora = iso => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
function guardar() { try { localStorage.setItem(chaveRasc(), JSON.stringify({ modo: A.modo, origem: A.origem, linhas: A.linhas, leitura: A.leitura, lojas: A.lojas, em: new Date().toISOString() })); } catch { } }
function lerRasc() { try { return JSON.parse(localStorage.getItem(chaveRasc()) || 'null'); } catch { return null; } }
function apagarRasc() { try { localStorage.removeItem(chaveRasc()); } catch { } }
let tGuardar; const guardarDepois = () => { clearTimeout(tGuardar); tGuardar = setTimeout(guardar, 400); };

function unidade(u, fator) {
  if (fator > 1) return 'UN';
  const x = sem(u).toUpperCase().replace(/[^A-Z]/g, '');
  const m = { UND: 'UN', UNID: 'UN', UNI: 'UN', U: 'UN', PC: 'UN', PCA: 'UN', PECA: 'UN', LT: 'L', LITRO: 'L', LTS: 'L', PT: 'PCT', PAC: 'PCT', PACOTE: 'PCT', FARDO: 'FD', CAIXA: 'CX', DUZIA: 'DZ', KILO: 'KG', QUILO: 'KG', GR: 'G', GRS: 'G' };
  const r = m[x] || x; return UN_OK.includes(r) ? r : 'UN';
}

// ---------- dicionário ----------
const dic = () => (A.agente?.dicionario?.length ? A.agente.dicionario : DIC_PADRAO);
// regra: a palavra que aparece primeiro no nome ganha; empate, a mais longa. Sem palavra, tenta o começo do NCM.
export function classificar(nome, ncm, regras) {
  const t = texto(nome); let best = null;
  for (const r of regras) for (const k0 of r.p || []) {
    const k = texto(k0).trim(); if (!k) continue;
    const pos = k.length < 4 ? t.indexOf(' ' + k + ' ') : t.indexOf(' ' + k);
    if (pos < 0) continue;
    if (!best || pos < best.pos || (pos === best.pos && k.length > best.n)) best = { c: r.c, s: r.s || '', pos, n: k.length, por: 'palavra', k: k0.trim() };
  }
  if (best) return best;
  const n = soDig(ncm);
  if (n) { let m = null; for (const r of regras) for (const p of r.ncm || []) if (p && n.startsWith(p) && (!m || p.length > m.n)) m = { c: r.c, s: r.s || '', n: p.length, por: 'ncm', k: p }; if (m) return m; }
  return null;
}

// ---------- estado do catálogo atual ----------
function indices() {
  const S = C.S, porEan = new Map(), porNome = new Map(), porForn = new Map();
  S.produtos.forEach(p => { if (p.ean) porEan.set(z(p.ean), p); porNome.set(texto(p.nome).trim(), p); });
  S.codigos.forEach(c => { const p = S.produtos.find(x => x.id === c.produto_id); if (p) porEan.set(z(c.ean), p); });
  S.codForn.forEach(c => { const p = S.produtos.find(x => x.id === c.produto_id); if (p) porForn.set(c.fornecedor_cnpj + '|' + c.codigo, p); });
  return { porEan, porNome, porForn };
}

function novaLinha(o, idx) {
  const regras = dic(), cl = classificar(o.nome, o.ncm, regras.filter(r => !o.cat || sem(r.c) === sem(o.cat))) || (o.cat ? null : classificar(o.nome, o.ncm, regras));
  let existente = null, parecido = null;
  if (o.ean) existente = idx.porEan.get(z(o.ean)) || null;
  if (!existente && o.fornCnpj && o.fornCod) existente = idx.porForn.get(o.fornCnpj + '|' + o.fornCod) || null;
  if (!existente) parecido = idx.porNome.get(texto(o.nome).trim()) || null;
  const preco = o.preco > 0 ? o.preco : (o.custo > 0 ? C.precoSugerido(o.custo) : null);
  return {
    k: 0, incluir: !existente && !parecido, nome: o.nome, ean: o.ean || '', un: o.un || 'UN', custo: o.custo || 0, preco, precoManual: o.preco > 0,
    cat: o.cat || cl?.c || '', sub: o.cat ? (o.sub || cl?.s || '') : (cl?.s || ''), catPor: o.cat ? 'planilha' : (cl?.por || null), catChave: cl?.k || '',
    ncm: ncmOk(soDig(o.ncm)) ? soDig(o.ncm) : '', ncmLido: o.ncm || '', cest: o.cest || '', grupo: o.grupo || null, st: o.st ?? null,
    fornCnpj: o.fornCnpj || '', fornCod: o.fornCod || '', fator: o.fator || 1, origem: o.origem || '', emissao: o.emissao || '',
    existente: existente ? { id: existente.id, nome: existente.nome } : null, parecido: parecido ? { id: parecido.id, nome: parecido.nome } : null, repetido: 0
  };
}

// o que precisa de conferência em cada linha
function motivos(l) {
  const m = [];
  if (l.existente) return ['ja'];
  if (l.parecido) m.push('parecido');
  if (!l.ean) m.push('semean');
  if (!ncmOk(l.ncm)) m.push('semncm');
  if (!l.cat) m.push('semcat');
  if (!(l.preco > 0)) m.push('sempreco');
  else if (l.custo > 0 && l.preco <= l.custo) m.push('prejuizo');
  if (['CX', 'FD', 'PCT', 'DZ'].includes(l.un) && (l.fator || 1) === 1 && A.origem === 'xml') m.push('embalagem');
  if (l.repetido) m.push('repetido');
  return m;
}
const ROTULO = { ja: ['Já cadastrado', ''], parecido: ['Nome igual a um produto seu', 'warn'], semean: ['Sem código de barras', 'warn'], semncm: ['Sem NCM', 'bad'], semcat: ['Sem categoria', 'warn'], sempreco: ['Sem preço', 'bad'], prejuizo: ['Preço abaixo do custo', 'bad'], repetido: ['Veio em mais de uma nota', 'new'], embalagem: ['Comprado em caixa: confira a unidade de venda', 'warn'] };
const PRECISA = new Set(['parecido', 'semean', 'semncm', 'semcat', 'sempreco', 'prejuizo', 'embalagem']);

// ---------- leitura de arquivos ----------
async function textosDe(files) {
  const out = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      const { default: JSZip } = await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm');
      const zz = await JSZip.loadAsync(f);
      for (const e of Object.values(zz.files)) if (!e.dir && /\.xml$/i.test(e.name)) out.push({ nome: e.name.split('/').pop(), txt: await e.async('string') });
    } else if (/\.xml$/i.test(f.name) || /xml/.test(f.type)) out.push({ nome: f.name, txt: await f.text() });
  }
  return out;
}

function deNotas(textos) {
  const S = C.S, idx = indices(), erros = [], notas = new Map();
  const raiz = soDig(S.emp.cnpj).slice(0, 8);
  for (const t of textos) {
    try {
      const n = C.lerNFe(t.txt);
      if (raiz && n.destCnpj && soDig(n.destCnpj).slice(0, 8) !== raiz) { erros.push(`${t.nome}: a nota é para outro CNPJ (${n.destCnpj}), ficou de fora`); continue; }
      notas.set(n.chave, n);
    } catch (e) { erros.push(`${t.nome}: ${e.message}`); }
  }
  const lista = [...notas.values()].sort((a, b) => String(a.emissao).localeCompare(String(b.emissao)));
  const m = new Map(); let itens = 0;
  for (const n of lista) for (const it of n.itens) {
    itens++;
    const ean = it.eanUn || it.ean || null, chave = ean ? 'e' + z(ean) : 'f' + n.fornCnpj + '|' + it.codigo;
    const pis = it.pisCst === '04' ? '04' : '49', g = C.grupoDe(it.st, pis);
    const o = { nome: C.bonito(it.desc), ean, un: unidade(it.uCom, it.fator), custo: it.custoUn, ncm: it.ncm, cest: /^\d{7}$/.test(it.cest || '') ? it.cest : '', grupo: g?.id || null, st: it.st,
      fornCnpj: n.fornCnpj, fornCod: it.codigo, fator: it.fator, origem: `NF ${n.numero} · ${C.bonito(n.fornNome)}`, emissao: n.emissao };
    const ant = m.get(chave);
    if (ant) { ant.repetido++; ant.custo = o.custo; ant.origem = o.origem; ant.emissao = o.emissao; if (!ant.precoManual && o.custo > 0) ant.preco = C.precoSugerido(o.custo); if (!ncmOk(ant.ncm) && ncmOk(o.ncm)) ant.ncm = o.ncm; continue; }
    m.set(chave, novaLinha(o, idx));
  }
  return { linhas: [...m.values()], leitura: { arquivos: textos.length, notas: lista.length, itens, erros } };
}

// planilha modelo: aceita CSV (; , ou tab) e Excel
const COLS = {
  nome: ['nome', 'descricao', 'produto', 'descricao do produto', 'nome do produto', 'item'],
  ean: ['codigo de barras', 'cod barras', 'codigo barras', 'cod de barras', 'ean', 'gtin', 'codbarras', 'barras', 'ean13'],
  custo: ['custo', 'preco de custo', 'valor de custo', 'custo unitario', 'preco custo', 'vl custo', 'custo r$'],
  preco: ['preco de venda', 'preco venda', 'venda', 'preco', 'valor de venda', 'pv'],
  ncm: ['ncm'], cest: ['cest'], un: ['unidade', 'un', 'und', 'unid', 'unidade de venda'],
  cat: ['categoria', 'departamento', 'secao', 'grupo'], sub: ['subcategoria', 'sub categoria', 'subgrupo', 'sub grupo']
};
function mapaCab(cab) {
  const h = cab.map(x => sem(x).replace(/[^a-z0-9$ ]+/g, ' ').replace(/\s+/g, ' ').trim()), r = {};
  for (const [k, als] of Object.entries(COLS)) { let i = h.findIndex(x => als.includes(x)); if (i < 0 && k !== 'preco' && k !== 'un') i = h.findIndex(x => als.some(a => a.length > 3 && x.includes(a))); if (i >= 0 && !Object.values(r).includes(i)) r[k] = i; }
  return r;
}
function csv(txt) {
  const l0 = txt.split(/\r?\n/)[0] || '', d = [';', '\t', ','].sort((a, b) => l0.split(b).length - l0.split(a).length)[0];
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < txt.length; i++) {
    const ch = txt[i];
    if (q) { if (ch === '"') { if (txt[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true; else if (ch === d) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && txt[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
async function dePlanilha(f) {
  let rows;
  if (/\.(xlsx|xls|ods)$/i.test(f.name)) {
    const X = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm');
    const wb = X.read(await f.arrayBuffer()), ws = wb.Sheets[wb.SheetNames[0]];
    rows = X.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  } else rows = csv((await f.text()).replace(/^﻿/, ''));
  rows = rows.filter(r => r.some(c => String(c ?? '').trim()));
  const ini = rows.findIndex(r => { const m = mapaCab(r); return m.nome != null; });
  if (ini < 0) throw new Error('Não achei a coluna "Nome" na planilha. Use a planilha modelo.');
  const M = mapaCab(rows[ini]), idx = indices(), m = new Map(), erros = [];
  const cel = (r, k) => M[k] == null ? '' : r[M[k]];
  rows.slice(ini + 1).forEach((r, i) => {
    const nome = String(cel(r, 'nome') ?? '').trim(); if (!nome) return;
    let e = cel(r, 'ean'); if (typeof e === 'number') e = Math.round(e).toString();
    let nc = cel(r, 'ncm'); if (typeof nc === 'number') nc = String(Math.round(nc)).padStart(8, '0');
    const ean = eanOk(e); if (String(e ?? '').trim() && !ean) erros.push(`Linha ${ini + i + 2}: código de barras "${e}" inválido, ficou em branco`);
    const o = { nome: C.bonito(nome), ean, un: unidade(cel(r, 'un'), 1), custo: cent(cel(r, 'custo')) || 0, preco: cent(cel(r, 'preco')) || 0, ncm: soDig(nc), cest: soDig(cel(r, 'cest')),
      cat: String(cel(r, 'cat') ?? '').trim(), sub: String(cel(r, 'sub') ?? '').trim(), origem: `Planilha, linha ${ini + i + 2}` };
    const ch = ean ? 'e' + z(ean) : 'n' + texto(nome);
    const ant = m.get(ch); if (ant) { ant.repetido++; return; }
    m.set(ch, novaLinha(o, idx));
  });
  return { linhas: [...m.values()], leitura: { arquivos: 1, notas: 0, itens: rows.length - ini - 1, erros, colunas: Object.keys(M) } };
}

function modeloCsv() {
  const linhas = ['Nome;Código de barras;Custo;Preço de venda;NCM;Unidade;Categoria;Subcategoria',
    'Refrigerante Coca-Cola Lata 350ml;7894900011517;2,49;;22021000;UN;Bebidas;Refrigerantes',
    'Biscoito Recheado Chocolate 130g;7896004000000;1,89;3,49;19053100;UN;;',
    'Sabonete em Barra 85g;;1,20;;34011190;UN;;'];
  baixar('planilha-modelo-beep.csv', '﻿' + linhas.join('\r\n'), 'text/csv');
}
function baixar(nome, conteudo, tipo) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([conteudo], { type: tipo + ';charset=utf-8' })); a.download = nome; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

// ---------- carga ----------
async function carregarAgente() {
  const { sb, S } = C;
  const [ag, lt] = await Promise.all([
    sb.from('empresas').select('agente').eq('id', S.emp.id).single(),
    sb.from('agente_lotes').select('id,criado_em,origem,resumo,desfeito_em,resultado_desfazer').eq('empresa_id', S.emp.id).order('criado_em', { ascending: false }).limit(12)
  ]);
  if (ag.error || lt.error) { A.semBanco = true; A.agente = {}; A.lotes = []; return; }
  A.semBanco = false; A.agente = ag.data?.agente || {}; A.lotes = lt.data || [];
}
async function categoriasAtuais() {
  const { sb, S } = C;
  const pag = async (t, sel) => { const out = []; for (let de = 0; ; de += 1000) { const r = await sb.from(t).select(sel).eq('empresa_id', S.emp.id).order('id').range(de, de + 999); if (r.error) throw r.error; out.push(...r.data); if (r.data.length < 1000) return out; } };
  const [cats, prods] = await Promise.all([pag('categorias', 'id,nome,pai_id'), pag('produtos', 'id,nome,ncm,ativo,categoria_id,subcategoria_id')]);
  return { cats, prods };
}

// ---------- telas ----------
export async function telaAgente(ctx) {
  C = ctx; css();
  const M = C.$('#main'); M.innerHTML = '<p class="vazio">Carregando…</p>';
  await carregarAgente();
  if (A.modo === 'relatorio' && A.lote) return relatorio(A.lote);
  if (A.modo === 'revisao' && A.linhas.length) return revisao();
  inicio();
}

function inicio() {
  const { $, esc, S, brl } = C, M = $('#main'), r = lerRasc(), dono = S.papel === 'dono', m = markup();
  A.modo = null;
  const semCat = S.produtos.filter(p => p.ativo).length;
  M.innerHTML = `<div class="head"><div><h1>Configurar minha loja</h1><p>Mande as notas de compra ou a planilha. O Beep Smart Pay monta o cadastro, você revisa e só então ele grava.</p></div>
   <div class="row"><button class="btn" id="agDic">Dicionário de categorias</button></div></div>
  <div id="agPassos"></div>
  ${A.semBanco ? '<div class="aviso" style="margin-bottom:16px"><b>Falta atualizar o banco.</b>&nbsp;A leitura e a revisão funcionam, mas para gravar é preciso aplicar a atualização do agente no Supabase.</div>' : ''}
  ${r?.linhas?.length ? `<div class="aviso info" style="margin-bottom:16px;align-items:center"><div style="flex:1">Você tem uma revisão que não terminou: <b>${r.linhas.length} produtos</b>, guardada em ${esc(dataHora(r.em))}. Ela fica salva neste computador mesmo se a internet cair.</div><button class="btn sm pri" id="agCont">Continuar</button><button class="btn sm" id="agDesc">Descartar</button></div>` : ''}
  <div class="agopts">
   <div class="card agopt"><div class="agic">${IC.nota}</div><h3>Notas de compra</h3><p class="mu sm">Arraste os XMLs das notas (ou um .zip com todos). O Beep Smart Pay lê nome, código de barras, custo, NCM e unidade.</p>
    <div class="drop agdrop" id="agDropX"><b>Solte os XMLs aqui</b><span class="mu sm">ou</span><label class="btn sm">Escolher arquivos<input type="file" id="agFx" accept=".xml,.zip,text/xml,application/zip" multiple hidden></label></div>
    <button class="btn sm" id="agSefaz" style="justify-self:start">Usar as notas recebidas da SEFAZ</button></div>
   <div class="card agopt"><div class="agic">${IC.plan}</div><h3>Planilha</h3><p class="mu sm">Preencha a planilha modelo (Excel ou CSV). Só o nome é obrigatório; o resto o Beep Smart Pay completa ou aponta.</p>
    <div class="drop agdrop" id="agDropP"><b>Solte a planilha aqui</b><span class="mu sm">ou</span><label class="btn sm">Escolher planilha<input type="file" id="agFp" accept=".csv,.xlsx,.xls,.ods,.txt" hidden></label></div>
    <button class="btn sm" id="agModelo" style="justify-self:start">Baixar planilha modelo</button></div>
   <div class="card agopt"><div class="agic">${IC.org}</div><h3>Organizar o que já tenho</h3><p class="mu sm">Coloca categoria e subcategoria nos ${semCat} produtos ativos usando o dicionário. Você revisa antes.</p>
    <div class="agnum"><b class="num">${semCat}</b><span class="mu sm">produtos ativos</span></div>
    <button class="btn pri" id="agOrg" style="justify-self:start">Organizar categorias</button></div>
  </div>
  <div class="card agmk"><div style="flex:1;min-width:240px"><h2 style="font-size:17px">Markup padrão da loja</h2><p class="mu sm" style="margin-top:2px">Preço sugerido = custo + ${pctTxt(m)}, terminando em ,${String(C.regra().terminacaoCentavos).padStart(2, '0')}. Exemplo: custo ${brl(250)} → <b style="color:var(--ink)">${brl(C.precoSugerido(250))}</b>. Vale também para a entrada de NF-e.</p></div>
   ${dono ? `<div class="row"><label class="f" style="width:130px">Markup (%)<input id="agMk" inputmode="decimal" value="${(m * 100).toFixed(0)}"></label><button class="btn" id="agMkS" style="align-self:end">Salvar</button></div>` : '<span class="mu sm">Só o dono muda o markup.</span>'}</div>
  <h2 style="font-size:18px;margin:26px 0 10px">Importações feitas</h2><div class="tblwrap" id="agHist"></div>`;
  historico(); passos();
  const lerX = async files => { if (!files.length) return; ocupado('Lendo as notas…'); try { const t = await textosDe(files); if (!t.length) throw new Error('Nenhum XML encontrado nos arquivos'); comecar('xml', deNotas(t)); } catch (e) { livre(); C.toast(e.message); } };
  const lerP = async f => { if (!f) return; ocupado('Lendo a planilha…'); try { comecar('planilha', await dePlanilha(f)); } catch (e) { livre(); C.toast(e.message); } };
  soltar($('#agDropX'), fs => lerX([...fs])); soltar($('#agDropP'), fs => lerP(fs[0]));
  $('#agFx').onchange = e => lerX([...e.target.files]); $('#agFp').onchange = e => lerP(e.target.files[0]);
  $('#agModelo').onclick = modeloCsv; $('#agSefaz').onclick = sefaz; $('#agOrg').onclick = organizar; $('#agDic').onclick = editarDic;
  if ($('#agCont')) { $('#agCont').onclick = () => { Object.assign(A, { modo: r.modo, origem: r.origem, linhas: r.linhas, leitura: r.leitura, lojas: r.lojas, filtro: 'todos', pag: 0, busca: '' }); revisao(); }; $('#agDesc').onclick = () => { apagarRasc(); inicio(); }; }
  if ($('#agMkS')) $('#agMkS').onclick = salvarMarkup;
}
async function passos() {
  const el = C.$('#agPassos'); if (!el || !C.resumoAssistente) return;
  try {
    const r = await C.resumoAssistente(); if (r.concluido && r.feitos === r.total) { el.innerHTML = ''; return; }
    const nomes = ['Conta', 'Produtos', 'Nota fiscal', 'Maquininha', 'Venda de teste'], ks = ['conta', 'produtos', 'fiscal', 'maquininha', 'teste'];
    el.innerHTML = `<div class="wzbanner"><div><b>Primeiros passos</b><div class="mu sm">${r.feitos} de ${r.total} prontos</div></div><div class="agpbar">${ks.map((k, i) => `<span class="${r.ok[k] ? 'ok' : ''}"><i></i>${nomes[i]}</span>`).join('')}</div><button class="btn pri sm" id="agPassosBt">${r.feitos ? 'Continuar' : 'Começar'}</button></div>`;
    C.$('#agPassosBt').onclick = () => C.abrirAssistente();
  } catch { el.innerHTML = ''; }
}
function soltar(d, fn) {
  ['dragenter', 'dragover'].forEach(ev => d.addEventListener(ev, e => { e.preventDefault(); d.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => d.addEventListener(ev, e => { e.preventDefault(); d.classList.remove('over'); }));
  d.addEventListener('drop', e => fn(e.dataTransfer.files));
}
function ocupado(t) { C.modal(`<div style="display:grid;gap:14px;justify-items:center;padding:12px"><div class="agspin"></div><b>${C.esc(t)}</b><p class="mu sm">Nada é gravado nesta etapa.</p></div>`); }
function livre() { C.fechar(); }

async function sefaz() {
  const { sb, S } = C; ocupado('Buscando as notas recebidas…');
  try {
    const { data, error } = await sb.from('nfe_recebidas').select('chave,xml_path').eq('empresa_id', S.emp.id).not('xml_path', 'is', null).order('emissao', { ascending: false }).limit(300);
    if (error) throw error; if (!data.length) throw new Error('Ainda não chegou nenhuma nota com XML. Use "Atualizar notas" na Entrada de NF-e.');
    const t = []; let i = 0;
    for (const r of data) { i++; if (i % 10 === 0) ocupado(`Lendo nota ${i} de ${data.length}…`); const { data: f } = await sb.storage.from('notas').download(r.xml_path); if (f) t.push({ nome: r.chave + '.xml', txt: await f.text() }); }
    comecar('xml', deNotas(t));
  } catch (e) { livre(); C.toast(e.message); }
}

function comecar(origem, r) {
  livre();
  if (!r.linhas.length) { C.toast(r.leitura.erros[0] || 'Não encontrei produtos nos arquivos'); return; }
  r.linhas.forEach((l, i) => l.k = i);
  Object.assign(A, { modo: 'revisao', origem, linhas: r.linhas, leitura: r.leitura, filtro: 'todos', pag: 0, busca: '', lojas: A.lojas || C.lojas().map(l => l.id) });
  guardar(); revisao();
}

async function organizar() {
  ocupado('Organizando as categorias…');
  try {
    const { cats, prods } = await categoriasAtuais(), nomeCat = new Map(cats.map(c => [c.id, c.nome])), regras = dic();
    const linhas = prods.filter(p => p.ativo).map(p => {
      const cl = classificar(p.nome, p.ncm, regras), atual = nomeCat.get(p.categoria_id) || '', atualS = nomeCat.get(p.subcategoria_id) || '';
      return { k: 0, id: p.id, nome: C.bonito(p.nome), ncm: p.ncm || '', atual, atualS, cat: cl?.c || atual, sub: cl ? cl.s : atualS, catPor: cl?.por || null, catChave: cl?.k || '', incluir: !!cl && !atual };
    }).sort((a, b) => (a.atual ? 1 : 0) - (b.atual ? 1 : 0) || a.nome.localeCompare(b.nome));
    livre();
    if (!linhas.length) return C.toast('Nenhum produto ativo para organizar');
    linhas.forEach((l, i) => l.k = i);
    Object.assign(A, { modo: 'revisao', origem: 'organizar', linhas, leitura: { itens: linhas.length, erros: [] }, filtro: 'todos', pag: 0, busca: '', lojas: [] });
    guardar(); revisao();
  } catch (e) { livre(); C.toast(e.message); }
}

// ---------- revisão ----------
function filtrar() {
  const t = sem(A.busca).trim(), org = A.origem === 'organizar';
  return A.linhas.filter(l => {
    if (t && !sem(l.nome).includes(t) && !(l.ean || '').includes(t)) return false;
    if (org) { if (A.filtro === 'sem') return !l.atual; if (A.filtro === 'nao') return !l.cat; if (A.filtro === 'muda') return l.atual && l.cat && (l.cat !== l.atual || l.sub !== l.atualS); return true; }
    const m = motivos(l);
    switch (A.filtro) {
      case 'conferir': return m.some(x => PRECISA.has(x)); case 'semean': return m.includes('semean'); case 'semncm': return m.includes('semncm');
      case 'semcat': return m.includes('semcat'); case 'dup': return m.includes('ja') || m.includes('parecido') || m.includes('repetido'); default: return true;
    }
  });
}
function contagens() {
  const L = A.linhas;
  if (A.origem === 'organizar') return { todos: L.length, sem: L.filter(l => !l.atual).length, muda: L.filter(l => l.atual && l.cat && (l.cat !== l.atual || l.sub !== l.atualS)).length, nao: L.filter(l => !l.cat).length };
  const ms = L.map(motivos);
  return { todos: L.length, conferir: ms.filter(m => m.some(x => PRECISA.has(x))).length, semean: ms.filter(m => m.includes('semean')).length, semncm: ms.filter(m => m.includes('semncm')).length, semcat: ms.filter(m => m.includes('semcat')).length, dup: ms.filter(m => m.includes('ja') || m.includes('parecido') || m.includes('repetido')).length };
}

function revisao() {
  const { $, esc, S } = C, M = $('#main'), org = A.origem === 'organizar', L = A.linhas, ct = contagens(), lr = A.leitura || {};
  const vao = L.filter(l => l.incluir && !l.existente).length, ja = L.filter(l => l.existente).length;
  const chip = (k, t) => ct[k] == null ? '' : `<button class="prchip${A.filtro === k ? ' on' : ''}" data-f="${k}">${t}<span class="num">${ct[k]}</span></button>`;
  const titulo = org ? 'Organizar categorias' : A.origem === 'xml' ? 'Revisar produtos das notas' : 'Revisar produtos da planilha';
  const sub = org ? `${L.length} produtos ativos. Marque os que devem receber a categoria sugerida.` : A.origem === 'xml' ? `${lr.notas} notas lidas, ${lr.itens} itens, ${L.length} produtos diferentes.` : `${lr.itens} linhas lidas, ${L.length} produtos diferentes.`;
  const cats = [...new Set([...dic().map(r => r.c), ...L.map(l => l.cat).filter(Boolean)])].sort((a, b) => a.localeCompare(b));
  const subs = [...new Set([...dic().map(r => r.s), ...L.map(l => l.sub).filter(Boolean)])].filter(Boolean).sort((a, b) => a.localeCompare(b));
  M.innerHTML = `<div class="head"><div><h1>${titulo}</h1><p>${esc(sub)}</p></div><div class="row"><button class="btn" id="agVolta">Voltar</button><button class="btn" id="agDic2">Dicionário</button></div></div>
  <div class="aviso info" style="margin-bottom:14px"><span>Nada foi gravado ainda. Ajuste o que quiser direto na tabela; sua revisão fica guardada neste computador, mesmo sem internet. Só grava quando você aprovar no fim.</span></div>
  ${lr.erros?.length ? `<details class="card agerr" style="margin-bottom:14px"><summary><b>${lr.erros.length} ${lr.erros.length === 1 ? 'aviso' : 'avisos'} na leitura</b> <span class="mu sm">(arquivos que ficaram de fora)</span></summary><ul class="sm mu">${lr.erros.slice(0, 50).map(e => `<li>${esc(e)}</li>`).join('')}</ul></details>` : ''}
  ${org ? '' : `<div class="grid5" style="margin-bottom:14px"><div class="kpi"><span>Vão ser criados</span><b class="num" id="kVao">${vao}</b></div><div class="kpi"><span>Já cadastrados</span><b class="num">${ja}</b></div><div class="kpi"><span>Para conferir</span><b class="num">${ct.conferir}</b></div><div class="kpi"><span>Sem código de barras</span><b class="num">${ct.semean}</b></div><div class="kpi"><span>Sem NCM</span><b class="num">${ct.semncm}</b></div></div>`}
  <div class="prbar"><div class="prbusca"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><input id="agBusca" placeholder="Buscar por nome ou código" value="${esc(A.busca)}"></div>
   ${org ? chip('todos', 'Todos') + chip('sem', 'Sem categoria hoje') + chip('muda', 'Categoria muda') + chip('nao', 'Sem sugestão') : chip('todos', 'Todos') + chip('conferir', 'Para conferir') + chip('semean', 'Sem código') + chip('semncm', 'Sem NCM') + chip('semcat', 'Sem categoria') + chip('dup', 'Duplicados')}</div>
  <div class="row" style="margin-bottom:10px"><button class="btn sm" id="agTodos">Marcar todos desta lista</button><button class="btn sm" id="agNenhum">Desmarcar todos desta lista</button>${org ? '' : '<button class="btn sm" id="agRecalc">Recalcular preços pelo markup</button>'}<span class="sp"></span><span class="mu sm" id="agPagInfo"></span></div>
  <div class="tblwrap"><table class="tbl agtbl"><thead><tr><th style="width:36px"></th><th>Produto</th><th>Categoria</th>${org ? '<th>Hoje</th>' : '<th>Unidade</th><th class="n">Custo</th><th class="n">Preço</th><th>NCM</th>'}<th>Situação</th></tr></thead><tbody id="agCorpo"></tbody></table></div>
  <div class="row" style="justify-content:center;margin-top:12px" id="agPags"></div>
  <datalist id="agCats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist><datalist id="agSubs">${subs.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
  <div class="barra">${org ? '' : `<div style="display:grid;gap:6px"><span class="mu sm">Colocar à venda em</span><div class="row" style="gap:6px">${C.lojas().map(l => `<label class="chk"><input type="checkbox" data-loja="${l.id}" ${A.lojas?.includes(l.id) ? 'checked' : ''}>${esc(l.nome)}</label>`).join('') || '<span class="mu sm">Nenhuma loja ativa</span>'}</div></div>`}
   <span class="sp"></span><span id="agResumo" class="sm"></span><button class="btn pri" id="agOk">Aprovar e gravar</button></div>`;
  desenharCorpo();
  M.querySelectorAll('.prchip').forEach(b => b.onclick = () => { A.filtro = b.dataset.f; A.pag = 0; revisao(); });
  const bi = $('#agBusca'); bi.oninput = () => { clearTimeout(bi._t); bi._t = setTimeout(() => { A.busca = bi.value; A.pag = 0; desenharCorpo(); }, 200); };
  $('#agVolta').onclick = () => { guardar(); A.modo = null; inicio(); };
  $('#agDic2').onclick = editarDic;
  $('#agTodos').onclick = () => { filtrar().forEach(l => { if (!l.existente) l.incluir = true; }); guardarDepois(); desenharCorpo(); };
  $('#agNenhum').onclick = () => { filtrar().forEach(l => l.incluir = false); guardarDepois(); desenharCorpo(); };
  if ($('#agRecalc')) $('#agRecalc').onclick = () => { let n = 0; A.linhas.forEach(l => { if (l.custo > 0) { l.preco = C.precoSugerido(l.custo); l.precoManual = false; n++; } }); guardarDepois(); desenharCorpo(); C.toast(n + ' preços recalculados com markup de ' + pctTxt(markup())); };
  M.querySelectorAll('[data-loja]').forEach(c => c.onchange = () => { A.lojas = [...M.querySelectorAll('[data-loja]:checked')].map(x => x.dataset.loja); guardarDepois(); resumo(); });
  $('#agOk').onclick = confirmar;
  const corpo = $('#agCorpo');
  corpo.addEventListener('input', editar); corpo.addEventListener('change', editar);
}

function editar(e) {
  const el = e.target, k = el.closest('tr')?.dataset.k; if (k == null || !el.dataset.c) return;
  const l = A.linhas[+k], c = el.dataset.c;
  if (c === 'incluir') l.incluir = el.checked;
  else if (c === 'nome') l.nome = el.value;
  else if (c === 'cat') { l.cat = el.value.trim(); l.catPor = 'manual'; }
  else if (c === 'sub') { l.sub = el.value.trim(); l.catPor = 'manual'; }
  else if (c === 'un') l.un = el.value;
  else if (c === 'custo') { if (e.type !== 'change') return; const v = cent(el.value); l.custo = v ?? 0; if (!l.precoManual && l.custo > 0) l.preco = C.precoSugerido(l.custo); }
  else if (c === 'preco') { if (e.type !== 'change') return; const v = cent(el.value); l.preco = v; l.precoManual = true; }
  else if (c === 'ncm') { if (e.type !== 'change') return; l.ncm = soDig(el.value).slice(0, 8); }
  else if (c === 'ean') { if (e.type !== 'change') return; l.ean = eanOk(el.value) || ''; }
  guardarDepois();
  if (e.type === 'change' && c !== 'incluir' && c !== 'nome') { const tr = el.closest('tr'); tr.outerHTML = linhaHtml(l); }
  else if (c === 'incluir') { el.closest('tr').classList.toggle('off', !l.incluir); }
  resumo();
}

function situacao(l) {
  if (A.origem === 'organizar') {
    if (!l.cat) return '<span class="pill warn">Sem sugestão</span>';
    if (l.catPor === 'manual') return '<span class="pill new">Você escolheu</span>';
    return `<span class="pill ${l.catPor === 'ncm' ? 'warn' : 'ok'}" title="${C.esc(l.catPor === 'ncm' ? 'Pelo começo do NCM ' + l.catChave : 'Pela palavra “' + l.catChave + '”')}">${l.catPor === 'ncm' ? 'Pelo NCM' : 'Pela palavra'}</span>`;
  }
  const m = motivos(l);
  if (m[0] === 'ja') return `<span class="pill">Já cadastrado</span><div class="mu sm agw">${C.esc(C.bonito(l.existente.nome))}</div>`;
  const p = m.map(x => `<span class="pill ${ROTULO[x][1]}">${ROTULO[x][0]}</span>`);
  if (l.parecido) p.push(`<div class="mu sm agw">Seu cadastro: ${C.esc(C.bonito(l.parecido.nome))}</div>`);
  if (l.catPor === 'ncm' && l.cat) p.push(`<span class="pill warn" title="Categoria pelo começo do NCM ${C.esc(l.catChave)}">Categoria pelo NCM</span>`);
  return p.length ? p.join(' ') : '<span class="pill ok">Pronto</span>';
}
function linhaHtml(l) {
  const { esc, brl } = C, org = A.origem === 'organizar', off = l.existente || !l.incluir;
  const mg = l.preco > 0 && l.custo > 0 ? Math.round((l.preco - l.custo) / l.preco * 100) : null;
  const cat = `<div class="agcat"><input data-c="cat" list="agCats" value="${esc(l.cat)}" placeholder="Categoria"><input data-c="sub" list="agSubs" value="${esc(l.sub)}" placeholder="Subcategoria"></div>`;
  if (org) return `<tr data-k="${l.k}" class="${off ? 'off' : ''}"><td><input type="checkbox" data-c="incluir" ${l.incluir ? 'checked' : ''}></td><td><b>${esc(l.nome)}</b><div class="mu sm num">${l.ncm ? 'NCM ' + esc(l.ncm) : 'sem NCM'}</div></td><td>${cat}</td><td class="sm">${l.atual ? esc(l.atual) + (l.atualS ? '<span class="mu"> › ' + esc(l.atualS) + '</span>' : '') : '<span class="mu">—</span>'}</td><td>${situacao(l)}</td></tr>`;
  return `<tr data-k="${l.k}" class="${off ? 'off' : ''}"><td><input type="checkbox" data-c="incluir" ${l.incluir && !l.existente ? 'checked' : ''} ${l.existente ? 'disabled' : ''}></td>
   <td><input data-c="nome" class="agnome" value="${esc(l.nome)}" ${l.existente ? 'disabled' : ''}><div class="row mu sm" style="gap:6px;margin-top:4px"><input data-c="ean" class="agean num" value="${esc(l.ean)}" placeholder="sem código" ${l.existente ? 'disabled' : ''}><span class="agw">${esc(l.origem)}</span></div></td>
   <td>${cat}</td>
   <td><select data-c="un" class="agun">${UN_OK.map(u => `<option ${u === l.un ? 'selected' : ''}>${u}</option>`).join('')}</select></td>
   <td class="n"><input data-c="custo" class="inp-s num" inputmode="decimal" value="${reais(l.custo)}"></td>
   <td class="n"><input data-c="preco" class="inp-s num" inputmode="decimal" value="${reais(l.preco)}" placeholder="0,00">${mg != null ? `<div class="mu sm num">${mg}% margem</div>` : ''}</td>
   <td><input data-c="ncm" class="agncm num" inputmode="numeric" maxlength="10" value="${esc(l.ncm)}" placeholder="8 números"></td>
   <td class="agsit">${situacao(l)}</td></tr>`;
}
function desenharCorpo() {
  const { $ } = C, F = filtrar(), tot = Math.max(1, Math.ceil(F.length / POR_PAG)); A.pag = Math.min(A.pag, tot - 1);
  const pg = F.slice(A.pag * POR_PAG, (A.pag + 1) * POR_PAG);
  $('#agCorpo').innerHTML = pg.map(linhaHtml).join('') || `<tr><td colspan="8" class="vazio">Nada nesta lista.</td></tr>`;
  $('#agPagInfo').textContent = F.length ? `${A.pag * POR_PAG + 1}–${A.pag * POR_PAG + pg.length} de ${F.length}` : '';
  const P = $('#agPags'); P.innerHTML = tot > 1 ? `<button class="btn sm" data-p="-1" ${A.pag ? '' : 'disabled'}>Anterior</button><span class="mu sm">Página ${A.pag + 1} de ${tot}</span><button class="btn sm" data-p="1" ${A.pag < tot - 1 ? '' : 'disabled'}>Próxima</button>` : '';
  P.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { A.pag += +b.dataset.p; desenharCorpo(); window.scrollTo({ top: 0 }); });
  resumo();
}
function resumo() {
  const el = C.$('#agResumo'); if (!el) return;
  const sel = A.linhas.filter(l => l.incluir && !l.existente), org = A.origem === 'organizar';
  if (org) { const n = sel.filter(l => l.cat).length; el.innerHTML = `<b>${n}</b> produtos vão receber categoria`; C.$('#agOk').disabled = !n; return; }
  const semPreco = sel.filter(l => !(l.preco > 0)).length, lojas = (A.lojas || []).length;
  el.innerHTML = `<b>${sel.length}</b> produtos vão ser criados${lojas ? ` e postos à venda em ${lojas} ${lojas === 1 ? 'loja' : 'lojas'}` : ', sem colocar à venda'}${semPreco && lojas ? ` <span class="mu">(${semPreco} sem preço ficam só no cadastro)</span>` : ''}`;
  const k = C.$('#kVao'); if (k) k.textContent = sel.length;
  C.$('#agOk').disabled = !sel.length;
}

function confirmar() {
  const { esc } = C, org = A.origem === 'organizar', sel = A.linhas.filter(l => l.incluir && !l.existente && (!org || l.cat));
  if (!org && sel.some(l => !l.nome.trim())) return C.toast('Tem produto marcado sem nome');
  const ms = sel.map(motivos), conf = ms.filter(m => m.some(x => PRECISA.has(x))).length;
  const lojas = C.lojas().filter(l => A.lojas?.includes(l.id)).map(l => l.nome);
  C.modal(`<h2>${org ? 'Gravar as categorias?' : 'Gravar os produtos?'}</h2>
   <ul class="aglist">${org ? `<li><b>${sel.length}</b> produtos recebem categoria e subcategoria.</li>` : `<li><b>${sel.length}</b> produtos novos no cadastro${lojas.length ? `, à venda em <b>${esc(lojas.join(', '))}</b> com o preço da revisão` : ' (sem colocar à venda)'}.</li>
    <li>Categorias que ainda não existem são criadas.</li>${conf ? `<li><b>${conf}</b> ainda têm algo para conferir; vão para o relatório.</li>` : ''}`}
    <li>Dá para desfazer depois em "Importações feitas".</li></ul>
   <p class="erro" id="agErr"></p><div class="row"><span class="sp"></span><button class="btn" data-close>Voltar à revisão</button><button class="btn pri" id="agGo">Gravar agora</button></div>`);
  C.$('#agGo').onclick = () => gravar(sel);
}

async function gravar(sel) {
  const { sb, S } = C, org = A.origem === 'organizar', bt = C.$('#agGo'); bt.disabled = true; bt.textContent = 'Gravando…';
  const rel = relatorioDe(sel);
  const novos = org ? [] : sel.map(l => ({ nome: l.nome.trim(), ean: l.ean || null, ncm: l.ncm || null, cest: l.cest || null, unidade: l.un, custo: l.custo || 0, preco: l.preco > 0 ? l.preco : null, categoria: l.cat || null, subcategoria: l.sub || null, grupo_fiscal_id: l.grupo || null, fornecedor_cnpj: l.fornCnpj || null, fornecedor_codigo: l.fornCod || null, fator: l.fator || 1 }));
  const orgz = org ? sel.map(l => ({ produto_id: l.id, categoria: l.cat, subcategoria: l.sub || null })) : [];
  try {
    const { data, error } = await sb.rpc('agente_aplicar', { p_empresa: S.emp.id, p_origem: A.origem, p_novos: novos, p_organizar: orgz, p_lojas: org ? [] : (A.lojas || []), p_resumo: { leitura: { notas: A.leitura?.notas || 0, itens: A.leitura?.itens || 0, arquivos: A.leitura?.arquivos || 0 }, markup: Math.round(markup() * 100), relatorio: rel } });
    if (error) throw new Error(/function .* does not exist|Could not find the function/i.test(error.message) ? 'Falta aplicar a atualização do agente no banco. Sua revisão ficou guardada.' : error.message);
    apagarRasc(); C.fechar();
    await C.carregar();
    const { data: lote } = await sb.from('agente_lotes').select('id,criado_em,origem,resumo,desfeito_em,resultado_desfazer').eq('id', data.lote).single();
    A.linhas = []; A.modo = 'relatorio'; A.lote = lote; relatorio(lote);
    C.toast(org ? `${data.organizados} produtos organizados` : `${data.criados} produtos criados`);
  } catch (e) {
    const msg = /Failed to fetch|NetworkError|Load failed/i.test(e.message) ? 'Sem internet agora. Nada foi gravado e sua revisão continua guardada; tente de novo quando a conexão voltar.' : e.message;
    C.$('#agErr').textContent = msg; bt.disabled = false; bt.textContent = 'Tentar de novo';
  }
}

// relatório final: guardado junto do lote para poder abrir depois
function relatorioDe(sel) {
  const org = A.origem === 'organizar', gn = id => (C.S.grupos || []).find(g => g.id === id)?.nome || '';
  if (org) {
    const porCat = {}; sel.forEach(l => { porCat[l.cat] = (porCat[l.cat] || 0) + 1; });
    return { categorias: porCat, conferir: sel.filter(l => l.catPor === 'ncm').map(l => ({ n: l.nome, m: ['Categoria pelo NCM'] })).slice(0, 800), semSugestao: A.linhas.filter(l => !l.cat).map(l => l.nome).slice(0, 800) };
  }
  const conferir = sel.map(l => ({ n: l.nome, e: l.ean || '', m: motivos(l).filter(x => PRECISA.has(x)).map(x => ROTULO[x][0]) })).filter(x => x.m.length);
  const ncm = sel.map(l => ({ n: l.nome, e: l.ean || '', ncm: l.ncm || '', cest: l.cest || '', g: gn(l.grupo), st: l.st })).sort((a, b) => (a.ncm ? 1 : 0) - (b.ncm ? 1 : 0) || a.n.localeCompare(b.n));
  const porCat = {}; sel.forEach(l => { const c = l.cat || 'Sem categoria'; porCat[c] = (porCat[c] || 0) + 1; });
  return { categorias: porCat, conferir: conferir.slice(0, 2000), ncm: ncm.slice(0, 5000), ignorados: A.linhas.filter(l => l.existente).length, desmarcados: A.linhas.filter(l => !l.existente && !l.incluir).length, avisos: (A.leitura?.erros || []).slice(0, 100) };
}

function relatorio(lote) {
  const { $, esc } = C, M = $('#main'), r = lote.resumo || {}, rel = r.relatorio || {}, org = lote.origem === 'organizar';
  const nomeOrig = { xml: 'Notas de compra', planilha: 'Planilha', organizar: 'Organização de categorias' }[lote.origem];
  const lojas = C.S.locais.filter(l => (r.lojas || []).includes(l.id)).map(l => l.nome);
  const cats = Object.entries(rel.categorias || {}).sort((a, b) => b[1] - a[1]);
  const conf = rel.conferir || [], ncm = rel.ncm || [], semNcm = ncm.filter(x => !x.ncm).length;
  M.innerHTML = `<div class="head"><div><h1>Relatório da importação</h1><p>${esc(nomeOrig)} · ${esc(dataHora(lote.criado_em))}${lote.desfeito_em ? ' · <b style="color:#f87171">desfeita em ' + esc(dataHora(lote.desfeito_em)) + '</b>' : ''}</p></div>
   <div class="row"><button class="btn" id="agIni">Voltar</button><button class="btn" onclick="print()">Imprimir</button>${!org && ncm.length ? '<button class="btn" id="agCsv">Lista para o contador</button>' : ''}${lote.desfeito_em ? '' : '<button class="btn dang" id="agUndo">Desfazer esta importação</button>'}</div></div>
  <div class="grid2 agrel">
   <div class="card"><h2 class="agh">O que o Beep Smart Pay fez</h2><ul class="aglist">
    ${org ? `<li><b>${r.organizados || 0}</b> produtos receberam categoria.</li>` : `<li><b>${r.criados || 0}</b> produtos criados${lojas.length ? ', à venda em ' + esc(lojas.join(', ')) : ' só no cadastro'}.</li>
    ${r.leitura?.notas ? `<li>${r.leitura.notas} notas lidas, ${r.leitura.itens} itens.</li>` : r.leitura?.itens ? `<li>${r.leitura.itens} linhas da planilha lidas.</li>` : ''}
    <li>Preço sugerido com markup de ${r.markup ?? '—'}%.</li>
    ${r.pulados ? `<li>${r.pulados} já existiam no cadastro e não foram duplicados.</li>` : ''}${rel.ignorados ? `<li>${rel.ignorados} já estavam cadastrados e ficaram de fora.</li>` : ''}${rel.desmarcados ? `<li>${rel.desmarcados} você desmarcou na revisão.</li>` : ''}`}
    ${lote.resultado_desfazer ? `<li><b>Desfeito:</b> ${lote.resultado_desfazer.apagados} apagados, ${lote.resultado_desfazer.desativados} desativados (já tinham venda ou estoque), ${lote.resultado_desfazer.restaurados} categorias restauradas.</li>` : ''}</ul>
    ${cats.length ? `<h3 class="agh3">Por categoria</h3><div class="agcats">${cats.map(([c, n]) => `<span class="pill">${esc(c)} <b class="num">${n}</b></span>`).join('')}</div>` : ''}</div>
   <div class="card"><h2 class="agh">Precisa da sua conferência <span class="pill ${conf.length ? 'warn' : 'ok'}">${conf.length || 'nada'}</span></h2>
    ${conf.length ? `<div class="agscroll"><table class="tbl"><tbody>${conf.slice(0, 400).map(x => `<tr><td>${esc(x.n)}${x.e ? `<div class="mu sm num">${esc(x.e)}</div>` : ''}</td><td>${x.m.map(m => `<span class="pill warn">${esc(m)}</span>`).join(' ')}</td></tr>`).join('')}</tbody></table></div>${conf.length > 400 ? `<p class="mu sm">E mais ${conf.length - 400}.</p>` : ''}` : '<p class="mu">Tudo certo: nenhum produto ficou com pendência.</p>'}
    ${rel.semSugestao?.length ? `<p class="mu sm" style="margin-top:10px">${rel.semSugestao.length} produtos ficaram sem categoria porque nenhuma palavra do dicionário bateu. Acrescente palavras no dicionário e rode de novo.</p>` : ''}</div>
  </div>
  ${!org && ncm.length ? `<div class="card" style="margin-top:16px"><div class="row"><h2 class="agh" style="flex:1">Lista de NCMs para o contador</h2><span class="pill ${semNcm ? 'bad' : 'ok'}">${semNcm ? semNcm + ' sem NCM' : 'todos com NCM'}</span></div>
   <p class="mu sm" style="margin:4px 0 10px">Mande esta lista para o contador conferir NCM e tributação. O botão "Lista para o contador" baixa em planilha.</p>
   <div class="agscroll"><table class="tbl"><thead><tr><th>Produto</th><th>Código de barras</th><th>NCM</th><th>CEST</th><th>Grupo fiscal sugerido</th></tr></thead><tbody>${ncm.slice(0, 600).map(x => `<tr><td>${esc(x.n)}</td><td class="num mu">${esc(x.e || '—')}</td><td class="num">${x.ncm ? esc(x.ncm) : '<span class="pill bad">Falta</span>'}</td><td class="num mu">${esc(x.cest || '—')}</td><td class="sm">${esc(x.g || 'a definir')}${x.st === true ? ' <span class="pill ok">veio com ST</span>' : ''}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
  ${rel.avisos?.length ? `<details class="card agerr" style="margin-top:16px"><summary><b>Avisos da leitura</b></summary><ul class="sm mu">${rel.avisos.map(e => `<li>${esc(e)}</li>`).join('')}</ul></details>` : ''}`;
  $('#agIni').onclick = () => { A.modo = null; A.lote = null; inicio(); };
  if ($('#agCsv')) $('#agCsv').onclick = () => { const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"'; baixar('ncm-para-contador.csv', '﻿' + ['Produto;Código de barras;NCM;CEST;Grupo fiscal sugerido;Veio com ST na nota', ...ncm.map(x => [x.n, x.e, x.ncm || 'FALTA', x.cest, x.g, x.st === true ? 'sim' : x.st === false ? 'não' : ''].map(q).join(';'))].join('\r\n'), 'text/csv'); };
  if ($('#agUndo')) $('#agUndo').onclick = () => desfazer(lote);
}

function desfazer(lote) {
  const r = lote.resumo || {}, org = lote.origem === 'organizar';
  C.modal(`<h2>Desfazer esta importação?</h2><ul class="aglist">${org ? `<li>Os ${r.organizados || 0} produtos voltam para a categoria que tinham antes (os que você mexeu depois ficam como estão).</li>` : `<li>Os ${r.criados || 0} produtos criados saem do cadastro e das lojas.</li><li>Os que já tiveram venda, entrada de nota ou estoque não são apagados: ficam desativados, para não perder o histórico.</li>`}<li>Categorias criadas por esta importação e que ficarem vazias são removidas.</li></ul>
   <p class="erro" id="agErr"></p><div class="row"><span class="sp"></span><button class="btn" data-close>Cancelar</button><button class="btn pri" id="agUndoOk">Desfazer</button></div>`);
  C.$('#agUndoOk').onclick = async () => {
    const b = C.$('#agUndoOk'); b.disabled = true; b.textContent = 'Desfazendo…';
    const { data, error } = await C.sb.rpc('agente_desfazer', { p_lote: lote.id });
    if (error) { C.$('#agErr').textContent = error.message; b.disabled = false; b.textContent = 'Tentar de novo'; return; }
    C.fechar(); await C.carregar(); await carregarAgente();
    const novo = A.lotes.find(x => x.id === lote.id) || { ...lote, desfeito_em: new Date().toISOString(), resultado_desfazer: data };
    A.modo = 'relatorio'; A.lote = novo; relatorio(novo); C.toast('Importação desfeita');
  };
}

function historico() {
  const { $, esc } = C, el = $('#agHist'); if (!el) return;
  if (!A.lotes?.length) { el.innerHTML = '<p class="vazio">Nenhuma importação ainda. Quando você aprovar uma revisão, ela aparece aqui com o relatório e o botão de desfazer.</p>'; return; }
  const nome = { xml: 'Notas de compra', planilha: 'Planilha', organizar: 'Categorias' };
  el.innerHTML = `<table class="tbl"><thead><tr><th>Quando</th><th>Origem</th><th>Resultado</th><th>Situação</th><th></th></tr></thead><tbody>${A.lotes.map(l => { const r = l.resumo || {}; return `<tr><td class="mu">${esc(dataHora(l.criado_em))}</td><td>${nome[l.origem]}</td><td>${l.origem === 'organizar' ? (r.organizados || 0) + ' produtos organizados' : (r.criados || 0) + ' produtos criados'}</td><td>${l.desfeito_em ? '<span class="pill">Desfeita</span>' : '<span class="pill ok">Gravada</span>'}</td><td class="n"><button class="btn sm" data-ver="${l.id}">Ver relatório</button></td></tr>`; }).join('')}</tbody></table>`;
  el.querySelectorAll('[data-ver]').forEach(b => b.onclick = () => { const l = A.lotes.find(x => x.id === b.dataset.ver); A.modo = 'relatorio'; A.lote = l; relatorio(l); });
}

async function salvarMarkup() {
  const v = num(C.$('#agMk').value); if (v == null || v < 0 || v > 500) return C.toast('Digite o markup em %, ex.: 75');
  const reg = { ...C.regra(), divisor: Math.round(1 / (1 + v / 100) * 10000) / 10000 };
  const { error } = await C.sb.from('empresas').update({ regra_preco: reg }).eq('id', C.S.emp.id);
  if (error) return C.toast('Não foi possível salvar: ' + error.message);
  C.S.emp.regra_preco = reg; C.toast('Markup salvo: ' + v + '%'); inicio();
}

// ---------- dicionário editável ----------
function editarDic() {
  const { esc } = C, dono = C.S.papel === 'dono';
  let R = JSON.parse(JSON.stringify(dic()));
  C.$('#modal').classList.add('wide');
  const linha = (r, i) => `<tr data-i="${i}"><td><input data-d="c" value="${esc(r.c)}" placeholder="Categoria"></td><td><input data-d="s" value="${esc(r.s || '')}" placeholder="Subcategoria"></td><td><input data-d="p" value="${esc((r.p || []).join(', '))}" placeholder="palavras separadas por vírgula"></td><td><input data-d="ncm" class="num" value="${esc((r.ncm || []).join(', '))}" placeholder="ex.: 2202"></td><td><button class="btn sm dang" data-x="${i}" title="Remover">✕</button></td></tr>`;
  const desenha = () => {
    C.modal(`<div class="row"><div style="flex:1"><h2>Dicionário de categorias</h2><p class="mu sm">Quando uma palavra aparece no nome do produto, ele vai para aquela categoria. Sem palavra, vale o começo do NCM. ${A.agente?.dicionario?.length ? 'Este é o dicionário da sua empresa.' : 'Você está vendo o dicionário padrão do Beep Smart Pay.'}</p></div></div>
     <div class="row"><input id="dTeste" placeholder="Teste: digite o nome de um produto" style="flex:1"><span id="dRes" class="sm"></span></div>
     <div class="tblwrap" style="max-height:52vh"><table class="tbl agdic"><thead><tr><th>Categoria</th><th>Subcategoria</th><th>Palavras no nome</th><th>Começo do NCM</th><th></th></tr></thead><tbody>${R.map(linha).join('')}</tbody></table></div>
     <p class="erro" id="dErr"></p>
     <div class="row"><button class="btn sm" id="dAdd">Adicionar linha</button><button class="btn sm" id="dPadrao">Voltar ao padrão</button><span class="sp"></span><button class="btn" data-close>Fechar</button>${dono ? '<button class="btn pri" id="dSalvar">Salvar dicionário</button>' : '<span class="mu sm">Só o dono pode salvar.</span>'}</div>`);
    C.$('#modal').classList.add('wide');
    const tb = C.$('.agdic tbody');
    tb.addEventListener('input', e => { const i = +e.target.closest('tr').dataset.i, d = e.target.dataset.d; if (!d) return; const v = e.target.value; R[i][d] = d === 'p' ? v.split(',').map(x => x.trim()).filter(Boolean) : d === 'ncm' ? v.split(/[,\s]+/).map(soDig).filter(Boolean) : v; });
    tb.querySelectorAll('[data-x]').forEach(b => b.onclick = () => { R.splice(+b.dataset.x, 1); desenha(); });
    C.$('#dAdd').onclick = () => { R.unshift({ c: '', s: '', p: [], ncm: [] }); desenha(); };
    C.$('#dPadrao').onclick = () => { R = JSON.parse(JSON.stringify(DIC_PADRAO)); desenha(); };
    const t = C.$('#dTeste'); t.oninput = () => { const r = t.value.trim() ? classificar(t.value, '', R) : null; C.$('#dRes').innerHTML = t.value.trim() ? (r ? `<span class="pill ok">${esc(r.c)}${r.s ? ' › ' + esc(r.s) : ''}</span> <span class="mu">pela palavra “${esc(r.k)}”</span>` : '<span class="pill warn">Nenhuma regra bateu</span>') : ''; };
    if (C.$('#dSalvar')) C.$('#dSalvar').onclick = async () => {
      const limpo = R.map(r => ({ c: String(r.c || '').trim().slice(0, 60), s: String(r.s || '').trim().slice(0, 60), p: (r.p || []).map(x => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 200), ncm: (r.ncm || []).map(soDig).filter(Boolean).slice(0, 50) })).filter(r => r.c && (r.p.length || r.ncm.length));
      const ag = { ...(A.agente || {}), dicionario: limpo };
      const { error } = await C.sb.from('empresas').update({ agente: ag }).eq('id', C.S.emp.id);
      if (error) { C.$('#dErr').textContent = /agente/.test(error.message) ? 'Falta aplicar a atualização do agente no banco.' : error.message; return; }
      A.agente = ag; C.fechar(); C.toast('Dicionário salvo');
      if (A.modo === 'revisao') reclassificar();
    };
  };
  desenha();
}
// depois de mudar o dicionário: refaz a sugestão das linhas que não foram escolhidas à mão
function reclassificar() {
  const regras = dic(); let n = 0;
  A.linhas.forEach(l => { if (l.catPor === 'manual' || l.catPor === 'planilha') return; const cl = classificar(l.nome, l.ncm, regras); const c = cl?.c || (A.origem === 'organizar' ? l.atual : ''), s = cl ? cl.s : (A.origem === 'organizar' ? l.atualS : ''); if (c !== l.cat || s !== l.sub) n++; l.cat = c; l.sub = s; l.catPor = cl?.por || null; l.catChave = cl?.k || ''; });
  guardar(); revisao(); if (n) C.toast(n + ' categorias atualizadas pelo novo dicionário');
}

// ---------- visual ----------
const IC = {
  nota: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg>',
  plan: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/></svg>',
  org: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h10M4 18h6"/><circle cx="18" cy="16" r="3"/></svg>'
};
function css() {
  if (document.getElementById('agCss')) return;
  const s = document.createElement('style'); s.id = 'agCss';
  s.textContent = `.agopts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.agopt{display:grid;gap:12px;align-content:start}.agopt h3{font-size:18px}
.agic{width:44px;height:44px;border-radius:12px;background:rgba(255,214,10,.1);color:var(--y);display:grid;place-items:center}
.agdrop{padding:22px 14px;gap:6px}.agnum{display:flex;align-items:baseline;gap:8px;padding:14px 0}.agnum b{font:800 34px Manrope,Inter,sans-serif}
.wzbanner{display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-bottom:16px;padding:16px 18px;border-radius:16px;border:1px solid rgba(255,214,10,.3);background:rgba(255,214,10,.05)}.agpbar{flex:1;min-width:260px;display:grid;grid-template-columns:repeat(5,1fr);gap:6px}.agpbar span{display:grid;gap:6px;font-size:12px;font-weight:600;color:var(--mu)}.agpbar i{height:6px;border-radius:99px;background:var(--p3)}.agpbar .ok i{background:var(--ok)}.agpbar .ok{color:var(--ink)}
.agmk{margin-top:14px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.agtbl td{vertical-align:middle}.agtbl tr.off td{opacity:.5}.agtbl tr.off td:first-child{opacity:1}
.agtbl input:not([type=checkbox]),.agtbl select{min-height:34px!important;padding:0 8px!important;font-size:13.5px}
.agnome{min-width:220px;font-weight:600}.agean{width:150px!important;min-height:28px!important;font-size:12px!important}.agncm{width:104px!important}.agun{width:78px!important}
.agcat{display:grid;gap:4px;min-width:170px}.agcat input:last-child{font-size:12.5px!important;min-height:28px!important;color:var(--mu)}
.agsit{min-width:170px;max-width:220px}.agsit .pill{margin:0 2px 4px 0;white-space:normal}.agtbl input[type=checkbox]{accent-color:var(--y);width:18px;height:18px}.agw{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agerr summary{cursor:pointer}.agerr ul{margin:10px 0 0 18px;display:grid;gap:4px}
.aglist{margin:6px 0 0 18px;display:grid;gap:6px}.agh{font-size:17px;display:flex;gap:10px;align-items:center}.agh3{font-size:14px;margin:16px 0 8px;color:var(--mu)}
.agcats{display:flex;flex-wrap:wrap;gap:6px}.agscroll{max-height:420px;overflow:auto;margin-top:8px}
.agdic input{min-height:34px!important;font-size:13px}.agdic th:nth-child(1),.agdic th:nth-child(2){width:19%}.agdic th:nth-child(3){width:42%}.agdic td{padding:6px 8px}
.agspin{width:34px;height:34px;border-radius:50%;border:3px solid var(--p3);border-top-color:var(--y);animation:agr .8s linear infinite}@keyframes agr{to{transform:rotate(360deg)}}
@media(max-width:900px){.agopts{grid-template-columns:1fr}}
@media print{.agscroll{max-height:none;overflow:visible}#main .head .row{display:none}}`;
  document.head.appendChild(s);
}
