/* sw.js — keeps the app openable offline and makes updates arrive.
   CACHE_VERSION must equal version.json and window._BUNDLE_VERSION in
   index.html. `node tools/bump.mjs` writes all three; tests/pwa.mjs fails if
   they drift apart. */
const CACHE_VERSION = '1.10.2';
const CACHE_NAME = 'mgivatayim-' + CACHE_VERSION;

/* Everything the shell needs to open with no network. tests/pwa.mjs fails if
   a file under src/ is missing here: a module that is not precached works
   online and then breaks the whole app the first time it opens offline. */
const CORE = [
  './', './index.html', './styles.css', './manifest.webmanifest',
  './assets/crest.png',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png',
  './src/app.js', './src/bridge.js', './src/components.js', './src/config.js',
  './src/fixtures.js', './src/format.js', './src/icons.js', './src/importer.js', './src/install.js', './src/positions.js',
  './src/posters.js', './src/season.js', './src/store.js', './src/updater.js',
  './src/live/model.js', './src/live/sync.js', './src/ui/sheet.js',
  './src/views/admin.js', './src/views/gate.js', './src/views/home.js',
  './src/views/live.js', './src/views/media.js', './src/views/stats.js',
];

/* How long a request may wait for the network before a cached copy is used.
   Long enough for a slow mobile connection to win, short enough that a
   parent in a basement with one bar still gets the page. */
const NETWORK_WAIT_MS = 4000;

self.addEventListener('install', (e) => {
  /* cache:'no-cache' fills from the server, not from an HTTP cache that may
     still hold the previous release — GitHub Pages sends max-age=600. */
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then((c) => Promise.all(CORE.map((u) =>
        fetch(u, { cache: 'no-cache' }).then((r) => { if (r.ok) return c.put(u, r); }).catch(() => null))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('mgivatayim-') && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

/* Network first, cache as the fallback — the opposite of family-vault, on
   purpose. This app changes often, and cache-first means a release reaches
   installed phones only if the version was bumped. Network-first means any
   push to main reaches everyone who is online on their next open, bump or
   not; the bump is what makes an *already open* app notice and reload. */
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // The bridge, Google Fonts, Waze: never cached, never intercepted.
  if (url.origin !== location.origin) return;
  // The server's statement of what is current must never come from a cache.
  if (url.pathname.endsWith('/version.json')) return;

  e.respondWith(respond(req));
});

async function respond(req) {
  // A navigation Request cannot be re-issued with an init object, so it is
  // refetched by URL; everything else keeps its own mode and credentials.
  const network = (req.mode === 'navigate' ? fetch(req.url, { cache: 'no-cache' }) : fetch(req, { cache: 'no-cache' }))
    .then(async (res) => {
      if (res.ok && res.type === 'basic') {
        const c = await caches.open(CACHE_NAME);
        await c.put(req, res.clone());
      }
      return res;
    });

  const cached = await caches.match(req, { ignoreSearch: true })
    || (req.mode === 'navigate' ? await caches.match('./index.html') : undefined);
  if (!cached) return network.catch(() => Response.error());

  const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), NETWORK_WAIT_MS));
  return Promise.race([network.catch(() => cached), timeout]);
}
