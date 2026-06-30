const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { buildCadenceAccounts, cadenceConfig } = require('./scheduler');

// posts.account_handle is raw-case; tracked_accounts.username is lowercased.
// The frequency query folds account_handle to lowercase so the in-memory join
// in buildCadenceAccounts (keyed on the lowercased tracked username) matches.
test('freq GROUP BY LOWER(account_handle) yields lowercase keys that join to tracked username', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE posts (account_handle TEXT, soft_deleted INTEGER DEFAULT 0)");
  const ins = db.prepare("INSERT INTO posts (account_handle) VALUES (?)");
  ins.run('TheRock'); ins.run('therock'); ins.run('THEROCK'); // same creator, mixed case

  const freqRows = db.prepare(
    `SELECT LOWER(account_handle) AS username, COUNT(*) AS recent_post_count
     FROM posts WHERE (soft_deleted = 0 OR soft_deleted IS NULL)
     GROUP BY LOWER(account_handle)`
  ).all();

  // one bucket, lowercased, all three counted
  assert.strictEqual(freqRows.length, 1);
  assert.strictEqual(freqRows[0].username, 'therock');
  assert.strictEqual(Number(freqRows[0].recent_post_count), 3);

  // joins to the lowercased tracked username → non-zero postsPerWeek (not silently 0)
  const cfg = cadenceConfig({});
  const accounts = buildCadenceAccounts([{ username: 'therock' }], freqRows, cfg);
  assert.ok(accounts[0].postsPerWeek > 0, 'mixed-case posts should count toward cadence frequency');
});

// The 3 failure-recording sites + success reset key on the lowercased identifier.
test('failure/reset updates match a lowercased tracked username regardless of query case', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE tracked_accounts (username TEXT UNIQUE, consecutive_failures INTEGER DEFAULT 0)");
  db.prepare("INSERT INTO tracked_accounts (username, consecutive_failures) VALUES ('therock', 0)").run();

  // mirrors scraper.js: filters.query.replace('@','').toLowerCase()
  const param = '@TheRock'.replace('@', '').toLowerCase();
  db.prepare("UPDATE tracked_accounts SET consecutive_failures = COALESCE(consecutive_failures,0)+1 WHERE username = ?").run(param);
  assert.strictEqual(db.prepare("SELECT consecutive_failures c FROM tracked_accounts WHERE username='therock'").get().c, 1);

  // success reset keys on (accountHandle||'').toLowerCase()
  db.prepare("UPDATE tracked_accounts SET consecutive_failures = 0 WHERE username = ?").run(('TheRock').toLowerCase());
  assert.strictEqual(db.prepare("SELECT consecutive_failures c FROM tracked_accounts WHERE username='therock'").get().c, 0);
});
