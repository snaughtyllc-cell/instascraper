process.env.AUTH_PASSWORD = ''; // disable auth for the smoke test (mirrors integration.test.js)
const { test } = require('node:test');
const assert = require('node:assert');
const { appRequest } = require('./test-support/app-request');

test('radar routes: validation wiring (no DB dependency on the 400 paths)', async () => {
  const app = require('./index'); // exports app without listening
  // empty term → 400 term_required (returns before touching the DB)
  let r = await appRequest(app, { method: 'POST', path: '/radar/terms', body: {} });
  assert.strictEqual(r.status, 400);
  assert.match(r.text, /term_required/);
  // bad status → 400 bad_status (returns before touching the DB)
  r = await appRequest(app, { method: 'PATCH', path: '/radar/terms/1', body: { status: 'nope' } });
  assert.strictEqual(r.status, 400);
  assert.match(r.text, /bad_status/);
});
