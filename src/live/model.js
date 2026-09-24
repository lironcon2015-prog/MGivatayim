// The live match as pure data and pure functions: no network, no DOM, no
// clock reads. Every operation carries the times it needs (`at`, `atMs`), so
// replaying the same operations always yields the same state — which is what
// lets a controller's queued actions be re-applied on top of a newer server
// copy after a conflict or a dropped connection (see sync.js).

/* ── Match format ──────────────────────────────────────────────────────── */

export const DEFAULT_FORMAT = [30, 30, 20];

export const FORMAT_PRESETS = [
  { label: '3 שלישים · 30/30/20', format: [30, 30, 20] },
  { label: '3 שלישים · 20', format: [20, 20, 20] },
  { label: '2 מחציות · 25', format: [25, 25] },
  { label: '2 מחציות · 30', format: [30, 30] },
  { label: '2 מחציות · 45', format: [45, 45] },
  { label: '4 רבעים · 15', format: [15, 15, 15, 15] },
];

export function cleanFormat(f) {
  const out = (Array.isArray(f) ? f : []).map((m) => Math.round(Number(m))).filter((m) => m > 0 && m <= 90).slice(0, 6);
  return out.length ? out : [...DEFAULT_FORMAT];
}

/* ── Players on the field ──────────────────────────────────────────────
   Youth football here is nine-a-side until the older age groups move to
   eleven. The season sets the default (settings.size); a single match can
   override it before kickoff. A state from before sizes existed reads as 9. */

export const SIZES = [
  { n: 9, label: 'תשיעיות' },
  { n: 11, label: '11 על 11' },
];
export const DEFAULT_SIZE = 9;
export const cleanSize = (n) => (SIZES.some((x) => x.n === Number(n)) ? Number(n) : DEFAULT_SIZE);
export const sizeOf = (state) => cleanSize(state?.size);
export const describeSize = (n) => SIZES.find((x) => x.n === cleanSize(n)).label;

// The starting lineup of the most recent match that recorded one, as the
// default for the next: most weeks the same players start. Players who have
// left the squad drop out, and a lineup bigger than this match's size is cut
// to it. `matches` is newest first (season.recent).
export function previousLineup(matches, players, size) {
  const ids = new Set((players || []).map((p) => p.id));
  const last = (matches || []).find((m) => Array.isArray(m.lineup) && m.lineup.length);
  if (!last) return [];
  const seen = new Set();
  return last.lineup
    .filter((l) => ids.has(l.pid) && !seen.has(l.pid) && seen.add(l.pid))
    .slice(0, cleanSize(size))
    .map((l) => ({ pid: l.pid, pos: l.pos || '' }));
}

const WORDS = { 1: 'משחק', 2: 'מחצית', 3: 'שליש', 4: 'רבע' };
export const periodWord = (format) => WORDS[format.length] || 'חלק';
export const periodName = (format, i) => (format.length === 1 ? 'משחק' : `${periodWord(format)} ${i + 1}`);
export const describeFormat = (format) =>
  format.length === 1 ? `משחק אחד · ${format[0]} דק׳`
    : `${format.length} ${{ 2: 'מחציות', 3: 'שלישים', 4: 'רבעים' }[format.length] || 'חלקים'} · ${
      format.every((m) => m === format[0]) ? `${format[0]} דק׳` : format.join('/')}`;

/* ── Clock ─────────────────────────────────────────────────────────────── */

export function elapsedMs(state, now) {
  const c = state.clock || {};
  return Math.max(0, (c.accMs || 0) + (c.running && c.startedAt != null ? now - c.startedAt : 0));
}

const offsetMin = (format, period) => format.slice(0, period).reduce((a, b) => a + b, 0);

// Wraps a number-with-symbols in Unicode directional isolates (LRI…PDI).
// In Hebrew text the trailing apostrophe of "23'" and the leading plus of
// "+01:23" are direction-neutral, so the bidi algorithm moves them to the
// wrong side and the page reads "'23". Isolating the label here — in the
// data, not in CSS — fixes it everywhere it lands: timeline, sheet titles,
// toasts, button labels, aria text.
export const ltr = (s) => `\u2066${s}\u2069`;

