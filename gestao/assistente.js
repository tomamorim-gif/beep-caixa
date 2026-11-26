// Assistente de primeiro acesso: uma etapa por tela, com barra de progresso, voltar e vídeo curto.
// Etapas: conta, produtos, fiscal, maquininha e teste de venda. O progresso fica salvo na empresa.
let C;
// Vídeos curtos de cada etapa (MP4 ou link do YouTube). Enquanto estiver vazio, aparece o passo a passo escrito.
export const VIDEOS = { conta: '', produtos: '', fiscal: '', maquininha: '', teste: '' };

const ETAPAS = [
  { k: 'conta', t: 'Sua conta', d: 'Dados da empresa e da loja.' },
  { k: 'produtos', t: 'Produtos', d: 'Monte o cadastro a partir das notas ou da planilha.' },
  { k: 'fiscal', t: 'Nota fiscal', d: 'Certificado digital A1 e dados da SEFAZ.' },
  { k: 'maquininha', t: 'Maquininha', d: 'Conecte a conta do Mercado Pago.' },
  { k: 'teste', t: 'Venda de teste', d: 'Faça uma venda de verdade no caixa.' }
];
const W = { i: 0, ok: {}, ob: {}, ag: {} };
const soDig = v => String(v ?? '').replace(/\D/g, '');
const fmtCnpj = c => { const d = soDig(c); return d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : d; };
function cnpjValido(c) {
  const d = soDig(c); if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  const calc = n => { let s = 0, p = n - 7; for (let i = 0; i < n; i++) { s += +d[i] * p--; if (p < 2) p = 9; } const r = s % 11; return r < 2 ? 0 : 11 - r; };
  return calc(12) === +d[12] && calc(13) === +d[13];
}

async function salvarProgresso(extra = {}) {
  if (C.S.papel !== 'dono') return;
  W.ob = { ...W.ob, passo: ETAPAS[W.i].k, ...extra };
  W.ag = { ...W.ag, onboarding: W.ob };
  await C.sb.from('empresas').update({ agente: W.ag }).eq('id', C.S.emp.id);
}

// o que já está pronto, olhando os dados de verdade
async function conferir() {
  const { sb, S } = C, e = S.emp.id;
  const [disp, vend] = await Promise.all([
    sb.from('dispositivos').select('id', { count: 'exact', head: true }).eq('empresa_id', e).eq('ativo', true),
    sb.from('vendas').select('id', { count: 'exact', head: true }).eq('empresa_id', e).eq('status', 'paga')
  ]);
  let nf = null, mp = null;
  try { nf = await C.apiNf('status'); } catch { }
  try { mp = await C.apiPag('status'); } catch { }
  const comPreco = new Set(S.precos.filter(p => p.ativo_no_mix && p.preco > 0).map(p => p.produto_id));
  W.ok = {
    conta: !!(S.emp.razao_social && soDig(S.emp.cnpj).length === 14 && C.lojas().length),
    produtos: S.produtos.some(p => p.ativo && comPreco.has(p.id)),
    fiscal: !!(nf?.certificado && nf?.tem_csc),
    maquininha: !!mp?.configurado,
    teste: (vend.count || 0) > 0
  };
  W.caixas = disp.count || 0; W.nf = nf; W.mp = mp;
  return W.ok;
}
export async function resumoAssistente(ctx) {
  C = ctx; const { data } = await C.sb.from('empresas').select('agente').eq('id', C.S.emp.id).single();
  W.ag = data?.agente || {}; W.ob = W.ag.onboarding || {};
  await conferir();
  return { feitos: ETAPAS.filter(e => W.ok[e.k]).length, total: ETAPAS.length, concluido: !!W.ob.concluido_em, ok: W.ok };
}

export async function abrirAssistente(ctx, etapa) {
  C = ctx; css();
  C.modal('<div style="display:grid;place-items:center;padding:40px"><div class="agspin"></div></div>');
  C.$('#modal').classList.add('wide');
  await resumoAssistente(ctx);
  W.i = Math.max(0, ETAPAS.findIndex(e => e.k === (etapa || W.ob.passo || (ETAPAS.find(x => !W.ok[x.k]) || ETAPAS[0]).k)));
  desenhar();
}

