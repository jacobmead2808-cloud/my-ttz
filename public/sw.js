// Service worker: makes Clipzy installable, shows an offline screen, and receives push notifications.
// API calls, media and WebSockets always go to the network (never cached: they're private and live).
const VERSION = 'clipzy-v5';
const SHELL = ['/offline.html', '/css/app.css', '/css/theme.css', '/css/features.css', '/css/identity.css', '/css/design.css', '/css/live.css', '/fonts/inter-var.woff2', '/js/app.js', '/js/theme-init.js',
  '/assets/brand/logo.svg', '/assets/brand/icon-192.png', '/manifest.webmanifest', '/js/offline.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/') || url.pathname === '/ws') return;
  // Page navigations: always the network (fresh app + session); offline screen when there's no connection.
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/offline.html')));
    return;
  }
  // Static assets: network first so updates show immediately, cache as a fallback.
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request)));
});

// ---------- Push notifications ----------
self.addEventListener('push', (e) => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch { msg = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(msg.title || 'Clipzy', {
    body: msg.body || '',
    icon: '/assets/brand/icon-192.png',
    badge: '/assets/brand/badge-96.png',
    tag: msg.tag || undefined,
    renotify: !!msg.tag,
    data: { url: msg.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin);
  if (target.origin !== self.location.origin) return;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const win = wins.find((w) => new URL(w.url).origin === target.origin);
    if (win) return win.focus().then((w) => w.navigate(target.href)).catch(() => self.clients.openWindow(target.href));
    return self.clients.openWindow(target.href);
  }));
});