// Match minute in the usual football form: the 23rd minute is "23'", and
// time played past a period's length is stoppage — "30+2'" — rather than a
// minute that belongs to the next period.
export function minuteLabel(format, period, atMs, { atStart = false } = {}) {
  if (atStart) return `תחילת ${periodName(format, period)}`;
  const len = (format[period] ?? format.at(-1)) * 60000;
  const base = offsetMin(format, period);
  if (atMs < len) return ltr(`${base + Math.floor(atMs / 60000) + 1}'`);
  return ltr(`${base + format[period]}+${Math.floor((atMs - len) / 60000) + 1}'`);
}

export function clockText(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export const inStoppage = (state, now) =>
  state.status === 'running' && elapsedMs(state, now) >= (state.format[state.period] || 0) * 60000;

/* ── State ─────────────────────────────────────────────────────────────── */

// Calendar date in Israel for a timestamp — from the operation's own time,
// so the reducer stays pure.
export function israelDate(ms) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(ms)).reduce((o, x) => ({ ...o, [x.type]: x.value }), {});
  return `${p.year}-${p.month}-${p.day}`;
}

// `fixture` names the schedule row this match was opened from ({date,
// opponent}); the finished match carries it, and that is what takes the row
// off the schedule even when the match was played on another day.
export function newLive({ id, opponent, home = true, round = null, friendly = false, date, format, size, lineup, players, fixture = null }) {
  const squad = (players || []).map((p) => ({ id: p.id, name: p.name, number: p.number ?? null, pos: p.pos || '', pos2: p.pos2 || '' }));
  return {
    id,
    status: 'setup',          // setup · running · break · fulltime · ended
    opponent: opponent || '',
    home: home !== false,
    round: round ?? null,
    friendly: friendly === true,
    date: date || '',
    format: cleanFormat(format),
    size: cleanSize(size),
    fixture: fixture && fixture.date ? { date: fixture.date, opponent: fixture.opponent || '' } : null,
    period: 0,
    clock: { running: false, startedAt: null, accMs: 0 },
    lineup: (lineup || []).filter((l) => squad.some((p) => p.id === l.pid)).map((l) => ({ pid: l.pid, pos: l.pos || '' })),
    events: [],
    // A snapshot of the squad at kickoff: the live screen renders from this
    // alone, and a player renamed or removed later still reads correctly in
    // this match's history.
    players: squad,
  };
}

/* ── State from the wire ───────────────────────────────────────────────
   The bridge takes live state from any device holding control, and that
   device need not be running this app. The views print numbers and ids
   straight into markup (only text is escaped), so whatever arrives is
   rebuilt field by field with its type forced: a "shirt number" that is a
   string of HTML would otherwise run in every viewer's browser, the
   manager's included. tests/e2e.mjs feeds such a state to every screen. */

const num = (v, d = null) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v) => (v == null ? '' : String(v));
const STATUSES = ['setup', 'running', 'break', 'fulltime', 'ended'];

const cleanPlayers = (list) => (Array.isArray(list) ? list : [])
  .filter((p) => p && p.id != null)
  .map((p) => ({ id: str(p.id), name: str(p.name), number: num(p.number), pos: str(p.pos), pos2: str(p.pos2) }));
const cleanLineup = (list) => (Array.isArray(list) ? list : [])
  .filter((l) => l && l.pid != null)
  .map((l) => ({ pid: str(l.pid), pos: str(l.pos) }));

function cleanEvent(e) {
  const out = { id: str(e.id), type: str(e.type), period: num(e.period, 0), atMs: num(e.atMs, 0) };
  if (e.atStart) out.atStart = true;
  if (e.type === 'goal') {
    out.side = e.side === 'them' ? 'them' : 'us';
    if (out.side === 'us') { out.scorer = e.scorer == null ? null : str(e.scorer); out.assist = e.assist == null ? null : str(e.assist); }
  } else if (e.type === 'sub') {
    out.out = str(e.out); out.in = str(e.in); out.pos = str(e.pos);
  }
  return out;
}
const cleanEvents = (list) => (Array.isArray(list) ? list : []).filter((e) => e && typeof e === 'object').map(cleanEvent);

export function cleanLive(s) {
  if (!s || typeof s !== 'object') return null;
  const clock = s.clock && typeof s.clock === 'object' ? s.clock : {};
  return {
    id: str(s.id),
    status: STATUSES.includes(s.status) ? s.status : 'setup',
    opponent: str(s.opponent), home: s.home !== false, round: num(s.round), friendly: s.friendly === true, date: str(s.date),
    format: cleanFormat(s.format), size: cleanSize(s.size),
    fixture: s.fixture && s.fixture.date ? { date: str(s.fixture.date), opponent: str(s.fixture.opponent) } : null,
    period: num(s.period, 0),
    clock: { running: !!clock.running, startedAt: num(clock.startedAt), accMs: num(clock.accMs, 0) },
    lineup: cleanLineup(s.lineup),
    events: cleanEvents(s.events),
    players: cleanPlayers(s.players),
  };
}

