const { test } = require('node:test');
const assert = require('node:assert');
const { isAllowedOrigin } = require('./security');

process.env.AUTH_PASSWORD = ''; // keep app import from hashing a real password
const app = require('./index');
const { checkProdSecrets } = app;

const strong = { DATABASE_URL: 'postgresql://user:pass@db.example.test/app', SESSION_SECRET: 'x'.repeat(32), AUTH_PASSWORD: 'a-strong-team-pw!' };

test('checkProdSecrets: no-op outside production', () => {
  assert.deepStrictEqual(checkProdSecrets({ NODE_ENV: 'development' }), []);
  assert.deepStrictEqual(checkProdSecrets({}), []);
});

test('checkProdSecrets: clean prod config passes', () => {
  assert.deepStrictEqual(checkProdSecrets({ NODE_ENV: 'production', ...strong }), []);
});

test('checkProdSecrets: production requires PostgreSQL', () => {
  const problems = checkProdSecrets({ NODE_ENV: 'production', SESSION_SECRET: strong.SESSION_SECRET, AUTH_PASSWORD: strong.AUTH_PASSWORD });
  assert.ok(problems.some(p => /DATABASE_URL/.test(p)));
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

test('production CORS allows no-origin, same-origin, and configured origins only', () => {
  const env = { NODE_ENV: 'production', CORS_ORIGINS: 'https://models.example.com' };
  assert.strictEqual(isAllowedOrigin(null, 'app.example.com', env), true);
  assert.strictEqual(isAllowedOrigin('https://app.example.com', 'app.example.com', env), true);
  assert.strictEqual(isAllowedOrigin('https://models.example.com/', 'app.example.com', env), true);
  assert.strictEqual(isAllowedOrigin('https://evil.example.com', 'app.example.com', env), false);
  assert.strictEqual(isAllowedOrigin('not a url', 'app.example.com', env), false);
});

test('development CORS permits local cross-origin clients', () => {
  assert.strictEqual(isAllowedOrigin('http://localhost:3000', 'localhost:4000', { NODE_ENV: 'development' }), true);
});
