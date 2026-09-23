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
  try {
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
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
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.|ERR_FAILED/.test(m.text())) page.errors.push(`${label}: ${m.text()}`); });
  page.on('request', (r) => { if (r.method() === 'OPTIONS') page.errors.push(`${label}: CORS preflight sent to ${r.url()}`); });
  return page;
}
// Opens a list item in the editor whether or not it is already open —
// clicking the summary of an open <details> would close it instead.
const openItem = (page, path) => page.locator(`details[data-item="${path}"]`).evaluate((d) => { d.open = true; });
const text = (page) => page.locator('#view').innerText();
const waitText = (page, s, timeout = 5000) => page.locator('#view').getByText(s, { exact: false }).first().waitFor({ timeout });

const parent = await device('parent');
const admin = await device('admin');

console.log('e2e:');

await step('a new device lands on the access request, not on data', async () => {
  await parent.goto(APP);
  await waitText(parent, 'בקשת גישה');
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
  await waitText(admin, 'נתוני העונה');
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
  await admin.fill('[data-path="team.league"]', 'ליגת ילדים א');
  await admin.fill('[data-path="team.season"]', '2026/27');
  await admin.fill('[data-path="matches.0.date"]', '2026-09-19');
  await admin.fill('[data-path="matches.0.opponent"]', 'בני לוד');
  await admin.fill('[data-path="matches.0.gf"]', '2');
  await admin.fill('[data-path="matches.0.ga"]', '1');
  await admin.click('[data-add="players"]');
  await admin.fill('[data-path="players.0.name"]', 'איתי');
  await admin.fill('[data-path="players.0.goals"]', '2');
  await admin.click('#add-next');
  await admin.fill('[data-path="nextMatch.opponent"]', 'הפועל כוכבים');
  await admin.fill('[data-kick="date"]', '2030-10-05');
  await admin.fill('[data-kick="time"]', '10:30');
  await admin.fill('[data-path="nextMatch.venue.address"]', 'שדרות ירושלים 24, גבעתיים');
  await admin.click('#save');
  await waitText(admin, 'נשמר');
  const saved = JSON.parse(bridge.driveFile('season.json'));
  expect(saved.version === 1, 'version is ' + saved.version);
  expect(saved.season.nextMatch.kickoff === '2030-10-05T10:30:00+03:00', 'kickoff stored as ' + saved.season.nextMatch.kickoff);
  expect(saved.season.matches[0].gf === 2 && typeof saved.season.matches[0].gf === 'number', 'score not stored as a number');
  expect(!JSON.stringify(saved).includes('__open'), 'UI state leaked into the saved data');
});

await step('manager approves the parent', async () => {
  await admin.click('[data-tab="access"]');
  await waitText(admin, 'אבא של איתי');
  await admin.locator('[data-set="approved"]').first().click();
  await waitText(admin, 'אין בקשות חדשות');
});

await step('after approval the parent sees the season', async () => {
  await parent.click('#recheck');
  await waitText(parent, 'בני לוד');
  await waitText(parent, 'הפועל כוכבים');
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
  await admin.click('[data-tab="season"]');
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
  await other.fill('[data-path="team.league"]', 'שינוי ממכשיר שני');
  await other.click('#save');
  await waitText(other, 'גרסה 3');
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
  await admin.click('[data-tab="season"]');
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
  expect(await parent.locator('[data-board="minutes"]').count() === 0, 'a parent sees the minutes tab');
  const cached = await parent.evaluate(() => JSON.parse(localStorage.getItem('mg:season') || 'null'));
  expect(cached && cached.season.players.every((p) => !('minutes' in p)), 'minutes reached the parent\'s device');
  expect(cached.season.matches.every((m) => !('lineup' in m)), 'a past lineup reached the parent\'s device');
  await admin.goto(APP + '#/stats');
  await admin.locator('[data-board="minutes"]').waitFor();
});

await step('a history row opens the match with its goals and subs', async () => {
  await parent.goto(APP + '#/');
  await parent.locator('button.match', { hasText: 'מכבי נחלים' }).first().click();
  await parent.locator('.sheet .tl', { hasText: 'גיא פרץ' }).waitFor();
  await parent.locator('.sheet-x').click();
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
  await admin.click('[data-add="videos"]');
  await admin.fill('[data-path="videos.0.title"]', 'השער מול נחלים');
  await admin.fill('[data-path="videos.0.url"]', 'https://clips.example.com/goal');
  await admin.click('#save');
  await waitText(admin, 'נשמר');
  const v = JSON.parse(bridge.driveFile('season.json')).season.videos[0];
  expect(v.poster && v.posterFor === 'https://clips.example.com/goal', 'no poster made: ' + JSON.stringify(v));
  await parent.goto(APP + '#/media');
  await parent.reload();
  await parent.locator('.thumb-img[src^="blob:"]').first().waitFor({ timeout: 10000 });
});

await step('a pasted schedule becomes the next match and the list after it', async () => {
  await admin.goto(APP + '#/admin');
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
});

await step('deleting the games clears the schedule and typed results, and keeps live ones', async () => {
  await admin.goto(APP + '#/admin');
  await admin.click('[data-clear-games]');
  expect(!(await admin.locator('[data-clear="live"]').isChecked()), 'live matches must not be preselected');
  await admin.click('[data-clear-go]');
  await admin.click('#save');
  await waitText(admin, 'נשמר');
  const season = JSON.parse(bridge.driveFile('season.json')).season;
  expect(season.fixtures.length === 0, 'fixtures left: ' + season.fixtures.length);
  expect(season.matches.length > 0 && season.matches.every((m) => m.liveId), 'typed results left, or the live one lost: ' + JSON.stringify(season.matches.map((m) => m.opponent)));
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
  const errs = [...parent.errors, ...admin.errors];
  expect(!errs.length, errs.join(' | '));
});

await browser.close();
app.close();
bridgeServer.close();
console.log(`\ne2e: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