// A played match in the season: a live one carries the same parts, written
// by the bridge from what the controlling device sent. Hand-entered fields
// pass through; only what a controller could have written is retyped.
export function cleanPlayedMatch(m) {
  const out = { ...m, date: str(m.date), opponent: str(m.opponent), round: num(m.round), friendly: m.friendly === true };
  if ('events' in m) out.events = cleanEvents(m.events);
  if ('lineup' in m) out.lineup = cleanLineup(m.lineup);
  if ('players' in m) out.players = cleanPlayers(m.players);
  if ('format' in m) out.format = cleanFormat(m.format);
  if (m.fixture) out.fixture = m.fixture.date ? { date: str(m.fixture.date), opponent: str(m.fixture.opponent) } : null;
  return out;
}

const clone = (o) => JSON.parse(JSON.stringify(o));

function endPeriod(s, at) {
  const atMs = elapsedMs(s, at);
  s.events.push({ id: `end-${s.period}`, type: 'period_end', period: s.period, atMs });
  s.clock = { running: false, startedAt: null, accMs: 0 };
  s.period += 1;
  s.status = s.period >= s.format.length ? 'fulltime' : 'break';
}

// Applies one operation. Unknown or out-of-place operations return the state
// unchanged rather than throwing: a queued action that a newer server state
// has made meaningless (a second "start" for a period already started from
// another phone) must fall away quietly, not wedge the queue.
export function reduce(state, op) {
  const s = clone(state);
  switch (op.t) {
    case 'meta':
      if (s.status !== 'setup') return state;
      for (const k of ['opponent', 'home', 'round', 'date']) if (k in op.patch) s[k] = op.patch[k];
      if ('format' in op.patch) s.format = cleanFormat(op.patch.format);
      if ('size' in op.patch) s.size = cleanSize(op.patch.size);
      return s;
    case 'lineup':
      if (s.status !== 'setup') return state;
      s.lineup = op.lineup.filter((l) => s.players.some((p) => p.id === l.pid)).map((l) => ({ pid: l.pid, pos: l.pos || '' }));
      return s;
    case 'start':
      if (!(s.status === 'setup' || s.status === 'break')) return state;
      // The match is dated by its kick-off, not by the schedule: fixtures
      // move, and a match started from a later fixture happened today.
      if (s.status === 'setup' && op.at) s.date = israelDate(op.at);
      s.status = 'running';
      s.clock = { running: true, startedAt: op.at, accMs: 0 };
      s.events.push({ id: `start-${s.period}`, type: 'period_start', period: s.period, atMs: 0 });
      return s;
    case 'pause':
      if (s.status !== 'running' || !s.clock.running) return state;
      s.clock = { running: false, startedAt: null, accMs: elapsedMs(s, op.at) };
      return s;
    case 'resume':
      if (s.status !== 'running' || s.clock.running) return state;
      s.clock = { running: true, startedAt: op.at, accMs: s.clock.accMs };
      return s;
    case 'adjust': {
      if (s.status !== 'running') return state;
      const now = elapsedMs(s, op.at);
      const target = Math.max(0, now + op.ms);
      s.clock = s.clock.running
        ? { running: true, startedAt: op.at, accMs: target }
        : { running: false, startedAt: null, accMs: target };
      return s;
    }
    case 'end':
      if (s.status !== 'running' || s.period !== op.period) return state;
      endPeriod(s, op.at);
      return s;
    case 'goal':
    case 'sub': {
      if (s.events.some((e) => e.id === op.id)) return state;
      if (!['running', 'break', 'fulltime'].includes(s.status)) return state;
      const e = { id: op.id, type: op.t, period: op.period, atMs: op.atMs };
      if (op.atStart) e.atStart = true;
      if (op.t === 'goal') {
        e.side = op.side === 'them' ? 'them' : 'us';
        if (e.side === 'us') { e.scorer = op.scorer || null; e.assist = op.assist || null; }
      } else {
        if (!op.out || !op.in || op.out === op.in) return state;
        e.out = op.out; e.in = op.in; e.pos = op.pos || '';
      }
      s.events.push(e);
      return s;
    }
    case 'edit': {
      const e = s.events.find((x) => x.id === op.id);
      if (!e || !['goal', 'sub'].includes(e.type)) return state;
      for (const k of ['scorer', 'assist', 'atMs', 'period', 'atStart', 'pos']) if (k in op.patch) e[k] = op.patch[k];
      if (e.atStart === false) delete e.atStart;
      return s;
    }
    case 'del':
      s.events = s.events.filter((e) => e.id !== op.id || !['goal', 'sub'].includes(e.type));
      return s;
    case 'finish':
      if (s.status === 'running') endPeriod(s, op.at);
      if (!['break', 'fulltime'].includes(s.status)) return state;
      s.status = 'ended';
      return s;
    case 'reopen':
      // A mistaken "finish" is recoverable; the result is re-saved on the
      // next finish, replacing the earlier one (the bridge keys it by id).
      if (s.status !== 'ended') return state;
      s.status = s.period >= s.format.length ? 'fulltime' : 'break';
      return s;
    default:
      return state;
  }
}

