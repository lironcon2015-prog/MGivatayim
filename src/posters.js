// Video posters, as nines does them: the bridge finds an image for a link and
// keeps it in Drive (makePoster); every approved device fetches it through
// the bridge (getPoster) and keeps the bytes in IndexedDB, so a poster is
// fetched once per phone and still shows with no network.
//
// YouTube needs none of this: its thumbnail is a fixed public address.
import { call } from './bridge.js';

const DB = 'mg-posters';
const STORE = 'posters';
const urls = new Map();          // ref → blob: URL, one per ref per session
const pending = new Map();       // ref → Promise, so two cards share one fetch

export function youtubeThumb(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (/(^|\.)youtube(-nocookie)?\.com$/.test(host)) {
    id = u.searchParams.get('v') || (u.pathname.match(/\/(shorts|embed|live|v)\/([^/?#]+)/) || [])[2];
  }
  return id && /^[\w-]{6,}$/.test(id) ? `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg` : null;
}

// IndexedDB can be missing or throw (private mode); then posters are just
// fetched each session.
let opening = null;
function db() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      if (!self.indexedDB) { reject(new Error('no IndexedDB')); return; }
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('blocked'));
    }).catch((e) => { opening = null; throw e; });
  }
  return opening;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function toBlob({ mime, data }) {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'image/jpeg' });
}

// A displayable URL for a stored poster, or null if there is none.
export function posterUrl(ref) {
  if (!ref) return Promise.resolve(null);
  if (urls.has(ref)) return Promise.resolve(urls.get(ref));
  if (pending.has(ref)) return pending.get(ref);
  const p = (async () => {
    let blob = null;
    try { blob = await tx('readonly', (s) => s.get(ref)); } catch { /* no cache: fetch */ }
    if (!blob) {
      try { blob = toBlob(await call('getPoster', { ref })); } catch { return null; }
      try { await tx('readwrite', (s) => s.put(blob, ref)); } catch { /* shown, just not kept */ }
    }
    const u = URL.createObjectURL(blob);
    urls.set(ref, u);
    return u;
  })().finally(() => pending.delete(ref));
  pending.set(ref, p);
  return p;
}

// Fills every <img data-poster> under root. Called after each render; an
// image that fails to arrive leaves the plain gradient card behind it.
export function hydratePosters(root) {
  root.querySelectorAll('img[data-poster]').forEach(async (img) => {
    const u = await posterUrl(img.dataset.poster);
    if (u && img.isConnected) img.src = u;
  });
}

// Manager's save: every video whose link has no poster yet (or changed)
// gets one made by the bridge. Best effort — a link with no image just keeps
// the plain card, and never blocks the save.
export async function preparePosters(videos, onProgress = () => {}) {
  const todo = (videos || []).filter((v) => v.url && !youtubeThumb(v.url) && (!v.poster || v.posterFor !== v.url));
  for (const [i, v] of todo.entries()) {
    onProgress(i + 1, todo.length);
    try {
      const { ref } = await call('makePoster', { url: v.url }, { asAdmin: true });
      v.poster = ref;
      v.posterFor = v.url;
    } catch {
      delete v.poster;
      delete v.posterFor;
    }
  }
  for (const v of videos || []) if (!v.url || youtubeThumb(v.url)) { delete v.poster; delete v.posterFor; }
  return todo.length;
}
