const { test } = require('node:test');
const assert = require('node:assert');

process.env.AUTH_PASSWORD = ''; // keep app import from hashing a real password
const app = require('./index');
const { checkProdSecrets } = app;

const strong = { SESSION_SECRET: 'x'.repeat(32), AUTH_PASSWORD: 'a-strong-team-pw!' };

test('checkProdSecrets: no-op outside production', () => {
  assert.deepStrictEqual(checkProdSecrets({ NODE_ENV: 'development' }), []);
  assert.deepStrictEqual(checkProdSecrets({}), []);
});

test('checkProdSecrets: clean prod config passes', () => {
  assert.deepStrictEqual(checkProdSecrets({ NODE_ENV: 'production', ...strong }), []);
});

test('checkProdSecrets: flags missing/dev/short SESSION_SECRET', () => {
  const miss = checkProdSecrets({ NODE_ENV: 'production', AUTH_PASSWORD: strong.AUTH_PASSWORD });
  assert.ok(miss.some(p => /SESSION_SECRET/.test(p)));
  const dev = checkProdSecrets({ NODE_ENV: 'production', AUTH_PASSWORD: strong.AUTH_PASSWORD, SESSION_SECRET: 'instascraper-dev-secret-change-me' });
  assert.ok(dev.some(p => /SESSION_SECRET/.test(p)));
  const short = checkProdSecrets({ NODE_ENV: 'production', AUTH_PASSWORD: strong.AUTH_PASSWORD, SESSION_SECRET: 'tooshort' });
  assert.ok(short.some(p => /SESSION_SECRET/.test(p)));
});

test('checkProdSecrets: flags missing/weak/short AUTH_PASSWORD', () => {
  const miss = checkProdSecrets({ NODE_ENV: 'production', SESSION_SECRET: strong.SESSION_SECRET });
  assert.ok(miss.some(p => /AUTH_PASSWORD/.test(p)));
  const weak = checkProdSecrets({ NODE_ENV: 'production', SESSION_SECRET: strong.SESSION_SECRET, AUTH_PASSWORD: 'test123' });
  assert.ok(weak.some(p => /AUTH_PASSWORD/.test(p)));
  const short = checkProdSecrets({ NODE_ENV: 'production', SESSION_SECRET: strong.SESSION_SECRET, AUTH_PASSWORD: 'short' });
  assert.ok(short.some(p => /AUTH_PASSWORD/.test(p)));
});
