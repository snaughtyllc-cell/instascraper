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

test('backfill stops after the runner detects consecutive Gemini failures', async (t) => {
  const pool = await makeSortDb();
  const videoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sort-outage-review-'));
  t.after(async () => {
    pool.sqlite.close();
    await fs.rm(videoDir, { recursive: true, force: true });
  });
  for (let id = 1; id <= 5; id++) {
    pool.sqlite.prepare("INSERT INTO posts(id,shortcode,posted_at,video_cache_status) VALUES (?,?,?,'cached')")
      .run(id, `reel${id}`, `2026-11-${10 + id}`);
    await fs.writeFile(path.join(videoDir, `${id}.mp4`), 'fake video');
  }
  const cfg = { ...sortConfig({ GEMINI_API_KEY: 'fake-key' }), batch: 5, dailyMax: 100 };
  let describeCalls = 0;
  let batches = 0;
  const app = express();
  app.use(express.json());
  registerSortRoutes(app, {
    pool,
    cfg,
    runAutoSort: async (options) => {
      batches++;
      return runAutoSort({ ...options, videoDir, describe: async () => {
        describeCalls++;
        throw new Error('Gemini temporarily unavailable');
      } });
    },
  });
  const response = await appRequest(app, { method: 'POST', path: '/sort/backfill' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { started: true });
  for (let i = 0; i < 100 && describeCalls < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  // Allow the background route to attempt another batch if it ignores the stop.
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(batches, 1, 'backfill must not immediately reopen the stopped batch');
  assert.equal(describeCalls, 3);
  assert.deepEqual(pool.sqlite.prepare('SELECT id,ai_attempts,sort_status FROM posts ORDER BY id DESC').all(), [
    { id: 5, ai_attempts: 1, sort_status: 'unsorted' },
    { id: 4, ai_attempts: 1, sort_status: 'unsorted' },
    { id: 3, ai_attempts: 1, sort_status: 'unsorted' },
    { id: 2, ai_attempts: 0, sort_status: 'unsorted' },
    { id: 1, ai_attempts: 0, sort_status: 'unsorted' },
  ]);
});
