// The whole access story in a real browser, against the real bridge.gs:
// a parent asks, the manager approves and publishes, the parent sees it,
// the manager edits, the parent sees the edit, the manager revokes, the
// parent is locked out and their cached copy is gone.
//
//   npm i playwright        (once, at the repo root; node_modules is ignored)
//   node tests/e2e.mjs
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge, serveBridge } from './mock-bridge.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ADMIN = 'test-admin-code-1234';
const APP_PORT = 8781, BRIDGE_PORT = 8782;
const APP = `http://localhost:${APP_PORT}/`;
const BRIDGE = `http://localhost:${BRIDGE_PORT}/exec`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
const app = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, APP).pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, path.endsWith('/') ? path + 'index.html' : path);
  let body;
  try { body = await readFile(file); } catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(body);
}).listen(APP_PORT);

const bridge = createBridge({ adminCode: ADMIN });
const bridgeServer = await serveBridge(bridge, BRIDGE_PORT);

const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});

let passed = 0;
const failures = [];
async function step(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { failures.push(name); console.log('  ✗', name, '\n     ', e.message.split('\n')[0]); }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

// Each role is its own browser context: separate storage, so separate device.
async function device(label) {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 860 } });
  await ctx.addInitScript((url) => { try { localStorage.setItem('mg:bridge', url); localStorage.setItem('mg:pollMs', '500'); } catch {} }, BRIDGE);
  // Google Fonts is outside the test; failing it fast keeps runs offline-safe.
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.|ERR_FAILED|ERR_INTERNET_DISCONNECTED/.test(m.text())) page.errors.push(`${label}: ${m.text()}`); });
  page.on('request', (r) => { if (r.method() === 'OPTIONS') page.errors.push(`${label}: CORS preflight sent to ${r.url()}`); });
  return page;
}
// Opens a list item in the editor whether or not it is already open —
// clicking the summary of an open <details> would close it instead.
// The admin screen is split into tabs, and import tools fold behind a toggle.
const adminTab = (page, t) => page.click(`[data-tab="${t}"]`);
// Adds a row to a manager's list and returns its path: the new row opens
// first in the list, whatever its place in the data.
async function newRow(page, list) {
  await page.click(`[data-add="${list}"]`);
  const first = page.locator(`details[data-item^="${list}."]`).first();
  expect(await first.getAttribute('open') !== null, `the new ${list} row did not open at the top`);
  return first.getAttribute('data-item');
}
async function adminTools(page, list) {
  const btn = page.locator(`[data-tools="${list}"]`);
  if (await btn.getAttribute('aria-expanded') !== 'true') await btn.click();
}
const openItem = (page, path) => page.locator(`details[data-item="${path}"]`).evaluate((d) => { d.open = true; });
const text = (page) => page.locator('#view').innerText();
const waitText = (page, s, timeout = 5000) => page.locator('#view').getByText(s, { exact: false }).first().waitFor({ timeout });

const parent = await device('parent');
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const admin = await device('admin');

console.log('e2e:');

await step('a new device lands on the access request, not on data', async () => {
  await parent.goto(APP);
  await waitText(parent, 'בקשת גישה');
});

await step('on a phone outside the home-screen app there is no request form, only a way through', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: IPHONE });
  await ctx.addInitScript((url) => { try { localStorage.setItem('mg:bridge', url); } catch {} }, BRIDGE);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const phone = await ctx.newPage();
  await phone.goto(APP);
  await phone.locator('[data-skip-install]').waitFor();
  expect(await phone.locator('#request-form').count() === 0, 'a phone in the browser must not see the form');
  await phone.click('[data-skip-install]');
  await phone.locator('#request-form').waitFor();
  await phone.addInitScript(() => { window.navigator.__defineGetter__('standalone', () => true); });
  await phone.reload();
  await phone.locator('#request-form').waitFor();
  expect((await phone.locator('.gate h2').first().innerText()).trim() === 'בקשת גישה', 'inside the installed app the title is plain');
  expect(await phone.locator('[data-install]').count() === 0, 'the installed app shows no install help');
  await ctx.close();
});

await step('the first screen explains installing on iPhone and Android', async () => {
  await waitText(parent, 'התקנה במסך הבית');
  const t = await text(parent);
  expect(t.includes('אייפון') && t.includes('אנדרואיד'), 'both systems should be explained');
  expect(await parent.locator('[data-install-now]').isHidden(), 'the install button shows only when Chrome offers it');
  expect(await parent.locator('details.install-os[open]').count() === 0, 'both systems start folded');
  await parent.locator('.gate h2', { hasText: 'בקשת גישה — אחרי התקנה במסך הבית' }).waitFor();
});

await step('an empty name is refused on the page', async () => {
  await parent.locator('#request-form button').click();
  await waitText(parent, 'צריך למלא שם');
});

await step('sending a request shows the pending screen', async () => {
  await parent.fill('input[name=name]', 'אבא של איתי');
  await parent.locator('#request-form button').click();
  await waitText(parent, 'ממתינה לאישור');
});

await step('recheck while still pending says so', async () => {
  await parent.click('#recheck');
  await waitText(parent, 'עדיין ממתין');
});

await step('a wrong manager code is refused', async () => {
  await admin.goto(APP + '#/admin');
  await admin.fill('input[name=code]', 'not-the-code-xyz');
  await admin.locator('#admin-form button').click();
  await waitText(admin, 'הקוד שגוי');
});

await step('the right code opens the manager area on an empty season', async () => {
  await admin.fill('input[name=code]', ADMIN);
  await admin.locator('#admin-form button').click();
  await waitText(admin, 'המשחק הבא');
  await waitText(admin, 'גרסה 0');
});

await step('the pending request shows a count on the access tab', async () => {
  await admin.locator('[data-tab="access"] .count').waitFor({ timeout: 5000 });
  expect((await admin.locator('[data-tab="access"] .count').innerText()) === '1', 'count is not 1');
});

await step('saving with a missing required field is blocked with a reason', async () => {
  await admin.click('[data-add="matches"]');
  await admin.fill('[data-path="matches.0.opponent"]', '');
  await admin.click('#save');
  await waitText(admin, 'חסר יריבה');
});

