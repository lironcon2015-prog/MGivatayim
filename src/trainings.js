// This week's trainings, for the strip above the next match (the owner's
// pick from a mockup: one square per training, like a calendar row).
//
// The manager keeps two lists: the weekly routine (`trainings`: day of the
// week, hours, venue) and one-off changes (`trainingChanges`: a date that
// moves, cancels or adds a training). The week is computed from both on
// every load and never stored — a change simply stops mattering once its
// week is over.

import { todayInIsrael } from './fixtures.js';

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
function venueOf(v, home) {
  const name = text(v?.name), address = text(v?.address);
  if (name || address) return { name, address };
  return { name: text(home?.name), address: text(home?.address) };
}

// Sunday to Saturday around today (Israel), the week a parent plans by;
// `ahead` = 1 is the week after (the owner's "next week" button, offered
// from Saturday). The first game on the schedule that falls in the week
// closes the row.
export function trainingWeek(season, games, now = new Date(), ahead = 0) {
  const today = todayInIsrael(now);
  const start = addDays(today, 7 * ahead - weekday(today));
  const end = addDays(start, 6);
  const home = season?.team?.homeVenue;

  const routine = (season?.trainings || []).filter((t) => t && /^[0-6]$/.test(String(t.day)));
  const changes = (season?.trainingChanges || []).filter((c) => c && DATE.test(String(c.date)) && c.date >= start && c.date <= end);

  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(start, i);
    const regular = routine.filter((t) => Number(t.day) === i)
      .map((t) => ({ date, start: time(t.start), end: time(t.end), venue: venueOf(t.venue, home), change: '' }));
    // A change on a day with a routine training replaces the fields it fills
    // in (an empty field keeps the routine's), and keeps what they were
    // (`was`) for the sheet; on any other day it is an extra training.
    const taken = new Set();
    for (const c of changes.filter((x) => x.date === date)) {
      const base = regular.find((r) => !taken.has(r));
      const hasVenue = text(c.venue?.name) || text(c.venue?.address);
      const merged = {
        date,
        start: time(c.start) || base?.start || '',
        end: time(c.end) || base?.end || '',
        venue: hasVenue ? venueOf(c.venue, home) : base?.venue || venueOf(null, home),
        change: c.cancelled === true ? 'cancelled' : base ? 'changed' : 'extra',
      };
      if (base) {
        Object.assign(base, merged, { was: { start: base.start, end: base.end, venue: base.venue } });
        taken.add(base);
      } else regular.push(merged);
    }
    days.push(...regular.sort((a, b) => a.start.localeCompare(b.start)));
  }

  const items = days.map((d) => ({ ...d, kind: 'training', past: d.date < today, today: d.date === today }));
  const game = (games || []).find((g) => g?.date >= start && g.date <= end);
  if (game) {
    items.push({ kind: 'game', date: game.date, start: time(game.time), opponent: text(game.opponent), past: game.date < today, today: game.date === today });
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'game') - (b.kind === 'game'));
  return { start, end, ahead, trainings: days.length, items };
}

// The "next week" button shows from Saturday: the week's game is that day,
// and parents plan the coming week from it.
export const offersNextWeek = (now = new Date()) => weekday(todayInIsrael(now)) === 6;
