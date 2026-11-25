// Celular do dono lendo o QR do tablet do kit: cria a conta (ou entra) e liga o tablet à loja.
let C, COD;
const soDig = v => String(v ?? '').replace(/\D/g, '');
const fmtCnpj = v => { const d = soDig(v).slice(0, 14); return d.replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d)/, '$1-$2'); };
function cnpjValido(c) {
  const d = soDig(c); if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  const calc = n => { let s = 0, p = n - 7; for (let i = 0; i < n; i++) { s += +d[i] * p--; if (p < 2) p = 9; } const r = s % 11; return r < 2 ? 0 : 11 - r; };
  return calc(12) === +d[12] && calc(13) === +d[13];
}
async function apiKit(acao, corpo = {}, auth = false) {
  const h = { 'content-type': 'application/json' };
  if (auth) { const { data: { session } } = await C.sb.auth.getSession(); if (session) h.authorization = 'Bearer ' + session.access_token; }
  let r; try { r = await fetch(C.SB_URL + '/functions/v1/kit', { method: 'POST', headers: h, body: JSON.stringify({ acao, ...corpo }) }); } catch { throw new Error('Sem internet. Confira a conexão e tente de novo.'); }
  const j = await r.json().catch(() => ({ erro: 'Resposta inválida' })); if (!r.ok) throw new Error(j.erro || 'Erro'); return j;
}
const tela = (h) => { C.$('#raiz').innerHTML = `<div class="login kitm"><div class="card"><img src="../logo-claro.png" alt="Beep Smart Pay">${h}</div></div>`; };
const passos = n => `<div class="kitpassos">${['Conta', 'Loja', 'Tablet'].map((t, i) => `<span class="${i < n ? 'ok' : i === n ? 'on' : ''}"><i></i>${t}</span>`).join('')}</div>`;

export async function telaKit(ctx, codigo) {
  C = ctx; COD = codigo; css();
  tela('<p class="mu">Conferindo o QR…</p>');
  try { const r = await apiKit('consultar', { codigo }); if (!r.valido) return vencido(); } catch (e) { return tela(`<h1 style="font-size:22px">Sem conexão</h1><p class="mu">${C.esc(e.message)}</p><button class="btn pri" onclick="location.reload()">Tentar de novo</button>`); }
  const { data: { session } } = await C.sb.auth.getSession();
  if (session) return escolherLoja(); else return criarConta();
}
function vencido() {
  tela(`<h1 style="font-size:24px">Este QR venceu</h1><p class="mu">Por segurança, cada QR vale 20 minutos. No tablet, toque em <b>Gerar novo QR</b> e leia de novo.</p>`);
}
function sair() { history.replaceState(null, '', location.pathname); }

