// Getting releases onto phones, including the home-screen shortcut.
// Ported from family-vault's Updater (itself from Navigo), where every layer
// was written against a real Safari-on-GitHub-Pages bug:
//
//   1. The service worker is registered with updateViaCache:'none', so the
//      browser never serves sw.js itself from an HTTP cache.
//   2. version.json, fetched past every cache, is the truth. When it names a
//      version the page is not running and no install is under way, the SW is
//      re-registered at sw.js?v=<version> — a URL no cache has ever seen.
//   3. A new SW takes control → the page reloads, once per version pair.
//
// Checked at launch and every time the app comes back to the foreground,
// which is how a home-screen app is "reopened" on iOS: it resumes, it does
// not relaunch.

const running = () => window._BUNDLE_VERSION || '';
const SW_URL = new URL('../sw.js', import.meta.url);
const VERSION_URL = new URL('../version.json', import.meta.url);

let reg = null;
let remote = '';
let registered = '';
let canReload = () => true;

/* Reload brake. If version.json and the page keep disagreeing after a
   reload — a half-finished Pages deploy, a CDN serving an old index.html
   beside a fresh version.json — every check would re-register, every
   registration would reload, and the page would flash forever. One reload
   per (remote, running) pair; after that the bar is shown instead. */
function shouldReload() {
  const tag = `${remote || '?'}|${running() || '?'}`;
  let prev = '';
  try { prev = sessionStorage.getItem('mg:reload') || ''; } catch { /* private mode */ }
  if (prev === tag) return false;
  try { sessionStorage.setItem('mg:reload', tag); } catch { /* private mode */ }
  return true;
}

function reload() {
  // A manager halfway through entering a result does not lose it to an
  // update: they get the bar, and the reload waits for their tap.
  if (!canReload() || !shouldReload()) { offer(); return; }
  location.reload();
}

function offer() {
  if (document.querySelector('.update-bar')) return;
  const bar = document.createElement('div');
  bar.className = 'update-bar';
  bar.setAttribute('role', 'status');
  bar.innerHTML = `<span>יש גרסה חדשה${remote ? ` (${remote})` : ''}</span><button type="button" class="btn small">רענון</button>`;
  bar.querySelector('button').addEventListener('click', () => {
    if (!canReload() && !confirm('יש שינויים שלא נשמרו. לרענן בכל זאת?')) return;
    const waiting = reg?.waiting;
    if (waiting) waiting.postMessage('skip-waiting');
    else location.reload();
  });
  document.body.appendChild(bar);
}

async function check() {
  try { reg?.update(); } catch { /* not blocking */ }
  let json;
  try {
    const url = new URL(VERSION_URL);
    url.searchParams.set('t', Date.now());
    json = await (await fetch(url, { cache: 'no-store' })).json();
  } catch { return; } // offline: nothing to compare against
  const v = json?.version;
  if (!v || v === running()) return;
  remote = v;
  if (reg && !reg.waiting && !reg.installing && registered !== v) {
    // Once per version: re-registering at a changing URL is itself a pump
    // for controllerchange, the other half of the same reload loop.
    registered = v;
    const url = new URL(SW_URL);
    url.searchParams.set('v', v);
    try { reg = await navigator.serviceWorker.register(url, { updateViaCache: 'none' }); } catch { /* not blocking */ }
    return;
  }
  if (reg?.waiting) offer();
  // No service worker at all (unsupported, or blocked): a plain reload still
  // brings the new code, because nothing else stands between page and server.
  if (!reg) reload();
}

export function startUpdater({ isBusy } = {}) {
  if (isBusy) canReload = () => !isBusy();
  if (!('serviceWorker' in navigator)) { check(); return; }

  navigator.serviceWorker.register(SW_URL, { updateViaCache: 'none' })
    .then((r) => { reg = r; check(); })
    .catch(() => { check(); });

  // The first install takes control of a page that had no controller; a
  // reload there would only flash the app on its very first open. Reload
  // only when a controller that already existed is replaced — a real update.
  let hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) { hadController = true; return; }
    reloading = true;
    reload();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
}

export const appVersion = running;
