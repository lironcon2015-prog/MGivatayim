// Runs the real tools/bridge.gs under Node, on in-memory stand-ins for the
// Apps Script services it uses. The point is that tests exercise the actual
// server code — a hand-written imitation of the bridge would pass while the
// .gs file that gets deployed stayed broken.
//
//   node tests/mock-bridge.mjs [port]        → HTTP server, like the /exec URL
//   import { createBridge } from './mock-bridge.mjs'   → in-process, for units
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const GS = fileURLToPath(new URL('../tools/bridge.gs', import.meta.url));

function iterator(items) {
  let i = 0;
  return { hasNext: () => i < items.length, next: () => items[i++] };
}

export function createBridge({ adminCode = 'test-admin-code-1234' } = {}) {
  const folders = [];
  const cache = new Map();
  const props = new Map([['ADMIN_CODE', adminCode]]);
  let writes = 0;

  // Files and folders get ids like Drive's, so getFileById and getParents
  // behave: the poster check depends on a file knowing which folder it is in.
  const byId = new Map();
  let nextId = 1;
  const newId = (kind) => `${kind}${String(nextId++).padStart(12, '0')}`;
  const makeBlob = (bytes, type, name = '') => {
    const b = {
      name, getBytes: () => [...bytes], getContentType: () => type,
      getDataAsString: () => Buffer.from(bytes).toString('utf8'),
      setName: (n) => { b.name = n; return b; }, getName: () => b.name,
    };
    return b;
  };

  const makeFolder = (name, parent = null) => {
    const files = [];
    const subs = [];
    const id = newId('fold');
    const folder = {
      name, description: '', files, id,
      getId: () => id,
      getName: () => name,
      getDescription: () => folder.description,
      setDescription: (d) => { folder.description = d; },
      isTrashed: () => false,
      getFilesByName: (n) => iterator(files.filter((f) => f.name === n && !f.trashed)),
      getFoldersByName: (n) => iterator(subs.filter((f) => f.name === n)),
      createFolder: (n) => { const f = makeFolder(n, folder); subs.push(f); return f; },
      // createFile(name, text) for JSON, createFile(blob) for images — as in Apps Script.
      createFile: (a, text) => {
        const blob = typeof a === 'string' ? null : a;
        const fid = newId('file');
        const f = {
          name: blob ? blob.getName() : a, text, trashed: false, blob,
          getId: () => fid,
          isTrashed: () => f.trashed,
          setTrashed: (t) => { f.trashed = t; },
          getParents: () => iterator([folder]),
          getBlob: () => f.blob || { getDataAsString: () => f.text },
          setContent: (t) => { f.text = t; writes++; },
        };
        files.push(f); byId.set(fid, f); writes++;
        return f;
      },
    };
    if (!parent) folders.push(folder);
    return folder;
  };

  // The web as the bridge sees it through UrlFetchApp: tests register pages
  // and images by URL; anything else is a 404.
  const web = new Map();
  const fetched = [];
  const drivePics = new Map();
  const mails = [];

  const sandbox = {
    console,
    JSON, Date, Math, Object, String, Number, Array, Error, RegExp,
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props.get(k) ?? null }) },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => cache.get(k) ?? null,
        put: (k, v) => { cache.set(k, v); },
        remove: (k) => { cache.delete(k); },
        getAll: (keys) => Object.fromEntries(keys.filter((k) => cache.has(k)).map((k) => [k, cache.get(k)])),
      }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256', SHA_1: 'sha1' },
      Charset: { UTF_8: 'utf8' },
      // Apps Script hands back *signed* bytes; the bridge masks them with
      // & 0xff, and an unsigned shim would hide a missing mask.
      computeDigest: (alg, str) => [...createHash(alg).update(str, 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
      base64Encode: (bytes) => Buffer.from(bytes.map((b) => b & 0xff)).toString('base64'),
      base64Decode: (str) => [...Buffer.from(str, 'base64')].map((b) => (b > 127 ? b - 256 : b)),
      newBlob: (bytes, type, name) => makeBlob(bytes, type, name),
    },
    DriveApp: {
      getFoldersByName: (n) => iterator(folders.filter((f) => f.name === n)),
      createFolder: (n) => makeFolder(n),
      getFileById: (id) => {
        if (byId.has(id)) return byId.get(id);
        // A video file of the manager's elsewhere in Drive: only its thumbnail matters.
        if (drivePics.has(id)) return { getThumbnail: () => makeBlob(drivePics.get(id), 'image/jpeg') };
        throw new Error('No item with the given ID could be found');
      },
    },
    UrlFetchApp: {
      fetchAll: (reqs) => reqs.map((r) => sandbox.UrlFetchApp.fetch(r.url, r)),
      fetch: (url, opts) => {
        fetched.push({ url, opts });
        const hit = web.get(url);
        const code = hit ? 200 : 404;
        const body = hit ? Buffer.from(hit.body) : Buffer.from('not found');
        return {
          getResponseCode: () => code,
          getContentText: () => body.toString('utf8'),
          getBlob: () => makeBlob([...body], hit ? hit.type : 'text/html'),
        };
      },
    },
    MailApp: { sendEmail: (to, subject, body) => { mails.push({ to, subject, body }); } },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(GS, 'utf8'), sandbox, { filename: 'bridge.gs' });

  return {
    post(body) {
      const out = sandbox.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } });
      return JSON.parse(out.text);
    },
    // Test hooks: what landed in "Drive", and a way to drop the cache so a
    // test can prove a value came from the file and not from memory.
    driveFile: (name) => folders[0]?.files.find((f) => f.name === name)?.text ?? null,
    clearCache: () => cache.clear(),
    fetched,
    mails,
    web: (url, type, body) => web.set(url, { type, body }),
    drivePicture: (id, bytes) => drivePics.set(id, bytes),
    fileById: (id) => byId.get(id) ?? null,
    driveFileId: (name) => folders[0]?.files.find((f) => f.name === name)?.getId() ?? null,
    setProp: (k, v) => props.set(k, v),
    get writes() { return writes; },
  };
}

export function serveBridge(bridge, port) {
  const server = createServer((req, res) => {
    // Apps Script never answers a CORS preflight. Refusing OPTIONS here is
    // what makes the tests fail if the client ever grows a Content-Type
    // header and stops sending a "simple" request.
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || 8799);
  await serveBridge(createBridge(), port);
  console.log(`mock bridge on http://localhost:${port}  (admin code: test-admin-code-1234)`);
}