function criarConta(msg = '') {
  tela(`${passos(0)}<div><h1 style="font-size:24px">Vamos abrir sua loja</h1><p class="mu sm">Crie o acesso do dono. Leva 2 minutos e o tablet se liga sozinho no fim.</p></div>
   <div class="tabs2"><button class="on">Criar conta</button><button id="kJa">Já tenho conta</button></div>
   <form id="kF" style="display:grid;gap:12px" autocomplete="on">
    <label class="f">CNPJ da empresa<div class="row" style="flex-wrap:nowrap"><input name="cnpj" inputmode="numeric" placeholder="00.000.000/0000-00" required autocomplete="off"><button type="button" class="btn sm" id="kBusca" style="white-space:nowrap">Buscar</button></div></label>
    <div id="kEmp" class="kitemp" hidden></div>
    <label class="f">Razão social<input name="razao" required></label>
    <label class="f">Nome da loja<input name="loja" placeholder="Ex.: Mercadinho do Condomínio Sol" required></label>
    <label class="f">Endereço da loja<input name="end" placeholder="Rua, número, bairro, cidade"></label>
    <label class="f">Seu nome<input name="resp" autocomplete="name" required></label>
    <label class="f">E-mail<input name="email" type="email" autocomplete="username" required></label>
    <label class="f">Crie uma senha (mínimo 8 caracteres)<input name="senha" type="password" minlength="8" autocomplete="new-password" required></label>
    <label class="chk" style="align-items:flex-start"><input type="checkbox" name="aceite" required style="margin-top:3px"><span class="sm">Li e aceito os <a href="../termos/" target="_blank" style="color:var(--ink)">Termos de uso e Privacidade</a>.</span></label>
    <input type="hidden" name="uf"><p class="erro" id="kErr">${C.esc(msg)}</p>
    <button class="btn pri" type="submit">Criar conta e ligar o tablet</button></form>`);
  const f = C.$('#kF');
  f.cnpj.oninput = () => { f.cnpj.value = fmtCnpj(f.cnpj.value); if (soDig(f.cnpj.value).length === 14) buscar(f); };
  C.$('#kBusca').onclick = () => buscar(f);
  C.$('#kJa').onclick = () => entrar();
  f.onsubmit = async e => {
    e.preventDefault(); const err = C.$('#kErr'), bt = f.querySelector('[type=submit]'); err.textContent = '';
    if (!cnpjValido(f.cnpj.value)) { err.textContent = 'CNPJ inválido. Confira os 14 números.'; return; }
    bt.disabled = true; bt.textContent = 'Criando sua conta…';
    try {
      const r = await apiKit('criar_conta', { codigo: COD, cnpj: soDig(f.cnpj.value), razao: f.razao.value, nome: f.loja.value, loja: f.loja.value, endereco: f.end.value, responsavel: f.resp.value, email: f.email.value, senha: f.senha.value, uf: f.uf.value });
      const { error } = await C.sb.auth.signInWithPassword({ email: r.email, password: f.senha.value });
      pronto(r.loja?.nome, !error);
    } catch (e2) { err.textContent = e2.message; bt.disabled = false; bt.textContent = 'Criar conta e ligar o tablet'; }
  };
}
async function buscar(f) {
  const d = soDig(f.cnpj.value), box = C.$('#kEmp'), err = C.$('#kErr');
  if (!cnpjValido(d)) { err.textContent = 'CNPJ inválido. Confira os 14 números.'; return; }
  err.textContent = ''; box.hidden = false; box.innerHTML = '<span class="mu sm">Buscando na Receita…</span>';
  try {
    const r = await fetch('https://brasilapi.com.br/api/cnpj/v1/' + d); if (!r.ok) throw new Error(r.status === 404 ? 'CNPJ não encontrado na Receita.' : 'Consulta indisponível; preencha à mão.');
    const j = await r.json(); f.razao.value = j.razao_social || ''; f.uf.value = j.uf || '';
    if (!f.loja.value) f.loja.value = C.bonito(j.nome_fantasia || '');
    if (!f.end.value) f.end.value = [[j.descricao_tipo_de_logradouro, j.logradouro].filter(Boolean).join(' '), j.numero, j.bairro, j.municipio].filter(Boolean).map(x => C.bonito(String(x))).join(', ') + (j.uf ? '/' + j.uf : '');
    const ativa = !j.descricao_situacao_cadastral || /ativa/i.test(j.descricao_situacao_cadastral);
    box.innerHTML = `<b>${C.esc(j.razao_social || '')}</b><span class="mu sm">${C.esc(C.bonito(j.municipio || ''))}${j.uf ? '/' + C.esc(j.uf) : ''} · ${ativa ? 'situação ativa' : '<span style="color:#f87171">situação ' + C.esc(j.descricao_situacao_cadastral) + '</span>'}</span>`;
  } catch (e) { box.innerHTML = `<span class="mu sm">${C.esc(e.message)}</span>`; }
}

function entrar(msg = '') {
  tela(`${passos(0)}<div><h1 style="font-size:24px">Entrar</h1><p class="mu sm">Use o login de dono da loja.</p></div>
   <div class="tabs2"><button id="kNova">Criar conta</button><button class="on">Já tenho conta</button></div>
   <form id="kE" style="display:grid;gap:12px"><label class="f">E-mail<input name="email" type="email" autocomplete="username" required></label><label class="f">Senha<input name="senha" type="password" autocomplete="current-password" required></label><p class="erro" id="kErr">${C.esc(msg)}</p><button class="btn pri" type="submit">Entrar</button></form>`);
  C.$('#kNova').onclick = () => criarConta();
  C.$('#kE').onsubmit = async e => {
    e.preventDefault(); const f = e.target, bt = f.querySelector('button'); bt.disabled = true;
    const { error } = await C.sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.senha.value });
    if (error) { C.$('#kErr').textContent = /Invalid/.test(error.message) ? 'E-mail ou senha incorretos' : error.message; bt.disabled = false; return; }
    escolherLoja();
  };
}

