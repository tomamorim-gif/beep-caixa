// Guarda o app no aparelho para abrir sem internet. Chamadas à API nunca são cacheadas.
const V = 'beep-caixa-v25';
const FOTOS = 'beep-fotos'; // fotos dos produtos: guardadas no aparelho por 7 dias
const SETE_DIAS = 7 * 24 * 60 * 60 * 1000;
const ARQ = ['./', './index.html', './manifest.webmanifest', './logo.png', './icon-192.png', './icon-512.png', './vendor/qrcode.js'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(ARQ))); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V && k !== FOTOS).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  // foto de produto (link assinado do Supabase): usa a cópia guardada por até 7 dias, mesmo sem internet
  if (e.request.method === 'GET' && u.hostname.endsWith('.supabase.co') && (u.pathname.includes('/storage/v1/object/sign/produtos/') || (u.pathname.includes('/storage/v1/object/sign/midia/') && !u.pathname.endsWith('.mp4')))) {
    const chave = new Request(u.origin + u.pathname); // sem o token, que muda a cada renovação do link
    e.respondWith(caches.open(FOTOS).then(async (c) => {
      const salva = await c.match(chave);
      const quando = Number(salva?.headers.get('x-salva-em') || 0);
      if (salva && Date.now() - quando < SETE_DIAS) return salva;
      try {
        const r = await fetch(e.request);
        if (r.ok) { const b = await r.blob(); const h = new Headers(r.headers); h.set('x-salva-em', String(Date.now())); await c.put(chave, new Response(b, { status: 200, headers: h })); return new Response(b, { status: 200, headers: r.headers }); }
        return salva || r;
      } catch { return salva || Response.error(); }
    }));
    return;
  }
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  // sempre confere no servidor (o GitHub guarda cópia por 10 min); sem internet usa a cópia salva
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then((r) => { const c = r.clone(); caches.open(V).then((k) => k.put(e.request, c)); return r; }).catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html'))));
});
