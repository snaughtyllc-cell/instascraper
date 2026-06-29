const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

// The exact upsert SQL the scraper will use (kept in sync with scraper.js).
const UPSERT = `
  INSERT INTO posts (shortcode, video_url, thumbnail_url, like_count, comment_count, view_count, followers_at_scrape, er_percent, er_label, tag, notes, content_type, archived, soft_deleted, thumbnail_cache_status)
  VALUES (@shortcode, @video_url, @thumbnail_url, @like_count, @comment_count, @view_count, @followers_at_scrape, @er_percent, @er_label, NULL, NULL, NULL, NULL, NULL, 'pending')
  ON CONFLICT (shortcode) DO UPDATE SET
    video_url = excluded.video_url,
    thumbnail_url = excluded.thumbnail_url,
    like_count = excluded.like_count,
    comment_count = excluded.comment_count,
    view_count = excluded.view_count,
    followers_at_scrape = excluded.followers_at_scrape,
    er_percent = excluded.er_percent,
    er_label = excluded.er_label,
    thumbnail_cache_status = 'pending'`;

test('re-scrape refreshes thumbnail_url + counts but preserves user fields', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE posts (
    shortcode TEXT UNIQUE, video_url TEXT, thumbnail_url TEXT, like_count INTEGER, comment_count INTEGER, view_count INTEGER, followers_at_scrape INTEGER, er_percent REAL, er_label TEXT,
    tag TEXT, notes TEXT, content_type TEXT, archived INTEGER, soft_deleted INTEGER, thumbnail_cache_status TEXT)`);

  // Insert initial post with scrape-derived fields
  db.prepare(UPSERT).run({
    shortcode: 'p1',
    video_url: 'https://video.old',
    thumbnail_url: 'OLD_THUMB',
    like_count: 10,
    comment_count: 2,
    view_count: 100,
    followers_at_scrape: 5000,
    er_percent: 0.24,
    er_label: 'Low'
  });

  // User tags it, adds notes, sets content_type, archives, marks not soft-deleted, and it gets cached
  db.prepare(`UPDATE posts SET tag='recreate', notes='great hook', content_type='talking', archived=1, soft_deleted=0, thumbnail_cache_status='cached' WHERE shortcode='p1'`).run();

  // Re-scrape with fresh values for ALL scrape-derived fields
  db.prepare(UPSERT).run({
    shortcode: 'p1',
    video_url: 'https://video.fresh',
    thumbnail_url: 'FRESH_THUMB',
    like_count: 99,
    comment_count: 15,
    view_count: 500,
    followers_at_scrape: 8000,
    er_percent: 1.43,
    er_label: 'Good'
  });

  const row = db.prepare(`SELECT * FROM posts WHERE shortcode='p1'`).get();

  // Assert: all scrape-derived fields refreshed to new values
  assert.equal(row.video_url, 'https://video.fresh', 'video_url refreshed');
  assert.equal(row.thumbnail_url, 'FRESH_THUMB', 'thumbnail_url refreshed');
  assert.equal(row.like_count, 99, 'like_count refreshed');
  assert.equal(row.comment_count, 15, 'comment_count refreshed');
  assert.equal(row.view_count, 500, 'view_count refreshed');
  assert.equal(row.followers_at_scrape, 8000, 'followers_at_scrape refreshed');
  assert.equal(row.er_percent, 1.43, 'er_percent refreshed');
  assert.equal(row.er_label, 'Good', 'er_label refreshed');

  // Assert: thumbnail_cache_status reset to pending for re-download
  assert.equal(row.thumbnail_cache_status, 'pending', 'cache status reset so sweep re-downloads');

  // Assert: ALL FIVE user-owned fields unchanged
  assert.equal(row.tag, 'recreate', 'user tag preserved');
  assert.equal(row.notes, 'great hook', 'user notes preserved');
  assert.equal(row.content_type, 'talking', 'user content_type preserved');
  assert.equal(row.archived, 1, 'user archived flag preserved');
  assert.equal(row.soft_deleted, 0, 'user soft_deleted flag preserved');
});
