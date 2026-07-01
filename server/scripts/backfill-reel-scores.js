// One-off: pull reels + compute the reel-performance score for pending suggestions.
// Usage (in prod container): node scripts/backfill-reel-scores.js [--all]
//   default: only pending accounts that have no reels yet;  --all: every pending account.
const pool = require('../db');
const InstagramScraper = require('../scraper');
const { BudgetExceededError } = require('../scraper');

const scraper = new InstagramScraper(process.env.APIFY_API_KEY || '');

(async () => {
  const all = process.argv.includes('--all');
  const sql = all
    ? "SELECT username FROM suggested_accounts WHERE status = 'pending' ORDER BY discovered_at DESC"
    : `SELECT s.username FROM suggested_accounts s
        WHERE s.status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM suggested_reels r WHERE r.username = s.username)
        ORDER BY s.discovered_at DESC`;
  const { rows } = await pool.query(sql);
  console.log(`[Backfill] ${rows.length} pending accounts (all=${all})`);
  let done = 0, withReels = 0;
  for (const r of rows) {
    try {
      const { count, score } = await scraper.captureTopReels(r.username);
      done++; if (count > 0) withReels++;
      console.log(`[Backfill] @${r.username} -> ${count} reels, score ${score}`);
    } catch (e) {
      if (e instanceof BudgetExceededError) { console.log(`[Backfill] budget reached — stopping: ${e.message}`); break; }
      console.log(`[Backfill] @${r.username} FAILED: ${e.message}`);
    }
  }
  console.log(`[Backfill] done=${done} withReels=${withReels}`);
  process.exit(0);
})().catch((e) => { console.error('[Backfill] FATAL', e.message); process.exit(1); });
