// PDV do vendedor: guarda a tela no aparelho para abrir mesmo com a internet oscilando.
// Escopo próprio (/vendedor/), separado do caixa de autoatendimento. Chamadas à API nunca são cacheadas.
const V = 'pagnow-vendedor-v1';
const FOTOS = 'beep-fotos'; // mesmas fotos do caixa: guardadas por 7 dias
const SETE_DIAS = 7 * 24 * 60 * 60 * 1000;
const ARQ = ['./', './index.html', './manifest.webmanifest', '../site/marca/simbolo.svg', '../site/marca/logo-fundo-escuro.svg', '../site/marca/icone-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(ARQ))); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('pagnow-vendedor-') && k !== V).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method === 'GET' && u.hostname.endsWith('.supabase.co') && u.pathname.includes('/storage/v1/object/sign/produtos/')) {
    const chave = new Request(u.origin + u.pathname);
    e.respondWith(caches.open(FOTOS).then(async (c) => {
      const salva = await c.match(chave);
      if (salva && Date.now() - Number(salva.headers.get('x-salva-em') || 0) < SETE_DIAS) return salva;
      try {
        const r = await fetch(e.request);
        if (r.ok) { const b = await r.blob(); const h = new Headers(r.headers); h.set('x-salva-em', String(Date.now())); await c.put(chave, new Response(b, { status: 200, headers: h })); return new Response(b, { status: 200, headers: r.headers }); }
        return salva || r;
      } catch { return salva || Response.error(); }
    }));
    return;
  }
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then((r) => { const c = r.clone(); caches.open(V).then((k) => k.put(e.request, c)); return r; }).catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html'))));
});
