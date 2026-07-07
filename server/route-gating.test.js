// server/route-gating.test.js
const { test } = require('node:test');
const assert = require('node:assert');
// A tiny pure model of the gate to lock the intended policy.
function gate(kind, user) {
  if (kind === 'admin') return user && user.role === 'admin';
  if (kind === 'model') return user && user.role === 'model' && !!user.modelId;
  return !!user;
}
test('admin gate: model session denied, admin allowed', () => {
  assert.strictEqual(gate('admin', { role: 'model', modelId: 7 }), false);
  assert.strictEqual(gate('admin', { role: 'admin', modelId: null }), true);
});
test('model gate: admin (no modelId) denied, model allowed', () => {
  assert.strictEqual(gate('model', { role: 'admin', modelId: null }), false);
  assert.strictEqual(gate('model', { role: 'model', modelId: 7 }), true);
});
