// Everything this app keeps on the device. Every access is wrapped: storage
// throws in some private windows and can come back empty at any time, and the
// app must still reach a sensible screen — at worst "ask for access again".
const P = 'mg:';

function get(key) {
  try { return localStorage.getItem(P + key); } catch { return null; }
}
function set(key, value) {
  try {
    if (value == null) localStorage.removeItem(P + key);
    else localStorage.setItem(P + key, value);
  } catch { /* nothing to do: the next launch will simply ask again */ }
}

// The device's identity toward the bridge. 256 random bits, generated once
// and never shown. The bridge stores only a hash of it.
export function deviceKey() {
  let key = get('device');
  if ((!key || key.length < 64) && kept) { key = kept; set('device', key); }
  if (!key || key.length < 64) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    key = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    set('device', key);
  }
  return key;
}

// A second copy of the key, in IndexedDB — a store of its own on disk. Parents
// on Android kept losing access and asking again (the owner, 1.88.2): with the
// key in localStorage alone, losing that one store (Chrome drops a damaged
// localStorage and starts it empty; a read that fails comes back as "no key")
// made a new device that the bridge had never approved. The copy brings the key
// back, and wins when the two differ: the key never changes on purpose, so a
// different one in localStorage is one made after the first was lost. Clearing
// the site's data clears both; the manager replaces the device then.
// Awaited before the first call to the bridge (start in app.js), at most a second.
let kept = null;
const KEY_DB = 'mg-device';
function keyStore(mode, run) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(KEY_DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('k');
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error('blocked'));
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('k', mode);
      const req = run(tx.objectStore('k'));
      tx.oncomplete = () => { db.close(); resolve(req.result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}
export function keepDeviceKey() {
  const work = (async () => {
    const copy = await keyStore('readonly', (st) => st.get('device'));
    if (typeof copy === 'string' && copy.length >= 64) {
      kept = copy;
      if (get('device') !== copy) set('device', copy);
      return;
    }
    const key = deviceKey();
    await keyStore('readwrite', (st) => st.put(key, 'device'));
  })().catch(() => {});
  return Promise.race([work, new Promise((r) => setTimeout(r, 1000))]);
}

export const getName = () => get('name') || '';
export const setName = (n) => set('name', n);

// The formation last chosen on this device, per size: the next match's default.
export const getFormation = (size) => { try { return JSON.parse(get('formation') || '{}')[size] || ''; } catch { return ''; } };
export const setFormation = (id, size) => {
  let all = {};
  try { all = JSON.parse(get('formation') || '{}'); } catch {}
  all[size] = id;
  set('formation', JSON.stringify(all));
};
export const getAdminCode = () => get('admin') || '';
export const setAdminCode = (c) => set('admin', c || null);

// Last season this device was allowed to see. It lets a returning parent get
// the page instantly while the bridge — often a few seconds cold — answers in
// the background. It is dropped the moment the bridge says access is gone.
export function getCachedSeason() {
  try { return JSON.parse(get('season') || 'null'); } catch { return null; }
}
export function setCachedSeason(payload) {
  set('season', payload ? JSON.stringify(payload) : null);
}

// The last minutes alert shown on this device (match and period), so it
// comes once and not on every poll.
export const getAlerted = () => get('alerted') || '';
export const setAlerted = (k) => set('alerted', k);
// The alert the coach folded with "got it" (same key): it stays one line.
export const getFolded = () => get('folded') || '';
export const setFolded = (k) => set('folded', k || null);
// The coach's live screen: the squad's buttons, or all of them by choice.
export const getCoachFull = () => get('coachFull') === '1';
export const setCoachFull = (on) => set('coachFull', on ? '1' : null);

export function forgetAccess() {
  setCachedSeason(null);
  set('liveLast', null);
  set('gallery', null);
}

// Tests point the app at a local bridge through this key. It is read from
// storage only, never from the URL: a link that could redirect the app to a
// foreign bridge would be a way to harvest the manager's code.
export const bridgeOverride = () => get('bridge') || '';
// And at a second one, standing in for the way around (see bridge.js).
export const fallbackOverride = () => get('bridgeFallback') || '';
// Until when this phone goes the way around: a network that cannot reach the
// server answered through Google. Kept across restarts — the same phone on the
// same network would otherwise fail its first request at every opening. Kept
// with the server's address: one that changed (1.87.3) is tried again at once.
export const getVia = (url) => { const [until, at] = (get('via') || '').split('|'); return at === url ? Number(until) || 0 : 0; };
export const setVia = (until, url) => set('via', until ? `${until}|${url}` : null);
