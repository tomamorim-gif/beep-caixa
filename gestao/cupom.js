// Cupom fiscal (NFC-e) de compra feita no varejo: atacarejo, supermercado.
// 1. lerDanfe: lê os itens do DANFE que o site da SEFAZ-CE devolve (HTML), no mesmo formato da NF-e do painel.
// 2. sugestoes: quando o cupom não traz código de barras, acha no cadastro o produto de nome parecido
//    (o dono confirma; o vínculo fica gravado para as próximas compras no mesmo fornecedor).
// 3. lerQr: leitor do QR code do cupom pela câmera ou por uma foto.

// ---------- código de barras ----------
export function gtinOk(c) {
  c = String(c || '');
  if (!/^(\d{8}|\d{12,14})$/.test(c) || /^0+$/.test(c)) return false;
  const d = c.split('').reverse().map(Number); let s = 0;
  for (let i = 1; i < d.length; i++) s += d[i] * (i % 2 ? 3 : 1);
  return (10 - s % 10) % 10 === d[0];
}

// ---------- DANFE (HTML do site da SEFAZ) ----------
const limpa = t => String(t ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
// "1.234,56" -> 1234.56 · "0,764" -> 0.764 · "3" -> 3
export function numBr(t) {
  let s = String(t ?? '').replace(/[^\d,.\-]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s); return Number.isFinite(n) ? n : null;
}
// texto do span sem o rótulo em <strong> ("Qtde.:", "UN:", "Vl. Unit.:")
const semRotulo = el => { if (!el) return ''; const c = el.cloneNode(true); c.querySelectorAll('strong,b').forEach(x => x.remove()); return limpa(c.textContent).replace(/^[A-Za-z. ]+:\s*/, ''); };

// unidades por embalagem quando o cupom vende caixa/fardo: "CX C/12", "FD 12X350ML", "DZ"
export function fatorEmbalagem(uCom, desc) {
  const u = String(uCom || '').toUpperCase();
  if (/^DZ/.test(u)) return 12;
  if (!/^(CX|FD|FAR|DP|PAC|PCT|PC|KIT)/.test(u)) return 1;
  const d = String(desc || '').toUpperCase();
  const m = d.match(/\bC\/\s?(\d{1,3})\b/) || d.match(/\b(\d{1,3})\s?X\s?\d/) || d.match(/\b(\d{1,3})\s?(?:UN|UND|UNID)\b/);
  const n = m ? +m[1] : 1;
  return n >= 2 && n <= 200 ? n : 1;
}

export function lerDanfe(html, chave, parser = new DOMParser()) {
  const doc = parser.parseFromString(`<div id="raiz">${html}</div>`, 'text/html');
  const tab = doc.querySelector('#tabResult');
  if (!tab) throw new Error('A SEFAZ devolveu o cupom sem a lista de itens. Tente de novo.');
  const linhas = [...tab.querySelectorAll('tr')].filter(tr => tr.querySelector('.txtTit') && tr.querySelector('.valor'));
  if (!linhas.length) throw new Error('O cupom não tem itens.');
  const centavos = v => Math.round((v || 0) * 100);
  const itens = linhas.map((tr, i) => {
    const desc = limpa(tr.querySelector('.txtTit')?.textContent);
    const cod = (limpa(tr.querySelector('.RCod')?.textContent).match(/c[óo]digo:\s*([^\s)]+)/i) || [])[1] || '';
    const qCom = numBr(semRotulo(tr.querySelector('.Rqtd'))) || 1;
    const uCom = (semRotulo(tr.querySelector('.RUN')) || 'UN').toUpperCase().slice(0, 6);
    const total = numBr(tr.querySelector('.valor')?.textContent);
    if (total == null) throw new Error(`Não consegui ler o valor do item "${desc}"`);
    const codigo = cod.replace(/[^\w.\-]/g, '').slice(0, 60) || String(i + 1);
    const ean = gtinOk(codigo) ? codigo : null;
    return { nItem: i + 1, codigo, ean, eanUn: null, desc, ncm: '', cest: null, cfop: '', icmsCst: '', st: false, pisCst: '',
      uCom, qCom, fator: fatorEmbalagem(uCom, desc), valorItem: centavos(total) };
  });

  // totais: o desconto do cupom é repartido entre os itens, para o custo ser o que foi pago de fato
  const tot = {};
  doc.querySelectorAll('#totalNota > div, #totalNota div').forEach(d => {
    const lb = limpa(d.querySelector('label')?.textContent).replace(/:$/, '').toLowerCase();
    const v = numBr(d.querySelector('.totalNumb')?.textContent);
    if (lb && v != null && !(lb in tot)) tot[lb] = v;
  });
  const soma = itens.reduce((s, it) => s + it.valorItem, 0);
  const desconto = Math.max(0, centavos(tot['descontos r$'] || 0));
  const aPagar = tot['valor a pagar r$'] != null ? centavos(tot['valor a pagar r$']) : soma - desconto;
  let resto = desconto > 0 && desconto < soma ? desconto : 0;
  if (resto) {
    const ordem = [...itens].sort((a, b) => b.valorItem - a.valorItem); let dado = 0;
    itens.forEach(it => { it.desconto = Math.floor(desconto * it.valorItem / soma); dado += it.desconto });
    for (let k = 0; dado < desconto; k++) { ordem[k % ordem.length].desconto++; dado++ }
  }
  itens.forEach(it => {
    it.custoTotal = it.valorItem - (it.desconto || 0);
    const un = it.qCom * it.fator; it.custoUn = un > 0 ? Math.round(it.custoTotal / un) : it.custoTotal;
  });

  // emitente e dados do cupom
  const topo = limpa(doc.querySelector('.txtTopo, #u20')?.textContent);
  const textos = [...doc.querySelectorAll('.txtCenter .text, .txtCenter div')].map(e => limpa(e.textContent));
  const cnpj = (textos.find(t => /^CNPJ/i.test(t)) || '').replace(/\D/g, '').slice(0, 14);
  const infos = limpa(doc.querySelector('#infos')?.textContent || doc.body.textContent);
  const numero = (infos.match(/N[úu]mero:\s*(\d+)/i) || [])[1] || String(+chave.slice(25, 34));
  const serie = (infos.match(/S[ée]rie:\s*(\d+)/i) || [])[1] || String(+chave.slice(22, 25));
  const em = infos.match(/Emiss[ãa]o:\s*(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}:\d{2}(?::\d{2})?)/i);
  const emissao = em ? `${em[3]}-${em[2]}-${em[1]}T${em[4].length === 5 ? em[4] + ':00' : em[4]}-03:00` : null;
  const chaveHtml = limpa(doc.querySelector('.chave')?.textContent).replace(/\D/g, '');
  if (chaveHtml && chaveHtml.length === 44 && chaveHtml !== chave) throw new Error('A SEFAZ devolveu outro cupom. Leia o QR code de novo.');
  const fornCnpj = cnpj || chave.slice(6, 20);
  const avisos = [];
  if (tot['qtd. total de itens'] != null && Math.round(tot['qtd. total de itens']) !== itens.length) avisos.push(`O cupom diz ${Math.round(tot['qtd. total de itens'])} itens e foram lidos ${itens.length}. Confira com o cupom em mãos.`);
  return { tipo: 'cupom', chave, numero, serie, emissao, fornCnpj, fornNome: topo || 'Fornecedor ' + fornCnpj, destCnpj: '', total: aPagar, desconto, itens, avisos, xml: html };
}

