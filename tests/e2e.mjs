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
import { deflateSync, crc32 } from 'node:zlib';
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
  catch (e) {
    failures.push(name);
    // Playwright's call log names the element it waited for: a timeout
    // alone does not say which of a step's clicks never happened.
    const waited = e.message.replace(/\x1b\[\d+m/g, '').split('\n').find((l) => /waiting for/.test(l));
    console.log('  ✗', name, '\n     ', e.message.split('\n')[0], waited ? '\n     ' + waited.trim() : '');
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

// A PNG of w×h, opaque gold where `fill` says, and elsewhere transparent —
// or the flat colour `bg`.
function rgbaPng(w, h, fill, bg = null) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (fill(x, y)) raw.set([232, 185, 49, 255], y * (w * 4 + 1) + 1 + x * 4);
    else if (bg) raw.set([...bg, 255], y * (w * 4 + 1) + 1 + x * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

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
// A save of the manager's screen, done: its message, not the text "נשמר" —
// "יש שינויים שלא נשמרו." has it too, and the wait passed before the save.
const waitSaved = (page, timeout = 5000) => page.locator('#view .save-msg.ok').waitFor({ timeout });
// We are always on the right (the owner): in an open match sheet, our crest and
// name over the score, our score, our scorers' column and our side of the
// timeline, and in each running score of the timeline ours is the last number.
const usOnRight = (page) => page.evaluate(() => {
  const x = (sel) => { const el = document.querySelector('.sheet ' + sel); return el ? el.getBoundingClientRect().x : null; };
  const bad = [];
  if (!(x('.ms-board .sc-team.us') > x('.ms-board .sc-team:not(.us)'))) bad.push('team names');
  if (!(x('.ms-board .sc-score .ours') > x('.ms-board .sc-score span:last-child'))) bad.push('score');
  if (x('.ms-scorers .them') != null && !(x('.ms-scorers .us') > x('.ms-scorers .them'))) bad.push('scorers');
  document.querySelectorAll('.sheet .mk-sc, .sheet .ev-sc').forEach((sc) => {
    const b = sc.querySelector('b'), r = sc.getBoundingClientRect();
    if (b && b.getBoundingClientRect().right < r.right - 12) bad.push('running score: ' + sc.textContent.trim());
  });
  return bad;
});

const parent = await device('parent');
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const admin = await device('admin');

console.log('e2e:');

await step('a new device lands on the access request, not on data', async () => {
  await parent.goto(APP);
  await waitText(parent, 'בקשת גישה');
});

await step('on a phone outside the home-screen app there is no request form and no way around it', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: IPHONE });
  await ctx.addInitScript((url) => { try { localStorage.setItem('mg:bridge', url); } catch {} }, BRIDGE);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const phone = await ctx.newPage();
  await phone.goto(APP);
  await phone.locator('.gate h2', { hasText: 'אחרי התקנה במסך הבית' }).waitFor();
  expect(await phone.locator('#request-form').count() === 0, 'a phone in the browser must not see the form');
  expect(await phone.locator('[data-skip-install]').count() === 0 && !(await text(phone)).includes('בלי התקנה'), 'a phone in the browser is offered a way around installing');
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
  expect(await parent.locator('[data-install-now]').count() === 0, 'no in-app install button: the guide teaches the ⋮ menu');
  expect(await parent.locator('a[data-install-guide][href^="docs/install.html"]').count() === 1, 'the install card links to the illustrated guide');
  expect(await parent.locator('details.install-os[open]').count() === 0, 'both systems start folded');
  await parent.locator('.gate h2', { hasText: 'בקשת גישה — אחרי התקנה במסך הבית' }).waitFor();
});

await step('an empty name is refused on the page', async () => {
  await parent.locator('#request-form button[type=submit]').click();
  await waitText(parent, 'צריך למלא שם');
});

await step('sending a request shows the pending screen', async () => {
  await parent.fill('input[name=name]', 'אבא של איתי');
  await parent.locator('#request-form button[type=submit]').click();
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
  // A hand-entered result names its scorers: one row per goal of ours.
  expect(await admin.locator('[data-goals-host="0"] select[data-gk="scorer"]').count() === 2, 'no scorer row per goal of ours');
  await admin.selectOption('[data-goal="0.0"][data-gk="scorer"]', { label: 'איתי' });
  await admin.selectOption('[data-goal="0.1"][data-gk="scorer"]', 'og');
  expect(await admin.locator('[data-goal="0.1"][data-gk="assist"]').isDisabled(), 'an own goal takes an assist');
  // The next match is the schedule's nearest row, with everything the old
  // separate record held: gathering time, kit, the crest.
  const fx = await newRow(admin, 'fixtures');
  await admin.fill(`[data-path="${fx}.opponent"]`, 'הפועל כוכבים');
  await admin.fill(`[data-path="${fx}.date"]`, '2030-10-05');
  await admin.fill(`[data-path="${fx}.time"]`, '10:30');
  await admin.fill(`[data-path="${fx}.venue.address"]`, 'שדרות ירושלים 24, גבעתיים');
  await admin.fill(`[data-path="${fx}.arrival"]`, '09:45');
  await admin.fill(`[data-path="${fx}.kit"]`, 'כחול / לבן');
  // The opponent's crest: uploaded here, kept by name, shown to parents below.
  // It comes with a transparent margin, which the upload cuts away: 40×40
  // with a 10×30 shield in it arrives as 10×30.
  await admin.setInputFiles('.logo-row [data-logo-file="הפועל כוכבים"]', { name: 'crest.png', mimeType: 'image/png', buffer: rgbaPng(40, 40, (x, y) => x >= 10 && x < 20 && y >= 5 && y < 35) });
  const logo = admin.locator('.logo-row .opp-logo[src]');
  await logo.waitFor({ timeout: 8000 });
  const dims = await logo.evaluate(async (i) => { await i.decode(); return `${i.naturalWidth}x${i.naturalHeight}`; });
  expect(dims === '10x30', 'crest margin not cropped: ' + dims);
  // A wider shield on Gemini's flat green (CREST_PROMPT): the green goes, and
  // with it the margin. (Another size, or the bridge would keep the same
  // file and hand back the same ref.)
  const was = await logo.getAttribute('data-poster');
  await admin.setInputFiles('.logo-row [data-logo-file="הפועל כוכבים"]', { name: 'crest.png', mimeType: 'image/png', buffer: rgbaPng(40, 40, (x, y) => x >= 10 && x < 22 && y >= 5 && y < 35, [7, 245, 7]) });
  await admin.waitForFunction((w) => { const i = document.querySelector('.logo-row .opp-logo[src]'); return i && i.dataset.poster !== w; }, was, { timeout: 8000 });
  const keyed = await admin.locator('.logo-row .opp-logo[src]').evaluate(async (i) => { await i.decode(); return `${i.naturalWidth}x${i.naturalHeight}`; });
  expect(keyed === '12x30', 'green background not removed: ' + keyed);
  await admin.click('#save');
  await waitSaved(admin);
  // Saved, the row folds, marked as the next match, with its crest.
  const nextRow = admin.locator('details[data-item^="fixtures."]', { hasText: 'הפועל כוכבים' });
  expect(await nextRow.getAttribute('open') === null, 'the next match stays open after saving');
  const nextSum = (await nextRow.locator('summary').innerText()).replace(/\s+/g, ' ');
  expect(nextSum.includes('המשחק הבא') && nextSum.includes('05.10.30') && nextSum.includes('10:30') && nextSum.includes('התכנסות 09:45'), 'next match row: ' + nextSum);
  await nextRow.locator('summary .opp-logo[src]').waitFor({ timeout: 8000 });
  expect(await admin.locator('.crest-tile', { hasText: 'הפועל כוכבים' }).locator('.opp-logo[src]').count() === 1, 'the crests section lacks the uploaded crest');
  const saved = JSON.parse(bridge.driveFile('season.json'));
  expect(saved.version === 1, 'version is ' + saved.version);
  expect(!('nextMatch' in saved.season), 'a separate next match was stored');
  const f0 = saved.season.fixtures[0];
  expect(f0.date === '2030-10-05' && f0.time === '10:30' && f0.arrival === '09:45' && f0.kit === 'כחול / לבן', 'next match row stored as ' + JSON.stringify(f0));
  expect(saved.season.matches[0].gf === 2 && typeof saved.season.matches[0].gf === 'number', 'score not stored as a number');
  const goals = saved.season.matches[0].goals;
  expect(goals?.length === 2 && goals[0].scorer === saved.season.players[0].id && goals[1].og === true, 'scorers not saved: ' + JSON.stringify(goals));
  expect(saved.season.team.homeVenue?.address === 'רחוב המעיין 4, גבעתיים', 'home ground not saved: ' + JSON.stringify(saved.season.team));
  expect(!JSON.stringify(saved).includes('__open'), 'UI state leaked into the saved data');
  expect(/^[\w-]{10,}$/.test(saved.season.opponentLogos?.['הפועל כוכבים'] || ''), 'crest not stored by name: ' + JSON.stringify(saved.season.opponentLogos));
});

await step('the settings copy the crest prompt for Gemini', async () => {
  await admin.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP });
  await adminTab(admin, 'team');
  await admin.click('[data-crest-prompt]');
  await admin.locator('.toast', { hasText: 'ההנחיה הועתקה' }).waitFor();
  const copied = await admin.evaluate(() => navigator.clipboard.readText());
  expect(copied.includes('#00FF00') && copied.includes('משבצות'), 'the prompt was not copied: ' + copied.slice(0, 80));
  await adminTab(admin, 'games');
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

