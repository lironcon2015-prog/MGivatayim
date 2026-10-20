// The Apps Script services bridge.gs uses, rebuilt over plain memory, so the
// same bridge runs on the Cloudflare server. Nothing here knows Cloudflare:
// the server (server/worker.js) and the tests (tests/server-bridge.mjs) both
// hand it a place to keep things and a way to reach the web.
//
// Three things Apps Script gives that a server does not, and how they are kept:
//
//   1. Synchronous Drive and fetch. The bridge reads a file or a web page and
//      uses the answer on the next line. Here every file's text is already in
//      memory (the whole team is a few hundred KB), and anything that is not —
//      a web page, a stored image — is fetched *between* runs: the run notes
//      what it needs and stops counting; the request waits for it and runs the
//      bridge again from the top, now with the answer at hand. The bridge
//      catches errors in places (findPoster_), so "stops" is a flag on the run,
//      not an exception anyone can swallow.
//
//   2. A run that is thrown away leaves no trace. Before each run the state is
//      copied; a run that needed something is rolled back to the copy, so a
//      write it made before reaching the fetch is not done twice. Only the run
//      that finishes is kept, and only then is it written to storage. One run
//      is synchronous from start to end, so no other request lands inside it:
//      that is what LockService used to give, and why the lock here is free.
//
//   3. The cache is memory. What decides something later — an upload's
//      signature, the hourly upload count, the "mail already sent" mark — is
//      also kept in storage (PERSIST_CACHE), because the server forgets its
//      memory when it sleeps, and a signature lost between "sign" and "add"
//      would drop a photo the parent already uploaded, with no error.
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { bridgeCore } from './bridge-core.js';

export const PERSIST_CACHE = /^(sig:|signs:|mail:)/;
const MAX_RUNS = 8;

/* ---------- state ---------- */

// fs: folder and file records (no content). texts: file id → text.
// blobs: file id → bytes, for images, loaded on demand. cache: key → {v, exp}.
export function emptyState() {
  return { fs: { folders: [], files: [] }, texts: new Map(), blobs: new Map(), cache: new Map() };
}

function snapshot(s) {
  return {
    fs: JSON.parse(JSON.stringify(s.fs)),
    fsJson: JSON.stringify(s.fs),
    texts: new Map(s.texts), blobs: new Map(s.blobs), cache: new Map(s.cache),
  };
}

function restore(s, snap) {
  s.fs = snap.fs; s.texts = snap.texts; s.blobs = snap.blobs; s.cache = snap.cache;
}

const idChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
function newId() {
  const r = new Uint8Array(28);
  crypto.getRandomValues(r);
  return 'S' + [...r].map((b) => idChars[b & 63]).join('');
}

function iterator(items) {
  let i = 0;
  return { hasNext: () => i < items.length, next: () => items[i++] };
}

const toBytes = (b) => (b instanceof Uint8Array ? b : Uint8Array.from(b, (x) => x & 0xff));

/* ---------- the services ---------- */

