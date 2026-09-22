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

console.log(`\nbridge: ${passed} passed`);
