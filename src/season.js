// Everything the UI shows about the season is derived here, from the match
// list alone. Nothing aggregate is stored in season.json on purpose: hand-kept
// totals drift from the fixtures they summarise, and the mockups this app was
// built from already disagreed with themselves that way.

import { minutesPlayed } from './live/model.js';
import { primaryPos, posLabel } from './positions.js';

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

export function buildSeason(input) {
  // Every list may be missing or empty: the data file is filled in by hand,
  // often section by section, and a season that has not kicked off yet has
  // no matches at all. None of that should take the page down.
  const raw = {
    ...input,
    team: { name: 'מכבי גבעתיים', ...(input.team ?? {}) },
    matches: input.matches ?? [],
    players: input.players ?? [],
    videos: input.videos ?? [],
    links: input.links ?? [],
    analysis: { items: [], ...(input.analysis ?? {}) },
  };
  const chronological = [...raw.matches].sort((a, b) => a.date.localeCompare(b.date));
  const recent = [...chronological].reverse();

  const overall = tally(chronological);
  const home = tally(chronological.filter((m) => m.home));
  const away = tally(chronological.filter((m) => !m.home));

  // A player's totals are the manager's baseline (matches played before live
  // tracking, entered by hand) plus everything recorded in live matches. The
  // live part is never stored as a number anywhere — it is recounted from the
  // events every time, so deleting a mistaken goal fixes the table with it.
  const fromLive = { goals: {}, assists: {}, minutes: {} };
  const bump = (bag, id, n = 1) => { if (id) bag[id] = (bag[id] || 0) + n; };
  for (const m of chronological) {
    if (!Array.isArray(m.events)) continue;
    for (const e of m.events) {
      if (e.type !== 'goal' || e.side === 'them') continue;
      bump(fromLive.goals, e.scorer);
      bump(fromLive.assists, e.assist);
    }
    if (Array.isArray(m.lineup) && Array.isArray(m.format)) {
      const mins = minutesPlayed({ format: m.format, events: m.events, lineup: m.lineup, status: 'ended' });
      for (const [id, n] of Object.entries(mins)) bump(fromLive.minutes, id, n);
    }
  }
  const players = [...raw.players].map((p) => {
    const key = p.id || 'n:' + String(p.name || '').trim();
    const goals = (Number(p.goals) || 0) + (fromLive.goals[key] || 0);
    const assists = (Number(p.assists) || 0) + (fromLive.assists[key] || 0);
    const minutes = (Number(p.minutes) || 0) + (fromLive.minutes[key] || 0);
    const pos = primaryPos(p);
    // Players saved before ids existed get a stable one from their name — the
    // same rule the manager's editor uses when it next saves them — so a live
    // match started before that save still credits the right child.
    const id = p.id || 'n:' + String(p.name || '').trim();
    return { ...p, id, pos, goals, assists, minutes, points: goals + assists, posText: posLabel(pos) || p.position || '' };
  });
  const squadGoals = players.reduce((sum, p) => sum + p.goals, 0);

  return {
    ...raw,
    chronological,
    recent,
    overall: {
      ...overall,
      // Points taken out of points available (3 per match): the figure a
      // league table ranks by, where a draw counts for something.
      maxPoints: overall.played * 3,
      pointsRate: overall.played ? overall.points / (overall.played * 3) : 0,
      goalsPerGame: overall.played ? overall.gf / overall.played : 0,
      concededPerGame: overall.played ? overall.ga / overall.played : 0,
      streak: streaks(chronological),
    },
    splits: { home, away },
    players,
    // A player tally that does not add up to the team's goals means someone is
    // missing from the squad list, so the UI can say so instead of quietly
    // showing a share of the wrong whole.
    squadGoals,
    squadGoalsMatch: squadGoals === overall.gf,
  };
}

export function topBy(players, key, limit = 5) {
  return [...players]
    .filter((p) => p[key] > 0)
    .sort((a, b) => b[key] - a[key] || b.goals - a.goals || a.name.localeCompare(b.name, 'he'))
    .slice(0, limit);
}
