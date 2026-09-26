// Everything the UI shows about the season is derived here, from the match
// list alone. Nothing aggregate is stored in season.json on purpose: hand-kept
// totals drift from the fixtures they summarise, and the mockups this app was
// built from already disagreed with themselves that way.

import { cleanPlayedMatch } from './live/model.js';
import { primaryPos, posLabel } from './positions.js';
import { upcomingFixtures, fixtureAsNext } from './fixtures.js';
import { trainingWeek, offersNextWeek } from './trainings.js';

export const OUTCOMES = { win: 'ניצחון', draw: 'תיקו', loss: 'הפסד' };

export function outcomeOf(match) {
  if (match.gf > match.ga) return 'win';
  if (match.gf < match.ga) return 'loss';
  return 'draw';
}

const POINTS = { win: 3, draw: 1, loss: 0 };

function tally(matches) {
  const t = { played: matches.length, win: 0, draw: 0, loss: 0, gf: 0, ga: 0, points: 0, cleanSheets: 0 };
  for (const m of matches) {
    const o = outcomeOf(m);
    t[o]++;
    t.points += POINTS[o];
    t.gf += m.gf;
    t.ga += m.ga;
    if (m.ga === 0) t.cleanSheets++;
  }
  return t;
}

// Longest run of wins anywhere in the season, and the run still open at the
// end of it. Both are reported: "best ever" and "right now" answer different
// questions and a team mid-slump should not see its September peak as current.
function streaks(chronological) {
  let best = 0, run = 0;
  for (const m of chronological) {
    run = outcomeOf(m) === 'win' ? run + 1 : 0;
    if (run > best) best = run;
  }
  let current = 0;
  for (let i = chronological.length - 1; i >= 0 && outcomeOf(chronological[i]) === 'win'; i--) current++;
  return { best, current };
}

const sameDay = (f, nm) => !!nm?.kickoff && String(nm.kickoff).slice(0, 10) === f.date;

// A home game with no venue of its own is at the team's home ground
// (team.homeVenue, set once in the settings). Filled in here, on every load,
// and never written back: change the home ground and every home game follows.
// A venue given for a game wins; away games get nothing.
function withHomeVenue(game, home) {
  if (!game || game.home === false || !(home?.name || home?.address)) return game;
  const v = game.venue || {};
  if (v.name || v.address) return game;
  return { ...game, venue: { ...v, name: home.name || '', address: home.address || '' } };
}

// Opponent crests: { [opponent name]: ref }, a ref being a Drive file id in
// the bridge's posters folder (putLogo, fetched with getPoster). Keyed by
// name, so the crest follows the opponent to the next-match card, the live
// board and a second meeting later in the season. Rebuilt entry by entry:
// the ref lands in an HTML attribute.
export const logoKey = (name) => String(name || '').replace(/\s+/g, ' ').trim();
function cleanLogos(m) {
  const out = {};
  if (m && typeof m === 'object') {
    for (const [k, v] of Object.entries(m)) if (logoKey(k) && /^[\w-]{10,100}$/.test(String(v))) out[logoKey(k)] = String(v);
  }
  return out;
}
export const opponentLogo = (season, name) => season?.opponentLogos?.[logoKey(name)] || null;

function withKickoff(f, nm) {
  const time = String(nm.kickoff || '').slice(11, 16);
  return /^\d\d:\d\d$/.test(time) ? { ...f, time } : f;
}

