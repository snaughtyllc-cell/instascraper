const { test } = require('node:test');
const assert = require('node:assert');
const health = require('./health');
const { appRequest } = require('./test-support/app-request');

test('wrapAsyncRoutes turns a rejected async route into a 503 (not a hang/crash)', async () => {
  const express = require('express');
  const { wrapAsyncRoutes, dbErrorMiddleware } = require('./db-health');
  const a = express();
  wrapAsyncRoutes(a);
  a.get('/boom', async () => { const e = new Error('db down'); e.code = 'ECONNREFUSED'; throw e; });
  a.use(dbErrorMiddleware);
  const r = await appRequest(a, { path: '/boom' });
  assert.equal(r.status, 503, 'a DB-rejecting route returns a clean 503');
});

test('/live always 200, /ready reflects latch', async () => {
  process.env.AUTH_PASSWORD = ''; // disable auth for the smoke test
  health.resetForTest();
  const app = require('./index'); // must export app without listening
  let r = await appRequest(app, { path: '/live' });
  assert.equal(r.status, 200);
  r = await appRequest(app, { path: '/ready' });
  assert.equal(r.status, 503, 'not ready before init');
  health.markReady();
  r = await appRequest(app, { path: '/ready' });
  assert.equal(r.status, 200, 'ready after latch');
});
