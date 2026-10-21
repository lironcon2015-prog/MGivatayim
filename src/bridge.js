import { BRIDGE_URL, FALLBACK_URL } from './config.js';
import { bridgeOverride, fallbackOverride, deviceKey, getAdminCode, getVia, setVia } from './store.js';

const TIMEOUT_MS = 30000;

export const bridgeUrl = () => bridgeOverride() || BRIDGE_URL;
export const bridgeConfigured = () => !!bridgeUrl();
// A test's local bridge has no way around unless the test gives it one.
const fallbackUrl = () => (bridgeOverride() ? fallbackOverride() : FALLBACK_URL);

// The way around (config.js). A read the server never answered — the network
// failed, or nothing came back in time — is asked again through Google at
// once; when that answers, the network is the problem, and every request goes
// around for VIA_MS. Then a read tries the server again, and a write goes
// around while a 'hello' asks whether the server is back: a write is sent
// once, never to a server that may not be there (see RETRY_SAFE).
// A network that blocks the server only ever answers a read through Google,
// so a phone back from the background, with no network at all, does not switch.
const VIA_MS = 10 * 60 * 1000;
const route = (until) => {
  setVia(until, bridgeUrl());
  // The footer says which way this phone goes (app.js) — the owner asked how to tell.
  const el = typeof document !== 'undefined' && document.getElementById('app-route');
  if (el) el.hidden = !until;
};
const goAround = () => route(Date.now() + VIA_MS);
export const goingAround = () => !!fallbackUrl() && getVia(bridgeUrl()) > Date.now();
const unreached = (e) => e.code === 'network';
let probing = null;
function probe() {
  probing ||= send(bridgeUrl(), JSON.stringify({ action: 'hello', deviceKey: deviceKey() }))
    .then(() => route(0), (e) => { if (unreached(e)) goAround(); })
    .finally(() => { probing = null; });
}

export class BridgeError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || 'error';
  }
}

// Reads only. A request that failed on the way may still have reached the
// bridge and been done — only its answer lost — so a write sent again could
// land twice (a season save refused as "changed elsewhere" after it saved,
// a gallery row added twice). Anything not listed here, an action added later
// included, is sent once. The live queue (putLive, finishLive) has its own.
const RETRY_SAFE = new Set(['hello', 'getSeason', 'getLive', 'getPoster', 'getGallery', 'adminPing', 'listUsers']);
const RETRY_AFTER_MS = 1000;
// What one quiet retry answers: a phone back from the background before its
// network woke, a request cut when the app went away, Google failing an
// execution before the script ran. Not a timeout — that already waited 30 s.
const RETRY_CODES = new Set(['network', 'http', 'bad_reply']);

// No headers, on purpose. A string body with no explicit Content-Type goes
// out as text/plain, which keeps this a CORS "simple" request with no
// preflight. Apps Script never answers OPTIONS, so adding
// 'Content-Type: application/json' here breaks every call with an opaque
// network error. tests/mock-bridge.mjs refuses OPTIONS to hold this line.
export async function call(action, params = {}, { asAdmin = false } = {}) {
  const url = bridgeUrl();
  if (!url) throw new BridgeError('האפליקציה עוד לא חוברה לדרייב.', 'setup');

  const body = { action, deviceKey: deviceKey(), ...params };
  if (asAdmin) body.adminCode = params.adminCode ?? getAdminCode();
  const text = JSON.stringify(body);

  const alt = fallbackUrl();
  const read = RETRY_SAFE.has(action);
  const via = alt ? getVia(url) : 0;
  if (via > Date.now()) return send(alt, text);
  if (via && !read) { probe(); return send(alt, text); }

  try {
    const r = await send(url, text);
    if (via) route(0);
    return r;
  } catch (e) {
    if (read && alt && unreached(e)) {
      let r;
      // Any answer through Google, a refusal included, says the way around works.
      try { r = await send(alt, text); } catch (e2) { if (!unreached(e2)) goAround(); throw e2; }
      goAround();
      return r;
    }
    if (!read || !RETRY_CODES.has(e.code) || e.timeout || (e.code === 'http' && e.status < 500)) throw e;
    await new Promise((r) => setTimeout(r, RETRY_AFTER_MS));
    return send(url, text);
  }
}

async function send(url, text) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { method: 'POST', body: text, signal: ctrl.signal });
  } catch (e) {
    // A timeout keeps the code 'network': the live queue retries on it, and
    // anything else would drop the queue as refused for good.
    const err = new BridgeError(
      e?.name === 'AbortError' ? 'השרת לא ענה בזמן. נסו שוב.' : 'אין חיבור לשרת. בדקו את הרשת ונסו שוב.',
      'network');
    err.timeout = e?.name === 'AbortError';
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const err = new BridgeError(`השרת החזיר שגיאה (${res.status}).`, 'http');
    err.status = res.status;
    throw err;
  }

  let json;
  try { json = await res.json(); } catch { json = null; }
  // A non-JSON answer is almost always a Google HTML page: the URL is not the
  // /exec deployment, or the deployment was never authorised.
  if (!json) throw new BridgeError('תשובה לא תקינה מהשרת. ודאו שהכתובת מסתיימת ב-/exec.', 'bad_reply');
  if (!json.ok) throw new BridgeError(json.error || 'שגיאה בשרת.', json.code);
  return json.result;
}
