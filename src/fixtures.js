// The season's fixture list: reading it out of a spreadsheet, and working out
// which fixtures are still to come. Pure functions, no DOM — tests/units.mjs
// runs them under Node.
//
// A fixture is a fact: { date, time, opponent, home, round, venue }. What is
// derived from it — the next match, which fixtures are still ahead — is
// computed on every load and never stored (see season.js).
import { israelIso, splitKickoff } from './format.js';

/* ── Reading cells ─────────────────────────────────────────────────────── */

const pad = (n) => String(n).padStart(2, '0');

// Excel keeps a date as a day count from 1899-12-30, and a time as a
// fraction of a day. A cell that holds both is the two added together.
function fromSerial(n) {
  const days = Math.floor(n);
  const d = new Date(Date.UTC(1899, 11, 30) + days * 86400000);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const mins = Math.round((n - days) * 1440);
  return { date, time: mins > 0 && mins < 1440 ? `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}` : '' };
}

// "19/09/2026", "19.9.26", "2026-09-19", "19-09-2026", or an Excel serial.
// Day first, as in Israel. Anything else is not a date.
export function parseDate(value) {
  const v = String(value ?? '').trim();
  if (!v) return { date: '', time: '' };
  if (/^\d{4,5}(\.\d+)?$/.test(v)) return fromSerial(Number(v));
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  let y, mo, d;
  if (m) [, y, mo, d] = m;
  else {
    // Four digits before two: "2026" must not stop at "20".
    m = v.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?!\d)/);
    if (!m) return { date: '', time: '' };
    [, d, mo, y] = m;
    if (y.length === 2) y = '20' + y;
  }
  const date = `${y}-${pad(mo)}-${pad(d)}`;
  const check = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.getUTCDate() !== Number(d)) return { date: '', time: '' };
  // "19/09/2026 17:30" — a time after the date, when a sheet keeps both in one cell.
  const t = v.slice(m[0].length).match(/(\d{1,2}):(\d{2})/);
  return { date, time: t ? `${pad(t[1])}:${t[2]}` : '' };
}

