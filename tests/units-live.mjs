// The live-match model. Run through tests/units.mjs.
import assert from 'node:assert/strict';
import * as M from '../src/live/model.js';
import { subGroups } from '../src/positions.js';

const P = (id, number, pos, pos2 = '') => ({ id, name: 'שחקן ' + id, number, pos, pos2 });
const squad = [P('g', 1, 'GK'), P('a', 7, 'LB', 'LW'), P('b', 10, 'AM', 'CM'), P('c', 9, 'ST'), P('d', 12, 'LW', 'LB'), P('e', 14, 'CB', 'DM')];
const MIN = 60000;

export async function run(test) {
  console.log('live model:');
  const base = () => M.reduce(
    M.newLive({ id: 'L1', opponent: 'בני לוד', format: [30, 30, 20], players: squad }),
    { t: 'lineup', lineup: [{ pid: 'g', pos: 'GK' }, { pid: 'a', pos: 'LB' }, { pid: 'b', pos: 'AM' }, { pid: 'c', pos: 'ST' }] });
  const T0 = 1_000_000;

  await test('minute labels are wrapped in directional isolates', () => {
    assert.equal(M.minuteLabel([30], 0, 0), "\u20661'\u2069");
  });

  await test('minute labels count across periods and mark stoppage', () => {
    const f = [30, 30, 20];
    const bare = (fn) => (...a) => fn(...a).replace(/[\u2066\u2069]/g, '');
    const minuteLabel = bare(M.minuteLabel);
    const M_ = { minuteLabel };
    assert.equal(minuteLabel(f, 0, 0), "1'");
    assert.equal(minuteLabel(f, 0, 22 * MIN + 5000), "23'");
    assert.equal(minuteLabel(f, 0, 30 * MIN + 1000), "30+1'");
    assert.equal(minuteLabel(f, 1, 5 * MIN), "36'");
    assert.equal(minuteLabel(f, 2, 21 * MIN), "80+2'");
    assert.equal(minuteLabel(f, 1, 0, { atStart: true }), 'תחילת שליש 2');
    assert.equal(minuteLabel([25, 25], 1, 0, { atStart: true }), 'תחילת מחצית 2');
  });

  await test('the clock runs, pauses, resumes and keeps counting into stoppage', () => {
    let s = M.reduce(base(), { t: 'start', at: T0 });
    assert.equal(M.elapsedMs(s, T0 + 10 * MIN), 10 * MIN);
    s = M.reduce(s, { t: 'pause', at: T0 + 10 * MIN });
    assert.equal(M.elapsedMs(s, T0 + 99 * MIN), 10 * MIN);
    s = M.reduce(s, { t: 'resume', at: T0 + 12 * MIN });
    assert.equal(M.elapsedMs(s, T0 + 34 * MIN), 32 * MIN);
    assert.equal(M.inStoppage(s, T0 + 34 * MIN), true);
  });

  await test('a clock correction moves time without stopping it', () => {
    let s = M.reduce(base(), { t: 'start', at: T0 });
    s = M.reduce(s, { t: 'adjust', ms: 60000, at: T0 + 5 * MIN });
    assert.equal(M.elapsedMs(s, T0 + 5 * MIN), 6 * MIN);
    assert.equal(M.elapsedMs(s, T0 + 6 * MIN), 7 * MIN);
    s = M.reduce(s, { t: 'adjust', ms: -99 * MIN, at: T0 + 6 * MIN });
    assert.equal(M.elapsedMs(s, T0 + 6 * MIN), 0);
  });

  await test('ending periods walks break → next period → fulltime', () => {
    let s = M.reduce(base(), { t: 'start', at: T0 });
    s = M.reduce(s, { t: 'end', period: 0, at: T0 + 31 * MIN });
    assert.equal(s.status, 'break'); assert.equal(s.period, 1);
    s = M.reduce(s, { t: 'start', at: T0 + 40 * MIN });
    s = M.reduce(s, { t: 'end', period: 1, at: T0 + 70 * MIN });
    s = M.reduce(s, { t: 'start', at: T0 + 75 * MIN });
    s = M.reduce(s, { t: 'end', period: 2, at: T0 + 96 * MIN });
    assert.equal(s.status, 'fulltime');
    s = M.reduce(s, { t: 'finish', at: T0 + 97 * MIN });
    assert.equal(s.status, 'ended');
  });

  await test('a replayed "end" for a period already ended is ignored', () => {
    let s = M.reduce(base(), { t: 'start', at: T0 });
    s = M.reduce(s, { t: 'end', period: 0, at: T0 + 30 * MIN });
    const again = M.reduce(s, { t: 'end', period: 0, at: T0 + 31 * MIN });
    assert.equal(again, s);
  });

  await test('score counts our goals and theirs; a goal id is only applied once', () => {
    let s = M.reduce(base(), { t: 'start', at: T0 });
    const g = { t: 'goal', id: 'e1', side: 'us', scorer: 'c', assist: 'b', period: 0, atMs: 5 * MIN };
    s = M.reduce(s, g);
    s = M.reduce(s, g);
    s = M.reduce(s, { t: 'goal', id: 'e2', side: 'them', period: 0, atMs: 9 * MIN });
    assert.deepEqual(M.score(s), { us: 1, them: 1 });
    assert.equal(s.events.find((e) => e.id === 'e2').scorer, undefined);
  });

  await test('penalties: a goal from the spot is marked, a miss is shown and never scored', () => {
    let s = M.reduce(base(), { t: 'start', at: T0 });
    s = M.reduce(s, { t: 'goal', id: 'p1', side: 'us', scorer: 'c', assist: 'b', pen: true, period: 0, atMs: 5 * MIN });
    s = M.reduce(s, { t: 'miss', id: 'm1', side: 'us', scorer: 'b', period: 0, atMs: 7 * MIN });
    s = M.reduce(s, { t: 'goal', id: 'p2', side: 'them', pen: true, period: 0, atMs: 9 * MIN });
    s = M.reduce(s, { t: 'miss', id: 'm2', side: 'them', scorer: 'c', period: 0, atMs: 11 * MIN });
    assert.deepEqual(M.score(s), { us: 1, them: 1 }, 'a miss changes no score');
    const ev = Object.fromEntries(s.events.map((e) => [e.id, e]));
    assert.ok(ev.p1.pen && ev.p1.scorer === 'c' && ev.p1.assist === null, 'a penalty has no assist');
    assert.ok(ev.p2.pen);
    assert.equal(ev.m1.scorer, 'b');
    assert.equal(ev.m2.scorer, undefined, 'their kicker has no name');
    // Through the cleaner, as every viewer gets it.
    const clean = M.cleanLive(JSON.parse(JSON.stringify(s)));
    assert.deepEqual(clean.events.filter((e) => e.type !== 'period_start').map((e) => [e.id, e.type, !!e.pen]),
      [['p1', 'goal', true], ['m1', 'miss', false], ['p2', 'goal', true], ['m2', 'miss', false]]);
    // Deleted like any goal.
    s = M.reduce(s, { t: 'del', id: 'm1' });
    assert.ok(!s.events.some((e) => e.id === 'm1'));
  });

  await test('an own goal by the opponent is ours, credited to no one', () => {
    let s = M.reduce(base(), { t: 'start', at: T0 });
    s = M.reduce(s, { t: 'goal', id: 'o1', side: 'us', scorer: 'c', assist: 'b', og: true, period: 0, atMs: 5 * MIN });
    const e = s.events.find((x) => x.id === 'o1');
    assert.deepEqual([e.og, e.scorer, e.assist, M.score(s).us], [true, null, null, 1]);
    // Fixed to a real scorer, and back.
    s = M.reduce(s, { t: 'edit', id: 'o1', patch: { scorer: 'c', assist: null, og: false } });
    assert.deepEqual([s.events.find((x) => x.id === 'o1').og, s.events.find((x) => x.id === 'o1').scorer], [undefined, 'c']);
    s = M.reduce(s, { t: 'edit', id: 'o1', patch: { scorer: null, assist: null, og: true } });
    assert.equal(M.cleanLive(JSON.parse(JSON.stringify(s))).events.find((x) => x.id === 'o1').og, true);
    // A forged own goal with a scorer is cleaned to none.
    const forged = M.cleanLive({ ...s, events: [{ id: 'z', type: 'goal', side: 'us', og: true, scorer: 'c', period: 0, atMs: 0 }] });
    assert.equal(forged.events[0].scorer, null);
  });

  await test('substitutions change who is on the field, in match order', () => {
    let s = M.reduce(base(), { t: 'start', at: T0 });
    s = M.reduce(s, { t: 'sub', id: 's2', out: 'd', in: 'e', period: 0, atMs: 20 * MIN });
    s = M.reduce(s, { t: 'sub', id: 's1', out: 'a', in: 'd', period: 0, atMs: 10 * MIN });
    const field = Object.fromEntries(M.onField(s).map((f) => [f.pid, f.pos]));
    assert.deepEqual(field, { g: 'GK', e: 'LB', b: 'AM', c: 'ST' });
    assert.deepEqual(M.bench(s).map((p) => p.id).sort(), ['a', 'd']);
  });

  await test('a sub into a different position moves the slot', () => {
    let s = M.reduce(base(), { t: 'start', at: T0 });
    s = M.reduce(s, { t: 'sub', id: 's1', out: 'a', in: 'e', pos: 'CB', period: 0, atMs: MIN });
    assert.equal(M.onField(s).find((f) => f.pid === 'e').pos, 'CB');
  });

  await test('an interval sub is stamped at the start of the next period', () => {
    let s = M.reduce(base(), { t: 'start', at: T0 });
    s = M.reduce(s, { t: 'end', period: 0, at: T0 + 30 * MIN });
    const stamp = M.stampNow(s, T0 + 35 * MIN);
    assert.deepEqual(stamp, { period: 1, atMs: 0, atStart: true });
    s = M.reduce(s, { t: 'sub', id: 's1', out: 'a', in: 'd', ...stamp });
    assert.equal(M.minuteLabel(s.format, 1, 0, { atStart: true }), 'תחילת שליש 2');
    assert.ok(M.onField(s).some((f) => f.pid === 'd'));
  });

  await test('minutes played follow subs and each period\'s real length', () => {
    let s = M.reduce(base(), { t: 'start', at: T0 });
    s = M.reduce(s, { t: 'sub', id: 's1', out: 'a', in: 'd', period: 0, atMs: 10 * MIN });
    s = M.reduce(s, { t: 'end', period: 0, at: T0 + 32 * MIN });             // 30 + 2 stoppage
    s = M.reduce(s, { t: 'sub', id: 's2', out: 'd', in: 'a', period: 1, atMs: 0, atStart: true });
    s = M.reduce(s, { t: 'start', at: T0 + 40 * MIN });
    s = M.reduce(s, { t: 'end', period: 1, at: T0 + 70 * MIN });
    s = M.reduce(s, { t: 'start', at: T0 + 75 * MIN });
    s = M.reduce(s, { t: 'finish', at: T0 + 95 * MIN });
    const m = M.minutesPlayed(s);
    assert.equal(m.g, 82);          // 32 + 30 + 20
    assert.equal(m.a, 10 + 30 + 20);
    assert.equal(m.d, 22);
    assert.equal(m.e, undefined);
  });

  await test('the same operations replayed on the same state give the same result', () => {
    const ops = [
      { t: 'start', at: T0 },
      { t: 'goal', id: 'x', side: 'us', scorer: 'c', assist: null, period: 0, atMs: 3 * MIN },
      { t: 'sub', id: 'y', out: 'b', in: 'e', period: 0, atMs: 8 * MIN },
      { t: 'pause', at: T0 + 9 * MIN },
    ];
    const a = ops.reduce(M.reduce, base());
    const b = ops.reduce(M.reduce, base());
    assert.deepEqual(a, b);
  });

  await test('deleting and editing touch only goals and subs', () => {
    let s = M.reduce(base(), { t: 'start', at: T0 });
    s = M.reduce(s, { t: 'goal', id: 'g1', side: 'us', scorer: 'c', period: 0, atMs: MIN });
    s = M.reduce(s, { t: 'edit', id: 'g1', patch: { scorer: 'b', assist: 'c' } });
    assert.equal(s.events.find((e) => e.id === 'g1').scorer, 'b');
    s = M.reduce(s, { t: 'del', id: 'start-0' });
    assert.ok(s.events.some((e) => e.id === 'start-0'));
    s = M.reduce(s, { t: 'del', id: 'g1' });
    assert.deepEqual(M.score(s), { us: 0, them: 0 });
  });

  await test('squad size: defaults to nine, takes eleven, and a match can change it before kickoff', () => {
    assert.equal(M.cleanSize(undefined), 9);
    assert.equal(M.cleanSize('11'), 11);
    assert.equal(M.cleanSize(8), 9);
    assert.equal(M.sizeOf({}), 9, 'a state from before sizes reads as nine');
    const s0 = M.newLive({ id: 'S', players: squad, size: 11 });
    assert.equal(s0.size, 11);
    const s1 = M.reduce(s0, { t: 'meta', patch: { size: 9 } });
    assert.equal(s1.size, 9);
    const running = M.reduce(M.reduce(s1, { t: 'lineup', lineup: [{ pid: 'g', pos: 'GK' }] }), { t: 'start', at: 1 });
    assert.equal(M.reduce(running, { t: 'meta', patch: { size: 11 } }).size, 9, 'size is fixed once the match is on');
  });

  await test('the last starting lineup is the default for the next match', () => {
    const matches = [
      { date: '2026-09-19', gf: 1, ga: 0 },                                     // entered by hand: no lineup
      { date: '2026-09-12', lineup: [{ pid: 'g', pos: 'GK' }, { pid: 'gone', pos: 'CB' }, { pid: 'a', pos: 'LB' }, { pid: 'a', pos: 'LB' }] },
      { date: '2026-09-05', lineup: [{ pid: 'c', pos: 'ST' }] },
    ];
    assert.deepEqual(M.previousLineup(matches, squad, 9), [{ pid: 'g', pos: 'GK' }, { pid: 'a', pos: 'LB' }],
      'newest recorded lineup, without players who left and without duplicates');
    assert.deepEqual(M.previousLineup(matches, squad, 9).length, 2);
    const big = [{ lineup: squad.map((p) => ({ pid: p.id, pos: p.pos })) }];
    assert.equal(M.previousLineup(big, squad, 9).length, 6);
    assert.equal(M.previousLineup([{ lineup: [...big[0].lineup, ...big[0].lineup.map((l) => ({ ...l, pid: l.pid }))] }], squad, 9).length, 6);
    assert.deepEqual(M.previousLineup([], squad, 9), []);
    const s = M.newLive({ id: 'N', players: squad, lineup: M.previousLineup(matches, squad, 9) });
    assert.equal(s.lineup.length, 2, 'newLive takes the default lineup');
  });

  await test('a previous lineup longer than the size is cut to it', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => P('p' + i, i + 1, 'CM'));
    const m = [{ lineup: eleven.map((p) => ({ pid: p.id, pos: 'CM' })) }];
    assert.equal(M.previousLineup(m, eleven, 9).length, 9);
    assert.equal(M.previousLineup(m, eleven, 11).length, 11);
  });

  await test('a match is dated by its kick-off, not by the schedule', () => {
    const fixture = { date: '2030-11-08', opponent: 'בני לוח' };
    const s0 = M.newLive({ id: 'F', opponent: 'בני לוח', date: '2030-11-08', players: squad, fixture });
    assert.deepEqual(s0.fixture, fixture);
    const kick = Date.parse('2026-09-23T21:30:00Z');          // 00:30 on the 24th in Israel
    const s1 = M.reduce(s0, { t: 'start', at: kick });
    assert.equal(s1.date, '2026-09-24', 'Israel\'s calendar day at kick-off');
    const brk = M.reduce(s1, { t: 'end', period: 0, at: kick + 60000 });
    assert.equal(brk.status, 'break');
    const s2 = M.reduce(brk, { t: 'start', at: kick + 86400000 * 3 });
    assert.equal(s2.status, 'running');
    assert.equal(s2.period, 1);
    assert.equal(s2.date, '2026-09-24', 'the second half does not move it again');
    assert.equal(M.newLive({ id: 'N', players: squad }).fixture, null);
  });

  await test('format presets and cleaning', () => {
    assert.deepEqual(M.cleanFormat(['25', 25]), [25, 25]);
    assert.deepEqual(M.cleanFormat([0, -3]), M.DEFAULT_FORMAT);
    assert.equal(M.describeFormat([30, 30, 20]), '3 שלישים · 30/30/20');
    assert.equal(M.describeFormat([25, 25]), '2 מחציות · 25 דק׳');
  });

  // The owner's order for who comes on: same position (first, then second),
  // the positions beside it, then whole lines in an order that depends on
  // the line being replaced. Keepers are not defenders.
  const B = (id, pos, pos2 = '') => ({ id, name: id, number: null, pos, pos2 });
  const bench = [B('gk', 'GK', 'CB'), B('st', 'ST'), B('rb', 'RB'), B('cm', 'CM'), B('lw2', 'CM', 'LW'), B('lw', 'LW'),
    B('rw', 'RW'), B('cb', 'CB'), B('am', 'AM'), B('dm', 'DM'), B('cb2', 'ST', 'CB'), B('dm2', 'RB', 'DM'), B('cm2', 'ST', 'CM'), B('none', '')];
  const order = (pos, opts) => subGroups(pos, bench, opts).map((g) => [g.label, g.players.map((p) => p.id)]);

  await test('left wing: left wing first, then as a second position, then attack, midfield, defence', () => {
    assert.deepEqual(order('LW'), [
      ['בעמדה: כנף שמאל', ['lw']],
      ['כנף שמאל כעמדה נוספת', ['lw2']],
      ['התקפה', ['st', 'rw', 'cb2', 'cm2']],
      ['קישור', ['cm', 'am', 'dm', 'dm2']],
      ['הגנה', ['rb', 'cb', 'gk']],
      ['שאר הספסל', ['none']],
    ]);
  });

  await test('centre back: centre backs, then defence without the keeper, midfield, attack', () => {
    assert.deepEqual(order('CB'), [
      ['בעמדה: בלם', ['cb']],
      ['בלם כעמדה נוספת', ['gk', 'cb2']],
      ['הגנה', ['rb', 'dm2']],
      // cm2 is a striker who also plays central midfield: midfield, by his
      // second position, comes before attack.
      ['קישור', ['cm', 'lw2', 'am', 'dm', 'cm2']],
      ['התקפה', ['st', 'lw', 'rw']],
      ['שאר הספסל', ['none']],
    ]);
  });

  await test('defensive midfield: DM, DM as second, central midfielders (first and second), attack, defence', () => {
    assert.deepEqual(order('DM'), [
      ['בעמדה: קשר אחורי', ['dm']],
      ['קשר אחורי כעמדה נוספת', ['dm2']],
      ['קשר מרכזי', ['cm', 'lw2', 'cm2']],
      ['קישור', ['am']],
      ['התקפה', ['st', 'lw', 'rw', 'cb2']],
      ['הגנה', ['rb', 'cb', 'gk']],
      ['שאר הספסל', ['none']],
    ]);
  });

  await test('a keeper is replaced by keepers, then anyone', () => {
    assert.deepEqual(order('GK').map(([l]) => l), ['בעמדה: שוער', 'שאר הספסל']);
  });

  await test('from the bench: the field players in the incoming first position, then his second, then the lines', () => {
    const field = [B('f1', 'ST'), B('f2', 'CB'), B('f3', 'LW'), B('f4', 'CM'), B('f5', 'GK')];
    const g = subGroups('LW', field, { second: () => '', also: 'CM', rest: 'שאר המגרש', all: 'על המגרש' })
      .map((x) => [x.label, x.players.map((p) => p.id)]);
    assert.deepEqual(g, [['בעמדה: כנף שמאל', ['f3']], ['בעמדה: קשר מרכזי', ['f4']], ['התקפה', ['f1']], ['הגנה', ['f2']], ['שאר המגרש', ['f5']]]);
  });
}