// props: Script properties. net.fetch(req) → Promise<{status, headers, bytes, type}>
// or net.fetchSync for tests. net.thumb(id) → bytes or null (a Drive file's
// thumbnail, through the helper in Apps Script). loadBlob(id) → bytes or null,
// a promise on the server and a plain value in the tests (net.sync).
// Images stay in memory only until they are written: a read comes from
// storage each time, so a season of posters never piles up in memory.
export function createGas({ state, props = {}, net = {}, loadBlob = null }) {
  // { needs: Map(key → loader), resolved: Map(key → value), outbox: [], newBlobs: Set }
  let run = null;
  const log = { fetched: [], walks: 0 };

  const need = (key, loader) => {
    if (run.resolved.has(key)) return run.resolved.get(key);
    if (net.sync) {           // tests: everything answers at once
      const v = loader(true);
      run.resolved.set(key, v);
      return v;
    }
    run.needs.set(key, loader);
    throw new Error('pending: ' + key);
  };

  const makeBlob = (bytes, type, name = '') => {
    const b = {
      getBytes: () => bytes,
      getContentType: () => type,
      getDataAsString: () => Buffer.from(bytes).toString('utf8'),
      getName: () => name,
      setName: (n) => { name = n; return b; },
      _bytes: () => bytes,
    };
    return b;
  };

  const folderRec = (id) => state.fs.folders.find((f) => f.id === id);
  const fileRec = (id) => state.fs.files.find((f) => f.id === id);

  const fileObj = (id) => {
    const rec = () => fileRec(id);
    const f = {
      getId: () => id,
      getName: () => rec().name,
      isTrashed: () => !!rec().trashed,
      setTrashed: (t) => { rec().trashed = !!t; return f; },
      getParents: () => iterator(rec().parent ? [folderObj(rec().parent)] : []),
      getBlob: () => {
        const r = rec();
        if (r.kind === 'text') return makeBlob(Buffer.from(state.texts.get(id) ?? '', 'utf8'), r.type || 'application/json', r.name);
        let bytes = state.blobs.get(id);
        if (!bytes) {
          bytes = need('blob:' + id, () => (loadBlob ? loadBlob(id) : null));
          if (!bytes || bytes.error) throw new Error('blob missing: ' + id);
        }
        return makeBlob(bytes, r.type || 'application/octet-stream', r.name);
      },
      setContent: (text) => { state.texts.set(id, String(text)); return f; },
      getThumbnail: () => null,
    };
    return f;
  };

  // A file of the manager's that is not ours (a video in their Drive): only
  // its thumbnail is ever asked for, through the helper in Apps Script.
  const outsideFile = (id) => ({
    getId: () => id,
    isTrashed: () => false,
    getParents: () => iterator([]),
    getBlob: () => { throw new Error('No item with the given ID could be found'); },
    getThumbnail: () => {
      const bytes = need('thumb:' + id, (sync) => (sync ? net.thumbSync?.(id) ?? null : net.thumb ? net.thumb(id) : null));
      if (!bytes || bytes.error) throw new Error('No item with the given ID could be found');
      return makeBlob(toBytes(bytes), 'image/jpeg', id);
    },
  });

  const folderObj = (id) => {
    const rec = () => folderRec(id);
    const kids = (list, n) => list.filter((x) => x.parent === id && x.name === n);
    const fo = {
      getId: () => id,
      getName: () => rec().name,
      isTrashed: () => !!rec().trashed,
      getDescription: () => rec().desc || '',
      setDescription: (d) => { rec().desc = String(d); return fo; },
      getFilesByName: (n) => iterator(kids(state.fs.files, n).map((r) => fileObj(r.id))),
      getFoldersByName: (n) => iterator(kids(state.fs.folders, n).map((r) => folderObj(r.id))),
      getFiles: () => iterator(state.fs.files.filter((x) => x.parent === id).map((r) => fileObj(r.id))),
      createFolder: (n) => makeFolder(n, id),
      // createFile(name, text, mime) for JSON, createFile(blob) for images.
      createFile: (a, text, mime) => {
        const fid = newId();
        if (typeof a === 'string') {
          state.fs.files.push({ id: fid, name: a, parent: id, kind: 'text', type: mime || 'text/plain', trashed: false });
          state.texts.set(fid, String(text ?? ''));
        } else {
          state.fs.files.push({ id: fid, name: a.getName(), parent: id, kind: 'blob', type: a.getContentType(), trashed: false });
          state.blobs.set(fid, toBytes(a._bytes ? a._bytes() : a.getBytes()));
          run?.newBlobs.add(fid);
        }
        return fileObj(fid);
      },
    };
    return fo;
  };

  const makeFolder = (name, parent = null) => {
    const id = newId();
    state.fs.folders.push({ id, name, parent, desc: '', trashed: false });
    return folderObj(id);
  };

  const fetchKey = (url, o) => 'fetch:' + JSON.stringify([url, o.method || 'get', o.payload || null, o.followRedirects !== false, o.headers || null]);
  const toRequest = (url, o) => ({
    url, method: String(o.method || 'get').toUpperCase(), headers: o.headers || {},
    payload: o.payload ?? null, contentType: o.contentType || null, follow: o.followRedirects !== false,
  });
  const response = (r, o) => {
    if (r.error) throw new Error(r.error);
    if (!o.muteHttpExceptions && r.status >= 400) throw new Error('Request failed with code ' + r.status);
    return {
      getResponseCode: () => r.status,
      getContentText: () => Buffer.from(r.bytes).toString('utf8'),
      getBlob: () => makeBlob(toBytes(r.bytes), r.type || 'application/octet-stream'),
      getHeaders: () => r.headers || {},
    };
  };

  const services = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (props[k] == null ? null : String(props[k])) }) },
    CacheService: {
      getScriptCache: () => {
        const live = (k) => { const e = state.cache.get(k); return e && e.exp > Date.now() ? e : null; };
        const put = (k, v, ttl = 600) => { state.cache.set(k, { v: String(v), exp: Date.now() + Math.min(ttl, 21600) * 1000 }); };
        return {
          get: (k) => live(k)?.v ?? null,
          put,
          putAll: (all, ttl) => { for (const [k, v] of Object.entries(all)) put(k, v, ttl); },
          remove: (k) => { state.cache.delete(k); },
          getAll: (keys) => Object.fromEntries(keys.filter((k) => live(k)).map((k) => [k, live(k).v])),
        };
      },
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256', SHA_1: 'sha1' },
      Charset: { UTF_8: 'utf8' },
      // Signed bytes, as Apps Script hands them back; the bridge masks them.
      computeDigest: (alg, str) => [...createHash(alg).update(String(str), 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
      base64Encode: (bytes) => Buffer.from(toBytes(bytes)).toString('base64'),
      base64Decode: (str) => new Uint8Array(Buffer.from(String(str), 'base64')),
      newBlob: (bytes, type, name) => makeBlob(toBytes(bytes), type, name),
    },
    DriveApp: {
      getFoldersByName: (n) => { log.walks++; return iterator(state.fs.folders.filter((f) => f.parent == null && f.name === n).map((r) => folderObj(r.id))); },
      createFolder: (n) => makeFolder(n),
      getFileById: (id) => {
        id = String(id);
        if (fileRec(id)) return fileObj(id);
        if (/^[\w-]{10,}$/.test(id)) return outsideFile(id);
        throw new Error('No item with the given ID could be found');
      },
    },
    UrlFetchApp: {
      fetch: (url, o = {}) => {
        log.fetched.push({ url, opts: o });
        const req = toRequest(url, o);
        return response(need(fetchKey(url, o), (sync) => (sync ? net.fetchSync(req) : net.fetch(req))), o);
      },
      // Only Cloudinary deletions use it, and they ignore the answers: sent
      // after the request is answered, never waited on.
      fetchAll: (reqs) => reqs.map((r) => {
        log.fetched.push({ url: r.url, opts: r });
        run.outbox.push({ kind: 'fetch', req: toRequest(r.url, r) });
        return { getResponseCode: () => 200, getContentText: () => '', getHeaders: () => ({}) };
      }),
    },
    MailApp: { sendEmail: (to, subject, body) => { run.outbox.push({ kind: 'mail', to, subject, body }); } },
    // "Whoever the bridge runs as" — the helper in Apps Script knows; the
    // server only says "the owner".
    Session: { getEffectiveUser: () => ({ getEmail: () => String(props.OWNER_EMAIL || '@owner') }) },
    ContentService: {
      MimeType: { JSON: 'application/json', JAVASCRIPT: 'application/javascript' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
  };

  const core = bridgeCore(services);

  // One request: run until a run needs nothing it does not have. Returns the
  // bridge's answer text, what changed (for storage), and what to send after.
  async function handle(bodyText) {
    const resolved = new Map();      // this request's answers, kept across its runs
    for (let i = 0; i < MAX_RUNS; i++) {
      const snap = snapshot(state);
      run = { needs: new Map(), resolved, outbox: [], newBlobs: new Set() };
      const out = core.doPost({ postData: { contents: bodyText }, parameter: {} });
      if (run.needs.size) {
        const needs = [...run.needs];
        restore(state, snap);
        run = null;
        await Promise.all(needs.map(async ([key, load]) => {
          try { resolved.set(key, await load(false)); } catch (e) { resolved.set(key, { error: String((e && e.message) || e) }); }
        }));
        continue;
      }
      const done = { text: out.text, changes: diff(snap, state, run.newBlobs), outbox: run.outbox };
      run = null;
      return done;
    }
    run = null;
    throw new Error('the request needed the network too many times');
  }

  // Tests: nothing to wait for.
  function handleSync(bodyText) {
    const snap = snapshot(state);
    run = { needs: new Map(), resolved: new Map(), outbox: [], newBlobs: new Set() };
    const out = core.doPost({ postData: { contents: bodyText }, parameter: {} });
    const done = { text: out.text, changes: diff(snap, state, run.newBlobs), outbox: run.outbox };
    run = null;
    return done;
  }

  // The server's own work on the same state (the import from Drive): one
  // synchronous run, kept or written like a request.
  function exec(fn) {
    const snap = snapshot(state);
    run = { needs: new Map(), resolved: new Map(), outbox: [], newBlobs: new Set() };
    try {
      const result = fn();
      if (run.needs.size) throw new Error('exec cannot wait for the network');
      return { result, changes: diff(snap, state, run.newBlobs), outbox: run.outbox };
    } catch (e) {
      restore(state, snap);
      throw e;
    } finally {
      run = null;
    }
  }

  // A file from Drive, under the id Drive gave it: the season refers to its
  // posters by that id, so it must not change on the way over. A text file
  // replaces the live file of its name; an image replaces the one with its id.
  function importFile({ where, id, name, text, bytes, type }) {
    return exec(() => {
      const folder = where === 'posters' ? core.posterDir_() : core.root_();
      const parent = folder.getId();
      const cache = services.CacheService.getScriptCache();
      if (text != null) {
        const live = state.fs.files.find((f) => f.parent === parent && f.name === name && !f.trashed);
        if (live) state.texts.set(live.id, String(text));
        else folder.createFile(name, String(text), type || 'application/json');
        // Whatever the cache held of this file is from before the import.
        cache.remove(name);
        cache.remove('fid:' + name);
        return { name };
      }
      if (!/^[\w-]{10,}$/.test(String(id || ''))) throw new Error('bad id: ' + id);
      const old = state.fs.files.findIndex((f) => f.id === id);
      if (old >= 0) state.fs.files.splice(old, 1);
      state.fs.files.push({ id, name, parent, kind: 'blob', type: type || 'application/octet-stream', trashed: false });
      state.blobs.set(id, toBytes(bytes));
      run.newBlobs.add(id);
      return { id };
    });
  }

  return { handle, handleSync, exec, importFile, core, log, services };
}

// What a finished run changed, as storage writes.
function diff(snap, s, newBlobs) {
  const ch = { meta: null, texts: [], blobs: [], cache: [] };
  const fsJson = JSON.stringify(s.fs);
  if (fsJson !== snap.fsJson) ch.meta = fsJson;
  for (const [id, t] of s.texts) if (snap.texts.get(id) !== t) ch.texts.push([id, t]);
  for (const id of newBlobs) if (s.blobs.has(id)) ch.blobs.push([id, s.blobs.get(id)]);
  for (const [k, e] of s.cache) if (PERSIST_CACHE.test(k) && snap.cache.get(k) !== e) ch.cache.push([k, e]);
  for (const k of snap.cache.keys()) if (PERSIST_CACHE.test(k) && !s.cache.has(k)) ch.cache.push([k, null]);
  return ch;
}
