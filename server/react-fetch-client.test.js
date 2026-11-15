const { test } = require('node:test');
const assert = require('node:assert/strict');

const sqlitePath = process.env.SQLITE_PATH;
process.env.SQLITE_PATH = ':memory:';
const { createApifyClient } = require('./react-fetch');
if (sqlitePath === undefined) delete process.env.SQLITE_PATH;
else process.env.SQLITE_PATH = sqlitePath;

const response = (status, body) => ({ ok: status >= 200 && status < 300, status,
  json: async () => body, body: { destroy() {} } });
const signal = () => new AbortController().signal;
const noSleep = async () => {};

function captureErrors(t) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  t.after(() => { console.error = original; });
  return lines;
}

test('Apify client authenticates every route with query token and configures run memory', async () => {
  const requests = [], token = 'secret-token&hidden=value';
  const client = createApifyClient({ APIFY_API_KEY: token, REACT_FETCH_MEMORY_MB: '1024' }, async (url, options) => {
    requests.push({ url: new URL(url), options });
    return response(200, { data: { id: 'run-id' } });
  }, noSleep, 180000);
  const input = { directUrls: ['https://www.instagram.com/reel/example/'], resultsLimit: 1 };
  await client.startRun('apify~instagram-reel-scraper', input, signal());
  await client.getRun('run-id', signal());
  await client.getItems('run-id', signal());
  await client.abortRun('run-id', signal());
  assert.deepEqual(requests.map(item => item.url.pathname), [
    '/v2/acts/apify~instagram-reel-scraper/runs', '/v2/actor-runs/run-id',
    '/v2/actor-runs/run-id/dataset/items', '/v2/actor-runs/run-id/abort',
  ]);
  for (const { url, options } of requests) {
    assert.equal(url.searchParams.get('token'), token);
    assert.deepEqual(options.headers, { 'Content-Type': 'application/json' });
    assert.equal(options.redirect, 'manual');
  }
  assert.equal(requests[0].url.searchParams.get('timeout'), '180');
  assert.equal(requests[0].url.searchParams.get('memory'), '1024');
  assert.deepEqual(JSON.parse(requests[0].options.body), input);
  assert.equal(requests[3].url.searchParams.get('gracefully'), 'false');
});

test('Apify run memory defaults to 512 for absent or invalid configuration', async () => {
  for (const memory of [undefined, '0', '-1', 'not-a-number', '512.5']) {
    let requested;
    const client = createApifyClient({ APIFY_API_KEY: 'secret', REACT_FETCH_MEMORY_MB: memory }, async url => {
      requested = new URL(url);
      return response(200, { data: { id: 'run-id' } });
    }, noSleep, 180000);
    await client.startRun('actor', {}, signal());
    assert.equal(requested.searchParams.get('memory'), '512');
  }
});

test('HTTP failures log exactly one sanitized line per response on every route', async t => {
  const lines = captureErrors(t);
  const token = 'secret-token';
  const client = createApifyClient({ APIFY_API_KEY: token }, async () => response(401, {
    error: { type: 'invalid-token', message: `https://example.com?token=${token}` },
    dataset: [{ videoUrl: 'https://private.example/video' }],
  }), noSleep, 180000);
  await assert.rejects(client.startRun('actor', {}, signal()), { code: 'apify_failed', message: 'apify_failed' });
  await assert.rejects(client.getRun('run-id', signal()), { code: 'apify_failed' });
  await assert.rejects(client.getItems('run-id', signal()), { code: 'apify_failed' });
  await assert.rejects(client.abortRun('run-id', signal()), { code: 'apify_failed' });
  assert.deepEqual(lines, ['startRun', 'getRun', 'getItems', 'abortRun'].map(route =>
    `[React fetch] apify_http route=${route} status=401 type=invalid-token`));
  assert.ok(!lines.join('\n').includes(token));
  assert.ok(!lines.join('\n').includes('https://'));
  assert.ok(!lines.join('\n').includes('dataset'));
});

test('untrusted or token-bearing error types are replaced with a static placeholder', async t => {
  const lines = captureErrors(t);
  for (const type of ['bad\ntype', 'https://example.com/token', 'CAPITALS', 'x'.repeat(65),
    'secret-token', 'error-secret-token', undefined, 7]) {
    const client = createApifyClient({ APIFY_API_KEY: 'secret-token' }, async () => response(400, {
      error: { type, message: 'secret-token' },
    }), noSleep, 180000);
    await assert.rejects(client.getRun('run-id', signal()), { code: 'apify_failed' });
  }
  assert.ok(lines.every(line => line === '[React fetch] apify_http route=getRun status=400 type=unknown'));
});

