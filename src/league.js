// The league table and every game of the league, from the daily file of the
// league's site (the bridge parses it, see parseLeague_ in tools/bridge.gs).
// Pure: names, the match between our opponents' names and the league's, and
// one team's figures and games. Nothing here is stored: the season keeps only
// the manager's corrections of a name (leagueNames).
import { logoKey } from './season.js';

// The league's names carry the age group's sponsor and the district: "הפ'
// ניר רמת השרון צפון "צו פיוס"". On a phone the table shows the rest.
export function shortTeam(name) {
  return String(name || '')
    .replace(/[״]/g, '"').replace(/[׳]/g, "'")
    .replace(/["']?\s*צו\s+פיוס\s*["']?/g, ' ')
    .replace(/(^|\s)צפון(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ').trim() || String(name || '');
}

// Abbreviations as both sides write them, opened to words.
const EXPAND = [
  [/(^|\s)הפ'(?=\s|$)/g, ' הפועל '], [/(^|\s)ה\.?מ\.?(?=\s|$)/g, ' הפועל מכבי '], [/(^|\s)מ\.?כ\.?(?=\s|$)/g, ' מכבי '],
  [/(^|\s)מ\.?ס\.?(?=\s|$)/g, ' '], [/(^|\s)ר"ג(?=\s|$)/g, ' רמת גן '], [/(^|\s)ת"א(?=\s|$)/g, ' תל אביב '],
  [/(^|\s)רמה"ש(?=\s|$)/g, ' רמת השרון '], [/(^|\s)פ"ת(?=\s|$)/g, ' פתח תקווה '], [/(^|\s)ר"צ(?=\s|$)/g, ' ראשון לציון '],
  [/(^|\s)ק\.(?=\s)/g, ' קרית '],
];
// The club's own word: two names with one each and none in common are two
// clubs, however alike the town ("הפועל תל אביב" is not "שמשון ת"א").
const CLUBS = new Set(['הפועל', 'מכבי', 'ביתר', 'הכח', 'שמשון', 'אליצור', 'הכוח']);
// Words that tell no team from another.
const GENERIC = new Set(['עירוני', 'מועדון', 'ספורט', 'צפון', 'דרום', 'מזרח', 'מערב', 'קבוצת', 'צו', 'פיוס', 'בני', 'הכדורגל', 'כדורגל']);

function words(name) {
  let t = ' ' + String(name || '').replace(/[״]/g, '"').replace(/[׳]/g, "'") + ' ';
  t = t.replace(/["']?\s*צו\s+פיוס\s*["']?/g, ' ');
  for (const [re, to] of EXPAND) t = t.replace(re, to);
  // A gershayim inside a word is part of it (בית"ר); anywhere else, a break.
  const all = t.replace(/([א-ת])["']([א-ת])/g, '$1$2').replace(/["'.()\-–,]/g, ' ').replace(/וו/g, 'ו').replace(/יי/g, 'י').split(/\s+/).filter(Boolean);
  return {
    clubs: all.filter((w) => CLUBS.has(w)),
    tokens: all.filter((w) => !CLUBS.has(w) && !GENERIC.has(w) && (w.length > 1 || /^\d+$/.test(w))),
  };
}
export const nameTokens = (name) => words(name).tokens;

// One letter apart, or one a start of the other: "תקוה"/"תקווה" (already
// folded), "אורתודוקסים"/"אורתודוכסים", "קריית"/"קרית".
function near(a, b) {
  if (a === b) return true;
  if (/^\d/.test(a) || /^\d/.test(b)) return false;
  if (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a)) && Math.abs(a.length - b.length) <= 2) return true;
  if (a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

// How alike two names are, 0–1: the share of telling words they have in common.
export function likeness(a, b) {
  const A = words(a), B = words(b);
  if (A.clubs.length && B.clubs.length && !A.clubs.some((c) => B.clubs.includes(c))) return 0;
  const x = A.tokens, y = [...B.tokens];
  if (!x.length || !y.length) return 0;
  let common = 0;
  for (const w of x) {
    const k = y.findIndex((v) => near(w, v));
    if (k >= 0) { common++; y.splice(k, 1); }
  }
  return (2 * common) / (x.length + B.tokens.length);
}

// The league team an opponent's name means, or null: not guessed when no name
// is alike enough, or when two are about as alike (the manager picks then).
export function matchTeam(name, teams) {
  const scored = teams.map((t) => ({ t, v: likeness(name, t) })).sort((a, b) => b.v - a.v);
  const [best, second] = scored;
  if (!best || best.v < 0.5) return null;
  if (second && best.v - second.v < 0.15) return null;
  return best.t;
}

// The league team for one of our opponents: the manager's pick first ('-' is
// "not in the league": a friendly against another league's team), then the
// match by name. Never ourselves.
export function leagueTeamFor(s, opponent) {
  const lg = s?.league;
  if (!lg || !opponent) return null;
  const teams = lg.table.map((r) => r.team).filter((t) => t !== lg.team);
  const pick = s.leagueNames?.[logoKey(opponent)];
  if (pick === '-') return null;
  if (pick && teams.includes(pick)) return pick;
  return matchTeam(opponent, teams);
}

// The opponent names the manager deals with: the schedule's and the results'.
export function opponentNames(s) {
  const seen = new Map();
  for (const x of [...(s.schedule || []), ...(s.recent || [])]) {
    const k = logoKey(x.opponent);
    if (k && !seen.has(k)) seen.set(k, x.opponent);
  }
  return [...seen.values()];
}

const RESULT = { W: 'נ', D: 'ת', L: 'ה' };
export const resultLetter = (r) => RESULT[r] || '';

// One team as the league has it: its row, and its games from its own side —
// played newest first, the rest soonest first — and its games against us.
export function teamView(lg, team) {
  if (!lg || !team) return null;
  const row = lg.table.find((r) => r.team === team);
  if (!row) return null;
  const games = lg.games.filter((g) => g.home === team || g.away === team).map((g) => {
    const home = g.home === team;
    const played = g.hg != null && g.ag != null;
    const gf = played ? (home ? g.hg : g.ag) : null, ga = played ? (home ? g.ag : g.hg) : null;
    return {
      round: g.round, date: g.date, time: g.time, home, opp: home ? g.away : g.home, played, gf, ga,
      res: played ? (gf > ga ? 'W' : gf < ga ? 'L' : 'D') : null,
    };
  });
  const played = games.filter((g) => g.played).sort((a, b) => b.date.localeCompare(a.date) || (b.round ?? 0) - (a.round ?? 0));
  const ahead = games.filter((g) => !g.played).sort((a, b) => a.date.localeCompare(b.date) || (a.round ?? 0) - (b.round ?? 0));
  return { row, us: team === lg.team, played, ahead, vsUs: team === lg.team ? [] : games.filter((g) => g.opp === lg.team).sort((a, b) => a.date.localeCompare(b.date)) };
}

// The round the table stands after: the highest round with a result.
export function lastRound(lg) {
  return lg?.games.reduce((m, g) => (g.hg != null && g.round > m ? g.round : m), 0) || null;
}
