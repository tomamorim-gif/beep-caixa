// Service worker do Painel: só recebe as notificações da inteligência e abre o Painel no lugar certo.
// Não guarda nada em cache (o Painel sempre carrega a versão mais nova).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (er) { d = { title: 'PagNow', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'PagNow', {
    body: d.body || '', tag: d.tag || 'pagnow', renotify: true,
    icon: '../site/marca/icone-192.png', badge: '../site/marca/icone-192.png', data: { url: d.url || './' },
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil((async () => {
    const abertas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of abertas) if (c.url.startsWith(self.registration.scope)) { await c.focus(); return c.navigate(url); }
    return self.clients.openWindow(url);
  })());
});