function video(k) {
  const u = VIDEOS[k]; if (!u) return '';
  const yt = u.match(/(?:youtu\.be\/|v=|embed\/)([\w-]{11})/);
  return `<div class="wzvid">${yt ? `<iframe src="https://www.youtube-nocookie.com/embed/${yt[1]}?rel=0" title="Vídeo da etapa" allow="encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe>` : `<video src="${C.esc(u)}" controls playsinline preload="metadata"></video>`}</div>`;
}

function desenhar() {
  const { esc } = C, e = ETAPAS[W.i], feitos = ETAPAS.filter(x => W.ok[x.k]).length;
  C.modal(`<div class="wz">
    <div class="wzhead"><div><span class="mu sm">Primeiros passos · etapa ${W.i + 1} de ${ETAPAS.length}</span><h2>${esc(e.t)}</h2><p class="mu sm">${esc(e.d)}</p></div><button class="btn sm" data-close>Fechar</button></div>
    <div class="wzbar" role="progressbar" aria-valuemin="0" aria-valuemax="${ETAPAS.length}" aria-valuenow="${feitos}">${ETAPAS.map((x, i) => `<button class="wzseg${W.ok[x.k] ? ' ok' : ''}${i === W.i ? ' on' : ''}" data-i="${i}" title="${esc(x.t)}"><i></i><span>${esc(x.t)}</span></button>`).join('')}</div>
    ${video(e.k)}
    <div id="wzCorpo" class="wzcorpo"></div>
    <div class="wzpe"><button class="btn" id="wzVolta" ${W.i ? '' : 'disabled'}>Voltar</button><span class="sp"></span><span class="mu sm" id="wzEstado"></span><button class="btn" id="wzPula">${W.i === ETAPAS.length - 1 ? 'Fazer depois' : 'Pular por enquanto'}</button><button class="btn pri" id="wzSegue">${W.i === ETAPAS.length - 1 ? 'Concluir' : 'Continuar'}</button></div></div>`);
  C.$('#modal').classList.add('wide');
  C.$('#mbox').querySelectorAll('[data-i]').forEach(b => b.onclick = () => ir(+b.dataset.i));
  C.$('#wzVolta').onclick = () => ir(W.i - 1);
  C.$('#wzPula').onclick = () => W.i === ETAPAS.length - 1 ? (C.fechar()) : ir(W.i + 1);
  C.$('#wzSegue').onclick = () => seguir();
  CORPOS[e.k]();
  estado();
}
function estado() { const el = C.$('#wzEstado'); if (el) el.innerHTML = W.ok[ETAPAS[W.i].k] ? '<span class="pill ok">Pronto</span>' : ''; }
async function ir(i) { if (i < 0 || i >= ETAPAS.length) return; W.i = i; desenhar(); salvarProgresso().catch(() => { }); }
async function seguir() {
  const e = ETAPAS[W.i];
  if (e.k === 'conta') { const ok = await salvarConta(); if (!ok) return; }
  if (W.i === ETAPAS.length - 1) {
    await conferir(); const falta = ETAPAS.filter(x => !W.ok[x.k]);
    if (falta.length) { const el = C.$('#wzEstado'); el.innerHTML = `<span style="color:var(--warn)">Ainda falta: ${falta.map(x => C.esc(x.t)).join(', ')}</span>`; return; }
    await salvarProgresso({ concluido_em: new Date().toISOString() });
    C.modal(`<div class="wz" style="text-align:center;justify-items:center"><div class="wzfim"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 12l5 5L20 7"/></svg></div><h2>Sua loja está pronta</h2><p class="mu">Conta, produtos, nota fiscal, maquininha e venda de teste conferidos. Os caixas já podem vender.</p><button class="btn pri" data-close>Ir para o painel</button></div>`);
    return;
  }
  ir(W.i + 1);
}