export function buildSeason(input, now = new Date()) {
  // Every list may be missing or empty: the data file is filled in by hand,
  // often section by section, and a season that has not kicked off yet has
  // no matches at all. None of that should take the page down.
  const raw = {
    ...input,
    team: { name: 'מכבי גבעתיים', ...(input.team ?? {}) },
    matches: (input.matches ?? []).filter(Boolean).map(cleanPlayedMatch),
    fixtures: (input.fixtures ?? []).map((f) => withHomeVenue(f, input.team?.homeVenue)),
    players: input.players ?? [],
    videos: input.videos ?? [],
    links: input.links ?? [],
    trainings: input.trainings ?? [],
    trainingChanges: input.trainingChanges ?? [],
    analysis: { items: [], ...(input.analysis ?? {}) },
    opponentLogos: cleanLogos(input.opponentLogos),
  };
  const chronological = [...raw.matches].sort((a, b) => a.date.localeCompare(b.date));
  const recent = [...chronological].reverse();
  // A training match (friendly) is listed with the results but counts in no
  // figure: not the record, the splits, the streaks, the form or a player's
  // goals. The owner asked for it next to the round numbers; a league table
  // does not count friendlies, and neither does this one.
  const league = chronological.filter((m) => !m.friendly);

  const overall = tally(league);
  const home = tally(league.filter((m) => m.home));
  const away = tally(league.filter((m) => !m.home));

  // A player's totals are the manager's baseline (matches played before live
  // tracking, entered by hand) plus everything recorded in live matches.
  // Playing time is the coach's, and counted in src/minutes.js. The
  // live part is never stored as a number anywhere — it is recounted from the
  // events every time, so deleting a mistaken goal fixes the table with it.
  const fromLive = { goals: {}, assists: {} };
  const bump = (bag, id, n = 1) => { if (id) bag[id] = (bag[id] || 0) + n; };
  for (const m of league) {
    if (!Array.isArray(m.events)) continue;
    for (const e of m.events) {
      if (e.type !== 'goal' || e.side === 'them') continue;
      bump(fromLive.goals, e.scorer);
      bump(fromLive.assists, e.assist);
    }
  }
  const players = [...raw.players].map((p) => {
    const key = p.id || 'n:' + String(p.name || '').trim();
    const goals = (Number(p.goals) || 0) + (fromLive.goals[key] || 0);
    const assists = (Number(p.assists) || 0) + (fromLive.assists[key] || 0);
    const pos = primaryPos(p);
    // Players saved before ids existed get a stable one from their name — the
    // same rule the manager's editor uses when it next saves them — so a live
    // match started before that save still credits the right child.
    const id = p.id || 'n:' + String(p.name || '').trim();
    return { ...p, id, pos, goals, assists, points: goals + assists, posText: posLabel(pos) || p.position || '' };
  });
  const squadGoals = players.reduce((sum, p) => sum + p.goals, 0);
  const friendlyGoals = chronological.filter((m) => m.friendly)
    .reduce((n, m) => n + (m.events || []).filter((e) => e.type === 'goal' && e.side !== 'them' && e.scorer).length, 0);

  // The next match: the one the manager set by hand (with its gathering time
  // and kit), else the first fixture still ahead in the schedule. Derived on
  // every load, so entering a result moves the schedule on by itself.
  const upcoming = upcomingFixtures(raw.fixtures, raw.matches, now);
  const nextMatch = raw.nextMatch?.opponent ? withHomeVenue(raw.nextMatch, raw.team.homeVenue) : fixtureAsNext(upcoming[0]);
  // Game days for the trainings strip: the next match (its kickoff is local
  // Israel time) and every fixture after it.
  const kick = String(nextMatch?.kickoff || '');
  const games = [...(nextMatch ? [{ date: kick.slice(0, 10), time: nextMatch.timeTbd ? '' : kick.slice(11, 16), opponent: nextMatch.opponent }] : []), ...upcoming];

  return {
    ...raw,
    nextMatch,
    // This week's trainings and the week after, each closed by its game
    // (src/trainings.js); the view offers the second from Saturday.
    week: trainingWeek(raw, games, now),
    nextWeek: trainingWeek(raw, games, now, 1),
    offersNextWeek: offersNextWeek(now),
    // Every fixture still ahead, and those after the one the card shows. The
    // fixture on the day of a next match set by hand shows that match's
    // kickoff: the schedule said "time not set" beside a card saying 09:30.
    schedule: raw.nextMatch?.opponent ? upcoming.map((f) => (sameDay(f, raw.nextMatch) ? withKickoff(f, raw.nextMatch) : f)) : upcoming,
    upcoming: raw.nextMatch?.opponent ? upcoming.filter((f) => !sameDay(f, raw.nextMatch)) : upcoming.slice(1),
    chronological,
    recent,
    // The latest league results, newest first: the form pills.
    form: [...league].reverse(),
    overall: {
      ...overall,
      // Points taken out of points available (3 per match): the figure a
      // league table ranks by, where a draw counts for something.
      maxPoints: overall.played * 3,
      pointsRate: overall.played ? overall.points / (overall.played * 3) : 0,
      goalsPerGame: overall.played ? overall.gf / overall.played : 0,
      concededPerGame: overall.played ? overall.ga / overall.played : 0,
      streak: streaks(league),
    },
    splits: { home, away },
    players,
    // A player tally that does not add up to the team's goals means someone is
    // missing from the squad list, so the UI can say so instead of quietly
    // showing a share of the wrong whole.
    squadGoals,
    squadGoalsMatch: squadGoals === overall.gf,
    // What an empty scorers list says. After a first match that was a
    // friendly, "no goals yet" contradicts the goal everyone just watched.
    emptyScorers: friendlyGoals ? 'שערים ממשחקי אימון לא נספרים בטבלה.'
      : overall.gf ? 'עוד לא שויכו שערים לשחקנים.' : 'טרם נרשמו שערים העונה.',
  };
}

export function topBy(players, key, limit = 5) {
  return [...players]
    .filter((p) => p[key] > 0)
    .sort((a, b) => b[key] - a[key] || b.goals - a.goals || a.name.localeCompare(b.name, 'he'))
    .slice(0, limit);
}
