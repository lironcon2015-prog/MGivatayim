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

  const makeFolder = (name) => {
    const files = [];
    const folder = {
      name, description: '', files,
      getName: () => name,
      getDescription: () => folder.description,
      setDescription: (d) => { folder.description = d; },
      isTrashed: () => false,
      getFilesByName: (n) => iterator(files.filter((f) => f.name === n)),
      createFile: (n, text) => {
        const f = {
          name: n, text,
          isTrashed: () => false,
          getBlob: () => ({ getDataAsString: () => f.text }),
          setContent: (t) => { f.text = t; writes++; },
        };
        files.push(f); writes++;
        return f;
      },
    };
    folders.push(folder);
    return folder;
  };

  const sandbox = {
    console,
    JSON, Date, Math, Object, String, Number, Array, Error,
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props.get(k) ?? null }) },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => cache.get(k) ?? null,
        put: (k, v) => { cache.set(k, v); },
        remove: (k) => { cache.delete(k); },
      }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      // Apps Script hands back *signed* bytes; the bridge masks them with
      // & 0xff, and an unsigned shim would hide a missing mask.
      computeDigest: (alg, str) => [...createHash(alg).update(str, 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
    },
    DriveApp: {
      getFoldersByName: (n) => iterator(folders.filter((f) => f.name === n)),
      createFolder: (n) => makeFolder(n),
    },
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
