// Playing time, for the coach. Nothing here is stored: every figure is
// recounted from the lineup and the substitutions of each live match, with
// the coach's two facts per match (the minimum and who was absent) from the
// bridge's coach data. The tool informs — it never suggests who should come
// on — so it only ever marks a shortfall, never a player who played a lot.

import * as M from './live/model.js';

export const DEFAULT_MIN = 20;
const MAX_MIN = 200;

// Number(null) is 0: an unset minimum must stay unset, or cleaning the data
// twice would set it to zero and no one would ever be short.
const int = (v, lo, hi) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};

// The coach data as the bridge sends it, rebuilt field by field: it is
// written by a device, and the views trust what comes out of here.
export function cleanCoach(raw) {
  const out = { minDefault: DEFAULT_MIN, matches: {} };
  if (!raw || typeof raw !== 'object') return out;
  out.minDefault = int(raw.minDefault, 0, MAX_MIN) ?? DEFAULT_MIN;
  const ms = raw.matches && typeof raw.matches === 'object' && !Array.isArray(raw.matches) ? raw.matches : {};
  for (const [id, e] of Object.entries(ms)) {
    if (!e || typeof e !== 'object') continue;
    out.matches[id] = {
      min: int(e.min, 0, MAX_MIN),
      absent: Array.isArray(e.absent) ? e.absent.filter((x) => typeof x === 'string') : [],
    };
  }
  return out;
}

// The minimum and the absentees of one match. A match the coach never set
// a minimum for runs on the current default.
export function coachFor(coach, liveId) {
  const c = cleanCoach(coach);
  const e = c.matches[liveId] || {};
  return { min: e.min ?? c.minDefault, absent: new Set(e.absent || []) };
}

// Everyone who took part counts as present, whatever the attendance says:
// a child who started or came on was plainly there.
function appeared(state) {
  const ids = new Set(state.lineup.map((l) => l.pid));
  for (const e of state.events) if (e.type === 'sub' && e.in) ids.add(e.in);
  return ids;
}

export function presentPlayers(state, absent) {
  const took = appeared(state);
  return state.players.filter((p) => took.has(p.id) || !absent.has(p.id));
}

const offsetMin = (format, period) => format.slice(0, period).reduce((a, b) => a + b, 0);

// The minute on the match clock a player on the field now reaches the
// minimum, as the scoreboard would print it.
function reachMinute(state, now, missing) {
  const inRunning = state.status === 'running';
  const period = state.period;
  const at = (inRunning ? M.elapsedMs(state, now) : 0) + missing * 60000;
  return M.ltr(`${offsetMin(state.format, period) + Math.ceil(at / 60000)}'`);
}

// One row per player present: minutes so far, on the field or not, and
// whether they are short of the minimum. Fewest minutes first.
// A player off the field who played: when, as match-clock minutes —
// [[30, 42]] reads "played 30'–42'". Stoppage folds into the period's end.
function ranges(format, list) {
  const at = (p, ms) => offsetMin(format, p) + Math.round(Math.min(ms, format[p] * 60000) / 60000);
  return (list || []).map((s) => [at(s.p, s.from), at(s.toP, s.to)]);
}

export function liveRows(state, now, { min, absent }) {
  const mins = M.minutesPlayed(state, now);
  const field = new Set(M.onField(state).map((f) => f.pid));
  const started = state.status !== 'setup';
  const spans = started ? stints(state) : new Map();
  return presentPlayers(state, absent).map((p) => {
    const minutes = mins[p.id] || 0;
    const on = started && field.has(p.id);
    const short = minutes < min;
    const row = { id: p.id, name: p.name, number: p.number, minutes, on, short };
    if (short && on && ['running', 'break'].includes(state.status)) row.reachAt = reachMinute(state, now, min - minutes);
    if (!on && minutes > 0) row.ranges = ranges(state.format, spans.get(p.id));
    return row;
  }).sort((a, b) => a.minutes - b.minutes || (a.number ?? 999) - (b.number ?? 999) || a.name.localeCompare(b.name, 'he'));
}

