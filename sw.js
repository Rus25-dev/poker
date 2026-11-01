// Офлайн-кэш оболочки приложения (сеть всё равно нужна для игры с друзьями)
const CACHE = 'rpoker-v3';
const ASSETS = ['./', 'index.html', 'css/style.css', 'css/desktop.css', 'js/app.js', 'js/cards.js', 'js/engine.js', 'js/equity.js',
  'js/bot.js', 'js/host.js', 'js/client.js', 'js/net.js', 'js/stats.js', 'js/i18n.js', 'js/sound.js', 'js/anim.js',
  'js/history.js', 'js/fair.js', 'js/worker.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
// сначала сеть (чтобы обновления приходили сразу), при отсутствии сети — кэш
// клик по уведомлению «ваш ход» — открыть приложение
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(cs => cs.length ? cs[0].focus() : self.clients.openWindow('./')));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok && new URL(e.request.url).origin === location.origin) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); }
    return r;
  }).catch(() => caches.match(e.request)));
});