// "17:30", "17.30", "9:00", or an Excel time fraction.
export function parseTime(value) {
  const v = String(value ?? '').trim();
  if (!v) return '';
  if (/^0?\.\d+$/.test(v)) return fromSerial(Number(v)).time;
  const m = v.match(/^(\d{1,2})[:.](\d{2})/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return '';
  return `${pad(m[1])}:${m[2]}`;
}

export function parseHome(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (/^(בית|ב|ביתי|home|h)$/.test(v)) return true;
  if (/^(חוץ|ח|אורחת|away|a)$/.test(v)) return false;
  return null;
}

const num = (v) => {
  const s = String(v ?? '').trim();
  return /^\d{1,2}$/.test(s) ? Number(s) : null;
};

/* ── Columns ───────────────────────────────────────────────────────────── */

export const FIXTURE_FIELDS = [
  { key: 'date', label: 'תאריך' },
  { key: 'time', label: 'שעה' },
  { key: 'round', label: 'מחזור' },
  { key: 'opponent', label: 'יריבה' },
  { key: 'where', label: 'בית / חוץ' },
  { key: 'homeTeam', label: 'קבוצת בית' },
  { key: 'awayTeam', label: 'קבוצת חוץ' },
  { key: 'venue', label: 'מגרש' },
  { key: 'address', label: 'כתובת' },
  { key: 'gf', label: 'שערים שלנו' },
  { key: 'ga', label: 'שערי היריבה' },
  { key: 'homeGoals', label: 'שערי קבוצת הבית' },
  { key: 'awayGoals', label: 'שערי קבוצת החוץ' },
  { key: '', label: 'לא לייבא' },
];

// Header names as they appear in schedules the league sends and in ones a
// coach types. The order matters: longer phrases before the words in them.
const HEADERS = [
  ['homeGoals', /^(שערי (קבוצת )?(ה)?בית|home ?goals)$/i],
  ['awayGoals', /^(שערי (קבוצת )?(ה)?חוץ|away ?goals)$/i],
  ['homeTeam', /^(קבוצת (ה)?בית|(ה)?מארחת|home ?team|home)$/i],
  ['awayTeam', /^(קבוצת (ה)?חוץ|(ה)?אורחת|away ?team|away)$/i],
  ['where', /^(בית ?\/ ?חוץ|ב ?\/ ?ח|מיקום|home ?\/ ?away|h ?\/ ?a)$/i],
  ['gf', /^(שערים (שלנו|לנו)|שערינו|כבשנו|goals ?for|gf)$/i],
  ['ga', /^(שערי (ה)?יריבה|ספגנו|goals ?against|ga)$/i],
  ['date', /^(תאריך|תאריך (ה)?משחק|יום|date)$/i],
  ['time', /^(שעה|שעת (ה)?(משחק|פתיחה)|time|kick ?off)$/i],
  ['round', /^(מחזור|מס['׳"״]? ?מחזור|round|md|matchday)$/i],
  ['opponent', /^((ה)?יריבה|קבוצה יריבה|נגד|opponent|vs\.?)$/i],
  ['venue', /^(מגרש|(ה)?אצטדיון|מקום|venue|stadium|ground|pitch)$/i],
  ['address', /^(כתובת|כתובת (ה)?מגרש|address)$/i],
];

// A fixture list is read by its header row: dates, rounds and goal counts
// are all small numbers, and guessing which is which would be wrong often
// enough to put a match on the wrong day.
export function detectFixtureColumns(rows) {
  const first = rows[0] || [];
  const width = Math.max(0, ...rows.map((r) => r.length));
  const map = Array(width).fill('');
  first.forEach((h, i) => {
    const t = String(h ?? '').trim().replace(/\s+/g, ' ');
    const hit = HEADERS.find(([key, re]) => re.test(t) && !map.includes(key));
    if (hit) map[i] = hit[0];
  });
  return { map, headerRow: map.some(Boolean) };
}

const norm = (s) => String(s || '').replace(/[\s"'׳״.,-]/g, '').toLowerCase();

// In a league schedule (home team / away team), "us" is the team that is in
// every row. The team name from the season settles a tie.
function whoIsUs(rows, iHome, iAway, teamName) {
  const count = new Map();
  for (const r of rows) for (const i of [iHome, iAway]) {
    const k = norm(r[i]);
    if (k) count.set(k, (count.get(k) || 0) + 1);
  }
  const want = norm(teamName);
  let best = '', n = -1;
  for (const [k, c] of count) {
    if (c > n || (c === n && want && (k.includes(want) || want.includes(k)))) { best = k; n = c; }
  }
  return best;
}

// Rows → fixtures. A row with both scores is a match already played and
// comes back as a result; the rest are fixtures. Rows without a date or an
// opponent are skipped and counted, so the preview can say so.
export function rowsToFixtures(rows, { map, headerRow }, teamName = '') {
  const body = headerRow ? rows.slice(1) : rows;
  const at = (key) => map.indexOf(key);
  const iHome = at('homeTeam'), iAway = at('awayTeam');
  const us = iHome >= 0 && iAway >= 0 ? whoIsUs(body, iHome, iAway, teamName) : '';
  const get = (r, key) => { const i = at(key); return i < 0 ? '' : String(r[i] ?? '').trim(); };

  const fixtures = [], results = [];
  let skipped = 0;
  for (const r of body) {
    if (!r.some((c) => String(c ?? '').trim())) continue;
    const when = parseDate(get(r, 'date'));
    let opponent = get(r, 'opponent');
    let home = parseHome(get(r, 'where'));
    if (us) {
      const h = get(r, 'homeTeam'), a = get(r, 'awayTeam');
      if (norm(h) === us) { home = true; opponent = opponent || a; }
      else if (norm(a) === us) { home = false; opponent = opponent || h; }
    }
    if (!when.date || !opponent) { skipped++; continue; }
    const round = num(get(r, 'round'));
    // "אימון" / "ידידות" in the round column: a training match, with no round.
    const friendly = /אימון|ידידות|friendly/i.test(String(get(r, 'round') ?? ''));
    const time = parseTime(get(r, 'time')) || when.time;
    const fixture = {
      date: when.date, time, opponent: opponent.replace(/\s+/g, ' '), home: home !== false, round, ...(friendly ? { friendly } : {}),
      venue: { name: get(r, 'venue'), address: get(r, 'address') },
    };
    let gf = num(get(r, 'gf')), ga = num(get(r, 'ga'));
    if (gf == null || ga == null) {
      const hg = num(get(r, 'homeGoals')), ag = num(get(r, 'awayGoals'));
      if (hg != null && ag != null) [gf, ga] = fixture.home ? [hg, ag] : [ag, hg];
    }
    if (gf != null && ga != null) results.push({ date: fixture.date, opponent: fixture.opponent, home: fixture.home, round, ...(friendly ? { friendly } : {}), gf, ga });
    else fixtures.push(fixture);
  }
  const byDate = (a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || '');
  return { fixtures: fixtures.sort(byDate), results: results.sort(byDate), skipped };
}

/* ── What is still to come ─────────────────────────────────────────────── */

export function todayInIsrael(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now).reduce((o, x) => ({ ...o, [x.type]: x.value }), {});
  return `${p.year}-${p.month}-${p.day}`;
}

// Fixtures from today on, minus any whose date already has a result: once
// the manager enters the score, the next fixture moves up by itself.
// A fixture is done when a match sits on its date, or when a match was
// opened from it (match.fixture) — played early or late, on another day.
export const fixtureKey = (f) => `${f.date}|${String(f.opponent || '').trim()}`;

// A schedule row that has its result: a match on its day, or a live match
// opened from it (which may have been played on another day).
export function playedTest(matches) {
  const played = new Set((matches || []).map((m) => m.date));
  const opened = new Set((matches || []).filter((m) => m.fixture).map((m) => fixtureKey(m.fixture)));
  return (f) => played.has(f.date) || opened.has(fixtureKey(f));
}

// A game whose day is still to be set (tbd, the "צו פיוס" setting): its date
// is the round's date from the league's list, which only tells the week —
// the league lists every round on its Saturday, and these games are played
// on a weekday. It counts as possibly any day of that week (Sunday–Saturday),
// and sorts after every dated game of the week.
const shiftDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dow = (iso) => new Date(iso + 'T12:00:00Z').getUTCDay();
export const isTbd = (f) => f?.tbd === true && /^\d{4}-\d{2}-\d{2}$/.test(String(f.date || ''));
export const firstDay = (f) => (isTbd(f) ? shiftDays(f.date, -dow(f.date)) : f?.date || '');
export const lastDay = (f) => (isTbd(f) ? shiftDays(f.date, 6 - dow(f.date)) : f?.date || '');
export const gameOrder = (f) => `${lastDay(f)} ${isTbd(f) ? '~' : f?.time || ''}`;

// A game put off (the owner): postponed — not played on its day, to be played
// later, the new day still unknown — or cancelled. Neither is the next match;
// both stay on the schedule with their word. A postponed game stays there past
// its day, at the end, until a new date is typed (which clears the mark).
export const STATUS = { postponed: 'נדחה', cancelled: 'בוטל' };
export const offStatus = (f) => (f?.status === 'postponed' || f?.status === 'cancelled' ? f.status : '');
export const nextPlayable = (list) => (list || []).find((f) => !offStatus(f)) || null;

export function upcomingFixtures(fixtures, matches, now = new Date()) {
  const today = todayInIsrael(now);
  const played = playedTest(matches);
  const later = (f) => offStatus(f) === 'postponed';
  return (fixtures || [])
    .filter((f) => f && (lastDay(f) >= today || later(f)) && !played(f))
    .sort((a, b) => later(a) - later(b) || gameOrder(a).localeCompare(gameOrder(b)));
}

// Games a gallery upload can belong to, newest first: every result, and every
// game on the schedule whose day has come even when no result was entered
// for it — the photos are taken either way.
export function photoMatches(matches, fixtures, now = new Date()) {
  const today = todayInIsrael(now);
  const played = (matches || []).filter((m) => m?.date).map((m) => ({ date: m.date, opponent: m.opponent || '' }));
  const days = new Set(played.map((m) => m.date));
  const past = (fixtures || []).filter((f) => f?.date && !offStatus(f) && firstDay(f) <= today && !days.has(f.date))
    .map((f) => ({ date: f.date, opponent: f.opponent || '' }));
  return [...played, ...past].filter((m) => m.opponent).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20);
}

// A fixture in the shape the next-match card reads. Without a time the
// card says the time is still to be set, and shows no countdown.
export function fixtureAsNext(f) {
  if (!f) return null;
  const time = f.time || '12:00';
  return {
    opponent: f.opponent, home: f.home !== false, round: f.round ?? null, friendly: f.friendly === true,
    kickoff: israelIso(f.date, time), timeTbd: !f.time, ...(isTbd(f) ? { dateTbd: true } : {}),
    venue: { name: f.venue?.name || '', address: f.venue?.address || '', waze: f.venue?.waze || '' },
    arrival: f.arrival || '', kit: f.kit || '', fromFixtures: true,
  };
}

// Merging an imported file: its fixtures replace the list (a schedule file is
// the whole schedule), and its results are added unless a match on that date
// is already there — a result entered by hand or saved from a live match is
// never overwritten by a spreadsheet.
// With "צו פיוס" on (tbd) the file's dates are only the rounds' weeks: every
// fixture comes in with its date still to be set, and a date the manager
// already set by hand (the same round and opponent, on another day than the
// file's) stays.
export function applyFixtureImport(season, { fixtures, results }, { tbd = false } = {}) {
  // The file knows dates, opponents and grounds; what the manager added to a
  // game here (gathering, kit, a Waze link, a ground the file leaves empty)
  // stays with the same game — the imported schedule replaces the old one.
  const before = (season.fixtures || []).filter(Boolean);
  const had = new Map(before.map((f) => [fixtureKey(f), f]));
  const sameRound = (f) => f.round != null && before.find((o) => o.round === f.round && String(o.opponent || '').trim() === f.opponent);
  fixtures = fixtures.map((f) => {
    if (tbd) f = { ...f, tbd: true };
    const old = had.get(fixtureKey(f)) || (tbd ? sameRound(f) : null);
    if (!old) return f;
    if (tbd && old.tbd !== true && old.date !== f.date) {
      const { tbd: _, ...rest } = f;
      f = { ...rest, date: old.date, time: old.time || f.time };
    } else if (tbd) f = { ...f, time: f.time || old.time || '' };
    const v = f.venue || {}, ov = old.venue || {};
    return {
      ...f, arrival: old.arrival || '', kit: old.kit || '', ...(offStatus(old) && old.date === f.date ? { status: old.status } : {}),
      venue: { ...v, name: v.name || ov.name || '', address: v.address || ov.address || '', waze: ov.waze || '' },
    };
  });
  const matches = [...(season.matches || [])];
  const have = new Set(matches.map((m) => m.date));
  let added = 0;
  for (const r of results) if (!have.has(r.date)) { matches.push(r); have.add(r.date); added++; }
  return { fixtures, matches, added };
}

// The next match used to be a record of its own beside the schedule, with
// the gathering time, kit and Waze link only it could hold. It is now just the
// schedule's nearest row (the owner: the two were the same game twice), and a
// stored one folds into its row — same day and opponent, else the same day —
// or becomes a row when the schedule does not have it.
export function mergeNextMatch(season) {
  const fixtures = [...(season?.fixtures || [])];
  const nm = season?.nextMatch;
  if (!nm?.opponent) return { fixtures, merged: false };
  const { date, time } = splitKickoff(nm.kickoff);
  const name = String(nm.opponent).trim();
  let i = fixtures.findIndex((f) => f && f.date === date && String(f.opponent || '').trim() === name);
  if (i < 0) i = fixtures.findIndex((f) => f && f.date === date);
  const f = i >= 0 ? fixtures[i] : { date, opponent: name };
  const v = nm.venue || {}, fv = f.venue || {};
  const row = {
    ...f,
    time: time || f.time || '',
    home: nm.home !== false, round: nm.round ?? f.round ?? null, friendly: nm.friendly === true || f.friendly === true,
    venue: { name: v.name || fv.name || '', address: v.address || fv.address || '', waze: v.waze || fv.waze || '' },
    arrival: nm.arrival || f.arrival || '', kit: nm.kit || f.kit || '',
  };
  if (i >= 0) fixtures[i] = row; else fixtures.push(row);
  return { fixtures, merged: true };
}

/* ── The game message from WhatsApp ────────────────────────────────────── */

// What the team gets on WhatsApp before each game, pasted by the manager:
//   בשעה טובה , מחזור ליגה 1
//   שישי  הקרוב  משחק נגד רמת השרון צפון
//   הגעה - 14:30 / תחילת משחק - 15:30 / סיום משוער - 17:00
//   מיקום - דרך דודו דותן 2 רמה"ש.
//   יש להגיע לבושים עם גרביים ומכנסיים צהובים, בתיק חולצה לבנה, מגינים…
// Pure: text and today in, what it says out (only what it says — a field it
// does not mention is left out, not emptied). The end time is not kept.
const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
// A weekday word is a day only where it reads as one — "ביום שישי", "בשבת",
// "שישי הקרוב", or opening a line — not "המשחק הראשון", "החלק השני".
const DAY_ALT = DAYS.join('|');
const DAY_RE = new RegExp(`(?:(?:^|[\\s,(])(?:ב?יום\\s+|ב)(${DAY_ALT})|^(${DAY_ALT})|(?:^|[\\s,(])(${DAY_ALT})(?=\\s+(?:הקרוב|הקרובה|הבא|הזה|\\d)))(?=[\\s,.)!]|$)`, 'm');
const hhmm = (s) => { const m = /(\d{1,2})[:.](\d{2})(?!\d)/.exec(s); return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? `${pad(m[1])}:${m[2]}` : ''; };
// The value after "הגעה - " / "מיקום: ".
const after = (line, word) => line.slice(line.search(word)).replace(word, '').replace(/^\s*[-–:]\s*/, '').trim();
// The kit sentence runs on into what to bring; it stops at the first item
// that names no garment and no colour ("מגינים", "ליטר וחצי מים").
const GARMENT = /חולצ|מכנס|גרבי|אימונית|טרנינג|סווטשירט|ערכה|מדים|שורט|צהוב|כחול|לבנ|לבן|שחור|אדומ|אדום|ירוק|אפור|כתומ|כתום|סגול|זהב/;

export function parseGameMessage(text, today = todayInIsrael()) {
  const lines = String(text || '').normalize('NFC').replace(/[‎‏‪-‮⁦-⁩]/g, '')
    .split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const all = lines.join('\n');
  const out = {};
  const round = /מחזור(?:\s+ליגה)?\s*(?:מס(?:פר|')?\s*)?(\d{1,2})(?!\d)/.exec(all);
  if (round) out.round = Number(round[1]);
  if (/משחק\s+(?:אימון|ידידות)/.test(all)) out.friendly = true;
  const opp = /(?:^|\s)(?:נגד|מול)\s+([^\n,!.]+)/.exec(all);
  if (opp) out.opponent = opp[1].replace(/\s*[-–]\s*$/, '').replace(/\s+(?:ב|ה)?(?:בית|חוץ)$/, '').trim();
  if (/משחק\s+(?:ה)?בית|(?:^|\s)בבית(?=[\s,.]|$)|במגרש\s+הביתי/.test(all)) out.home = true;
  else if (/משחק\s+(?:ה)?חוץ|(?:^|\s)בחוץ(?=[\s,.]|$)/.test(all)) out.home = false;

  // The day: a date written out wins; then "מחר"/"היום"; then a weekday,
  // the nearest one from today (today included).
  // "17/10", "17.10.26"; "17.10" alone only after a weekday or "תאריך" —
  // "15.30" is how some write a time.
  const dated = /(?:^|[\s(])(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?=[\s,.)]|$)/m.exec(all)
    || /(?:^|[\s(])(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})(?=[\s,)]|\.?$)/m.exec(all)
    || new RegExp(`(?:${DAY_ALT}|תאריך)\\s*[-–:]?\\s*(\\d{1,2})\\.(\\d{1,2})()(?=[\\s,)]|$)`, 'm').exec(all);
  if (dated && Number(dated[1]) <= 31 && Number(dated[2]) <= 12) {
    let y = dated[3] ? (dated[3].length === 2 ? '20' + dated[3] : dated[3]) : today.slice(0, 4);
    let iso = `${y}-${pad(dated[2])}-${pad(dated[1])}`;
    if (!dated[3] && iso < shiftDays(today, -60)) iso = `${Number(y) + 1}${iso.slice(4)}`;
    if (parseDate(iso).date) out.date = iso;
  }
  if (!out.date) {
    if (/(?:^|\s)מחרתיים(?=[\s,.]|$)/.test(all)) out.date = shiftDays(today, 2);
    else if (/(?:^|\s)מחר(?=[\s,.]|$)/.test(all)) out.date = shiftDays(today, 1);
    else if (/(?:^|\s)היום(?=[\s,.]|$)/.test(all)) out.date = today;
    else {
      const d = DAY_RE.exec(all);
      if (d) { out.day = DAYS.indexOf(d[1] || d[2] || d[3]); out.date = shiftDays(today, (out.day - dow(today) + 7) % 7); }
    }
  }

  for (const line of lines) {
    const t = hhmm(line);
    if (t && /סיום|עד\s+השעה|חזרה|איסוף\s+מ/.test(line)) continue;
    if (t && /הגעה|התכנסות|להגיע\s+(?:ב|עד)|איסוף|ריכוז/.test(line)) out.arrival ??= t;
    else if (t && /תחילת|שריקת|שעת\s+(?:ה)?משחק|משחק\s*(?:[-–:]|ב-?\s*\d|בשעה)|פתיחה|קיק/.test(line)) out.time ??= t;
    if (/^(?:מיקום|כתובת|מקום)(?:\s+(?:ה)?משחק)?\s*[-–:]/.test(line)) out.address ??= after(line, /^(?:מיקום|כתובת|מקום)(?:\s+(?:ה)?משחק)?/).replace(/[.\s]+$/, '');
    else if (/^מגרש\s*[-–:]/.test(line)) out.venue ??= after(line, /^מגרש/).replace(/[.\s]+$/, '');
    const kit = /(?:לבושים|לבושות|ללבוש|תלבושת)\s*[-–:]?\s*(?:עם\s+|ב)?(.+)/.exec(line);
    if (kit && !out.kit) {
      const keep = [];
      for (const part of kit[1].split(',').map((s) => s.replace(/[.\s]+$/, '').trim()).filter(Boolean)) {
        if (!GARMENT.test(part)) break;
        keep.push(part);
      }
      if (keep.length) out.kit = keep.join(', ').slice(0, 120);
    }
  }
  if (!out.time) {
    // A message with one time and nothing to say what it is: the kickoff.
    const times = lines.filter((l) => !/סיום|הגעה|התכנסות/.test(l)).map(hhmm).filter(Boolean);
    if (times.length === 1) out.time = times[0];
  }
  return out;
}

const words = (s) => String(s || '').normalize('NFC').replace(/[׳'"״`.\-–]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);

// The schedule row a game message is about: the opponent (its words in the
// row's name or the other way round — "רמת השרון צפון" is "הפועל רמת השרון
// צפון"), and the round; among equals, the nearest game still to come.
// Returns the index, or -1.
export function gameMessageRow(fixtures, msg, matches = [], today = todayInIsrael()) {
  const played = playedTest(matches);
  const want = words(msg.opponent);
  let best = -1, top = 0, bestOrder = '';
  (fixtures || []).forEach((f, i) => {
    if (!f || played(f) || lastDay(f) < shiftDays(today, -7)) return;
    const have = words(f.opponent);
    let s = 0;
    if (want.length && have.length) {
      const shared = want.filter((w) => have.includes(w)).length;
      if (shared === Math.min(want.length, have.length)) s += 4;
      else if (shared * 2 >= want.length) s += 2;
    }
    if (msg.round != null && f.round === msg.round) s += 3;
    if (msg.date && msg.date >= firstDay(f) && msg.date <= lastDay(f)) s += 1;
    if (!s || (want.length && s < 3)) return;
    const order = gameOrder(f);
    if (s > top || (s === top && order < bestOrder)) { best = i; top = s; bestOrder = order; }
  });
  return best;
}

// The row as the message leaves it: only what the message says changes.
// A weekday for a game whose day was still to be set falls in that game's
// week. A new address drops the old ground's name and Waze link — they
// would lead to the old place.
export function applyGameMessage(f, msg, today = todayInIsrael()) {
  const row = { ...f, venue: { name: '', address: '', waze: '', ...(f.venue || {}) } };
  let date = msg.date;
  if (msg.day != null && isTbd(f) && lastDay(f) >= today) date = shiftDays(firstDay(f), msg.day);
  if (date) { row.date = date; delete row.tbd; delete row.status; }
  if (msg.time) row.time = msg.time;
  if (msg.arrival) row.arrival = msg.arrival;
  if (msg.kit) row.kit = msg.kit;
  if (msg.round != null && row.round == null && !row.friendly) row.round = msg.round;
  if (typeof msg.home === 'boolean') row.home = msg.home;
  if (msg.address && msg.address !== row.venue.address) row.venue = { name: msg.venue || '', address: msg.address, waze: '' };
  else if (msg.venue) row.venue = { ...row.venue, name: msg.venue };
  return row;
}
