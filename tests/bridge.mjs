// Server-side rules of tools/bridge.gs, run against the real file.
//   node tests/bridge.mjs
import { createBridge } from './mock-bridge.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const ADMIN = 'test-admin-code-1234';
const devA = 'a'.repeat(64), devB = 'b'.repeat(64);
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓', name); };
const err = (r) => (r.ok ? null : r.code);

const b = createBridge({ adminCode: ADMIN });

test('unknown device sees status none', () => {
  assert.equal(b.post({ action: 'hello', deviceKey: devA }).result.status, 'none');
});

test('a short device key is refused', () => {
  assert.equal(err(b.post({ action: 'hello', deviceKey: 'short' })), 'bad_device');
});

test('an unknown device cannot read the season', () => {
  assert.equal(err(b.post({ action: 'getSeason', deviceKey: devA })), 'not_approved');
});

test('requesting access needs a name', () => {
  assert.equal(err(b.post({ action: 'requestAccess', deviceKey: devA, name: '   ' })), 'bad_name');
});

test('a request becomes pending, and a pending device still cannot read', () => {
  assert.equal(b.post({ action: 'requestAccess', deviceKey: devA, name: 'אמא של איתי' }).result.status, 'pending');
  assert.equal(err(b.post({ action: 'getSeason', deviceKey: devA })), 'not_approved');
});

test('the raw device key never reaches Drive', () => {
  assert.ok(!b.driveFile('access.json').includes(devA));
});

test('admin actions refuse a wrong code', () => {
  assert.equal(err(b.post({ action: 'listUsers', adminCode: 'wrong-code-xxxxx' })), 'bad_code');
  assert.equal(err(b.post({ action: 'listUsers' })), 'bad_code');
});

test('a device key is not an admin code', () => {
  assert.equal(err(b.post({ action: 'putSeason', deviceKey: devA, season: {}, baseVersion: 0 })), 'bad_code');
});

let idA;
test('admin sees the pending request and approves it', () => {
  const users = b.post({ action: 'listUsers', adminCode: ADMIN }).result;
  assert.equal(users.length, 1);
  assert.equal(users[0].name, 'אמא של איתי');
  idA = users[0].id;
  assert.equal(b.post({ action: 'setStatus', adminCode: ADMIN, id: idA, status: 'approved' }).result.status, 'approved');
});

test('an approved device reads an empty season before anything is saved', () => {
  const r = b.post({ action: 'getSeason', deviceKey: devA }).result;
  assert.equal(r.version, 0);
  assert.equal(r.season, null);
});

test('admin saves; the approved device reads it back from Drive', () => {
  const r = b.post({ action: 'putSeason', adminCode: ADMIN, baseVersion: 0, season: { team: { name: 'מכבי גבעתיים' } } }).result;
  assert.equal(r.version, 1);
  b.clearCache();
  const s = b.post({ action: 'getSeason', deviceKey: devA }).result;
  assert.equal(s.version, 1);
  assert.equal(s.season.team.name, 'מכבי גבעתיים');
});

test('player minutes and past lineups reach the manager only', () => {
  const cur = b.post({ action: 'getSeason', adminCode: ADMIN }).result;
  const season = { ...cur.season,
    players: [{ id: 'p1', name: 'איתי', goals: 2, minutes: 120 }],
    matches: [{ date: '2026-09-19', opponent: 'בני לוד', gf: 1, ga: 0, lineup: [{ pid: 'p1', pos: 'ST' }], events: [{ id: 'g', type: 'goal', side: 'us', scorer: 'p1' }] }] };
  const r = b.post({ action: 'putSeason', adminCode: ADMIN, baseVersion: cur.version, season }).result;
  b.clearCache();
  const parent = b.post({ action: 'getSeason', deviceKey: devA }).result.season;
  assert.equal('minutes' in parent.players[0], false, 'minutes sent to a parent');
  assert.equal(parent.players[0].goals, 2, 'the rest of the player stays');
  assert.equal('lineup' in parent.matches[0], false, 'a past lineup lets minutes be recomputed');
  assert.equal(parent.matches[0].events.length, 1, 'events stay: the timeline is built from them');
  const admin = b.post({ action: 'getSeason', adminCode: ADMIN }).result.season;
  assert.equal(admin.players[0].minutes, 120);
  assert.equal(admin.matches[0].lineup.length, 1);
  const again = b.post({ action: 'getSeason', adminCode: ADMIN }).result.season;
  assert.equal(again.players[0].minutes, 120, 'stripping for a parent must not touch the stored copy');
  assert.equal(r.version, cur.version + 1);
});