async function escolherLoja() {
  const { sb } = C, { data: { session } } = await sb.auth.getSession();
  const { data: m } = await sb.from('membros').select('empresa_id').eq('user_id', session.user.id).eq('papel', 'dono').eq('ativo', true);
  if (!m?.length) { await sb.auth.signOut(); return entrar('Este login não é de dono. Entre com o login do dono da loja.'); }
  const { data: lojas } = await sb.from('locais').select('id,nome,empresa_id').in('empresa_id', m.map(x => x.empresa_id)).eq('tipo', 'loja').eq('ativo', true).order('nome');
  tela(`${passos(1)}<div><h1 style="font-size:24px">Em qual loja fica este tablet?</h1><p class="mu sm">Ele vai vender os produtos e preços desta loja.</p></div>
   <div style="display:grid;gap:8px;max-height:44vh;overflow:auto">${(lojas || []).map((l, i) => `<label class="opt"><input type="radio" name="lj" value="${l.id}" ${i === 0 ? 'checked' : ''}><span><b>${C.esc(l.nome)}</b></span></label>`).join('')}
    <label class="opt"><input type="radio" name="lj" value="nova" ${lojas?.length ? '' : 'checked'}><span><b>Uma loja nova</b><small>Cria a loja agora</small></span></label></div>
   <div id="kNovaL" style="display:${lojas?.length ? 'none' : 'grid'};gap:10px"><label class="f">Nome da loja nova<input id="kLn" placeholder="Ex.: Condomínio Sol"></label><label class="f">Endereço<input id="kLe"></label></div>
   <p class="erro" id="kErr"></p><button class="btn pri" id="kLig">Ligar o tablet a esta loja</button>`);
  C.$('#raiz').querySelectorAll('[name=lj]').forEach(r => r.onchange = () => { C.$('#kNovaL').style.display = C.$('[name=lj]:checked').value === 'nova' ? 'grid' : 'none'; });
  C.$('#kLig').onclick = async () => {
    const v = C.$('[name=lj]:checked')?.value, bt = C.$('#kLig'); if (!v) return;
    const corpo = v === 'nova' ? { codigo: COD, nova_loja: C.$('#kLn').value, endereco: C.$('#kLe').value, empresa_id: m[0].empresa_id } : { codigo: COD, local_id: v };
    bt.disabled = true; bt.textContent = 'Ligando…';
    try { const r = await apiKit('vincular', corpo, true); pronto(r.loja?.nome, true); }
    catch (e) { C.$('#kErr').textContent = e.message; bt.disabled = false; bt.textContent = 'Ligar o tablet a esta loja'; }
  };
}

function pronto(loja, logado) {
  tela(`${passos(3)}<div class="kitok"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 12l5 5L20 7"/></svg></div>
   <div><h1 style="font-size:24px">Tablet ligado${loja ? ' à loja ' + C.esc(loja) : ''}</h1><p class="mu">Olhe o tablet: em alguns segundos ele pede para criar o PIN do gerente. Depois disso, ele já pode vender.</p></div>
   <p class="mu sm">Agora vamos cadastrar os produtos, a nota fiscal e a maquininha. Dá para fazer pelo celular ou, mais confortável, pelo computador em <b>${C.esc(location.host + location.pathname)}</b>.</p>
   <button class="btn pri" id="kSeg">${logado ? 'Continuar a configuração' : 'Entrar no painel'}</button>`);
  C.$('#kSeg').onclick = () => { sair(); C.iniciar(); };
}

function css() {
  if (document.getElementById('kitCss')) return;
  const s = document.createElement('style'); s.id = 'kitCss';
  s.textContent = `.kitm .card{width:min(460px,100%)}.kitpassos{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.kitpassos span{display:grid;gap:6px;font-size:12px;font-weight:600;color:var(--mu)}.kitpassos i{height:5px;border-radius:9px;background:var(--p3)}.kitpassos .ok i{background:var(--ok)}.kitpassos .on i{background:var(--y)}.kitpassos .on{color:var(--ink)}
.kitemp{display:grid;gap:2px;padding:10px 12px;border-radius:12px;background:var(--p2);border:1px solid var(--line)}.kitok{width:64px;height:64px;border-radius:50%;background:rgba(34,197,94,.14);color:var(--ok);display:grid;place-items:center}
@media(max-width:520px){.login{padding:14px}.login .card{padding:22px}}`;
  document.head.appendChild(s);
}

