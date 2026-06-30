const { test } = require('node:test');
const assert = require('node:assert');
const {
  cadenceConfig, computeInterval, backoffDays, daysSince, isDue, selectDueAccounts, buildCadenceAccounts,
} = require('./scheduler');

const CFG = cadenceConfig({}); // all defaults
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000_000 * DAY; // arbitrary fixed "now" in ms

test('cadenceConfig: defaults + env override + bad values fall back', () => {
  assert.strictEqual(CFG.maxPerCycle, 10);
  assert.strictEqual(CFG.intervalQuiet, 8);
  assert.strictEqual(cadenceConfig({ SCRAPE_MAX_PER_CYCLE: '3' }).maxPerCycle, 3);
  assert.strictEqual(cadenceConfig({ SCRAPE_MAX_PER_CYCLE: 'nope' }).maxPerCycle, 10);
  assert.strictEqual(cadenceConfig({ CADENCE_FREQ_WINDOW_DAYS: '30.9' }).freqWindowDays, 30); // floored int
});

test('computeInterval: active/moderate/quiet incl. boundaries', () => {
  assert.strictEqual(computeInterval(10, CFG), 2);
  assert.strictEqual(computeInterval(4, CFG), 2);   // boundary = active
  assert.strictEqual(computeInterval(1, CFG), 4);   // boundary = moderate
  assert.strictEqual(computeInterval(0.5, CFG), 8); // quiet
  assert.strictEqual(computeInterval(0, CFG), 8);
});

test('backoffDays: 0 → 0, doubles, clamps at max', () => {
  assert.strictEqual(backoffDays(0, CFG), 0);
  assert.strictEqual(backoffDays(1, CFG), 1);
  assert.strictEqual(backoffDays(2, CFG), 2);
  assert.strictEqual(backoffDays(3, CFG), 4);
  assert.strictEqual(backoffDays(99, CFG), 14); // clamp
});

test('daysSince: null/malformed → Infinity', () => {
  assert.strictEqual(daysSince(null, NOW), Infinity);
  assert.strictEqual(daysSince('garbage', NOW), Infinity);
  assert.strictEqual(daysSince(new Date(NOW - 3 * DAY).toISOString(), NOW), 3);
});

test('isDue: never-scraped → due', () => {
  assert.strictEqual(isDue({ last_scraped_at: null, postsPerWeek: 0, consecutive_failures: 0 }, NOW, CFG), true);
});

test('isDue: within interval → not due', () => {
  const acct = { last_scraped_at: new Date(NOW - 1 * DAY).toISOString(), postsPerWeek: 5, consecutive_failures: 0 }; // interval 2
  assert.strictEqual(isDue(acct, NOW, CFG), false);
});

test('isDue: past interval but in backoff cooldown → not due', () => {
  const acct = {
    last_scraped_at: new Date(NOW - 9 * DAY).toISOString(), // quiet interval 8 → past
    last_attempt_at: new Date(NOW - 1 * DAY).toISOString(),  // attempted 1d ago
    postsPerWeek: 0, consecutive_failures: 3,                // backoff 4d → still cooling
  };
  assert.strictEqual(isDue(acct, NOW, CFG), false);
});

test('isDue: past interval and past cooldown → due', () => {
  const acct = {
    last_scraped_at: new Date(NOW - 20 * DAY).toISOString(),
    last_attempt_at: new Date(NOW - 10 * DAY).toISOString(), // cooled (backoff for 3 failures = 4d)
    postsPerWeek: 0, consecutive_failures: 3,
  };
  assert.strictEqual(isDue(acct, NOW, CFG), true);
});

test('selectDueAccounts: filters non-due, most-overdue first, respects cap', () => {
  const mk = (u, scrapedDaysAgo, ppw = 0, fails = 0, attemptDaysAgo = scrapedDaysAgo) => ({
    username: u,
    last_scraped_at: scrapedDaysAgo == null ? null : new Date(NOW - scrapedDaysAgo * DAY).toISOString(),
    last_attempt_at: attemptDaysAgo == null ? null : new Date(NOW - attemptDaysAgo * DAY).toISOString(),
    postsPerWeek: ppw, consecutive_failures: fails,
  });
  const accts = [
    mk('fresh', 1, 5),                 // within interval 2 → not due
    mk('never', null),                 // never → due (most overdue)
    mk('stale', 20, 0),                // quiet, way overdue → due
    mk('mid', 9, 0),                   // quiet, just overdue → due
    mk('failing', 30, 0, 3, 1),        // overdue but cooling (attempt 1d, backoff 4d) → not due
  ];
  const due = selectDueAccounts(accts, NOW, { ...CFG, maxPerCycle: 2 });
  assert.deepStrictEqual(due.map(a => a.username), ['never', 'stale']); // never (Inf) then most-overdue, capped at 2
});

test('buildCadenceAccounts: merges rows + computes postsPerWeek over the window', () => {
  const cfg = { ...CFG, freqWindowDays: 28 }; // 4 weeks
  const rows = [{ username: 'a', last_scraped_at: null, last_attempt_at: null, consecutive_failures: 2 }, { username: 'b', last_scraped_at: null }];
  const freq = [{ username: 'a', recent_post_count: 8 }]; // 8 posts / 4 weeks = 2 ppw
  const out = buildCadenceAccounts(rows, freq, cfg);
  assert.strictEqual(out[0].postsPerWeek, 2);
  assert.strictEqual(out[0].consecutive_failures, 2);
  assert.strictEqual(out[1].postsPerWeek, 0); // b absent from freq
});
