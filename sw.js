// WetterBoard Service Worker
// Strategie:
//   index.html  → Network-first (immer aktuellste Version holen)
//   Statische Assets (Chart.js, manifest, icon) → Cache-first
//   Open-Meteo API → immer live, kein Cache

const CACHE = 'wetterboard-v15';
const STATIC = [
  './manifest.json?v=15',
  './assets/css/app.css?v=15',
  './assets/js/app.js?v=15',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './help.html',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js'
];

// ── Install: statische Assets vorhalten ──────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC))
  );
  // Kein skipWaiting() → neuer SW wartet, bis Nutzer aktiv neu lädt
});

// ── Activate: alte Caches löschen, sofort übernehmen ─────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Message: Nutzer hat "Jetzt aktualisieren" geklickt ───────────────────────
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── Push: Server sendet Frost-Alarm auch wenn App geschlossen ist ────────────
self.addEventListener('push', e => {
  const d = e.data?.json() ?? {};
  e.waitUntil(
    self.registration.showNotification(d.title ?? '❄️ WetterBoard', {
      body:              d.body ?? '',
      icon:              './icon-192.png',
      badge:             './icon-192.png',
      tag:               d.tag ?? 'push',
      requireInteraction: d.requireInteraction ?? false,
      data:              { url: '/' },
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
      const open = cs.find(c => c.url.includes(self.location.origin));
      return open ? open.focus() : clients.openWindow('/');
    })
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = e.request.url;
  const reqUrl = new URL(url);

  // Lokale API: nie cachen, immer direkt zum Backend.
  if (reqUrl.pathname.startsWith('/api/')) return;

  // Wetter-API: immer live
  if (url.includes('open-meteo.com')) return;

  // index.html: Network-first → bei Fehler Cache-Fallback
  if (url.endsWith('/') || url.includes('index.html')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          // frische Version auch in Cache speichern
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Statische Assets: Cache-first
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
