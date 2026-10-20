// The Cloudflare server: the same bridge as Apps Script (server/gas.js runs
// tools/bridge.gs), answering at the same address shape — POST a JSON text,
// get {ok, result} back. One Durable Object ("the team") holds everything:
// requests reach it one run at a time, so nothing needs a lock, and its
// memory keeps the team's files between requests.
//
// Routes:
//   POST /              the bridge, exactly as Apps Script's /exec
//   GET  /              "who are you" (as doGet)
//   GET  /live          live match updates over a WebSocket (see LIVE below)
//   POST /admin/<op>    the move from Drive, backups (admin code; see ADMIN)
//
// Settings (Cloudflare → Worker → Settings → Variables and Secrets):
//   ADMIN_CODE, CLOUDINARY_CLOUD, CLOUDINARY_KEY, CLOUDINARY_SECRET,
//   NOTIFY_EMAIL — as in Apps Script's Script properties.
//   HELPER_URL, HELPER_TOKEN — the old Apps Script deployment, which still
//   sends the access mail and reads Drive thumbnails (it runs as the owner).
//   ALLOW_IMPORT=1 — only while moving from Drive; remove it after.
import { DurableObject } from 'cloudflare:workers';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createGas } from './gas.js';
import { loadState, applyChanges } from './store.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};
const MAX_BODY = 4 * 1024 * 1024;      // a logo is ~270KB of base64, a season 400K characters
const MAX_FETCH = 6 * 1024 * 1024;     // a page or an image the bridge reads
const FETCH_MS = 15000;
const PROP_KEYS = ['ADMIN_CODE', 'NOTIFY_EMAIL', 'CLOUDINARY_CLOUD', 'CLOUDINARY_KEY', 'CLOUDINARY_SECRET', 'OWNER_EMAIL'];
const MAX_SOCKETS = 300;
const HELLO_MS = 10000;                 // a socket that has not said who it is by then is closed
const BYE = ['not_approved', 'bad_code', 'bad_device'];

export const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
});
// A failure carries its reason: "server error" alone hid every cause before.
const fail = (error, code, status = 200) => json({ ok: false, error, code }, status);

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const team = env.TEAM.get(env.TEAM.idFromName('team'));
    return team.fetch(request);
  },
};

async function readCapped(res, cap) {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > cap) { reader.cancel(); break; }
    parts.push(value);
  }
  const out = new Uint8Array(Math.min(size, cap));
  let at = 0;
  for (const p of parts) { out.set(p.subarray(0, out.length - at), at); at += p.length; if (at >= out.length) break; }
  return out;
}

// UrlFetchApp.fetch, as the bridge expects its answers.
async function webFetch(r) {
  const init = { method: r.method, headers: { ...r.headers }, redirect: r.follow ? 'follow' : 'manual', signal: AbortSignal.timeout(FETCH_MS) };
  if (r.payload != null && r.method !== 'GET') {
    if (typeof r.payload === 'object') init.body = new URLSearchParams(Object.entries(r.payload).map(([k, v]) => [k, String(v)]));
    else { init.body = String(r.payload); if (r.contentType) init.headers['Content-Type'] = r.contentType; }
  }
  const res = await fetch(r.url, init);
  const headers = {};
  const loc = res.headers.get('location');
  if (loc) headers.Location = loc;
  return { status: res.status, headers, bytes: await readCapped(res, MAX_FETCH), type: (res.headers.get('content-type') || '').split(';')[0].trim() };
}

