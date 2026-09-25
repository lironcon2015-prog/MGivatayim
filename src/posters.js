// Video posters, as nines does them: the bridge finds an image for a link and
// keeps it in Drive (makePoster); every approved device fetches it through
// the bridge (getPoster) and keeps the bytes in IndexedDB, so a poster is
// fetched once per phone and still shows with no network.
//
// YouTube needs none of this: its thumbnail is a fixed public address.
import { call } from './bridge.js';
import { getAdminCode } from './store.js';

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

export const cachedPosterUrl = (ref) => urls.get(ref) || null;

// A displayable URL for a stored poster, or null if there is none.
export function posterUrl(ref) {
  if (!ref) return Promise.resolve(null);
  if (urls.has(ref)) return Promise.resolve(urls.get(ref));
  if (pending.has(ref)) return pending.get(ref);
  const p = (async () => {
    let blob = null;
    try { blob = await tx('readonly', (s) => s.get(ref)); } catch { /* no cache: fetch */ }
    if (!blob) {
      // The manager's own phone need not be an approved device: the code
      // is what lets it read.
      try { blob = toBlob(await call('getPoster', { ref }, { asAdmin: !!getAdminCode() })); } catch { return null; }
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
    if (img.getAttribute('src')) return;
    const u = await posterUrl(img.dataset.poster);
    if (u && img.isConnected) img.src = u;
  });
}

// An opponent's crest, picked on the manager's phone: redrawn at most
// LOGO_EDGE px (a badge is shown at 72px), PNG to keep a transparent
// background, and handed to the bridge (putLogo), which keeps it with the
// posters. Returns the ref the season stores under the opponent's name.
const LOGO_EDGE = 256;
export async function uploadLogo(file) {
  if (!String(file?.type).startsWith('image/')) throw new Error('צריך לבחור קובץ תמונה');
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw new Error('לא הצלחנו לקרוא את התמונה'); }
  const k = Math.min(1, LOGO_EDGE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * k));
  canvas.height = Math.max(1, Math.round(bmp.height * k));
  const ctx = canvas.getContext('2d');
  // The default smoothing is the fast kind: a crest shrunk with it comes out
  // jagged at its edges and lettering.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  const [mime, data] = canvas.toDataURL('image/png').match(/^data:([^;]+);base64,(.*)$/).slice(1);
  const { ref } = await call('putLogo', { mime, data }, { asAdmin: true });
  return ref;
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
