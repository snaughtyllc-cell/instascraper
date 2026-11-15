const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { getCreators } = require('./creators-mix');

function makeDb(t) {
  const sqlite = new Database(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(`CREATE TABLE model_creators (model_id INTEGER, username TEXT);
  CREATE TABLE models (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE posts (
    id INTEGER PRIMARY KEY, account_handle TEXT, content_type TEXT,
    sort_status TEXT DEFAULT 'unsorted', archived INTEGER DEFAULT 0,
    soft_deleted INTEGER DEFAULT 0
  )`);
  return {
    sqlite,
    query: async (sql, params = []) => ({ rows: sqlite.prepare(sql.replace(/\$\d+/g, '?')).all(...params) }),
  };
}

test('creators mix percentages exclude an unsorted reel', async (t) => {
  const db = makeDb(t);
  db.sqlite.exec(`INSERT INTO posts (id, account_handle, content_type, sort_status) VALUES
    (1, 'creator', 'talking', 'auto'),
    (2, 'creator', 'talking', 'manual'),
    (3, 'creator', 'dance', 'auto'),
    (4, 'creator', 'dance', 'unsorted')`);
  assert.deepEqual(await getCreators(db), [{
    account_handle: 'creator', post_count: 4, owners: [],
    mix: [{ type: 'talking', pct: 67 }, { type: 'dance', pct: 33 }],
  }]);
});

test('creator mixes and post counts exclude archived and deleted reels', async (t) => {
  const db = makeDb(t);
  db.sqlite.exec(`INSERT INTO posts (id, account_handle, content_type, sort_status, archived, soft_deleted) VALUES
    (1, 'creator', 'talking', 'auto', 0, 0),
    (2, 'creator', 'dance', 'auto', 1, 0),
    (3, 'creator', 'dance', 'manual', 0, 1),
    (4, 'hidden', 'dance', 'manual', 1, 0)`);
  assert.deepEqual(await getCreators(db), [{
    account_handle: 'creator', post_count: 1, owners: [], mix: [{ type: 'talking', pct: 100 }],
  }]);
});

test('creator handles are case normalized into one mix', async (t) => {
  const db = makeDb(t);
  db.sqlite.exec(`INSERT INTO posts (id, account_handle, content_type, sort_status) VALUES
    (1, 'Creator', 'talking', 'auto'),
    (2, 'creator', 'dance', 'manual'),
    (3, ' CREATOR ', 'talking', 'auto'),
    (4, '', 'dance', 'auto'),
    (5, NULL, 'dance', 'auto')`);
  assert.deepEqual(await getCreators(db), [{
    account_handle: 'creator', post_count: 3, owners: [],
    mix: [{ type: 'talking', pct: 67 }, { type: 'dance', pct: 33 }],
  }]);
});

test('a creator with no decided reel has an empty mix', async (t) => {
  const db = makeDb(t);
  db.sqlite.exec(`INSERT INTO posts (id, account_handle, content_type, sort_status) VALUES
    (1, 'creator', 'dance', 'needs_look'),
    (2, 'creator', 'dance', 'unsorted'),
    (3, 'creator', NULL, 'manual')`);
  assert.deepEqual(await getCreators(db), [{ account_handle: 'creator', post_count: 3, owners: [], mix: [] }]);
});

test('creator mixes include every model owner', async t => {
  const db = makeDb(t);
  db.sqlite.exec(`INSERT INTO posts (id, account_handle) VALUES (1, 'Mia.Talks');
    INSERT INTO models VALUES (1, 'Logan'), (2, 'Gigi');
    INSERT INTO model_creators VALUES (1, 'mia.talks'), (2, 'mia.talks')`);
  assert.deepEqual((await getCreators(db))[0].owners, [{ modelId: 1, name: 'Logan' }, { modelId: 2, name: 'Gigi' }]);
});