/* ── Derived ───────────────────────────────────────────────────────────── */

const order = (a, b) => a.period - b.period || a.atMs - b.atMs;

export const playerById = (state, id) => state.players.find((p) => p.id === id) || null;

export function score(state) {
  let us = 0, them = 0;
  for (const e of state.events) if (e.type === 'goal') (e.side === 'them' ? them++ : us++);
  return { us, them };
}

// Who is on the field now: the starting lineup with every substitution
// applied in match order. A sub keeps the slot's position unless it names
// its own.
export function onField(state) {
  const field = new Map(state.lineup.map((l) => [l.pid, l.pos]));
  const subs = state.events.map((e, i) => ({ e, i })).filter(({ e }) => e.type === 'sub')
    .sort((a, b) => order(a.e, b.e) || a.i - b.i);
  for (const { e } of subs) {
    if (!field.has(e.out)) continue;
    const pos = e.pos || field.get(e.out);
    field.delete(e.out);
    field.set(e.in, pos);
  }
  return [...field].map(([pid, pos]) => ({ pid, pos }));
}

export function bench(state) {
  const on = new Set(onField(state).map((f) => f.pid));
  return state.players.filter((p) => !on.has(p.id));
}

// Newest first, for the timeline.
export function timeline(state) {
  return state.events.map((e, i) => ({ e, i }))
    .sort((a, b) => order(b.e, a.e) || b.i - a.i)
    .map(({ e }) => e);
}

// Minutes each player spent on the field, from the lineup, the subs and how
// long each period actually ran (including stoppage). Periods that never
// started count as zero; a period still running counts up to `now`.
export function minutesPlayed(state, now = null) {
  const lengths = state.format.map((_, p) => {
    const end = state.events.find((e) => e.type === 'period_end' && e.period === p);
    if (end) return end.atMs;
    if (state.status === 'running' && state.period === p && now != null) return elapsedMs(state, now);
    return 0;
  });
  const ms = new Map();
  const field = new Map(state.lineup.map((l) => [l.pid, l.pos]));
  const subs = state.events.filter((e) => e.type === 'sub').sort(order);
  let k = 0;
  for (let p = 0; p < state.format.length; p++) {
    const L = lengths[p];
    let cursor = 0;
    // Subs recorded against an earlier period that never got an end time
    // still have to be applied before this one is counted.
    while (k < subs.length && subs[k].period < p) apply(subs[k++]);
    while (k < subs.length && subs[k].period === p) {
      const at = Math.min(Math.max(subs[k].atMs, 0), L);
      credit(at - cursor);
      cursor = at;
      apply(subs[k++]);
    }
    credit(L - cursor);
  }
  const out = {};
  for (const [pid, v] of ms) out[pid] = Math.round(v / 60000);
  return out;

  function credit(d) { if (d > 0) for (const pid of field.keys()) ms.set(pid, (ms.get(pid) || 0) + d); }
  function apply(e) {
    if (!field.has(e.out)) return;
    const pos = e.pos || field.get(e.out);
    field.delete(e.out);
    field.set(e.in, pos);
  }
}

// The event's place on the clock when it is entered: "now" while a period
// runs, or the start of the next period during a break — which is what the
// "period start" option means for a change made at the interval.
export function stampNow(state, now) {
  if (state.status === 'running') return { period: state.period, atMs: elapsedMs(state, now) };
  if (state.status === 'break') return { period: state.period, atMs: 0, atStart: true };
  const last = state.format.length - 1;
  return { period: last, atMs: state.format[last] * 60000 };
}
