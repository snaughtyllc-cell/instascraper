const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { calcER } = require('./scraper');

test('calcER: no/zero/negative followers → 0% and null label (cannot compute)', () => {
  assert.deepStrictEqual(calcER(100, 10, 0), { er_percent: 0, er_label: null });
  assert.deepStrictEqual(calcER(100, 10, undefined), { er_percent: 0, er_label: null });
  assert.deepStrictEqual(calcER(100, 10, -5), { er_percent: 0, er_label: null });
});

test('calcER: computes percent + label bands when followers known', () => {
  assert.deepStrictEqual(calcER(600, 0, 10000), { er_percent: 6, er_label: 'Viral' });   // 6.0% → Viral
  assert.deepStrictEqual(calcER(300, 0, 10000), { er_percent: 3, er_label: 'Good' });     // 3.0% → Good
  assert.deepStrictEqual(calcER(100, 0, 10000), { er_percent: 1, er_label: 'Average' });  // 1.0% → Average
  assert.deepStrictEqual(calcER(50, 0, 10000), { er_percent: 0.5, er_label: 'Low' });     // 0.5% → Low
  // likes + comments both count
  assert.strictEqual(calcER(80, 20, 10000).er_percent, 1);
});

// The success update preserves a known follower count when this scrape resolved none:
// followers = COALESCE(NULLIF($2,0), followers). $2 single-use → dual-mode-safe.
test('follower count is preserved (not wiped) when scrape resolves 0', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE tracked_accounts (username TEXT UNIQUE, followers INTEGER DEFAULT 0)");
  db.prepare("INSERT INTO tracked_accounts (username, followers) VALUES ('a', 120000)").run();
  const upd = db.prepare("UPDATE tracked_accounts SET followers = COALESCE(NULLIF(?, 0), followers) WHERE username = 'a'");

  upd.run(0); // unknown this cycle → keep prior
  assert.strictEqual(db.prepare("SELECT followers f FROM tracked_accounts WHERE username='a'").get().f, 120000);

  upd.run(150000); // known → update
  assert.strictEqual(db.prepare("SELECT followers f FROM tracked_accounts WHERE username='a'").get().f, 150000);
});
