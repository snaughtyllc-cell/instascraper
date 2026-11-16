const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureTikTokPlatform } = require('./tiktok-migration');

test('TikTok migration adds nullable columns idempotently without altering legacy rows', async t => {
  const sqlite = new Database(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec("CREATE TABLE posts (shortcode TEXT); CREATE TABLE tracked_accounts (username TEXT); INSERT INTO posts VALUES ('IG123'); INSERT INTO tracked_accounts VALUES ('creator')");
  const db = { query: async sql => {
    const stmt = sqlite.prepare(sql);
    return { rows: stmt.reader ? stmt.all() : (stmt.run(), []) };
  } };
  assert.deepEqual(await ensureTikTokPlatform(db, { isPg: false }), { added: true });
  assert.deepEqual(await ensureTikTokPlatform(db, { isPg: false }), { added: false });
  assert.deepEqual(sqlite.prepare('SELECT * FROM posts').get(), { shortcode: 'IG123', platform: null });
  assert.deepEqual(sqlite.prepare('SELECT * FROM tracked_accounts').get(), { username: 'creator', platform: null });
});

test('Postgres TikTok migration checks current schema and uses guarded ADD COLUMN', async () => {
  const statements = [];
  const db = { query: async sql => {
    statements.push(sql);
    return { rows: [] };
  } };
  await ensureTikTokPlatform(db, { isPg: true });
  assert.equal(statements.length, 4);
  assert.match(statements[0], /table_schema = current_schema\(\).*table_name = 'posts'/);
  assert.equal(statements[1], 'ALTER TABLE posts ADD COLUMN IF NOT EXISTS platform TEXT');
  assert.match(statements[2], /table_name = 'tracked_accounts'/);
  assert.equal(statements[3], 'ALTER TABLE tracked_accounts ADD COLUMN IF NOT EXISTS platform TEXT');
});