await step('manager fills a season and saves it', async () => {
  await admin.fill('[data-path="matches.0.date"]', '2026-09-19');
  await admin.fill('[data-path="matches.0.opponent"]', 'בני לוד');
  await admin.fill('[data-path="matches.0.gf"]', '2');
  await admin.fill('[data-path="matches.0.ga"]', '1');
  await adminTab(admin, 'team');
  await admin.fill('[data-path="team.league"]', 'ליגת ילדים א');
  await admin.fill('[data-path="team.season"]', '2026/27');
  await admin.fill('[data-path="team.homeVenue.name"]', 'אצטדיון גבעתיים');
  await admin.fill('[data-path="team.homeVenue.address"]', 'רחוב המעיין 4, גבעתיים');
  await adminTab(admin, 'players');
  await admin.click('[data-add="players"]');
  await admin.fill('[data-path="players.0.name"]', 'איתי');
  await admin.fill('[data-path="players.0.goals"]', '2');
  await adminTab(admin, 'games');
  expect(await admin.inputValue('[data-path="matches.0.opponent"]') === 'בני לוד', 'switching tabs lost an edit');
  await admin.click('#add-next');
  await admin.fill('[data-path="nextMatch.opponent"]', 'הפועל כוכבים');
  await admin.fill('[data-kick="date"]', '2030-10-05');
  await admin.fill('[data-kick="time"]', '10:30');
  await admin.fill('[data-path="nextMatch.venue.address"]', 'שדרות ירושלים 24, גבעתיים');
  // The opponent's crest: uploaded here, kept by name, shown to parents below.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await admin.setInputFiles('[data-logo-file="הפועל כוכבים"]', { name: 'crest.png', mimeType: 'image/png', buffer: png });
  await admin.locator('.logo-row .opp-logo[src]').waitFor({ timeout: 8000 });
  await admin.click('#save');
  await waitText(admin, 'נשמר');
  const saved = JSON.parse(bridge.driveFile('season.json'));
  expect(saved.version === 1, 'version is ' + saved.version);
  expect(saved.season.nextMatch.kickoff === '2030-10-05T10:30:00+03:00', 'kickoff stored as ' + saved.season.nextMatch.kickoff);
  expect(saved.season.matches[0].gf === 2 && typeof saved.season.matches[0].gf === 'number', 'score not stored as a number');
  expect(saved.season.team.homeVenue?.address === 'רחוב המעיין 4, גבעתיים', 'home ground not saved: ' + JSON.stringify(saved.season.team));
  expect(!JSON.stringify(saved).includes('__open'), 'UI state leaked into the saved data');
  expect(/^[\w-]{10,}$/.test(saved.season.opponentLogos?.['הפועל כוכבים'] || ''), 'crest not stored by name: ' + JSON.stringify(saved.season.opponentLogos));
});

await step('a save blocked by a field on another tab opens that tab', async () => {
  await adminTab(admin, 'team');
  await admin.fill('[data-path="team.name"]', '');
  await adminTab(admin, 'games');
  await admin.click('#save');
  await waitText(admin, 'חסר שם הקבוצה');
  expect(await admin.getAttribute('[data-tab="team"]', 'aria-selected') === 'true', 'the error\'s tab was not opened');
  await admin.fill('[data-path="team.name"]', 'מכבי גבעתיים');
  await adminTab(admin, 'games');
});

await step('the access tab has an invitation with the app\'s address, ready for WhatsApp', async () => {
  await admin.click('[data-tab="access"]');
  const preview = await admin.locator('.invite-preview').textContent();
  expect(preview.includes(APP), 'invite lacks the app address: ' + preview);
  const wa = await admin.locator('[data-invite-wa]').getAttribute('href');
  expect(wa.startsWith('https://wa.me/?text=') && decodeURIComponent(wa).includes(APP), 'whatsapp link: ' + wa);
  expect(!preview.includes('#'), 'the invitation must not carry a route or anything after the address');
});

await step('the toggle switches what copy and WhatsApp send: the parent or coach guide', async () => {
  for (const [kind, page] of [['parent', 'docs/parent.html'], ['coach', 'docs/coach.html']]) {
    await admin.click(`[data-invite-kind="${kind}"]`);
    const wa = decodeURIComponent(await admin.locator('[data-invite-wa]').getAttribute('href'));
    expect(wa.includes(APP + page), `${kind}: whatsapp sends ` + wa);
    expect((await admin.locator('.invite-preview').textContent()).includes(APP + page), `${kind}: preview`);
  }
  await admin.click('[data-invite-kind="app"]');
  expect(!decodeURIComponent(await admin.locator('[data-invite-wa]').getAttribute('href')).includes('docs/'), 'back to short: still a guide');
});

await step('manager approves the parent', async () => {
  await admin.click('[data-tab="access"]');
  await waitText(admin, 'אבא של איתי');
  await admin.locator('[data-set="approved"]').first().click();
  await waitText(admin, 'אין בקשות חדשות');
});

await step('after approval the parent sees the season on returning to the app, with no tap', async () => {
  await parent.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await waitText(parent, 'בני לוד');
  await waitText(parent, 'הפועל כוכבים');
  await parent.locator('.hero .side:not(.us) .opp-logo[src^="blob:"]').waitFor({ timeout: 8000 });
  const t = await text(parent);
  expect(t.includes('איתי'), 'player missing');
});

await step('the Waze link is built from the address', async () => {
  const href = await parent.locator('a.btn[href*="waze.com"]').getAttribute('href');
  expect(href.includes(encodeURIComponent('שדרות ירושלים 24')), 'waze href: ' + href);
});

await step('a parent has no manager tab and cannot open the editor', async () => {
  expect(await parent.locator('#nav a[href="#/admin"]').count() === 0, 'parent sees the manager tab');
  await parent.goto(APP + '#/admin');
  await waitText(parent, 'קוד מנהל');
  await parent.goto(APP + '#/');
});

await step('the manager edits a score; the parent sees it after reopening', async () => {
  await adminTab(admin, 'games');
  await openItem(admin, 'matches.0');
  await admin.fill('[data-path="matches.0.gf"]', '3');
  await admin.click('#save');
  await waitText(admin, 'גרסה 2');
  await parent.reload();
  await parent.locator('.match .score .ours', { hasText: '3' }).first().waitFor({ timeout: 5000 });
});

await step('a save over a version changed elsewhere is refused, not merged', async () => {
  const other = await device('admin-2');
  await other.goto(APP + '#/admin');
  await other.fill('input[name=code]', ADMIN);
  await other.locator('#admin-form button').click();
  await waitText(other, 'גרסה 2');
  await adminTab(other, 'team');
  await other.fill('[data-path="team.league"]', 'שינוי ממכשיר שני');
  await other.click('#save');
  await waitText(other, 'גרסה 3');
  await adminTab(admin, 'team');
  await admin.fill('[data-path="team.league"]', 'שינוי ישן');
  await admin.click('#save');
  await waitText(admin, 'נשמרו בינתיים ממכשיר אחר');
  expect(JSON.parse(bridge.driveFile('season.json')).season.team.league === 'שינוי ממכשיר שני', 'stale save overwrote');
  await other.context().close();
});

await step('"the match was played" turns the fixture into a result row', async () => {
  admin.once('dialog', (d) => d.accept());
  await admin.click('#discard');
  await waitText(admin, 'גרסה 3');
  expect(await admin.inputValue('[data-path="team.league"]') === 'שינוי ממכשיר שני', 'discard did not load the newer version');
  await adminTab(admin, 'games');
  await admin.click('#played');
  expect(await admin.inputValue('[data-path="matches.0.opponent"]') === 'הפועל כוכבים', 'opponent not carried over');
  expect(await admin.inputValue('[data-path="matches.0.date"]') === '2030-10-05', 'date not carried over');
  await admin.fill('[data-path="matches.0.gf"]', '1');
  await admin.fill('[data-path="matches.0.ga"]', '1');
  await admin.click('#save');
  await waitText(admin, 'גרסה 4');
  const s = JSON.parse(bridge.driveFile('season.json')).season;
  expect(s.nextMatch === null && s.matches.length === 2, 'fixture not moved');
});

