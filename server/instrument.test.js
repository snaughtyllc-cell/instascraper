const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const uploadUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=SENTINEL_UPLOAD_SECRET';
const rawUrl = 'https://hq.example.test/raw/SENTINEL_RAW_SECRET.mp4?signature=SENTINEL_RAW_SIGNATURE';
const key = 'SENTINEL_SERVICE_KEY';

// Exercise the actual initialization hooks with a fake SDK. Tests never patch
// HTTP modules or create a Sentry transport, even if the developer has a DSN.
function instrument(env = {}) {
  let options;
  const sdk = {
    init: value => { options = value; },
    httpIntegration: value => ({ name: 'Http', options: value }),
  };
  const module = { exports: {} };
  const context = {
    require: name => name === '@sentry/node' ? sdk
      : name === 'dotenv' ? { config() {} } : require(name),
    process: { env: { SENTRY_DSN: 'fake-dsn', HQ_PUBLIC_URL: 'https://hq.example.test', FILM_SERVICE_KEY: key, ...env } },
    __dirname, module, URL,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'instrument.js'), 'utf8'), context);
  assert.equal(module.exports, sdk, 'existing module export remains the SDK');
  return options;
}

test('Sentry remains inert without a DSN', () => {
  assert.equal(instrument({ SENTRY_DSN: '' }), undefined);
});

test('HTTP instrumentation excludes Drive capabilities and all allowed HQ source paths', () => {
  const http = instrument().integrations[0].options;
  for (const url of [uploadUrl, rawUrl, 'https://hq.example.test/api/filming/react/callback']) {
    assert.equal(http.ignoreOutgoingRequests(url), true);
  }
  for (const url of ['https://example.test/resource', 'https://www.googleapis.com/drive/v3/files', 'https://hq.example.test.attacker.test/raw', 'malformed']) {
    assert.equal(http.ignoreOutgoingRequests(url), false);
  }
  for (const url of ['/film/v1/react-render', '/FILM/v1/REACT-RENDER/?ignored=1', 'https://scraper.example/film/v1/react-render']) {
    assert.equal(http.ignoreIncomingRequestBody(url), true);
  }
  assert.equal(http.ignoreIncomingRequestBody('/film/v1/react-reference'), false);
  assert.equal(http.ignoreIncomingRequestBody('/film/v1/react-render/extra'), false);
});

test('sensitive breadcrumbs and structured logs cannot carry URLs or credentials', () => {
  const options = instrument();
  for (const breadcrumb of [
    { category: 'http', data: { url: uploadUrl } },
    { category: 'http', data: { url: rawUrl } },
    { category: 'console', message: `PUT ${uploadUrl} failed` },
    { category: 'console', data: { nested: { rawUrl } } },
    { category: 'console', message: JSON.stringify({ uploadUrl }) },
    { category: 'console', message: `Bearer ${key}` },
    { category: 'console', data: { upload_id: 'SENTINEL_UPLOAD_SECRET' } },
  ]) {
    assert.equal(options.beforeBreadcrumb(breadcrumb), null);
    assert.equal(options.beforeSendLog(breadcrumb), null);
  }
  const unrelated = { category: 'http', data: { url: 'https://example.test/feed?limit=5', status_code: 200 } };
  assert.equal(options.beforeBreadcrumb(unrelated), unrelated);
  assert.equal(options.beforeSendLog(unrelated), unrelated);
});

test('incoming render events omit body, query, metadata and all headers while preserving the error', () => {
  const options = instrument();
  const event = {
    exception: { values: [{ type: 'Error', value: 'safe failure' }] },
    request: {
      method: 'POST', url: 'https://scraper.example/FILM/v1/REACT-RENDER/?rawUrl=SENTINEL_RAW_SECRET',
      headers: { Authorization: `Bearer ${key}`, 'X-Capability': uploadUrl, Referer: rawUrl },
      cookies: { session: 'SENTINEL_COOKIE' }, query_string: `upload_id=SENTINEL_UPLOAD_SECRET`,
      data: { uploadUrl, rawUrl, callbackUrl: 'https://hq.example.test/callback' },
    },
    sdkProcessingMetadata: { normalizedRequest: { data: { uploadUrl }, headers: { authorization: key } } },
    breadcrumbs: [{ category: 'http', data: { url: uploadUrl } }, { category: 'console', message: 'worker_error' }],
  };
  const filtered = options.beforeSend(event);
  assert.ok(filtered);
  assert.equal(filtered.exception, event.exception);
  assert.equal(filtered.request.url, '/film/v1/react-render');
  assert.equal(filtered.request.method, 'POST');
  assert.equal(Object.keys(filtered.request).length, 2);
  assert.equal(filtered.sdkProcessingMetadata, undefined);
  assert.equal(filtered.breadcrumbs.length, 1);
  assert.equal(filtered.breadcrumbs[0].message, 'worker_error');
  assert.doesNotMatch(JSON.stringify(filtered), /SENTINEL_|upload_id|hq\.example|googleapis/);
  assert.ok(event.request.data.uploadUrl, 'filter does not mutate the captured input');
});

test('final event filter drops secrets anywhere and keeps unrelated telemetry intact', () => {
  const options = instrument();
  for (const event of [
    { message: `request failed ${uploadUrl}` },
    { extra: { source: rawUrl } },
    { request: { headers: { Authorization: `Bearer ${key}` } } },
  ]) assert.equal(options.beforeSend(event), null);
  const unrelated = {
    message: 'normal server failure', request: { url: 'https://scraper.example/models', headers: { 'X-Request-ID': 'abc' }, data: { name: 'model' } },
  };
  assert.equal(options.beforeSend(unrelated), unrelated);
});
