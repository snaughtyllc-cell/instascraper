const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const scraper = require('./scraper');

const {
  isoNoMillis, BudgetExceededError, extractUsageUsd,
  budgetStatus, recordRunLaunch, recordRunCompletion, usageSummary, hasActiveJob,
} = scraper;

// Minimal pg-style wrapper over an in-memory sqlite db: $1,$2 → ?, returns { rows }.
function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE apify_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT UNIQUE NOT NULL, actor_id TEXT,
    purpose TEXT, query TEXT, status TEXT DEFAULT 'running', results_count INTEGER DEFAULT 0,
    usage_usd REAL DEFAULT 0, scrape_job_id INTEGER, started_at TEXT, completed_at TEXT)`);
  sqlite.exec(`CREATE TABLE scrape_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, query TEXT, query_type TEXT, status TEXT DEFAULT 'running',
    created_at TEXT)`);
  return {
    sqlite,
    query: async (sql, params = []) => {
      const converted = sql.replace(/\$(\d+)/g, '?');
      const trimmed = converted.trim();
      if (/^SELECT/i.test(trimmed)) return { rows: sqlite.prepare(converted).all(...params) };
      const info = sqlite.prepare(converted).run(...params);
      return { rows: [], rowCount: info.changes };
    },
  };
}

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-06-30T12:00:00Z');

test('isoNoMillis matches the no-millis NOW_DEFAULT format', () => {
  assert.strictEqual(isoNoMillis(Date.parse('2026-06-30T12:00:00.123Z')), '2026-06-30T12:00:00Z');
});

test('extractUsageUsd reads usageTotalUsd, defaults to 0 on missing/non-numeric', () => {
  assert.strictEqual(extractUsageUsd({ usageTotalUsd: 0.042 }), 0.042);
  assert.strictEqual(extractUsageUsd({}), 0);
  assert.strictEqual(extractUsageUsd(null), 0);
  assert.strictEqual(extractUsageUsd({ usageTotalUsd: 'x' }), 0);
  assert.strictEqual(extractUsageUsd({ usageTotalUsd: Infinity }), 0);
});

test('recordRunLaunch inserts a running row; recordRunCompletion finalizes it', async () => {
  const db = makeDb();
  await recordRunLaunch(db, { runId: 'r1', actorId: 'a', purpose: 'scrape', query: '@x', nowMs: NOW });
  let row = db.sqlite.prepare(`SELECT * FROM apify_runs WHERE run_id='r1'`).get();
  assert.strictEqual(row.status, 'running');
  assert.strictEqual(row.usage_usd, 0);

  await recordRunCompletion(db, { runId: 'r1', runObject: { usageTotalUsd: 0.07, stats: { itemCount: 12 } }, status: 'succeeded', nowMs: NOW });
  row = db.sqlite.prepare(`SELECT * FROM apify_runs WHERE run_id='r1'`).get();
  assert.strictEqual(row.status, 'succeeded');
  assert.strictEqual(row.results_count, 12);
  assert.strictEqual(row.usage_usd, 0.07);
  assert.ok(row.completed_at);
});

test('recordRunCompletion with no runObject records status only, no throw', async () => {
  const db = makeDb();
  await recordRunLaunch(db, { runId: 'r2', actorId: 'a', purpose: 'scrape', query: '@y', nowMs: NOW });
  await recordRunCompletion(db, { runId: 'r2', status: 'failed', nowMs: NOW });
  const row = db.sqlite.prepare(`SELECT * FROM apify_runs WHERE run_id='r2'`).get();
  assert.strictEqual(row.status, 'failed');
  assert.strictEqual(row.usage_usd, 0);
});

test('budgetStatus: enforcement off when ceiling unset', async () => {
  const db = makeDb();
  delete process.env.APIFY_BUDGET_USD_30D;
  const s = await budgetStatus(db, NOW);
  assert.strictEqual(s.enforced, false);
  assert.strictEqual(s.over, false);
});

test('budgetStatus: sums succeeded usage in the 30-day window and flags over', async () => {
  const db = makeDb();
  process.env.APIFY_BUDGET_USD_30D = '1.00';
  // two succeeded runs inside window summing to 0.90
  await recordRunLaunch(db, { runId: 'a', actorId: 'x', purpose: 'scrape', query: '@a', nowMs: NOW - HOUR });
  await recordRunCompletion(db, { runId: 'a', runObject: { usageTotalUsd: 0.50, stats: { itemCount: 1 } }, status: 'succeeded', nowMs: NOW - HOUR });
  await recordRunLaunch(db, { runId: 'b', actorId: 'x', purpose: 'scrape', query: '@b', nowMs: NOW - HOUR });
  await recordRunCompletion(db, { runId: 'b', runObject: { usageTotalUsd: 0.40, stats: { itemCount: 1 } }, status: 'succeeded', nowMs: NOW - HOUR });
  let s = await budgetStatus(db, NOW);
  assert.ok(Math.abs(s.spentUsd - 0.90) < 1e-9);
  assert.strictEqual(s.over, false); // 0.90 < 1.00, no in-flight
  // a third succeeded run pushes spent to 1.10 → over
  await recordRunLaunch(db, { runId: 'c', actorId: 'x', purpose: 'scrape', query: '@c', nowMs: NOW - HOUR });
  await recordRunCompletion(db, { runId: 'c', runObject: { usageTotalUsd: 0.20, stats: { itemCount: 1 } }, status: 'succeeded', nowMs: NOW - HOUR });
  s = await budgetStatus(db, NOW);
  assert.ok(s.over, 'over once projected >= ceiling');
});

test('budgetStatus: excludes runs older than 30 days', async () => {
  const db = makeDb();
  process.env.APIFY_BUDGET_USD_30D = '1.00';
  await recordRunLaunch(db, { runId: 'old', actorId: 'x', purpose: 'scrape', query: '@o', nowMs: NOW - 40 * 24 * HOUR });
  await recordRunCompletion(db, { runId: 'old', runObject: { usageTotalUsd: 5.0, stats: { itemCount: 1 } }, status: 'succeeded', nowMs: NOW - 40 * 24 * HOUR });
  const s = await budgetStatus(db, NOW);
  assert.strictEqual(s.spentUsd, 0);
  assert.strictEqual(s.over, false);
});

test('budgetStatus: in-flight runs add estimated cost via projectedUsd', async () => {
  const db = makeDb();
  process.env.APIFY_BUDGET_USD_30D = '1.00';
  process.env.APIFY_EST_USD_PER_RUN = '0.30';
  // spent 0.80 succeeded, no finished-average yet beyond these; plus 1 running
  await recordRunLaunch(db, { runId: 's1', actorId: 'x', purpose: 'scrape', query: '@a', nowMs: NOW - HOUR });
  await recordRunCompletion(db, { runId: 's1', runObject: { usageTotalUsd: 0.80, stats: { itemCount: 1 } }, status: 'succeeded', nowMs: NOW - HOUR });
  await recordRunLaunch(db, { runId: 'run1', actorId: 'x', purpose: 'scrape', query: '@b', nowMs: NOW }); // still running
  const s = await budgetStatus(db, NOW);
  // estPerRun = avg of succeeded (0.80); projected = 0.80 + 1*0.80 = 1.60 >= 1.00 → over
  assert.ok(s.over, 'in-flight estimate pushes projected over ceiling');
  assert.ok(s.projectedUsd > s.spentUsd);
});

test('usageSummary returns totals and top accounts by spend', async () => {
  const db = makeDb();
  process.env.APIFY_BUDGET_USD_30D = '5.00';
  for (const [id, q, usd] of [['1', '@a', 0.5], ['2', '@a', 0.5], ['3', '@b', 0.2]]) {
    await recordRunLaunch(db, { runId: id, actorId: 'x', purpose: 'scrape', query: q, nowMs: NOW });
    await recordRunCompletion(db, { runId: id, runObject: { usageTotalUsd: usd, stats: { itemCount: 1 } }, status: 'succeeded', nowMs: NOW });
  }
  const sum = await usageSummary(db, NOW);
  assert.strictEqual(sum.run_count, 3);
  assert.ok(Math.abs(sum.spent_usd - 1.2) < 1e-9);
  assert.strictEqual(sum.top_accounts[0].query, '@a');
  assert.ok(Math.abs(sum.top_accounts[0].usd - 1.0) < 1e-9);
  assert.strictEqual(sum.top_accounts[0].runs, 2);
});

test('hasActiveJob detects a recent running job for the same query', async () => {
  const db = makeDb();
  db.sqlite.prepare(`INSERT INTO scrape_jobs (query, query_type, status, created_at) VALUES (?,?,?,?)`)
    .run('@busy', 'username', 'running', isoNoMillis(NOW - 2 * 60 * 1000));
  assert.strictEqual(await hasActiveJob(db, '@busy', NOW), true);
  assert.strictEqual(await hasActiveJob(db, '@free', NOW), false);
  // outside the 10-min window → not active
  db.sqlite.prepare(`INSERT INTO scrape_jobs (query, query_type, status, created_at) VALUES (?,?,?,?)`)
    .run('@stale', 'username', 'running', isoNoMillis(NOW - 30 * 60 * 1000));
  assert.strictEqual(await hasActiveJob(db, '@stale', NOW), false);
});