// ---- live match ----
const liveFile = () => JSON.parse(bridge.driveFile('live.json') || '{}').state;
const seasonFile = () => JSON.parse(bridge.driveFile('season.json')).season;

await step('players are imported by pasting cells from a spreadsheet', async () => {
  await adminTab(admin, 'players');
  await adminTools(admin, 'players');
  await admin.click('[data-import="paste"]');
  await admin.fill('[data-paste]', 'מספר\tשם\tעמדה\n1\tנועם\tשוער\n9\tגיא פרץ\tחלוץ\n10\tדניאל לוי\tקשר קדמי\n14\tתומר עזרא\tבלם\n');
  await admin.click('[data-go]');
  await admin.locator('[data-apply]').click();
  await admin.click('#save');
  await waitText(admin, 'נשמר');
  const names = seasonFile().players.map((p) => p.name);
  expect(['גיא פרץ', 'דניאל לוי', 'תומר עזרא', 'נועם'].every((n) => names.includes(n)), 'imported: ' + names.join(','));
  expect(seasonFile().players.find((p) => p.name === 'גיא פרץ').pos === 'ST', 'position not read');
});

await step('the manager opens a live match and picks a lineup', async () => {
  await admin.goto(APP + '#/live');
  await admin.click('[data-act="new"]');
  await waitText(admin, 'הרכב פותח');
  await admin.click('[data-act="start"]');
  await admin.locator('.toast', { hasText: 'חסר שם היריבה' }).waitFor();
  await admin.fill('[data-meta="opponent"]', 'מכבי נחלים');
  await admin.locator('[data-meta="opponent"]').blur();
  for (const n of ['1', '9', '10', 'איתי']) {
    await admin.locator('.lu-row', { hasText: n }).first().locator('.lu-toggle').click();
  }
  await admin.waitForFunction(() => document.querySelectorAll('.lu-row.on').length === 4);
  await admin.click('[data-act="start"]');
  await admin.locator('.ctl-goal').first().waitFor();
});

await step('a goal with scorer and assist is recorded exactly once', async () => {
  await admin.click('[data-act="goal-us"]');
  await admin.locator('.pick', { hasText: 'גיא פרץ' }).click();
  await admin.locator('.pick', { hasText: 'דניאל לוי' }).click();
  await waitText(admin, 'כולם רואים');
  const goals = liveFile().events.filter((e) => e.type === 'goal');
  expect(goals.length === 1, `${goals.length} goals recorded for one tap`);
  const byName = Object.fromEntries(liveFile().players.map((p) => [p.name, p.id]));
  expect(goals[0].scorer === byName['גיא פרץ'] && goals[0].assist === byName['דניאל לוי'], 'wrong scorer/assist');
});

await step('a watching parent sees the goal, with the scorer, without reloading', async () => {
  await parent.goto(APP + '#/live');
  await parent.locator('.sc-score .ours', { hasText: '1' }).waitFor({ timeout: 8000 });
  await waitText(parent, 'גיא פרץ');
  await parent.locator('.sc-scorers .us', { hasText: 'גיא פרץ' }).waitFor();
  expect(await parent.locator('.ctl-goal').count() === 0, 'a watching parent sees controls');
});

await step('the manager sees how many watch, and who; a parent does not', async () => {
  await admin.locator('.watch-chip', { hasText: '1' }).waitFor({ timeout: 8000 });
  await admin.click('.watch-chip');
  await admin.locator('.sheet', { hasText: 'אבא של איתי' }).waitFor();
  await admin.click('.sheet-x');
  expect(await parent.locator('.watch-chip').count() === 0, 'a parent sees the watcher count');
});

await step('tapping a player on the pitch substitutes them', async () => {
  await admin.locator('button.pl', { hasText: 'איתי' }).click();
  await admin.locator('.pick', { hasText: 'תומר עזרא' }).click();
  await waitText(admin, 'כולם רואים');
  const sub = liveFile().events.find((e) => e.type === 'sub');
  expect(!!sub, 'no sub recorded');
  await parent.locator('.pl', { hasText: 'תומר' }).waitFor({ timeout: 8000 });
});

await step('a wrong live code is refused; the right one hands the parent control', async () => {
  await admin.click('[data-act="more"]');
  await admin.fill('[data-code-form] input', '4821');
  await admin.locator('[data-code-form] button').click();
  await admin.locator('.toast', { hasText: '4821' }).waitFor();
  await parent.click('[data-act="claim"]');
  await parent.fill('[data-claim] input', '0000');
  await parent.locator('[data-claim] button').click();
  await parent.locator('[data-msg]', { hasText: 'נותרו' }).waitFor();
  await parent.fill('[data-claim] input', '4821');
  await parent.locator('[data-claim] button').click();
  await parent.locator('.ctl-goal').first().waitFor({ timeout: 8000 });
});

await step('the parent in control records a goal against; the manager sees it', async () => {
  await parent.click('[data-act="goal-them"]');
  await admin.locator('.sc-score [data-them]', { hasText: '1' }).waitFor({ timeout: 8000 });
});

await step('a controlling phone reopened with no reception still shows the match and can record', async () => {
  await parent.context().setOffline(true);
  await parent.reload();
  await parent.locator('.ctl-goal').first().waitFor({ timeout: 8000 });
  await parent.locator('.sync.off').waitFor();
  expect((await parent.locator('.sc-score [data-them]').innerText()).trim() === '1', 'the reopened board lost the score');
  await parent.context().setOffline(false);
  await parent.locator('.sync.ok').waitFor({ timeout: 15000 });
});

// Control lets a device write the whole live state, and nothing obliges it
// to use this app to do so. Numbers are printed into markup unescaped, so a
// "shirt number" of HTML is the way in; the page must retype it on arrival.
await step('a controlling device that writes HTML into the live state runs nothing anywhere', async () => {
  const live = (page, action, params = {}) =>
    page.evaluate(([url, a, p]) => import(url).then((m) => m.call(a, p)), [APP + 'src/bridge.js', action, params]);
  const PWN = (n) => `<img src=x onerror="window.__pwn=${n}">`;
  const original = (await live(parent, 'getLive')).state;
  const bad = { ...original, round: PWN(1), players: original.players.map((p) => ({ ...p, number: PWN(2) })) };
  await live(parent, 'putLive', { state: bad, baseVersion: (await live(parent, 'getLive')).version });
  for (const page of [parent, admin]) await page.goto(APP + '#/live');
  await new Promise((r) => setTimeout(r, 1500));
  for (const page of [parent, admin]) {
    expect(await page.evaluate(() => window.__pwn) === undefined, 'injected markup ran on the ' + (page === admin ? 'manager' : 'parent') + '\'s page');
  }
  await live(parent, 'putLive', { state: original, baseVersion: (await live(parent, 'getLive')).version });
  await new Promise((r) => setTimeout(r, 1000));
});

