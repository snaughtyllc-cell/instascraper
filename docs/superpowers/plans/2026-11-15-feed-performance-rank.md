# Plan: rank model feeds by reel performance (views vs creator median)

Date: 2026-11-15 · Approved by user ("Yes, rank by it") · Branch `feed-performance-rank` off `main`

## Goal
A model's feed (InstaScraper `/me/feed`, the workspace reels view, and Film `/film/v1/models/:id/feed`, all built by `buildMeFeedQuery` in `server/me-feed.js`) is ordered by niche, then look match + learned taste, then newest. View count isn't used at all, so a flop sits above a creator's biggest hit just because it's newer. Add a **performance score** so reels that beat their own creator's usual views rise. It only reorders the feed and never filters anything out.

## Approach
1. **Column.** Add `posts.perf_score REAL` (nullable) using the existing idempotent ALTER pattern (see `server/sort-migration.js` `ensureSortStatus`; add it there or alongside in the same boot path, working for both PG and SQLite).
2. **New module `server/perf-score.js`.**
   - Pure `computePerfScores(rows, { minReels = 5 } = {})`. `rows` are `{ id, view_count }` for ONE creator; it returns `Map<id, number|null>`.
     - Eligible rows have `view_count > 0`. If there are fewer than `minReels` eligible rows, every score is `null`.
     - `median` uses the existing `median()` from `server/engagement-metrics.js`. If median ≤ 0, every score is `null`.
     - Score = `clamp(log2(view_count / median), -2, 2)`, rounded to 3 decimals. Ineligible rows (views 0/null) get `null`.
   - `async refreshPerfScores(pool, handles = null)`. `null` means every distinct `account_handle` in posts.
     - For each handle, read its non-archived, non-soft-deleted posts (same filter as `medianViewsByAccount`).
     - Compute the scores, then UPDATE `perf_score` only where the value changed (NULL-safe comparison).
     - Archived and soft-deleted posts of that handle are left untouched.
     - Placeholders must be in ascending order (SQLite test adapter rule).
     - Return `{ handles, updated }`.
   - Env `PERF_MIN_REELS` overrides `minReels` (default 5).
3. **Keep it fresh.**
   - After a scrape job finishes saving posts for a creator (find the completion point in `server/scraper.js` `startScrapeJob` / its save path), call `refreshPerfScores(pool, [handle])`. Errors are caught and logged as `[PerfScore] ...`; it must never fail the scrape.
   - Also do this anywhere existing posts' `view_count` gets refreshed, if such a path exists.
   - At boot, run `refreshPerfScores(pool)` once in the background (non-blocking, caught), so existing reels get scores right after deploy.
4. **Rank by it** in `buildMeFeedQuery` (not shuffled only).
   - Add the term `COALESCE(posts.perf_score, 0) * <W>` into the same summed rank expression as look and taste terms.
   - `W` comes from env `FEED_PERF_WEIGHT`, default `1`. Pass it as a bound param, or inline it as a validated finite number. If it's not finite or < 0, use 1. When `W = 0`, the term is omitted.
   - Resulting order: `nicheOrder, (look + taste + perf) DESC, posts.posted_at DESC`. The term applies even when there are no look/taste terms.
   - `shuffle` stays `RANDOM()` with no perf term. The `all` mode behaves as today, plus the perf term when not shuffled.
   - The niche hard filter, scope and visibility are unchanged. Nothing is filtered by perf.
5. Don't change Film API response shape, suggestion scoring, or the admin library sorts.

## Key decisions & tradeoffs
- **Relative to the creator's own median** (not raw views), so small creators' hits compete with big accounts' average posts.
- **log2 clamped to ±2.** 4× median = +2 and ¼ median = −2, comparable to one or two look-tag matches (each 0/1) and taste (−1..1). One freak viral reel can't drown out everything.
- **Stored column, not computed per query.** Median isn't portable SQL (PG vs SQLite), and the feed query must stay a single SQL statement.
- **Minimum 5 reels** before scoring a creator, so medians aren't noise.

## Risks / open questions
- Old viral reels from a creator's last ~50 posts may stick near the top. `posted_at` stays the tiebreaker, and the clamp limits this. A recency decay is out of scope.
- The boot backfill touches every post once. At current scale (thousands of rows) per-row updates are fine.

## Out of scope
Hiding low performers; recency decay; showing the score in UI; changing suggestion/proposal scoring.

## Acceptance criteria & verification
- Unit tests for `computePerfScores`:
  - fewer than 5 eligible → all null
  - even-count median
  - clamp at ±2
  - views 0/null → null
  - median-equal reel → 0
- SQLite integration test: `refreshPerfScores` writes scores, leaves archived/soft-deleted rows alone, and a second run reports 0 updated.
- `me-feed.test.js` (or a new test):
  - Within the same niche with equal look/taste, a higher-`perf_score` reel ranks above a newer lower one.
  - `FEED_PERF_WEIGHT=0` restores newest-first.
  - shuffle has no perf term.
  - A preferred-niche reel still ranks above any non-niche reel regardless of perf.
- Existing Film API and workspace tests still pass.
- Commands (must pass):
  - `cd server && NODE_USE_SYSTEM_CA=0 GEMINI_API_KEY= npm test`
  - `cd client && NODE_USE_SYSTEM_CA=0 CI=true npm run build`. No client change is expected; this just confirms nothing broke.

## Addendum (user, same day): team "Not a good pick" on workspace reels
The user reviews the reels in a model's workspace (`client/src/components/ModelWorkspace.js` reels list, served by `GET /workspaces/:modelId/reels`). They can't remove a bad pick for that model, and the system can't learn from it.

1. **Server:**
   - `POST /workspaces/:modelId/reels/:postId/reject` records `not_my_style` for that model on that reel. Reuse the existing skip logic in `server/model-reactions.js` (the same path Film's skip uses), including the taste refresh (`refreshTaste` / `recomputeTaste`).
   - The reel immediately drops out of her feed: `/me/feed`, the workspace reels list and Film. Taste learns from it, so similar reels (same creator, type or look tag) sink. Nothing is banned globally, and other models are unaffected.
   - A reel outside her scope or not visible returns 404 `{ error: 'reel_not_available' }`.
   - `DELETE /workspaces/:modelId/reels/:postId/reject` is the undo. It removes that `not_my_style` feedback row and refreshes taste, and the reel returns to her feed.
   - Both are behind the same admin auth as the other workspace routes.
2. **Client:**
   - Each reel card in the workspace reels list gets a "Not a good pick" button. Clicking it removes the card from the list and shows a short "Removed from <model>'s feed · Undo" notice. Undo calls the DELETE and restores the card.
   - Errors show inline and don't silently swallow.
3. **Tests:**
   - Reject hides the reel from `buildMeFeedQuery` for that model only, and taste records a negative.
   - Undo restores the reel.
   - Out-of-scope returns 404.
   - The same verification commands must pass.