// The one alert: at the break before the last period, the players on the
// bench still short of the minimum, with the latest minute each can come on
// and still reach it. A player on the field reaches it by staying there, so
// is left out. No break before the last period (a single-period match) —
// no alert.
export function shortfall(state, { min, absent }) {
  if (!state || state.status !== 'break' || state.format.length < 2 || state.period !== state.format.length - 1) return [];
  const last = state.format[state.period];
  const base = offsetMin(state.format, state.period);
  return liveRows(state, null, { min, absent })
    .filter((r) => r.short && !r.on)
    .map((r) => {
      const missing = min - r.minutes;
      return { ...r, missing, cannot: missing > last, latest: M.ltr(`${base + last - missing}'`) };
    });
}

export const alertKey = (state) => `${state.id}:${state.period}`;

// When each player was on the field, per period, in ms from that period's
// start — for drawing a match as a bar. Mirrors minutesPlayed.
export function stints(state) {
  const lengths = state.format.map((_, p) => {
    const end = state.events.find((e) => e.type === 'period_end' && e.period === p);
    return end ? end.atMs : 0;
  });
  const open = new Map(state.lineup.map((l) => [l.pid, { p: 0, from: 0 }]));
  const out = new Map();
  const close = (pid, p, to) => {
    const s = open.get(pid);
    if (!s) return;
    open.delete(pid);
    if (to > s.from || p > s.p) (out.get(pid) || out.set(pid, []).get(pid)).push({ p: s.p, from: s.from, toP: p, to });
  };
  const subs = state.events.filter((e) => e.type === 'sub').sort((a, b) => a.period - b.period || a.atMs - b.atMs);
  for (const e of subs) {
    if (!open.has(e.out)) continue;
    const at = Math.min(Math.max(e.atMs, 0), lengths[e.period] || e.atMs);
    close(e.out, e.period, at);
    open.set(e.in, { p: e.period, from: at });
  }
  const lastP = state.format.length - 1;
  for (const pid of [...open.keys()]) close(pid, lastP, lengths[lastP]);
  return out;
}

// A stint as a share of the whole scheduled match, for a bar: [start, width]
// in 0..1. Stoppage time is folded into the end of its period.
export function stintSpans(format, list) {
  const total = format.reduce((a, b) => a + b, 0) * 60000 || 1;
  const pos = (p, ms) => (offsetMin(format, p) * 60000 + Math.min(ms, format[p] * 60000)) / total;
  return (list || []).map((s) => {
    const a = pos(s.p, s.from), b = pos(s.toP, s.to);
    return [a, Math.max(0, b - a)];
  });
}

// The season: every live match played, oldest first, and for each player on
// the roster how many of them they attended, the minutes they played, their
// average over the matches they attended, and how often they ended under
// that match's minimum.
export function seasonMinutes(season, coach) {
  const matches = season.chronological
    .filter((m) => m.liveId && Array.isArray(m.lineup) && Array.isArray(m.format) && Array.isArray(m.events))
    .map((m) => {
      const state = { format: m.format, events: m.events, lineup: m.lineup, players: m.players || [], status: 'ended' };
      const cfg = coachFor(coach, m.liveId);
      const mins = M.minutesPlayed(state);
      const present = new Set(presentPlayers(state, cfg.absent).map((p) => p.id));
      const squad = new Set(state.players.map((p) => p.id));
      const started = new Set(m.lineup.map((l) => l.pid));
      const spans = stints(state);
      const cells = {};
      for (const pid of squad) {
        cells[pid] = present.has(pid)
          ? { minutes: mins[pid] || 0, short: (mins[pid] || 0) < cfg.min, started: started.has(pid), spans: stintSpans(m.format, spans.get(pid)) }
          : { absent: true };
      }
      return { match: m, min: cfg.min, cells };
    });

  const players = season.players.map((p) => {
    let games = 0, total = 0, below = 0, starts = 0;
    for (const x of matches) {
      const c = x.cells[p.id];
      if (!c || c.absent) continue;
      games++; total += c.minutes;
      if (c.short) below++;
      if (c.started) starts++;
    }
    return { id: p.id, name: p.name, number: p.number ?? null, pos: p.pos || '', pos2: p.pos2 || '', posText: p.posText || '', games, total, below, starts, avg: games ? total / games : 0 };
  });
  players.sort((a, b) => (a.games ? 0 : 1) - (b.games ? 0 : 1) || a.avg - b.avg || (a.number ?? 999) - (b.number ?? 999));
  return {
    matches,
    players,
    belowTotal: players.reduce((n, p) => n + p.below, 0),
    playersBelow: players.filter((p) => p.below).length,
  };
}
