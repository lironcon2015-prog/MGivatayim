// Server-side rules of tools/bridge.gs, run against the real file.
//   node tests/bridge.mjs
import { createBridge } from './mock-bridge.mjs';
import assert from 'node:assert/strict';

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
    assert.equal(err(L.post({ action: 'putLive', deviceKey: parent, baseVersion: 4, state: state() })), 'not_approved');
    L.post({ action: 'setStatus', adminCode: ADMIN, id: parentId, status: 'approved' });
  });

  test('finishing writes the result into the season, counted from the events', () => {
    L.post({ action: 'putSeason', adminCode: ADMIN, baseVersion: 0, season: { team: { name: 'מכבי גבעתיים' }, nextMatch: { opponent: 'בני לוד' }, matches: [] } });
    const v = L.post({ action: 'getLive', adminCode: ADMIN }).result.version;
    const ended = state({ status: 'ended', events: [
      { id: 'a', type: 'goal', side: 'us', scorer: 'p1' }, { id: 'b', type: 'goal', side: 'us' }, { id: 'c', type: 'goal', side: 'them' }] });
    const r = L.post({ action: 'finishLive', deviceKey: parent, baseVersion: v, state: ended }).result;
    assert.deepEqual([r.gf, r.ga], [2, 1]);
    const season = L.post({ action: 'getSeason', deviceKey: parent }).result.season;
    assert.equal(season.matches.length, 1);
    assert.equal(season.matches[0].liveId, 'M1');
    assert.equal(season.nextMatch, null);
  });

  test('finishing again after a correction replaces the row, never duplicates it', () => {
    const v = L.post({ action: 'getLive', adminCode: ADMIN }).result.version;
    const ended = state({ status: 'ended', events: [{ id: 'a', type: 'goal', side: 'us' }] });
    L.post({ action: 'finishLive', adminCode: ADMIN, baseVersion: v, state: ended });
    const season = L.post({ action: 'getSeason', adminCode: ADMIN }).result.season;
    assert.equal(season.matches.length, 1);
    assert.deepEqual([season.matches[0].gf, season.matches[0].ga], [1, 0]);
  });

  test('after the match ends the parent\'s control ends with it', () => {
    const v = L.post({ action: 'getLive', adminCode: ADMIN }).result.version;
    assert.equal(err(L.post({ action: 'putLive', deviceKey: parent, baseVersion: v, state: state({ status: 'ended' }) })), 'not_controller');
    assert.equal(L.post({ action: 'getLive', deviceKey: parent }).result.canControl, false);
  });

  test('clearing the live match leaves nothing to watch; a new one can start', () => {
    L.post({ action: 'clearLive', adminCode: ADMIN });
    assert.equal(L.post({ action: 'getLive', deviceKey: parent }).result.state, null);
    assert.ok(L.post({ action: 'startLive', adminCode: ADMIN, state: state({ id: 'M2' }) }).ok);
    assert.deepEqual(L.post({ action: 'getLive', adminCode: ADMIN }).result.control.controllers, []);
  });
}

console.log(`\nbridge: ${passed} passed`);
