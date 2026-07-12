// server/auth.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { hashPassword, verifyPassword, resolveLogin, modelAccessErrorStatus, LoginThrottle } = require('./auth');

test('hash/verify round-trips and rejects wrong password', () => {
  const h = hashPassword('s3cret!');
  assert.ok(verifyPassword('s3cret!', h));
  assert.strictEqual(verifyPassword('nope', h), false);
});

test('resolveLogin: no email → admin when team password matches', () => {
  const adminPasswordHash = hashPassword('teampw');
  const r = resolveLogin({ password: 'teampw' }, { adminPasswordHash, models: [] });
  assert.deepStrictEqual(r, { ok: true, user: { id: 0, role: 'admin', modelId: null } });
});

test('resolveLogin: wrong admin password rejected', () => {
  const r = resolveLogin({ password: 'x' }, { adminPasswordHash: hashPassword('teampw'), models: [] });
  assert.strictEqual(r.ok, false);
});

test('resolveLogin: model email+password requires login_enabled AND status=active', () => {
  const models = [{ id: 7, email: 'mia@x.com', password_hash: hashPassword('pw'), role: 'model', login_enabled: 1, status: 'active' }];
  const ok = resolveLogin({ email: 'mia@x.com', password: 'pw' }, { adminPasswordHash: null, models });
  assert.deepStrictEqual(ok, { ok: true, user: { id: 7, role: 'model', modelId: 7 } });
  const disabled = resolveLogin({ email: 'mia@x.com', password: 'pw' }, { adminPasswordHash: null, models: [{ ...models[0], login_enabled: 0 }] });
  assert.strictEqual(disabled.ok, false);
  const inactive = resolveLogin({ email: 'mia@x.com', password: 'pw' }, { adminPasswordHash: null, models: [{ ...models[0], status: 'inactive' }] });
  assert.strictEqual(inactive.ok, false, 'deleted/deactivated model cannot log in [R1-#5]');
  const wrong = resolveLogin({ email: 'mia@x.com', password: 'bad' }, { adminPasswordHash: null, models });
  assert.strictEqual(wrong.ok, false);
});
test('resolveLogin: a stored role=admin on a model row does NOT grant admin [R1-#7]', () => {
  const models = [{ id: 9, email: 'x@x.com', password_hash: hashPassword('pw'), role: 'admin', login_enabled: 1, status: 'active' }];
  const r = resolveLogin({ email: 'x@x.com', password: 'pw' }, { adminPasswordHash: null, models });
  assert.deepStrictEqual(r, { ok: true, user: { id: 9, role: 'model', modelId: 9 } });
});

test('model access distinguishes an expired session from a disabled or wrong-role account', () => {
  assert.strictEqual(modelAccessErrorStatus(null, { authEnabled: true }), 401);
  assert.strictEqual(modelAccessErrorStatus(null, { authEnabled: false }), 403);
  assert.strictEqual(modelAccessErrorStatus({ role: 'admin', modelId: null }, { authEnabled: true }), 403);
  assert.strictEqual(modelAccessErrorStatus({ role: 'model', modelId: 7 }, { authEnabled: true }), null);
});

test('LoginThrottle blocks after max failures and resets', () => {
  const t = new LoginThrottle({ max: 2, windowMs: 60000, now: () => 1000 });
  assert.strictEqual(t.check('a').blocked, false);
  t.fail('a'); t.fail('a');
  assert.strictEqual(t.check('a').blocked, true);
  t.reset('a');
  assert.strictEqual(t.check('a').blocked, false);
});

test('LoginThrottle bounds random-email memory growth', () => {
  const throttle = new LoginThrottle({ maxEntries: 3 });
  for (const key of ['a', 'b', 'c', 'd', 'e']) throttle.fail(key);
  assert.ok(throttle.hits.size <= 3);
  assert.ok(throttle.hits.has('e'));
});