await step('finishing saves the result and the scorers into the season', async () => {
  await parent.click('[data-act="end"]');
  await parent.click('[data-ok]');
  await parent.locator('[data-act="finish"]').first().click();
  await parent.click('[data-ok]');
  await waitText(parent, 'נשמר בתוצאות');
  await parent.waitForFunction(() => true);
  await new Promise((r) => setTimeout(r, 800));
  const m = seasonFile().matches.find((x) => x.liveId);
  expect(m && m.gf === 1 && m.ga === 1, 'result: ' + JSON.stringify(m && [m.gf, m.ga]));
  expect(m.opponent === 'מכבי נחלים', 'opponent: ' + m.opponent);
  expect(m.events.some((e) => e.type === 'sub'), 'events not saved with the match');
});

await step('the scorer\'s total comes from the match events', async () => {
  await parent.goto(APP + '#/stats');
  await parent.locator('#board .leader', { hasText: 'גיא פרץ' }).waitFor({ timeout: 8000 });
  const row = await parent.locator('#board .leader', { hasText: 'גיא פרץ' }).innerText();
  expect(/\b1\b/.test(row), 'leader row: ' + row);
});

await step('minutes per player are the manager\'s only', async () => {
  expect(await parent.locator('#minutes').count() === 0, 'a parent sees the minutes section');
  const cached = await parent.evaluate(() => JSON.parse(localStorage.getItem('mg:season') || 'null'));
  expect(cached && cached.season.players.every((p) => !('minutes' in p)), 'minutes reached the parent\'s device');
  expect(cached.season.matches.every((m) => !('lineup' in m)), 'a past lineup reached the parent\'s device');
  await admin.goto(APP + '#/stats');
  await admin.locator('#minutes .mn-table').waitFor();
});

await step('a history row opens the match with its goals and subs', async () => {
  await parent.goto(APP + '#/');
  await parent.locator('button.match', { hasText: 'מכבי נחלים' }).first().click();
  await parent.locator('.sheet .tl', { hasText: 'גיא פרץ' }).waitFor();
  await parent.locator('.sheet-x').click();
});

await step('the back button (a route change) closes an open sheet instead of leaving it over the next screen', async () => {
  await parent.locator('button.match', { hasText: 'מכבי נחלים' }).first().click();
  await parent.locator('.sheet').waitFor();
  await parent.evaluate(() => { location.hash = '#/stats'; });
  await parent.waitForFunction(() => !document.querySelector('.sheet'), null, { timeout: 3000 });
  await parent.goto(APP + '#/');
});

await step('the next live match opens with the last starting lineup, capped at the size', async () => {
  await admin.goto(APP + '#/live');
  await admin.reload();
  await admin.locator('[data-act="clear"]').click();
  await admin.locator('[data-ok]').click();
  await admin.locator('[data-act="new"]').click();
  await waitText(admin, 'הרכב פותח');
  await admin.waitForFunction(() => document.querySelectorAll('.lu-row.on').length === 4);
  const text = await admin.locator('#view').innerText();
  expect(text.includes('4 מתוך 9'), 'size counter missing');
  expect(text.includes('תשיעיות'), 'size not shown in the format line');
});

await step('a video link gets a poster in Drive, and the parent sees it', async () => {
  bridge.web('https://clips.example.com/goal', 'text/html', '<meta property="og:image" content="https://clips.example.com/goal.jpg">');
  // A real 1×1 PNG: the card drops an image the browser cannot decode.
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  bridge.web('https://clips.example.com/goal.jpg', 'image/png', [...PNG]);
  await admin.goto(APP + '#/admin');
  await adminTab(admin, 'media');
  const at = await newRow(admin, 'videos');
  await admin.fill(`[data-path="${at}.title"]`, 'השער מול נחלים');
  await admin.fill(`[data-path="${at}.url"]`, 'https://clips.example.com/goal');
  await admin.click('#save');
  await waitText(admin, 'נשמר');
  const v = JSON.parse(bridge.driveFile('season.json')).season.videos[0];
  expect(v.poster && v.posterFor === 'https://clips.example.com/goal', 'no poster made: ' + JSON.stringify(v));
  await parent.goto(APP + '#/media');
  await parent.reload();
  await parent.locator('.thumb-img[src^="blob:"]').first().waitFor({ timeout: 10000 });
});

await step('a player added by hand opens first, and is saved in shirt-number order', async () => {
  await admin.goto(APP + '#/admin');
  await adminTab(admin, 'players');
  for (const [name, num] of [['תשע', '9'], ['שלוש', '3']]) {
    const at = await newRow(admin, 'players');
    await admin.fill(`[data-path="${at}.name"]`, name);
    await admin.fill(`[data-path="${at}.number"]`, num);
  }
  await admin.click('#save');
  await waitText(admin, 'נשמר');
  const saved = JSON.parse(bridge.driveFile('season.json')).season.players;
  const nums = saved.map((p) => p.number ?? 999);
  expect(nums.every((n, i) => !i || nums[i - 1] <= n), 'the squad was saved out of number order: ' + saved.map((p) => `${p.number}:${p.name}`).join(', '));
  const rows = await admin.locator('details[data-item^="players."] .ei-lead').allInnerTexts();
  expect(rows.join(',') === [...rows].sort((a, b) => (Number(a) || 999) - (Number(b) || 999)).join(','), 'the list on screen is out of order: ' + rows.join(','));
  // Out again, so the steps after this one see the squad they expect.
  for (const name of ['תשע', 'שלוש']) {
    admin.once('dialog', (d) => d.accept());
    const row = admin.locator('details[data-item^="players."]', { has: admin.locator('.ei-main b', { hasText: new RegExp(`^${name}$`) }) });
    const at = await row.getAttribute('data-item');
    await row.locator('summary').click();
    await admin.click(`[data-remove="${at}"]`);
  }
  await admin.click('#save');
  await waitText(admin, 'נשמר');
  const left = JSON.parse(bridge.driveFile('season.json')).season.players.map((p) => p.name);
  expect(!left.includes('תשע') && !left.includes('שלוש'), 'test players left behind: ' + left.join(', '));
});

