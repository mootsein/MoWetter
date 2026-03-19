// WetterBoard Service Worker
// Strategie:
//   index.html  → Network-first (immer aktuellste Version holen)
//   Statische Assets (Chart.js, manifest, icon) → Cache-first
//   Open-Meteo API → immer live, kein Cache

const CACHE = 'wetterboard-v2';
const STATIC = [
  './manifest.json',
  './icon.svg',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js'
];

// ── Install: statische Assets vorhalten ──────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC))
  );
  self.skipWaiting(); // neue SW-Version sofort aktivieren
});

// ── Activate: alte Caches löschen, sofort übernehmen ─────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim(); // alle offenen Tabs sofort übernehmen
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Wetter-API: immer live
  if (url.includes('open-meteo.com')) return;

  // index.html: Network-first → bei Fehler Cache-Fallback
  if (url.endsWith('/') || url.includes('index.html') || url.includes('wetterboard.html')) {
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