export class Team extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    // The phone's keep-alive is answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.ready = ctx.blockConcurrencyWhile(() => this.boot());
  }

  async boot() {
    const all = new Map();
    for (const prefix of ['meta', 'txt:', 'cache:']) {
      for (const [k, v] of await this.ctx.storage.list({ prefix })) all.set(k, v);
    }
    this.state = loadState(all);
    const props = {};
    for (const k of PROP_KEYS) if (this.env[k] != null) props[k] = String(this.env[k]);
    this.gas = createGas({
      state: this.state,
      props,
      net: { fetch: webFetch, thumb: (id) => this.helperThumb(id) },
      loadBlob: (id) => this.ctx.storage.get('blob:' + id).then((b) => b ?? null),
    });
  }

  sink() {
    const st = this.ctx.storage;
    // Not awaited on purpose: the object's output gate holds the answer until
    // every write is on disk, and writes in one turn land together.
    return { put: (k, v) => { st.put(k, v); }, del: (k) => { st.delete(k); } };
  }

  commit(done) {
    applyChanges(this.sink(), done.changes, this.state);
    if (done.outbox.length) this.ctx.waitUntil(this.flush(done.outbox));
  }

  // What the bridge asked to send after answering: the access mail (through
  // the helper, which sends as the owner) and Cloudinary deletions.
  async flush(outbox) {
    for (const o of outbox) {
      try {
        if (o.kind === 'mail') await this.helper({ action: 'helperMail', to: o.to, subject: o.subject, body: o.body });
        else await webFetch(o.req);
      } catch (e) {
        console.log('after-reply send failed', o.kind, String(e && e.message || e));
      }
    }
  }

  async helper(body) {
    if (!this.env.HELPER_URL || !this.env.HELPER_TOKEN) throw new Error('no helper configured (HELPER_URL, HELPER_TOKEN)');
    const res = await fetch(this.env.HELPER_URL, {
      method: 'POST', body: JSON.stringify({ ...body, token: this.env.HELPER_TOKEN }), signal: AbortSignal.timeout(FETCH_MS),
    });
    const out = await res.json().catch(() => null);
    if (!out || !out.ok) throw new Error('helper: ' + ((out && out.error) || 'HTTP ' + res.status));
    return out.result;
  }

  async helperThumb(id) {
    try {
      const r = await this.helper({ action: 'helperThumb', id });
      return r && r.data ? new Uint8Array(Buffer.from(r.data, 'base64')) : null;
    } catch (e) {
      console.log('thumbnail via helper failed', String(e && e.message || e));
      return null;
    }
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    if (url.pathname === '/live') return this.liveSocket(request);
    if (request.method === 'GET') return json({ ok: true, result: { service: 'mgivatayim-bridge', server: 'cloudflare' } });
    if (request.method !== 'POST') return fail('שיטה לא נתמכת', 'method', 405);
    const len = Number(request.headers.get('content-length') || 0);
    if (len > MAX_BODY) return fail('הבקשה גדולה מדי', 'too_big', 413);
    const text = await request.text();
    if (text.length > MAX_BODY) return fail('הבקשה גדולה מדי', 'too_big', 413);
    if (url.pathname.startsWith('/admin/')) return this.admin(url.pathname.slice(7), text);

    let done;
    try {
      done = await this.gas.handle(text);
    } catch (e) {
      return fail('שגיאה בשרת: ' + String((e && e.message) || e), 'server');
    }
    this.commit(done);
    this.afterWrite(done.changes);
    let out = done.text;
    // The one thing the server adds: "this server can push" — a phone that
    // reads it opens /live and stops asking every few seconds.
    if (/"action"\s*:\s*"getLive"/.test(text) && out.startsWith('{"ok":true')) {
      const o = JSON.parse(out);
      o.result.push = true;
      out = JSON.stringify(o);
    }
    return new Response(out, { headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });
  }

  /* ---------- ADMIN: the move from Drive, and backups ----------
     All with the admin code. Import (and reset) only while ALLOW_IMPORT=1.
       import   {files: [{where: 'root'|'posters', name, text} | {where, id, name, type, data(base64)}]}
       digest   → every file: where, name, id, trashed, sha256 — to compare with Drive
       export   → every text file, and the list of images
       blob     {id} → one image, base64
       reset    → empty the server (a rehearsal starts over) */
  async admin(op, text) {
    let body;
    try { body = JSON.parse(text || '{}'); } catch { return fail('JSON לא תקין', 'bad_json'); }
    if (!this.gas.core.isAdmin_(body)) return fail('קוד מנהל שגוי', 'bad_code');
    const importing = String(this.env.ALLOW_IMPORT || '') === '1';
    try {
      if (op === 'import' || op === 'reset') {
        if (!importing) return fail('ייבוא סגור: ALLOW_IMPORT אינו 1', 'import_closed');
        if (op === 'reset') {
          await this.ctx.storage.deleteAll();
          await this.boot();
          this.afterWrite({ texts: [1] });
          return json({ ok: true, result: { reset: true } });
        }
        const out = [];
        for (const f of body.files || []) {
          const done = this.gas.importFile(f.text != null
            ? { where: f.where, name: f.name, text: f.text, type: f.type }
            : { where: f.where, id: f.id, name: f.name, type: f.type, bytes: Buffer.from(String(f.data || ''), 'base64') });
          this.commit(done);
          out.push(done.result);
        }
        this.afterWrite({ texts: [1] });
        return json({ ok: true, result: { imported: out } });
      }
      if (op === 'digest') return json({ ok: true, result: await this.digest() });
      if (op === 'export') return json({ ok: true, result: this.exportAll() });
      if (op === 'blob') {
        const rec = this.state.fs.files.find((f) => f.id === body.id && f.kind === 'blob');
        const bytes = rec && (this.state.blobs.get(rec.id) || await this.ctx.storage.get('blob:' + rec.id));
        if (!bytes) return fail('התמונה לא נמצאה', 'not_found');
        return json({ ok: true, result: { id: rec.id, name: rec.name, type: rec.type, data: Buffer.from(bytes).toString('base64') } });
      }
      return fail('פעולה לא מוכרת', 'bad_action');
    } catch (e) {
      return fail('שגיאה בשרת: ' + String((e && e.message) || e), 'server');
    }
  }

  where(rec) {
    const folder = this.state.fs.folders.find((f) => f.id === rec.parent);
    return folder && folder.parent == null ? 'root' : folder ? folder.name : '?';
  }

  async digest() {
    const out = [];
    for (const f of this.state.fs.files) {
      let data;
      if (f.kind === 'text') data = Buffer.from(this.state.texts.get(f.id) ?? '', 'utf8');
      else data = this.state.blobs.get(f.id) || await this.ctx.storage.get('blob:' + f.id);
      out.push({ where: this.where(f), name: f.name, id: f.id, trashed: !!f.trashed, sha256: data ? createHash('sha256').update(data).digest('hex') : null });
    }
    return out;
  }

  exportAll() {
    const files = [];
    const images = [];
    for (const f of this.state.fs.files) {
      if (f.trashed) continue;
      if (f.kind === 'text') files.push({ where: this.where(f), name: f.name, text: this.state.texts.get(f.id) ?? '' });
      else images.push({ where: this.where(f), id: f.id, name: f.name, type: f.type });
    }
    return { at: new Date().toISOString(), files, images };
  }

  /* ---------- LIVE: updates pushed over a WebSocket ----------
     A phone opens /live and says who it is in its first message:
       → {type: 'hello', deviceKey, adminCode?, since, watching}
       → {type: 'watching', on}          the live screen opened / closed
       → 'ping'                          keep-alive, answered 'pong' without waking us
     and gets what getLive would have answered it, whenever that changes:
       ← {type: 'live', result}          exactly getLive's result (+ push: true)
       ← {type: 'bye', code, error}      access is gone; the socket closes
     Each phone's answer is computed by the bridge itself (getLive_ with its own
     credentials), so a hidden match, a revoked device or the manager's control
     panel follow the very rules polling follows. The credentials live in the
     socket's attachment, in the runtime's memory — never in storage. */
  liveSocket(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return fail('נדרש WebSocket', 'no_upgrade', 426);
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) return fail('יותר מדי חיבורים חיים', 'too_many', 503);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ opened: Date.now() });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, msg) {
    await this.ready;
    let m = null;
    try { m = JSON.parse(typeof msg === 'string' ? msg : new TextDecoder().decode(msg)); } catch { /* below */ }
    if (!m || typeof m !== 'object') { ws.close(1003, 'bad message'); return; }
    const a = ws.deserializeAttachment() || {};
    if (m.type === 'hello') {
      a.creds = { deviceKey: String(m.deviceKey || '') };
      if (m.adminCode) a.creds.adminCode = String(m.adminCode);
      a.watching = !!m.watching;
      a.v = null;
      a.sig = null;
      ws.serializeAttachment(a);
      await this.pushTo(ws, m.since == null ? null : Number(m.since));
      await this.pushAdmins(ws);
      return;
    }
    if (!a.creds) { ws.close(4000, 'hello first'); return; }
    if (m.type === 'watching') {
      a.watching = !!m.on;
      ws.serializeAttachment(a);
      await this.pushAdmins();
    }
  }

  async webSocketClose(ws) {
    await this.ready;
    try { ws.close(1000, 'bye'); } catch { /* already closed */ }
    // Gone means gone now, not when the 30 seconds of a poll run out —
    // unless the same phone still watches on another socket.
    const a = ws.deserializeAttachment() || {};
    if (a.creds && a.creds.deviceKey && !a.creds.adminCode && a.creds.deviceKey.length >= 32) {
      const still = this.sockets(ws).some((o) => (o.deserializeAttachment() || {}).creds?.deviceKey === a.creds.deviceKey);
      if (!still) this.gas.services.CacheService.getScriptCache().remove('watch:' + this.gas.core.hash_(a.creds.deviceKey));
    }
    await this.pushAdmins(ws);
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  sockets(except = null) {
    return this.ctx.getWebSockets().filter((ws) => ws !== except && ws.readyState === 1);
  }

  // A phone on the live screen is a viewer while its socket is open — not
  // only in the 30 seconds after its last question, as when polling.
  touchWatchers() {
    const cache = this.gas.services.CacheService.getScriptCache();
    for (const ws of this.sockets()) {
      const a = ws.deserializeAttachment() || {};
      if (a.watching && a.creds && !a.creds.adminCode && a.creds.deviceKey.length >= 32) {
        cache.put('watch:' + this.gas.core.hash_(a.creds.deviceKey), String(Date.now()), 120);
      }
    }
  }

  // getLive for one phone, with its own credentials; sent only when it
  // changed for that phone. since: what the phone already has, on hello.
  async pushTo(ws, since = undefined) {
    const a = ws.deserializeAttachment() || {};
    if (!a.creds) return;
    const req = { action: 'getLive', ...a.creds, watching: a.watching };
    const have = since !== undefined ? since : a.v;
    if (have != null) req.since = have;
    const done = await this.gas.handle(JSON.stringify(req));
    this.commit(done);
    const out = JSON.parse(done.text);
    if (!out.ok) {
      if (BYE.includes(out.code)) {
        try { ws.send(JSON.stringify({ type: 'bye', code: out.code, error: out.error })); ws.close(4001, out.code); } catch { /* gone */ }
      }
      return;
    }
    const r = out.result;
    r.push = true;
    const sig = JSON.stringify([r.canControl, !!r.hidden, !!r.isAdmin, r.control || null]);
    if (r.unchanged && sig === a.sig) return;
    a.v = r.version;
    a.sig = sig;
    ws.serializeAttachment(a);
    try { ws.send(JSON.stringify({ type: 'live', result: r })); } catch { /* closing */ }
  }

  // The manager's panel counts viewers: tell the managers when that changes.
  async pushAdmins(except = null) {
    this.touchWatchers();
    for (const ws of this.sockets(except)) {
      const a = ws.deserializeAttachment() || {};
      if (a.creds && a.creds.adminCode) await this.pushTo(ws);
    }
  }

  async broadcast() {
    this.touchWatchers();
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() || {};
      if (!a.creds) {
        if (now - (a.opened || 0) > HELLO_MS) { try { ws.close(4000, 'hello first'); } catch { /* gone */ } }
        continue;
      }
      if (ws.readyState === 1) await this.pushTo(ws);
    }
  }

  // Anything written may change what a phone sees (the match, its access,
  // its role): every open socket is asked again.
  afterWrite(changes) {
    if (!changes || !(changes.texts?.length || changes.meta)) return;
    if (!this.ctx.getWebSockets().length) return;
    this.ctx.waitUntil(this.broadcast());
  }
}