await step('a game added by hand is saved in date order, and saving closes the open rows', async () => {
  await admin.goto(APP + '#/admin');
  await adminTab(admin, 'games');
  for (const [date, opp] of [['2031-03-20', 'מאוחר'], ['2031-03-06', 'מוקדם']]) {
    const at = await newRow(admin, 'fixtures');
    await admin.fill(`[data-path="${at}.date"]`, date);
    await admin.fill(`[data-path="${at}.opponent"]`, opp);
    if (opp === 'מוקדם') await admin.selectOption(`[data-path="${at}.round"]`, 'f');
  }
  expect(await admin.locator('details[data-item^="fixtures."][open]').count() === 1, 'opening a new row left the previous one open');
  await admin.click('#save');
  await waitText(admin, 'נשמר');
  const { fixtures } = JSON.parse(bridge.driveFile('season.json')).season;
  const names = fixtures.map((f) => f.opponent);
  expect(names.indexOf('מוקדם') < names.indexOf('מאוחר'), 'the schedule was saved out of date order: ' + names.join(', '));
  const early = fixtures.find((f) => f.opponent === 'מוקדם');
  expect(early.friendly === true && early.round == null, 'the training match: ' + JSON.stringify(early));
  expect(await admin.locator('.edit-item[open]').count() === 0, 'rows stayed open after the save');
  const rows = await admin.locator('details[data-item^="fixtures."] summary').allInnerTexts();
  expect(rows.some((t) => t.includes('06.03.31') && t.includes('משחק אימון')), 'the row lacks the year or the training label: ' + rows.join(' | '));
});

await step('a pasted schedule becomes the next match and the list after it', async () => {
  await admin.goto(APP + '#/admin');
  await adminTab(admin, 'games');
  await adminTools(admin, 'fixtures');
  await admin.click('[data-import="fixtures-paste"]');
  await admin.fill('[data-paste]', [
    'מחזור\tתאריך\tשעה\tקבוצת בית\tקבוצת חוץ\tשערי בית\tשערי חוץ',
    '1\t01/08/2026\t17:00\tמכבי גבעתיים\tעירוני לוח\t2\t2',
    '8\t01/11/2030\t17:30\tהפועל לוח\tמכבי גבעתיים\t\t',
    '9\t08/11/2030\t\tמכבי גבעתיים\tבני לוח\t\t',
  ].join('\n'));
  await admin.click('[data-go]');
  await admin.locator('[data-fapply]').click();
  await admin.click('#save');
  await waitText(admin, 'נשמר');
  const season = JSON.parse(bridge.driveFile('season.json')).season;
  expect(season.fixtures.length === 2, 'fixtures: ' + season.fixtures.length);
  expect(season.matches.some((m) => m.opponent === 'עירוני לוח' && m.gf === 2), 'the result row was not added');
  expect(!('nextMatch' in season) || !season.nextMatch, 'the next match must be derived, not stored');
  await parent.goto(APP + '#/');
  await parent.reload();
  await parent.locator('.hero', { hasText: 'הפועל לוח' }).waitFor({ timeout: 8000 });
  await parent.locator('.fixture-row', { hasText: 'בני לוח' }).waitFor();
  expect((await parent.locator('.fixture-row', { hasText: 'בני לוח' }).innerText()).includes('טרם נקבע'), 'a missing time should say so');
  // The date column holds its text: nothing spills into the home/away pill.
  const clash = await parent.locator('.match').evaluateAll((rows) => rows.map((r) => {
    const w = r.querySelector('.when'), ha = r.querySelector('.ha');
    const kids = [...w.children].map((c) => c.getBoundingClientRect());
    return kids.some((k) => k.left < ha.getBoundingClientRect().right - 0.5) || w.scrollWidth > w.clientWidth ? r.innerText.replace(/\s+/g, ' ') : null;
  }).filter(Boolean));
  expect(!clash.length, 'a date runs into its pill: ' + clash.join(' | '));
});

const israelToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

await step('a later fixture can go live now; finishing dates it today and takes it off the schedule', async () => {
  await admin.goto(APP + '#/live');
  await admin.reload();
  // The setup left open by an earlier step is cancelled first.
  if (await admin.locator('[data-act="more"]').count()) {
    await admin.click('[data-act="more"]');
    await admin.click('[data-m="cancel"]');
    await admin.click('[data-ok]');
  }
  await admin.click('[data-act="pick"]');
  await admin.locator('.pick', { hasText: 'בני לוח' }).click();
  await admin.locator('[data-meta="opponent"]').waitFor();
  expect(await admin.inputValue('[data-meta="opponent"]') === 'בני לוח', 'opponent not taken from the fixture');
  await admin.click('[data-act="start"]');
  await admin.click('[data-act="end"]');
  await admin.click('[data-ok]');
  await admin.locator('[data-act="finish"]').first().click();
  await admin.click('[data-ok]');
  await waitText(admin, 'נשמר בתוצאות');
  await new Promise((r) => setTimeout(r, 600));
  const m = JSON.parse(bridge.driveFile('season.json')).season.matches.find((x) => x.opponent === 'בני לוח');
  expect(m && m.date === israelToday(), 'dated ' + (m && m.date) + ', expected today');
  expect(m.fixture && m.fixture.date === '2030-11-08', 'fixture link: ' + JSON.stringify(m && m.fixture));
  await parent.goto(APP + '#/stats');
  await parent.reload();
  await parent.locator('.fixture-row', { hasText: 'הפועל לוח' }).waitFor();
  expect(await parent.locator('.fixture-row', { hasText: 'בני לוח' }).count() === 0, 'the played fixture is still on the schedule');
});

await step('cancelling a live match saves nothing and returns the fixture to the schedule', async () => {
  await admin.click('[data-act="clear"]');
  await admin.click('[data-ok]');
  await admin.click('[data-act="pick"]');
  await admin.locator('.pick', { hasText: 'הפועל לוח' }).click();
  await admin.click('[data-act="start"]');
  await admin.click('[data-act="goal-them"]');
  // Finished by mistake, reopened for a correction, then cancelled after all:
  // the row the first finish wrote must go too.
  await admin.click('[data-act="more"]');
  await admin.click('[data-m="finish"]');
  await admin.click('[data-ok]');
  await admin.locator('[data-act="reopen"]').click();
  const saved = () => JSON.parse(bridge.driveFile('season.json')).season.matches.some((x) => x.opponent === 'הפועל לוח');
  for (let i = 0; i < 50 && !saved(); i++) await admin.waitForTimeout(100);
  expect(saved(), 'the first finish did not save');
  await admin.click('[data-act="more"]');
  await admin.click('[data-m="cancel"]');
  await admin.click('[data-ok]');
  await admin.locator('[data-act="pick"]').waitFor();
  const season = JSON.parse(bridge.driveFile('season.json')).season;
  expect(!season.matches.some((x) => x.opponent === 'הפועל לוח'), 'a cancelled match was saved');
  await parent.reload();
  await parent.locator('.fixture-row', { hasText: 'הפועל לוח' }).waitFor();
});

