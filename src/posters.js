// Video posters, as nines does them: the bridge finds an image for a link and
// keeps it in Drive (makePoster); every approved device fetches it through
// the bridge (getPoster) and keeps the bytes in IndexedDB, so a poster is
// fetched once per phone and still shows with no network.
//
// YouTube needs none of this: its thumbnail is a fixed public address.
import { call } from './bridge.js';
import { getAdminCode } from './store.js';
import { opaqueBounds, unsharp } from './imaging.js';

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

// An opponent's crest, picked on the manager's phone: its transparent margin
// cut away, scaled down in halves (one big drawImage step is what made small
// crests look soft), lightly sharpened, and kept at LOGO_EDGE px — three
// device pixels for every CSS pixel of the 72px disc, with room to spare.
// PNG keeps a transparent background. A detailed crest can make a 512px PNG
// larger than the bridge takes (MAX_LOGO_BYTES in bridge.gs), so it steps
// down until it fits. Returns the ref the season stores under the name.
const LOGO_EDGE = 512;
const LOGO_MIN_EDGE = 256;
const MAX_LOGO_B64 = Math.floor(200 * 1024 * 4 / 3);
const canvasOf = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });
const smooth = (c) => { const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; return ctx; };

function scaled(src, box, edge) {
  const k = Math.min(1, edge / Math.max(box.w, box.h));
  const w = Math.max(1, Math.round(box.w * k)), h = Math.max(1, Math.round(box.h * k));
  let cur = canvasOf(box.w, box.h);
  smooth(cur).drawImage(src, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  while (cur.width >= w * 2 && cur.height >= h * 2) {
    const half = canvasOf(Math.ceil(cur.width / 2), Math.ceil(cur.height / 2));
    smooth(half).drawImage(cur, 0, 0, half.width, half.height);
    cur = half;
  }
  const out = canvasOf(w, h);
  const ctx = smooth(out);
  ctx.drawImage(cur, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  unsharp(img.data, w, h);
  ctx.putImageData(img, 0, 0);
  return out;
}

export async function uploadLogo(file) {
  if (!String(file?.type).startsWith('image/')) throw new Error('צריך לבחור קובץ תמונה');
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw new Error('לא הצלחנו לקרוא את התמונה'); }
  const src = canvasOf(bmp.width, bmp.height);
  const sctx = src.getContext('2d');
  sctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  const box = opaqueBounds(sctx.getImageData(0, 0, src.width, src.height).data, src.width, src.height)
    || { x: 0, y: 0, w: src.width, h: src.height };
  let edge = Math.min(LOGO_EDGE, Math.max(box.w, box.h));
  let url;
  for (;;) {
    url = scaled(src, box, edge).toDataURL('image/png');
    if (url.length - url.indexOf(',') - 1 <= MAX_LOGO_B64 || edge <= LOGO_MIN_EDGE) break;
    edge = Math.max(LOGO_MIN_EDGE, Math.round(edge * 0.75));
  }
  const [mime, data] = url.match(/^data:([^;]+);base64,(.*)$/).slice(1);
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