// ---------- etapas ----------
const CORPOS = {
  conta() {
    const { esc, S } = C, e = S.emp, loja = C.lojas()[0], dono = S.papel === 'dono', temCnpj = soDig(e.cnpj).length === 14;
    C.$('#wzCorpo').innerHTML = `<form id="wzConta" class="wzform" autocomplete="off">
      <div class="g2"><label class="f">CNPJ<div class="row" style="flex-wrap:nowrap"><input name="cnpj" inputmode="numeric" value="${esc(fmtCnpj(e.cnpj))}" ${temCnpj ? 'readonly' : ''} placeholder="00.000.000/0000-00">${temCnpj ? '' : '<button type="button" class="btn sm" id="wzCnpj" style="white-space:nowrap">Buscar dados</button>'}</div></label>
      <label class="f">Responsável<input name="resp" value="${esc(W.ob.responsavel || '')}" placeholder="Nome de quem cuida da loja"></label></div>
      <div class="g2"><label class="f">Razão social<input name="razao" value="${esc(e.razao_social || '')}"></label><label class="f">Nome que aparece no caixa<input name="nome" value="${esc(e.nome_exibicao || '')}" placeholder="Ex.: Mercadinho Bela Vista"></label></div>
      <div class="g2"><label class="f">Nome da loja<input name="loja" value="${esc(loja?.nome || '')}" placeholder="Ex.: Condomínio Benvinda"></label><label class="f">Endereço da loja<input name="end" value="${esc(W.end || '')}" placeholder="Rua, número, bairro, cidade"></label></div>
      <input type="hidden" name="uf" value="${esc(e.uf || '')}">
      <p class="erro" id="wzErr"></p>${dono ? '' : '<p class="mu sm">Só o dono pode mudar estes dados.</p>'}
      ${temCnpj ? '<p class="mu sm">O CNPJ não muda por aqui porque as notas fiscais já saem com ele. Para trocar, fale com o suporte PagNow.</p>' : ''}</form>`;
    const b = C.$('#wzCnpj'); if (b) b.onclick = buscarCnpj;
    if (loja) C.sb.from('locais').select('endereco').eq('id', loja.id).single().then(({ data }) => { const i = C.$('#wzConta [name=end]'); if (data?.endereco && i && !i.value) { i.value = data.endereco; W.end = data.endereco; } });
  },
  produtos() {
    const { S } = C, ativos = S.produtos.filter(p => p.ativo).length, comPreco = new Set(S.precos.filter(p => p.ativo_no_mix && p.preco > 0).map(p => p.produto_id)).size;
    C.$('#wzCorpo').innerHTML = `<div class="wzstat"><div><b class="num">${ativos}</b><span>produtos no cadastro</span></div><div><b class="num">${comPreco}</b><span>à venda nas lojas</span></div></div>
      <ol class="wzpassos"><li>Junte os <b>XMLs das notas de compra</b> (ou use as que chegaram da SEFAZ) ou preencha a <b>planilha modelo</b>.</li><li>O PagNow monta os produtos com custo, preço sugerido, NCM e categoria.</li><li>Você revisa, aprova e recebe o relatório com o que conferir.</li></ol>
      <button class="btn pri" id="wzAg">Abrir Configurar minha loja</button>`;
    C.$('#wzAg').onclick = () => { salvarProgresso().catch(() => { }); C.fechar(); C.ir('ag'); };
  },
  fiscal() {
    C.$('#wzCorpo').innerHTML = `<ol class="wzpassos"><li>Tenha em mãos o <b>certificado digital A1</b> (arquivo .pfx) e a senha dele.</li><li>Peça ao contador o <b>CSC</b> (código de segurança do contribuinte) da SEFAZ do seu estado.</li><li>Preencha abaixo. Comece em <b>homologação</b> (teste) e mude para produção quando a primeira nota de teste sair.</li></ol>
      <div class="card wzsub"><div class="row"><b style="flex:1">Nota fiscal do consumidor · NFC-e</b><span class="pill" id="nfEstado">Verificando…</span></div><div id="nfCorpo" style="display:grid;gap:12px"></div></div>`;
    C.cartaoNf();
  },
  maquininha() {
    C.$('#wzCorpo').innerHTML = `<div class="wzmp"><div><b>Conecte a conta que vai receber as vendas</b><p class="mu sm">O PagNow cobra na maquininha Point e no Pix da sua conta Mercado Pago. O dinheiro cai direto para você.</p></div>
       <a class="btn pri" href="https://www.mercadopago.com.br/developers/panel/app" target="_blank" rel="noopener">Conectar Mercado Pago</a></div>
      <ol class="wzpassos"><li>No Mercado Pago, abra <b>Suas integrações</b> e crie uma aplicação (tipo "Pagamentos presenciais").</li><li>Em <b>Credenciais de produção</b>, copie o <b>Access Token</b>. Em <b>Webhooks</b>, copie a <b>assinatura secreta</b>.</li><li>Cole os dois aqui embaixo e salve. Depois, ligue a maquininha ao caixa em <b>Caixas</b>.</li></ol>
      <div class="card wzsub"><div class="row"><b style="flex:1">Maquininha · Mercado Pago</b><span class="pill" id="mpEstado">Verificando…</span></div><div id="mpCorpo" style="display:grid;gap:12px"></div></div>`;
    C.cartaoMp();
  },
  teste() {
    const tem = W.caixas > 0;
    C.$('#wzCorpo').innerHTML = `<ol class="wzpassos">${tem ? '' : '<li>Ative um caixa: gere o código e digite no tablet da loja.</li>'}<li>No tablet, passe um produto barato e pague com <b>Pix ou cartão</b>.</li><li>A tela fica <b>verde</b> e a venda aparece no painel. Se quiser, estorne em <b>Vendas</b>.</li></ol>
      <div class="row">${tem ? `<span class="pill ok">${W.caixas} ${W.caixas === 1 ? 'caixa ativo' : 'caixas ativos'}</span>` : '<button class="btn" id="wzCx">Ativar um caixa</button>'}<span class="sp"></span><button class="btn" id="wzVer">Já vendi, conferir</button></div><p class="mu sm" id="wzVerMsg"></p>`;
    if (C.$('#wzCx')) C.$('#wzCx').onclick = () => { C.fechar(); C.ir('cx'); setTimeout(() => C.gerarCodigo(), 350); };
    C.$('#wzVer').onclick = async () => { const b = C.$('#wzVer'); b.disabled = true; await conferir(); b.disabled = false; C.$('#wzVerMsg').textContent = W.ok.teste ? 'Venda encontrada. Tudo certo!' : 'Ainda não encontrei venda paga. Confira se a tela do caixa ficou verde.'; estado(); C.$('#mbox').querySelectorAll('.wzseg').forEach((s, i) => s.classList.toggle('ok', !!W.ok[ETAPAS[i].k])); };
  }
};

