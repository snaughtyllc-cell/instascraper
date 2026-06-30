const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { calcER } = require('./scraper');

test('calcER: no/zero/negative views → 0% and null label (cannot compute)', () => {
  assert.deepStrictEqual(calcER(100, 10, 0), { er_percent: 0, er_label: null });
  assert.deepStrictEqual(calcER(100, 10, undefined), { er_percent: 0, er_label: null });
  assert.deepStrictEqual(calcER(100, 10, null), { er_percent: 0, er_label: null });
  assert.deepStrictEqual(calcER(100, 10, -5), { er_percent: 0, er_label: null });
});

test('calcER: view-based percent + label bands', () => {
  assert.deepStrictEqual(calcER(1000, 0, 10000), { er_percent: 10, er_label: 'Viral' });  // 10% → Viral
  assert.deepStrictEqual(calcER(500, 0, 10000), { er_percent: 5, er_label: 'Good' });     // 5% → Good
  assert.deepStrictEqual(calcER(200, 0, 10000), { er_percent: 2, er_label: 'Average' });  // 2% → Average
  assert.deepStrictEqual(calcER(100, 0, 10000), { er_percent: 1, er_label: 'Low' });      // 1% → Low
  // likes + comments both count against views
  assert.strictEqual(calcER(80, 20, 2000).er_percent, 5);   // (80+20)/2000 = 5%
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
