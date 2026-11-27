// Tela "Inteligência" do Painel: o cérebro do negócio.
// Os números vêm do banco (rpc inteligencia_base) e as contas ficam no motor (inteligencia-motor.js), sem IA externa.

import { analisar, insights, quandoTxt, ritmoTxt, CFG_PADRAO } from './inteligencia-motor.js?v=2';

const ABAS = [['loja', 'Lojas'], ['compra', 'Compras do CD'], ['minmax', 'Mín. e máx.'], ['essencial', 'Não pode faltar'], ['parado', 'Parados'], ['margem', 'Margem']];
const G = { aba: 'loja', loja: '', filtro: 'atencao', q: '', A: null, base: null, cfg: null, timer: null, feedI: 0 };
const nf = (v, c = 0) => (+v || 0).toLocaleString('pt-BR', { maximumFractionDigits: c, minimumFractionDigits: 0 });
const mil = c => { const r = c / 100; return r >= 1e6 ? nf(r / 1e6, 1) + ' mi' : r >= 1e4 ? nf(r / 1e3, 0) + ' mil' : nf(r, 0); };

const IC = {
  loja: '<path d="M3 9l1.5-5h15L21 9M4 9v11h16V9M3 9h18M9 20v-6h6v6"/>',
  cd: '<path d="M3 21V8l9-5 9 5v13M7 21v-8h10v8M7 17h10"/>',
  sefaz: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
  forn: '<path d="M1 7h13v10H1zM14 10h4l3 3v4h-7"/><circle cx="5" cy="18.5" r="1.8"/><circle cx="17" cy="18.5" r="1.8"/>',
  fin: '<path d="M4 20V10M10 20V4M16 20v-7M2 20h20"/>',
  cx: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
  cfg: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  bad: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  warn: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  info: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
};
const svg = (k, s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${IC[k]}</svg>`;

// ---------------- estilo (só desta tela) ----------------
const CSS = `
.ig-hero{display:grid;grid-template-columns:minmax(0,1fr);border:1px solid var(--line);border-radius:var(--r);background:var(--p1);overflow:hidden;margin-bottom:18px}
.ig-net{position:relative;height:380px;border-bottom:1px solid var(--line);background:radial-gradient(ellipse 34% 62% at 50% 50%,rgba(255,214,10,.08),transparent 72%)}
.ig-net.cp{height:auto;aspect-ratio:560/300}
.ig-net svg{position:absolute;inset:0;width:100%;height:100%}
.ig-lane{fill:none;stroke:rgba(255,214,10,.32);stroke-width:1.1}
.ig-lane.in{stroke:rgba(56,189,248,.3)}
.ig-pad{fill:var(--p1);stroke:rgba(255,214,10,.6);stroke-width:1.2}.ig-pad.in{stroke:rgba(56,189,248,.6)}
.ig-dec{fill:none;stroke:rgba(255,214,10,.14);stroke-width:1}
.ig-dec-p{fill:none;stroke:rgba(255,214,10,.3);stroke-width:1}
.ig-dec-d{fill:rgba(255,214,10,.55)}
.ig-beam{fill:none;stroke:#ffe866;stroke-width:2.6;stroke-linecap:round;stroke-dasharray:22 300;stroke-dashoffset:22;opacity:0;animation:igBeam 4.4s cubic-bezier(.35,0,.55,1) infinite}
.ig-beam.fio{stroke:#fffbe0;stroke-width:1.2;stroke-dasharray:6 300}
.ig-beam.in{stroke:#38bdf8}.ig-beam.in.fio{stroke:#e0f6ff}
html[data-tema=claro] .ig-beam{stroke:#b88600}html[data-tema=claro] .ig-beam.fio{stroke:#8a6500}html[data-tema=claro] .ig-beam.in{stroke:#0369a1}html[data-tema=claro] .ig-beam.in.fio{stroke:#075985}
html[data-tema=claro] .ig-lane{stroke:rgba(138,101,0,.35)}html[data-tema=claro] .ig-lane.in{stroke:rgba(3,105,161,.3)}html[data-tema=claro] .ig-dec{stroke:rgba(138,101,0,.18)}
@keyframes igBeam{0%{stroke-dashoffset:22;opacity:0}3%{opacity:1}28%{opacity:1}31%{stroke-dashoffset:-100;opacity:0}100%{stroke-dashoffset:-100;opacity:0}}
.ig-node rect{fill:var(--p2);stroke:var(--line);animation:igHit 4.4s ease-out infinite}
@keyframes igHit{0%,26%{stroke:var(--line)}31%{stroke:rgba(255,214,10,.9);filter:drop-shadow(0 0 6px rgba(255,214,10,.45))}50%,100%{stroke:var(--line);filter:none}}
.ig-node text{fill:var(--ink);font:600 13px Inter,sans-serif}
.ig-node .ig-sub{fill:var(--mu);font:500 11.5px Inter,sans-serif}
.ig-node .ig-ic{color:var(--yt)}
.ig-node .ig-led{fill:var(--ok);animation:igLed 1.8s ease-in-out infinite}
.ig-esf{fill:url(#igEsfG);stroke:rgba(255,214,10,.4);stroke-width:1.2}
.ig-halo{fill:none;stroke:rgba(255,214,10,.3);stroke-width:1}
.ig-ring{fill:none;stroke:rgba(255,214,10,.4);stroke-width:1}
.ig-ring.r1{stroke-width:5;stroke-dasharray:1.2 3.8;stroke:rgba(255,214,10,.3);animation:igRot 50s linear infinite}
.ig-ring.r2{stroke-width:2;stroke-dasharray:70 18 12 18;animation:igRot 26s linear infinite reverse}
.ig-ring.r3{stroke:rgba(56,189,248,.35);stroke-dasharray:1 5;animation:igRot 40s linear infinite}
.ig-ring.r4{stroke-width:7;stroke:rgba(255,214,10,.13);stroke-dasharray:34 120;animation:igRot 18s linear infinite}
.ig-syn-l{stroke:rgba(255,214,10,.24);stroke-width:.8}
.ig-neu{fill:var(--yt);animation:igSyn 1.8s ease-in-out infinite}
.ig-fire{fill:#fff7c2}
.ig-core{animation:igCore 2.2s ease-in-out infinite}
.ig-clu{animation:igRot 70s linear infinite}
html[data-tema=claro] .ig-halo,html[data-tema=claro] .ig-ring,html[data-tema=claro] .ig-esf{stroke:rgba(138,101,0,.35)}html[data-tema=claro] .ig-syn-l{stroke:rgba(138,101,0,.28)}html[data-tema=claro] .ig-fire{fill:#8a6500}
@keyframes igSyn{0%,100%{opacity:.25}50%{opacity:1}}
@keyframes igLed{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes igRot{to{transform:rotate(360deg)}}
@keyframes igCore{0%,100%{transform:scale(.86);opacity:.6}50%{transform:scale(1.12);opacity:1}}
.ig-feed{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);column-gap:28px;align-content:start;padding:18px 22px;min-width:0}
.ig-feed>.ig-feed-h,.ig-feed>.ig-stat,.ig-feed>.ig-pens{grid-column:1/-1}
.ig-feed>.ig-hist{margin-top:0}
.ig-feed-h{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.ig-feed-h b{font:700 13px Inter,sans-serif;text-transform:uppercase;letter-spacing:.06em;color:var(--mu)}
.ig-live{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--okt);font-weight:600}.ig-live i{width:7px;height:7px;border-radius:50%;background:var(--ok);animation:igLed 1.4s infinite}
.ig-feed-h .sp{flex:1}
.ig-now{min-height:96px;padding:14px 16px;border-radius:14px;background:var(--p2);border:1px solid var(--line);cursor:pointer;transition:border-color .15s}
.ig-now:hover{border-color:var(--hl)}
.ig-now .ig-k{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
.ig-now .ig-k.bad{color:var(--badt)}.ig-now .ig-k.warn{color:var(--warnt)}.ig-now .ig-k.info{color:var(--newt)}
.ig-now h3{font:700 16.5px/1.35 Manrope,Inter,sans-serif;margin-top:6px}
.ig-now p{color:var(--mu);font-size:13.5px;margin-top:4px}
.ig-car{display:inline-block;width:2px;height:1em;background:var(--yt);vertical-align:-2px;margin-left:2px;animation:igLed .9s steps(1) infinite}
.ig-pens{color:var(--mu);font-size:13.5px;display:flex;align-items:center;gap:8px;min-height:24px}
.ig-pens i{width:5px;height:5px;border-radius:50%;background:var(--mu);display:inline-block;animation:igSyn 1s infinite}.ig-pens i:nth-child(2){animation-delay:.2s}.ig-pens i:nth-child(3){animation-delay:.4s}
.ig-hist{margin-top:12px;display:grid;gap:2px}
.ig-hist button{display:flex;gap:10px;align-items:center;text-align:left;padding:8px 2px;border-top:1px solid var(--line);font-size:13px;color:var(--mu);min-width:0}
.ig-hist button:first-child{border-top:0}
.ig-hist button:hover{color:var(--ink)}
.ig-hist button span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.ig-hist .ig-b{flex:none;width:8px;height:8px;border-radius:3px}
.ig-b.bad{background:var(--bad)}.ig-b.warn{background:var(--warn)}.ig-b.info{background:var(--blue)}
.ig-stat{margin-top:12px;padding-top:12px;font-size:12px;color:var(--mu2);border-top:1px dashed var(--line)}
.ig-kpi{margin-bottom:18px}
.ig-kpi .kpi{min-height:104px;display:flex;flex-direction:column}
.ig-kpi .kpi small{margin-top:auto;padding-top:6px}
.ig-cols{display:grid;grid-template-columns:minmax(0,1fr);gap:16px}
.ig-tab{margin:22px 0 14px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.ig-tab .sp{flex:1}
.ig-tbl td{vertical-align:middle}
.ig-tbl .n{text-align:right;white-space:nowrap}
.ig-tbl tr.ig-x td:first-child{box-shadow:inset 3px 0 var(--bad)}
.ig-tbl tr.ig-w td:first-child{box-shadow:inset 3px 0 var(--warn)}
.ig-pn{display:flex;align-items:center;gap:8px;min-width:0}.ig-pn b{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ig-st{color:var(--yt);flex:none;display:inline-flex}
.ig-st.off{color:var(--mu3)}
.ig-st button{display:inline-flex;color:inherit}
.ig-why{font-size:12px;color:var(--mu)}
.ig-tag{display:inline-block;font-size:11px;font-weight:700;padding:1px 7px;border-radius:6px;background:var(--p3);color:var(--mu);margin-left:6px;vertical-align:1px}
.ig-tag.a{background:rgba(255,214,10,.14);color:var(--yt)}
.ig-aviso{display:flex;gap:12px;align-items:flex-start;padding:14px 16px;border-radius:14px;border:1px solid rgba(245,158,11,.3);background:rgba(245,158,11,.07);font-size:13.5px;margin-bottom:16px}
.ig-aviso svg{color:var(--warnt);flex:none;margin-top:1px}
.ig-cfg{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.ig-tot td{font-weight:700;background:var(--p2)}
@media(prefers-reduced-motion:reduce){.ig-ring,.ig-neu,.ig-core,.ig-clu,.ig-led,.ig-node rect,.ig-car,.ig-live i,.ig-pens i{animation:none!important}.ig-beam,.ig-fire,.ig-halo,.ig-dec-d{display:none}}
@media(max-width:900px){.ig-feed{grid-template-columns:minmax(0,1fr)}.ig-feed>.ig-hist{margin-top:12px}}
@media(max-width:900px){.ig-kpi{grid-template-columns:repeat(2,minmax(0,1fr))}.ig-cfg{grid-template-columns:1fr}.ig-hm{display:none}}
`;
function estilo() { if (document.getElementById('igcss')) return; const s = document.createElement('style'); s.id = 'igcss'; s.textContent = CSS; document.head.appendChild(s); }

// ---------------- o cérebro (SVG) ----------------
// Esfera de neurônios no centro, ligada a 5 cartões com números reais. Cada ligação tem duas vias:
// a amarela leva (o núcleo manda), a azul traz (o cartão devolve dados). Tela estreita usa o modo compacto.
function rede(st, cp) {
  const f = v => v.toFixed(1);
  const W = cp ? 560 : 1000, H = cp ? 300 : 380, cx = W / 2, cy = H / 2, R = cp ? 46 : 104, RR = R + (cp ? 30 : 40);
  const cw = cp ? 162 : 196, ch = cp ? 46 : 52;
  const nos = cp ? [
    { k: 'loja', t: 'Lojas', x: 90, y: 64 }, { k: 'cd', t: 'CD', x: 90, y: 236 }, { k: 'fin', t: 'Financeiro', x: 280, y: 28 },
    { k: 'sefaz', t: 'SEFAZ', x: 470, y: 64 }, { k: 'forn', t: 'Fornecedores', x: 470, y: 236 },
  ] : [
    { k: 'loja', t: 'Lojas', x: 122, y: 72 }, { k: 'cd', t: 'CD', x: 122, y: 308 }, { k: 'fin', t: 'Financeiro', x: 122, y: 190 },
    { k: 'sefaz', t: 'SEFAZ', x: 878, y: 112 }, { k: 'forn', t: 'Fornecedores', x: 878, y: 268 },
  ];
  nos.forEach(n => { n.s = st[{ loja: 'lojas', cd: 'cd', fin: 'fin', sefaz: 'sefaz', forn: 'forn' }[n.k]]; });
  const naBorda = (y, lado) => cx + lado * Math.sqrt(Math.max(RR * RR - (y - cy) ** 2, 0));
  // trilha de circuito: sai da borda, anda reto, dobra a 45° e segue reto até o cartão
  const trilha = (yAlvo, xFim, lado, off) => {
    const y0 = cy + (yAlvo - cy) * 0.5 + off, x0 = naBorda(y0, lado), xa = x0 + lado * 26, dy = yAlvo + off - y0;
    return [[x0, y0], [xa, y0], [xa + lado * Math.abs(dy), yAlvo + off], [xFim, yAlvo + off]];
  };
  const curva = (n, off) => {
    const ang = Math.atan2(n.y - cy, n.x - cx), bx = cx + Math.cos(ang) * RR + off, by = cy + Math.sin(ang) * RR;
    const ex = n.x + off, ey = n.y + (n.y < cy ? ch / 2 : -ch / 2) * (n.x === cx ? 1 : 0);
    return { c: true, p: [[bx, by], [n.x === cx ? bx : (bx + ex) / 2, n.x === cx ? (by + ey) / 2 : by], [n.x === cx ? ex : (bx + ex) / 2, n.x === cx ? (by + ey) / 2 : ey], [ex, ey]] };
  };
  const dPts = (o, rev) => { const p = rev ? [...o.p].reverse() : o.p; return o.c ? `M${f(p[0][0])} ${f(p[0][1])}C${p.slice(1).map(q => f(q[0]) + ' ' + f(q[1])).join(' ')}` : 'M' + p.map(q => f(q[0]) + ' ' + f(q[1])).join('L'); };
  const vias = n => {
    const lado = n.x < cx ? -1 : n.x > cx ? 1 : 0, borda = n.x - lado * cw / 2;
    if (cp) return [curva(n, -3), curva(n, 3)];
    return [{ p: trilha(n.y, borda, lado, -4) }, { p: trilha(n.y, borda, lado, 4) }];
  };
  // envios no ritmo do núcleo (batidas alternadas); o retorno vem entre uma batida e outra
  const atraso = i => (1.1 + (i % 2) * 2.2).toFixed(2) + 's', volta = i => (2.4 + (i % 2) * 2.2).toFixed(2) + 's';
  const feixe = (d, cls, dl) => `<path class="ig-beam${cls}" d="${d}" pathLength="100" filter="url(#igGlow)" style="animation-delay:${dl}"/><path class="ig-beam fio${cls}" d="${d}" pathLength="100" style="animation-delay:${dl}"/>`;
  const linhas = nos.map((n, i) => {
    const [vo, vi] = vias(n), dO = dPts(vo), dI = dPts(vi, true), fo = vo.p[3], fi = vi.p[3];
    return `<path class="ig-lane" d="${dO}"/><path class="ig-lane in" d="${dI}"/>
      <circle class="ig-pad" cx="${f(vo.p[0][0])}" cy="${f(vo.p[0][1])}" r="2.2"/><circle class="ig-pad in" cx="${f(vi.p[0][0])}" cy="${f(vi.p[0][1])}" r="2.2"/>
      <circle class="ig-pad" cx="${f(fo[0])}" cy="${f(fo[1])}" r="2.2"/><circle class="ig-pad in" cx="${f(fi[0])}" cy="${f(fi[1])}" r="2.2"/>
      ${feixe(dO, '', atraso(i))}${feixe(dI, ' in', volta(i))}`;
  }).join('');
  // trilhas decorativas entre os cartões, como numa placa de circuito
  const dec = cp ? '' : [[-1, 131], [-1, 249], [1, 34], [1, 190], [1, 346]].map(([lado, y], k) => {
    const pts = trilha(y, lado < 0 ? 26 : W - 26, lado, 0), d = 'M' + pts.map(q => f(q[0]) + ' ' + f(q[1])).join('L'), e = pts[3];
    const tr = [0, 1, 2, 3].map(j => `<rect x="${f(e[0] - lado * (18 + j * 7) - 1.5)}" y="${f(e[1] - 1)}" width="3" height="2" class="ig-dec-d" opacity="${(0.25 + j * 0.15).toFixed(2)}"/>`).join('');
    return `<path class="ig-dec" d="${d}"/><circle class="ig-dec-p" cx="${f(e[0])}" cy="${f(e[1])}" r="3"/>${tr}
      <circle r="1.6" class="ig-dec-d"><animateMotion dur="${(3 + k * 0.6).toFixed(1)}s" repeatCount="indefinite" begin="-${(k * 0.9).toFixed(1)}s" path="${d}"/></circle>`;
  }).join('');
  const caixas = nos.map((n, i) => {
    const x = n.x - cw / 2, y = n.y - ch / 2, ty = (ch - 30) / 2;
    return `<g class="ig-node"><rect x="${x}" y="${y}" width="${cw}" height="${ch}" rx="12" style="animation-delay:${atraso(i)}"/>
      <g class="ig-ic" transform="translate(${x + 12} ${y + ch / 2 - 9}) scale(.75)"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${IC[n.k]}</svg></g>
      <text x="${x + 40}" y="${y + ty + 12}">${n.t}</text><text class="ig-sub" x="${x + 40}" y="${y + ty + 27}">${n.s}</text>
      <circle class="ig-led" cx="${x + cw - 12}" cy="${y + 12}" r="3"/></g>`;
  }).join('');
  // esfera: neurônios espalhados (girassol), ligados aos vizinhos, cada um passeando num laço próprio
  const N = cp ? 24 : 48, P = [];
  for (let i = 0; i < N; i++) { const r = (R - (cp ? 6 : 10)) * Math.sqrt((i + 0.5) / N), a = i * 2.39996 + 0.4; P.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
  const E = [], vis = new Set();
  P.forEach((p, i) => {
    P.map((q, j) => [j, Math.hypot(p[0] - q[0], p[1] - q[1])]).filter(x => x[0] !== i).sort((x, y) => x[1] - y[1]).slice(0, 3)
      .forEach(([j]) => { const k = i < j ? i + '-' + j : j + '-' + i; if (!vis.has(k)) { vis.add(k); E.push([i, j]); } });
  });
  const amp = cp ? 0.6 : 1;
  const mov = P.map((p, i) => {
    const r = (3 + (i % 4) * 1.4) * amp, fase = i * 1.7, dur = (3.4 + (i % 5) * 0.9).toFixed(1), xs = [], ys = [];
    for (let k = 0; k <= 8; k++) { const t = fase + k * Math.PI / 4; xs.push(f(p[0] + Math.cos(t) * r)); ys.push(f(p[1] + Math.sin(t * 2) * r * 0.7)); }
    return { x: xs.join(';'), y: ys.join(';'), dur };
  });
  const an = (at, v, d) => `<animate attributeName="${at}" values="${v}" dur="${d}s" repeatCount="indefinite"/>`;
  const sin = E.map(([i, j]) => `<line class="ig-syn-l" x1="${f(P[i][0])}" y1="${f(P[i][1])}" x2="${f(P[j][0])}" y2="${f(P[j][1])}">${an('x1', mov[i].x, mov[i].dur)}${an('y1', mov[i].y, mov[i].dur)}${an('x2', mov[j].x, mov[j].dur)}${an('y2', mov[j].y, mov[j].dur)}</line>`).join('');
  const fogo = E.filter((_, k) => k % 3 === 0).map(([i, j], k) => `<circle r="1.7" class="ig-fire"><animateMotion dur="${(0.9 + (k % 4) * 0.25).toFixed(2)}s" repeatCount="indefinite" begin="-${(k * 0.29).toFixed(2)}s" path="M${f(P[i][0])} ${f(P[i][1])}L${f(P[j][0])} ${f(P[j][1])}"/></circle>`).join('');
  const neu = P.map((p, i) => `<circle class="ig-neu" cx="${f(p[0])}" cy="${f(p[1])}" r="${(1.4 + (i % 3) * 0.55).toFixed(1)}" style="animation-delay:${((i * 0.41) % 1.8).toFixed(2)}s">${an('cx', mov[i].x, mov[i].dur)}${an('cy', mov[i].y, mov[i].dur)}</circle>`).join('');
  const org = `transform-origin:${cx}px ${cy}px`;
  const halo = [0, 1, 2].map(k => `<circle class="ig-halo" cx="${cx}" cy="${cy}" r="${R}"><animate attributeName="r" values="${R};${RR + 50}" dur="3s" begin="-${k}s" repeatCount="indefinite"/><animate attributeName="opacity" values=".9;0" dur="3s" begin="-${k}s" repeatCount="indefinite"/></circle>`).join('');
  const k = cp ? 0.55 : 1;
  const B = `<defs><radialGradient id="igCoreG"><stop offset="0" stop-color="#ffe866" stop-opacity=".7"/><stop offset=".4" stop-color="#ffd60a" stop-opacity=".25"/><stop offset="1" stop-color="#ffd60a" stop-opacity="0"/></radialGradient>
    <radialGradient id="igEsfG"><stop offset="0" stop-color="#ffd60a" stop-opacity=".12"/><stop offset=".8" stop-color="#ffd60a" stop-opacity=".04"/><stop offset="1" stop-color="#ffd60a" stop-opacity=".1"/></radialGradient>
    <filter id="igGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
    <circle class="ig-ring r4" cx="${cx}" cy="${cy}" r="${f(R + 34 * k)}" style="${org}"/><circle class="ig-ring r3" cx="${cx}" cy="${cy}" r="${f(R + 26 * k)}" style="${org}"/>
    <circle class="ig-ring r2" cx="${cx}" cy="${cy}" r="${f(R + 17 * k)}" style="${org}"/><circle class="ig-ring r1" cx="${cx}" cy="${cy}" r="${f(R + 8 * k)}" style="${org}"/>
    <circle class="ig-esf" cx="${cx}" cy="${cy}" r="${R}"/>
    <circle class="ig-core" cx="${cx}" cy="${cy}" r="${f(R * 0.55)}" fill="url(#igCoreG)" style="${org}"/>
    <g filter="url(#igGlow)"><g class="ig-clu" style="${org}">${sin}${neu}${fogo}</g></g>`;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Núcleo da inteligência trocando dados com lojas, CD, financeiro, SEFAZ e fornecedores">
    ${halo}${dec}${linhas}${B}${caixas}</svg>`;
}
// desenha a rede no tamanho certo e redesenha só se a tela mudar de largo para estreito (ou o contrário)
function pintarRede(C, st) {
  const el = C.$('#igNet'); if (!el) return;
  G.st = st; const cp = el.clientWidth < 760; el.classList.toggle('cp', cp); G.cp = cp; el.innerHTML = rede(st, cp);
  if (!G.rz) { G.rz = true; addEventListener('resize', () => { const e = document.getElementById('igNet'); if (!e || !G.st) return; if ((e.clientWidth < 760) !== G.cp) pintarRede(C, G.st); }); }
}

// ---------------- carga ----------------
async function carregar(C) {
  const { sb, S } = C;
  const [b, e, p] = await Promise.all([
    sb.rpc('inteligencia_base', { p_empresa: S.emp.id, p_teste: false, p_tz: 'America/Fortaleza' }),
    sb.from('empresas').select('inteligencia').eq('id', S.emp.id).maybeSingle(),
    (async () => { const out = []; for (let de = 0; ; de += 1000) { const r = await sb.from('produtos').select('id,fator_embalagem').eq('empresa_id', S.emp.id).range(de, de + 999); if (r.error) return r; out.push(...r.data); if (r.data.length < 1000) return { data: out }; } })(),
  ]);
  if (b.error) throw b.error;
  const intel = e.data?.inteligencia || {};
  const fat = new Map((p.data || []).map(x => [x.id, x.fator_embalagem]));
  G.base = b.data; G.intel = intel; G.cfg = { ...CFG_PADRAO, ...(intel.cfg || {}), essenciais: intel.essenciais || [] };
  const cad = { locais: S.locais, produtos: S.produtos.map(x => ({ ...x, fator_embalagem: fat.get(x.id) })), precos: S.precos, sacEstoque: intel.sac_estoque || null };
  G.A = analisar(G.base, cad, G.cfg);
  // contadores reais das conexões (Financeiro, SEFAZ, Fornecedores)
  const [nf, cp] = await Promise.all([
    sb.from('nfe_recebidas').select('id', { count: 'exact', head: true }).eq('empresa_id', S.emp.id),
    sb.from('contas_pagar').select('id', { count: 'exact', head: true }).eq('empresa_id', S.emp.id),
  ]).catch(() => [{}, {}]);
  G.cont = { notas: nf?.count ?? null, contas: cp?.count ?? null };
}

// ---------------- tela ----------------
export async function telaInteligencia(C) {
  estilo();
  const { $, esc } = C, M = $('#main');
  clearInterval(G.timer);
  M.innerHTML = `<div class="head"><div><h1>Inteligência</h1><p>O cérebro do negócio: cruza vendas, estoque, compras e margem de todas as lojas e diz o que fazer.</p></div>
    <div class="row"><button class="btn sm" id="igCfg">${svg('cfg', 16)}Ajustes</button></div></div>
    <section class="ig-hero"><div class="ig-net" id="igNet"></div><div class="ig-feed"><div class="ig-feed-h"><b>Pensando agora</b><span class="ig-live"><i></i>ao vivo</span></div><div class="ig-pens"><i></i><i></i><i></i>Lendo vendas, estoque e notas…</div></div></section>
    <div id="igCorpo"></div>`;
  pintarRede(C, { lojas: '…', cd: '…', fin: '…', sefaz: '…', forn: '…' });
  $('#igCfg').onclick = () => ajustes(C);
  try { await carregar(C); }
  catch (e) { $('#igCorpo').innerHTML = `<p class="vazio">Não foi possível montar a inteligência: ${esc(e.message)}</p>`; return; }
  desenhar(C);
}

function desenhar(C) {
  const { $, esc, brl, bonito, S } = C, A = G.A, R = A.resumo;
  const nLojas = A.lojas.length, comDados = A.lojas.filter(l => A.infoLoja.has(l.id)).length;
  const cdSaldo = A.cd ? A.itensLoja.length && (R.fonteSac || true) : 0;
  const itensCD = (G.intel.sac_estoque?.itens || []).filter(x => x[0] === A.cd?.id && x[2] > 0).length + (G.base.saldos || []).filter(s => s.local_id === A.cd?.id && s.saldo > 0).length;
  pintarRede(C, {
    lojas: `${comDados} de ${nLojas} vendendo`,
    cd: itensCD ? `${nf(itensCD)} itens com saldo` : 'sem saldo ainda',
    fin: `${brl(R.bruto90).replace(/,\d\d$/, '')} em 90 dias`,
    sefaz: G.cont.notas != null ? `${nf(G.cont.notas)} notas lidas` : 'notas de compra',
    forn: A.compra.length ? `${A.compra.length} itens a pedir` : 'nada a pedir',
  });
  void cdSaldo;

  const ins = insights(A, brl, bonito);
  G.ins = ins;
  feed(C);

  const aviso = [];
  if (!R.lojasComDados) aviso.push('Ainda não há vendas para aprender. Assim que as lojas venderem pelo PagNow (ou o histórico for importado), as previsões aparecem aqui.');
  if (R.incerto.length) aviso.push(`Estoque sem controle em ${R.incerto.map(x => x.nome).join(', ')}: menos da metade dos produtos que vendem ali tem saldo positivo${R.fonteSac ? ' (foto do SAC Varejo, que só baixava as vendas)' : ''}. Nesses locais a previsão usa o ritmo de venda e avisa quando um produto para de vender de repente. Fica exata quando a loja começar a conferir o estoque pelo PagNow.`);
  else if (R.fonteSac) aviso.push(`Parte do estoque vem da foto do SAC Varejo de ${R.fonteSac.split('-').reverse().join('/')}. Saldo negativo no SAC conta como zero.`);
  if (R.semSaldo.length) aviso.push(`Sem saldo de estoque para: ${R.semSaldo.join(', ')}. Para essas lojas a previsão mostra só o ritmo de venda.`);

  $('#igCorpo').innerHTML = `${aviso.map(t => `<div class="ig-aviso">${svg('bad', 18)}<div>${esc(t)}</div></div>`).join('')}
    <div class="grid4 ig-kpi">
      <div class="kpi"><span>Em falta agora</span><b class="num" style="color:${R.falta ? 'var(--badt)' : 'inherit'}">${nf(R.falta)}</b><small>${R.falta ? `${R.sumiu ? `${nf(R.sumiu)} pararam de vender · ` : ''}~${brl(Math.round(R.perdaDia))} por dia` : 'nenhum produto que vende está zerado'}</small></div>
      <div class="kpi"><span>Acabam até o abastecimento</span><b class="num" style="color:${R.acaba ? 'var(--warnt)' : 'inherit'}">${nf(R.acaba)}</b><small>${R.acabaEssencial ? `${R.acabaEssencial} são "não pode faltar"` : `nos próximos ${A.cfg.ciclo_abastecimento} dias`}</small></div>
      <div class="kpi"><span>Pedido de compra sugerido</span><b class="num">${brl(Math.round(R.compraValor))}</b><small>${R.compraItens ? `${R.compraItens} produtos, ${R.compraUrgente} urgentes` : 'o CD está coberto'}</small></div>
      <div class="kpi"><span>Dinheiro parado</span><b class="num">${brl(Math.round(R.parado))}</b><small>${R.paradoItens ? `${R.paradoItens} itens sem venda há ${A.cfg.parado_dias}+ dias` : 'nenhum item parado'}</small></div>
    </div>
    <section class="card"><div class="row"><h2 style="font-size:17px">O que fazer hoje</h2><span class="sp"></span><span class="mu sm">${ins.length ? `${ins.length} ${ins.length === 1 ? 'ponto' : 'pontos'}, do mais urgente ao menos` : ''}</span></div>
      <div style="margin-top:6px">${ins.length ? ins.map((x, i) => `<div class="at ${x.nivel}"><span class="dot">${svg(x.nivel, 18)}</span><div class="tx"><b>${esc(x.titulo)}</b><p>${esc(x.texto)}</p></div><button class="btn sm${x.nivel === 'bad' ? ' pri' : ''}" data-ins="${i}">Ver</button></div>`).join('') : `<div class="tudo"><span class="dot">${svg('star', 18)}</span><div><b>Tudo em ordem</b><p class="mu sm">Nenhuma falta prevista, nada urgente para comprar.</p></div></div>`}</div></section>
    <div class="ig-tab"><div class="fnseg" id="igAbas">${ABAS.map(([k, t]) => `<button data-a="${k}" class="${G.aba === k ? 'on' : ''}">${t}</button>`).join('')}</div><span class="sp"></span><div id="igCtl" class="row"></div></div>
    <div id="igAba"></div>`;
  $('#igCorpo').querySelectorAll('[data-ins]').forEach(b => b.onclick = () => irPara(C, ins[+b.dataset.ins]));
  $('#igAbas').querySelectorAll('button').forEach(b => b.onclick = () => { G.aba = b.dataset.a; desenhar(C); });
  aba(C);
}

function irPara(C, x) {
  if (!x) return;
  const mapa = { loja: 'loja', falta: 'loja', compra: 'compra', minmax: 'minmax', parado: 'parado', margem: 'margem' };
  G.aba = mapa[x.ir] || 'loja';
  if (x.loja) G.loja = x.loja;
  if (x.ir === 'falta' || x.ir === 'loja') G.filtro = 'atencao';
  desenhar(C);
  C.$('#igAbas')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------- "Pensando agora": escreve um insight por vez ----------------
function feed(C) {
  const { $, esc } = C, el = $('.ig-feed');
  if (!el) return;
  clearInterval(G.timer);
  const ins = G.ins, R = G.A.resumo;
  const stat = `Analisou ${nf(R.vendas90)} itens vendidos em ${R.lojasComDados} ${R.lojasComDados === 1 ? 'loja' : 'lojas'} (${Math.min(90, R.diasRede)} dias) · atualizado ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  if (!ins.length) {
    el.innerHTML = `<div class="ig-feed-h"><b>Pensando agora</b><span class="ig-live"><i></i>ao vivo</span></div><div class="ig-now"><div class="ig-k info">${svg('star', 14)}Tudo certo</div><h3>Nada urgente por aqui.</h3><p>Sigo de olho nas vendas e no estoque de cada loja.</p></div><div class="ig-stat">${esc(stat)}</div>`;
    return;
  }
  const rot = { bad: 'Atenção', warn: 'Faça logo', info: 'Oportunidade' };
  el.innerHTML = `<div class="ig-feed-h"><b>Pensando agora</b><span class="ig-live"><i></i>ao vivo</span><span class="sp"></span><span class="mu sm" id="igPos"></span></div>
    <div class="ig-now" id="igNow"></div><div class="ig-hist" id="igHist"></div><div class="ig-stat">${esc(stat)}</div>`;
  const now = $('#igNow'), hist = $('#igHist'), pos = $('#igPos');
  let i = G.feedI % ins.length, tTyping = null;
  const mostra = () => {
    const x = ins[i];
    now.onclick = () => irPara(C, x);
    now.innerHTML = `<div class="ig-k ${x.nivel}">${svg(x.nivel, 14)}${rot[x.nivel]}</div><h3><span id="igTit"></span><span class="ig-car"></span></h3><p id="igTx" style="opacity:0;transition:opacity .4s">${esc(x.texto)}</p>`;
    const tit = now.querySelector('#igTit'), alvo = x.titulo, reduz = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let k = reduz ? alvo.length : 0;
    clearInterval(tTyping);
    const passo = () => { tit.textContent = alvo.slice(0, k); if (k >= alvo.length) { clearInterval(tTyping); const tx = now.querySelector('#igTx'); if (tx) tx.style.opacity = 1; } k += 2; };
    passo(); if (!reduz) tTyping = setInterval(passo, 22);
    pos.textContent = `${i + 1} de ${ins.length}`;
    const prox = [1, 2, 3].map(d => ins[(i + d) % ins.length]).filter((v, j, a) => ins.length > j + 1 && a.indexOf(v) === j);
    hist.innerHTML = prox.map(y => `<button data-h="${ins.indexOf(y)}"><i class="ig-b ${y.nivel}"></i><span>${esc(y.titulo)}</span></button>`).join('');
    hist.querySelectorAll('[data-h]').forEach(b => b.onclick = () => { i = +b.dataset.h; G.feedI = i; mostra(); reinicia(); });
  };
  const reinicia = () => { clearInterval(G.timer); G.timer = setInterval(() => { if (!document.body.contains(now)) { clearInterval(G.timer); clearInterval(tTyping); return; } i = (i + 1) % ins.length; G.feedI = i; mostra(); }, 6500); };
  mostra(); reinicia();
}

// ---------------- abas ----------------
function aba(C) {
  const f = { loja: abaLoja, compra: abaCompra, minmax: abaMinmax, essencial: abaEssencial, parado: abaParado, margem: abaMargem }[G.aba];
  C.$('#igCtl').innerHTML = '';
  f(C);
}
const nomeP = (C, p, ess) => `<span class="ig-pn">${ess ? `<span class="ig-st" title="Não pode faltar">${svg('star', 14)}</span>` : ''}<b>${C.esc(C.bonito(p.nome))}</b></span>`;
const vazio = (t) => `<tr><td colspan="9" class="vazio">${t}</td></tr>`;

function abaLoja(C) {
  const { $, esc } = C, A = G.A;
  if (!A.lojas.some(l => l.id === G.loja)) G.loja = (A.lojas.find(l => A.infoLoja.has(l.id)) || A.lojas[0])?.id || '';
  $('#igCtl').innerHTML = `<select id="igLoja" style="width:240px">${A.lojas.map(l => `<option value="${l.id}" ${l.id === G.loja ? 'selected' : ''}>${esc(l.nome)}</option>`).join('')}</select>
    <div class="fnseg fnseg-s" id="igFil">${[['atencao', 'Atenção'], ['vende', 'Com venda'], ['todos', 'Todos']].map(([k, t]) => `<button data-f="${k}" class="${G.filtro === k ? 'on' : ''}">${t}</button>`).join('')}</div>`;
  $('#igLoja').onchange = e => { G.loja = e.target.value; aba(C); };
  $('#igFil').querySelectorAll('button').forEach(b => b.onclick = () => { G.filtro = b.dataset.f; aba(C); });
  let L = A.itensLoja.filter(x => x.loja.id === G.loja);
  if (G.filtro === 'atencao') L = L.filter(x => x.status === 'falta' || x.status === 'sumiu' || x.status === 'acaba');
  else if (G.filtro === 'vende') L = L.filter(x => x.r > 0);
  const ord = { falta: 0, sumiu: 0, acaba: 1, ok: 2, sem_saldo: 3, parado: 4 };
  L.sort((a, b) => (ord[a.status] - ord[b.status]) || ((a.dias ?? 999) - (b.dias ?? 999)) || (b.r - a.r));
  const info = A.infoLoja.get(G.loja);
  $('#igAba').innerHTML = `<div class="tblwrap"><table class="tbl ig-tbl"><thead><tr><th>Produto</th><th class="n">Vende</th><th class="n">Tem</th><th class="n">Acaba</th><th class="n">Levar</th><th class="n ig-hm">Máx.</th></tr></thead><tbody>
    ${L.slice(0, 300).map(x => `<tr class="${x.status === 'falta' || x.status === 'sumiu' ? 'ig-x' : x.status === 'acaba' ? 'ig-w' : ''}"><td>${nomeP(C, x.p, x.essencial)}</td>
      <td class="n num">${x.status === 'sumiu' ? `<span class="mu">era ${ritmoTxt(x.rPrev)}</span>` : ritmoTxt(x.r)}</td><td class="n num">${x.saldo == null ? '<span class="mu">—</span>' : nf(x.saldo)}${x.negativo ? ' <span class="ig-tag" title="Negativo no SAC">SAC −</span>' : ''}</td>
      <td class="n">${x.status === 'sumiu' ? '<b style="color:var(--badt)" title="Vendia e não vendeu nada nos últimos 7 dias">parou de vender</b>' : x.status === 'falta' ? '<b style="color:var(--badt)">em falta</b>' : x.r > 0 && x.saldo != null ? `<span style="color:${x.status === 'acaba' ? 'var(--warnt)' : 'inherit'};font-weight:${x.status === 'acaba' ? 700 : 400}">${quandoTxt(x.dias, A.hoje)}</span>` : '<span class="mu">—</span>'}</td>
      <td class="n num">${x.levar ? '<b>' + nf(x.levar) + '</b>' : '<span class="mu">—</span>'}</td><td class="n num ig-hm">${x.max || '<span class="mu">—</span>'}</td></tr>`).join('') || vazio(G.filtro === 'atencao' ? 'Nada em falta nem acabando nesta loja.' : 'Nenhum produto neste filtro.')}
    </tbody></table></div>
    <p class="mu sm" style="margin-top:10px">${info ? `Ritmo calculado com ${info.dias} dias de vendas, pesando mais a última semana${info.dias >= 28 ? ' e o dia da semana' : ''}.` : 'Esta loja ainda não tem vendas registradas.'} ${A.confianca.get(G.loja)?.ok === false ? `Estoque desta loja sem controle: "Levar" repõe o que vende em ${A.cfg.ciclo_abastecimento} dias.` : `"Levar" completa até o máximo ou até cobrir ${A.cfg.ciclo_abastecimento + A.cfg.seguranca} dias, o que for maior.`}</p>`;
}

function abaCompra(C) {
  const { $, brl } = C, A = G.A, L = A.compra;
  $('#igCtl').innerHTML = L.length ? `<button class="btn sm" id="igCopiar">Copiar pedido</button>` : '';
  const tot = L.reduce((s, x) => s + x.valor, 0);
  $('#igAba').innerHTML = `<div class="tblwrap"><table class="tbl ig-tbl"><thead><tr><th>Produto</th><th class="n">Rede vende</th><th class="n">CD tem</th><th class="n">Cobre</th><th class="n">Comprar</th><th class="n ig-hm">Custo</th><th class="n">Valor</th></tr></thead><tbody>
    ${L.map(x => `<tr class="${x.urgente ? 'ig-w' : ''}"><td>${nomeP(C, x.p, x.essencial)}${x.fornecedor ? `<div class="ig-why">${C.esc(x.fornecedor)}</div>` : ''}</td><td class="n num">${ritmoTxt(x.r)}</td><td class="n num">${nf(x.saldoCD)}</td>
      <td class="n">${x.saldoCD <= 0 ? '<b style="color:var(--badt)">zerado</b>' : x.cobre > 120 ? '+4 meses' : x.cobre + ' dias'}</td>
      <td class="n num"><b>${nf(x.qtd)}</b>${x.fator > 1 ? ` <span class="mu">(${nf(x.caixas)} cx)</span>` : ''}</td><td class="n num ig-hm">${x.custo ? brl(x.custo) : '<span class="mu">sem custo</span>'}</td><td class="n num">${brl(Math.round(x.valor))}</td></tr>`).join('') || vazio('O CD cobre a venda das lojas até a próxima compra. Nada a pedir.')}
    ${L.length ? `<tr class="ig-tot"><td colspan="6">Total do pedido</td><td class="n num">${brl(Math.round(tot))}</td></tr>` : ''}</tbody></table></div>
    <p class="mu sm" style="margin-top:10px">Compra para cobrir ${A.cfg.prazo_fornecedor} dias de entrega + ${A.cfg.ciclo_compra} dias até a próxima compra + ${A.cfg.seguranca} de folga, já descontando o que o CD tem. Arredonda para caixa fechada quando o produto tem embalagem cadastrada. Mude os prazos em Ajustes.</p>`;
  const cp = $('#igCopiar');
  if (cp) cp.onclick = async () => {
    const t = 'Pedido sugerido\n' + L.map(x => `${C.bonito(x.p.nome)}: ${nf(x.qtd)}${x.fator > 1 ? ` (${nf(x.caixas)} cx)` : ''}`).join('\n') + `\nTotal estimado: ${brl(Math.round(tot))}`;
    try { await navigator.clipboard.writeText(t); C.toast('Pedido copiado'); } catch (e) { C.toast('Não foi possível copiar'); }
  };
}

function abaMinmax(C) {
  const { $, esc, sb } = C, A = G.A, L = A.ajustes.slice().sort((a, b) => a.loja.nome.localeCompare(b.loja.nome) || b.r - a.r);
  $('#igCtl').innerHTML = L.length ? `<button class="btn sm pri" id="igAplicar">Aplicar sugestões</button>` : '';
  const rot = { subir: 'Falta antes do abastecimento', descer: 'Sobra por mais de um mês', definir: 'Vende e não tem padrão' };
  $('#igAba').innerHTML = `<div class="tblwrap"><table class="tbl ig-tbl"><thead><tr><th>Produto</th><th>Loja</th><th class="n">Vende</th><th class="n">Máx. atual</th><th class="n">Sugerido</th><th class="ig-hm">Por quê</th></tr></thead><tbody>
    ${L.map(x => `<tr><td>${nomeP(C, x.p, x.essencial)}</td><td>${esc(x.loja.nome)}</td><td class="n num">${ritmoTxt(x.r)}</td><td class="n num">${x.ajuste.de || '—'}</td><td class="n num"><b style="color:${x.ajuste.tipo === 'descer' ? 'var(--newt)' : 'var(--warnt)'}">${x.ajuste.para}</b></td><td class="ig-hm mu sm">${rot[x.ajuste.tipo]}</td></tr>`).join('') || vazio('Os mínimos e máximos estão de acordo com o que cada loja vende.')}
    </tbody></table></div><p class="mu sm" style="margin-top:10px">É aqui que a inteligência aprende: compara o máximo de cada loja com o ritmo real de venda. Aplicar muda só o máximo (o mínimo continua o seu, ou vai para metade do novo máximo se ficar maior que ele).</p>`;
  const ap = $('#igAplicar');
  if (ap) ap.onclick = async () => {
    if (!confirm(`Aplicar ${L.length} sugestões de máximo nas lojas?`)) return;
    ap.disabled = true; ap.textContent = 'Aplicando…';
    const porLoja = new Map();
    for (const x of L) { const mn = x.min > x.ajuste.para ? Math.floor(x.ajuste.para / 2) : x.min; (porLoja.get(x.loja.id) ?? porLoja.set(x.loja.id, []).get(x.loja.id)).push({ produto_id: x.p.id, min: mn, max: x.ajuste.para }); }
    let ok = 0;
    for (const [loja, itens] of porLoja) { const r = await sb.rpc('salvar_minmax', { p_local: loja, p_itens: itens }); if (r.error) { C.toast('Erro: ' + r.error.message); break; } ok += itens.length; }
    try { await C.carregar(); } catch (_) {}
    C.toast(`${ok} máximos ajustados`);
    G.A = null; telaInteligencia(C);
  };
}

function abaEssencial(C) {
  const { $, esc } = C, A = G.A;
  const L = [...A.essencial.entries()].map(([id, motivos]) => {
    const it = A.itensLoja.filter(x => x.p.id === id);
    return { p: it[0]?.p || C.S.produtos.find(p => p.id === id), motivos, falta: it.filter(x => x.status === 'falta' || x.status === 'sumiu').length, acaba: it.filter(x => x.status === 'acaba').length, lojas: it.length, abc: A.abc.get(id), mao: (G.cfg.essenciais || []).includes(id) };
  }).filter(x => x.p).sort((a, b) => (b.falta - a.falta) || (b.acaba - a.acaba) || (a.abc || 'Z').localeCompare(b.abc || 'Z'));
  $('#igCtl').innerHTML = `<button class="btn sm" id="igMarcar">Marcar produto</button>`;
  $('#igAba').innerHTML = `<div class="tblwrap"><table class="tbl ig-tbl"><thead><tr><th>Produto</th><th class="ig-hm">Por quê</th><th class="n">Lojas</th><th class="n">Em falta</th><th class="n">Acabando</th><th></th></tr></thead><tbody>
    ${L.map(x => `<tr class="${x.falta ? 'ig-x' : x.acaba ? 'ig-w' : ''}"><td>${nomeP(C, x.p, true)}${x.abc === 'A' ? '<span class="ig-tag a">Curva A</span>' : ''}</td><td class="ig-hm ig-why">${esc(x.motivos.join(' · '))}</td><td class="n num">${x.lojas}</td>
      <td class="n num">${x.falta ? `<b style="color:var(--badt)">${x.falta}</b>` : '0'}</td><td class="n num">${x.acaba ? `<b style="color:var(--warnt)">${x.acaba}</b>` : '0'}</td>
      <td class="n">${x.mao ? `<button class="lnk" data-tira="${x.p.id}">Desmarcar</button>` : ''}</td></tr>`).join('') || vazio('Ainda não há vendas para saber quais produtos não podem faltar.')}
    </tbody></table></div><p class="mu sm" style="margin-top:10px">Entram sozinhos os produtos da curva A (somam 80% do faturamento) e os que vendem quase todo dia. Você pode marcar outros.</p>`;
  $('#igAba').querySelectorAll('[data-tira]').forEach(b => b.onclick = () => salvarEssenciais(C, (G.cfg.essenciais || []).filter(id => id !== b.dataset.tira)));
  $('#igMarcar').onclick = () => {
    C.modal(`<h2>Marcar "não pode faltar"</h2><label class="f">Produto<input id="igBusca" placeholder="Digite o nome ou o código de barras" autocomplete="off"></label><div id="igRes" style="max-height:300px;overflow:auto"></div><div class="row"><span class="sp"></span><button class="btn" data-close>Fechar</button></div>`);
    const res = $('#igRes');
    $('#igBusca').oninput = e => {
      const q = e.target.value.trim().toLowerCase();
      const r = q.length < 2 ? [] : C.S.produtos.filter(p => p.ativo !== false && (p.nome.toLowerCase().includes(q) || (p.ean || '').includes(q))).slice(0, 30);
      res.innerHTML = r.map(p => `<div class="at"><div class="tx"><b>${esc(C.bonito(p.nome))}</b><p>${esc(p.ean || '')}</p></div><button class="btn sm" data-m="${p.id}">Marcar</button></div>`).join('');
      res.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { C.fechar(); salvarEssenciais(C, [...new Set([...(G.cfg.essenciais || []), b.dataset.m])]); });
    };
    $('#igBusca').focus();
  };
}

async function salvarIntel(C, novo) {
  const { sb, S } = C;
  const { data: atual } = await sb.from('empresas').select('inteligencia').eq('id', S.emp.id).maybeSingle();
  const r = await sb.from('empresas').update({ inteligencia: { ...(atual?.inteligencia || {}), ...novo } }).eq('id', S.emp.id).select('id');
  if (r.error || !r.data?.length) throw new Error(r.error?.message || 'sem permissão (só dono ou gerente)');
}
async function salvarEssenciais(C, lista) {
  try { await salvarIntel(C, { essenciais: lista }); C.toast('Salvo'); G.aba = 'essencial'; telaInteligencia(C); }
  catch (e) { C.toast('Não foi possível salvar: ' + e.message); }
}

function abaParado(C) {
  const { $, esc, brl } = C, A = G.A;
  const L = A.parados.slice().sort((a, b) => b.preso - a.preso), S2 = A.semVendaRede;
  $('#igAba').innerHTML = `<section class="card" style="margin-bottom:16px"><h2 style="font-size:17px">Candidatos a sair do portfólio</h2><p class="mu sm" style="margin:2px 0 8px">Não venderam em nenhuma loja nos últimos ${Math.min(90, A.resumo.diasRede)} dias.</p>
    <div class="tblwrap"><table class="tbl ig-tbl"><thead><tr><th>Produto</th><th class="n">No mix de</th><th class="n">Estoque</th><th class="n">Dinheiro parado</th></tr></thead><tbody>
    ${S2.slice(0, 200).map(x => `<tr><td>${nomeP(C, x.p)}</td><td class="n num">${x.lojas} ${x.lojas === 1 ? 'loja' : 'lojas'}</td><td class="n num">${nf(x.saldo)}</td><td class="n num">${x.preso ? brl(Math.round(x.preso)) : '<span class="mu">—</span>'}</td></tr>`).join('') || vazio(A.resumo.diasRede < A.cfg.parado_dias ? `Precisa de ${A.cfg.parado_dias} dias de vendas para julgar.` : 'Todo produto do mix vendeu em alguma loja.')}
    </tbody></table></div></section>
    <section class="card"><h2 style="font-size:17px">Parados na prateleira</h2><p class="mu sm" style="margin:2px 0 8px">Têm estoque na loja e não vendem há ${A.cfg.parado_dias} dias ou mais. Se vendem bem em outra loja, vale transferir.</p>
    <div class="tblwrap"><table class="tbl ig-tbl"><thead><tr><th>Produto</th><th>Loja</th><th class="n">Tem</th><th class="n">Parado</th><th class="ig-hm">Vende em</th></tr></thead><tbody>
    ${L.slice(0, 300).map(x => { const outras = A.itensLoja.filter(y => y.p.id === x.p.id && y.r > 0).map(y => y.loja.nome); return `<tr><td>${nomeP(C, x.p)}</td><td>${esc(x.loja.nome)}</td><td class="n num">${nf(x.saldo)}</td><td class="n num">${brl(Math.round(x.preso))}</td><td class="ig-hm ig-why">${outras.length ? esc(outras.slice(0, 3).join(', ')) + (outras.length > 3 ? '…' : '') : 'nenhuma loja'}</td></tr>`; }).join('') || vazio('Nenhum produto parado.')}
    </tbody></table></div></section>`;
}

function abaMargem(C) {
  const { $, brl } = C, A = G.A, L = A.margemBaixa;
  $('#igAba').innerHTML = `<div class="tblwrap"><table class="tbl ig-tbl"><thead><tr><th>Produto</th><th class="n">Custo</th><th class="n">Preço médio</th><th class="n">Margem</th><th class="n ig-hm">Vendeu (90 dias)</th></tr></thead><tbody>
    ${L.map(x => `<tr><td>${nomeP(C, x.p, true)}</td><td class="n num">${brl(x.custo)}</td><td class="n num">${brl(Math.round(x.preco))}</td><td class="n num"><b class="mg ${x.margem < 0.2 ? 'baixa' : 'media'}">${nf(x.margem * 100, 1)}%</b></td><td class="n num ig-hm">${brl(x.bruto)}</td></tr>`).join('') || vazio(`Os produtos que mais vendem estão com margem acima de ${A.cfg.margem_alvo}%.`)}
    </tbody></table></div><p class="mu sm" style="margin-top:10px">Mostra os produtos da curva A com margem abaixo da sua meta (${A.cfg.margem_alvo}%). Custo da última nota lançada no PagNow; sem nota, o custo do cadastro. A próxima etapa traz alta de custo sem reajuste, fornecedor mais barato e mix por loja.</p>`;
}

// ---------------- ajustes ----------------
function ajustes(C) {
  const c = G.cfg || CFG_PADRAO;
  const campo = (k, t, d) => `<label class="f">${t}<input type="number" min="0" max="365" step="1" data-k="${k}" value="${c[k]}"><span class="mu sm">${d}</span></label>`;
  C.modal(`<h2>Ajustes da inteligência</h2><p class="mu sm">Prazos que a inteligência usa para prever falta e sugerir compra.</p>
    <div class="ig-cfg">${campo('ciclo_abastecimento', 'Dias entre abastecimentos', 'De quantos em quantos dias cada loja recebe mercadoria.')}${campo('prazo_fornecedor', 'Prazo de entrega (dias)', 'Do pedido até a mercadoria chegar no CD.')}
    ${campo('ciclo_compra', 'Dias entre compras', 'De quantos em quantos dias você faz pedido.')}${campo('seguranca', 'Dias de folga', 'Margem para atraso ou venda acima do normal.')}
    ${campo('parado_dias', 'Parado depois de (dias)', 'Sem venda por esse tempo, o item conta como parado.')}${campo('margem_alvo', 'Meta de margem (%)', 'Abaixo disso o produto aparece em Margem.')}</div>
    <div class="row"><span class="sp"></span><button class="btn" data-close>Cancelar</button><button class="btn pri" id="igSalvarCfg">Salvar</button></div>`);
  C.$('#igSalvarCfg').onclick = async () => {
    const novo = {};
    document.querySelectorAll('#mbox [data-k]').forEach(i => { const v = Math.max(0, Math.min(365, Math.round(+i.value || 0))); novo[i.dataset.k] = v; });
    try { await salvarIntel(C, { cfg: novo }); C.fechar(); C.toast('Ajustes salvos'); telaInteligencia(C); }
    catch (e) { C.toast('Não foi possível salvar: ' + e.message); }
  };
}
