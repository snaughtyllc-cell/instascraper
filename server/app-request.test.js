const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const { appRequest } = require('./test-support/app-request');

test('appRequest uses Express JSON parsing and query handling', async () => {
  const app = express();
  app.use(express.json());
  app.post('/echo', (req, res) => res.status(201).json({ input: req.body, query: req.query }));
  const response = await appRequest(app, { method: 'POST', path: '/echo?q=hello%20world', body: { value: 42 } });
  assert.equal(response.status, 201);
  assert.match(response.headers['content-type'], /application\/json/);
  assert.deepEqual(response.body, { input: { value: 42 }, query: { q: 'hello world' } });
  assert.deepEqual(JSON.parse(response.text), response.body);
});

test('appRequest preserves cookies, sessions, and custom request/response headers', async () => {
  const app = express();
  app.use(session({ secret: 'fake-session-secret', resave: false, saveUninitialized: false }));
  app.get('/session', (req, res) => {
    req.session.count = (req.session.count || 0) + 1;
    res.set('x-echo', req.get('x-custom'));
    res.json({ count: req.session.count });
  });
  const first = await appRequest(app, { path: '/session', headers: { 'X-Custom': 'first' } });
  assert.equal(first.headers['x-echo'], 'first');
  assert.deepEqual(first.body, { count: 1 });
  assert.ok(Array.isArray(first.headers['set-cookie']));
  const cookie = first.headers['set-cookie'].map(value => value.split(';')[0]).join('; ');
  const second = await appRequest(app, { path: '/session', headers: { Cookie: cookie, 'X-Custom': 'second' } });
  assert.equal(second.headers['x-echo'], 'second');
  assert.deepEqual(second.body, { count: 2 });
});

test('appRequest passes rejected async routes through error middleware', async () => {
  const app = express();
  app.get('/error', (req, res, next) => Promise.reject(new Error('fake outage')).catch(next));
  app.use((error, req, res, next) => res.status(503).json({ error: error.message }));
  const response = await appRequest(app, { path: '/error' });
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, { error: 'fake outage' });
});

test('appRequest uses the Express 404 handler and keeps non-JSON text', async () => {
  const response = await appRequest(express(), { path: '/missing' });
  assert.equal(response.status, 404);
  assert.match(response.text, /Cannot GET \/missing/);
  assert.equal(response.body, response.text);
});

test('appRequest decodes streamed chunked responses without losing UTF-8 bytes', async () => {
  const app = express();
  app.get('/stream', (req, res) => {
    res.type('text');
    res.write('hello ');
    const unicode = Buffer.from('世界');
    res.write(unicode.subarray(0, 2));
    res.end(unicode.subarray(2));
  });
  const response = await appRequest(app, { path: '/stream' });
  assert.equal(response.status, 200);
  assert.equal(response.headers['transfer-encoding'], 'chunked');
  assert.equal(response.text, 'hello 世界');
  assert.equal(response.body, response.text);
});
