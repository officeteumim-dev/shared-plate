// Shared Plate service worker: keeps the app shell available offline (task data comes from Firestore's own offline
// cache) and receives push notifications through Firebase Cloud Messaging.
const CACHE = 'sp-v2';
const SHELL = ['/', '/index.html', '/app.css', '/app.js', '/logic.js', '/hebrew.js', '/config.js', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/icons/badge-72.png'];
const LIBS = /^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|www\.gstatic\.com\/firebasejs)\//;

// Push: the server sends a `webpush.notification`, which the Firebase Messaging library shows for us,
// and opens fcmOptions.link when it's tapped.
try {
  importScripts('/config.js');
  if (self.SP_CONFIG && self.SP_CONFIG.configured) {
    importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');
    firebase.initializeApp(self.SP_CONFIG.firebase);
    firebase.messaging();
  }
} catch (e) { /* offline at install: the next update picks it up */ }

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (url.pathname.startsWith('/__/') || url.pathname.startsWith('/cal/')) return; // sign-in helper pages and calendar feeds
    // Network first so updates show up right away; the cached copy when offline.
    e.respondWith(fetch(req).then(res => {
      if (res.status === 200) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); }
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('/index.html'))));
    return;
  }
  if (LIBS.test(req.url)) {
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res; })));
  }
});
// If a notification arrives without a link, tapping it still opens (or focuses) the app.
self.addEventListener('notificationclick', e => {
  if (e.notification.data && e.notification.data.FCM_MSG) return; // handled by Firebase Messaging
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow('/');
  }));
});
