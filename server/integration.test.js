const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const health = require('./health');

function get(server, path) {
  const { port } = server.address();
  return new Promise((resolve) => {
    http.get({ port, path }, (res) => { let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
  });
}

test('wrapAsyncRoutes turns a rejected async route into a 503 (not a hang/crash)', async () => {
  const express = require('express');
  const { wrapAsyncRoutes, dbErrorMiddleware } = require('./db-health');
  const a = express();
  wrapAsyncRoutes(a);
  a.get('/boom', async () => { const e = new Error('db down'); e.code = 'ECONNREFUSED'; throw e; });
  a.use(dbErrorMiddleware);
  const server = a.listen(0);
  try {
    const r = await get(server, '/boom');
    assert.equal(r.status, 503, 'a DB-rejecting route returns a clean 503');
  } finally { server.close(); }
});

test('/live always 200, /ready reflects latch', async () => {
  process.env.AUTH_PASSWORD = ''; // disable auth for the smoke test
  health.resetForTest();
  const app = require('./index'); // must export app without listening
  const server = app.listen(0);
  try {
    let r = await get(server, '/live');
    assert.equal(r.status, 200);
    r = await get(server, '/ready');
    assert.equal(r.status, 503, 'not ready before init');
    health.markReady();
    r = await get(server, '/ready');
    assert.equal(r.status, 200, 'ready after latch');
  } finally { server.close(); }
});