await step('deleting the games clears the schedule and typed results, and keeps live ones', async () => {
  await admin.goto(APP + '#/admin');
  await adminTab(admin, 'games');
  await adminTools(admin, 'fixtures');
  await admin.click('[data-clear-games]');
  expect(!(await admin.locator('[data-clear="live"]').isChecked()), 'live matches must not be preselected');
  await admin.click('[data-clear-go]');
  await admin.click('#save');
  await waitText(admin, 'נשמר');
  const season = JSON.parse(bridge.driveFile('season.json')).season;
  expect(season.fixtures.length === 0, 'fixtures left: ' + season.fixtures.length);
  expect(season.matches.length > 0 && season.matches.every((m) => m.liveId), 'typed results left, or the live one lost: ' + JSON.stringify(season.matches.map((m) => m.opponent)));
});

// The coach: an approved device the manager marks. It sees what a parent
// sees, and playing time on top — in the live match and across the season.
let coach;
const coachFile = () => JSON.parse(bridge.driveFile('coach.json') || '{}');
const asAdmin = (action, params = {}) =>
  admin.evaluate(([url, a, p]) => import(url).then((m) => m.call(a, p, { asAdmin: true })), [APP + 'src/bridge.js', action, params]);
const until = async (fn, what, ms = 8000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out waiting for ' + what); await new Promise((r) => setTimeout(r, 100)); }
};

await step('a device the manager marks as coach sees playing time; a parent does not', async () => {
  coach = await device('coach');
  await coach.goto(APP);
  await coach.fill('input[name=name]', 'המאמן');
  await coach.locator('#request-form button').click();
  await waitText(coach, 'ממתינה לאישור');
  // The manager's tab carries a dot while a request waits, on any screen.
  const dot = admin.locator('#nav a[href="#/admin"] .nav-dot');
  await admin.goto(APP + '#/stats');
  await admin.reload();
  await dot.waitFor({ timeout: 8000 });
  await admin.goto(APP + '#/admin');
  await admin.click('[data-tab="access"]');
  // By the exact name: every row's role switch reads "הורה מאמן".
  const row = admin.locator('.user-row').filter({ has: admin.locator('.who b', { hasText: /^המאמן$/ }) });
  await row.locator('[data-set="approved"]').click();
  await dot.waitFor({ state: 'detached', timeout: 8000 });
  await row.locator('[data-role="coach"]').click();
  await row.locator('[data-role="coach"][aria-pressed="true"]').waitFor();
  await coach.click('#recheck');
  await coach.goto(APP + '#/stats');
  await coach.locator('#minutes .mn-table').waitFor({ timeout: 8000 });
  await coach.locator('#minutes [data-mnview="map"]').click();
  await coach.locator('#minutes .mn-map .mn-cell').first().waitFor();
  await coach.locator('#minutes .mn-pl').first().click();
  await coach.locator('.sheet .mn-hist').waitFor();
  await coach.locator('.sheet-x').click();
  await parent.goto(APP + '#/stats');
  await parent.reload();
  await parent.locator('#board').waitFor();
  expect(await parent.locator('#minutes').count() === 0, 'a parent sees the minutes section');
  const cached = await parent.evaluate(() => JSON.parse(localStorage.getItem('mg:season') || 'null'));
  expect(cached.role === 'parent' && !('coach' in cached), 'coach data reached a parent\'s device');
});

await step('before kick-off the coach sets the minimum and who came; a parent sees no minutes tab', async () => {
  await asAdmin('clearLive');
  await admin.goto(APP + '#/live');
  await admin.reload();
  await admin.locator('[data-act="new"]').click();
  await waitText(admin, 'הרכב פותח');
  await admin.fill('[data-meta="opponent"]', 'הפועל מבחן');
  await admin.locator('[data-meta="opponent"]').blur();
  await until(() => liveFile().opponent === 'הפועל מבחן', 'the opponent to be saved');
  const id = liveFile().id;
  await coach.goto(APP + '#/live');
  await coach.locator('[data-tab="minutes"]').click({ timeout: 8000 });
  await coach.locator('[data-mn-step="5"]').click();
  await until(() => coachFile().matches?.[id]?.min === 25, 'the minimum to reach Drive');
  expect(coachFile().minDefault === 25, 'the new minimum is the default for the next match');
  const benched = liveFile().players.find((p) => !liveFile().lineup.some((l) => l.pid === p.id));
  const away = coach.locator(`[data-mn-present="${benched.id}"][data-mn-state="away"]`);
  await away.click();
  await until(() => (coachFile().matches[id].absent || []).includes(benched.id), 'the absence to reach Drive');
  await coach.locator('.mn-att.away', { hasText: benched.name }).waitFor();
  expect(await away.getAttribute('aria-pressed') === 'true', 'not shown as absent');
  // They turned up after all: the one player on the bench, for the alert.
  await coach.locator(`[data-mn-present="${benched.id}"][data-mn-state="here"]`).click();
  await until(() => !coachFile().matches[id].absent.includes(benched.id), 'the correction to reach Drive');
  coach.benchName = benched.name;
});

await step('a match opened ahead is hidden from parents until the manager publishes it', async () => {
  await parent.goto(APP + '#/live');
  await waitText(parent, 'אין משחק חי כרגע');
  expect(await parent.locator('.score-card').count() === 0, 'a parent sees a match that was not published');
  await coach.locator('.hidden-live').waitFor();
  expect(await coach.locator('.hidden-live [data-act="publish"]').count() === 0, 'the coach can publish');
  await admin.click('.hidden-live [data-act="publish"]');
  await admin.locator('.hidden-live').waitFor({ state: 'detached', timeout: 8000 });
  await parent.locator('.score-card').waitFor({ timeout: 8000 });
  expect(await parent.locator('[data-tab="minutes"]').count() === 0, 'a parent sees the minutes tab');
});

await step('at the break before the last period the coach is alerted once, wherever they are', async () => {
  await coach.goto(APP + '#/');
  const st = () => liveFile();
  for (let i = 0; i < 4; i++) {
    const s = st();
    if (s.status === 'break' && s.period === s.format.length - 1) break;
    await admin.locator('[data-act="start"]').first().click();
    if (s.status === 'setup' && await admin.locator('[data-ok]').count()) await admin.click('[data-ok]');
    await until(() => st().status === 'running', 'the period to start');
    await admin.click('[data-act="end"]');
    await admin.click('[data-ok]');
    await until(() => st().status === 'break' || st().status === 'fulltime', 'the period to end');
  }
  const toastEl = coach.locator('.toast', { hasText: 'בספסל מתחת' });
  await toastEl.waitFor({ timeout: 8000 });
  // The home screen keeps it for the whole break, not just while the toast is up.
  await coach.locator('.mn-home').waitFor();
  await toastEl.locator('button').click();
  // The live tab's alert, not the home card's (which also reads .mn-alert).
  await coach.locator('[data-mn-host] .mn-alert').waitFor();
  const alert = await coach.locator('[data-mn-host] .mn-alert').innerText();
  expect(alert.includes(coach.benchName), 'the benched player is not in the alert: ' + alert);
  expect(/השליש האחרון|המחצית האחרונה/.test(alert), 'the alert does not name the last period: ' + alert);
  expect(await coach.locator('.mn-row').count() > 0, 'no minutes list');
  // "Got it" folds it to one line — on the tab and off the home screen.
  await coach.click('[data-mn="fold"]');
  await coach.locator('.mn-alert.folded').waitFor();
  await coach.goto(APP + '#/');
  await coach.reload();
  await new Promise((r) => setTimeout(r, 2000));
  expect(await coach.locator('.toast', { hasText: 'בספסל מתחת' }).count() === 0, 'the alert came twice');
  expect(await coach.locator('.mn-home').count() === 0, 'a folded alert is still on the home screen');
  await parent.goto(APP + '#/live');
  await parent.locator('.score-card').waitFor();
  await new Promise((r) => setTimeout(r, 1500));
  expect(await parent.locator('.mn-alert, .toast:has-text("בספסל")').count() === 0, 'a parent got the coach\'s alert');
  await asAdmin('clearLive');
  const coachId = (await asAdmin('listUsers')).find((u) => u.name === 'המאמן').id;
  await asAdmin('setStatus', { id: coachId, status: 'revoked' });
});

