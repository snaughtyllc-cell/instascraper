// server/model-credentials.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildCredentialFields, buildModelWriteColumns } = require('./model-credentials');

test('password provided → includes a bcrypt hash, never plaintext', () => {
  const f = buildCredentialFields({ email: 'a@b.com', password: 'pw', login_enabled: 1 });
  assert.strictEqual(f.email, 'a@b.com');
  assert.strictEqual(f.login_enabled, 1);
  assert.ok(f.password_hash && f.password_hash !== 'pw' && f.password_hash.startsWith('$2'));
});

test('no password → no password_hash key (leave existing untouched)', () => {
  const f = buildCredentialFields({ email: 'a@b.com' });
  assert.ok(!('password_hash' in f));
});

test('role is NEVER settable from the model form [R1-#7]', () => {
  const f = buildCredentialFields({ email: 'a@b.com', role: 'admin', password: 'pw' });
  assert.ok(!('role' in f), 'role must not appear in the credential fields');
});

// [R1-#8] The dynamic INSERT/UPDATE column builder must ONLY ever emit columns that are
// in the allowlist, and must take values from a hand-built `merged` object — never from
// Object.keys(req.body). This test proves both halves of that defense:
//   1. the real wiring (base fields pulled by name + buildCredentialFields(body) merged in)
//      never lets role/status/id/a client-supplied password_hash reach the column list;
//   2. even if a rogue key somehow ended up ON the merged object directly (a future
//      refactor mistake), buildModelWriteColumns still filters by the allowlist alone —
//      unlisted columns are structurally impossible to write.
test('buildModelWriteColumns: malicious body keys can never become writable columns [R1-#8]', () => {
  const ALLOWLIST = ['name', 'primary_niche', 'secondary_niches', 'delivery_method', 'delivery_contact', 'delivery_day', 'email', 'login_enabled', 'password_hash'];
  const maliciousBody = { name: 'x', primary_niche: 'y', role: 'admin', password_hash: 'client-supplied-hash', status: 'z', id: 99 };

  // (1) Simulates the real index.js wiring: base fields pulled by name, credential
  // fields merged in via buildCredentialFields(req.body) — never a raw spread of req.body.
  const merged = { name: maliciousBody.name, primary_niche: maliciousBody.primary_niche, ...buildCredentialFields(maliciousBody) };
  let built = buildModelWriteColumns(merged, ALLOWLIST);
  assert.deepStrictEqual(built.columns, ['name', 'primary_niche']);
  assert.deepStrictEqual(built.placeholders, ['$1', '$2']);
  assert.deepStrictEqual(built.params, ['x', 'y']);

  // (2) Defense in depth: even if role/status/id/password_hash were directly present on
  // the merged object, the allowlist alone keeps them out of the emitted column list.
  const contaminated = { ...merged, role: 'admin', status: 'inactive', id: 99 };
  built = buildModelWriteColumns(contaminated, ALLOWLIST);
  assert.ok(!built.columns.includes('role'), 'role must never be a writable column');
  assert.ok(!built.columns.includes('status'), 'status must never be a writable column');
  assert.ok(!built.columns.includes('id'), 'id must never be a writable column');
});

// [CRITICAL] The dev/test SQLite adapter converts $n → ? with a naive global regex and NO
// dedup, so placeholders must be numbered sequentially with no gaps and no reuse.
test('buildModelWriteColumns numbers placeholders sequentially with no gaps or reuse', () => {
  const ALLOWLIST = ['name', 'primary_niche', 'secondary_niches', 'delivery_method', 'delivery_contact', 'delivery_day', 'email', 'login_enabled', 'password_hash'];
  const merged = { name: 'x', primary_niche: 'y', email: 'a@b.com', login_enabled: 1 };
  const { columns, placeholders, params } = buildModelWriteColumns(merged, ALLOWLIST);
  assert.deepStrictEqual(columns, ['name', 'primary_niche', 'email', 'login_enabled']);
  assert.deepStrictEqual(placeholders, ['$1', '$2', '$3', '$4']);
  assert.deepStrictEqual(params, ['x', 'y', 'a@b.com', 1]);
});
