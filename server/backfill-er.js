/**
 * Backfill engagement rates for existing posts.
 *
 * Usage:
 *   node server/backfill-er.js                          # recalc ER for posts that already have followers_at_scrape > 0
 *   node server/backfill-er.js sabrinasnowww 1200000    # set followers for an account and recalc ER
 *   node server/backfill-er.js --all                    # recalc all posts that have followers_at_scrape > 0
 *
 * You can run this multiple times — it just updates existing rows.
 */

const db = require('./db');

function calcER(likes, comments, followers) {
  if (!followers || followers <= 0) return { er_percent: 0, er_label: null };
  const er = ((likes + comments) / followers) * 100;
  let label = 'Low';
  if (er >= 6) label = 'Viral';
  else if (er >= 3) label = 'Good';
  else if (er >= 1) label = 'Average';
  return { er_percent: Math.round(er * 100) / 100, er_label: label };
}

const args = process.argv.slice(2);

if (args.length >= 2 && args[0] !== '--all') {
  // Set followers for an account, then recalculate
  const handle = args[0].replace('@', '');
  const followers = parseInt(args[1], 10);

  if (isNaN(followers) || followers <= 0) {
    console.error('Invalid follower count. Usage: node server/backfill-er.js <handle> <followers>');
    process.exit(1);
  }

  const update = db.prepare('UPDATE posts SET followers_at_scrape = ? WHERE account_handle = ?');
  const result = update.run(followers, handle);
  console.log(`Set ${result.changes} posts for @${handle} to ${followers.toLocaleString()} followers`);
}

// Now recalculate ER for all posts with followers > 0
const posts = db.prepare('SELECT id, like_count, comment_count, followers_at_scrape FROM posts WHERE followers_at_scrape > 0').all();

const updateER = db.prepare('UPDATE posts SET er_percent = ?, er_label = ? WHERE id = ?');

const batchUpdate = db.transaction((posts) => {
  let count = 0;
  for (const post of posts) {
    const { er_percent, er_label } = calcER(post.like_count || 0, post.comment_count || 0, post.followers_at_scrape);
    updateER.run(er_percent, er_label, post.id);
    count++;
  }
  return count;
});

const updated = batchUpdate(posts);
console.log(`Recalculated ER for ${updated} posts.`);

// Print summary by account
const summary = db.prepare(`
  SELECT account_handle, COUNT(*) as posts, ROUND(AVG(er_percent), 2) as avg_er, MAX(followers_at_scrape) as followers
  FROM posts
  WHERE followers_at_scrape > 0
  GROUP BY account_handle
  ORDER BY avg_er DESC
`).all();

if (summary.length > 0) {
  console.log('\n--- Account Summary ---');
  console.log('Account'.padEnd(25) + 'Posts'.padEnd(8) + 'Followers'.padEnd(14) + 'Avg ER%');
  console.log('-'.repeat(55));
  for (const row of summary) {
    console.log(
      `@${row.account_handle}`.padEnd(25) +
      String(row.posts).padEnd(8) +
      row.followers.toLocaleString().padEnd(14) +
      `${row.avg_er}%`
    );
  }
} else {
  console.log('\nNo posts with follower data yet. Set followers for an account:');
  console.log('  node server/backfill-er.js <handle> <follower_count>');
  console.log('  Example: node server/backfill-er.js sabrinasnowww 1200000');
}