// ---- the team gallery ----
// Cloudinary is outside the test: its upload API and its image CDN are
// stood in for per browser context. The bridge's side is the real one.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const uploads = [];
async function fakeCloudinary(page) {
  await page.context().route('https://api.cloudinary.com/**', async (r) => {
    uploads.push({ url: r.request().url(), body: r.request().postDataBuffer()?.toString('latin1') || '' });
    await r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"public_id":"ok"}' });
  });
  await page.context().route('https://res.cloudinary.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
}
let other;
const galleryFile = () => JSON.parse(bridge.driveFile('gallery.json') || '{"items":[]}');

await step('the gallery stays out of sight until the bridge has Cloudinary keys', async () => {
  await parent.goto(APP + '#/media');
  await parent.locator('.sec-head', { hasText: 'הסרטון הנבחר' }).or(parent.locator('.sec-head', { hasText: 'סרטונים' })).first().waitFor();
  await parent.waitForTimeout(500);
  expect(await parent.locator('[data-gallery] [data-upload]').count() === 0, 'a gallery with no storage behind it is shown');
  await parent.locator('[data-gallery] .video', { hasText: 'השער מול נחלים' }).waitFor();
});

await step('a parent uploads a photo; it is in the gallery at once, under their name', async () => {
  bridge.setProp('CLOUDINARY_CLOUD', 'mg-test');
  bridge.setProp('CLOUDINARY_KEY', '111');
  bridge.setProp('CLOUDINARY_SECRET', 'test-secret');
  // A second parent, approved straight through the bridge: the request and
  // approval screens are tested above.
  other = await device('parent-2');
  await other.goto(APP);
  await other.fill('input[name=name]', 'אמא של דניאל');
  await other.locator('#request-form button').click();
  await waitText(other, 'ממתינה לאישור');
  const id = bridge.post({ action: 'listUsers', adminCode: ADMIN }).result.find((u) => u.name === 'אמא של דניאל').id;
  bridge.post({ action: 'setStatus', adminCode: ADMIN, id, status: 'approved' });
  for (const p of [parent, admin, other]) await fakeCloudinary(p);
  await parent.reload();
  await parent.locator('[data-gallery] [data-upload]').waitFor({ timeout: 8000 });
  await parent.setInputFiles('[data-files]', { name: 'goal.png', mimeType: 'image/png', buffer: PNG });
  await parent.locator('.sheet', { hasText: 'העלאה לגלריה' }).waitFor();
  // Every game played so far is a choice on the screen, not only the latest.
  const played = seasonFile().matches.length;
  const choices = await parent.locator('.sheet .mp-opt input').count();
  expect(played > 1 && choices === played + 1, `games to choose: ${choices}, played: ${played}`);
  await parent.click('.sheet [data-go]');
  await parent.locator('[data-gallery] .gl-tile').first().waitFor({ timeout: 8000 });
  const items = galleryFile().items;
  expect(items.length === 1 && items[0].byName === 'אבא של איתי' && items[0].status === 'live', 'gallery.json: ' + JSON.stringify(items));
  const up = uploads.find((u) => u.url.endsWith('/mg-test/image/upload'));
  expect(up && up.body.includes('name="signature"') && up.body.includes(items[0].pid), 'the upload did not carry the signature and the id');
  expect(!up.body.includes('test-secret'), 'the secret went to the browser');
});

await step('photos and videos show apart; the linked videos sit in the videos tab', async () => {
  expect(await parent.locator('[data-gtab="photos"][aria-selected="true"]').count() === 1, 'not on the photos tab after a photo upload');
  expect(await parent.locator('[data-gallery] .video').count() === 0, 'a linked video in the photos tab');
  await parent.click('[data-gtab="videos"]');
  await parent.locator('[data-gallery] .video', { hasText: 'השער מול נחלים' }).waitFor();
  expect(await parent.locator('[data-gallery] .gl-tile').count() === 0, 'a photo in the videos tab');
  expect(await parent.locator('#view .sec-head', { hasText: 'סרטונים' }).count() === 0, 'a second videos section outside the gallery');
  await parent.click('[data-gtab="photos"]');
});

await step('reopening the media screen shows the gallery at once, not the pre-gallery screen while it loads', async () => {
  // A slow bridge, as Apps Script often is: the kept copy must carry the first frame.
  const slow = async (r) => { if ((r.request().postData() || '').includes('"getGallery"')) await new Promise((ok) => setTimeout(ok, 2500)); await r.continue().catch(() => {}); };
  await parent.route(BRIDGE, slow);
  await parent.goto(APP + '#/');
  await parent.reload();
  await parent.locator('.hero').waitFor();
  await parent.evaluate(() => { location.hash = '#/media'; });
  await parent.waitForTimeout(300);
  const first = await parent.locator('[data-gallery]').innerText();
  expect(!first.includes('טרם הועלו סרטונים') && await parent.locator('[data-gallery] [data-upload]').count() === 1, 'the first frame was not the gallery: ' + first.slice(0, 80));
  await parent.waitForTimeout(2800);
  await parent.unroute(BRIDGE, slow);
});

await step('the help explains uploading, hiding and where photos go — and never mentions a manager', async () => {
  await parent.click('[data-gallery] [data-help]');
  const sheet = parent.locator('.sheet', { hasText: 'איך הגלריה עובדת' });
  await sheet.waitFor();
  const t = await sheet.innerText();
  expect(['איך מעלים', 'הסתרה', 'לאן התמונות עולות'].every((h) => t.includes(h)), 'a section is missing: ' + t);
  expect(!t.includes('מנהל'), 'the help speaks of a manager');
  await sheet.locator('.sheet-x').click();
});

