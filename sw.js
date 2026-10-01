/* sw.js — opens the app at once from the copy on the phone, keeps it
   openable offline, and makes updates arrive.
   CACHE_VERSION must equal version.json and window._BUNDLE_VERSION in
   index.html. `node tools/bump.mjs` writes all three; tests/pwa.mjs fails if
   they drift apart. */
const CACHE_VERSION = '1.52.1';
const CACHE_NAME = 'mgivatayim-' + CACHE_VERSION;

/* The app itself: everything it needs to open with no network, kept as one
   copy per version and served from it. tests/pwa.mjs fails if a file under
   src/ is missing here: a module that is not in the copy is asked of the
   network on every open, and breaks the whole app the first time it opens
   offline. */
const CORE = [
  './', './index.html', './styles.css', './manifest.webmanifest',
  './assets/crest.png',
  './assets/fonts/assistant-hebrew.woff2', './assets/fonts/assistant-latin.woff2', './assets/fonts/rubik-hebrew.woff2', './assets/fonts/rubik-latin.woff2',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png',
  './src/app.js', './src/bridge.js', './src/components.js', './src/config.js',
  './src/fixtures.js', './src/format.js', './src/gallery.js', './src/icons.js', './src/imaging.js', './src/importer.js', './src/install.js', './src/positions.js', './src/trainings.js',
  './src/lineup-text.js', './src/minutes.js', './src/posters.js', './src/season.js', './src/store.js', './src/updater.js',
  './src/live/model.js', './src/live/sync.js', './src/ui/sheet.js',
  './src/views/admin.js', './src/views/gallery.js', './src/views/gate.js', './src/views/home.js',
  './src/views/live.js', './src/views/media.js', './src/views/minutes.js', './src/views/stats.js',
];

const SHELL = new Set(CORE.map((u) => new URL(u, location.href).href));

/* Anything else of ours (the guides, a favicon): how long a request may wait
   for the network before a cached copy is used. Long enough for a slow mobile
   connection to win, short enough that a parent in a basement with one bar
   still gets the page. */
const NETWORK_WAIT_MS = 4000;

/* A version is taken whole or not at all. Every file must come, and the page
   must be of this same release (a CDN still holding the last index.html
   would open the old app from a copy this worker vouches for). Otherwise the
   install fails, the version in use stays as it is, and the page's next
   check asks again. cache:'no-cache' fills from the server, not from an HTTP
   cache that may still hold the previous release — GitHub Pages sends
   max-age=600; files that did not change come back as a short 304. */
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const got = await Promise.all(CORE.map(async (u) => {
      const res = await fetch(u, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`${u}: ${res.status}`);
      return [u, res];
    }));
    for (const [u, res] of got) {
      if ((u === './' || u === './index.html') && !(await res.clone().text()).includes(`_BUNDLE_VERSION = '${CACHE_VERSION}'`)) {
        throw new Error(`${u} is not ${CACHE_VERSION}`);
      }
    }
    const c = await caches.open(CACHE_NAME);
    await Promise.all(got.map(([u, res]) => c.put(u, res)));
    await self.skipWaiting();
  })());
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

/* The app opens from its copy, without waiting for the network: on a pitch
   with one bar every file used to wait for it (2.6 s to the home screen on a
   300 ms line; 0.16 s from the copy). The owner's decision, knowing what it
   costs: a release reaches phones only with a version bump — which every
   push to main carries — and the first open after one shows the last version
   until the new copy is in, then reloads once (src/updater.js).
   Anything outside the app (the guides, a favicon) stays network first. */
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // The bridge, Waze, Cloudinary: never cached, never intercepted.
  if (url.origin !== location.origin) return;
  // The server's statement of what is current must never come from a cache.
  if (url.pathname.endsWith('/version.json')) return;

  e.respondWith(SHELL.has(url.origin + url.pathname) ? fromCopy(req) : respond(req));
});

async function fromCopy(req) {
  // Not in it (storage cleared under us): the network, as for anything else.
  return (await caches.match(req, { cacheName: CACHE_NAME, ignoreSearch: true, ignoreVary: true })) || respond(req);
}

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
  // An error page (Pages mid-deploy, a 5xx) is no fresher than the copy
  // that works: a module answered with one took the whole app down.
  return Promise.race([network.then((res) => (res.ok ? res : cached), () => cached), timeout]);
}
