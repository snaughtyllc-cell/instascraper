process.env.AUTH_PASSWORD = ''; // disable auth for the smoke test (mirrors integration.test.js)
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');

function req(server, method, path, body) {
  const { port } = server.address();
  const data = body ? JSON.stringify(body) : null;
  return new Promise((resolve) => {
    const r = http.request({ port, path, method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    if (data) r.write(data);
    r.end();
  });
}

test('radar routes: validation wiring (no DB dependency on the 400 paths)', async () => {
  const app = require('./index'); // exports app without listening
  const server = app.listen(0);
  try {
    // empty term → 400 term_required (returns before touching the DB)
    let r = await req(server, 'POST', '/radar/terms', {});
    assert.strictEqual(r.status, 400);
    assert.match(r.body, /term_required/);
    // bad status → 400 bad_status (returns before touching the DB)
    r = await req(server, 'PATCH', '/radar/terms/1', { status: 'nope' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body, /bad_status/);
  } finally { server.close(); }
});