await step('another parent hides it: gone for everyone else, still there for the uploader', async () => {
  await other.click('#recheck');
  await other.locator('#nav').waitFor();
  await other.goto(APP + '#/media');
  await other.locator('[data-gallery] .gl-tile').first().click();
  await other.locator('.gv [data-v="hide"]').click();
  await other.locator('.sheet [data-hide]').click();
  await other.locator('.gv').waitFor({ state: 'detached' });
  expect(galleryFile().items[0].status === 'hidden', 'not hidden in gallery.json');
  await other.reload();
  await other.click('[data-gtab="photos"]');
  await other.locator('[data-gallery] .gl-empty').waitFor();
  await parent.reload();
  await parent.locator('[data-gallery] .gl-tile .gl-flag', { hasText: 'מוסתרת' }).waitFor();
});

await step('the manager sees what was hidden, by whom, and brings it back', async () => {
  await admin.goto(APP + '#/admin');
  await admin.click('[data-tab="media"]');
  await admin.locator('[data-tab="media"] .count', { hasText: '1' }).waitFor({ timeout: 8000 });
  await waitText(admin, 'הוסתרה ע״י אמא של דניאל');
  await admin.locator('[data-g-restore]').click();
  await admin.locator('[data-g-restore]').waitFor({ state: 'detached' });
  expect(galleryFile().items[0].status === 'live', 'not restored');
  await other.reload();
  await other.locator('[data-gallery] .gl-tile').first().waitFor();
});

await step('the uploader deletes their own photo', async () => {
  await parent.reload();
  await parent.locator('[data-gallery] .gl-tile').first().click();
  await parent.locator('.gv [data-v="delete"]').click();
  await parent.click('.sheet [data-ok]');
  await parent.locator('[data-gallery] .gl-empty').waitFor();
  expect(galleryFile().items.length === 0, 'still in gallery.json');
});

await step('several items are deleted at once by picking them; a parent picks only their own', async () => {
  await other.reload();
  await other.setInputFiles('[data-files]', { name: 'b.png', mimeType: 'image/png', buffer: PNG });
  await other.click('.sheet [data-go]');
  await other.locator('[data-gallery] .gl-tile').first().waitFor({ timeout: 8000 });
  await parent.reload();
  await parent.setInputFiles('[data-files]', [{ name: 'a1.png', mimeType: 'image/png', buffer: PNG }, { name: 'a2.png', mimeType: 'image/png', buffer: PNG }]);
  await parent.click('.sheet [data-go]');
  await parent.locator('[data-gallery] .gl-tile').nth(2).waitFor({ timeout: 8000 });
  // The overview is short: latest uploads and a card per game. Picking
  // happens on a game's page.
  expect(await parent.locator('[data-gallery] [data-sel="start"]').count() === 0, 'picking offered on the overview');
  await parent.locator('[data-gallery] .gl-album').first().click();
  await parent.locator('[data-gallery] [data-back]').waitFor();
  expect(await parent.locator('[data-gallery] .gl-album-grid .gl-tile').count() === 3, 'the game page does not hold all three photos');
  // The photos | videos switch stays on a game's page, even for a game
  // with photos only.
  await parent.click('[data-gallery] [data-gtab="videos"]');
  await parent.locator('[data-gallery] .gl-empty', { hasText: 'אין סרטונים מהמשחק הזה' }).waitFor();
  expect(await parent.locator('[data-gallery] [data-back]').count() === 1, 'switching tabs left the game page');
  await parent.click('[data-gallery] [data-gtab="photos"]');
  // "הגלריה" returns to the top of the page, not to where it was scrolled.
  await parent.evaluate(() => window.scrollTo(0, 400));
  await parent.click('[data-gallery] [data-back]');
  await parent.locator('[data-gallery] .gl-album').first().waitFor();
  expect(await parent.evaluate(() => window.scrollY) === 0, 'back to the gallery left the page scrolled');
  await parent.locator('[data-gallery] .gl-album').first().click();
  await parent.click('[data-sel="start"]');
  expect(await parent.locator('.gl-tile.pick.nopick').count() === 1, 'another parent\'s photo is pickable');
  await parent.click('[data-sel="all"]');
  expect(await parent.locator('.gl-tile.pick.on').count() === 2, 'select all did not take both of mine');
  await parent.click('[data-sel="delete"]');
  await parent.click('.sheet [data-ok]');
  await parent.locator('.gl-selbar').waitFor({ state: 'detached' });
  const left = galleryFile().items;
  expect(left.length === 1 && left[0].byName === 'אמא של דניאל', 'left: ' + JSON.stringify(left.map((x) => x.byName)));
});

await step('the manager picks anyone\'s items; the uploads switch answers at once', async () => {
  await admin.goto(APP + '#/media');
  await admin.locator('[data-gallery] .gl-album').first().click();
  await admin.click('[data-sel="start"]');
  await admin.locator('.gl-tile.pick:not(.nopick)').first().click();
  await admin.click('[data-sel="delete"]');
  await admin.click('.sheet [data-ok]');
  await admin.locator('.gl-selbar').waitFor({ state: 'detached' });
  expect(galleryFile().items.length === 0, 'the manager could not delete a parent\'s item');
  await admin.locator('[data-gallery] .gl-empty').waitFor();   // the emptied game page falls back to the overview
  // A slow bridge: the switch must move before it answers.
  await admin.route(BRIDGE, async (r) => {
    if ((r.request().postData() || '').includes('"setGallery"')) await new Promise((z) => setTimeout(z, 1500));
    await r.continue();
  });
  await admin.goto(APP + '#/admin');
  await admin.click('[data-tab="media"]');
  await admin.click('[data-g-mode="review"]');
  await admin.locator('[data-g-mode="review"][aria-selected="true"]').waitFor({ timeout: 400 });
  await admin.locator('.field .saving').waitFor({ timeout: 400 });
  await admin.locator('.field .saving').waitFor({ state: 'detached', timeout: 8000 });
  expect(galleryFile().settings.mode === 'review', 'mode not saved');
  await admin.click('[data-g-mode="open"]');
  await admin.locator('.field .saving').waitFor({ state: 'detached', timeout: 8000 });
  await admin.unroute(BRIDGE);
  const id = bridge.post({ action: 'listUsers', adminCode: ADMIN }).result.find((u) => u.name === 'אמא של דניאל').id;
  bridge.post({ action: 'removeUser', adminCode: ADMIN, id });
});

await step('revoking locks the parent out and drops their cached copy', async () => {
  await admin.goto(APP + '#/admin');
  await admin.click('[data-tab="access"]');
  await waitText(admin, 'אבא של איתי');
  await admin.locator('[data-set="revoked"]').first().click();
  await waitText(admin, 'עוד לא אושר אף אחד');
  await parent.reload();
  await waitText(parent, 'הגישה בוטלה');
  const cached = await parent.evaluate(() => localStorage.getItem('mg:season'));
  expect(cached === null, 'season still cached on a revoked device');
});

await step('no page errors and no CORS preflight on any device', async () => {
  const errs = [...parent.errors, ...admin.errors, ...(coach?.errors || []), ...(other?.errors || [])];
  expect(!errs.length, errs.join(' | '));
});

await browser.close();
app.close();
bridgeServer.close();
console.log(`\ne2e: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
