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

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { method: 'POST', body: JSON.stringify(body), signal: ctrl.signal });
  } catch (e) {
    throw new BridgeError(
      e?.name === 'AbortError' ? 'השרת לא ענה בזמן. נסו שוב.' : 'אין חיבור לשרת. בדקו את הרשת ונסו שוב.',
      'network');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new BridgeError(`השרת החזיר שגיאה (${res.status}).`, 'http');

  let json;
  try { json = await res.json(); } catch { json = null; }
  // A non-JSON answer is almost always a Google HTML page: the URL is not the
  // /exec deployment, or the deployment was never authorised.
  if (!json) throw new BridgeError('תשובה לא תקינה מהשרת. ודאו שהכתובת מסתיימת ב-/exec.', 'bad_reply');
  if (!json.ok) throw new BridgeError(json.error || 'שגיאה בשרת.', json.code);
  return json.result;
}