test('non-JSON HTTP errors still emit a sanitized diagnostic', async t => {
  const lines = captureErrors(t);
  const client = createApifyClient({ APIFY_API_KEY: 'secret-token' }, async () => ({
    ...response(400), json: async () => { throw new Error('https://example.com/secret-token'); },
  }), noSleep, 180000);
  await assert.rejects(client.getItems('run-id', signal()), { code: 'apify_failed' });
  assert.deepEqual(lines, ['[React fetch] apify_http route=getItems status=400 type=unknown']);
});

test('capacity statuses and error types back off three times then fail apify_busy', async t => {
  const lines = captureErrors(t);
  const cases = [
    { status: 402, type: 'payment-required' }, { status: 429, type: 'too-many-requests' },
    { status: 503, type: 'service-unavailable' }, { status: 400, type: 'actor-memory-limit-exceeded' },
    { status: 400, type: 'concurrent-runs-exceeded' }, { status: 400, type: 'rate-exceeded' },
    { status: 400, type: 'MEMORY\nsecret-token' },
  ];
  for (const { status, type } of cases) {
    let calls = 0;
    const waits = [];
    const client = createApifyClient({ APIFY_API_KEY: 'secret-token' }, async () => {
      calls++;
      return response(status, { error: { type } });
    }, async ms => { waits.push(ms); }, 180000);
    await assert.rejects(client.startRun('actor', {}, signal()), { code: 'apify_busy', message: 'apify_busy' });
    assert.equal(calls, 4);
    assert.deepEqual(waits, [15000, 30000, 60000]);
  }
  assert.equal(lines.length, cases.length * 4);
  assert.ok(!lines.join('\n').includes('secret-token'));
});

test('403 never retries even when its error type names a limit', async t => {
  captureErrors(t);
  let calls = 0;
  const client = createApifyClient({ APIFY_API_KEY: 'secret-token' }, async () => {
    calls++;
    return response(403, { error: { type: 'actor-memory-limit-exceeded' } });
  }, async () => { assert.fail('403 must not back off'); }, 180000);
  await assert.rejects(client.getRun('run-id', signal()), { code: 'apify_failed' });
  assert.equal(calls, 1);
});

test('a transient response retries successfully while a short remaining window fails busy', async t => {
  captureErrors(t);
  let calls = 0;
  const waits = [];
  const client = createApifyClient({ APIFY_API_KEY: 'secret-token' }, async () => {
    calls++;
    return calls === 1 ? response(402, { error: { type: 'memory-limit' } }) : response(200, { data: { id: 'run-id' } });
  }, async ms => { waits.push(ms); }, 180000);
  assert.deepEqual(await client.startRun('actor', {}, signal()), { id: 'run-id' });
  assert.deepEqual(waits, [15000]);
  const bounded = createApifyClient({ APIFY_API_KEY: 'secret-token' }, async () => response(402),
    async () => { assert.fail('backoff cannot exceed the remaining window'); }, 1000);
  await assert.rejects(bounded.getRun('run-id', signal()), { code: 'apify_busy' });
});

test('network exceptions expose only apify_network and aborted requests preserve fetch_timeout', async () => {
  const client = createApifyClient({ APIFY_API_KEY: 'secret-token' }, async () => {
    throw new Error('request https://api.apify.com?token=secret-token failed');
  }, noSleep, 180000);
  await assert.rejects(client.getRun('run-id', signal()), { code: 'apify_network', message: 'apify_network' });
  const controller = new AbortController();
  const aborted = createApifyClient({ APIFY_API_KEY: 'secret-token' }, async () => {
    controller.abort();
    throw new Error('secret-token');
  }, noSleep, 180000);
  await assert.rejects(aborted.getRun('run-id', controller.signal), { code: 'fetch_timeout', message: 'fetch_timeout' });
});

test('aborting during backoff exits promptly without sending another request', async t => {
  captureErrors(t);
  const controller = new AbortController();
  let calls = 0;
  const client = createApifyClient({ APIFY_API_KEY: 'secret-token' }, async () => {
    calls++;
    return response(402);
  }, async (_ms, currentSignal) => {
    assert.equal(currentSignal, controller.signal);
    controller.abort();
    await new Promise(() => {});
  }, 180000);
  await assert.rejects(client.getRun('run-id', controller.signal), { code: 'fetch_timeout' });
  assert.equal(calls, 1);
});

test('aborting the default backoff clears its pending timer', async t => {
  captureErrors(t);
  const timer = {}, scheduled = [], cleared = [];
  t.mock.method(global, 'setTimeout', (_callback, ms) => { scheduled.push(ms); return timer; });
  t.mock.method(global, 'clearTimeout', value => { cleared.push(value); });
  const controller = new AbortController();
  const client = createApifyClient({ APIFY_API_KEY: 'secret-token' }, async () => response(402));
  const pending = client.getRun('run-id', controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(scheduled, [15000]);
  controller.abort();
  await assert.rejects(pending, { code: 'fetch_timeout' });
  assert.deepEqual(cleared, [timer]);
});
