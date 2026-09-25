import { call } from './bridge.js';

/* ── The team gallery: data and transport ─────────────────────────────────
   Files live in Cloudinary, uploaded straight from the phone; the bridge
   signs each upload and keeps the list (gallery.json). Nothing here decides
   who may do what — the bridge does — this only moves bytes and builds
   addresses. */

export const MAX_VIDEO_S = 60;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_EDGE = 1600;
const JPEG_Q = 0.82;

// The last answer is kept on the device (mg:gallery), like the season: the
// media screen draws the gallery from it at once. Without it the first visit
// of a session showed the pre-gallery screen ("no videos yet") for the second
// the bridge took, and then swapped the gallery in.
const KEY = 'mg:gallery';
let last = (() => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } })();
export const cachedGallery = () => last;

export async function loadGallery({ asAdmin = false } = {}) {
  last = await call('getGallery', {}, { asAdmin });
  try { localStorage.setItem(KEY, JSON.stringify(last)); } catch { /* full or private: memory only */ }
  return last;
}

// Ids come from the bridge ("mg/…"); the check keeps a stray value out of
// an address anyway.
const okPid = (pid) => /^mg\/[a-z0-9]+$/.test(String(pid || ''));
const base = (g, kind) => `https://res.cloudinary.com/${encodeURIComponent(g.cloud)}/${kind === 'video' ? 'video' : 'image'}/upload`;

export function thumbUrl(g, it, size = 360) {
  if (!okPid(it.pid)) return '';
  return it.kind === 'video'
    ? `${base(g, 'video')}/so_1,c_fill,w_${size},h_${size},q_auto/${it.pid}.jpg`
    : `${base(g, 'image')}/c_fill,g_auto,w_${size},h_${size},q_auto,f_auto/${it.pid}`;
}

export function fullUrl(g, it) {
  if (!okPid(it.pid)) return '';
  return it.kind === 'video'
    ? `${base(g, 'video')}/q_auto/${it.pid}.mp4`
    : `${base(g, 'image')}/c_limit,w_${MAX_EDGE},h_${MAX_EDGE},q_auto,f_auto/${it.pid}`;
}

export const posterUrl = (g, it) => (okPid(it.pid) ? `${base(g, 'video')}/so_1,c_limit,w_${MAX_EDGE},q_auto/${it.pid}.jpg` : '');

// A download Cloudinary serves as an attachment, so "save" saves.
export function saveUrl(g, it) {
  if (!okPid(it.pid)) return '';
  return it.kind === 'video' ? `${base(g, 'video')}/fl_attachment/${it.pid}.mp4` : `${base(g, 'image')}/fl_attachment/${it.pid}.jpg`;
}

/* ---- before the upload ---- */

export const kindOf = (file) => (String(file.type).startsWith('video/') ? 'video' : 'image');

// Redrawn on a canvas: smaller (a phone photo is 3–5 MB, this is ~0.4 MB)
// and without its EXIF, which carries the GPS position of the pitch or home.
export async function shrinkImage(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', JPEG_Q));
  if (!blob) throw new Error('לא הצלחנו לעבד את התמונה');
  return { blob, w, h };
}

export function videoMeta(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    const done = (m) => { URL.revokeObjectURL(url); resolve(m); };
    v.preload = 'metadata';
    v.onloadedmetadata = () => done({ dur: v.duration, w: v.videoWidth, h: v.videoHeight });
    v.onerror = () => done({ dur: null, w: null, h: null });
    v.src = url;
  });
}

/* ---- the upload ---- */

// XHR and not fetch: fetch has no upload progress, and a video on a
// mobile line takes long enough that a bar is the difference between
// waiting and giving up.
function postToCloudinary(sig, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', blob);
    fd.append('api_key', sig.apiKey);
    fd.append('timestamp', String(sig.timestamp));
    fd.append('public_id', sig.public_id);
    fd.append('allowed_formats', sig.allowed_formats);
    fd.append('signature', sig.signature);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `https://api.cloudinary.com/v1_1/${encodeURIComponent(sig.cloud)}/${sig.kind === 'video' ? 'video' : 'image'}/upload`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body || {});
      else reject(new Error(body?.error?.message ? 'הקובץ נדחה: ' + body.error.message : 'ההעלאה נכשלה'));
    };
    xhr.onerror = () => reject(new Error('אין חיבור. נסו שוב.'));
    xhr.send(fd);
  });
}

// One file, start to finish. Throws with a message fit for the file's row.
export async function uploadOne(file, match, { onProgress, asAdmin = false } = {}) {
  const kind = kindOf(file);
  let blob = file, w = null, h = null, dur = null;
  if (kind === 'video') {
    if (file.size > MAX_VIDEO_BYTES) throw new Error('הסרטון גדול מדי');
    ({ dur, w, h } = await videoMeta(file));
    if (dur && dur > MAX_VIDEO_S + 1) throw new Error(`סרטון עד ${MAX_VIDEO_S} שניות`);
  } else {
    ({ blob, w, h } = await shrinkImage(file));
  }
  const sig = await call('signUpload', { kind }, { asAdmin });
  await postToCloudinary(sig, blob, onProgress);
  return call('addGalleryItem', { pid: sig.public_id, w, h, dur, match }, { asAdmin });
}

export const hideItem = (id, why, { asAdmin = false } = {}) => call('hideGalleryItem', { id, why }, { asAdmin });
export const deleteItem = (id, { asAdmin = false } = {}) => call('deleteGalleryItem', { id }, { asAdmin });
export const deleteItems = (ids, { asAdmin = false } = {}) => call('deleteGalleryItem', { ids }, { asAdmin });
