// The Cloudflare server's bridge (server/gas.js over server/bridge-core.js),
// in-process, with the same face as mock-bridge.mjs — so every test written
// for the Apps Script bridge runs, unchanged, against the server too:
//
//   BRIDGE=server node tests/bridge.mjs
//
// Storage is a Map that outlives the server's memory: restart() throws the
// memory away and loads again from it, as Cloudflare does when the server
// sleeps. A test that passes only while memory lasts fails after restart().
import { createServer } from 'node:http';
import { createGas } from '../server/gas.js';
import { loadState, applyChanges } from '../server/store.js';

export function createBridge({ adminCode = 'test-admin-code-1234' } = {}) {
  const disk = new Map();                 // what Cloudflare keeps
  const props = { ADMIN_CODE: adminCode, OWNER_EMAIL: 'owner@example.com' };
  const web = new Map();
  const drivePics = new Map();
  const mails = [];
  const sent = [];                        // fire-and-forget requests (Cloudinary)
  let gas, state;
  let writes = 0;

  const fetchSync = (req) => {
    const hit = web.get(req.url);
    if (hit?.location) return { status: 302, headers: { Location: hit.location }, bytes: new Uint8Array(0), type: 'text/html' };
    const body = Buffer.from(hit ? hit.body : 'not found');
    return { status: hit ? 200 : 404, headers: {}, bytes: new Uint8Array(body), type: hit ? hit.type : 'text/html' };
  };

  const boot = () => {
    state = loadState(disk);
    const fetched = gas ? gas.log.fetched : [];
    const walks = gas ? gas.log.walks : 0;
    gas = createGas({
      state, props,
      net: { sync: true, fetchSync, thumbSync: (id) => drivePics.get(id) ?? null },
      loadBlob: (id) => disk.get('blob:' + id) ?? null,
    });
    gas.log.fetched = fetched;
    gas.log.walks = walks;
  };
  boot();

  const post = (body) => {
    const done = gas.handleSync(typeof body === 'string' ? body : JSON.stringify(body));
    writes += done.changes.texts.length;
    applyChanges(disk, done.changes, state);
    // Sent after the answer, as the server does: a failure here is not the request's.
    for (const o of done.outbox) { try { (o.kind === 'mail' ? mails : sent).push(o); } catch { /* lost mail */ } }
    return JSON.parse(done.text);
  };

  const root = () => state.fs.folders.find((f) => f.parent == null);
  const filesNamed = (name) => state.fs.files.filter((f) => f.parent === root()?.id && f.name === name);
  // A file as the tests handle it in mock-bridge: its text and trash flag,
  // changed "behind the bridge's back" — in memory and on disk both.
  const fileHandle = (id) => {
    const rec = () => state.fs.files.find((f) => f.id === id);
    return {
      get name() { return rec().name; },
      get text() { return state.texts.get(id) ?? null; },
      set text(t) { state.texts.set(id, t); disk.set('txt:' + id, t); },
      setContent(t) { this.text = t; },
      getId: () => id,
      isTrashed: () => !!rec().trashed,
      setTrashed: (t) => { rec().trashed = !!t; disk.set('meta', JSON.stringify(state.fs)); },
    };
  };

  return {
    post,
    driveFile: (name) => { const f = filesNamed(name).find((x) => !x.trashed) || filesNamed(name)[0]; return f ? state.texts.get(f.id) ?? null : null; },
    // "Time has passed": every entry expires, the stored ones too.
    clearCache: () => {
      state.cache.clear();
      for (const k of [...disk.keys()]) if (k.startsWith('cache:')) disk.delete(k);
    },
    get fetched() { return gas.log.fetched; },
    mails,
    sent,
    web: (url, type, body) => web.set(url, { type, body }),
    redirect: (url, location) => web.set(url, { location }),
    drivePicture: (id, bytes) => drivePics.set(id, bytes),
    fileById: (id) => (state.fs.files.some((f) => f.id === id) ? fileHandle(id) : null),
    driveFileId: (name) => filesNamed(name)[0]?.id ?? null,
    setProp: (k, v) => { props[k] = v; },
    get writes() { return writes; },
    get walks() { return gas.log.walks; },
    driveFiles: (name) => filesNamed(name).map((r) => fileHandle(r.id)),
    fn: (name) => gas.core[name],
    // Server only: what is on disk, and a cold start from it.
    disk,
    restart: boot,
  };
}

export function serveBridge(bridge, port) {
  const server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Access-Control-Allow-Origin': '*' });
      res.end();
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const out = bridge.post(body);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