// ---------- equivalência pelo nome ----------
const PARADAS = new Set('de da do das dos com sem c e em p para tipo sabor un und unid pct pc cx fd emb bdj tp pt gfa gf lt'.split(' '));
const ABREV = { refrig: 'refrigerante', refri: 'refrigerante', ref: 'refrigerante', bisc: 'biscoito', bisct: 'biscoito', choc: 'chocolate', chocol: 'chocolate', achoc: 'achocolatado', cerv: 'cerveja', cer: 'cerveja', agua: 'agua', ag: 'agua', min: 'mineral', s: 'sem', gas: 'gas', leit: 'leite', lt: 'lata', lat: 'lata', pet: 'pet', sab: 'sabonete', deterg: 'detergente', det: 'detergente', amac: 'amaciante', desod: 'desodorante', marg: 'margarina', mant: 'manteiga', iog: 'iogurte', sorv: 'sorvete', salg: 'salgadinho', frang: 'frango', past: 'pasta', dent: 'dental', papel: 'papel', hig: 'higienico', energ: 'energetico', suco: 'suco', nect: 'nectar', integ: 'integral', desn: 'desnatado', trad: 'tradicional', orig: 'original', zero: 'zero', cx: 'caixa' };
const semAcento = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
// "REFRIG COCA COLA PET 2LT" -> {palavras:[refrigerante,coca,cola,pet], medidas:['2000ml']}
export function termos(t) {
  let s = semAcento(t).toLowerCase().replace(/(\d),(\d)/g, '$1.$2');
  s = s.replace(/(\d)\s*(lts?|litros?|l)\b/g, '$1l').replace(/(\d)\s*(mls?)\b/g, '$1ml').replace(/(\d)\s*(kgs?|kilos?|quilos?)\b/g, '$1kg').replace(/(\d)\s*(grs?|gramas?|g)\b/g, '$1g');
  const palavras = [], medidas = [];
  for (const w of s.split(/[^a-z0-9.]+/)) {
    if (!w) continue;
    const m = w.match(/^(\d+(?:\.\d+)?)(ml|l|g|kg)$/);
    if (m) { const v = +m[1] * (m[2] === 'l' || m[2] === 'kg' ? 1000 : 1); medidas.push(Math.round(v) + (m[2] === 'l' || m[2] === 'ml' ? 'ml' : 'g')); continue }
    if (/^\d/.test(w) || PARADAS.has(w) || w.length < 2) continue;
    palavras.push(ABREV[w] || w);
  }
  return { palavras, medidas };
}
const casa = (a, b) => a === b || (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a)));
export function parecido(a, b) {
  const A = typeof a === 'string' ? termos(a) : a, B = typeof b === 'string' ? termos(b) : b;
  if (!A.palavras.length || !B.palavras.length) return 0;
  const usados = new Set(); let iguais = 0;
  for (const x of A.palavras) { const j = B.palavras.findIndex((y, k) => !usados.has(k) && casa(x, y)); if (j >= 0) { usados.add(j); iguais++ } }
  let s = 2 * iguais / (A.palavras.length + B.palavras.length);
  // a primeira palavra costuma ser o tipo do produto (refrigerante, biscoito): peso extra
  if (casa(A.palavras[0], B.palavras[0])) s += 0.1;
  if (A.medidas.length && B.medidas.length) s = A.medidas.some(m => B.medidas.includes(m)) ? s + 0.2 : s * 0.45;
  return Math.min(1, s);
}
// melhores candidatos do cadastro para a descrição do cupom
export function sugestoes(desc, produtos, n = 3, minimo = 0.5) {
  const A = termos(desc), out = [];
  for (const p of produtos) {
    if (p.ativo === false) continue;
    if (!p._t) Object.defineProperty(p, '_t', { value: termos(p.nome), enumerable: false });
    const s = parecido(A, p._t);
    if (s >= minimo) out.push({ p, s });
  }
  return out.sort((x, y) => y.s - x.s).slice(0, n);
}