async function buscarCnpj() {
  const f = C.$('#wzConta'), d = soDig(f.cnpj.value), err = C.$('#wzErr'), b = C.$('#wzCnpj');
  if (!cnpjValido(d)) { err.textContent = 'CNPJ inválido. Confira os 14 números.'; return; }
  b.disabled = true; b.textContent = 'Buscando…'; err.textContent = '';
  try {
    const r = await fetch('https://brasilapi.com.br/api/cnpj/v1/' + d); if (!r.ok) throw new Error(r.status === 404 ? 'CNPJ não encontrado na Receita' : 'Consulta indisponível agora; preencha à mão');
    const j = await r.json();
    f.razao.value = j.razao_social || f.razao.value; if (!f.nome.value) f.nome.value = C.bonito(j.nome_fantasia || j.razao_social || '');
    f.uf.value = j.uf || ''; if (!f.end.value) f.end.value = [j.descricao_tipo_de_logradouro, j.logradouro, j.numero, j.bairro, j.municipio && j.municipio + '/' + j.uf].filter(Boolean).map(x => C.bonito(String(x))).join(', ').replace(/\/(\w\w)$/, (m, u) => '/' + u.toUpperCase());
    if (j.situacao_cadastral && !/ativa/i.test(j.descricao_situacao_cadastral || 'ativa')) err.textContent = 'Atenção: a Receita mostra este CNPJ como ' + j.descricao_situacao_cadastral;
  } catch (e) { err.textContent = e.message; }
  b.disabled = false; b.textContent = 'Buscar dados';
}
async function salvarConta() {
  const { sb, S } = C, f = C.$('#wzConta'); if (!f) return true; if (S.papel !== 'dono') return true;
  const err = C.$('#wzErr'), cnpj = soDig(f.cnpj.value), temCnpj = soDig(S.emp.cnpj).length === 14;
  if (!temCnpj && !cnpjValido(cnpj)) { err.textContent = 'Digite um CNPJ válido.'; return false; }
  if (!f.razao.value.trim()) { err.textContent = 'Falta a razão social.'; return false; }
  if (!f.loja.value.trim()) { err.textContent = 'Dê um nome para a loja.'; return false; }
  const up = { razao_social: f.razao.value.trim().slice(0, 120), nome_exibicao: (f.nome.value.trim() || f.razao.value.trim()).slice(0, 60) };
  if (!temCnpj) { up.cnpj = cnpj; if (f.uf.value) up.uf = f.uf.value; }
  const r = await sb.from('empresas').update(up).eq('id', S.emp.id); if (r.error) { err.textContent = r.error.message; return false; }
  Object.assign(S.emp, up);
  const loja = C.lojas()[0];
  const r2 = loja ? await sb.from('locais').update({ nome: f.loja.value.trim().slice(0, 60), endereco: f.end.value.trim().slice(0, 200) || null }).eq('id', loja.id)
    : await sb.from('locais').insert({ empresa_id: S.emp.id, tipo: 'loja', nome: f.loja.value.trim().slice(0, 60), endereco: f.end.value.trim().slice(0, 200) || null });
  if (r2.error) { err.textContent = r2.error.message; return false; }
  W.ob.responsavel = f.resp.value.trim().slice(0, 80);
  await C.carregar(); await conferir(); await salvarProgresso();
  return true;
}

