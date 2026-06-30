/**
 * Backfill view-based engagement rates for existing posts.
 *
 * Usage:
 *   node server/backfill-er.js          # recalc ER = (likes + comments) / views for all posts with views > 0
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const pool = require('./db');
const { calcViewER } = require('./engagement-metrics');

async function main() {
  const postsResult = await pool.query(
        'SELECT id, like_count, comment_count, view_count FROM posts WHERE view_count > 0'
      );
    const posts = postsResult.rows;

  let count = 0;
    for (const post of posts) {
          const { er_percent, er_label } = calcViewER(post.like_count || 0, post.comment_count || 0, post.view_count);
          await pool.query(
                  'UPDATE posts SET er_percent = $1, er_label = $2 WHERE id = $3',
                  [er_percent, er_label, post.id]
                );
          count++;
    }
    console.log(`Recalculated view-based ER for ${count} posts.`);

  const summaryResult = await pool.query(`
      SELECT account_handle,
            COUNT(*) as posts,
                  ROUND(AVG(er_percent)::numeric, 2) as avg_er,
                        MAX(view_count) as max_views
                            FROM posts
                                WHERE view_count > 0
                                    GROUP BY account_handle
                                        ORDER BY avg_er DESC
                                          `);
    const summary = summaryResult.rows;

  if (summary.length > 0) {
        console.log('\n--- Account Summary (view-based ER) ---');
        console.log('Account'.padEnd(25) + 'Posts'.padEnd(8) + 'Max Views'.padEnd(14) + 'Avg ER%');
        console.log('-'.repeat(55));
        for (const row of summary) {
                console.log(
                          `@${row.account_handle}`.padEnd(25) +
                          String(row.posts).padEnd(8) +
                          Number(row.max_views).toLocaleString().padEnd(14) +
                          `${row.avg_er}%`
                        );
        }
  } else {
        console.log('\nNo posts with view data yet. Scrape some accounts first.');
  }

  if (pool.end) await pool.end();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