// ---------- leitor do QR code ----------
let detector = null;
async function obterDetector() {
  if (detector) return detector;
  if ('BarcodeDetector' in window) {
    try { const sup = await BarcodeDetector.getSupportedFormats(); if (sup.includes('qr_code')) return detector = new BarcodeDetector({ formats: ['qr_code'] }) } catch (e) { }
  }
  const base = new URL('../cliente/vendor/', location.href).href;
  if (!window.BarcodeDetectionAPI) await new Promise((ok, er) => { const sc = document.createElement('script'); sc.src = base + 'barcode-detector.js'; sc.onload = ok; sc.onerror = () => er(new Error('Não consegui carregar o leitor de QR code')); document.head.appendChild(sc) });
  const A = window.BarcodeDetectionAPI;
  A.prepareZXingModule({ overrides: { locateFile: (f, pre) => f.endsWith('.wasm') ? base + 'zxing_reader.wasm' : pre + f }, fireImmediately: true });
  return detector = new A.BarcodeDetector({ formats: ['qr_code'] });
}
const ehCupom = v => /\|/.test(v) || /sefaz|nfce|fazenda/i.test(v);

// lê o QR de uma foto (arquivo de imagem)
export async function lerQrFoto(file) {
  const det = await obterDetector();
  const img = await createImageBitmap(file);
  // fotos grandes: tenta inteira e reduzida (o leitor acha melhor em tamanhos médios)
  for (const lado of [0, 1600, 1000]) {
    let fonte = img;
    if (lado && Math.max(img.width, img.height) > lado) {
      const k = lado / Math.max(img.width, img.height), cv = document.createElement('canvas');
      cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k); cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height); fonte = cv;
    } else if (lado) continue;
    const r = await det.detect(fonte).catch(() => []);
    const v = r.map(x => x.rawValue).find(ehCupom);
    if (v) return v;
  }
  throw new Error('Não achei o QR code do cupom na foto. Tire outra, mais perto e com o QR inteiro.');
}

// câmera ao vivo dentro do modal do painel; chama aoLer(texto) uma vez
export async function lerQrCamera(caixa, aoLer, aoErro) {
  const vid = caixa.querySelector('video'), msg = caixa.querySelector('[data-msg]');
  let det;
  try { det = await obterDetector() } catch (e) { aoErro(e.message); return () => { } }
  let st;
  try { st = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } }) }
  catch (e) { aoErro('Não consegui abrir a câmera. Libere a câmera para este site ou use "Foto do cupom".'); return () => { } }
  let vivo = true; const parar = () => { vivo = false; st.getTracks().forEach(t => t.stop()) };
  vid.srcObject = st; try { await vid.play() } catch (e) { }
  const tr = st.getVideoTracks()[0], cap = tr.getCapabilities?.() || {};
  try { if (cap.focusMode?.includes('continuous')) await tr.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }) } catch (e) { }
  if (msg) msg.textContent = 'Aproxime o QR code do cupom';
  const loop = async () => {
    if (!vivo) return;
    if (!document.body.contains(vid)) { parar(); return }
    if (vid.videoWidth) {
      try { const r = await det.detect(vid); const v = r.map(x => x.rawValue).find(ehCupom); if (v) { parar(); aoLer(v); return } } catch (e) { }
    }
    setTimeout(loop, 150);
  };
  loop();
  return parar;
}
