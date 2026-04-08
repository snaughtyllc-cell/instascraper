/**
 * Backfill engagement rates for existing posts.
 *
 * Usage:
 *   node server/backfill-er.js                          # recalc ER for posts with followers_at_scrape > 0
 *   node server/backfill-er.js sabrinasnowww 1200000    # set followers for an account and recalc ER
 *   node server/backfill-er.js --all                    # recalc all posts with followers_at_scrape > 0
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const pool = require('./db');

function calcER(likes, comments, followers) {
    if (!followers || followers <= 0) return { er_percent: 0, er_label: null };
    const er = ((likes + comments) / followers) * 100;
    let label = 'Low';
    if (er >= 6) label = 'Viral';
    else if (er >= 3) label = 'Good';
    else if (er >= 1) label = 'Average';
    return { er_percent: Math.round(er * 100) / 100, er_label: label };
}

async function main() {
    const args = process.argv.slice(2);

  if (args.length >= 2 && args[0] !== '--all') {
        const handle = args[0].replace('@', '');
        const followers = parseInt(args[1], 10);
        if (isNaN(followers) || followers <= 0) {
                console.error('Invalid follower count. Usage: node server/backfill-er.js <handle> <followers>');
                process.exit(1);
        }
        const result = await pool.query(
                'UPDATE posts SET followers_at_scrape = $1 WHERE account_handle = $2',
                [followers, handle]
              );
        console.log(`Set ${result.rowCount} posts for @${handle} to ${followers.toLocaleString()} followers`);
  }

  const postsResult = await pool.query(
        'SELECT id, like_count, comment_count, followers_at_scrape FROM posts WHERE followers_at_scrape > 0'
      );
    const posts = postsResult.rows;

  let count = 0;
    for (const post of posts) {
          const { er_percent, er_label } = calcER(post.like_count || 0, post.comment_count || 0, post.followers_at_scrape);
          await pool.query(
                  'UPDATE posts SET er_percent = $1, er_label = $2 WHERE id = $3',
                  [er_percent, er_label, post.id]
                );
          count++;
    }
    console.log(`Recalculated ER for ${count} posts.`);

  const summaryResult = await pool.query(`
      SELECT account_handle,
            COUNT(*) as posts,
                  ROUND(AVG(er_percent)::numeric, 2) as avg_er,
                        MAX(followers_at_scrape) as followers
                            FROM posts
                                WHERE followers_at_scrape > 0
                                    GROUP BY account_handle
                                        ORDER BY avg_er DESC
                                          `);
    const summary = summaryResult.rows;

  if (summary.length > 0) {
        console.log('\n--- Account Summary ---');
        console.log('Account'.padEnd(25) + 'Posts'.padEnd(8) + 'Followers'.padEnd(14) + 'Avg ER%');
        console.log('-'.repeat(55));
        for (const row of summary) {
                console.log(
                          `@${row.account_handle}`.padEnd(25) +
                          String(row.posts).padEnd(8) +
                          Number(row.followers).toLocaleString().padEnd(14) +
                          `${row.avg_er}%`
                        );
        }
  } else {
        console.log('\nNo posts with follower data yet. Set followers for an account:');
        console.log('  node server/backfill-er.js <handle> <follower_count>');
        console.log('  Example: node server/backfill-er.js sabrinasnowww 1200000');
  }

  if (pool.end) await pool.end();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
