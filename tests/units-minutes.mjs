// Playing time for the coach (src/minutes.js). Run through tests/units.mjs.
import assert from 'node:assert/strict';
import * as M from '../src/live/model.js';
import * as MN from '../src/minutes.js';

const P = (id, number) => ({ id, name: 'שחקן ' + id, number, pos: '' });
const squad = [P('g', 1), P('a', 7), P('b', 10), P('c', 9), P('d', 12), P('e', 14)];
const MIN = 60000;
const T0 = 1_000_000;
const bare = (s) => s.replace(/[⁦⁩]/g, '');

// A 30/30/20 match with four starters, played to the break before the last
// third: d came on for a at 20' and went off again for e at 50'.
function toLastBreak(format = [30, 30, 20]) {
  let s = M.newLive({ id: 'L1', opponent: 'בני לוד', format, players: squad });
  s = M.reduce(s, { t: 'lineup', lineup: ['g', 'a', 'b', 'c'].map((pid) => ({ pid, pos: '' })) });
  let t = T0;
  for (let p = 0; p < format.length - 1; p++) {
    s = M.reduce(s, { t: 'start', at: t });
    if (p === 0) s = M.reduce(s, { t: 'sub', id: 's1', out: 'a', in: 'd', period: 0, atMs: 20 * MIN });
    if (p === 1 && format.length > 2) s = M.reduce(s, { t: 'sub', id: 's2', out: 'd', in: 'e', period: 1, atMs: 20 * MIN });
    t += format[p] * MIN;
    s = M.reduce(s, { t: 'end', period: p, at: t });
  }
  return s;
}

