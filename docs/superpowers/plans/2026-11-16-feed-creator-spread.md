# Plan: spread creators in model feeds

Date: 2026-11-16 · Requested by user ("Show less Sophia Rain… overly crowded with just her videos on the dance tab") · Branch `feed-creator-spread`

## Goal
One prolific creator floods a model's feed. Sophie Rain has 100 reels (50 IG + 50 TikTok), mostly dance. Mix creators so no single creator dominates a screen of the feed, while keeping the existing ranking: niche first, then look + taste + perf, then newest.

## Approach
In `buildMeFeedQuery` (`server/me-feed.js`), used by `/me/feed`, workspace reels and the Film feed, when **not** shuffled:
1. Wrap the current selection in a subquery (or CTE) that computes:
   - `rank_score`: the existing summed rank expression, or 0 when there are no rank terms.
   - `niche_rank`: the existing niche CASE, or 0 when there's no niche ordering.
   - `creator_pos = ROW_NUMBER() OVER (PARTITION BY LOWER(posts.account_handle), niche_rank ORDER BY rank_score DESC, posts.posted_at DESC, posts.id DESC)`.
2. Outer `ORDER BY niche_rank DESC, ((creator_pos - 1) / N) ASC, rank_score DESC, posted_at DESC, id DESC`.
   - Integer division; use the same expression on PG and SQLite.
   - `N` = env `FEED_CREATOR_SPREAD`, a positive integer, default **2**.
   - Each creator contributes at most N reels per "round" before anyone gets more, so every creator's best 2 come first, then everyone's next 2, and so on.
   - `FEED_CREATOR_SPREAD=0` disables spreading and restores today's order exactly.
3. Pagination (LIMIT/OFFSET) applies to the outer query, so pages stay stable and non-overlapping.
4. Shuffle stays `RANDOM()`, untouched. The niche hard filter, easy-film clause, scope, rejects and visibility are unchanged; this is only ordering.
5. Keep SQL placeholders in ascending order (SQLite test adapter rule). Make sure the outer query still returns the same columns the callers use.

## Acceptance criteria
- Tests (`server/me-feed.test.js` or new):
  - Creator A has 6 high-score reels and B and C have 2 each. With N=2 the first 6 results are 2 A, 2 B, 2 C, each block ordered by score. A's remaining reels follow.
  - With `FEED_CREATOR_SPREAD=0` the order is identical to the pre-change order.
  - A preferred-niche reel still ranks above every non-niche reel.
  - Pages 1 and 2 don't overlap and cover everything.
  - Shuffle is unaffected.
  - Existing Film API, workspace and feed tests still pass.
- Commands: `cd server && NODE_USE_SYSTEM_CA=0 GEMINI_API_KEY= npm test`.
