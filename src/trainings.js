// This week's trainings, for the strip above the next match (the owner's
// pick from a mockup: one square per training, like a calendar row).
//
// The manager keeps two lists: the weekly routine (`trainings`: day of the
// week, hours, venue) and one-off changes (`trainingChanges`: a date that
// moves, cancels or adds a training). The week is computed from both on
// every load and never stored — a change simply stops mattering once its
// week is over.

import { todayInIsrael } from './fixtures.js';
import { israelIso } from './format.js';

export const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

const TIME = /^\d\d:\d\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const time = (v) => (TIME.test(String(v || '')) ? String(v) : '');
const text = (v) => String(v ?? '').trim();

// Dates as plain calendar days: YYYY-MM-DD in, arithmetic in UTC so no
// timezone or clock change can move a day.
const utc = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (isoDate, n) => { const d = utc(isoDate); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
export const weekday = (isoDate) => utc(isoDate).getUTCDay();

// A training's venue, falling back to the home ground when none is given.
// `waze` is the manager's own navigation link (a link, or coordinates;
// navLink in format.js), which wins over the address.
function venueOf(v, home) {
  const name = text(v?.name), address = text(v?.address), waze = text(v?.waze);
  if (name || address || waze) return { name, address, waze };
  return { name: text(home?.name), address: text(home?.address), waze: '' };
}

// Sunday to Saturday around today (Israel), the week a parent plans by;
// `ahead` = 1 is the week after (the owner's "next week" button, offered
// once the week's last training is over — nextWeekFrom). The week's games
// sit in their days, a played one with its score.
export function trainingWeek(season, games, now = new Date(), ahead = 0) {
  const today = todayInIsrael(now);
  const start = addDays(today, 7 * ahead - weekday(today));
  const end = addDays(start, 6);
  const home = season?.team?.homeVenue;

  const routine = (season?.trainings || []).filter((t) => t && /^[0-6]$/.test(String(t.day)));
  const valid = (season?.trainingChanges || []).filter((c) => c && DATE.test(String(c.date)));
  // A training moved to another day is one change, on its own date, with
  // `movedTo`: it leaves its day ("moved") and lands on the other ("moved
  // in"), and either end may fall in this week.
  const movedTo = (c) => (c.cancelled !== true && DATE.test(String(c.movedTo || '')) && c.movedTo !== c.date ? c.movedTo : '');
  const changes = valid.filter((c) => c.date >= start && c.date <= end);
  const arriving = valid.filter((c) => movedTo(c) >= start && movedTo(c) <= end);

  const routineOn = (date, i = weekday(date)) => routine.filter((t) => Number(t.day) === i)
    .map((t) => ({ date, start: time(t.start), end: time(t.end), venue: venueOf(t.venue, home), change: '' }));
  // The routine as a change leaves it: an empty field keeps the routine's.
  const apply = (c, base, date) => {
    const hasVenue = text(c.venue?.name) || text(c.venue?.address) || text(c.venue?.waze);
    return {
      date,
      start: time(c.start) || base?.start || '',
      end: time(c.end) || base?.end || '',
      venue: hasVenue ? venueOf(c.venue, home) : base?.venue || venueOf(null, home),
    };
  };

  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(start, i);
    const regular = routineOn(date, i);
    // A change on a day with a routine training replaces the fields it fills
    // in, and keeps what they were (`was`) for the sheet; on any other day it
    // is an extra training.
    const taken = new Set();
    for (const c of changes.filter((x) => x.date === date)) {
      const base = regular.find((r) => !taken.has(r));
      const to = movedTo(c);
      if (to && base) {
        // Gone from here: shown struck through, with where it went.
        Object.assign(base, { change: 'away', movedTo: to, was: { start: base.start, end: base.end, venue: base.venue } });
        taken.add(base);
        continue;
      }
      const merged = { ...apply(c, base, date), change: c.cancelled === true ? 'cancelled' : base ? 'changed' : 'extra' };
      if (base) {
        Object.assign(base, merged, { was: { start: base.start, end: base.end, venue: base.venue } });
        taken.add(base);
      } else regular.push(merged);
    }
    for (const c of arriving.filter((x) => movedTo(x) === date)) {
      const base = routineOn(c.date)[0];
      if (!base) continue;
      regular.push({ ...apply(c, base, date), change: 'moved', from: c.date, was: { start: base.start, end: base.end, venue: base.venue } });
    }
    days.push(...regular.sort((a, b) => a.start.localeCompare(b.start)));
  }

  const items = days.map((d) => ({ ...d, kind: 'training', past: d.date < today, today: d.date === today }));
  // Every game of the week, played ones too: a game that ended stays in its
  // day like a training that took place (the owner's ask), with its score.
  const seen = new Set();
  for (const g of games || []) {
    if (!g || !(g.date >= start && g.date <= end)) continue;
    const key = g.date + '|' + text(g.opponent);
    if (seen.has(key)) continue;
    seen.add(key);
    const played = Number.isInteger(g.gf) && Number.isInteger(g.ga);
    items.push({ kind: 'game', date: g.date, start: time(g.time), opponent: text(g.opponent),
      ...(played ? { gf: g.gf, ga: g.ga } : {}), past: played || g.date < today, today: g.date === today });
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'game') - (b.kind === 'game'));
  return { start, end, ahead, trainings: days.length, items };
}

// When the "next week" button shows (the owner's ask; it was Saturday): once
// the week's last training is over, nothing in this week is left to plan for.
// A cancelled training, or one moved out of the week, does not count. One
// with no end time counts half an hour after its start (the owner's call),
// and one with no hours at all at the end of its day. A week with no
// training left offers it at once. A moment (ms), so a screen drawn before it
// can tell that it passed (refresh in app.js).
const START_GRACE_MS = 30 * 60 * 1000;
export function nextWeekFrom(week) {
  let last = 0;
  for (const i of week?.items || []) {
    if (i.kind !== 'training' || i.change === 'cancelled' || i.change === 'away') continue;
    const at = i.end ? Date.parse(israelIso(i.date, i.end))
      : i.start ? Date.parse(israelIso(i.date, i.start)) + START_GRACE_MS
      : Date.parse(israelIso(i.date, '23:59'));
    if (at > last) last = at;
  }
  return last;
}