function css() {
  if (document.getElementById('wzCss')) return;
  const s = document.createElement('style'); s.id = 'wzCss';
  s.textContent = `.wz{display:grid;gap:18px}.wzhead{display:flex;gap:16px;align-items:flex-start;justify-content:space-between}.wzhead h2{font-size:26px;margin-top:2px}
.wzbar{display:grid;grid-template-columns:repeat(5,1fr);gap:6px}.wzseg{display:grid;gap:6px;text-align:left;color:var(--mu);font-size:12px;font-weight:600}
.wzseg i{height:6px;border-radius:99px;background:var(--p3);transition:background .2s}.wzseg.ok i{background:var(--ok)}.wzseg.on i{background:var(--y)}.wzseg.on{color:var(--ink)}
.wzvid{aspect-ratio:16/9;border-radius:14px;overflow:hidden;background:#000;border:1px solid var(--line)}.wzvid iframe,.wzvid video{width:100%;height:100%;border:0;display:block}
.wzcorpo{display:grid;gap:14px;min-height:180px}.wzform{display:grid;gap:12px}
.wzpassos{margin:0;padding:0;list-style:none;counter-reset:p;display:grid;gap:10px}.wzpassos li{counter-increment:p;position:relative;padding:2px 0 0 38px;min-height:26px;font-size:14.5px}
.wzpassos li::before{content:counter(p);position:absolute;left:0;top:0;width:26px;height:26px;border-radius:50%;background:rgba(255,214,10,.12);color:var(--y);font:700 13px Manrope,Inter,sans-serif;display:grid;place-items:center}
.wzstat{display:grid;grid-template-columns:1fr 1fr;gap:10px}.wzstat div{background:var(--p2);border:1px solid var(--line);border-radius:14px;padding:14px 16px}.wzstat b{display:block;font:800 28px Manrope,Inter,sans-serif}.wzstat span{color:var(--mu);font-size:13px}
.wzsub{background:var(--p2);display:grid;gap:12px;padding:16px}
.wzmp{display:flex;gap:16px;align-items:center;flex-wrap:wrap;padding:16px;border-radius:14px;background:linear-gradient(135deg,rgba(0,158,227,.12),rgba(0,158,227,.04));border:1px solid rgba(0,158,227,.3)}.wzmp>div{flex:1;min-width:220px}a.btn{text-decoration:none}
.wzpe{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding-top:14px;border-top:1px solid var(--line)}
.wzfim{width:76px;height:76px;border-radius:50%;background:rgba(34,197,94,.14);color:var(--ok);display:grid;place-items:center}
.wzbanner{display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-bottom:16px;padding:16px 18px;border-radius:16px;border:1px solid rgba(255,214,10,.3);background:rgba(255,214,10,.05)}
.wzbanner .wzbar{flex:1;min-width:260px}
@media(max-width:700px){.wzbar span{display:none}.wzstat{grid-template-columns:1fr}}`;
  document.head.appendChild(s);
}
export { ETAPAS };
