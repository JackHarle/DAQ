/* push-sw.js — ride notifications + offline use for the Suspension Analyzer.
 * Offline: the page itself is fetched from the network first (so a new upload
 * shows at once) and a copy is kept for when there is no signal; the charting
 * library is kept after its first download. Rides already live on the device
 * (IndexedDB), so past rides open with no internet.
 * Push: a push from your Worker carries no data; this asks the Worker which
 * ride arrived, shows "Ride ready", and opens the analyzer on that ride. */
const CACHE = 'sa-offline-v1';
const TILES = 'sa-tiles-v1', MAX_TILES = 6000;
const PAGE = new URL('./', self.registration.scope).href;
const LIBS = ['https://cdn.plot.ly/plotly-2.27.0.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/plotly.js/2.27.0/plotly.min.js',
              'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
              'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'];
// Map tiles (Trails tab): kept after the first look, so a trail's map works with no signal
const TILE_HOSTS = /(^|\.)(server\.arcgisonline\.com|tile\.opentopomap\.org|tile-cyclosm\.openstreetmap\.fr)$/;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all([
    fetch(PAGE, { cache: 'no-store' }).then(r => r.ok ? c.put(PAGE, r) : null).catch(() => {}),
    fetch(LIBS[0], { mode: 'no-cors' }).then(r => c.put(LIBS[0], r)).catch(() => {})
  ])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if ((k.startsWith('sa-offline-') && k !== CACHE) || (k.startsWith('sa-tiles-') && k !== TILES)) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Map tiles: cache first; trimmed now and then to the newest MAX_TILES
  if (TILE_HOSTS.test(url.hostname)) {
    e.respondWith(caches.open(TILES).then(async c => {
      const hit = await c.match(url.href);
      if (hit) return hit;
      const r = await fetch(req.mode === 'navigate' ? url.href : req);
      if (r.ok || r.type === 'opaque') { c.put(url.href, r.clone()).catch(() => {}); if (Math.random() < 0.02) trimTiles(c); }
      return r;
    }));
    return;
  }
  // Charting and map libraries: fixed versions, so the cached copy is always right
  if (LIBS.includes(url.href)) {
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(url.href);
      if (hit) return hit;
      const r = await fetch(req);
      c.put(url.href, r.clone()).catch(() => {});
      return r;
    }));
    return;
  }
  // The analyzer page and its own small files: network first, cached copy offline.
  // Everything else (the Worker, map tiles, the logger) goes straight to the network.
  if (url.origin !== self.location.origin || !url.href.startsWith(PAGE)) return;
  const isPage = req.mode === 'navigate' || url.href.split(/[?#]/)[0] === PAGE || /\/index\.html$/.test(url.pathname);
  const isAsset = /\.(webmanifest|png)$/.test(url.pathname);
  if (!isPage && !isAsset) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const key = isPage ? PAGE : url.href.split(/[?#]/)[0];
    try {
      const r = await fetch(req, isPage ? { cache: 'no-store' } : undefined);
      if (r.ok) c.put(key, r.clone()).catch(() => {});
      return r;
    } catch (err) {
      const hit = await c.match(key);
      if (hit) return hit;
      throw err;
    }
  })());
});

async function trimTiles(c) {
  try { const keys = await c.keys(); for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]); } catch (e) {}
}

function cfg() {
  return new Promise(res => {
    try {
      const r = indexedDB.open('sa-cloud', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('cfg');
      r.onsuccess = () => {
        const g = r.result.transaction('cfg', 'readonly').objectStore('cfg').get('cfg');
        g.onsuccess = () => res(g.result || null); g.onerror = () => res(null);
      };
      r.onerror = () => res(null);
    } catch (e) { res(null); }
  });
}

self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let n = { title: 'Ride ready', body: 'Tap to open it', name: null, host: null };
    try {
      const c = await cfg();
      if (c && c.url && c.key) {
        const r = await fetch(c.url.replace(/\/+$/, '') + '/v1/latest', { headers: { 'X-Read-Key': c.key }, cache: 'no-store' });
        if (r.ok) n = Object.assign(n, await r.json());
      }
    } catch (err) {}
    const url = new URL('./', self.registration.scope);
    if (n.name) { url.searchParams.set('ride', n.name); if (n.host) url.searchParams.set('host', n.host); }
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    wins.forEach(w => w.postMessage({ type: 'ride', name: n.name, host: n.host }));   // open pages start syncing now
    await self.registration.showNotification(n.title, {
      body: n.body, tag: n.name || 'ride', renotify: true,
      icon: new URL('icon-192.png', self.registration.scope).href, badge: new URL('icon-192.png', self.registration.scope).href,
      data: { url: url.href }
    });
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.indexOf(self.registration.scope) === 0 && 'focus' in w) { w.postMessage({ type: 'open', url }); return w.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});
