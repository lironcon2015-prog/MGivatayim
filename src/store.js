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
  if (!key || key.length < 64) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    key = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    set('device', key);
  }
  return key;
}

export const getName = () => get('name') || '';
export const setName = (n) => set('name', n);

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

export function forgetAccess() {
  setCachedSeason(null);
  set('liveLast', null);
}

// Tests point the app at a local bridge through this key. It is read from
// storage only, never from the URL: a link that could redirect the app to a
// foreign bridge would be a way to harvest the manager's code.
export const bridgeOverride = () => get('bridge') || '';
