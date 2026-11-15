const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { ensureSortStatus, AI_COLUMNS } = require('./sort-migration');

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE posts (id INTEGER PRIMARY KEY, content_type TEXT);
    CREATE TABLE creator_types (account_handle TEXT, content_type TEXT);
    INSERT INTO posts (id, content_type) VALUES (1, 'dance'), (2, NULL)`);
  return {
    sqlite,
    query: async (sql, params = []) => {
      const stmt = sqlite.prepare(sql.replace(/\$\d+/g, '?'));
      return stmt.reader ? { rows: stmt.all(...params) } : { rows: [], rowCount: stmt.run(...params).changes };
    },
  };
}

test('first run adds columns, every existing reel unsorted', async () => {
  const db = makeDb();
  const result = await ensureSortStatus(db, { isPg: false });
  const columns = db.sqlite.prepare('PRAGMA table_info(posts)').all().map((row) => row.name);
  for (const name of ['sort_status', ...AI_COLUMNS.map((column) => column.name)]) {
    assert.ok(columns.includes(name), `${name} missing`);
  }
  assert.deepStrictEqual(db.sqlite.prepare('SELECT sort_status FROM posts ORDER BY id').all(), [
    { sort_status: 'unsorted' }, { sort_status: 'unsorted' },
  ]);
  assert.strictEqual(result.added, true);
});

test('second run is a no-op', async () => {
  const db = makeDb();
  await ensureSortStatus(db, { isPg: false });
  assert.deepStrictEqual(await ensureSortStatus(db, { isPg: false }), { added: false });
});
