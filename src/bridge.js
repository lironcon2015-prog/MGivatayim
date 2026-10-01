import { BRIDGE_URL } from './config.js';
import { bridgeOverride, deviceKey, getAdminCode } from './store.js';

const TIMEOUT_MS = 30000;

export const bridgeUrl = () => bridgeOverride() || BRIDGE_URL;
export const bridgeConfigured = () => !!bridgeUrl();

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

  try {
    return await send(url, text);
  } catch (e) {
    if (!RETRY_SAFE.has(action) || !RETRY_CODES.has(e.code) || e.timeout || (e.code === 'http' && e.status < 500)) throw e;
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
