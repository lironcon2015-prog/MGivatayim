// Updates reaching phones.
//   node tests/pwa.mjs
// Static: the three version marks agree, and every module is precached.
// Live:   a page open on version A notices a deploy of version B, reloads by
//         itself and shows B — and does NOT reload over unsaved manager work.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync, existsSync, cpSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, extname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createBridge, serveBridge } from './mock-bridge.mjs';

const ADMIN = 'test-admin-code-1234';
const BRIDGE_PORT = 8772;
const bridgeServer = await serveBridge(createBridge({ adminCode: ADMIN }), BRIDGE_PORT);

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let passed = 0; const failures = [];
async function step(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { failures.push(name); console.log('  ✗', name, '\n     ', String(e.message).split('\n')[0]); }
}
const expect = (c, m) => { if (!c) throw new Error(m); };
const read = (f, dir = ROOT) => readFileSync(join(dir, f), 'utf8');
const versions = (dir = ROOT) => ({
  json: JSON.parse(read('version.json', dir)).version,
  sw: read('sw.js', dir).match(/CACHE_VERSION = '([^']+)'/)?.[1],
  html: read('index.html', dir).match(/_BUNDLE_VERSION = '([^']+)'/)?.[1],
});

console.log('pwa:');

await step('version.json, sw.js and index.html name the same version', () => {
  const v = versions();
  expect(v.json && v.json === v.sw && v.sw === v.html, JSON.stringify(v));
});

await step('every module under src/ is precached by the service worker', () => {
  const core = read('sw.js').match(/const CORE = \[([\s\S]*?)\];/)[1];
  const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const missing = walk(join(ROOT, 'src')).map((p) => './' + relative(ROOT, p)).filter((p) => !core.includes(`'${p}'`));
  expect(!missing.length, 'not in CORE: ' + missing.join(', '));
});

await step('every file the service worker precaches exists', () => {
  const core = [...read('sw.js').match(/const CORE = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const missing = core.filter((p) => p !== './' && !existsSync(join(ROOT, p)));
  expect(!missing.length, 'missing: ' + missing.join(', '));
});

// ---- live: deploy a new version under an open page ----
const site = mkdtempSync(join(tmpdir(), 'mg-pwa-'));
cpSync(ROOT, site, { recursive: true, filter: (p) => !/node_modules|\.git(\/|$)/.test(p) });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const PORT = 8771;
const server = createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const f = join(site, p.endsWith('/') ? p + 'index.html' : p);
  try {
    // max-age like GitHub Pages, so the test would catch an update path
    // that only works when the browser happens not to cache.
    res.writeHead(200, { 'Content-Type': TYPES[extname(f)] || 'application/octet-stream', 'Cache-Control': 'max-age=600' });
    res.end(await readFile(f));
  } catch { res.writeHead(404); res.end(); }
}).listen(PORT);

const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const ctx = await browser.newContext({ viewport: { width: 400, height: 800 } });
await ctx.route(/fonts\.|script\.google\.com/, (r) => r.abort());
const page = await ctx.newPage();
const shown = () => page.locator('#app-version').innerText();
const deploy = () => execFileSync(process.execPath, [join(site, 'tools/bump.mjs')], { cwd: site }).toString();

const start = versions(site).json;

await step('the running version is shown on screen', async () => {
  await page.goto(`http://localhost:${PORT}/`);
  await page.locator('#app-version').waitFor();
  expect(await shown() === start, `shows ${await shown()}, expected ${start}`);
});

await step('the service worker takes control', async () => {
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 });
});

let next;
await step('a deploy is picked up and the open page reloads onto it by itself', async () => {
  next = deploy().split('→')[1].trim().split('\n')[0];
  // Returning to the foreground is how a home-screen app is reopened.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction((v) => document.getElementById('app-version')?.textContent === v, next, { timeout: 15000 });
});

await step('a code change without a bump still reaches a fresh open (network first)', async () => {
  writeFileSync(join(site, 'src/config.js'), read('src/config.js', site).replace("DEFAULT_CREST = 'assets/crest.png'", "DEFAULT_CREST = 'assets/crest.png?probe'"));
  const page2 = await ctx.newPage();
  await page2.goto(`http://localhost:${PORT}/`);
  const src = await page2.evaluate(async () => (await import('./src/config.js')).DEFAULT_CREST);
  expect(src.endsWith('?probe'), 'served stale module: ' + src);
  await page2.close();
});

await step('unsaved manager work blocks the automatic reload; a bar is offered instead', async () => {
  const admin = await ctx.newPage();
  await admin.addInitScript((url) => localStorage.setItem('mg:bridge', url), `http://localhost:${BRIDGE_PORT}/exec`);
  await admin.goto(`http://localhost:${PORT}/#/admin`);
  await admin.fill('input[name=code]', ADMIN);
  await admin.locator('#admin-form button').click();
  await admin.click('[data-tab="team"]');
  await admin.locator('[data-path="team.league"]').waitFor({ timeout: 10000 });
  await admin.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 });
  await admin.fill('[data-path="team.league"]', 'עריכה שלא נשמרה');   // now dirty
  const loadedAt = await admin.evaluate(() => performance.timeOrigin);
  const shipped = deploy().split('→')[1].trim().split('\n')[0];
  await admin.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await admin.locator('.update-bar').waitFor({ timeout: 15000 });
  expect(await admin.evaluate(() => performance.timeOrigin) === loadedAt, 'the page reloaded over unsaved work');
  expect(await admin.inputValue('[data-path="team.league"]') === 'עריכה שלא נשמרה', 'the edit was lost');
  expect((await admin.locator('.update-bar').innerText()).includes(shipped), 'bar does not name the new version');
  await admin.close();
});

await browser.close();
server.close();
bridgeServer.close();
rmSync(site, { recursive: true, force: true });
console.log(`\npwa: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
