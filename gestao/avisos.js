// Avisos da inteligência no Painel: sino com a lista, pop-ups quando aparece algo novo,
// notificação no celular (Painel instalado) e a conexão opcional com IA.
// O dono decide em Configurações se a empresa recebe avisos, quem recebe (dono, gerente) e quais tipos.

const PUBLICA = 'BLzX5j5PkB1yyecilY6cujpbCFVzKLFvM2Cmqo96UZYwktpE8ZwpuImyMeLmdGS81hu8k6iBHDCJJ6p3Cd51vmg';
export const PADRAO = { ativo: true, papeis: { dono: true, gerente: true }, tipos: { estrategico: true, vencimentos: true, abastecimento: true } };
const TIPOS = [['estrategico', 'Estratégicos', 'Produtos em falta ou que pararam de vender, margem, parados e portfólio.'],
  ['vencimentos', 'Vencimentos', 'Contas a pagar vencidas, de hoje e dos próximos dias.'],
  ['abastecimento', 'Abastecimento e compras', 'O que levar às lojas e o que comprar para o CD.']];
const IA = [['anthropic', 'Anthropic (Claude)'], ['openai', 'OpenAI (ChatGPT)'], ['google', 'Google (Gemini)'], ['outro', 'Outro']];
const V = { lista: [], timer: null, aberto: false };
const IC = {
  sino: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  bad: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  warn: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  info: '<path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4z"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
};
const svg = (k, s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${IC[k]}</svg>`;

const CSS = `
.av-sino{position:fixed;top:14px;right:18px;z-index:60;width:42px;height:42px;border-radius:12px;display:grid;place-items:center;background:var(--p2);border:1px solid var(--line);color:var(--ink);box-shadow:0 6px 20px var(--sombra)}
.av-sino:hover{border-color:var(--hl)}
.av-sino b{position:absolute;top:-6px;right:-6px;min-width:20px;height:20px;padding:0 5px;border-radius:999px;background:var(--bad);color:#fff;font:700 11px/20px Inter,sans-serif;text-align:center}
.av-pnl{position:fixed;top:64px;right:18px;z-index:61;width:min(400px,calc(100vw - 32px));max-height:min(70vh,560px);overflow:auto;background:var(--p1);border:1px solid var(--line);border-radius:16px;box-shadow:0 18px 50px var(--sombra)}
.av-pnl header{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--p1)}
.av-pnl header b{font:700 15px Manrope,Inter,sans-serif}.av-pnl header .sp{flex:1}
.av-it{display:flex;gap:12px;align-items:flex-start;padding:12px 16px;border-top:1px solid var(--line);text-align:left;width:100%}
.av-it:first-of-type{border-top:0}.av-it:hover{background:var(--p2)}
.av-it .ic{flex:none;margin-top:1px}.av-it .ic.bad{color:var(--badt)}.av-it .ic.warn{color:var(--warnt)}.av-it .ic.info{color:var(--newt)}
.av-it b{display:block;font-size:13.5px;font-weight:600}.av-it p{font-size:12.5px;color:var(--mu);margin-top:2px}
.av-vz{padding:28px 16px;text-align:center;color:var(--mu);font-size:13.5px}
.av-pop{position:fixed;right:18px;bottom:18px;z-index:70;display:grid;gap:10px;width:min(380px,calc(100vw - 32px))}
.av-card{display:flex;gap:12px;align-items:flex-start;padding:14px 14px 14px 16px;background:var(--p1);border:1px solid var(--line);border-left:3px solid var(--y);border-radius:14px;box-shadow:0 14px 40px var(--sombra);cursor:pointer;animation:avIn .35s cubic-bezier(.2,.8,.3,1)}
.av-card.bad{border-left-color:var(--bad)}.av-card.warn{border-left-color:var(--warn)}.av-card.info{border-left-color:var(--blue)}
.av-card .tx{flex:1;min-width:0}.av-card small{display:block;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--mu)}
.av-card b{display:block;font-size:14px;margin-top:2px}.av-card p{font-size:12.5px;color:var(--mu);margin-top:2px}
.av-card button{flex:none;color:var(--mu);padding:2px}.av-card button:hover{color:var(--ink)}
@keyframes avIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){.av-card{animation:none}}
@media(max-width:900px){.av-sino{top:10px;right:12px;width:40px;height:40px}.av-pnl{top:58px;right:12px}.av-pop{right:12px;bottom:12px}}
@media print{.av-sino,.av-pnl,.av-pop{display:none!important}}
.av-sw{display:flex;align-items:flex-start;gap:12px;padding:12px 0;border-top:1px solid var(--line)}
.av-sw:first-of-type{border-top:0}.av-sw input{width:18px;height:18px;accent-color:var(--y);margin-top:2px;flex:none}
.av-sw b{display:block;font-weight:600}.av-sw small{display:block;color:var(--mu);font-size:12.5px}
.av-dv{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
`;
function estilo() { if (document.getElementById('avcss')) return; const s = document.createElement('style'); s.id = 'avcss'; s.textContent = CSS; document.head.appendChild(s); }

async function lerCfg(C) {
  const { data } = await C.sb.from('empresas').select('inteligencia').eq('id', C.S.emp.id).maybeSingle();
  const intel = data?.inteligencia || {}, a = intel.avisos || {};
  return { intel, cfg: { ...PADRAO, ...a, papeis: { ...PADRAO.papeis, ...(a.papeis || {}) }, tipos: { ...PADRAO.tipos, ...(a.tipos || {}) } } };
}
async function salvarIntel(C, novo) {
  const { data: atual } = await C.sb.from('empresas').select('inteligencia').eq('id', C.S.emp.id).maybeSingle();
  const r = await C.sb.from('empresas').update({ inteligencia: { ...(atual?.inteligencia || {}), ...novo } }).eq('id', C.S.emp.id).select('id');
  if (r.error || !r.data?.length) throw new Error(r.error?.message || 'sem permissão');
}
const recebe = (cfg, papel) => cfg.ativo && cfg.papeis[papel] !== false;

// ---------------- lista de avisos ----------------
async function montar(C, cfg) {
  const out = [];
  if (cfg.tipos.vencimentos) {
    try {
      const m = await import('./contas.js?v=1'), a = await m.avisosContas(C);
      if (a) {
        if (a.vencidas) out.push({ id: 'cp-venc', tipo: 'vencimentos', nivel: 'bad', titulo: `${a.vencidas} ${a.vencidas === 1 ? 'conta vencida' : 'contas vencidas'}`, texto: `${C.brl(a.vencidasValor)} em atraso. Pague ou marque como paga.`, tela: 'cp' });
        if (a.proximas) out.push({ id: 'cp-prox', tipo: 'vencimentos', nivel: a.hoje ? 'warn' : 'info', titulo: a.hoje ? `${a.hoje} ${a.hoje === 1 ? 'conta vence' : 'contas vencem'} hoje` : `${a.proximas} ${a.proximas === 1 ? 'conta vence' : 'contas vencem'} em até 3 dias`, texto: `${C.brl(a.proximasValor)} nos próximos dias.`, tela: 'cp' });
      }
    } catch (e) { /* sem contas: segue */ }
  }
  if (cfg.tipos.estrategico || cfg.tipos.abastecimento) {
    try {
      const m = await import('./inteligencia.js?v=6'), { A, ins } = await m.analiseParaAvisos(C);
      const R = A.resumo, abs = A.itensLoja.filter(x => x.levar > 0 && x.status !== 'parado').length;
      if (cfg.tipos.estrategico) for (const x of ins.filter(x => x.tipo !== 'compra').slice(0, 4)) out.push({ id: 'ig-' + x.titulo, tipo: 'estrategico', nivel: x.nivel, titulo: x.titulo, texto: x.texto, tela: 'int' });
      if (cfg.tipos.abastecimento && (abs || R.compraItens)) out.push({ id: 'ig-abs-' + abs + '-' + R.compraItens, tipo: 'abastecimento', nivel: R.compraUrgente ? 'warn' : 'info', titulo: 'Abastecimento pela inteligência', texto: `${abs ? `${abs} produtos para levar às lojas` : ''}${abs && R.compraItens ? ' e ' : ''}${R.compraItens ? `pedido de compra de ${C.brl(Math.round(R.compraValor))}${R.compraUrgente ? ` (${R.compraUrgente} urgentes)` : ''}` : ''}.`, tela: 'int', aba: 'abs' });
      // guarda o resumo para o aviso das 8h no celular (o servidor não refaz a análise)
      const hoje = new Date().toISOString().slice(0, 10), ult = (await lerCfg(C)).intel.resumo_avisos;
      if (!ult || ult.em.slice(0, 10) !== hoje || Date.now() - new Date(ult.em).getTime() > 3 * 3600 * 1000) {
        salvarIntel(C, { resumo_avisos: { em: new Date().toISOString(), falta: R.falta, perdaDia: R.perdaDia, compraValor: R.compraValor, compraItens: R.compraItens, compraUrgente: R.compraUrgente, abs, top: ins.slice(0, 3).map(x => x.titulo) } }).catch(() => {});
      }
    } catch (e) { /* inteligência sem dados: segue */ }
  }
  const ord = { bad: 0, warn: 1, info: 2 };
  return out.sort((a, b) => ord[a.nivel] - ord[b.nivel]);
}

const vistosKey = C => 'pn-avisos-' + C.S.user.id + '-' + new Date().toISOString().slice(0, 10);
function vistos(C) { try { return new Set(JSON.parse(localStorage.getItem(vistosKey(C)) || '[]')); } catch (e) { return new Set(); } }
function marcar(C, ids) { try { const v = vistos(C); ids.forEach(i => v.add(i)); localStorage.setItem(vistosKey(C), JSON.stringify([...v])); } catch (e) { /* sem armazenamento */ } }

function ir(C, a) {
  if (a.aba) { try { sessionStorage.setItem('igAba', a.aba); } catch (e) { /* sem sessionStorage */ } }
  fecharPainel(); C.ir(a.tela);
}
function sino(C) {
  let b = document.getElementById('avSino');
  if (!b) {
    b = document.createElement('button'); b.id = 'avSino'; b.className = 'av-sino'; b.setAttribute('aria-label', 'Avisos da inteligência');
    document.body.appendChild(b);
    b.onclick = () => (V.aberto ? fecharPainel() : abrirPainel(C));
  }
  const novos = V.lista.filter(a => !vistos(C).has(a.id)).length;
  b.innerHTML = svg('sino', 19) + (novos ? `<b>${novos > 9 ? '9+' : novos}</b>` : '');
}
function abrirPainel(C) {
  fecharPainel(); V.aberto = true;
  const p = document.createElement('div'); p.id = 'avPnl'; p.className = 'av-pnl';
  p.innerHTML = `<header><b>Avisos</b><span class="sp"></span><span class="mu sm">${V.lista.length || ''}</span></header>${V.lista.map((a, i) => `<button class="av-it" data-i="${i}"><span class="ic ${a.nivel}">${svg(a.nivel, 18)}</span><span><b>${C.esc(a.titulo)}</b><p>${C.esc(a.texto)}</p></span></button>`).join('') || '<div class="av-vz">Nada novo por aqui. A inteligência avisa quando algo precisar de você.</div>'}`;
  document.body.appendChild(p);
  p.querySelectorAll('[data-i]').forEach(x => x.onclick = () => ir(C, V.lista[+x.dataset.i]));
  marcar(C, V.lista.map(a => a.id)); sino(C);
  setTimeout(() => document.addEventListener('click', fora, true), 0);
}
function fora(e) { const p = document.getElementById('avPnl'), b = document.getElementById('avSino'); if (p && !p.contains(e.target) && !b.contains(e.target)) fecharPainel(); }
function fecharPainel() { document.getElementById('avPnl')?.remove(); V.aberto = false; document.removeEventListener('click', fora, true); }

function popups(C) {
  const v = vistos(C), novos = V.lista.filter(a => !v.has(a.id) && a.nivel !== 'info').slice(0, 3);
  if (!novos.length) return;
  let box = document.getElementById('avPop');
  if (!box) { box = document.createElement('div'); box.id = 'avPop'; box.className = 'av-pop'; document.body.appendChild(box); }
  const rot = { estrategico: 'Inteligência', vencimentos: 'Vencimentos', abastecimento: 'Abastecimento' };
  novos.forEach((a, k) => setTimeout(() => {
    const c = document.createElement('div'); c.className = 'av-card ' + a.nivel;
    c.innerHTML = `<div class="tx"><small>${rot[a.tipo]}</small><b>${C.esc(a.titulo)}</b><p>${C.esc(a.texto)}</p></div><button aria-label="Fechar">${svg('x', 16)}</button>`;
    c.onclick = e => { if (e.target.closest('button')) { c.remove(); return; } c.remove(); ir(C, a); };
    box.appendChild(c); setTimeout(() => c.remove(), 14000);
  }, 600 + k * 700));
  marcar(C, novos.map(a => a.id)); setTimeout(() => sino(C), 2600);
}

// chamado uma vez quando o Painel abre; refaz a cada 30 minutos
export async function iniciarAvisos(C) {
  estilo();
  const roda = async () => {
    try {
      const { cfg } = await lerCfg(C);
      if (!recebe(cfg, C.S.papel)) { document.getElementById('avSino')?.remove(); return; }
      V.lista = await montar(C, cfg); sino(C); popups(C);
    } catch (e) { /* aviso nunca trava o Painel */ }
  };
  clearInterval(V.timer); V.timer = setInterval(roda, 30 * 60 * 1000);
  setTimeout(roda, 2500);
}

// ---------------- celular: notificação do Painel instalado ----------------
const b64 = s => { const p = '='.repeat((4 - s.length % 4) % 4), r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(r, c => c.charCodeAt(0)); };
const suporta = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const instalado = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
async function registro() { return navigator.serviceWorker.register('./sw-painel.js', { scope: './' }); }
async function assinaturaAtual() { if (!suporta()) return null; const r = await navigator.serviceWorker.getRegistration('./'); return r ? r.pushManager.getSubscription() : null; }
async function ativarAqui(C) {
  if (!suporta()) throw new Error(ios() && !instalado() ? 'No iPhone, primeiro adicione o Painel à tela de início (Compartilhar › Adicionar à Tela de Início) e abra por lá.' : 'Este navegador não aceita notificações.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('As notificações foram bloqueadas. Libere nas configurações do navegador para este site.');
  const reg = await registro(); await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(PUBLICA) });
  const j = sub.toJSON();
  await C.sb.from('push_assinaturas').delete().eq('endpoint', j.endpoint);
  const r = await C.sb.from('push_assinaturas').insert({ empresa_id: C.S.emp.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, aparelho: (navigator.userAgentData?.platform || navigator.platform || '').slice(0, 60) + (instalado() ? ' · instalado' : '') });
  if (r.error) throw new Error(r.error.message);
}
async function desativarAqui(C) {
  const s = await assinaturaAtual(); if (!s) return;
  await C.sb.from('push_assinaturas').delete().eq('endpoint', s.endpoint); await s.unsubscribe();
}
async function testar(C) {
  const { data: { session } } = await C.sb.auth.getSession();
  const r = await fetch('https://gdnvjpmpfgautrmtkjmx.supabase.co/functions/v1/avisos', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token }, body: JSON.stringify({ acao: 'teste' }) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.erro || 'falhou'); return j;
}

// ---------------- Configurações: avisos e conexão com IA ----------------
export async function cfgAvisos(C, el) {
  estilo();
  const { esc, toast, S } = C, dono = S.papel === 'dono';
  const { intel, cfg } = await lerCfg(C);
  const sub = await assinaturaAtual().catch(() => null), ia = intel.ia || null;
  el.innerHTML = `<div class="card" style="display:grid;gap:6px;max-width:760px;margin-top:16px"><div><h2 style="font-size:18px">Avisos da inteligência</h2><p class="mu sm">Pop-ups e sino no Painel, e notificação no celular com o Painel instalado. ${dono ? 'Só o dono muda estas opções.' : 'Quem muda estas opções é o dono.'}</p></div>
    <label class="av-sw"><input type="checkbox" id="avAtivo" ${cfg.ativo ? 'checked' : ''} ${dono ? '' : 'disabled'}><span><b>Ligar avisos</b><small>Desligado, ninguém recebe pop-up nem notificação.</small></span></label>
    <div class="av-sw" style="display:block"><b style="font-weight:600">Quem recebe</b><div class="row" style="gap:18px;margin-top:8px">${[['dono', 'Dono'], ['gerente', 'Gerente']].map(([k, t]) => `<label class="row" style="gap:8px"><input type="checkbox" data-papel="${k}" ${cfg.papeis[k] !== false ? 'checked' : ''} ${dono ? '' : 'disabled'} style="width:18px;height:18px;accent-color:var(--y)">${t}</label>`).join('')}</div></div>
    ${TIPOS.map(([k, t, d]) => `<label class="av-sw"><input type="checkbox" data-tipo="${k}" ${cfg.tipos[k] !== false ? 'checked' : ''} ${dono ? '' : 'disabled'}><span><b>${t}</b><small>${d}</small></span></label>`).join('')}
    ${dono ? '<div class="row" style="justify-content:flex-end;margin-top:6px"><button class="btn pri" id="avSalvar">Salvar avisos</button></div>' : ''}
  </div>
  <div class="card" style="display:grid;gap:10px;max-width:760px;margin-top:16px"><div><h2 style="font-size:18px">Notificação neste aparelho</h2><p class="mu sm">Todo dia às 8h, e quando houver algo importante, a inteligência manda um resumo para os aparelhos ativados. Vale para quem o dono marcou acima.</p></div>
    <div class="mu sm">${!suporta() ? (ios() && !instalado() ? 'No iPhone: toque em Compartilhar e depois em "Adicionar à Tela de Início". Abra o Painel pelo ícone e volte aqui para ativar (precisa do iOS 16.4 ou mais novo).' : 'Este navegador não aceita notificações. No celular, use o Chrome (Android) ou o Painel instalado na tela de início (iPhone).') : sub ? 'Este aparelho está recebendo os avisos.' : instalado() ? 'O Painel está instalado. Falta só ativar.' : 'Funciona melhor com o Painel instalado: no Chrome, menu ⋮ › "Instalar app" ou "Adicionar à tela inicial".'}</div>
    <div class="av-dv">${suporta() ? (sub ? '<button class="btn" id="avTeste">Mandar um teste</button><button class="btn dang" id="avOff">Desativar neste aparelho</button>' : '<button class="btn pri" id="avOn">Ativar neste aparelho</button>') : ''}</div>
  </div>
  ${dono ? `<div class="card" style="display:grid;gap:12px;max-width:760px;margin-top:16px"><div><h2 style="font-size:18px">Conexão com IA <span class="pill" style="margin-left:6px">opcional</span></h2><p class="mu sm">A inteligência funciona sem IA. Se você quiser recursos extras, como perguntar em texto livre, conecte a sua própria conta de IA. A chave fica guardada só no servidor, nunca aparece no Painel de novo, e o uso é cobrado pela empresa de IA direto na sua conta.</p></div>
    ${ia?.ativo ? `<div class="row" style="gap:10px"><span class="pill ok">Conectado</span><span>${esc((IA.find(x => x[0] === ia.provedor) || [0, ia.provedor])[1])}${ia.modelo ? ' · ' + esc(ia.modelo) : ''} · chave terminada em ${esc(ia.fim)}</span></div>` : '<div class="mu sm">Nenhuma conexão cadastrada.</div>'}
    <div class="grid2" style="gap:12px"><label class="f">Provedor<select id="iaProv">${IA.map(([k, t]) => `<option value="${k}" ${ia?.provedor === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="f">Modelo (opcional)<input id="iaMod" value="${esc(ia?.modelo || '')}" placeholder="o recomendado do provedor" maxlength="80"></label></div>
    <label class="f">Chave de acesso (API key)<input id="iaChave" type="password" autocomplete="off" placeholder="${ia?.ativo ? 'deixe em branco para manter a atual' : 'cole a chave aqui'}"></label>
    <div class="row" style="justify-content:flex-end;gap:10px">${ia?.ativo ? '<button class="btn dang" id="iaOff">Desconectar</button>' : ''}<button class="btn pri" id="iaSalvar">${ia?.ativo ? 'Salvar' : 'Conectar'}</button></div>
  </div>` : ''}`;
  const q = s => el.querySelector(s);
  if (q('#avSalvar')) q('#avSalvar').onclick = async () => {
    const novo = { ativo: q('#avAtivo').checked, papeis: {}, tipos: {} };
    el.querySelectorAll('[data-papel]').forEach(i => { novo.papeis[i.dataset.papel] = i.checked; });
    el.querySelectorAll('[data-tipo]').forEach(i => { novo.tipos[i.dataset.tipo] = i.checked; });
    try { await salvarIntel(C, { avisos: novo }); toast('Avisos salvos'); iniciarAvisos(C); } catch (e) { toast('Não foi possível salvar: ' + e.message); }
  };
  const acao = (id, fn, ok) => { if (q(id)) q(id).onclick = async e => { e.target.disabled = true; try { await fn(); if (ok) toast(ok); cfgAvisos(C, el); } catch (er) { toast(er.message); e.target.disabled = false; } }; };
  acao('#avOn', () => ativarAqui(C), 'Avisos ativados neste aparelho');
  acao('#avOff', () => desativarAqui(C), 'Avisos desativados neste aparelho');
  acao('#avTeste', async () => { const r = await testar(C); if (!r.enviados) throw new Error('Não chegou em nenhum aparelho. Desative e ative de novo.'); }, 'Teste enviado');
  const salvarIA = async chave => {
    const { error } = await C.sb.rpc('ia_conexao_salvar', { p_empresa: S.emp.id, p_provedor: q('#iaProv').value, p_modelo: q('#iaMod').value.trim(), p_chave: chave });
    if (error) throw new Error(error.message);
  };
  acao('#iaSalvar', async () => {
    const ch = q('#iaChave').value.trim();
    if (!ch && !ia?.ativo) throw new Error('Cole a chave de acesso');
    if (!ch) { await salvarIntel(C, { ia: { ...ia, provedor: q('#iaProv').value, modelo: q('#iaMod').value.trim() } }); return; }
    await salvarIA(ch);
  }, 'Conexão com IA salva');
  acao('#iaOff', () => salvarIA(''), 'IA desconectada');
}
