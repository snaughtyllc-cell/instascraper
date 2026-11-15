const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { appRequest } = require('./test-support/app-request');
const { makeSortDb } = require('./test-support/sort-db');
const { sortConfig } = require('./sort-status');
const { runAutoSort } = require('./sort-runner');
const { registerSortRoutes } = require('./sort-routes');

test('backfill waits for a busy sweep and drains remaining reels', async (t) => {
  const pool = await makeSortDb();
  const videoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sort-review-'));
  t.after(async () => { pool.sqlite.close(); await fs.rm(videoDir, { recursive: true, force: true }); });
  pool.sqlite.exec("INSERT INTO posts(id,shortcode,posted_at,video_cache_status) VALUES (1,'first','2026-11-15','cached'),(2,'second','2026-11-14','cached')");
  await Promise.all([1, 2].map((id) => fs.writeFile(path.join(videoDir, `${id}.mp4`), 'fake video')));
  const cfg = { ...sortConfig({ GEMINI_API_KEY: 'fake-key' }), batch: 1 };
  const ai = { type: 'dance', confidence: 0.9, description: 'Dancing', suggestedType: null, usage: { inTokens: 1, outTokens: 1 } };
  let release;
  let started;
  let described = 0;
  const ready = new Promise((resolve) => { started = resolve; });
  const describe = async () => {
    described += 1;
    if (described === 1) {
      started();
      await new Promise((resolve) => { release = resolve; });
    }
    return ai;
  };
  const run = (options) => runAutoSort({ ...options, videoDir, describe });
  const sweep = run({ pool, cfg });
  await ready;
  const app = express();
  app.use(express.json());
  registerSortRoutes(app, { pool, cfg, runAutoSort: run, redecide: async () => ai });
  const response = await appRequest(app, { method: 'POST', path: '/sort/backfill' });
  assert.equal(response.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await sweep;
  for (let i = 0; i < 150 && described < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(described, 2, 'accepted backfill must resume after an overlapping sweep finishes');
  for (let i = 0; i < 50 && pool.sqlite.prepare("SELECT COUNT(*) n FROM posts WHERE sort_status='auto'").get().n < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(pool.sqlite.prepare("SELECT COUNT(*) n FROM posts WHERE sort_status='auto'").get().n, 2);
});

test('cleanup rechecks classification before hiding a selected reel', async (t) => {
  const testPool = await makeSortDb();
  t.after(() => testPool.sqlite.close());
  testPool.sqlite.exec("INSERT INTO posts(id,shortcode,account_handle,sort_status) VALUES (1,'old-reel','creator','unsorted')");
  const actualPool = require('./db');
  const originalQuery = actualPool.query;
  t.after(() => { actualPool.query = originalQuery; });
  actualPool.query = async (sql, params = []) => {
    if (/SELECT username FROM tracked_accounts/.test(sql)) return { rows: [], rowCount: 0 };
    if (/SELECT id, shortcode, account_handle FROM posts/.test(sql)) {
      const candidates = (await testPool.query('SELECT id, shortcode, account_handle FROM posts')).rows;
      // The human chooses a type after cleanup selected this old reel.
      await testPool.query("UPDATE posts SET sort_status='manual', content_type='dance' WHERE id=1");
      return { rows: candidates, rowCount: candidates.length };
    }
    return testPool.query(sql.replace(/TO_CHAR\(NOW\(\),\s*'[^']*'\)/gi, "'2026-11-15T00:00:00Z'"), params);
  };
  await require('./scheduler').runAutoCleanup();
  assert.equal(testPool.sqlite.prepare('SELECT soft_deleted FROM posts WHERE id=1').get().soft_deleted, 0,
    'a human classification must protect the reel even after candidate selection');
  assert.equal(testPool.sqlite.prepare('SELECT COUNT(*) n FROM deletion_log').get().n, 0);
});