// ---------- fábrica: equipe Beep prepara um tablet novo (só aparece para quem está em kit_admins) ----------
export async function cartaoFabrica(ctx, el) {
  C = ctx; if (!el) return;
  const { data: { session } } = await C.sb.auth.getSession(); if (!session) return;
  const { data: adm } = await C.sb.from('kit_admins').select('user_id').eq('user_id', session.user.id).maybeSingle();
  if (!adm) return;
  const { data: ss } = await C.sb.from('kit_seriais').select('final,rotulo,criado_em,usado_em').order('criado_em', { ascending: false }).limit(8);
  el.innerHTML = `<div class="card" style="margin-top:18px;display:grid;gap:12px"><div class="row"><div style="flex:1;min-width:240px"><h2 style="font-size:18px">Kits de fábrica <span class="pill new">equipe Beep</span></h2><p class="mu sm" style="margin-top:4px">Prepara um tablet novo para ser vendido: ele sai mostrando o QR para o cliente criar a conta sozinho. Só você vê este quadro.</p></div><button class="btn" id="fabNovo">Preparar tablet</button></div>
   ${ss?.length ? `<div class="tblwrap"><table class="tbl"><thead><tr><th>Série</th><th>Identificação</th><th>Preparado</th><th>Situação</th></tr></thead><tbody>${ss.map(x => `<tr><td class="num">…${C.esc(x.final)}</td><td>${C.esc(x.rotulo || '—')}</td><td class="mu">${new Date(x.criado_em).toLocaleDateString('pt-BR')}</td><td>${x.usado_em ? '<span class="pill ok">Ativado pelo cliente</span>' : '<span class="pill">Aguardando cliente</span>'}</td></tr>`).join('')}</tbody></table></div>` : ''}</div>`;
  C.$('#fabNovo').onclick = () => {
    C.modal(`<h2>Preparar tablet de fábrica</h2><p class="mu sm">Dê um nome para lembrar qual tablet é (ex.: etiqueta da caixa).</p><label class="f">Identificação<input id="fabRot" placeholder="Ex.: Kit 001 · Samsung Tab A9"></label><p class="erro" id="fabErr"></p><div class="row"><span class="sp"></span><button class="btn" data-close>Cancelar</button><button class="btn pri" id="fabOk">Gerar</button></div>`);
    C.$('#fabOk').onclick = async () => {
      const b = C.$('#fabOk'); b.disabled = true;
      try {
        const r = await apiKit('gerar_serial', { rotulo: C.$('#fabRot').value }, true);
        const link = location.origin + location.pathname.replace(/gestao\/?.*$/, '') + '#fabrica=' + r.serial;
        let svg = ''; try { const { default: Q } = await import('https://cdn.jsdelivr.net/npm/qrcode-generator@2.0.4/+esm'); const q = Q(0, 'M'); q.addData(link); q.make(); svg = q.createSvgTag({ cellSize: 6, margin: 2, scalable: true }); } catch { }
        C.modal(`<h2>Abra este link no tablet novo</h2><p class="mu sm">Leia o QR com a câmera do tablet (ou abra o link no navegador dele) <b>uma vez</b>. Ele guarda o número de série e passa a mostrar o QR de boas-vindas para o cliente. Este link não aparece de novo.</p>
          <div style="display:grid;place-items:center"><div style="width:220px;height:220px;background:#fff;border-radius:16px;padding:8px">${svg}</div></div><input readonly value="${C.esc(link)}" onclick="this.select()"><div class="row"><span class="sp"></span><button class="btn" id="fabCopia">Copiar link</button><button class="btn pri" data-close>Pronto</button></div>`);
        C.$('#fabCopia').onclick = () => navigator.clipboard?.writeText(link).then(() => C.toast('Link copiado'));
        cartaoFabrica(ctx, el);
      } catch (e) { C.$('#fabErr').textContent = e.message; b.disabled = false; }
    };
  };
}