await step('the toggle switches what copy and WhatsApp send: the install, parent, player or coach guide', async () => {
  for (const [kind, page] of [['install', 'docs/install.html'], ['parent', 'docs/parent.html'], ['player', 'docs/player.html'], ['coach', 'docs/coach.html']]) {
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

await step('the manager renames an approved device from the access list', async () => {
  const rename = async (from, to) => {
    await admin.locator('[data-rename]', { hasText: from }).click();
    const input = admin.locator('.sheet [data-rename-input]');
    expect(await input.inputValue() === from, 'the sheet does not start from the current name');
    await input.fill(to);
    await admin.locator('.sheet [data-go]').click();
    await admin.locator('.sheet').waitFor({ state: 'detached' });
    await admin.locator('.user-row .who-name', { hasText: new RegExp('^' + to + '$') }).waitFor({ timeout: 5000 });
  };
  // The name on one line, when they asked and were last seen on the next.
  const lines = await admin.locator('.user-row .who').first().evaluate((w) => {
    const name = w.querySelector('.who-name').getBoundingClientRect();
    const meta = w.querySelector(':scope > span').getBoundingClientRect();
    return { nameBottom: name.bottom, metaTop: meta.top };
  });
  expect(lines.metaTop >= lines.nameBottom - 1, 'the request line sits beside the name: ' + JSON.stringify(lines));
  await rename('אבא של איתי', 'אבא של איתי כהן');
  const users = await bridge.post({ action: 'listUsers', adminCode: ADMIN });
  expect(users.result.some((u) => u.name === 'אבא של איתי כהן' && u.status === 'approved'), 'not renamed in the bridge: ' + JSON.stringify(users.result));
  await rename('אבא של איתי כהן', 'אבא של איתי');
});

await step('after approval the parent sees the season on returning to the app, with no tap', async () => {
  await parent.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await parent.locator('.form-pill[aria-label*="בני לוד"]').waitFor({ timeout: 5000 });
  await waitText(parent, 'הפועל כוכבים');
  await parent.locator('.hero .side:not(.us) .opp-logo[src^="blob:"]').waitFor({ timeout: 8000 });
  const hero = await parent.locator('.hero').innerText();
  expect(hero.includes('09:45') && hero.includes('כחול / לבן'), 'gathering or kit missing from the next match: ' + hero);
  const t = await text(parent);
  expect(t.includes('איתי'), 'player missing');
  // The scorers the manager named open with the result.
  await parent.locator('.form-pill[aria-label*="בני לוד"]').click();
  const sheet = parent.locator('.sheet', { hasText: 'מול בני לוד' });
  await sheet.waitFor();
  const st = await sheet.innerText();
  const cols = await sheet.locator('.ms-scorers .us').innerText();
  expect(cols.includes('איתי') && cols.includes('גול עצמי'), 'hand-entered scorers missing under the score: ' + st);
  const wrongSide = await usOnRight(parent);
  expect(!wrongSide.length, 'not on the right in the match sheet: ' + wrongSide.join(', '));
  await parent.locator('.sheet-x').click();
  await parent.locator('.sheet').waitFor({ state: 'detached' });
  await parent.waitForFunction(() => !history.state?.mgLayer);
});

await step('the Waze link is built from the address', async () => {
  const href = await parent.locator('a.btn[href*="waze.com"]').getAttribute('href');
  expect(href.includes(encodeURIComponent('שדרות ירושלים 24')), 'waze href: ' + href);
});

await step('"all matches" and friends on home land on their own section in stats, not its top', async () => {
  const jumps = await parent.$$eval('a[data-jump]', (as) => as.map((x) => x.dataset.jump));
  expect(jumps.includes('stats-matches'), 'no jump links on home: ' + jumps.join(', '));
  for (const id of jumps) {
    await parent.locator(`a[data-jump="${id}"]`).click();
    await parent.locator('#' + id).waitFor();
    // At the top of the screen, or as far as the page scrolls when it is near the end.
    const { top, bottom } = await parent.evaluate((i) => ({ top: document.getElementById(i).getBoundingClientRect().top,
      bottom: Math.abs(scrollY + innerHeight - document.documentElement.scrollHeight) < 2 && scrollY > 0 }), id);
    expect(top >= 0 && (top < 60 || bottom), `${id} is at ${Math.round(top)}px, not the top of the screen`);
    await parent.evaluate(() => { location.hash = '#/'; });
    await parent.locator('a[data-jump]').first().waitFor();
  }
});

await step('scrolling down shrinks the nav to its icons (not gone), scrolling up brings it back', async () => {
  await parent.evaluate(() => { location.hash = '#/stats'; });
  await parent.locator('#stats-matches').waitFor();
  const nav = () => parent.evaluate(() => { const n = document.getElementById('nav'); return {
    h: n.getBoundingClientRect().height, label: getComputedStyle(n.querySelector('a span')).opacity, small: document.body.classList.contains('nav-small') }; });
  const full = await nav();
  expect(!full.small && full.h > 60, `the nav is ${Math.round(full.h)}px at the top of the screen`);
  // With the finger, not in one jump: half the range scrolled is a nav
  // half way, until the scroll stops and it settles.
  const mid = await parent.evaluate(() => new Promise((r) => { scrollBy(0, 35); requestAnimationFrame(() => requestAnimationFrame(() => r(document.getElementById('nav').getBoundingClientRect().height))); }));
  expect(mid > 50 && mid < 62, `half a scroll range left the nav at ${Math.round(mid)}px, not half way`);
  await parent.evaluate(() => scrollTo(0, 0));
  await parent.waitForTimeout(400);
  await parent.mouse.move(200, 400);
  for (let i = 0; i < 5; i++) { await parent.mouse.wheel(0, 120); await parent.waitForTimeout(50); }
  await parent.waitForTimeout(400);
  const small = await nav();
  expect(small.small && small.h < 50 && small.h > 30 && Number(small.label) === 0, `after a scroll down: ${JSON.stringify(small)}`);
  await parent.mouse.wheel(0, -100);
  await parent.waitForTimeout(400);
  const back = await nav();
  expect(!back.small && back.h > 60, `after a scroll up: ${JSON.stringify(back)}`);
  await parent.evaluate(() => { location.hash = '#/'; });
  await parent.locator('a[data-jump]').first().waitFor();
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
  // Results read by home and away (the owner): the home side on the right — a
  // home win of 3 to 1 is written 1:3, ours last (away: tests/units.mjs).
  await parent.locator('.form-pill[aria-label*="בני לוד"]', { hasText: '1:3' }).waitFor({ timeout: 5000 });
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
  await admin.locator('details[data-item^="fixtures."]', { hasText: 'הפועל כוכבים' }).locator('summary').click();
  await admin.click('[data-played]');
  expect(await admin.inputValue('[data-path="matches.0.opponent"]') === 'הפועל כוכבים', 'opponent not carried over');
  expect(await admin.inputValue('[data-path="matches.0.date"]') === '2030-10-05', 'date not carried over');
  await admin.fill('[data-path="matches.0.gf"]', '1');
  await admin.fill('[data-path="matches.0.ga"]', '1');
  await admin.click('#save');
  await waitText(admin, 'גרסה 4');
  const s = JSON.parse(bridge.driveFile('season.json')).season;
  expect(s.fixtures.length === 0 && s.matches.length === 2, 'fixture not moved');
});

await step('a next match stored the old way folds into the schedule on the manager\'s next visit', async () => {
  const cur = JSON.parse(bridge.driveFile('season.json'));
  const legacy = { ...cur.season, nextMatch: { opponent: 'מכבי ישן', home: true, round: 3, kickoff: '2030-10-12T11:00:00+03:00', arrival: '10:15', kit: 'צהוב', venue: { name: '', address: '', waze: '' } } };
  await admin.evaluate(([url, season, v]) => import(url).then((m) => m.call('putSeason', { season, baseVersion: v }, { asAdmin: true })), [APP + 'src/bridge.js', legacy, cur.version]);
  await admin.goto(APP + '#/');
  await admin.goto(APP + '#/admin');
  await waitText(admin, 'המשחק הבא עבר ללוח המשחקים');
  await adminTab(admin, 'games');
  await admin.locator('details[data-item^="fixtures."]', { hasText: 'מכבי ישן' }).waitFor();
  await admin.click('#save');
  await waitSaved(admin);
  const s = JSON.parse(bridge.driveFile('season.json')).season;
  const row = s.fixtures.find((f) => f.opponent === 'מכבי ישן');
  expect(!('nextMatch' in s) && row && row.time === '11:00' && row.arrival === '10:15' && row.kit === 'צהוב', 'folded as ' + JSON.stringify(row));
  // Out of the way of the steps after it.
  const again = JSON.parse(bridge.driveFile('season.json'));
  await admin.evaluate(([url, season, v]) => import(url).then((m) => m.call('putSeason', { season, baseVersion: v }, { asAdmin: true })),
    [APP + 'src/bridge.js', { ...again.season, fixtures: again.season.fixtures.filter((f) => f.opponent !== 'מכבי ישן') }, again.version]);
  await admin.goto(APP + '#/');
  await admin.goto(APP + '#/admin');
  await waitText(admin, `הכל שמור · גרסה ${again.version + 1}`);
});

// ---- live match ----
const liveFile = () => JSON.parse(bridge.driveFile('live.json') || '{}').state;
const seasonFile = () => JSON.parse(bridge.driveFile('season.json')).season;
// The live screen's routines. A sheet that closes takes its history step
// off; a navigation sent before that landed would be undone by it.
const sheetGone = async (page) => {
  await page.locator('.sheet').waitFor({ state: 'detached' });
  await page.waitForFunction(() => !history.state?.mgLayer);
};
// Time lives in the clock: a tap on it, then the end of the period.
const endPeriod = async (page) => {
  await page.click('[data-act="clock"]');
  await page.click('.sheet [data-ck-end]');
  await sheetGone(page);
};
// At a break the early finish is in "עוד", as it always was.
const finishNow = async (page) => {
  await page.click('[data-act="more"]');
  await page.click('.sheet [data-m="finish"]');
  await page.click('[data-ok]');
};
// The match details, before kick-off, are a sheet from the scoreboard.
const setOpponent = async (page, name, { open = true } = {}) => {
  if (open) await page.click('[data-act="details"]');
  await page.fill('.sheet [data-meta="opponent"]', name);
  await page.click('.sheet [data-done]');
  await sheetGone(page);
};
// Into the lineup from "not in the lineup" under the pitch, by number or name.
const addToLineup = async (page, keys) => {
  for (const k of keys) {
    const p = liveFile().players.find((x) => String(x.number) === k) || liveFile().players.find((x) => x.name.includes(k));
    const n = liveFile().lineup.length;
    await page.click(`[data-lineup="${p.id}"]`);
    for (let i = 0; i < 50 && liveFile().lineup.length === n; i++) await new Promise((r) => setTimeout(r, 100));
  }
};
const onPitch = (page) => page.locator('.pitch .pl:not(.open)').count();

await step('players are imported by pasting cells from a spreadsheet', async () => {
  await adminTab(admin, 'players');
  await adminTools(admin, 'players');
  await admin.click('[data-import="paste"]');
  await admin.fill('[data-paste]', 'מספר\tשם\tעמדה\n1\tנועם\tשוער\n9\tגיא פרץ\tחלוץ\n10\tדניאל לוי\tקשר קדמי\n14\tתומר עזרא\tבלם\n');
  await admin.click('[data-go]');
  await admin.locator('[data-apply]').click();
  await admin.click('#save');
  await waitSaved(admin);
  const names = seasonFile().players.map((p) => p.name);
  expect(['גיא פרץ', 'דניאל לוי', 'תומר עזרא', 'נועם'].every((n) => names.includes(n)), 'imported: ' + names.join(','));
  expect(seasonFile().players.find((p) => p.name === 'גיא פרץ').pos === 'ST', 'position not read');
});

await step('back in the app after a while, the parent sees what changed meanwhile, with no reload', async () => {
  // iOS resumes a home-screen app instead of loading it again: the season
  // read when it was opened stayed on screen — last week's next match, a
  // result missing — until the phone happened to drop the app.
  await parent.goto(APP + '#/');
  await parent.locator('.hero').waitFor();
  const reads = [];
  const onReq = (r) => { if (r.url().startsWith(BRIDGE) && (r.postData() || '').includes('"getSeason"')) reads.push(1); };
  parent.on('request', onReq);
  await parent.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await parent.waitForTimeout(500);
  expect(!reads.length, 'a quick look away read the season again');
  await adminTab(admin, 'team');
  const was = await admin.inputValue('[data-path="team.league"]');
  await admin.fill('[data-path="team.league"]', 'ליגה אחרת מחוז דן');
  await admin.click('#save');
  await waitSaved(admin);
  await parent.evaluate(() => { window.__realNow = Date.now; const real = Date.now; Date.now = () => real() + 120000; document.dispatchEvent(new Event('visibilitychange')); });
  await parent.locator('.topbar', { hasText: 'ליגה אחרת מחוז דן' }).waitFor({ timeout: 5000 });
  await parent.evaluate(() => { Date.now = window.__realNow; });
  parent.off('request', onReq);
  await admin.fill('[data-path="team.league"]', was);
  await admin.click('#save');
  await waitSaved(admin);
});

await step('a season read that brings nothing new redraws nothing', async () => {
  // Each redraw asked the bridge for the gallery again on the media screen,
  // and put back whatever the parent had opened.
  await parent.goto(APP + '#/stats');
  await parent.reload();                    // the device's copy as the season is now
  await parent.locator('#board-tabs').waitFor();
  await parent.waitForTimeout(800);
  const slow = async (r) => { await new Promise((ok) => setTimeout(ok, 700)); await r.continue().catch(() => {}); };
  await parent.route(BRIDGE, slow);
  await parent.reload();
  await parent.locator('#board-tabs [data-board="assists"]').click();
  await parent.waitForTimeout(2000);   // the season and the first live poll land
  await parent.unroute(BRIDGE, slow);
  expect(await parent.getAttribute('#board-tabs [data-board="assists"]', 'aria-selected') === 'true', 'the board was put back by a redraw with nothing new');
});

await step('the manager opens a live match and picks a lineup', async () => {
  await admin.goto(APP + '#/live');
  await admin.click('[data-act="new"]');
  await admin.locator('.formation-seg').waitFor();
  await admin.click('[data-act="start"]');
  await admin.locator('.toast', { hasText: 'חסר שם היריבה' }).waitFor();
  // The details sheet opens by itself, at the missing name.
  await setOpponent(admin, 'מכבי נחלים', { open: false });
  for (let i = 0; i < 50 && liveFile().opponent !== 'מכבי נחלים'; i++) await new Promise((r) => setTimeout(r, 100));
  await addToLineup(admin, ['1', '9', '10', 'איתי']);
  await admin.waitForFunction(() => document.querySelectorAll('.pitch .pl:not(.open)').length === 4);
  await admin.click('[data-act="start"]');
  await admin.locator('.sc-goal[data-act="goal-us"]').waitFor();
  // A running match: the goals are the crests in a board that stays at the
  // top, the substitution and "more" float above the nav — on screen at the
  // top of the page and at its bottom, and the page end clears them.
  expect(await admin.locator('.live-dock [data-act="goal-us"], .live-dock [data-act="penalty"]').count() === 0, 'the goal or penalty buttons are still in the bottom bar');
  const vh = admin.viewportSize().height;
  for (const y of ['0', 'document.body.scrollHeight']) {
    await admin.evaluate((to) => window.scrollTo(0, eval(to)), y);
    await admin.waitForTimeout(400);
    // The page is redrawn with every send; a box read mid-redraw is null.
    const boxOf = async (sel) => { let b = null; for (let k = 0; k < 20 && !b; k++) b = await admin.locator(sel).boundingBox().catch(() => null) || (await admin.waitForTimeout(100), null); return b; };
    const goal = await boxOf('.sc-goal[data-act="goal-us"]');
    const sub = await boxOf('.live-dock [data-act="sub"]');
    const nav = await admin.locator('.nav').boundingBox();
    expect(goal && goal.y >= 0 && goal.y + goal.height < vh / 3, `the crest goal button left the top of the screen (scrolled to ${y}): ` + JSON.stringify(goal));
    expect(sub && sub.y >= 0 && sub.y + sub.height <= nav.y, `the substitution left the screen or sits under the nav (scrolled to ${y}): ` + JSON.stringify(sub));
  }
  const last = await admin.locator('#view > *:last-child').evaluate((el) => el.previousElementSibling?.getBoundingClientRect().bottom ?? 0);
  const dockTop = (await admin.locator('.live-dock').boundingBox()).y;
  expect(last <= dockTop + 1 && dockTop < vh, `the page end hides under the bar (${last} > ${dockTop})`);
  await admin.evaluate(() => window.scrollTo(0, 0));
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
  expect(await parent.locator('.live-dock, [data-act="clock"]').count() === 0, 'a watching parent sees controls');
});

await step('the match screen switches between the pitch and the events, without scrolling', async () => {
  await parent.goto(APP + '#/live');
  await parent.reload();
  const pitch = parent.locator('#pane-pitch');
  const events = parent.locator('#pane-events');
  await pitch.waitFor({ timeout: 8000 });
  expect(await events.isHidden(), 'both panes show at once');
  // The switch counts the events, and the goal is behind it.
  expect((await parent.locator('.pane-tabs [data-pane="events"] .tab-count').innerText()) === '1', 'no event count on the switch');
  await parent.click('.pane-tabs [data-pane="events"]');
  await events.locator('.ev-list').waitFor();
  expect(await pitch.isHidden(), 'the pitch still shows under the events');
  expect(await parent.locator('.pane-tabs [data-pane="events"]').getAttribute('aria-selected') === 'true', 'the tab is not marked');
  // Away and back within the visit keeps the chosen pane.
  await parent.evaluate(() => { location.hash = '#/stats'; });
  await parent.locator('#pane-events').waitFor({ state: 'detached' });
  await parent.evaluate(() => { location.hash = '#/live'; });
  await events.waitFor({ timeout: 8000 });
  await parent.click('.pane-tabs [data-pane="pitch"]');
  await pitch.locator('.pitch').waitFor();
  // A parent is not the coach: no match | minutes switch at all.
  expect(await parent.locator('.live-tabs').count() === 0, 'a parent sees the screen switch');
});

await step('the formation changes during the match: positions move from that minute, and parents see it', async () => {
  const before = Object.fromEntries(liveFile().lineup.map((l) => [l.pid, l.pos]));
  await admin.click('[data-act="more"]');
  await admin.click('[data-m="shape"]');
  await admin.locator('.sheet [data-shape="4-2-2"]').click();
  // Two taps swap two players' positions in the preview.
  const [p1, p2] = await admin.locator('.sheet [data-swap]').evaluateAll((els) => els.slice(0, 2).map((b) => b.dataset.swap));
  await admin.locator(`.sheet [data-swap="${p1}"]`).click();
  await admin.locator(`.sheet [data-swap="${p2}"][aria-pressed="false"]`).click();
  await admin.click('[data-shape-go]');
  let ev;
  for (let k = 0; k < 80 && !(ev = liveFile().events.find((e) => e.type === 'shape')); k++) await new Promise((r) => setTimeout(r, 100));
  expect(ev && ev.formation === '4-2-2', 'no formation change recorded: ' + JSON.stringify(liveFile().events));
  const slots = ['GK', 'RWB', 'CB', 'CB', 'LWB', 'CM', 'CM', 'ST', 'ST'];
  expect(ev.moves.length === Object.keys(before).length && ev.moves.every((m) => slots.includes(m.pos)), 'moves outside 4-2-2: ' + JSON.stringify(ev.moves));
  // No one came on or off, and the starting lineup is as it was.
  expect(JSON.stringify(Object.fromEntries(liveFile().lineup.map((l) => [l.pid, l.pos]))) === JSON.stringify(before), 'the change rewrote the starting lineup');
  await parent.locator('#pane-pitch .pane-hint', { hasText: '4-2-2' }).waitFor({ timeout: 8000 });
  await parent.click('.pane-tabs [data-pane="events"]');
  // Not an event of the match to the owner: the pitch shows it, the timeline does not.
  await parent.locator('#pane-events .ev-kick').waitFor();
  expect(await parent.locator(`#pane-events li[data-ev="${ev.id}"]`).count() === 0, 'the formation change is in the timeline');
  await parent.click('.pane-tabs [data-pane="pitch"]');
});

await step('the manager sees how many watch, and who; a parent does not', async () => {
  await admin.locator('.watch-chip', { hasText: '1' }).waitFor({ timeout: 8000 });
  await admin.click('.watch-chip');
  await admin.locator('.sheet', { hasText: 'אבא של איתי' }).waitFor();
  await admin.click('.sheet-x');
  expect(await parent.locator('.watch-chip').count() === 0, 'a parent sees the watcher count');
});

await step('the live screen of a parent is not redrawn by polls that bring nothing new', async () => {
  // The manager's answer carries `control`, a parent's does not: comparing
  // the missing field with the stored null once read as a change on every
  // poll, and the board (crests and all) was redrawn every few seconds.
  await parent.evaluate(() => { document.querySelector('.sc-row').__mark = 1; });
  await parent.waitForTimeout(3000);   // six polls at mg:pollMs = 500
  expect(await parent.evaluate(() => document.querySelector('.sc-row').__mark === 1), 'the live board was redrawn with nothing new');
});

await step('tapping a player on the pitch substitutes them', async () => {
  // A real change redraws the board, but the crest already on screen stays
  // the same element: a new <img> would load again and blink.
  await parent.evaluate(() => { document.querySelector('.sc-crest img').__mark = 1; });
  await admin.locator('button.pl', { hasText: 'איתי' }).click();
  await admin.locator('.pick', { hasText: 'תומר עזרא' }).click();
  await waitText(admin, 'כולם רואים');
  const sub = liveFile().events.find((e) => e.type === 'sub');
  expect(!!sub, 'no sub recorded');
  await parent.locator('.pl', { hasText: 'תומר' }).waitFor({ timeout: 8000 });
  expect(await parent.evaluate(() => document.querySelector('.sc-crest img').__mark === 1), 'the crest was drawn afresh on a redraw');
});

await step('a sub entered with the wrong player is corrected from the timeline, as if entered right', async () => {
  const sub = liveFile().events.find((e) => e.type === 'sub');
  const outName = 'איתי';
  await admin.click('.pane-tabs [data-pane="events"]');
  await admin.click(`#pane-events [data-event="${sub.id}"]`);
  await admin.click('.sheet [data-e="out"]');
  const pick = admin.locator('.sheet .pick').first();
  const pid = await pick.getAttribute('data-pick');
  expect(pid !== sub.in && pid !== sub.out, 'the picker offered the players of the sub itself');
  await pick.click();
  let now;
  for (let k = 0; k < 80 && (now = liveFile().events.find((e) => e.id === sub.id)).out !== pid; k++) await new Promise((r) => setTimeout(r, 100));
  expect(now.out === pid && now.in === sub.in && now.atMs === sub.atMs, 'the sub was not corrected in place: ' + JSON.stringify(now));
  // The player first taken off is back on the pitch, for everyone.
  await parent.locator('.pl', { hasText: outName }).waitFor({ timeout: 8000 });
  // Back as it was, through the same sheet.
  await admin.click(`#pane-events [data-event="${sub.id}"]`);
  await admin.click('.sheet [data-e="out"]');
  await admin.locator('.sheet .pick', { hasText: outName }).click();
  for (let k = 0; k < 80 && liveFile().events.find((e) => e.id === sub.id).out !== sub.out; k++) await new Promise((r) => setTimeout(r, 100));
  expect(liveFile().events.find((e) => e.id === sub.id).out === sub.out, 'the sub did not go back');
  await admin.click('.pane-tabs [data-pane="pitch"]');
});

await step('the substitutions mode: numbers marked off and on in any order, recorded as one wave, undone as one', async () => {
  const subs = () => liveFile().events.filter((e) => e.type === 'sub');
  const poll = async (fn, what) => {
    for (let t = 0; t < 80 && !fn(); t++) await new Promise((r) => setTimeout(r, 100));
    expect(fn(), 'timed out waiting for ' + what);
  };
  const before = subs().length;
  await admin.click('[data-act="sub"]');
  const sheet = admin.locator('.sheet');
  try {
  await sheet.locator('.wave-grid').first().waitFor();
  const offs = sheet.locator('.wave-tile[data-out]');
  const ons = sheet.locator('.wave-tile[data-in]');
  // As big a wave as the test squad allows (two when the bench has two).
  const k = Math.min(2, await ons.count());
  expect(k >= 1, 'no one on the bench to bring on');
  const outIds = [], inIds = [];
  for (let i = 0; i < k; i++) {
    outIds.push(await offs.nth(i + 1).getAttribute('data-out'));
    inIds.push(await ons.nth(i).getAttribute('data-in'));
  }
  // Coming on first, then going off: any order.
  for (const id of inIds) await sheet.locator(`[data-in="${id}"]`).click();
  expect(await sheet.locator('[data-wave-go]').isDisabled(), 'recordable with more on than off');
  // A second tap unmarks.
  await sheet.locator(`[data-out="${outIds[0]}"]`).click();
  await sheet.locator(`[data-out="${outIds[0]}"]`).click();
  expect(await sheet.locator(`[data-out="${outIds[0]}"]`).getAttribute('aria-pressed') === 'false', 'a second tap did not unmark');
  for (const id of outIds) await sheet.locator(`[data-out="${id}"]`).click();
  const atStart = /תחילת/.test(await sheet.locator('[data-timing][aria-checked="true"], .timing-fixed').first().innerText());
  // A sub already recorded after this period's whistle: the wave cannot go
  // before it, so the default is now. (Put first, it brought on a player who
  // was still on the field then — the pitch lost him.)
  const live = liveFile();
  if (live.events.some((e) => (e.type === 'sub' || e.type === 'shape') && e.period === live.period && e.atMs > 0)) {
    expect(!atStart, 'the wave defaulted to the whistle, before a sub made after it');
  }
  await sheet.locator('[data-wave-go]').click();
  await poll(() => subs().length === before + k, 'the wave to reach the bridge');
  const wave = subs().slice(-k);
  expect(wave.every((e) => outIds.includes(e.out)) && new Set(wave.map((e) => e.out)).size === k, 'the wrong players went off: ' + JSON.stringify(wave));
  expect(wave.every((e) => inIds.includes(e.in)), 'the wrong players came on: ' + JSON.stringify(wave));
  expect(wave.every((e) => e.period === wave[0].period && e.atMs === wave[0].atMs), 'a wave at two minutes: ' + JSON.stringify(wave));
  expect(!!wave[0].atStart === atStart, 'the minute shown is not the one recorded: ' + JSON.stringify(wave[0]));
  // The sheet stays open for the next wave, the players moved sides.
  await sheet.locator(`.wave-tile[data-out="${inIds[0]}"]`).waitFor();
  await sheet.locator(`.wave-tile[data-in="${outIds[0]}"]`).waitFor();
  // One undo for the whole wave.
  await sheet.locator('[data-wave-undo="0"]').click();
  await poll(() => subs().length === before, 'the wave to be undone');
  await sheet.locator(`.wave-tile[data-out="${outIds[0]}"]`).waitFor();
  } catch (e) {
    console.log('     sheet:', (await sheet.count()) ? (await sheet.innerText()).replace(/\s+/g, ' ') : '(closed)');
    console.log('     subs on the bridge:', JSON.stringify(subs().slice(-3)));
    throw e;
  } finally {
    if (await sheet.count()) await admin.locator('.sheet-x').click();
  }
  await sheet.waitFor({ state: 'detached' });
  await admin.waitForFunction(() => !history.state?.mgLayer);
});

await step('a wrong live code is refused; the right one hands the parent control', async () => {
  await admin.click('[data-act="more"]');
  await admin.click('.sheet [data-m="code"]');
  await admin.fill('[data-code-form] input', '4821');
  await admin.locator('[data-code-form] button').click();
  await admin.locator('.toast', { hasText: '4821' }).waitFor();
  await parent.click('[data-act="claim"]');
  await parent.fill('[data-claim] input', '0000');
  await parent.locator('[data-claim] button').click();
  await parent.locator('[data-msg]', { hasText: 'נותרו' }).waitFor();
  await parent.fill('[data-claim] input', '4821');
  await parent.locator('[data-claim] button').click();
  await parent.locator('.sc-goal[data-act="goal-us"]').waitFor({ timeout: 8000 });
});

await step('the parent in control records a goal against; the manager sees it', async () => {
  await parent.click('[data-act="goal-them"]');
  await admin.locator('.sc-score [data-them]', { hasText: '1' }).waitFor({ timeout: 8000 });
});

await step('a double tap is one tap: one goal against, and a sheet that stays open', async () => {
  // Nothing swallows a quick second tap on a phone any more (no double-tap
  // zoom): on "goal against" it was a second goal, and on "goal" the second
  // tap landed on the sheet's backdrop and closed it as it opened.
  const against = () => liveFile().events.filter((e) => e.type === 'goal' && e.side === 'them').length;
  const before = against();
  // The step before tapped the same button a moment ago: that tap and this
  // double tap would read as three taps in a row.
  await parent.waitForTimeout(800);
  await parent.dblclick('[data-act="goal-them"]');
  await admin.locator('.sc-score [data-them]', { hasText: String(before + 1) }).waitFor({ timeout: 8000 });
  await parent.waitForTimeout(1500);
  expect(against() === before + 1, `a double tap recorded ${against() - before} goals`);
  await parent.locator('.toast button', { hasText: 'ביטול' }).click();
  await admin.locator('.sc-score [data-them]', { hasText: String(before) }).waitFor({ timeout: 8000 });
  await parent.dblclick('[data-act="goal-us"]');
  await parent.waitForTimeout(600);
  expect(await parent.locator('.sheet').count() === 1, 'the scorer sheet closed as it opened');
  await parent.locator('.sheet-x').click();
  await parent.locator('.sheet').waitFor({ state: 'detached' });
});

await step('a controlling phone reopened with no reception still shows the match and can record', async () => {
  await parent.context().setOffline(true);
  await parent.reload();
  await parent.locator('.sc-goal[data-act="goal-us"]').waitFor({ timeout: 8000 });
  await parent.locator('.sync.off').waitFor();
  expect((await parent.locator('.sc-score [data-them]').innerText()).trim() === '1', 'the reopened board lost the score');
  await parent.context().setOffline(false);
  await parent.locator('.sc-sync.ok').waitFor({ timeout: 15000 });
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

await step('Veo is hidden until the manager turns it on; then the stream link reaches whoever watches', async () => {
  const URL_ = 'https://app.veo.co/matches/20261003-nahalim/';
  await admin.goto(APP + '#/live');
  await admin.reload();
  await admin.click('[data-act="more"]');
  await admin.locator('.sheet [data-m="finish"], .sheet [data-m="cancel"]').first().waitFor();
  expect(await admin.locator('.sheet [data-m="stream"], .sheet [data-stream]').count() === 0, 'a Veo field before the setting is on');
  await admin.locator('.sheet-x').click();
  // A closed sheet takes its history step off: a navigation sent before
  // that step landed was undone by it (no hand is that fast).
  await admin.waitForFunction(() => !history.state?.mgLayer);
  expect(await parent.locator('.stream-link').count() === 0, 'a stream button before the setting is on');
  // The setting: a switch in the settings tab, saved as true, not "on".
  await admin.goto(APP + '#/admin');
  await adminTab(admin, 'team');
  await admin.locator('#f-settings-veo').check();
  await admin.click('#save');
  await waitSaved(admin);
  expect(seasonFile().settings.veo === true, 'setting saved as ' + JSON.stringify(seasonFile().settings.veo));
  // A bad link is refused; the real one reaches the parent's screen.
  await admin.goto(APP + '#/live');
  await admin.click('[data-act="more"]');
  await admin.click('.sheet [data-m="stream"]');
  await admin.locator('.sheet [data-stream]').waitFor();
  // "More" slides out for a moment: its row would take the next click.
  await admin.waitForFunction(() => document.querySelectorAll('.sheet').length === 1);
  await admin.fill('.sheet [data-stream]', 'javascript:alert(1)');
  await admin.click('.sheet [data-m="stream"]');
  await admin.locator('.toast', { hasText: 'לא נראה כמו קישור' }).waitFor();
  await admin.fill('.sheet [data-stream]', URL_);
  await admin.click('.sheet [data-m="stream"]');
  for (let k = 0; k < 80 && liveFile().stream !== URL_; k++) await new Promise((r) => setTimeout(r, 100));
  expect(liveFile().stream === URL_, 'stream not saved: ' + liveFile().stream);
  await parent.reload();
  const a = parent.locator('a.stream-link');
  await a.waitFor({ timeout: 8000 });
  expect(await a.getAttribute('href') === URL_ && await a.getAttribute('target') === '_blank', 'stream button: ' + await a.getAttribute('href'));
});

await step('finishing saves the result and the scorers into the season', async () => {
  await endPeriod(parent);
  await finishNow(parent);
  await waitText(parent, 'נשמר בתוצאות');
  await parent.waitForFunction(() => true);
  await new Promise((r) => setTimeout(r, 800));
  const m = seasonFile().matches.find((x) => x.liveId);
  expect(m && m.gf === 1 && m.ga === 1, 'result: ' + JSON.stringify(m && [m.gf, m.ga]));
  expect(m.opponent === 'מכבי נחלים', 'opponent: ' + m.opponent);
  expect(m.events.some((e) => e.type === 'sub'), 'events not saved with the match');
});

await step('after the match the manager puts the filmed match into the videos', async () => {
  await admin.goto(APP + '#/live');
  await admin.reload();
  await admin.locator('[data-act="veo-video"]').click({ timeout: 8000 });
  expect(await admin.locator('.sheet [data-vv-url]').inputValue() === liveFile().stream, 'the stream link is not the starting point');
  await admin.click('.sheet [data-vv-go]');
  await admin.locator('.ended', { hasText: 'המשחק המצולם בסרטונים' }).waitFor({ timeout: 8000 });
  const v = seasonFile().videos.find((x) => x.url === liveFile().stream);
  expect(v && v.title.includes('מכבי נחלים'), 'video not in the season: ' + JSON.stringify(seasonFile().videos));
});

await step('the scorer\'s total comes from the match events', async () => {
  await parent.goto(APP + '#/stats');
  await parent.locator('#board .leader', { hasText: 'גיא פרץ' }).waitFor({ timeout: 8000 });
  const row = await parent.locator('#board .leader', { hasText: 'גיא פרץ' }).innerText();
  expect(/\b1\b/.test(row), 'leader row: ' + row);
});

await step('minutes per player are the manager\'s only', async () => {
  expect(await parent.locator('#minutes').count() === 0, 'a parent sees the minutes section');
  expect(await parent.locator('.coach-only').count() === 0, 'a parent sees an "only the coach" note');
  const cached = await parent.evaluate(() => JSON.parse(localStorage.getItem('mg:season') || 'null'));
  expect(cached && cached.season.players.every((p) => !('minutes' in p)), 'minutes reached the parent\'s device');
  expect(cached.season.matches.every((m) => !('lineup' in m)), 'a past lineup reached the parent\'s device');
  await admin.goto(APP + '#/stats');
  await admin.locator('#minutes .mn-table').waitFor();
});

await step('a result on the home screen opens its match; every game is on the stats screen', async () => {
  // The owner's pick: the home screen keeps the last results, as pills that
  // open their match, and the whole list moved to the stats screen.
  await parent.goto(APP + '#/');
  await parent.locator('.form-pill').first().waitFor();
  expect(await parent.locator('#view button.match').count() === 0, 'the home screen still lists every game');
  await parent.locator('.form-pill[aria-label*="מכבי נחלים"]').click();
  await parent.locator('.sheet .ev-list', { hasText: 'גיא פרץ' }).waitFor();
  // The scorers sit under the score, by name and minute, above the timeline.
  const scorers = await parent.locator('.sheet .ms-scorers .us').innerText();
  expect(scorers.includes('גיא פרץ') && /\d+'/.test(scorers), 'scorers under the score: ' + scorers);
  expect(await parent.locator('.sheet .ms-scorers + .ev-sides').count() === 1, 'the scorers are not right above the timeline');
  const liveSide = await usOnRight(parent);
  expect(!liveSide.length, 'not on the right in a live match\'s sheet: ' + liveSide.join(', '));
  // Every sub names a position: a parent has no past lineup, so the slot's
  // is unknown here and the incoming player's own stands in.
  const sub = await parent.locator('.sheet .ev.sub .ev-txt .out').first().innerText();
  expect(/ · \S/.test(sub), 'a sub without a position: ' + sub);
  await parent.locator('.sheet-x').click();
  await parent.locator('.sheet').waitFor({ state: 'detached' });
  await parent.getByRole('link', { name: 'לכל המשחקים' }).click();
  // Every list on the stats screen shows five rows and a toggle for the rest.
  // Seven more games in the schedule make one list long enough to fold.
  const put = (season, v) => admin.evaluate(([url, season, v]) => import(url).then((m) => m.call('putSeason', { season, baseVersion: v }, { asAdmin: true })), [APP + 'src/bridge.js', season, v]);
  const cur = JSON.parse(bridge.driveFile('season.json'));
  const extra = Array.from({ length: 7 }, (_, i) => ({ date: `2031-0${i + 1}-10`, time: '10:00', opponent: `קיפול ${i + 1}`, home: true, round: 30 + i }));
  await put({ ...cur.season, fixtures: [...(cur.season.fixtures || []), ...extra] }, cur.version);
  await parent.reload();
  await parent.locator('#stats-schedule .fixture, #stats-schedule [data-fold] > *').first().waitFor();
  await parent.locator('#stats-matches .match').first().waitFor();
  // A fresh visit straight to the stats screen: nothing has fetched the
  // opponent's crest, and the match sheet must fetch it itself.
  await parent.locator('#stats-matches .match', { hasText: 'הפועל כוכבים' }).first().click();
  await parent.locator('.sheet .ms-board .opp-logo[src]').waitFor({ timeout: 8000 });
  await parent.locator('.sheet-x').click();
  await parent.locator('.sheet').waitFor({ state: 'detached' });
  await parent.waitForFunction(() => !history.state?.mgLayer);
  const lists = () => parent.evaluate(() => [...document.querySelectorAll('#view [data-fold], #board')].map((l) => {
    const rows = [...l.children].filter((r) => !r.matches('[data-fold-btn]'));
    return { id: l.dataset.fold || l.id, total: rows.length, shown: rows.filter((r) => !r.hidden).length, btn: !!l.querySelector('[data-fold-btn]') };
  }));
  const folded = await lists();
  expect(folded.some((l) => l.total > 5), 'no list long enough to fold: ' + JSON.stringify(folded));
  expect(folded.every((l) => l.total > 5 ? l.shown === 5 && l.btn : l.shown === l.total && !l.btn), 'a list is not folded to five: ' + JSON.stringify(folded));
  const long = folded.find((l) => l.total > 5);
  await parent.click(`[data-fold-btn="${long.id}"]`);
  const opened = (await lists()).find((l) => l.id === long.id);
  expect(opened.shown === opened.total, 'the toggle did not show the whole list: ' + JSON.stringify(opened));
  await parent.click(`[data-fold-btn="${long.id}"]`);
  const back = JSON.parse(bridge.driveFile('season.json'));
  await put({ ...back.season, fixtures: back.season.fixtures.filter((f) => !f.opponent.startsWith('קיפול')) }, back.version);
  await parent.reload();
  await parent.locator('button.match', { hasText: 'מכבי נחלים' }).first().click();
  await parent.locator('.sheet .ev-list', { hasText: 'גיא פרץ' }).waitFor();
  await parent.locator('.sheet-x').click();
  await parent.locator('.sheet').waitFor({ state: 'detached' });
});

await step('the back button (a route change) closes an open sheet instead of leaving it over the next screen', async () => {
  await parent.locator('button.match', { hasText: 'מכבי נחלים' }).first().click();
  await parent.locator('.sheet').waitFor();
  await parent.evaluate(() => { location.hash = '#/'; });
  await parent.waitForFunction(() => !document.querySelector('.sheet'), null, { timeout: 3000 });
  await parent.goto(APP + '#/');
});

await step('the back button closes an open sheet and stays on the screen', async () => {
  // On the first screen, back with a sheet open closed the app itself.
  await parent.goto(APP + '#/');
  await parent.locator('.form-pill[aria-label*="מכבי נחלים"]').click();
  await parent.locator('.sheet').waitFor();
  await parent.evaluate(() => history.back());
  await parent.waitForFunction(() => !document.querySelector('.sheet'), null, { timeout: 3000 });
  expect(new URL(parent.url()).hash === '#/', 'back left the screen: ' + parent.url());
  expect(await parent.locator('.hero').count() === 1, 'the home screen is gone');
  // Closed by its own button, a sheet takes its step off the history again.
  await parent.locator('.form-pill[aria-label*="מכבי נחלים"]').click();
  await parent.locator('.sheet').waitFor();
  await parent.locator('.sheet-x').click();
  await parent.waitForFunction(() => !document.querySelector('.sheet') && !history.state?.mgLayer, null, { timeout: 3000 });
});

await step('a sheet closed as the route moves on does not take the route back', async () => {
  // The route moved before the closed sheet's step back ran (a tap handled
  // first on a busy phone, its hashchange still to come), and the step back
  // undid it. pushState stands for that tap: a new entry, nothing announced.
  await parent.goto(APP + '#/');
  await parent.locator('.form-pill[aria-label*="מכבי נחלים"]').click();
  await parent.locator('.sheet').waitFor();
  const hash = await parent.evaluate(async () => {
    document.querySelector('.sheet-x').click();
    history.pushState(null, '', '#/stats');
    await new Promise((r) => setTimeout(r, 400));
    return location.hash;
  });
  expect(hash === '#/stats', 'the route was taken back to ' + hash);
  await parent.goto(APP + '#/');
});

await step('the next live match opens with the last starting lineup, capped at the size', async () => {
  await admin.goto(APP + '#/live');
  await admin.reload();
  await admin.locator('[data-act="clear"]').click();
  await admin.locator('[data-ok]').click();
  await admin.locator('[data-act="new"]').click();
  await admin.locator('.formation-seg').waitFor();
  await admin.waitForFunction(() => document.querySelectorAll('.pitch .pl:not(.open)').length === 4);
  const text = await admin.locator('#view').innerText();
  expect(/הרכב\s*4\s*\/\s*9/.test(text), 'size counter missing: ' + text.slice(0, 400));
  expect(text.includes('תשיעיות'), 'size not shown in the match line');
});

await step('a lineup pasted from WhatsApp is matched by first names and placed', async () => {
  const before = liveFile().lineup;
  const clip = (t) => admin.evaluate((x) => navigator.clipboard.writeText(x), t);
  // Text that names no one: the box to paste into by hand, empty.
  await clip('https://example.com/something');
  await admin.locator('[data-act="paste-lineup"]').click();
  await admin.locator('[data-lu-text]').waitFor();
  expect(await admin.locator('[data-lu-text]').inputValue() === '', 'unrelated clipboard text landed in the box');
  await admin.locator('.sheet-x').click();
  await admin.waitForFunction(() => !document.querySelector('.sheet'));
  // The coach's message on the clipboard: the button pastes it by itself.
  await clip('[27/09/2026, 20:14] המאמן: הרכב למחר 💪\nשוער: נועם\n1. תומר\n2. גיא\nחלוץ: משה\nספסל: דניאל');
  await admin.locator('[data-act="paste-lineup"]').click();
  // "משה" is no one: left to pick, and nothing is placed until the button.
  await admin.locator('.lu-imp .imp-kind', { hasText: 'לא זוהה' }).waitFor();
  expect(JSON.stringify(liveFile().lineup) === JSON.stringify(before), 'the preview changed the lineup');
  await admin.click('[data-lu-apply]');
  await admin.waitForFunction(() => document.querySelectorAll('.pitch .pl:not(.open)').length === 3);
  const byId = Object.fromEntries(liveFile().players.map((p) => [p.id, p.name]));
  for (let i = 0; i < 80 && liveFile().lineup.length !== 3; i++) await new Promise((r) => setTimeout(r, 100));
  const got = liveFile().lineup.map((l) => `${byId[l.pid]}:${l.pos}`).join(',');
  expect(got === 'נועם:GK,תומר עזרא:CB,גיא פרץ:ST', 'pasted lineup: ' + got);
});

await step('the formation is the base: a tap on a free slot fills it, and another formation moves the players', async () => {
  const byId = () => Object.fromEntries(liveFile().players.map((p) => [p.id, p.name]));
  const wait = async (fn) => { for (let i = 0; i < 80 && !fn(); i++) await new Promise((r) => setTimeout(r, 100)); };
  expect(liveFile().formation === '3-2-3', 'not opened in 3-2-3: ' + liveFile().formation);
  // Every slot of 3-2-3 is on the pitch: 3 filled, 6 free.
  expect(await admin.locator('.pitch .pl').count() === 9 && await admin.locator('.pitch .pl.open').count() === 6, 'the free slots are not drawn');
  await admin.locator('.pitch .pl.open[data-slot="CM"]').click();
  await admin.locator('.sheet .pick').first().waitFor();
  const picked = (await admin.locator('.sheet .pick').first().innerText()).split('\n').find((t) => /[א-ת]/.test(t));
  await admin.locator('.sheet .pick').first().click();
  await wait(() => liveFile().lineup.length === 4);
  const cm = liveFile().lineup.find((l) => l.pos === 'CM');
  expect(cm && picked.includes(byId()[cm.pid]), `the pick did not fill the slot: ${JSON.stringify(liveFile().lineup)} / ${picked}`);
  // 4-2-2: the same players, each in a slot of it; the CB and the striker stay.
  await admin.click('[data-formation="4-2-2"]');
  await wait(() => liveFile().formation === '4-2-2');
  const slots = ['GK', 'RWB', 'CB', 'CB', 'LWB', 'CM', 'CM', 'ST', 'ST'];
  const lu = liveFile().lineup;
  const free = [...slots];
  expect(lu.length === 4 && lu.every((l) => { const k = free.indexOf(l.pos); if (k < 0) return false; free.splice(k, 1); return true; }), 'a player outside 4-2-2: ' + JSON.stringify(lu));
  const where = Object.fromEntries(lu.map((l) => [byId()[l.pid], l.pos]));
  expect(where['תומר עזרא'] === 'CB' && where['גיא פרץ'] === 'ST' && where['נועם'] === 'GK', 'players moved off their position: ' + JSON.stringify(where));
  await admin.click('[data-formation="3-2-3"]');
  await wait(() => liveFile().formation === '3-2-3');
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
  await waitSaved(admin);
  const v = JSON.parse(bridge.driveFile('season.json')).season.videos.find((x) => x.url === 'https://clips.example.com/goal');
  expect(v?.poster && v.posterFor === 'https://clips.example.com/goal', 'no poster made: ' + JSON.stringify(v));
  await parent.goto(APP + '#/media');
  await parent.reload();
  await parent.locator('.thumb-img[src^="blob:"]').first().waitFor({ timeout: 10000 });
});

await step('a useful link is a link on the media screen, not just its title', async () => {
  await admin.goto(APP + '#/admin');
  await adminTab(admin, 'media');
  const at = await newRow(admin, 'links');
  await admin.fill(`[data-path="${at}.title"]`, 'רכישת ציוד');
  await admin.fill(`[data-path="${at}.url"]`, 'https://www.shop.example.com/login?cid=22');
  await admin.click('#save');
  await waitSaved(admin);
  await parent.goto(APP + '#/media');
  await parent.reload();
  const a = parent.locator('a.link', { hasText: 'רכישת ציוד' });
  await a.waitFor({ timeout: 8000 });
  expect(await a.getAttribute('href') === 'https://www.shop.example.com/login?cid=22', 'wrong href: ' + await a.getAttribute('href'));
  // No description: the site's name says where it goes.
  expect((await a.innerText()).includes('shop.example.com'), 'no host under a link without description');
});

await step('a link to a social page takes its icon; one picked by hand stays', async () => {
  await admin.goto(APP + '#/admin');
  await adminTab(admin, 'media');
  const at = await newRow(admin, 'links');
  await admin.fill(`[data-path="${at}.title"]`, 'הפייסבוק של המועדון');
  await admin.fill(`[data-path="${at}.url"]`, 'https://www.facebook.com/maccabi.givatayim');
  expect(await admin.locator(`[data-path="${at}.icon"]`).inputValue() === 'facebook', 'the icon did not follow the link');
  // Picked by hand: another link does not take it over.
  await admin.selectOption(`[data-path="${at}.icon"]`, 'globe');
  await admin.fill(`[data-path="${at}.url"]`, 'https://www.instagram.com/maccabi.givatayim');
  expect(await admin.locator(`[data-path="${at}.icon"]`).inputValue() === 'globe', 'a hand-picked icon was replaced');
  await admin.click('#save');
  await waitSaved(admin);
  expect(seasonFile().links.some((l) => l.title === 'הפייסבוק של המועדון' && l.icon === 'globe'), 'icon not saved');
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
  await waitSaved(admin);
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
  await waitSaved(admin);
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
  await waitSaved(admin);
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
  await waitSaved(admin);
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

await step('back on the home screen, the crest is the one already loaded, not a new one that shows empty first', async () => {
  // Leaving the home screen and coming back drew the next match's crest as
  // a new <img>: empty for a couple of frames, then there — it jumped.
  const CREST = '.side.us .disc img';
  await parent.goto(APP + '#/');
  await parent.locator(CREST).first().waitFor({ timeout: 8000 });
  await parent.waitForFunction((sel) => { const i = document.querySelector(sel); return i.complete && i.naturalWidth; }, CREST);
  await parent.evaluate((sel) => { document.querySelector(sel).__mark = 1; }, CREST);
  await parent.evaluate(() => { location.hash = '#/stats'; });
  await parent.locator('#board').waitFor();
  // Checked in the same task as the redraw: already loaded (a picture kept
  // from before — the header's crest is the same file, so either may come).
  const back = await parent.evaluate((sel) => new Promise((res) => {
    addEventListener('hashchange', () => setTimeout(() => {
      const i = document.querySelector(sel);
      res({ same: i?.__mark === 1, ready: !!(i?.complete && i.naturalWidth) });
    }), { once: true });
    location.hash = '#/';
  }), CREST);
  expect(back.ready, 'the crest came back as a new image, not loaded yet: ' + JSON.stringify(back));
});

const israelToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

await step('a weekly training shows above the next match, on the first screen, and opens its venue', async () => {
  const day = new Date(israelToday() + 'T12:00:00Z').getUTCDay();
  await admin.goto(APP + '#/admin');
  await adminTab(admin, 'games');
  const row = await newRow(admin, 'trainings');
  await admin.selectOption(`[data-path="${row}.day"]`, String(day));
  await admin.fill(`[data-path="${row}.start"]`, '17:00');
  await admin.fill(`[data-path="${row}.end"]`, '18:30');
  await admin.click('#save');
  await waitSaved(admin);
  const season = JSON.parse(bridge.driveFile('season.json')).season;
  expect(season.trainings?.length === 1 && season.trainings[0].start === '17:00', 'training not saved: ' + JSON.stringify(season.trainings));

  await parent.goto(APP + '#/');
  await parent.reload();
  const sq = parent.locator('.week-sec .wk-day.training.today');
  await sq.waitFor({ timeout: 8000 });
  const t = (await sq.innerText()).replace(/\s+/g, ' ');
  expect(t.includes('היום') && t.includes('17:00') && t.includes('אצטדיון גבעתיים'), 'today\'s square: ' + t);
  expect(!(await sq.locator('.wk-flag').count()), 'a routine training is flagged as changed');
  // Above the next match, and the card after it is still the schedule.
  const order = await parent.evaluate(() => {
    const w = document.querySelector('.week-sec'), h = document.querySelector('.hero');
    return { before: !!(w.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING), bottom: w.getBoundingClientRect().bottom, vh: innerHeight };
  });
  expect(order.before, 'the week strip is not above the next match');
  expect(order.bottom < order.vh / 3, 'the week strip is not near the top: ' + order.bottom);
  await sq.click();
  const sheet = parent.locator('.sheet', { hasText: '18:30' });
  await sheet.waitFor();
  expect(await sheet.locator('a.btn[href^="https://www.waze.com/ul?q="]').count() === 1, 'no Waze link for the home ground');
  await parent.locator('.sheet-x').click();

  // "Next week" is offered once the week's last training is over — here
  // today's, which ends at 18:30 — and shows the week after.
  const next = parent.locator('[data-next-week]');
  const nowHM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  if (nowHM >= '18:30') {
    await next.click();
    await parent.locator('.wk-label', { hasText: 'אימוני השבוע הבא' }).waitFor();
    const n = (await parent.locator('.week-sec .wk-day').first().innerText()).replace(/\s+/g, ' ');
    expect(n.includes(['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'][day]) && n.includes('17:00'), 'next week\'s square: ' + n);
    expect(!(await parent.locator('.week-sec .wk-day.training.today').count()), 'next week has a "today"');
    await parent.locator('[data-next-week]').click();
    await parent.locator('.week-sec .wk-day.training.today').waitFor();
  } else expect(!(await next.count()), 'the next week button shows before the week\'s last training is over');
});

await step('a training that differs from the routine is framed and flagged, and the sheet says what changed', async () => {
  await admin.goto(APP + '#/admin');
  await adminTab(admin, 'games');
  const row = await newRow(admin, 'trainingChanges');
  await admin.fill(`[data-path="${row}.date"]`, israelToday());
  await admin.fill(`[data-path="${row}.start"]`, '16:30');
  await admin.fill(`[data-path="${row}.venue.name"]`, 'מגרש זמני');
  await admin.fill(`[data-path="${row}.venue.address"]`, 'הירדן 3, רמת גן');
  await admin.fill(`[data-path="${row}.venue.waze"]`, 'not a link');
  await admin.click('#save');
  await waitText(admin, 'קישור שמתחיל ב-https://');
  // A link copied from Google Maps opens Google Maps: saved, it becomes the
  // coordinates it points at, a short link opened by the bridge.
  bridge.redirect('https://maps.app.goo.gl/e2eTraining', 'https://www.google.com/maps/search/31.956020,+34.834553?entry=tts');
  await admin.fill(`[data-path="${row}.venue.waze"]`, 'https://maps.app.goo.gl/e2eTraining');
  await admin.click('#save');
  await waitSaved(admin);

  const saved = JSON.parse(bridge.driveFile('season.json')).season.trainingChanges;
  expect(saved.at(-1).venue.waze === '31.956020,34.834553', 'the Google Maps link was stored as ' + saved.at(-1).venue.waze);

  await parent.goto(APP + '#/');
  await parent.reload();
  const sq = parent.locator('.week-sec .wk-day.training.today.chg');
  await sq.waitFor({ timeout: 8000 });
  expect((await sq.locator('.wk-flag').innerText()).trim() === 'שינוי', 'no "change" flag');
  const t = (await sq.innerText()).replace(/\s+/g, ' ');
  expect(t.includes('16:30') && t.includes('מגרש זמני'), 'the changed square: ' + t);
  const frame = await sq.evaluate((el) => getComputedStyle(el).borderTopColor);
  expect(frame === 'rgb(240, 106, 96)', 'the frame is not red: ' + frame);
  await sq.click();
  const was = parent.locator('.sheet .wk-was');
  await was.waitFor();
  const w = (await was.innerText()).replace(/\s+/g, ' ');
  expect(w.includes('17:00–18:30') && w.includes('16:30–18:30') && w.includes('אצטדיון גבעתיים') && w.includes('מגרש זמני'), 'what changed: ' + w);
  expect(!(await parent.locator('.sheet .meta-row', { hasText: '16:30' }).count()), 'the new hours are shown twice');
  expect(await parent.locator('.sheet a.btn[href="https://www.waze.com/ul?ll=31.956020,34.834553&navigate=yes"]').count() === 1, 'the training\'s own Waze link does not win over its address');
  await parent.locator('.sheet-x').click();
});

await step('the manager changes a training from the home screen; a parent has no such button', async () => {
  expect(await parent.locator('[data-tr-edit]').count() === 0, 'a sheet left open');
  await parent.locator('.week-sec .wk-day.training.today').click();
  await parent.locator('.sheet .wk-sheet').waitFor();
  expect(await parent.locator('[data-tr-edit]').count() === 0, 'a parent can change a training');
  await parent.locator('.sheet-x').click();

  await admin.goto(APP + '#/');
  await admin.reload();
  await admin.locator('.week-sec .wk-day.training.today').click();
  await admin.click('[data-tr-edit]');
  await admin.click('[data-tr-state="off"]');
  await admin.click('[data-tr-save]');
  await admin.locator('.week-sec .wk-day.training.today.cancelled').waitFor({ timeout: 8000 });
  const ch = () => JSON.parse(bridge.driveFile('season.json')).season.trainingChanges.filter((c) => c.date === israelToday());
  expect(ch().length === 1 && ch()[0].cancelled === true, 'cancelled from home: ' + JSON.stringify(ch()));
  // Only what differs from the routine is kept: the hours were the routine's.
  // Back to the routine, and the date has no change at all.
  await admin.locator('.week-sec .wk-day.training.today').click();
  await admin.click('[data-tr-edit]');
  await admin.click('[data-tr-reset]');
  await admin.locator('.week-sec .wk-day.training.today:not(.chg)').waitFor({ timeout: 8000 });
  expect(ch().length === 0, 'the change is still there: ' + JSON.stringify(ch()));

  // Moved to another day of the week: struck through here, there on the
  // other day, one change on today's date. Back to the routine undoes both.
  const today = israelToday();
  const shift = new Date(today + 'T12:00:00Z').getUTCDay() > 0 ? -1 : 1;
  const target = new Date(Date.parse(today + 'T12:00:00Z') + shift * 86400000).toISOString().slice(0, 10);
  await admin.locator('.week-sec .wk-day.training.today').click();
  await admin.click('[data-tr-edit]');
  await admin.fill('#tr-date', target);
  await admin.click('[data-tr-save]');
  await admin.locator('.week-sec .wk-day.training.today.away').waitFor({ timeout: 8000 });
  const [, m, d] = target.split('-');
  const movedSq = admin.locator('.week-sec .wk-day.moved');
  const mt = (await movedSq.innerText()).replace(/\s+/g, ' ');
  expect(mt.includes(`${+d}.${+m}`) && mt.includes('17:00') && mt.includes('הוזז'), 'the moved-in square: ' + mt);
  expect(ch().length === 1 && ch()[0].movedTo === target, 'moved as ' + JSON.stringify(ch()));
  await movedSq.click();
  await admin.click('[data-tr-edit]');
  await admin.click('[data-tr-reset]');
  await admin.locator('.week-sec .wk-day.training.today:not(.chg)').waitFor({ timeout: 8000 });
  expect(await admin.locator('.week-sec .wk-day.moved').count() === 0 && ch().length === 0, 'the move is still there');
  // The manager's editor picks the new version up instead of saving over it.
  await admin.goto(APP + '#/admin');
  await adminTab(admin, 'team');
  await admin.waitForTimeout(800);
  await admin.fill('[data-path="team.league"]', 'ליגת ילדים א');
  await admin.click('#save');
  await waitSaved(admin);
});

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
  await admin.locator('[data-act="details"]').waitFor();
  expect(liveFile().opponent === 'בני לוח', 'opponent not taken from the fixture');
  await admin.click('[data-act="start"]');

  // A penalty scored by us, one of theirs missed, and an own goal.
  // The penalty is in "more" now: the bottom bar is the substitution alone.
  const penalty = async () => { await admin.click('[data-act="more"]'); await admin.click('[data-m="penalty"]'); };
  await penalty();
  await admin.click('[data-pen="us"]');
  await admin.locator('.pick', { hasText: 'גיא פרץ' }).click();
  await admin.click('[data-res="goal"]');
  await penalty();
  await admin.click('[data-pen="them"]');
  await admin.click('[data-res="miss"]');
  await admin.click('[data-act="goal-us"]');
  await admin.locator('.pick-plain', { hasText: 'גול עצמי' }).click();
  await admin.locator('.sc-score .ours', { hasText: '2' }).waitFor();
  expect(await admin.locator('.sc-score [data-them]').innerText() === '0', 'a miss changed the score');
  expect(await admin.locator('.ev.us .tl-pen').count() === 1 && await admin.locator('.ev.them.miss').count() === 1, 'timeline: penalty tag, or their miss on their side, missing');

  await endPeriod(admin);
  // The recorder's board is folded while the clock runs: the scorers are
  // under the full board from the break on (and always for viewers).
  await admin.locator('.sc-scorers .us').waitFor();
  const us = (await admin.locator('.sc-scorers .us').innerText()).replace(/\s+/g, ' ');
  expect(us.includes('גיא פרץ') && us.includes('(פ)') && us.includes('גול עצמי'), 'our scorers: ' + us);
  expect(await admin.locator('.sc-scorers .them .scr-miss').count() === 1, 'their missed penalty is not shown');
  await finishNow(admin);
  await waitText(admin, 'נשמר בתוצאות');
  await new Promise((r) => setTimeout(r, 600));
  const m = JSON.parse(bridge.driveFile('season.json')).season.matches.find((x) => x.opponent === 'בני לוח');
  expect(m && m.gf === 2 && m.ga === 0, 'result: ' + JSON.stringify(m && [m.gf, m.ga]));
  const pen = m.events.find((e) => e.type === 'goal' && e.pen);
  const byName = Object.fromEntries(m.players.map((p) => [p.name, p.id]));
  expect(pen && pen.scorer === byName['גיא פרץ'] && !pen.assist, 'penalty goal: ' + JSON.stringify(pen));
  expect(m.events.some((e) => e.type === 'goal' && e.og && !e.scorer), 'own goal not saved');
  expect(m.events.some((e) => e.type === 'miss' && e.side === 'them'), 'missed penalty not saved');
  expect(m && m.date === israelToday(), 'dated ' + (m && m.date) + ', expected today');
  expect(m.fixture && m.fixture.date === '2030-11-08', 'fixture link: ' + JSON.stringify(m && m.fixture));
  await parent.goto(APP + '#/stats');
  await parent.reload();
  await parent.locator('.fixture-row', { hasText: 'הפועל לוח' }).waitFor();
  expect(await parent.locator('.fixture-row', { hasText: 'בני לוח' }).count() === 0, 'the played fixture is still on the schedule');
  // The manager's schedule loses the row too: it stayed there after the match.
  await admin.goto(APP + '#/admin');
  await adminTab(admin, 'games');
  await waitText(admin, 'ירד מהלוח');
  expect(await admin.locator('details[data-item^="fixtures."]', { hasText: 'בני לוח' }).count() === 0, 'the played fixture is still on the manager\'s schedule');
  await admin.click('#save');
  await waitSaved(admin);
  expect(!seasonFile().fixtures.some((f) => f.opponent === 'בני לוח'), 'the played fixture was saved back');
  await admin.goto(APP + '#/live');
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
  await waitSaved(admin);
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
  // The request says who is asking; the name typed before the choice stays.
  await coach.fill('input[name=name]', 'המאמן');
  await coach.click('[data-ask-role="coach"]');
  expect(await coach.inputValue('input[name=name]') === 'המאמן', 'picking a role lost the name');
  // The choice shows: the switch marked it by aria-pressed, which only
  // aria-selected lit up, and nothing on screen moved (the owner).
  const lit = (k) => coach.locator(`[data-ask-role="${k}"]`).evaluate((b) => getComputedStyle(b).color);
  expect(await lit('coach') !== await lit('parent'), 'the chosen role is not marked');
  await coach.locator('#request-form button[type=submit]').click();
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
  expect((await row.locator('.role-tag').innerText()).includes('מבקש כמאמן'), 'the request does not show the role it asks for');
  await row.locator('[data-set="approved"]').click();
  await dot.waitFor({ state: 'detached', timeout: 8000 });
  // Approving takes the role the request asked for.
  await row.locator('[data-role="coach"][aria-pressed="true"]').waitFor();
  // A refused role change says so: it used to vanish in the reload after it,
  // and the tap read as missed (the owner, a morning the bridge failed writes).
  const refuse = (r) => {
    let action = '';
    try { action = JSON.parse(r.request().postData() || '{}').action; } catch {}
    return action === 'setRole'
      ? r.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'text/plain', body: JSON.stringify({ ok: false, error: 'הגשר עסוק', code: 'busy' }) })
      : r.fallback();
  };
  await admin.route(BRIDGE, refuse);
  await row.locator('[data-role="parent"]').click();
  await admin.locator('.toast', { hasText: 'התפקיד לא נשמר' }).waitFor({ timeout: 5000 });
  await admin.unroute(BRIDGE, refuse);
  await row.locator('[data-role="coach"][aria-pressed="true"]').waitFor();
  await coach.click('#recheck');
  await coach.goto(APP + '#/stats');
  await coach.locator('#minutes .mn-table').waitFor({ timeout: 8000 });
  // Who the phone is, in the title on every screen; a parent's says nothing.
  expect((await coach.locator('.topbar .role-mark').innerText()).trim() === 'מאמן', 'the coach is not named in the title');
  expect((await admin.locator('.topbar .role-mark').innerText()).trim() === 'מנהל', 'the manager is not named in the title');
  expect(await parent.locator('.topbar .role-mark').count() === 0, 'a parent\'s title names a role');
  // What parents never see says so, to the coach and to the manager.
  expect(await coach.locator('#minutes .sec-head .coach-only').innerText() === '(רק למאמן)', 'the coach\'s minutes carry no "only the coach" note');
  await admin.goto(APP + '#/stats');
  await admin.locator('#minutes .sec-head .coach-only').waitFor({ timeout: 8000 });
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

await step('the access holders sort by last seen, or by joining', async () => {
  // The coach joined last but was seen last too: the two orders differ.
  const file = bridge.fileById(bridge.driveFileId('access.json'));
  const acc = JSON.parse(file.text);
  const holders = Object.values(acc.users).filter((u) => u.status === 'approved')
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  // The oldest was seen last: last seen first reads oldest first, newest-joined first the other way.
  // Dates ahead of now: the bridge rewrites a past lastSeen whenever a phone of the test calls it.
  holders.forEach((u, i) => { u.lastSeen = new Date(Date.UTC(2030, 0, 1 + (i === 0 ? 20 : 10 - i))).toISOString(); });
  file.setContent(JSON.stringify(acc));
  bridge.clearCache();   // the bridge reads access.json through its cache, not from Drive
  await admin.goto(APP + '#/admin');
  await admin.reload();
  await admin.click('[data-tab="access"]');
  const names = () => admin.locator('.holders-sort + .card .who b').allInnerTexts();
  const seen = [...holders].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).map((u) => u.name);
  await admin.locator('.holders-sort [data-holders-sort="seen"][aria-selected="true"]').waitFor({ timeout: 8000 });
  expect(JSON.stringify(await names()) === JSON.stringify(seen), 'holders are not in last-seen order: ' + (await names()).join(', '));
  await admin.click('[data-holders-sort="joined"]');
  const joined = holders.map((u) => u.name).reverse();   // newest first (the owner)
  expect(JSON.stringify(await names()) === JSON.stringify(joined), 'holders are not in joining order: ' + (await names()).join(', '));
  expect(JSON.stringify(seen) !== JSON.stringify(joined), 'the test data does not tell the two orders apart');
  // The role filter: each role shows its own, with its count; a coach or a player is tagged.
  const roleOf = (u) => (u.role === 'coach' || u.role === 'player' ? u.role : 'parent');
  expect(new Set(holders.map(roleOf)).size >= 2, 'the test data has one role only: ' + holders.map(roleOf).join(', '));
  for (const k of ['parent', 'player', 'coach', 'all']) {
    await admin.click(`[data-holders-role="${k}"]`);
    const want = [...holders].reverse().filter((u) => k === 'all' || roleOf(u) === k).map((u) => u.name);   // still by joining, newest first
    const got = want.length ? await names() : [];
    expect(JSON.stringify(got) === JSON.stringify(want), `role ${k}: ${got.join(', ')} instead of ${want.join(', ')}`);
    const n = await admin.locator(`[data-holders-role="${k}"] .n`).innerText();
    expect(n === String(want.length), `role ${k} counts ${n}, expected ${want.length}`);
  }
  // A holder's role is in its switch: no tag, and no pencil beside the name.
  expect(await admin.locator('.holders-sort + .card .role-tag, .holders-sort + .card .who-name svg').count() === 0, 'a holder carries a tag or a pencil');
});

await step('before kick-off the coach sets the minimum and who came; a parent sees no minutes tab', async () => {
  await asAdmin('clearLive');
  await admin.goto(APP + '#/live');
  await admin.reload();
  await admin.locator('[data-act="new"]').click();
  await admin.locator('.formation-seg').waitFor();
  await setOpponent(admin, 'הפועל מבחן');
  await until(() => liveFile().opponent === 'הפועל מבחן', 'the opponent to be saved');
  const id = liveFile().id;
  await coach.goto(APP + '#/live');
  await coach.locator('[data-tab="minutes"]', { hasText: 'איזור המאמן' }).locator('.coach-only').waitFor({ timeout: 8000 });
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

  // Taps in a row on a slow line: every one lands, and none jumps back when
  // the answer to an earlier one comes in. Two of them are starters: marked
  // absent before kick-off they leave the lineup — the coach controls the
  // match — and their slots stay open for someone else.
  const lineup = liveFile().lineup;
  const starters = [lineup[1].pid, lineup[2].pid];
  const row = [benched.id, ...starters];
  const slow = async (r) => { await new Promise((ok) => setTimeout(ok, 900)); await r.continue().catch(() => {}); };
  await coach.route(BRIDGE, slow);
  for (const pid of row) {
    await coach.locator(`[data-mn-present="${pid}"][data-mn-state="away"]`).click();
    await coach.waitForTimeout(250);
  }
  const shown = () => coach.locator('.mn-att.away').count();
  let least = await shown();
  for (let i = 0; i < 25; i++) { least = Math.min(least, await shown()); await coach.waitForTimeout(100); }
  await coach.unroute(BRIDGE, slow);
  await until(() => row.every((pid) => (coachFile().matches[id].absent || []).includes(pid)), 'every tap to reach Drive');
  expect(least === row.length, `a player marked absent jumped back while the answers came in (${least} of ${row.length})`);
  await until(() => !liveFile().lineup.some((l) => starters.includes(l.pid)), 'the absent starters to leave the lineup');
  expect(liveFile().lineup.length === lineup.length - 2, 'two starters less, the others where they were');
  await admin.locator('.pl.open').first().waitFor({ timeout: 8000 });
  // Back as it was, for the rest of the run.
  for (const pid of row) await coach.locator(`[data-mn-present="${pid}"][data-mn-state="here"]`).click();
  await until(() => !(coachFile().matches[id].absent || []).length, 'the corrections to reach Drive');
  const v = JSON.parse(bridge.driveFile('live.json')).version;
  await asAdmin('putLive', { baseVersion: v, state: { ...liveFile(), lineup } });
  await until(() => liveFile().lineup.length === lineup.length, 'the lineup restored');
});

await step('a field being typed in keeps its caret and its text when the screen is redrawn under it', async () => {
  // The date change goes out; its answer redraws the match details while the
  // manager already types the opponent's name. The keyboard closed and the
  // letters went nowhere.
  const slow = async (r) => { await new Promise((ok) => setTimeout(ok, 800)); await r.continue().catch(() => {}); };
  await admin.click('[data-act="details"]');
  await admin.route(BRIDGE, slow);
  await admin.fill('.sheet [data-meta="date"]', '2026-10-04');
  const opp = admin.locator('.sheet [data-meta="opponent"]');
  await opp.click();
  await opp.press('End');
  await admin.keyboard.type(' ב', { delay: 250 });
  await admin.waitForTimeout(1500);
  await admin.keyboard.type('ית', { delay: 50 });
  const focused = await admin.evaluate(() => document.activeElement?.dataset?.meta);
  const typed = await opp.inputValue();
  await admin.unroute(BRIDGE, slow);
  expect(focused === 'opponent', 'the field lost the caret to a redraw: ' + focused);
  expect(typed === 'הפועל מבחן בית', 'typing was lost to a redraw: ' + typed);
  await opp.blur();
  await until(() => liveFile().opponent === 'הפועל מבחן בית', 'the name to be sent on leaving the field');
  await admin.click('.sheet [data-done]');
  await sheetGone(admin);
});

await step('a match opened ahead is hidden from parents until the manager publishes it', async () => {
  await parent.goto(APP + '#/live');
  await waitText(parent, 'אין משחק חי כרגע');
  expect(await parent.locator('.score-card').count() === 0, 'a parent sees a match that was not published');
  // Nothing live for the parent: the last results, each opening its events.
  const recent = parent.locator('.live-recent button[data-match]');
  expect(await recent.count() > 0, 'no recent matches under "nothing live"');
  await recent.first().click();
  await parent.locator('.sheet .ms-board').waitFor({ timeout: 8000 });
  await parent.locator('.sheet-x').click();
  await parent.locator('.sheet').waitFor({ state: 'detached' });
  await parent.waitForFunction(() => !history.state?.mgLayer);
  await coach.locator('.sc-strip').waitFor();
  expect(await coach.locator('.sc-strip [data-act="publish"]').count() === 0, 'the coach can publish');
  await admin.click('.sc-strip [data-act="publish"]');
  await admin.locator('.sc-strip').waitFor({ state: 'detached', timeout: 8000 });
  await parent.locator('.score-card').waitFor({ timeout: 8000 });
  expect(await parent.locator('[data-tab="minutes"]').count() === 0, 'a parent sees the minutes tab');
  expect(await parent.locator('.live-recent').count() === 0, 'the recent matches stay while a match is live');
});

await step('the coach gets the squad buttons; all of them by choice, and back', async () => {
  // Before kick-off: the lineup on the pitch, no whistle, no match details.
  await coach.goto(APP + '#/live');
  await coach.locator('.live-dock [data-act="full"]').waitFor({ timeout: 8000 });
  await coach.click('[data-tab="match"]');
  await coach.locator('.formation-seg').waitFor();
  expect(await coach.locator('.live-dock [data-act="start"], [data-act="details"]').count() === 0, 'the coach has the whistle or the details by default');
  expect(await coach.locator('.formation-seg').count() === 1, 'the coach cannot arrange the lineup');
  await coach.click('.live-dock [data-act="full"]');
  await coach.locator('.live-dock [data-act="start"]').waitFor();
  expect(await coach.locator('[data-act="details"]').count() === 1, 'all the buttons, without the match details');
  // Kept on the phone, and closed the same way it opened.
  await coach.reload();
  await coach.locator('.live-dock [data-act="squad"]').click({ timeout: 8000 });
  await coach.locator('.live-dock [data-act="full"]').waitFor();
  expect(await coach.locator('.live-dock [data-act="start"]').count() === 0, 'back to the squad, the whistle stayed');
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
    await endPeriod(admin);
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
  // At the break the coach's bar is the squad's: a substitution and the shape,
  // and the timeline opens only them; the clock and the goals are not there.
  await coach.goto(APP + '#/live');
  await coach.locator('.live-dock [data-act="sub"]').waitFor({ timeout: 8000 });
  expect(await coach.locator('.live-dock [data-act="shape"]').count() === 1, 'no shape change in the squad bar');
  expect(await coach.locator('.live-dock [data-act="goal-us"], .live-dock [data-act="start"]').count() === 0, 'goals or the whistle in the squad bar');
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
  await other.locator('#request-form button[type=submit]').click();
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
  // A reload draws the media screen from the kept copy, then again when the
  // season arrives. An upload started on the first and still going when the
  // second is drawn must show on the second: a slow upload, a slower season.
  const slowUpload = async (r) => { await new Promise((ok) => setTimeout(ok, 3000)); await r.fallback(); };
  const slowSeason = async (r) => {
    if (!(r.request().postData() || '').includes('"getSeason"')) return r.continue().catch(() => {});
    const resp = await r.fetch();
    await new Promise((ok) => setTimeout(ok, 1000));
    await r.fulfill({ response: resp }).catch(() => {});
  };
  await other.route('https://api.cloudinary.com/**', slowUpload);
  await other.route(BRIDGE, slowSeason);
  await other.reload();
  await other.setInputFiles('[data-files]', { name: 'b.png', mimeType: 'image/png', buffer: PNG });
  await other.click('.sheet [data-go]');
  try { await other.locator('[data-gallery] .gl-tile').first().waitFor({ timeout: 8000 }); }
  catch { throw new Error(`the upload is not on the screen drawn after it started — bridge: ${galleryFile().items.length} items, tiles: ${await other.locator('[data-gallery] .gl-tile').count()}`); }
  await other.unroute('https://api.cloudinary.com/**', slowUpload);
  await other.unroute(BRIDGE, slowSeason);
  // The gallery's first answer on opening, answered at once but delivered
  // late, as on a slow line: it lands after the answer that follows the
  // upload, and must not draw the gallery from before it.
  // Every answer asked for before the upload is held back (the screen is
  // drawn twice on a reload, and each asks).
  let holding = true;
  const slowFirst = async (r) => {
    if (!holding || !(r.request().postData() || '').includes('"getGallery"')) return r.continue().catch(() => {});
    const resp = await r.fetch();
    await new Promise((ok) => setTimeout(ok, 3000));
    await r.fulfill({ response: resp }).catch(() => {});
  };
  await parent.route(BRIDGE, slowFirst);
  await parent.reload();
  await parent.setInputFiles('[data-files]', [{ name: 'a1.png', mimeType: 'image/png', buffer: PNG }, { name: 'a2.png', mimeType: 'image/png', buffer: PNG }]);
  await parent.locator('.sheet [data-go]').waitFor();
  holding = false;
  await parent.click('.sheet [data-go]');
  // Kept for the day this fails again (it did, rarely, before the fix above):
  // what the bridge holds, what the screen shows, and any sheet or toast.
  const diagnose = async () => [
    'bridge: ' + galleryFile().items.map((x) => x.byName).join(','),
    'tiles: ' + await parent.locator('[data-gallery] .gl-tile').count(),
    'sheets: ' + JSON.stringify(await parent.locator('.sheet').allInnerTexts()),
    'toast: ' + JSON.stringify(await parent.locator('.toast').allInnerTexts()),
  ].join(' | ');
  try { await parent.locator('[data-gallery] .gl-tile').nth(2).waitFor({ timeout: 8000 }); }
  catch (e) { throw new Error('the uploads are not in the gallery — ' + await diagnose()); }
  await parent.waitForTimeout(3500);
  await parent.unroute(BRIDGE, slowFirst);
  expect(await parent.locator('[data-gallery] .gl-tile').count() >= 3, 'a late answer drew the gallery from before the upload — ' + await diagnose());
  // The overview is short: latest uploads and a card per game. Picking
  // happens on a game's page.
  expect(await parent.locator('[data-gallery] [data-sel="start"]').count() === 0, 'picking offered on the overview');
  await parent.locator('[data-gallery] .gl-album').first().click();
  await parent.locator('[data-gallery] [data-back]').waitFor();
  expect(await parent.locator('[data-gallery] .gl-album-grid .gl-tile').count() === 3, 'the game page does not hold all three photos');
  // The upload button stays on screen above the nav wherever the page is
  // scrolled: after the last of many photos it was screens away.
  for (const y of [0, 1e6]) {
    await parent.evaluate((v) => { document.body.style.minHeight = '4000px'; window.scrollTo(0, v); }, y);
    const [btn, nav, vh] = await parent.evaluate(() => [document.querySelector('[data-upload-here]')?.getBoundingClientRect().toJSON(), document.querySelector('.nav, nav')?.getBoundingClientRect().toJSON(), innerHeight]);
    expect(btn && btn.top >= 0 && btn.bottom <= (nav ? nav.top : vh), `the upload button is off screen at scroll ${y}: ${JSON.stringify(btn)} nav ${JSON.stringify(nav)}`);
  }
  await parent.evaluate(() => { document.body.style.minHeight = ''; window.scrollTo(0, 0); });
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
  expect(await parent.locator('[data-upload-here]').count() === 0, 'the upload bar stayed under the picking bar');
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

await step('a sample schedule: one switch puts a note by the schedule and the results, and takes it off', async () => {
  // The page draws the cached season first; wait for the fresh one to land.
  const notes = async (on) => {
    await parent.goto(APP + '#/');
    await parent.reload();
    await parent.waitForFunction((want) => !!document.querySelector('#view .sample-note') === want, on, { timeout: 8000 }).catch(() => {});
    const home = await parent.locator('.sample-note').allInnerTexts();
    await parent.evaluate(() => { location.hash = '#/stats'; });
    await parent.locator('#stats-matches').waitFor();
    const stats = await parent.locator('.sample-note').allInnerTexts();
    const schedule = await parent.locator('#stats-schedule').count();
    return { home, stats, schedule };
  };
  const toggle = async (on) => {
    await admin.goto(APP + '#/admin');
    await adminTab(admin, 'team');
    await admin.locator('#f-settings-sampleSchedule').setChecked(on);
    await admin.click('#save');
    await waitSaved(admin);
    const saved = JSON.parse(bridge.driveFile('season.json')).season.settings?.sampleSchedule;
    expect(saved === on, 'setting saved as ' + JSON.stringify(saved));
  };
  const before = await notes(false);
  expect(!before.home.length && !before.stats.length, 'a note before the switch is on');
  await toggle(true);
  const on = await notes(true);
  expect(on.home.some((t) => t.includes('תוצאות לדוגמה')), 'home notes: ' + JSON.stringify(on.home));
  expect(on.stats.length === 1 + on.schedule && on.stats.at(-1).includes('תוצאות לדוגמה')
    && (!on.schedule || on.stats[0].includes('לוח לדוגמה')), 'stats notes: ' + JSON.stringify(on));
  await toggle(false);
  const off = await notes(false);
  expect(!off.home.length && !off.stats.length, 'notes left after the switch went off: ' + JSON.stringify(off));
});

await step('the roster: off until the manager turns it on, then the title opens it, by shirt number', async () => {
  const setRoster = async (on) => {
    await admin.goto(APP + '#/admin');
    await adminTab(admin, 'team');
    await admin.locator('#f-settings-showRoster').setChecked(on);
    await admin.click('#save');
    await waitSaved(admin);
    expect(JSON.parse(bridge.driveFile('season.json')).season.settings?.showRoster === on, 'showRoster saved as ' + on);
    await parent.goto(APP + '#/');
    await parent.reload();
    await parent.locator('#view section').first().waitFor();
  };
  await parent.goto(APP + '#/');
  await parent.locator('#view section').first().waitFor();
  expect(await parent.locator('[data-roster]').count() === 0 && !(await parent.locator('.topbar').innerText()).includes('הסגל'), 'the roster shows before it is turned on');
  await setRoster(true);
  await parent.waitForSelector('[data-roster]', { timeout: 8000 });
  // The season tag opens it, "הסגל ‹" under the season — not in the league line, where it ran into the role mark.
  expect((await parent.locator('[data-roster]').innerText()).includes('הסגל') && !(await parent.locator('.topbar p').innerText()).includes('הסגל'), 'the season tag does not say what it opens');
  await parent.click('[data-roster]');
  await parent.locator('.sheet .roster li').first().waitFor();
  const rows = await parent.locator('.sheet .roster li').evaluateAll((els) => els.map((li) => [li.children[0].textContent, li.children[1].textContent]));
  const nums = rows.map(([n]) => n === '' ? 999 : Number(n));
  expect(rows.length > 1 && nums.every((n, i) => i === 0 || nums[i - 1] <= n), 'roster by shirt number: ' + JSON.stringify(rows));
  expect(!(await parent.locator('.sheet').innerText()).match(/שוער|בלם|מגן|קשר|חלוץ|כנף/), 'the roster shows no positions');
  await parent.locator('.sheet-x').click();
  await parent.locator('.sheet').waitFor({ state: 'detached' });
  await parent.waitForFunction(() => !history.state?.mgLayer);
  await setRoster(false);
  expect(await parent.locator('[data-roster]').count() === 0, 'the roster stays after it was turned off');
});

// A child's own phone: the manager marks it a player and picks who he is in
// the squad. His card replaces the leaderboard; no analysis, no uploads, no
// control code. The team message from the coach shows on everyone's home.
await step('a player sees his own card and no leaderboard; the coach\'s message reaches everyone', async () => {
  await parent.goto(APP + '#/stats');
  await parent.reload();
  const top = parent.locator('#board .leader').first();
  await top.waitFor({ timeout: 8000 });
  const name = (await top.locator('.who b').innerText()).trim();
  const goals = (await top.locator('.fig.g b').innerText()).trim();
  const kid = await device('player');
  await kid.goto(APP);
  await kid.fill('input[name=name]', 'הילד');
  await kid.locator('#request-form button[type=submit]').click();
  await waitText(kid, 'ממתינה לאישור');
  await admin.goto(APP + '#/admin');
  await admin.reload();
  await admin.click('[data-tab="access"]');
  const row = admin.locator('.user-row').filter({ has: admin.locator('.who b', { hasText: /^הילד$/ }) });
  await row.locator('[data-set="approved"]').click();
  await row.locator('[data-role="player"]').click();
  await admin.locator('.sheet .pp-row', { hasText: name }).first().click();
  await row.locator('[data-role="player"][aria-pressed="true"]').waitFor({ timeout: 8000 });
  expect((await row.innerText()).includes(name), 'the access list does not say who the player is');
  await kid.click('#recheck');
  await kid.locator('.my-card').first().waitFor({ timeout: 8000 });
  const home = await kid.locator('#view').innerText();
  expect(home.includes('הכרטיס שלי') && !home.includes('מובילי העונה') && !home.includes('תמונת מצב'), 'the player\'s home shows a ranking or the analysis');
  expect((await kid.locator('.topbar .role-mark').innerText()).includes(name.split(' ')[0]), 'the title does not name the player');
  await kid.goto(APP + '#/stats');
  await kid.locator('#stats-mine .my-card').waitFor({ timeout: 8000 });
  expect(await kid.locator('#board-tabs, #board').count() === 0, 'the player got the leaderboard');
  expect(!(await kid.locator('#view').innerText()).includes('תרומת המוביל'), 'the player got "the leader\'s share"');
  expect((await kid.locator('#stats-mine .tile.accent b').innerText()).trim() === goals, `the card's goals are not the table's (${goals})`);
  expect(await kid.locator('#stats-mine .my-row').count() > 0, 'the card lists no matches');
  // His card and the team are two panes: the card first, the team a tap away,
  // and a link from home into a team section opens the team pane on it.
  expect(await kid.locator('#stats-matches').count() === 0, 'the team\'s sections are under the card');
  await kid.click('[data-pane="player:team"]');
  await kid.locator('#stats-matches').waitFor({ timeout: 5000 });
  expect(await kid.locator('#stats-mine').count() === 0, 'the card stayed on the team pane');
  await kid.click('[data-pane="player:mine"]');
  await kid.locator('#stats-mine').waitFor({ timeout: 5000 });
  await kid.goto(APP + '#/');
  await kid.locator('a[data-jump="stats-matches"]').click();
  await kid.locator('#stats-matches').waitFor({ timeout: 5000 });
  // The manager sees the same card for any player, picked from the squad.
  await admin.goto(APP + '#/stats');
  await admin.click('[data-pane="staff:cards"]');
  await admin.locator('.pick-player', { hasText: name }).first().click();
  await admin.locator('#stats-cards .my-card').waitFor({ timeout: 5000 });
  expect((await admin.locator('#stats-cards .tile.accent b').innerText()).trim() === goals, 'the manager\'s card of the player is not his');
  await admin.click('#stats-cards [data-card=""]');
  await admin.locator('.pick-grid').waitFor({ timeout: 5000 });
  await admin.click('[data-pane="staff:team"]');
  await admin.locator('#board .leader').first().waitFor({ timeout: 5000 });
  await kid.goto(APP + '#/media');
  await kid.locator('[data-gallery] .sec-head').first().waitFor({ timeout: 8000 });
  expect(await kid.locator('.gl-dock, [data-upload]').count() === 0, 'the player can upload');
  await kid.goto(APP + '#/live');
  await kid.locator('#view .card').first().waitFor({ timeout: 8000 });
  expect(await kid.locator('[data-act="claim"]').count() === 0, 'the player is offered a control code');

  // The entry QR: the manager uploads one; it stays whole (no margin cut
  // away, no background keyed out — the white edge is what a scanner wants),
  // the player gets a square at the end of the week, a parent none until the
  // manager says so, and it opens from the phone's copy when the bridge is out.
  await admin.goto(APP + '#/admin');
  await admin.reload();
  await admin.click('[data-tab="team"]');
  await admin.setInputFiles('#entry-qr [data-qr-file]', { name: 'qr.png', mimeType: 'image/png', buffer: rgbaPng(40, 40, (x, y) => (x >> 3) % 2 === (y >> 3) % 2, [255, 255, 255]) });
  const qrThumb = admin.locator('#entry-qr .qr-thumb img[src]');
  await qrThumb.waitFor({ timeout: 8000 });
  const qrDims = await qrThumb.evaluate(async (i) => { await i.decode(); return `${i.naturalWidth}x${i.naturalHeight}`; });
  expect(qrDims === '40x40', 'the QR was cropped or keyed: ' + qrDims);
  await admin.click('#save');
  await waitSaved(admin);
  await kid.goto(APP + '#/');
  await kid.reload();
  await kid.locator('.week-sec [data-qr]').waitFor({ timeout: 8000 });
  await parent.goto(APP + '#/');
  await parent.reload();
  await parent.locator('.week-sec, .next-card, .card').first().waitFor({ timeout: 8000 });
  expect(await parent.locator('[data-qr]').count() === 0, 'a parent got the QR with the switch off');
  await kid.click('[data-qr]');
  await kid.locator('.sheet .qr-pass img').evaluate((i) => i.decode());
  await kid.locator('.sheet .sheet-x').click();
  await kid.waitForFunction(() => !document.querySelector('.sheet'));
  const noPoster = (r) => {
    let a = '';
    try { a = JSON.parse(r.request().postData() || '{}').action; } catch {}
    return a === 'getPoster' ? r.abort() : r.fallback();
  };
  await kid.route(BRIDGE, noPoster);
  await kid.reload();
  await kid.locator('[data-qr]').click();
  await kid.locator('.sheet .qr-pass img').evaluate((i) => i.decode());
  await kid.unroute(BRIDGE, noPoster);
  await kid.locator('.sheet .sheet-x').click();
  await kid.waitForFunction(() => !document.querySelector('.sheet'));

  // "I won't come", in Waze's place on his next-match card (the parents
  // drive, not him): the coach's list has him at once, and he can take it
  // back before kick-off. And tagging himself in a photo, which the manager
  // can take off.
  {
    const cur = await asAdmin('getSeason');
    const d = new Date(israelToday() + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    const awayFx = { date: d.toISOString().slice(0, 10), time: '23:00', opponent: 'יריבת ההיעדרות', home: true };
    await asAdmin('putSeason', { season: { ...cur.season, fixtures: [...(cur.season.fixtures || []), awayFx] }, baseVersion: cur.version });
    const me = seasonFile().players.find((p) => p.name === name);
    const pid = me.id || 'n:' + me.name;
    const marked = () => Object.values(coachFile().away || {}).some((l) => l.includes(pid));
    await kid.goto(APP + '#/');
    await kid.reload();
    await kid.locator('.hero [data-away]').waitFor({ timeout: 8000 });
    expect(await kid.locator('.hero a[href*="waze"]').count() === 0, 'a player got the Waze button');
    await kid.click('.hero [data-away]');
    await kid.locator('.sheet .btn', { hasText: 'לא אגיע' }).click();
    await kid.locator('.hero .away-row', { hasText: 'סימנת שלא תגיע' }).waitFor({ timeout: 8000 });
    await until(marked, 'the player\'s mark in coach.json');
    await kid.waitForFunction(() => !history.state?.mgLayer);
    await admin.goto(APP + '#/');
    await admin.reload();
    await admin.locator('.mn-att', { hasText: name }).waitFor({ timeout: 8000 });
    expect((await admin.locator('.mn-att', { hasText: name }).innerText()).includes('סימן בעצמו'), 'the manager\'s list does not say he marked it himself');
    await kid.locator('[data-away-undo]').click();
    await kid.locator('.hero [data-away]').waitFor({ timeout: 8000 });
    expect(!marked(), 'taking it back left the mark');

    const sig = bridge.post({ action: 'signUpload', adminCode: ADMIN, kind: 'image' }).result;
    const item = bridge.post({ action: 'addGalleryItem', adminCode: ADMIN, pid: sig.public_id, w: 10, h: 10 }).result.id;
    const tagged = () => galleryFile().items.find((it) => it.id === item).players || [];
    await fakeCloudinary(kid);
    await kid.goto(APP + '#/media');
    await kid.reload();
    await kid.locator(`[data-open="${item}"]`).click();
    await kid.click('.gv [data-v="me"]');
    await kid.locator('.gv .gv-tag.me', { hasText: name }).waitFor({ timeout: 8000 });
    expect(tagged().join() === pid, 'gallery.json tags: ' + JSON.stringify(tagged()));
    await kid.click('.gv [data-v="close"]');
    await kid.waitForFunction(() => !history.state?.mgLayer);
    await kid.goto(APP + '#/stats');
    await kid.locator('[data-my-photos] [data-my-photo]').first().waitFor({ timeout: 8000 });
    await admin.goto(APP + '#/media');
    await admin.reload();
    await admin.locator(`[data-open="${item}"]`).click();
    await admin.locator('.gv .gv-tag', { hasText: name }).waitFor({ timeout: 8000 });
    await admin.click('.gv [data-v="untag"]');
    await until(() => !tagged().length, 'the manager\'s untag');
    await admin.click('.gv [data-v="close"]');
    await admin.waitForFunction(() => !history.state?.mgLayer);
    // Past twelve: three rows of four, the last one "+N", never a sideways scroll.
    for (let i = 0; i < 13; i++) {
      const sg = bridge.post({ action: 'signUpload', adminCode: ADMIN, kind: 'image' }).result;
      const id = bridge.post({ action: 'addGalleryItem', adminCode: ADMIN, pid: sg.public_id, w: 10, h: 10 }).result.id;
      bridge.post({ action: 'tagGalleryItem', adminCode: ADMIN, id, players: [pid] });
    }
    await kid.goto(APP + '#/stats');
    await kid.reload();
    await kid.locator('[data-my-photos] .gl-plus', { hasText: '+2' }).waitFor({ timeout: 8000 });
    const grid = await kid.locator('[data-my-photos] .my-photos').evaluate((el) => ({ n: el.children.length, wide: el.scrollWidth > el.clientWidth }));
    expect(grid.n === 12 && !grid.wide, 'my photos: ' + JSON.stringify(grid));
    const back = await asAdmin('getSeason');
    await asAdmin('putSeason', { season: { ...back.season, fixtures: back.season.fixtures.filter((f) => f.opponent !== awayFx.opponent) }, baseVersion: back.version });
  }

  // The message: written on the home screen (the coach's device is revoked by
  // now; the manager writes it the same way), read by all.
  try {
    await admin.goto(APP + '#/');
    await admin.reload();
    await admin.locator('[data-msg]').first().click();
    await admin.fill('#msg-text', 'מחר   חולצה לבנה');
    await admin.locator('[data-msg-save]').click();
    await admin.locator('.msg-card', { hasText: 'מחר חולצה לבנה' }).waitFor({ timeout: 8000 });
    for (const pg of [kid, parent]) {
      await pg.goto(APP + '#/');
      await pg.reload();
      await pg.locator('.msg-card', { hasText: 'מחר חולצה לבנה' }).waitFor({ timeout: 8000 });
      expect(await pg.locator('[data-msg]').count() === 0, 'a parent or a player can edit the message');
      expect((await pg.locator('.msg-label').innerText()) === 'הודעות', 'message label: ' + await pg.locator('.msg-label').innerText());
    }
    await admin.locator('.msg-edit').click();
    await admin.locator('[data-msg-clear]').click();
    await admin.locator('.msg-add').waitFor({ timeout: 8000 });
    expect(!kid.errors.length, kid.errors.join(' | '));
  } finally {
    const u = (await asAdmin('listUsers')).find((x) => x.name === 'הילד');
    await asAdmin('setStatus', { id: u.id, status: 'revoked' });
  }
  await kid.context().close();
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

// One quiet retry, for reads only. A phone back from the background, or
// Google failing an execution before the script ran, used to show "no
// connection" on one failed request. A write is never sent twice: its answer
// may be what was lost, after the bridge already did it.
const bridgeCall = (page, action, params = {}, opts = {}) => page.evaluate(([url, a, p, o]) =>
  import(url).then((m) => m.call(a, p, o)).then((result) => ({ result }), (e) => ({ code: e.code })),
[APP + 'src/bridge.js', action, params, opts]);
const actionOf = (r) => { try { return JSON.parse(r.request().postData() || '{}').action; } catch { return ''; } };

await step('a read that fails once on the way is sent again quietly; a write is sent once', async () => {
  const seen = [];
  let failed = 0;
  const flaky = async (r) => {
    const a = actionOf(r);
    seen.push(a);
    if (a === 'getSeason' && !failed++) return r.abort();
    // The bridge does the write, and the answer is lost on the way back.
    if (a === 'setRole') { await r.fetch().catch(() => {}); return r.abort(); }
    return r.continue().catch(() => {});
  };
  await admin.route(BRIDGE, flaky);
  try {
    const read = await bridgeCall(admin, 'getSeason', {}, { asAdmin: true });
    expect(read.result?.season, 'a read failing once reached the screen as an error: ' + read.code);
    expect(seen.filter((a) => a === 'getSeason').length === 2, 'the read was not sent again: ' + seen.join());
    const users = (await bridgeCall(admin, 'listUsers', {}, { asAdmin: true })).result;
    // Its own role again: the write changes nothing a later step reads.
    const u = users[0];
    const write = await bridgeCall(admin, 'setRole', { id: u.id, role: u.role === 'coach' ? 'coach' : 'parent' }, { asAdmin: true });
    expect(write.code === 'network', 'a write whose answer was lost did not say so: ' + JSON.stringify(write));
    await new Promise((ok) => setTimeout(ok, 1500));
    expect(seen.filter((a) => a === 'setRole').length === 1, 'a write was sent twice: ' + seen.join());
  } finally {
    await admin.unroute(BRIDGE, flaky);
  }
});

await step('the manager screen shows the device copy at once, and edits only the newest version', async () => {
  await admin.goto(APP + '#/');
  await admin.locator('#nav').waitFor();
  const slow = async (r) => {
    if (actionOf(r) === 'getSeason') await new Promise((ok) => setTimeout(ok, 1500));
    await r.continue().catch(() => {});
  };
  await admin.route(BRIDGE, slow);
  try {
    await admin.goto(APP + '#/admin');
    await admin.click('[data-tab="games"]');
    await admin.locator('.admin-body[inert]').waitFor({ timeout: 1000 });
    expect(await admin.locator('.empty', { hasText: 'טוען' }).count() === 0, 'the copy on the device was not drawn while the season loads');
    expect(/מעדכן/.test(await admin.locator('.save-msg').innerText()), 'the wait is not said');
    await admin.locator('.admin-body:not([inert])').waitFor({ timeout: 5000 });
  } finally {
    await admin.unroute(BRIDGE, slow);
  }
});

await step("a parent's copy of the season is never put up for the manager to edit", async () => {
  // A phone that is also a parent's keeps the parents' season — no minutes,
  // no past lineups. Shown to edit when the read failed, and saved, it
  // erased them from Drive.
  const down = (r) => (actionOf(r) === 'getSeason' ? r.abort() : r.continue().catch(() => {}));
  await admin.route(BRIDGE, down);
  try {
    await admin.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('mg:season'));
      localStorage.setItem('mg:season', JSON.stringify({ ...s, role: 'parent' }));
    });
    await admin.goto(APP + '#/admin');
    await admin.reload();
    await admin.locator('#resync').waitFor({ timeout: 10000 });
    const editable = await admin.evaluate(() => [...document.querySelectorAll('[data-path]')].filter((e) => !e.closest('[inert]')).length);
    expect(!editable, `the parent's copy was put up to edit (${editable} fields)`);
    expect(await admin.locator('#save:not([disabled])').count() === 0, 'saving is possible with no fresh season');
  } finally {
    await admin.unroute(BRIDGE, down);
  }
  await admin.click('#resync');
  await admin.locator('.admin-body:not([inert])').waitFor({ timeout: 8000 });
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
