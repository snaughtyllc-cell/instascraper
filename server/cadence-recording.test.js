const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { isTrackedUsernameQuery } = require('./scraper');

test('isTrackedUsernameQuery: username yes; hashtag/url/empty no', () => {
  assert.strictEqual(isTrackedUsernameQuery('sophiamoiss'), true);
  assert.strictEqual(isTrackedUsernameQuery('@sophiamoiss'), true);
  assert.strictEqual(isTrackedUsernameQuery('#dance'), false);
  assert.strictEqual(isTrackedUsernameQuery('https://instagram.com/x/'), false);
  assert.strictEqual(isTrackedUsernameQuery(''), false);
  assert.strictEqual(isTrackedUsernameQuery(null), false);
});

test('failure increment + success reset SQL round-trip (sqlite)', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE tracked_accounts (username TEXT UNIQUE, consecutive_failures INTEGER DEFAULT 0)");
  db.prepare("INSERT INTO tracked_accounts (username, consecutive_failures) VALUES ('a', 0)").run();
  const bump = db.prepare("UPDATE tracked_accounts SET consecutive_failures = COALESCE(consecutive_failures,0) + 1 WHERE username = ?");
  bump.run('a'); bump.run('a');
  assert.strictEqual(db.prepare("SELECT consecutive_failures c FROM tracked_accounts WHERE username='a'").get().c, 2);
  db.prepare("UPDATE tracked_accounts SET consecutive_failures = 0 WHERE username = ?").run('a');
  assert.strictEqual(db.prepare("SELECT consecutive_failures c FROM tracked_accounts WHERE username='a'").get().c, 0);
});
