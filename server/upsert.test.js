const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

// The exact upsert SQL the scraper will use (kept in sync with scraper.js).
const UPSERT = `
  INSERT INTO posts (shortcode, thumbnail_url, like_count, view_count, tag, notes, thumbnail_cache_status)
  VALUES (@shortcode, @thumbnail_url, @like_count, @view_count, NULL, NULL, 'pending')
  ON CONFLICT (shortcode) DO UPDATE SET
    thumbnail_url = excluded.thumbnail_url,
    like_count = excluded.like_count,
    view_count = excluded.view_count,
    thumbnail_cache_status = 'pending'`;

test('re-scrape refreshes thumbnail_url + counts but preserves user fields', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE posts (
    shortcode TEXT UNIQUE, thumbnail_url TEXT, like_count INTEGER, view_count INTEGER,
    tag TEXT, notes TEXT, thumbnail_cache_status TEXT)`);

  db.prepare(UPSERT).run({ shortcode: 'p1', thumbnail_url: 'OLD', like_count: 10, view_count: 5 });
  // user tags + notes it, and it gets cached
  db.prepare(`UPDATE posts SET tag='recreate', notes='great hook', thumbnail_cache_status='cached' WHERE shortcode='p1'`).run();

  // re-scrape with a fresh URL + new counts
  db.prepare(UPSERT).run({ shortcode: 'p1', thumbnail_url: 'FRESH', like_count: 99, view_count: 50 });

  const row = db.prepare(`SELECT * FROM posts WHERE shortcode='p1'`).get();
  assert.equal(row.thumbnail_url, 'FRESH', 'thumbnail_url refreshed');
  assert.equal(row.like_count, 99, 'counts refreshed');
  assert.equal(row.tag, 'recreate', 'user tag preserved');
  assert.equal(row.notes, 'great hook', 'user notes preserved');
  assert.equal(row.thumbnail_cache_status, 'pending', 'cache status reset so sweep re-downloads');
});
