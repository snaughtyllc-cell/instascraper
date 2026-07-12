const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { applyModelReaction } = require('./model-reactions');

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE model_saved_posts (model_id INTEGER, post_id INTEGER, saved_at TEXT, PRIMARY KEY (model_id, post_id));
    CREATE TABLE model_post_feedback (
      model_id INTEGER, post_id INTEGER, feedback TEXT, notes TEXT, created_at TEXT, updated_at TEXT,
      PRIMARY KEY (model_id, post_id)
    );
  `);
  const db = {
    query(sql, params = []) {
      const converted = sql.replace(/\$\d+/g, '?');
      const statement = sqlite.prepare(converted);
      if (/^\s*SELECT/i.test(converted)) {
        const rows = statement.all(...params);
        return { rows, rowCount: rows.length };
      }
      const info = statement.run(...params);
      return { rows: [], rowCount: info.changes };
    },
    async transaction(work) {
      sqlite.exec('BEGIN');
      try {
        const result = await work(db);
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    sqlite,
  };
  return db;
}

test('save and unsave preserve the saved/want-to-make invariant', async () => {
  const db = makeDb();
  await applyModelReaction(db, { modelId: 1, postId: 2, reaction: 'save', nowIso: '2026-07-12T00:00:00.000Z' });
  assert.ok(db.sqlite.prepare('SELECT 1 FROM model_saved_posts WHERE model_id=1 AND post_id=2').get());
  assert.strictEqual(db.sqlite.prepare('SELECT feedback FROM model_post_feedback WHERE model_id=1 AND post_id=2').get().feedback, 'want_to_make');

  await applyModelReaction(db, { modelId: 1, postId: 2, reaction: 'unsave' });
  assert.strictEqual(db.sqlite.prepare('SELECT 1 FROM model_saved_posts WHERE model_id=1 AND post_id=2').get(), undefined);
  assert.strictEqual(db.sqlite.prepare('SELECT 1 FROM model_post_feedback WHERE model_id=1 AND post_id=2').get(), undefined);
});

test('not interested atomically removes a save and records the skip', async () => {
  const db = makeDb();
  await applyModelReaction(db, { modelId: 4, postId: 9, reaction: 'save' });
  await applyModelReaction(db, { modelId: 4, postId: 9, reaction: 'not_interested' });
  assert.strictEqual(db.sqlite.prepare('SELECT 1 FROM model_saved_posts WHERE model_id=4 AND post_id=9').get(), undefined);
  assert.strictEqual(db.sqlite.prepare('SELECT feedback FROM model_post_feedback WHERE model_id=4 AND post_id=9').get().feedback, 'not_my_style');
});
