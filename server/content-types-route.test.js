// server/content-types-route.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { validateTypeLabel } = require('./content-types');

// The route's only branching logic is validation; assert it directly so the
// handler stays a thin wrapper (same approach as content-bulk).
test('POST /content-types rejects a blank label before touching the DB', () => {
  const v = validateTypeLabel('   ');
  assert.strictEqual(v.ok, false);
});

test('POST /content-types normalizes a good label to value+label', () => {
  assert.deepStrictEqual(validateTypeLabel('Get Ready'), { ok: true, value: 'get-ready', label: 'Get Ready' });
});
