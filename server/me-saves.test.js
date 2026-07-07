// server/me-saves.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { saveParams } = require('./me-saves');
test('saveParams uses the session modelId, coerces postId to int', () => {
  assert.deepStrictEqual(saveParams(7, '42'), { modelId: 7, postId: 42 });
});
test('saveParams rejects a non-numeric or out-of-int4 postId', () => {
  assert.strictEqual(saveParams(7, 'abc'), null);
  assert.strictEqual(saveParams(7, '3000000000'), null); // > int4 max
});
