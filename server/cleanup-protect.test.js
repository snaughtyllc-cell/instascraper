const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { cleanupProtectClause } = require('./scheduler');

test('cleanup protects auto and manual with type, keeps undecided reels eligible', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE posts (id INTEGER PRIMARY KEY, sort_status TEXT, content_type TEXT, tag TEXT);
      INSERT INTO posts VALUES (1,'auto','dance',NULL),(2,'manual','talking',NULL),
        (3,'unsorted','dance',NULL),(4,'needs_look',NULL,NULL),(5,'manual',NULL,NULL),
        (6,'unsorted',NULL,'recreate');`);
    const rows = db.prepare(`SELECT id FROM posts WHERE ${cleanupProtectClause()} ORDER BY id`).all();
    assert.deepEqual(rows.map(r => r.id), [3, 4, 5]);
  } finally { db.close(); }
});