test('video posters: made by the manager, read by approved devices only', () => {
  const JPG = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3];
  b.web('https://i.ytimg.com/vi/abcDEF12345/hqdefault.jpg', 'image/jpeg', JPG);
  b.web('https://example.com/clip', 'text/html', '<html><head><meta property="og:image" content="https://cdn.example.com/p.jpg?a=1&amp;b=2"></head></html>');
  b.web('https://cdn.example.com/p.jpg?a=1&b=2', 'image/png', [0x89, 0x50]);
  b.drivePicture('1AbCdEfGhIjKlMn', [9, 9, 9]);

  assert.equal(err(b.post({ action: 'makePoster', deviceKey: devA, url: 'https://youtu.be/abcDEF12345' })), 'bad_code');
  const yt = b.post({ action: 'makePoster', adminCode: ADMIN, url: 'https://www.youtube.com/watch?v=abcDEF12345' }).result.ref;
  const got = b.post({ action: 'getPoster', deviceKey: devA, ref: yt }).result;
  assert.equal(got.mime, 'image/jpeg');
  assert.deepEqual([...Buffer.from(got.data, 'base64')], JPG);

  const og = b.post({ action: 'makePoster', adminCode: ADMIN, url: 'https://example.com/clip' }).result.ref;
  assert.equal(b.post({ action: 'getPoster', deviceKey: devA, ref: og }).result.mime, 'image/png', 'og:image, &amp; decoded');
  const dr = b.post({ action: 'makePoster', adminCode: ADMIN, url: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view' }).result.ref;
  assert.deepEqual([...Buffer.from(b.post({ action: 'getPoster', deviceKey: devA, ref: dr }).result.data, 'base64')], [9, 9, 9]);

  assert.equal(err(b.post({ action: 'makePoster', adminCode: ADMIN, url: 'https://nothing.example.com/x' })), 'no_poster');
  const again = b.post({ action: 'makePoster', adminCode: ADMIN, url: 'https://www.youtube.com/watch?v=abcDEF12345' }).result.ref;
  assert.equal(b.fileById(yt).isTrashed(), true, 'the same link replaces its old image instead of piling up');
  assert.notEqual(again, yt);

  assert.equal(err(b.post({ action: 'getPoster', deviceKey: devB, ref: again })), 'not_approved');
  const season = b.driveFileId('season.json');
  assert.ok(season);
  assert.equal(err(b.post({ action: 'getPoster', deviceKey: devA, ref: season })), 'not_found', 'getPoster must not read files outside posters/');
  assert.equal(err(b.post({ action: 'getPoster', deviceKey: devA, ref: yt })), 'not_found', 'a trashed image is gone');
});

test('a save over a stale version is rejected, not silently overwritten', () => {
  assert.equal(err(b.post({ action: 'putSeason', adminCode: ADMIN, baseVersion: 0, season: { x: 1 } })), 'conflict');
  const s = b.post({ action: 'getSeason', adminCode: ADMIN }).result;
  assert.equal(s.season.team.name, 'מכבי גבעתיים');
});

test('a malformed season is rejected', () => {
  assert.equal(err(b.post({ action: 'putSeason', adminCode: ADMIN, baseVersion: 1, season: [1, 2] })), 'bad_season');
});

test('an approved device cannot write', () => {
  assert.equal(err(b.post({ action: 'putSeason', deviceKey: devA, baseVersion: 1, season: {} })), 'bad_code');
});

test('revoking locks the device out immediately', () => {
  b.post({ action: 'setStatus', adminCode: ADMIN, id: idA, status: 'revoked' });
  assert.equal(err(b.post({ action: 'getSeason', deviceKey: devA })), 'not_approved');
  assert.equal(b.post({ action: 'hello', deviceKey: devA }).result.status, 'revoked');
});

test('a revoked device may ask again, landing back in pending — not approved', () => {
  assert.equal(b.post({ action: 'requestAccess', deviceKey: devA, name: 'שוב' }).result.status, 'pending');
  assert.equal(err(b.post({ action: 'getSeason', deviceKey: devA })), 'not_approved');
});

test('another device is unaffected by the first one\'s approval', () => {
  assert.equal(b.post({ action: 'hello', deviceKey: devB }).result.status, 'none');
});

test('pending requests are capped', () => {
  const c = createBridge({ adminCode: ADMIN });
  let last;
  for (let i = 0; i < 45; i++) last = c.post({ action: 'requestAccess', deviceKey: String(i).padStart(40, 'x'), name: 'n' + i });
  assert.equal(err(last), 'too_many');
});

test('a missing or short admin code in the bridge is reported as a setup problem', () => {
  const c = createBridge({ adminCode: '' });
  assert.equal(err(c.post({ action: 'adminPing', adminCode: 'x' })), 'setup');
  c.setProp('ADMIN_CODE', 'short');
  assert.match(c.post({ action: 'adminPing', adminCode: 'short' }).error, /קצר מדי/);
});

// ---- live ----
console.log('live:');
{
  const L = createBridge({ adminCode: ADMIN });
  const dev = (ch) => ch.repeat(64);
  const approve = (key, name) => {
    L.post({ action: 'requestAccess', deviceKey: key, name });
    const id = L.post({ action: 'listUsers', adminCode: ADMIN }).result.find((u) => u.name === name).id;
    L.post({ action: 'setStatus', adminCode: ADMIN, id, status: 'approved' });
    return id;
  };
  const parent = dev('p'), other = dev('o'), stranger = dev('s');
  const parentId = approve(parent, 'אבא של איתי');
  approve(other, 'אמא של דניאל');
  const state = (extra = {}) => ({ id: 'M1', status: 'running', opponent: 'בני לוד', date: '2026-10-03', format: [30, 30, 20],
    lineup: [], players: [], events: [], ...extra });

  test('no live match yet: an approved device reads an empty state', () => {
    const r = L.post({ action: 'getLive', deviceKey: parent }).result;
    assert.equal(r.state, null);
    assert.equal(r.canControl, false);
    assert.ok(r.serverNow > 0);
  });

  test('a device that was never approved cannot watch', () => {
    assert.equal(err(L.post({ action: 'getLive', deviceKey: stranger })), 'not_approved');
  });

  test('only the manager can start a live match', () => {
    assert.equal(err(L.post({ action: 'startLive', deviceKey: parent, state: state() })), 'bad_code');
    assert.equal(L.post({ action: 'startLive', adminCode: ADMIN, state: state() }).result.version, 1);
  });

  test('a second live match is refused while one is open', () => {
    assert.equal(err(L.post({ action: 'startLive', adminCode: ADMIN, state: state({ id: 'M2' }) })), 'live_exists');
  });

  test('watchers get the state, then "unchanged" with no body until it changes', () => {
    const r1 = L.post({ action: 'getLive', deviceKey: parent }).result;
    assert.equal(r1.state.id, 'M1');
    const r2 = L.post({ action: 'getLive', deviceKey: parent, since: r1.version }).result;
    assert.equal(r2.unchanged, true);
    assert.equal(r2.state, undefined);
  });

  test('the manager sees who has the live screen open, and only the manager', () => {
    L.post({ action: 'getLive', deviceKey: parent, watching: true });
    L.post({ action: 'getLive', deviceKey: other });   // app open, not on the live screen
    const w = L.post({ action: 'getLive', adminCode: ADMIN }).result.control.watchers;
    assert.deepEqual(w, [{ name: 'אבא של איתי', coach: false }]);
    assert.equal(L.post({ action: 'getLive', deviceKey: other, watching: true }).result.control, undefined);
    assert.equal(L.post({ action: 'getLive', adminCode: ADMIN }).result.control.watchers.length, 2);
  });

  test('watching is kept in the cache, never written to Drive', () => {
    const before = L.writes;
    L.post({ action: 'getLive', deviceKey: parent, watching: true });
    assert.equal(L.writes, before);
  });

  test('an approved parent without a code cannot update the match', () => {
    assert.equal(err(L.post({ action: 'putLive', deviceKey: parent, baseVersion: 1, state: state() })), 'not_controller');
  });

  test('the manager updates; a stale base version is a conflict', () => {
    assert.equal(L.post({ action: 'putLive', adminCode: ADMIN, baseVersion: 1, state: state({ events: [{ id: 'g1', type: 'goal', side: 'us' }] }) }).result.version, 2);
    assert.equal(err(L.post({ action: 'putLive', adminCode: ADMIN, baseVersion: 1, state: state() })), 'conflict');
  });

  test('a live code must be 4–24 characters and is set by the manager only', () => {
    assert.equal(err(L.post({ action: 'setLiveCode', adminCode: ADMIN, code: '12' })), 'bad_code_format');
    assert.equal(err(L.post({ action: 'setLiveCode', deviceKey: parent, code: '4821' })), 'bad_code');
    assert.equal(L.post({ action: 'setLiveCode', adminCode: ADMIN, code: '4821' }).result.codeActive, true);
  });

  test('the code is stored hashed, not as typed', () => {
    assert.ok(!L.driveFile('live.json').includes('4821'));
  });

  test('a wrong code counts down the attempts', () => {
    assert.match(L.post({ action: 'claimLive', deviceKey: parent, code: '0000' }).error, /נותרו 4/);
    assert.equal(L.post({ action: 'getLive', adminCode: ADMIN }).result.control.attemptsLeft, 4);
  });

  test('the right code gives this device control — once', () => {
    assert.equal(L.post({ action: 'claimLive', deviceKey: parent, code: '4821' }).result.canControl, true);
    assert.equal(L.post({ action: 'getLive', deviceKey: parent }).result.canControl, true);
    assert.equal(err(L.post({ action: 'claimLive', deviceKey: other, code: '4821' })), 'no_code');
    assert.deepEqual(L.post({ action: 'getLive', adminCode: ADMIN }).result.control.controllers, ['אבא של איתי']);
  });

  test('the parent in control can update; a watching parent still cannot', () => {
    assert.equal(L.post({ action: 'putLive', deviceKey: parent, baseVersion: 2, state: state({ events: [{ id: 'g1', type: 'goal', side: 'us' }, { id: 'g2', type: 'goal', side: 'them' }] }) }).result.version, 3);
    assert.equal(err(L.post({ action: 'putLive', deviceKey: other, baseVersion: 3, state: state() })), 'not_controller');
  });

  test('a client cannot grant control by writing it into the state', () => {
    L.post({ action: 'putLive', deviceKey: parent, baseVersion: 3, state: state({ meta: { controllers: ['x'] }, events: [{ id: 'g1', type: 'goal', side: 'us' }, { id: 'g2', type: 'goal', side: 'them' }] }) });
    assert.equal(L.post({ action: 'getLive', deviceKey: other }).result.canControl, false);
  });

  test('five wrong codes lock the code for everyone', () => {
    L.post({ action: 'setLiveCode', adminCode: ADMIN, code: 'SECRET1' });
    let last;
    for (let i = 0; i < 5; i++) last = L.post({ action: 'claimLive', deviceKey: other, code: 'guess' + i });
    assert.equal(err(last), 'code_locked');
    assert.equal(err(L.post({ action: 'claimLive', deviceKey: other, code: 'SECRET1' })), 'no_code');
  });

  test('revoking a parent\'s access also ends their control', () => {
    L.post({ action: 'setStatus', adminCode: ADMIN, id: parentId, status: 'revoked' });
    assert.ok(!L.post({ action: 'getLive', adminCode: ADMIN }).result.control.watchers.some((x) => x.name === 'אבא של איתי'), 'a revoked device still listed as watching');
    assert.equal(err(L.post({ action: 'putLive', deviceKey: parent, baseVersion: 4, state: state() })), 'not_approved');
    L.post({ action: 'setStatus', adminCode: ADMIN, id: parentId, status: 'approved' });
  });

  test('finishing writes the result into the season, counted from the events', () => {
    L.post({ action: 'putSeason', adminCode: ADMIN, baseVersion: 0, season: { team: { name: 'מכבי גבעתיים' }, nextMatch: { opponent: 'בני לוד' }, matches: [] } });
    const v = L.post({ action: 'getLive', adminCode: ADMIN }).result.version;
    const ended = state({ status: 'ended', round: '<img src=x>', events: [
      { id: 'a', type: 'goal', side: 'us', scorer: 'p1' }, { id: 'b', type: 'goal', side: 'us' }, { id: 'c', type: 'goal', side: 'them' }] });
    const r = L.post({ action: 'finishLive', deviceKey: parent, baseVersion: v, state: ended }).result;
    assert.deepEqual([r.gf, r.ga], [2, 1]);
    const season = L.post({ action: 'getSeason', deviceKey: parent }).result.season;
    assert.equal(season.matches.length, 1);
    assert.equal(season.matches[0].liveId, 'M1');
    assert.equal(season.matches[0].round, null, 'a round that is not a number is not stored');
    assert.equal(season.nextMatch, null);
  });

  test('finishing again after a correction replaces the row, never duplicates it', () => {
    const v = L.post({ action: 'getLive', adminCode: ADMIN }).result.version;
    const ended = state({ status: 'ended', events: [{ id: 'a', type: 'goal', side: 'us' }], fixture: { date: '2030-11-08', opponent: 'בני לוד', extra: 'x' } });
    L.post({ action: 'finishLive', adminCode: ADMIN, baseVersion: v, state: ended });
    const season = L.post({ action: 'getSeason', adminCode: ADMIN }).result.season;
    assert.equal(season.matches.length, 1);
    assert.deepEqual([season.matches[0].gf, season.matches[0].ga], [1, 0]);
    assert.deepEqual(season.matches[0].fixture, { date: '2030-11-08', opponent: 'בני לוד' }, 'the schedule row it came from, and nothing else from the client');
    assert.equal(season.matches[0].date, '2026-10-03', 'dated by the match, not by the schedule');
  });

  test('after the match ends the parent\'s control ends with it', () => {
    const v = L.post({ action: 'getLive', adminCode: ADMIN }).result.version;
    assert.equal(err(L.post({ action: 'putLive', deviceKey: parent, baseVersion: v, state: state({ status: 'ended' }) })), 'not_controller');
    const rewrite = state({ status: 'ended', events: Array.from({ length: 9 }, (_, i) => ({ id: 'x' + i, type: 'goal', side: 'us' })) });
    assert.equal(err(L.post({ action: 'finishLive', deviceKey: parent, baseVersion: v, state: rewrite })), 'conflict',
      'a finished match is not the parent\'s to rewrite');
    assert.equal(L.post({ action: 'getSeason', adminCode: ADMIN }).result.season.matches[0].gf, 1);
    assert.equal(L.post({ action: 'getLive', deviceKey: parent }).result.canControl, false);
  });

  test('clearing the live match leaves nothing to watch; a new one can start', () => {
    L.post({ action: 'clearLive', adminCode: ADMIN });
    assert.equal(L.post({ action: 'getLive', deviceKey: parent }).result.state, null);
    assert.ok(L.post({ action: 'startLive', adminCode: ADMIN, state: state({ id: 'M2' }) }).ok);
    assert.deepEqual(L.post({ action: 'getLive', adminCode: ADMIN }).result.control.controllers, []);
    assert.ok(L.post({ action: 'getSeason', adminCode: ADMIN }).result.season.matches.some((m) => m.liveId === 'M1'),
      'closing the screen after the end keeps the saved result');
  });

  test('cancelling a match that was saved, reopened and then cancelled takes its row out of the season', () => {
    let v = L.post({ action: 'getLive', adminCode: ADMIN }).result.version;
    const goal = [{ id: 'z1', type: 'goal', side: 'us', pid: 'p9' }];
    L.post({ action: 'finishLive', adminCode: ADMIN, baseVersion: v, state: state({ id: 'M2', status: 'ended', events: goal }) });
    assert.ok(L.post({ action: 'getSeason', adminCode: ADMIN }).result.season.matches.some((m) => m.liveId === 'M2'));
    v = L.post({ action: 'getLive', adminCode: ADMIN }).result.version;
    L.post({ action: 'putLive', adminCode: ADMIN, baseVersion: v, state: state({ id: 'M2', status: 'fulltime', events: goal }) });   // reopened
    const r = L.post({ action: 'clearLive', adminCode: ADMIN, discard: true }).result;
    const matches = L.post({ action: 'getSeason', adminCode: ADMIN }).result.season.matches;
    assert.ok(!matches.some((m) => m.liveId === 'M2'), 'the cancelled match is still in the season');
    assert.ok(matches.some((m) => m.liveId === 'M1'), 'another live match was taken out with it');
    assert.ok(r.seasonVersion > 0, 'the client is not told the season changed');
  });

  test('only the manager can cancel', () => {
    assert.equal(err(L.post({ action: 'clearLive', deviceKey: parent, discard: true })), 'bad_code');
  });
}

// The coach: an approved device the manager marked. It reads what the
// manager reads about minutes and writes only its own data (threshold and
// attendance) — never the season, the live match or anyone's access.
{
  const C = createBridge({ adminCode: ADMIN });
  const coach = 'c'.repeat(64), parent = 'd'.repeat(64);
  const approve = (key, name) => {
    C.post({ action: 'requestAccess', deviceKey: key, name });
    const id = C.post({ action: 'listUsers', adminCode: ADMIN }).result.find((u) => u.name === name).id;
    C.post({ action: 'setStatus', adminCode: ADMIN, id, status: 'approved' });
    return id;
  };
  const coachId = approve(coach, 'המאמן');
  approve(parent, 'הורה');
  C.post({ action: 'putSeason', adminCode: ADMIN, baseVersion: 0, season: {
    players: [{ id: 'p1', name: 'איתי', minutes: 30 }],
    matches: [{ liveId: 'OLD', date: '2026-09-19', opponent: 'בני לוד', gf: 1, ga: 0, lineup: [{ pid: 'p1', pos: 'ST' }], events: [] }] } });

  test('only the manager can mark a coach, and only with a known role', () => {
    assert.equal(err(C.post({ action: 'setRole', deviceKey: coach, id: coachId, role: 'coach' })), 'bad_code');
    assert.equal(err(C.post({ action: 'setRole', adminCode: ADMIN, id: coachId, role: 'admin' })), 'bad_role');
    assert.equal(err(C.post({ action: 'setCoachMatch', deviceKey: coach, liveId: 'M1', min: 25 })), 'not_coach',
      'an approved device is not a coach until marked');
    assert.equal(C.post({ action: 'setRole', adminCode: ADMIN, id: coachId, role: 'coach' }).result.role, 'coach');
    assert.equal(C.post({ action: 'listUsers', adminCode: ADMIN }).result.find((u) => u.id === coachId).role, 'coach');
  });

  test('the coach reads minutes and past lineups; a parent still does not', () => {
    const c = C.post({ action: 'getSeason', deviceKey: coach }).result;
    assert.equal(c.role, 'coach');
    assert.equal(c.season.matches[0].lineup.length, 1);
    assert.deepEqual(c.coach, { minDefault: 20, matches: {} });
    const p = C.post({ action: 'getSeason', deviceKey: parent }).result;
    assert.equal(p.role, 'parent');
    assert.equal('lineup' in p.season.matches[0], false);
    assert.equal('coach' in p, false, 'coach data sent to a parent');
    assert.equal(C.post({ action: 'getSeason', adminCode: ADMIN }).result.role, 'admin');
  });

  test('a parent cannot write coach data', () => {
    assert.equal(err(C.post({ action: 'setCoachMatch', deviceKey: parent, liveId: 'M1', min: 5 })), 'not_coach');
  });

  test('the coach writes threshold and attendance; the new threshold becomes the default without rewriting the past', () => {
    const r = C.post({ action: 'setCoachMatch', deviceKey: coach, liveId: 'M1', min: 25, absent: ['p2', 'p2', 'p3'] }).result;
    assert.equal(r.minDefault, 25);
    assert.deepEqual(r.matches.M1, { min: 25, absent: ['p2', 'p3'] });
    assert.equal(r.matches.OLD.min, 20, 'a match played under the old default keeps it');
    const again = C.post({ action: 'setCoachMatch', adminCode: ADMIN, liveId: 'M1', absent: [] }).result;
    assert.deepEqual(again.matches.M1, { min: 25, absent: [] }, 'attendance alone leaves the threshold');
    C.clearCache();
    assert.equal(C.post({ action: 'getSeason', deviceKey: coach }).result.coach.minDefault, 25);
  });

  test('coach data is validated', () => {
    assert.equal(err(C.post({ action: 'setCoachMatch', deviceKey: coach, liveId: '<img>', min: 20 })), 'bad_match');
    assert.equal(err(C.post({ action: 'setCoachMatch', deviceKey: coach, liveId: 'M1', min: -1 })), 'bad_min');
    assert.equal(err(C.post({ action: 'setCoachMatch', deviceKey: coach, liveId: 'M1', min: 2.5 })), 'bad_min');
    assert.equal(err(C.post({ action: 'setCoachMatch', deviceKey: coach, liveId: 'M1', absent: 'p1' })), 'bad_absent');
  });

  test('a coach writes nothing else: not the season, not the live match, not access', () => {
    assert.equal(err(C.post({ action: 'putSeason', deviceKey: coach, baseVersion: 1, season: {} })), 'bad_code');
    assert.equal(err(C.post({ action: 'startLive', deviceKey: coach, state: { id: 'X', status: 'setup' } })), 'bad_code');
    C.post({ action: 'startLive', adminCode: ADMIN, state: { id: 'X', status: 'setup' } });
    const v = C.post({ action: 'getLive', deviceKey: coach }).result;
    assert.equal(v.canControl, false);
    assert.equal(err(C.post({ action: 'putLive', deviceKey: coach, baseVersion: v.version, state: { id: 'X', status: 'running' } })), 'not_controller');
    assert.equal(err(C.post({ action: 'setStatus', deviceKey: coach, id: coachId, status: 'approved' })), 'bad_code');
  });

  test('unmarking or revoking a coach takes the minutes away', () => {
    C.post({ action: 'setRole', adminCode: ADMIN, id: coachId, role: 'parent' });
    const r = C.post({ action: 'getSeason', deviceKey: coach }).result;
    assert.equal(r.role, 'parent');
    assert.equal('coach' in r, false);
    assert.equal(err(C.post({ action: 'setCoachMatch', deviceKey: coach, liveId: 'M1', min: 20 })), 'not_coach');
    C.post({ action: 'setRole', adminCode: ADMIN, id: coachId, role: 'coach' });
    C.post({ action: 'setStatus', adminCode: ADMIN, id: coachId, status: 'revoked' });
    assert.equal(err(C.post({ action: 'setCoachMatch', deviceKey: coach, liveId: 'M1', min: 20 })), 'not_approved');
  });
}

// The gallery: parents upload straight to Cloudinary with a signature the
// bridge makes; the list lives in gallery.json. Published at once, hidden
// by any parent, restored or deleted by the manager.
console.log('gallery:');
{
  const G = createBridge({ adminCode: ADMIN });
  const approve = (key, name) => {
    G.post({ action: 'requestAccess', deviceKey: key, name });
    const id = G.post({ action: 'listUsers', adminCode: ADMIN }).result.find((u) => u.name === name).id;
    G.post({ action: 'setStatus', adminCode: ADMIN, id, status: 'approved' });
    return id;
  };
  const noa = 'n'.repeat(64), gal = 'g'.repeat(64), stranger = 's'.repeat(64);
  const noaId = approve(noa, 'אמא של נועם');
  approve(gal, 'אבא של גיא');
  const upload = (key, kind = 'image', extra = {}) => {
    const sig = G.post({ action: 'signUpload', deviceKey: key, kind });
    if (!sig.ok) return sig;
    return G.post({ action: 'addGalleryItem', deviceKey: key, pid: sig.result.public_id, w: 1600, h: 1200, match: { date: '2026-09-19', opponent: 'בני לוד' }, ...extra });
  };

  test('without Cloudinary keys the gallery is off, and nothing is signed', () => {
    assert.equal(G.post({ action: 'getGallery', deviceKey: noa }).result.enabled, false);
    assert.equal(err(G.post({ action: 'signUpload', deviceKey: noa, kind: 'image' })), 'no_gallery');
  });

  G.setProp('CLOUDINARY_CLOUD', 'mg-demo');
  G.setProp('CLOUDINARY_KEY', '123456');
  G.setProp('CLOUDINARY_SECRET', 'shh-secret');

  test('only an approved device gets a signature', () => {
    assert.equal(err(G.post({ action: 'signUpload', deviceKey: stranger, kind: 'image' })), 'not_approved');
    assert.equal(err(G.post({ action: 'getGallery', deviceKey: stranger })), 'not_approved');
  });

  test('the signature is Cloudinary\'s: sorted params and the secret, and the secret never leaves', () => {
    const r = G.post({ action: 'signUpload', deviceKey: noa, kind: 'image' });
    const { public_id, timestamp, allowed_formats, signature } = r.result;
    const expected = createHash('sha1').update(`allowed_formats=${allowed_formats}&public_id=${public_id}&timestamp=${timestamp}shh-secret`).digest('hex');
    assert.equal(signature, expected);
    assert.ok(!JSON.stringify(r).includes('shh-secret'));
    assert.match(public_id, /^mg\/[a-z0-9]+$/);
    assert.ok(!allowed_formats.includes('mp4'), 'an image signature allows video formats');
  });

  test('an upload is published at once and carries the uploader\'s name', () => {
    const r = upload(noa);
    assert.ok(r.ok, JSON.stringify(r));
    const g = G.post({ action: 'getGallery', deviceKey: gal }).result;
    assert.equal(g.items.length, 1);
    assert.equal(g.items[0].byName, 'אמא של נועם');
    assert.equal(g.items[0].mine, false);
    assert.equal('by' in g.items[0], false, 'a parent gets another device\'s id');
  });

  test('a file id the device was not signed for cannot be listed', () => {
    const sig = G.post({ action: 'signUpload', deviceKey: noa, kind: 'image' }).result;
    assert.equal(err(G.post({ action: 'addGalleryItem', deviceKey: gal, pid: sig.public_id })), 'bad_upload');
    assert.equal(err(G.post({ action: 'addGalleryItem', deviceKey: gal, pid: 'mg/made-up' })), 'bad_upload');
  });

  test('the daily limit is kept per device and per kind', () => {
    G.post({ action: 'setGallery', adminCode: ADMIN, dayPhotos: 2, dayVideos: 1 });
    assert.ok(upload(gal).ok && upload(gal).ok);
    assert.equal(err(G.post({ action: 'signUpload', deviceKey: gal, kind: 'image' })), 'quota');
    assert.ok(upload(gal, 'video', { dur: 40 }).ok, 'the photo limit also stopped a video');
    assert.equal(G.post({ action: 'getGallery', deviceKey: gal }).result.left.video, 0);
    G.post({ action: 'setGallery', adminCode: ADMIN, dayPhotos: 30, dayVideos: 3 });
  });

  let item;
  test('any parent hides; the item leaves everyone else\'s gallery, the uploader still sees it', () => {
    item = G.post({ action: 'getGallery', deviceKey: gal }).result.items.find((x) => x.byName === 'אמא של נועם');
    assert.ok(G.post({ action: 'hideGalleryItem', deviceKey: gal, id: item.id, why: 'mine' }).ok);
    assert.ok(!G.post({ action: 'getGallery', deviceKey: gal }).result.items.some((x) => x.id === item.id));
    const own = G.post({ action: 'getGallery', deviceKey: noa }).result.items.find((x) => x.id === item.id);
    assert.equal(own.status, 'hidden');
    assert.equal('hiddenBy' in own, false, 'the uploader learns who hid it');
  });

  test('the manager sees who hid it and why, and restores it', () => {
    const it = G.post({ action: 'getGallery', adminCode: ADMIN }).result.items.find((x) => x.id === item.id);
    assert.deepEqual([it.hiddenBy.name, it.hiddenBy.why], ['אבא של גיא', 'mine']);
    assert.equal(G.post({ action: 'adminPing', adminCode: ADMIN }).result.galleryWaiting, 1);
    assert.equal(err(G.post({ action: 'restoreGalleryItem', deviceKey: noa, id: item.id })), 'bad_code');
    G.post({ action: 'restoreGalleryItem', adminCode: ADMIN, id: item.id });
    assert.ok(G.post({ action: 'getGallery', deviceKey: gal }).result.items.some((x) => x.id === item.id));
  });

  test('only the uploader deletes their own; the file goes from Cloudinary too', () => {
    assert.equal(err(G.post({ action: 'deleteGalleryItem', deviceKey: gal, id: item.id })), 'not_yours');
    assert.ok(G.post({ action: 'deleteGalleryItem', deviceKey: noa, id: item.id }).ok);
    assert.ok(!G.post({ action: 'getGallery', deviceKey: noa }).result.items.some((x) => x.id === item.id));
    const call = G.fetched.find((f) => f.url === 'https://api.cloudinary.com/v1_1/mg-demo/image/destroy');
    assert.ok(call && call.opts.payload.public_id === item.pid, 'no destroy call to Cloudinary');
  });

  test('several items go in one call; a selection with someone else\'s is refused whole', () => {
    const a = upload(noa).result, b2 = upload(noa).result, theirs = upload(gal).result;
    assert.equal(err(G.post({ action: 'deleteGalleryItem', deviceKey: noa, ids: [a.id, theirs.id] })), 'not_yours');
    const left = () => G.post({ action: 'getGallery', adminCode: ADMIN }).result.items.map((x) => x.id);
    assert.ok([a.id, b2.id, theirs.id].every((id) => left().includes(id)), 'a refused selection deleted something');
    const before = G.fetched.length;
    assert.equal(G.post({ action: 'deleteGalleryItem', deviceKey: noa, ids: [a.id, b2.id] }).result.deleted, 2);
    assert.ok(![a.id, b2.id].some((id) => left().includes(id)));
    assert.equal(G.fetched.length - before, 2, 'each file is destroyed at Cloudinary');
    assert.equal(G.post({ action: 'deleteGalleryItem', adminCode: ADMIN, ids: [theirs.id] }).result.deleted, 1, 'the manager deletes anyone\'s');
  });

  test('review mode holds new uploads back from others; closed takes uploads away', () => {
    G.post({ action: 'setGallery', adminCode: ADMIN, mode: 'review' });
    const r = upload(noa).result;
    assert.equal(r.status, 'pending');
    assert.ok(!G.post({ action: 'getGallery', deviceKey: gal }).result.items.some((x) => x.id === r.id));
    G.post({ action: 'setGallery', adminCode: ADMIN, mode: 'closed' });
    assert.equal(err(G.post({ action: 'signUpload', deviceKey: noa, kind: 'image' })), 'closed');
    assert.equal(err(G.post({ action: 'setGallery', deviceKey: noa, mode: 'open' })), 'bad_code');
    G.post({ action: 'setGallery', adminCode: ADMIN, mode: 'open' });
  });

  test('a blocked device keeps watching but cannot upload', () => {
    G.post({ action: 'blockUploader', adminCode: ADMIN, id: noaId, blocked: true });
    assert.equal(err(G.post({ action: 'signUpload', deviceKey: noa, kind: 'image' })), 'blocked');
    assert.equal(G.post({ action: 'getGallery', deviceKey: noa }).result.blocked, true);
    G.post({ action: 'blockUploader', adminCode: ADMIN, id: noaId, blocked: false });
    assert.ok(G.post({ action: 'signUpload', deviceKey: noa, kind: 'image' }).ok);
  });

  test('the gallery never lands in the season file', () => {
    assert.equal(G.driveFile('season.json'), null);
    assert.ok(G.driveFile('gallery.json'));
    assert.ok(!G.driveFile('gallery.json').includes(noa), 'a raw device key in Drive');
  });
}

console.log(`\nbridge: ${passed} passed`);
