// The Cloudflare server (server/): the bridge moved off Apps Script.
//   node tests/server.mjs
//
//   1. server/bridge-core.js is tools/bridge.gs, unchanged (make-server --check)
//   2. every test of tests/bridge.mjs, against the server's bridge
//   3. what only the server has: storage that outlives memory, runs that wait
//      for the network and start over, an identity that must match Drive's
//   4. the real thing — server/worker.js in workerd (miniflare), over HTTP
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge } from './server-bridge.mjs';
import { createBridge as createGasBridge } from './mock-bridge.mjs';
import { createGas } from '../server/gas.js';
import { loadState, applyChanges, CHUNK } from '../server/store.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ADMIN = 'test-admin-code-1234';
let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('  ✓', name); } catch (e) { failures.push(name); console.log('  ✗', name, '\n   ', (e && e.stack) || e); }
};
const err = (r) => (r.ok ? null : r.code);
const dev = (c) => c.repeat(64);

/* ---------- 1–2: the same bridge ---------- */
console.log('same bridge:');

await test('server/bridge-core.js is tools/bridge.gs as it stands', () => {
  const r = spawnSync(process.execPath, ['tools/make-server.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

await test('every rule of tests/bridge.mjs holds on the server', () => {
  const r = spawnSync(process.execPath, ['tests/bridge.mjs'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, BRIDGE: 'server' } });
  assert.equal(r.status, 0, (r.stdout || '').split('\n').slice(-30).join('\n') + r.stderr);
  const n = (r.stdout.match(/bridge: (\d+) passed/) || [])[1];
  assert.ok(Number(n) >= 90, 'fewer bridge tests than expected: ' + n);
});

/* ---------- 3: what only the server has ---------- */
console.log('storage and identity:');

const approved = (b, key, name = 'הורה') => {
  b.post({ action: 'requestAccess', deviceKey: key, name });
  const id = b.post({ action: 'listUsers', adminCode: ADMIN }).result.find((u) => u.name === name).id;
  b.post({ action: 'setStatus', adminCode: ADMIN, id, status: 'approved' });
  return id;
};
const hebrewSeason = (chars) => {
  const players = [];
  let n = 0;
  while (JSON.stringify(players).length < chars) players.push({ id: 'p' + n, name: `שחקן מספר ${n++} עם שם משפחה ארוך בעברית ✓ 😀` });
  return { team: { name: 'מכבי גבעתיים' }, players };
};

await test('a device is the same device on both bridges: the same hash, the one Drive already holds', () => {
  const server = createBridge({ adminCode: ADMIN }).fn('hash_');
  const gas = createGasBridge({ adminCode: ADMIN }).fn('hash_');
  for (const k of [dev('a'), 'מפתח-עברי-'.repeat(5), '😀'.repeat(20), 'x'.repeat(200)]) {
    const want = createHash('sha256').update(k, 'utf8').digest('hex').slice(0, 32);
    assert.equal(gas(k), want);
    assert.equal(server(k), want);
  }
});

await test('access.json written by Apps Script, moved as is: the approved phone reads the season with no new request', () => {
  const gas = createGasBridge({ adminCode: ADMIN });
  approved(gas, dev('q'), 'אבא של יואב');
  gas.post({ action: 'putSeason', adminCode: ADMIN, season: { team: { name: 'מכבי גבעתיים' }, players: [] }, baseVersion: 0 });
  const s = createBridge({ adminCode: ADMIN });
  s.post({ action: 'hello', deviceKey: dev('z') });                   // makes the root folder
  for (const name of ['access.json', 'season.json']) {
    const st = s.fn('root_')();
    const live = st.getFilesByName(name);
    let f = null;
    while (live.hasNext()) { const x = live.next(); if (!x.isTrashed()) f = x; }
    if (f) f.setContent(gas.driveFile(name)); else st.createFile(name, gas.driveFile(name), 'application/json');
  }
  s.clearCache();
  assert.equal(s.post({ action: 'hello', deviceKey: dev('q') }).result.status, 'approved');
  assert.equal(s.post({ action: 'getSeason', deviceKey: dev('q') }).result.season.team.name, 'מכבי גבעתיים');
  assert.equal(err(s.post({ action: 'getSeason', deviceKey: dev('r') })), 'not_approved');
});

await test('everything outlives the server\'s memory: a restart reads it back from storage', () => {
  const b = createBridge({ adminCode: ADMIN });
  approved(b, dev('a'), 'נועה');
  assert.ok(b.post({ action: 'putSeason', adminCode: ADMIN, season: { team: { name: 'א' }, players: [] }, baseVersion: 0 }).ok);
  b.restart();
  assert.equal(b.post({ action: 'hello', deviceKey: dev('a') }).result.status, 'approved');
  const r = b.post({ action: 'getSeason', deviceKey: dev('a') }).result;
  assert.equal(r.version, 1);
  assert.equal(r.season.team.name, 'א');
});

await test('a season past one stored value is kept in pieces, read back whole, and old pieces are removed', () => {
  const b = createBridge({ adminCode: ADMIN });
  const big = hebrewSeason(CHUNK * 1.5);
  assert.ok(b.post({ action: 'putSeason', adminCode: ADMIN, season: big, baseVersion: 0 }).ok);
  const pieces = () => [...b.disk.keys()].filter((k) => /^txt:.*#/.test(k));
  assert.ok(pieces().length >= 2, 'not cut into pieces');
  for (const k of pieces()) assert.ok(b.disk.get(k).length <= CHUNK);
  b.restart();
  const back = b.post({ action: 'getSeason', adminCode: ADMIN }).result.season;
  assert.deepEqual(back, big);
  const bigger = hebrewSeason(CHUNK * 1.4);
  assert.ok(b.post({ action: 'putSeason', adminCode: ADMIN, season: bigger, baseVersion: 1 }).ok);
  const tags = new Set(pieces().map((k) => k.split('#')[1]));
  assert.equal(tags.size, 1, 'the pieces of the old copy were left behind');
  assert.ok(b.post({ action: 'putSeason', adminCode: ADMIN, season: { team: { name: 'קטן' }, players: [] }, baseVersion: 2 }).ok);
  assert.equal(pieces().length, 0, 'a small save left the pieces behind');
  b.restart();
  assert.equal(b.post({ action: 'getSeason', adminCode: ADMIN }).result.season.team.name, 'קטן');
});

await test('a season at the limit, in Hebrew, is saved and survives a restart; one past it is refused', () => {
  const b = createBridge({ adminCode: ADMIN });
  const max = 400 * 1024;
  const s = { team: { name: 'מכבי גבעתיים' }, players: [] };
  for (let i = 0; JSON.stringify(s).length < max; i++) s.players.push({ id: 'p' + i, name: 'שחקן בשם עברי ארוך מאוד '.repeat(8) });
  while (JSON.stringify(s).length > max) s.players.pop();
  assert.ok(Buffer.byteLength(JSON.stringify(s)) > 650 * 1024, 'the case: far more bytes than letters');
  assert.ok(b.post({ action: 'putSeason', adminCode: ADMIN, season: s, baseVersion: 0 }).ok);
  b.restart();
  assert.equal(b.post({ action: 'getSeason', adminCode: ADMIN }).result.season.players.length, s.players.length);
  s.players.push({ id: 'x', name: 'א'.repeat(2000) });
  assert.equal(err(b.post({ action: 'putSeason', adminCode: ADMIN, season: s, baseVersion: 1 })), 'too_big');
});

const withGallery = (b) => {
  b.setProp('CLOUDINARY_CLOUD', 'mg-demo');
  b.setProp('CLOUDINARY_KEY', '123456');
  b.setProp('CLOUDINARY_SECRET', 'shh-secret');
};

await test('an upload signed before the server slept is still accepted after (the photo is already in Cloudinary)', () => {
  const b = createBridge({ adminCode: ADMIN });
  withGallery(b);
  approved(b, dev('g'), 'מעלה');
  const sig = b.post({ action: 'signUpload', deviceKey: dev('g'), kind: 'image' }).result;
  b.restart();
  const r = b.post({ action: 'addGalleryItem', deviceKey: dev('g'), pid: sig.public_id, w: 1600, h: 1200, match: null });
  assert.ok(r.ok, 'lost across the restart: ' + r.error);
  assert.equal(err(b.post({ action: 'addGalleryItem', deviceKey: dev('g'), pid: sig.public_id, w: 1, h: 1 })), 'bad_upload', 'the same signature, twice');
});

await test('the hourly upload count and the mail window also survive a restart', () => {
  const b = createBridge({ adminCode: ADMIN });
  b.post({ action: 'requestAccess', deviceKey: dev('m'), name: 'ראשון' });
  assert.equal(b.mails.length, 1);
  b.restart();
  b.post({ action: 'requestAccess', deviceKey: dev('n'), name: 'שני' });
  assert.equal(b.mails.length, 1, 'mailed again after a restart, inside the window');
  withGallery(b);
  approved(b, dev('h'), 'סופר');
  b.post({ action: 'signUpload', deviceKey: dev('h'), kind: 'image' });
  const counted = [...b.disk.keys()].some((k) => k.startsWith('cache:signs:'));
  assert.ok(counted, 'the hourly count lives only in memory');
});

await test('watching the live screen writes nothing to storage (a write every 4 seconds per phone)', () => {
  const b = createBridge({ adminCode: ADMIN });
  approved(b, dev('w'), 'צופה');
  const before = JSON.stringify([...b.disk]);
  for (let i = 0; i < 5; i++) b.post({ action: 'getLive', deviceKey: dev('w'), watching: true });
  assert.equal(JSON.stringify([...b.disk]), before);
});

await test('a refused request writes nothing', () => {
  const b = createBridge({ adminCode: ADMIN });
  b.post({ action: 'hello', deviceKey: dev('a') });
  const before = JSON.stringify([...b.disk]);
  for (const body of [{ action: 'nope' }, { action: 'putSeason', adminCode: 'wrong-code-xxxx', season: {}, baseVersion: 0 }, '{bad json', { action: 'requestAccess', deviceKey: 'short', name: 'x' }]) b.post(body);
  assert.equal(JSON.stringify([...b.disk]), before);
});

console.log('runs that wait for the network:');

// The server's way: answers arrive later, the run starts over.
function asyncGas(webPages, { delay = null } = {}) {
  const disk = new Map();
  const state = loadState(disk);
  const calls = [];
  const gas = createGas({
    state, props: { ADMIN_CODE: ADMIN },
    net: {
      fetch: async (req) => {
        calls.push(req.url);
        if (delay) await delay(req.url);
        const hit = webPages[req.url];
        if (hit === 'NETWORK_DOWN') throw new Error('connection refused');
        if (!hit) return { status: 404, headers: {}, bytes: new Uint8Array(0), type: 'text/html' };
        return { status: 200, headers: {}, bytes: new Uint8Array(Buffer.from(hit.body)), type: hit.type };
      },
    },
    loadBlob: async (id) => disk.get('blob:' + id) ?? null,
  });
  const post = async (body) => {
    const done = await gas.handle(JSON.stringify(body));
    applyChanges(disk, done.changes, state);
    return JSON.parse(done.text);
  };
  return { gas, state, disk, calls, post };
}
const PAGE = 'https://www.facebook.com/watch/?v=1';
const IMG = 'https://cdn.example.com/poster.jpg';
const pages = {
  [PAGE]: { type: 'text/html', body: `<html><head><meta property="og:image" content="${IMG}"></head></html>` },
  [IMG]: { type: 'image/jpeg', body: 'JPEGDATA' },
};

await test('a poster that needs a page and then its image: two waits, one answer, one file', async () => {
  const s = asyncGas(pages);
  const r = await s.post({ action: 'makePoster', adminCode: ADMIN, url: PAGE });
  assert.ok(r.ok, r.error);
  assert.deepEqual(s.calls, [PAGE, IMG], 'each address fetched once');
  const blobs = s.state.fs.files.filter((f) => f.kind === 'blob');
  assert.equal(blobs.length, 1, 'a run that was started over left a file behind');
  const back = await s.post({ action: 'getPoster', adminCode: ADMIN, ref: r.result.ref });
  assert.equal(Buffer.from(back.result.data, 'base64').toString(), 'JPEGDATA', 'read back from storage');
});

await test('a save that lands while a poster waits for the network is not lost, and the poster still lands', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = asyncGas(pages, { delay: (url) => (url === IMG ? gate : null) });
  await s.post({ action: 'putSeason', adminCode: ADMIN, season: { team: { name: 'לפני' }, players: [] }, baseVersion: 0 });
  const poster = s.post({ action: 'makePoster', adminCode: ADMIN, url: PAGE });
  await new Promise((r) => setTimeout(r, 20));
  const save = await s.post({ action: 'putSeason', adminCode: ADMIN, season: { team: { name: 'בזמן' }, players: [] }, baseVersion: 1 });
  assert.ok(save.ok, 'the save waited behind the poster: ' + save.error);
  release();
  assert.ok((await poster).ok);
  const after = await s.post({ action: 'getSeason', adminCode: ADMIN });
  assert.equal(after.result.season.team.name, 'בזמן');
  assert.equal(after.result.version, 2);
});

await test('a page that cannot be reached is "no image", as in Apps Script — not a crash', async () => {
  const s = asyncGas({ [PAGE]: 'NETWORK_DOWN' });
  const r = await s.post({ action: 'makePoster', adminCode: ADMIN, url: PAGE });
  assert.equal(err(r), 'no_poster');
});

await test('two requests that wait at once each get their own answers', async () => {
  const other = 'https://www.instagram.com/p/2';
  const img2 = 'https://cdn.example.com/two.jpg';
  const s = asyncGas({
    ...pages,
    [other]: { type: 'text/html', body: `<meta property="og:image" content="${img2}">` },
    [img2]: { type: 'image/jpeg', body: 'SECOND' },
  }, { delay: () => new Promise((r) => setTimeout(r, 5)) });
  const [a, b] = await Promise.all([
    s.post({ action: 'makePoster', adminCode: ADMIN, url: PAGE }),
    s.post({ action: 'makePoster', adminCode: ADMIN, url: other }),
  ]);
  const get = async (ref) => Buffer.from((await s.post({ action: 'getPoster', adminCode: ADMIN, ref })).result.data, 'base64').toString();
  assert.equal(await get(a.result.ref), 'JPEGDATA');
  assert.equal(await get(b.result.ref), 'SECOND');
});

/* ---------- 4: the real server ---------- */
console.log('the server in workerd:');

let Miniflare;
try { ({ Miniflare } = await import('miniflare')); } catch { /* reported below */ }
if (!Miniflare) {
  failures.push('miniflare is not installed (npm install --no-save miniflare)');
  console.log('  ✗ miniflare is not installed — npm install --no-save miniflare');
} else {
  const persist = mkdtempSync(join(tmpdir(), 'mg-server-'));
  const outbound = [];
  const web = {
    [PAGE]: pages[PAGE], [IMG]: pages[IMG],
  };
  let holdImage = null;
  const HELPER = 'https://script.google.com/macros/s/helper/exec';
  const start = (extra = {}) => new Miniflare({
    modules: true,
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    scriptPath: join(ROOT, 'server/worker.js'),
    modulesRoot: join(ROOT, 'server'),
    compatibilityDate: '2026-07-01',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: { TEAM: { className: 'Team', useSQLite: true } },
    durableObjectsPersist: persist,
    bindings: { ADMIN_CODE: ADMIN, HELPER_URL: HELPER, HELPER_TOKEN: 'helper-secret', CLOUDINARY_CLOUD: 'mg-demo', CLOUDINARY_KEY: '1', CLOUDINARY_SECRET: 's', ...extra },
    outboundService: async (req) => {
      const body = req.method === 'POST' ? await req.text() : '';
      outbound.push({ url: req.url, method: req.method, body });
      if (req.url === HELPER) {
        const b = JSON.parse(body);
        if (b.token !== 'helper-secret') return Response.json({ ok: false, error: 'BAD_TOKEN' });
        if (b.action === 'helperThumb') return Response.json({ ok: true, result: { data: Buffer.from('THUMB').toString('base64') } });
        return Response.json({ ok: true, result: {} });
      }
      if (req.url === IMG && holdImage) await holdImage;
      const hit = web[req.url];
      return hit ? new Response(hit.body, { headers: { 'Content-Type': hit.type } }) : new Response('not found', { status: 404 });
    },
  });
  let mf = start();
  // The client's request exactly: a string body, no headers (text/plain, no preflight).
  const call = async (body, path = '/') => {
    const r = await mf.dispatchFetch('https://server.test' + path, { method: 'POST', body: JSON.stringify(body) });
    return { status: r.status, cors: r.headers.get('access-control-allow-origin'), ...(await r.json()) };
  };
  const waitFor = async (pred) => { for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 20)); };

  try {
    await test('a preflight is answered (Apps Script never did), and every answer carries CORS', async () => {
      const r = await mf.dispatchFetch('https://server.test/', { method: 'OPTIONS', headers: { Origin: 'https://lironcon2015-prog.github.io', 'Access-Control-Request-Method': 'POST' } });
      assert.equal(r.status, 204);
      assert.equal(r.headers.get('access-control-allow-origin'), '*');
      const h = await call({ action: 'hello', deviceKey: dev('a') });
      assert.equal(h.cors, '*');
      assert.equal(h.result.status, 'none');
    });

    await test('a request for access is mailed through the helper, after the answer, with the helper\'s token', async () => {
      const r = await call({ action: 'requestAccess', deviceKey: dev('a'), name: 'אמא של איתי' });
      assert.equal(r.result.status, 'pending');
      await waitFor(() => outbound.some((o) => o.url === HELPER));
      const mail = JSON.parse(outbound.find((o) => o.url === HELPER).body);
      assert.equal(mail.action, 'helperMail');
      assert.equal(mail.token, 'helper-secret');
      assert.equal(mail.to, '@owner');
      assert.match(mail.subject, /אמא של איתי/);
      assert.ok(!mail.body.includes(dev('a')));
    });

    await test('approve, read, and it is all still there after the server restarts', async () => {
      const id = (await call({ action: 'listUsers', adminCode: ADMIN })).result[0].id;
      assert.equal((await call({ action: 'setStatus', adminCode: ADMIN, id, status: 'approved' })).result.status, 'approved');
      assert.ok((await call({ action: 'putSeason', adminCode: ADMIN, season: hebrewSeason(CHUNK * 1.3), baseVersion: 0 })).ok);
      await mf.dispose();
      mf = start();
      const r = await call({ action: 'getSeason', deviceKey: dev('a') });
      assert.ok(r.ok, r.error);
      assert.equal(r.result.version, 1);
      assert.equal(r.result.season.team.name, 'מכבי גבעתיים');
    });

    await test('a poster from a page, through the real fetch; a save meanwhile is not held up or lost', async () => {
      let release;
      holdImage = new Promise((r) => { release = r; });
      const poster = call({ action: 'makePoster', adminCode: ADMIN, url: PAGE });
      await waitFor(() => outbound.some((o) => o.url === IMG));
      const save = await call({ action: 'putSeason', adminCode: ADMIN, season: { team: { name: 'בזמן ההמתנה' }, players: [] }, baseVersion: 1 });
      assert.ok(save.ok, save.error);
      release();
      holdImage = null;
      const p = await poster;
      assert.ok(p.ok, p.error);
      const got = await call({ action: 'getPoster', deviceKey: dev('a'), ref: p.result.ref });
      assert.equal(Buffer.from(got.result.data, 'base64').toString(), 'JPEGDATA');
      assert.equal((await call({ action: 'getSeason', adminCode: ADMIN })).result.season.team.name, 'בזמן ההמתנה');
    });

    await test('a Drive video\'s thumbnail comes through the helper', async () => {
      const r = await call({ action: 'makePoster', adminCode: ADMIN, url: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view' });
      assert.ok(r.ok, r.error);
      const got = await call({ action: 'getPoster', adminCode: ADMIN, ref: r.result.ref });
      assert.equal(Buffer.from(got.result.data, 'base64').toString(), 'THUMB');
    });

    await test('the admin routes refuse a wrong code, and import is closed unless ALLOW_IMPORT=1', async () => {
      assert.equal((await call({ adminCode: 'wrong-code-xxxxx' }, '/admin/export')).code, 'bad_code');
      assert.equal((await call({ adminCode: ADMIN, files: [] }, '/admin/import')).code, 'import_closed');
      assert.equal((await call({ adminCode: ADMIN }, '/admin/reset')).code, 'import_closed');
    });

    await test('the move from Drive: files and posters land under their Drive ids, the digest matches, the phone keeps its access', async () => {
      await mf.dispose();
      mf = start({ ALLOW_IMPORT: '1' });
      assert.ok((await call({ adminCode: ADMIN }, '/admin/reset')).ok);
      assert.equal((await call({ action: 'hello', deviceKey: dev('a') })).result.status, 'none', 'reset left data behind');
      // Drive as Apps Script left it: a parent approved there, a season that names a poster by its Drive id.
      const gas = createGasBridge({ adminCode: ADMIN });
      approved(gas, dev('p'), 'אבא של נדב');
      const driveId = '1PosterDriveId_abcDEF123';
      gas.post({ action: 'putSeason', adminCode: ADMIN, season: { team: { name: 'מכבי גבעתיים', logo: driveId }, players: [] }, baseVersion: 0 });
      const files = ['access.json', 'season.json'].map((name) => ({ where: 'root', name, text: gas.driveFile(name) }));
      files.push({ where: 'posters', id: driveId, name: 'logo-x.png', type: 'image/png', data: Buffer.from('PNGBYTES').toString('base64') });
      const imp = await call({ adminCode: ADMIN, files }, '/admin/import');
      assert.ok(imp.ok, imp.error);
      const digest = (await call({ adminCode: ADMIN }, '/admin/digest')).result;
      for (const f of files) {
        const d = digest.find((x) => x.name === f.name && !x.trashed);
        const want = createHash('sha256').update(f.text != null ? Buffer.from(f.text, 'utf8') : Buffer.from(f.data, 'base64')).digest('hex');
        assert.equal(d.sha256, want, f.name + ' differs after the move');
      }
      assert.equal((await call({ action: 'hello', deviceKey: dev('p') })).result.status, 'approved');
      const s = await call({ action: 'getSeason', deviceKey: dev('p') });
      assert.equal(s.result.season.team.logo, driveId);
      const logo = await call({ action: 'getPoster', deviceKey: dev('p'), ref: driveId });
      assert.equal(Buffer.from(logo.result.data, 'base64').toString(), 'PNGBYTES', 'the poster did not keep its Drive id');
      // Importing again replaces, never doubles.
      assert.ok((await call({ adminCode: ADMIN, files }, '/admin/import')).ok);
      const again = (await call({ adminCode: ADMIN }, '/admin/digest')).result;
      assert.equal(again.filter((x) => x.name === 'season.json' && !x.trashed).length, 1);
      assert.equal(again.filter((x) => x.id === driveId).length, 1);
      const exp = (await call({ adminCode: ADMIN }, '/admin/export')).result;
      assert.equal(exp.files.find((f) => f.name === 'season.json').text, gas.driveFile('season.json'));
      assert.equal(exp.images[0].id, driveId);
      const blob = (await call({ adminCode: ADMIN, id: driveId }, '/admin/blob')).result;
      assert.equal(Buffer.from(blob.data, 'base64').toString(), 'PNGBYTES');
    });

    await test('a deleted gallery item is removed from Cloudinary after the answer', async () => {
      const sig = (await call({ action: 'signUpload', deviceKey: dev('p'), kind: 'image' })).result;
      const add = await call({ action: 'addGalleryItem', deviceKey: dev('p'), pid: sig.public_id, w: 10, h: 10 });
      assert.ok(add.ok, add.error);
      const del = await call({ action: 'deleteGalleryItem', deviceKey: dev('p'), id: add.result.id });
      assert.ok(del.ok, del.error);
      await waitFor(() => outbound.some((o) => o.url.includes('/image/destroy')));
      const d = outbound.find((o) => o.url.includes('/image/destroy'));
      assert.match(d.body, new RegExp('public_id=' + encodeURIComponent(sig.public_id)));
    });

    await test('a body over the size limit is refused with its reason', async () => {
      const r = await mf.dispatchFetch('https://server.test/', { method: 'POST', body: 'x'.repeat(4 * 1024 * 1024 + 10) });
      assert.equal(r.status, 413);
      assert.equal((await r.json()).code, 'too_big');
    });
  } finally {
    await mf.dispose();
    rmSync(persist, { recursive: true, force: true });
  }
}

/* ---------- 5: the move, run from Apps Script (tools/move.gs) ---------- */
if (Miniflare) {
  console.log('the move, from Apps Script:');
  const persist = mkdtempSync(join(tmpdir(), 'mg-move-'));
  const mf = new Miniflare({
    modules: true,
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    scriptPath: join(ROOT, 'server/worker.js'),
    modulesRoot: join(ROOT, 'server'),
    compatibilityDate: '2026-07-01',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: { TEAM: { className: 'Team', useSQLite: true } },
    durableObjectsPersist: persist,
    bindings: { ADMIN_CODE: ADMIN, ALLOW_IMPORT: '1' },
    port: 0,
  });
  const SERVER = String(await mf.ready).replace(/\/$/, '');
  // UrlFetchApp is synchronous; the test reaches the real server over HTTP
  // from a child process, so Apps Script code runs exactly as written.
  const syncFetch = (url, o) => {
    const r = spawnSync(process.execPath, ['-e', `
      const [url, method, body] = JSON.parse(process.argv[1]);
      fetch(url, { method, body: method === 'GET' ? undefined : body })
        .then(async (res) => process.stdout.write(JSON.stringify({ code: res.status, body: await res.text() })))
        .catch((e) => process.stdout.write(JSON.stringify({ down: String(e) })));
    `, JSON.stringify([url, String(o.method || 'get').toUpperCase(), o.payload ?? ''])], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const out = JSON.parse(r.stdout || '{"down":"no output"}');
    if (out.down) throw new Error('Address unavailable: ' + url);
    return out;
  };
  const gas = createGasBridge({
    adminCode: ADMIN, files: ['tools/move.gs'],
    fetchHook: (url, o) => (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost') ? syncFetch(url, o) : undefined),
  });
  const srv = async (body, path = '/') => (await fetch(SERVER + path, { method: 'POST', body: JSON.stringify(body) })).json();
  const png = Buffer.from('\x89PNG fake crest bytes').toString('base64');

  try {
    // Drive as the season left it.
    approved(gas, dev('m'), 'אמא של רון');
    const logo = gas.post({ action: 'putLogo', adminCode: ADMIN, mime: 'image/png', data: png }).result.ref;
    gas.post({ action: 'putSeason', adminCode: ADMIN, season: { team: { name: 'מכבי גבעתיים', logo }, players: [{ id: 'p1', name: 'רון' }] }, baseVersion: 0 });
    gas.post({ action: 'setMessage', adminCode: ADMIN, text: 'אימון בשש' });
    gas.post({ action: 'startLive', adminCode: ADMIN, state: { id: 'M1', status: 'running', opponent: 'בני לוד', date: '2026-10-03', format: [30, 30, 20], lineup: [], players: [], events: [] } });
    gas.post({ action: 'setLiveCode', adminCode: ADMIN, code: '4821' });
    gas.post({ action: 'claimLive', deviceKey: dev('m'), code: '0000' });          // one wrong guess on record
    gas.setProp('SERVER_URL', SERVER);

    await test('two live files with one name stop the move, and name the file', () => {
      const dup = gas.fn('root_')().createFile('season.json', '{"version":0}', 'application/json');
      assert.throws(() => gas.fn('moveToServer')(), /season\.json/);
      dup.setTrashed(true);
    });

    await test('moveToServer copies every file and image, and every fingerprint matches', () => {
      const r = gas.fn('moveToServer')();
      assert.equal(r.images, 1);
      assert.ok(r.texts >= 4, 'files: ' + r.texts);
    });

    await test('after the move the server answers as Drive did: access, season, crest, message, the live match and its code', async () => {
      assert.equal((await srv({ action: 'hello', deviceKey: dev('m') })).result.status, 'approved');
      const s = (await srv({ action: 'getSeason', deviceKey: dev('m') })).result;
      assert.equal(s.season.team.logo, logo);
      assert.equal(JSON.stringify(s.season), JSON.stringify(gas.post({ action: 'getSeason', deviceKey: dev('m') }).result.season));
      const crest = (await srv({ action: 'getPoster', deviceKey: dev('m'), ref: logo })).result;
      assert.equal(crest.data, gas.post({ action: 'getPoster', deviceKey: dev('m'), ref: logo }).result.data);
      const live = (await srv({ action: 'getLive', adminCode: ADMIN })).result;
      assert.equal(live.state.opponent, 'בני לוד');
      assert.equal(live.control.attemptsLeft, 4, 'the wrong guess before the move was forgotten');
      assert.equal(JSON.stringify((await srv({ action: 'getSeason', deviceKey: dev('m') })).result.message),
        JSON.stringify(gas.post({ action: 'getSeason', deviceKey: dev('m') }).result.message));
      assert.match(JSON.stringify((await srv({ action: 'getSeason', deviceKey: dev('m') })).result.message), /אימון בשש/);
    });

    await test('moving again replaces and never doubles', async () => {
      gas.fn('moveToServer')();
      const d = (await srv({ adminCode: ADMIN }, '/admin/digest')).result;
      assert.equal(d.filter((x) => x.name === 'season.json' && !x.trashed).length, 1);
      assert.equal(d.filter((x) => x.id === logo).length, 1);
    });

    await test('read-only while copying: reads answer, a write is refused with "moving" and why', () => {
      gas.setProp('MODE', 'readonly');
      assert.equal(gas.post({ action: 'getSeason', deviceKey: dev('m') }).ok, true);
      const w = gas.post({ action: 'requestAccess', deviceKey: dev('x'), name: 'חדש' });
      assert.equal(w.code, 'moving');
      assert.match(w.error, /שרת חדש/);
      assert.ok(!gas.driveFile('access.json').includes('חדש'));
    });

    await test('forward: an old phone\'s request reaches the server, and its answer comes back as is', async () => {
      gas.setProp('MODE', 'forward');
      const r = gas.post({ action: 'requestAccess', deviceKey: dev('y'), name: 'טלפון ישן' });
      assert.equal(r.result.status, 'pending');
      assert.ok(!gas.driveFile('access.json').includes('טלפון ישן'), 'written to Drive, not passed on');
      const users = (await srv({ action: 'listUsers', adminCode: ADMIN })).result;
      assert.ok(users.some((u) => u.name === 'טלפון ישן'));
    });

    await test('forward to a server that does not answer is a network failure the phone retries, not a refusal', () => {
      gas.setProp('SERVER_URL', 'http://127.0.0.1:1');
      const r = gas.post({ action: 'getSeason', deviceKey: dev('m') });
      assert.equal(r.code, 'network');
      assert.match(r.error, /השרת החדש/);
      gas.setProp('SERVER_URL', SERVER);
    });

    await test('the helper sends the owner\'s mail and reads a Drive thumbnail — with the right token only', () => {
      assert.equal(gas.post({ action: 'helperMail', token: 'x', to: '@owner', subject: 's', body: 'b' }).code, 'TOKEN_NOT_SET');
      gas.setProp('HELPER_TOKEN', 'helper-secret');
      assert.equal(gas.post({ action: 'helperMail', token: 'nope', to: '@owner', subject: 's', body: 'b' }).code, 'BAD_TOKEN');
      const before = gas.mails.length;
      assert.ok(gas.post({ action: 'helperMail', token: 'helper-secret', to: '@owner', subject: 'בקשת גישה חדשה: דנה', body: 'גוף' }).ok);
      assert.equal(gas.mails.length, before + 1);
      assert.equal(gas.mails.at(-1).to, 'owner@example.com');
      gas.drivePicture('1VideoInDrive_xyz', [7, 7, 7]);
      const t = gas.post({ action: 'helperThumb', token: 'helper-secret', id: '1VideoInDrive_xyz' });
      assert.deepEqual([...Buffer.from(t.result.data, 'base64')], [7, 7, 7]);
    });

    await test('the nightly backup writes the server\'s data into Drive, one folder a day, images once', async () => {
      const r1 = gas.fn('backupFromServer')();
      const r2 = gas.fn('backupFromServer')();
      assert.equal(r2.newImages, 0, 'images copied again');
      const top = gas.topFolder('MGivatayim-backup');
      const days = top.getFolders();
      const live = [];
      while (days.hasNext()) { const f = days.next(); if (!f.isTrashed() && f.getName() === r1.day) live.push(f); }
      assert.equal(live.length, 1, 'two folders for one day');
      const season = live[0].getFilesByName('season.json').next();
      const server = (await srv({ adminCode: ADMIN }, '/admin/export')).result.files.find((f) => f.name === 'season.json').text;
      assert.equal(season.text, server);
    });

    await test('the way back: the server\'s latest data, with an image made on the server, served by Apps Script again', async () => {
      const crest2 = Buffer.from('server-made crest').toString('base64');
      const ref = (await srv({ action: 'putLogo', adminCode: ADMIN, mime: 'image/png', data: crest2 })).result.ref;
      const v = (await srv({ action: 'getSeason', adminCode: ADMIN })).result.version;
      assert.ok((await srv({ action: 'putSeason', adminCode: ADMIN, season: { team: { name: 'מכבי גבעתיים', logo: ref }, players: [] }, baseVersion: v })).ok);
      gas.setProp('MODE', '');
      const r = gas.fn('rollbackFromServer')();
      assert.equal(r.images, 1);
      const s = gas.post({ action: 'getSeason', adminCode: ADMIN }).result;
      assert.equal(s.version, v + 1, 'Apps Script still serves its own old copy');
      assert.notEqual(s.season.team.logo, ref, 'the season points at an id Drive never gave');
      const back = gas.post({ action: 'getPoster', adminCode: ADMIN, ref: s.season.team.logo });
      assert.equal(back.result.data, crest2);
      assert.equal(gas.post({ action: 'hello', deviceKey: dev('y') }).result.status, 'pending', 'a request made on the server came back too');
    });
  } finally {
    await mf.dispose();
    rmSync(persist, { recursive: true, force: true });
  }
}

/* ---------- 6: the live match, pushed (the phone's own code, src/live/sync.js) ---------- */
if (Miniflare) {
  console.log('live push:');
  const persist = mkdtempSync(join(tmpdir(), 'mg-push-'));
  const mf = new Miniflare({
    modules: true,
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    scriptPath: join(ROOT, 'server/worker.js'),
    modulesRoot: join(ROOT, 'server'),
    compatibilityDate: '2026-07-01',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: { TEAM: { className: 'Team', useSQLite: true } },
    durableObjectsPersist: persist,
    bindings: { ADMIN_CODE: ADMIN },
    port: 0,
  });
  const SERVER = String(await mf.ready).replace(/\/$/, '');
  const WS = SERVER.replace(/^http/, 'ws') + '/live';
  const srv = async (body) => (await fetch(SERVER, { method: 'POST', body: JSON.stringify(body) })).json();

  // The phone, in Node: its storage, its page, and a count of every request it sends.
  const store = new Map([['mg:bridge', SERVER], ['mg:admin', ADMIN], ['mg:pollMs', String(10 ** 9)]]);
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const pageListeners = {};
  globalThis.document = { visibilityState: 'visible', addEventListener: (t, f) => { (pageListeners[t] ||= []).push(f); } };
  globalThis.window = { addEventListener: () => {} };
  const realFetch = globalThis.fetch;
  let phoneRequests = 0;
  globalThis.fetch = (url, opts) => { if (String(url).startsWith(SERVER)) phoneRequests++; return realFetch(url, opts); };
  const { LiveSession } = await import('../src/live/sync.js');
  const { newLive } = await import('../src/live/model.js');

  const until = async (pred, ms = 3000) => {
    const t = Date.now();
    while (Date.now() - t < ms) { if (await pred()) return true; await new Promise((r) => setTimeout(r, 15)); }
    return false;
  };
  // A raw phone: a socket, its hello, and what it was sent.
  const rawPhone = (hello) => new Promise((resolve) => {
    const ws = new WebSocket(WS);
    const got = [];
    let closed = null;
    ws.onmessage = (e) => { if (e.data !== 'pong') got.push(JSON.parse(e.data)); };
    ws.onclose = (e) => { closed = e.code; };
    ws.onopen = () => { ws.send(JSON.stringify({ type: 'hello', ...hello })); resolve({ ws, got, closed: () => closed }); };
  });
  let S = null;
  const state = (extra = {}) => ({ ...newLive({ id: 'L1', opponent: 'הפועל', date: '2026-10-24', format: [30, 30, 20], lineup: [], players: [] }), ...extra });

  try {
    // The manager's phone runs the real LiveSession; parents are raw sockets.
    const httpApprove = async (key, name) => {
      await srv({ action: 'requestAccess', deviceKey: key, name });
      const id = (await srv({ action: 'listUsers', adminCode: ADMIN })).result.find((u) => u.name === name).id;
      await srv({ action: 'setStatus', adminCode: ADMIN, id, status: 'approved' });
      return id;
    };
    const parentId = await httpApprove(dev('1'), 'הורה אחד');
    await httpApprove(dev('2'), 'הורה שתיים');
    S = new LiveSession({ asAdmin: () => true });
    S.start();

    await test('the server says it can push; the phone opens the socket and stops polling', async () => {
      await S.fetch();
      assert.equal(S.pushOffered, true);
      assert.ok(await until(() => S.pushAlive()), 'no socket');
      const before = phoneRequests;
      for (let i = 0; i < 5; i++) await S.tick();
      assert.equal(phoneRequests, before, 'still polling with a live socket');
    });

    await test('a hidden match reaches no parent; publishing it reaches them at once, with no question asked', async () => {
      const p1 = await rawPhone({ deviceKey: dev('1'), watching: true });
      await until(() => p1.got.length >= 1);
      await S.startMatch(state());
      await new Promise((r) => setTimeout(r, 150));
      assert.ok(p1.got.every((m) => m.type === 'live' && !m.result.state), 'a parent saw a hidden match');
      const t0 = Date.now();
      await S.admin('publishLive');
      assert.ok(await until(() => p1.got.some((m) => m.result?.state?.id === 'L1')), 'publish never reached the parent');
      assert.ok(Date.now() - t0 < 1000, 'slower than a second: ' + (Date.now() - t0));
      p1.ws.close();
    });

    await test('a goal entered by the manager reaches every parent; the manager\'s own phone keeps its newer copy', async () => {
      const phones = await Promise.all([dev('1'), dev('2')].map((k) => rawPhone({ deviceKey: k, since: null })));
      await until(() => phones.every((p) => p.got.length));
      assert.ok(S.dispatch({ t: 'start', at: Date.now() }), 'kick-off refused by the model');
      await until(() => !S.pending.length);
      const v = S.version;
      assert.ok(await until(() => phones.every((p) => p.got.some((m) => m.result?.version === v))), 'not every parent got the kick-off');
      // An older answer arriving late changes nothing.
      S.apply({ version: v - 1, state: state({ opponent: 'ישן' }), canControl: true, isAdmin: true, control: S.control });
      assert.equal(S.version, v);
      assert.notEqual(S.state.opponent, 'ישן');
      phones.forEach((p) => p.ws.close());
    });

    await test('the manager sees who watches while their socket is open, and sees them leave when it closes', async () => {
      const p = await rawPhone({ deviceKey: dev('2'), watching: true });
      assert.ok(await until(() => (S.control?.watchers || []).some((w) => w.name === 'הורה שתיים')), 'the viewer never appeared');
      p.ws.close();
      assert.ok(await until(() => !(S.control?.watchers || []).some((w) => w.name === 'הורה שתיים')), 'the viewer never left');
    });

    await test('a revoked phone is told and cut off at once; a stranger is cut off at hello', async () => {
      const p = await rawPhone({ deviceKey: dev('1') });
      await until(() => p.got.length);
      await srv({ action: 'setStatus', adminCode: ADMIN, id: parentId, status: 'revoked' });
      assert.ok(await until(() => p.got.some((m) => m.type === 'bye')), 'no goodbye');
      assert.ok(await until(() => p.closed() != null), 'still open');
      const s = await rawPhone({ deviceKey: dev('9') });
      assert.ok(await until(() => s.got.some((m) => m.type === 'bye' && m.code === 'not_approved')));
      const bad = await rawPhone({ adminCode: 'wrong-code-xxxxx', deviceKey: dev('8') });
      assert.ok(await until(() => bad.got.some((m) => m.type === 'bye')));
    });

    await test('a socket that drops: polling takes over at once, and the socket comes back', async () => {
      const before = phoneRequests;
      S.socket.close();
      assert.ok(await until(() => phoneRequests > before), 'no poll after the drop');
      assert.ok(await until(() => S.pushAlive(), 6000), 'the socket never came back');
    });

    await test('in a pocket the phone closes its socket; back in front it reopens and catches up', async () => {
      document.visibilityState = 'hidden';
      pageListeners.visibilitychange.forEach((f) => f());
      assert.equal(S.socket, null);
      await srv({ action: 'putLive', adminCode: ADMIN, state: { ...S.state, opponent: 'הפועל (עודכן)' }, baseVersion: S.version });
      document.visibilityState = 'visible';
      pageListeners.visibilitychange.forEach((f) => f());
      assert.ok(await until(() => S.state?.opponent === 'הפועל (עודכן)'), 'missed what happened while hidden');
      assert.ok(await until(() => S.pushAlive()));
    });

    await test('60 phones at kick-off: all connected, all told of the next goal, and the server sends only to them', async () => {
      await httpApprove(dev('5'), 'הורה חמש');
      const phones = await Promise.all(Array.from({ length: 60 }, () => rawPhone({ deviceKey: dev('5'), watching: true })));
      assert.ok(await until(() => phones.every((p) => p.got.length >= 1), 8000), 'not all got the match');
      const reqBefore = phoneRequests;
      assert.ok(S.dispatch({ t: 'goal', id: 'g-push', side: 'us', period: S.state.period, atMs: 180000 }), 'goal refused by the model');
      await until(() => !S.pending.length);
      const v = S.version;
      assert.ok(await until(() => phones.every((p) => p.got.some((m) => m.result?.version === v)), 8000), 'a phone missed the goal');
      assert.ok(phoneRequests - reqBefore <= 2, 'the goal cost more than its own write: ' + (phoneRequests - reqBefore));
      phones.forEach((p) => p.ws.close());
    });
  } finally {
    if (S) { S.pushOffered = false; S.closeSocket(); clearTimeout(S.timer); }
    globalThis.fetch = realFetch;
    await mf.dispose();
    rmSync(persist, { recursive: true, force: true });
  }
}

console.log(`\nserver: ${passed} passed, ${failures.length} failed`);
// A phone's timers (a poll scheduled far ahead) must not hold the run open.
process.exit(failures.length ? 1 : 0);