export async function run(test) {
  console.log('minutes:');

  await test('coach data is rebuilt field by field, with 20 as the default minimum', () => {
    assert.deepEqual(MN.cleanCoach(null), { minDefault: 20, matches: {} });
    const c = MN.cleanCoach({ minDefault: '<b>', matches: { X: { min: 2.5, absent: ['a', 7, { x: 1 }] }, Y: 'junk' } });
    assert.deepEqual(c, { minDefault: 20, matches: { X: { min: null, absent: ['a'] } } });
    const cfg = MN.coachFor({ minDefault: 25, matches: { X: { absent: ['a'] } } }, 'X');
    assert.equal(cfg.min, 25, 'a match without its own minimum takes the default');
    assert.deepEqual(MN.cleanCoach(MN.cleanCoach(c)), c, 'cleaning twice changes nothing');
    assert.equal(MN.coachFor(MN.cleanCoach({ matches: { X: { absent: [] } } }), 'X').min, 20, 'an unset minimum is not zero');
    assert.ok(cfg.absent.has('a'));
  });

  await test('at the break before the last third, only benched players short of the minimum are flagged', () => {
    const s = toLastBreak();
    // g, b, c: 60'. a: 20'. d: 30'. e: 10' and on the field. Absent: none.
    const rows = MN.shortfall(s, { min: 20, absent: new Set() });
    assert.deepEqual(rows.map((r) => r.id), [], 'e is short but on the field: staying there gets them over');
    const r25 = MN.shortfall(s, { min: 25, absent: new Set() });
    assert.deepEqual(r25.map((r) => [r.id, r.minutes, r.missing]), [['a', 20, 5]]);
    assert.equal(bare(r25[0].latest), "75'", 'on by 75\' to reach 25\' in a third that ends at 80\'');
    const live = MN.liveRows(s, null, { min: 25, absent: new Set() });
    const e = live.find((r) => r.id === 'e');
    assert.equal(e.on, true);
    assert.equal(bare(e.reachAt), "75'", 'e (10\', on the field) reaches 25\' at 75\'');
    const by = Object.fromEntries(live.map((r) => [r.id, r]));
    assert.deepEqual(by.a.ranges, [[0, 20]], 'a started and went off at 20\'');
    assert.deepEqual(by.d.ranges, [[20, 50]], 'd came on at 20\' and off at 50\'');
    assert.equal(e.ranges, undefined, 'no range for a player still on the field');
  });

  await test('a player who can no longer reach the minimum says so', () => {
    const s = toLastBreak();
    const [r] = MN.shortfall(s, { min: 45, absent: new Set(['d']) }).filter((x) => x.id === 'a');
    assert.equal(r.missing, 25);
    assert.equal(r.cannot, true);
  });

  await test('an absent player is left out; one who played is present whatever the attendance says', () => {
    const s = toLastBreak();
    const ids = MN.liveRows(s, null, { min: 20, absent: new Set(['a', 'e']) }).map((r) => r.id);
    assert.ok(ids.includes('a') && ids.includes('e'), 'both played');
    const noShow = M.newLive({ id: 'L2', opponent: 'x', format: [30, 30, 20], players: squad });
    assert.deepEqual(MN.liveRows(noShow, null, { min: 20, absent: new Set(['a']) }).map((r) => r.id).includes('a'), false);
  });

  await test('no alert outside the last break, and none in a single-period match', () => {
    const s = toLastBreak();
    const cfg = { min: 90, absent: new Set() };
    assert.ok(MN.shortfall(s, cfg).length > 0);
    assert.equal(MN.shortfall(M.reduce(s, { t: 'start', at: T0 + 99 * MIN }), cfg).length, 0, 'the last third is running');
    let first = M.reduce(M.newLive({ id: 'L3', opponent: 'x', format: [30, 30, 20], players: squad }), { t: 'lineup', lineup: [{ pid: 'g', pos: '' }] });
    first = M.reduce(M.reduce(first, { t: 'start', at: T0 }), { t: 'end', period: 0, at: T0 + 30 * MIN });
    assert.equal(first.status, 'break');
    assert.equal(MN.shortfall(first, cfg).length, 0, 'the break after the first third is not the last one');
    let one = M.reduce(M.newLive({ id: 'L4', opponent: 'x', format: [40], players: squad }), { t: 'lineup', lineup: [{ pid: 'g', pos: '' }] });
    one = M.reduce(M.reduce(one, { t: 'start', at: T0 }), { t: 'end', period: 0, at: T0 + 40 * MIN });
    assert.equal(MN.shortfall(one, cfg).length, 0);
  });

  await test('two halves: the alert comes at half time', () => {
    const s = toLastBreak([25, 25]);
    assert.equal(s.status, 'break');
    const rows = MN.shortfall(s, { min: 20, absent: new Set() });
    // a: 20' and not short; d: 5' but on the field; e: never on.
    assert.deepEqual(rows.map((r) => [r.id, r.minutes]), [['e', 0]]);
    assert.equal(bare(rows[0].latest), "30'");
  });

  await test('stints add up to the minutes played', () => {
    let s = toLastBreak();
    s = M.reduce(s, { t: 'start', at: T0 + 100 * MIN });
    s = M.reduce(s, { t: 'end', period: 2, at: T0 + 121 * MIN });
    const mins = M.minutesPlayed(s);
    for (const [pid, list] of MN.stints(s)) {
      const ms = list.reduce((n, x) => {
        let t = 0;
        for (let p = x.p; p <= x.toP; p++) {
          const len = s.events.find((e) => e.type === 'period_end' && e.period === p).atMs;
          t += (p === x.toP ? x.to : len) - (p === x.p ? x.from : 0);
        }
        return n + t;
      }, 0);
      assert.equal(Math.round(ms / MIN), mins[pid], pid);
    }
    const spans = MN.stintSpans(s.format, MN.stints(s).get('d'));
    assert.deepEqual(spans.map(([a, w]) => [a.toFixed(3), w.toFixed(3)]), [['0.250', '0.375']]);
  });

  await test('the season: attended, total, average and times under that match\'s minimum', () => {
    let s = toLastBreak();
    s = M.reduce(s, { t: 'start', at: T0 + 100 * MIN });
    s = M.reduce(s, { t: 'end', period: 2, at: T0 + 120 * MIN });
    const match = (liveId, date) => ({ liveId, date, format: s.format, lineup: s.lineup, events: s.events, players: s.players });
    const season = { chronological: [match('A', '2026-09-01'), match('B', '2026-09-08'), { date: '2026-09-15', gf: 1, ga: 0 }], players: squad };
    const coach = { minDefault: 30, matches: { A: { min: 20, absent: ['b'] } } };
    const r = MN.seasonMinutes(season, coach);
    assert.equal(r.matches.length, 2, 'a result typed in by hand has no minutes');
    const by = Object.fromEntries(r.players.map((p) => [p.id, p]));
    assert.deepEqual([by.a.games, by.a.total, by.a.below], [2, 40, 1], 'a: 20\' twice, under 30 in B only');
    assert.deepEqual([by.b.games, by.b.total, by.b.avg], [2, 160, 80], 'b played in A — present whatever the attendance says');
    assert.deepEqual([by.e.games, by.e.total, by.e.below], [2, 60, 0], 'e: 30\' a match (on at 50\')');
    assert.equal(r.matches[0].cells.a.short, false);
    assert.equal(r.matches[1].cells.a.short, true);
    assert.deepEqual(r.players.map((p) => p.id), ['a', 'd', 'e', 'g', 'c', 'b'], 'fewest average minutes first, then by number');
  });

  await test('an absent player gets no match and no zero', () => {
    const s = M.newLive({ id: 'Z', opponent: 'x', format: [30, 30, 20], players: squad });
    const m = { liveId: 'Z', date: '2026-09-01', format: s.format, lineup: [{ pid: 'g', pos: '' }], events: [], players: squad };
    const r = MN.seasonMinutes({ chronological: [m], players: squad }, { matches: { Z: { absent: ['a'] } } });
    const a = r.players.find((p) => p.id === 'a');
    assert.deepEqual([a.games, a.below], [0, 0]);
    assert.equal(r.matches[0].cells.a.absent, true);
    assert.equal(r.players.find((p) => p.id === 'b').below, 1, 'b came and did not play');
  });
}
