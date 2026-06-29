const { test } = require('node:test');
const assert = require('node:assert');
const health = require('./health');
const { initWithRetry } = require('./db-health');

test('readiness latch starts false, flips true, stays true', () => {
  health.resetForTest();
  assert.equal(health.isReady(), false);
  health.markReady();
  assert.equal(health.isReady(), true);
});

test('initWithRetry retries transient then succeeds', async () => {
  let n = 0;
  await initWithRetry(async () => { n++; if (n < 3) { const e = new Error('dns'); e.code = 'ENOTFOUND'; throw e; } },
    { maxAttempts: 5, baseDelayMs: 1 });
  assert.equal(n, 3);
});

test('initWithRetry fails fast on auth error', async () => {
  let n = 0;
  await assert.rejects(() => initWithRetry(async () => { n++; const e = new Error('bad pw'); e.code = '28P01'; throw e; },
    { maxAttempts: 5, baseDelayMs: 1 }));
  assert.equal(n, 1, 'should not retry auth errors');
});
