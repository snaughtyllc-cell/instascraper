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
  for (const name of ['sort_status', ...AI_COLUMNS.map((column) => column.name), 'perf_score']) {
    assert.ok(columns.includes(name), `${name} missing`);
  }
  const transcript = db.sqlite.prepare('PRAGMA table_info(posts)').all().find(column => column.name === 'ai_transcript');
  assert.strictEqual(transcript.type, 'TEXT');
  assert.strictEqual(db.sqlite.prepare('PRAGMA table_info(posts)').all().find(column => column.name === 'perf_score').type, 'REAL');
  assert.deepStrictEqual(db.sqlite.prepare('SELECT perf_score FROM posts ORDER BY id').all(), [
    { perf_score: null }, { perf_score: null },
  ]);
  assert.strictEqual(db.sqlite.prepare('PRAGMA table_info(posts)').all().find(column => column.name === 'ai_audio_kind').type, 'TEXT');
  assert.deepStrictEqual(db.sqlite.prepare('SELECT ai_audio_kind FROM posts ORDER BY id').all(), [
    { ai_audio_kind: null }, { ai_audio_kind: null },
  ]);
  assert.strictEqual(db.sqlite.prepare('PRAGMA table_info(posts)').all().find(column => column.name === 'ai_layout').type, 'TEXT');
  assert.deepStrictEqual(db.sqlite.prepare('SELECT ai_layout FROM posts ORDER BY id').all(), [
    { ai_layout: null }, { ai_layout: null },
  ]);
  for (const [name, type] of [['ai_lipsync_verdict', 'TEXT'], ['ai_lipsync_confidence', 'REAL'],
    ['ai_lipsync_evidence', 'TEXT'], ['ai_lipsync_checked_at', 'TEXT'], ['lipsync_repeat_of', 'INTEGER']]) {
    const column = db.sqlite.prepare('PRAGMA table_info(posts)').all().find(item => item.name === name);
    assert.ok(column, `${name} missing`);
    assert.strictEqual(column.type, type);
    assert.strictEqual(column.notnull, 0);
    assert.deepStrictEqual(db.sqlite.prepare(`SELECT ${name} FROM posts ORDER BY id`).all(), [
      { [name]: null }, { [name]: null },
    ]);
  }
  assert.deepStrictEqual(db.sqlite.prepare('SELECT ai_transcript FROM posts ORDER BY id').all(), [
    { ai_transcript: null }, { ai_transcript: null },
  ]);
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

test('PostgreSQL adds the performance column as nullable REAL', async () => {
  const statements = [];
  await ensureSortStatus({ query: async (sql) => {
    statements.push(sql);
    return { rows: [] };
  } }, { isPg: true });
  assert.ok(statements.includes('ALTER TABLE posts ADD COLUMN IF NOT EXISTS perf_score REAL'));
  assert.ok(statements.includes('ALTER TABLE posts ADD COLUMN IF NOT EXISTS ai_layout TEXT'));
  for (const [name, type] of [['ai_lipsync_verdict', 'TEXT'], ['ai_lipsync_confidence', 'REAL'],
    ['ai_lipsync_evidence', 'TEXT'], ['ai_lipsync_checked_at', 'TEXT'], ['lipsync_repeat_of', 'INTEGER']]) {
    assert.ok(statements.includes(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS ${name} ${type}`));
  }
});
