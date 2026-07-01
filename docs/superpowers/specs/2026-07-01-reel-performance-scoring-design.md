# Reel-Performance Scoring + Pull-for-All Previews — Design

**Date:** 2026-07-01
**Branch:** `feat/reel-performance-scoring` (off `main`)

## Problem & root cause

Suggested-account cards show a stuck score of **17** on 53 of 84 pending accounts, and their
`followers / avg_er / posts_per_week` stats are all **0**. Confirmed on prod: 78/84 have
`followers=0`, 79/84 `avg_er=0`, 79/84 `posts_per_week=0`.

The score formula (`scoreCandidate`) is fine; its **inputs are empty**. The profile-detail
Apify actor (`_fetchProfileQuick`, generic actor) that fills followers/ER/posts-per-week is
the one Instagram keeps blocking, so it returns nothing → `scoreCandidate({collabStrength:1,
avgEr:0, postsPerWeek:0}) = round(16.67) = 17` for nearly everyone.

**Key asymmetry:** the **reel** actor works reliably (we pull real view/like/comment counts
per reel), even for accounts whose profile enrichment is blocked (e.g. `4mbuh`, `madisonlmills`
returned 3 reels each with views up to 6.4M while `followers=0`). So we rebuild scoring around
the data we *can* get: the reels.

## Locked decisions (from brainstorming)

1. **Score basis:** reel performance (not profile followers/ER).
2. **Reward:** blend of reach (avg views) + engagement (view-based ER).
3. **Capture:** pull reels for **every** reel-primary suggestion (remove the `reelsMax=8` cap);
   the score is a **display/ranking** filter, not a capture gate. A reel pull is ~$0.02.
4. **Below-threshold:** collapse behind a "Show N lower-scoring" toggle — **non-destructive**
   (no delete, no status change). Default threshold 60%, adjustable live in the UI.
5. **Backfill:** one-time pass over existing pending suggestions so today's list comes alive.

## Component 1 — `scoreReels(reels, cfg)` (pure, unit-tested)

New pure function in `server/scraper.js`, exported. Input: an array of reel objects in the
`pickTopReels` output shape (`{ viewCount, likeCount, commentCount, ... }`). Output: an integer
**0–100**.

```
scoreReels(reels, cfg = scoreConfig()):
  if !Array.isArray(reels) or reels.length === 0: return 0
  avgViews = mean(reels.map(r => Number(r.viewCount) || 0))
  avgER    = mean(reels.map(r => calcViewER(r.likeCount, r.commentCount, r.viewCount).er_percent))
  // Reach: log-scaled between floor and target.
  reachFrac = clamp( (log10(max(avgViews,1)) - log10(cfg.viewFloor))
                     / (log10(cfg.viewTarget) - log10(cfg.viewFloor)), 0, 1 )
  reachPts  = reachFrac * cfg.reachWeight
  // Engagement: linear up to the ER target.
  erPts     = clamp(avgER / cfg.erTarget, 0, 1) * cfg.erWeight
  return round(reachPts + erPts)
```

Reuses the app's existing `calcViewER` (from `engagement-metrics`; `er_percent =
(likes+comments)/views*100`, returns 0 when views≤0). Averaging is over the account's stored
top reels (their best 3) — this rewards **hit potential** (what the creator is capable of),
which is the intent for a reels-scouting tool.

**Worked examples (defaults below):** avg 1M views + 6% ER → 60+40 = **100**; avg 100K + 3% →
40+20 = **60**; avg 10K + 2% → 20+13 = **~33**; avg 2K + 0.5% → 6+3 = **~9**; no reels → **0**.

### `scoreConfig(env)` (mirrors `discoveryConfig` num() pattern)

| Field | Env var | Default | Meaning |
|-------|---------|---------|---------|
| `viewFloor` | `SUGGEST_VIEW_FLOOR` | `1000` | avg views at/below → 0 reach |
| `viewTarget` | `SUGGEST_VIEW_TARGET` | `1000000` | avg views at/above → full reach |
| `reachWeight` | `SUGGEST_REACH_WEIGHT` | `60` | max reach points |
| `erTarget` | `SUGGEST_ER_TARGET` | `6` | ER% at/above → full engagement |
| `erWeight` | `SUGGEST_ER_WEIGHT` | `40` | max engagement points |

All tunable without a redeploy. `reachWeight + erWeight` need not equal 100, but the defaults do.

## Component 2 — capture-for-all + scoring wiring

**`captureTopReels(username)` (`server/scraper.js`)** — after persisting the reels (existing
behavior), also:
- `const score = scoreReels(reels, scoreConfig())`
- `UPDATE suggested_accounts SET suggestion_score = $1 WHERE username = $2` (runs even when
  `score === 0`, i.e. no reels captured — a blocked/private account correctly drops to 0).
- Return `{ count: reels.length, score }` (was: `count`; callers currently ignore the return —
  Task-5 discovery wiring does not use it, so this is safe).

**`runDiscovery` (`server/scheduler.js`)** — two changes:
- **Remove the reels cap:** capture reels for every newly-inserted suggestion. `reelsMax` default
  changes to **0 = unlimited**; the wiring treats `0`/falsy as "no cap." The existing budget guard
  (`BudgetExceededError` → `reelsBudgetStop`) and the `freshKept.slice(0, 50)` insert bound still
  apply, so a cycle captures at most ~50 reels regardless.
- **Stop the collab score-bump on repeats:** the cross-cycle accumulation `UPDATE` currently bumps
  `suggestion_score` by the collab-based `scoreCandidate`. Since the score is now reel-based, that
  would corrupt it — remove the `suggestion_score = CASE ...` clause from that UPDATE, keeping the
  source-token merge and `relevance_reason` refresh. (Score is set once at capture; refreshing it
  on repeats is out of scope for v1.)

The initial INSERT can keep writing the provisional `scoreCandidate` value; `captureTopReels`
overwrites it with the reel score moments later. If capture is skipped (budget stop), the
provisional collab score remains as a graceful fallback.

## Component 3 — serving

**`GET /suggested` (`server/index.js`)** — add `like_count, comment_count` to the `top_reels`
SELECT (so the client can compute view-ER). Ordering already defaults to `suggestion_score DESC`
via `suggestionsOrderClause('score')` — no change. No new columns anywhere; the score lives in
the existing `suggestion_score`, display stats derive from the joined `top_reels`.

## Component 4 — frontend (`client/src/pages/SuggestedAccountsTab.js`)

- **Reel-derived card stats** replace the always-zero `followers / ER / posts-per-week` block:
  from each account's `top_reels`, show **avg views**, **view-based ER** (with the existing
  Good/Viral label), and the **reel score** as a badge. `followers` is shown only when `> 0`.
  The score badge uses the server's `suggestion_score` (already on the account). A small pure
  client helper `reelStats(top_reels)` → `{ avgViews, avgER }` computes only the two **display**
  stats from the joined reels (it does not recompute the score). Empty `top_reels` → zeros, and
  the stat block falls back to hidden/neutral rather than showing "0 views".
- **Threshold collapse:** accounts arrive already sorted by score (server). The tab renders
  accounts with `suggestion_score >= threshold` normally; those below collapse behind a
  **"Show N lower-scoring"** toggle. `threshold` defaults to **60**, is adjustable via a small
  numeric input in the tab header, and persists in `localStorage` (`suggestScoreThreshold`).
  Purely client-side; nothing is mutated server-side.

## Component 5 — backfill routine

A committed one-off script `server/scripts/backfill-reel-scores.js`:
- Selects pending `suggested_accounts` (optionally only those with no rows in `suggested_reels`).
- For each, `await scraper.captureTopReels(username)` (which now also scores + updates).
- Bounded by the budget guard: catch `BudgetExceededError` → stop cleanly; other errors →
  log and continue. Logs `captured/scored` per account and a final summary.
- Run **once against prod** via `railway ssh` after deploy (~84 accounts, ~$1.70). Reusable later.

## Testing (TDD)

- **`scoreReels`** (pure): empty/`null` → 0; high views + high ER → ~100; reach-only and ER-only
  contributions; the log-reach buckets (1K→0, 100K→~40, 1M→60); ER clamp at target; a realistic
  mixed case. Boundary at threshold.
- **`scoreConfig`**: default, env override, non-numeric fallback (mirrors `discoveryConfig` test).
- **`reelStats` helper** (if extracted as pure): avg views + ER from a reel list; empty → zeros.
- **Accumulation UPDATE change**: update `discovery-reach.test.js` — the repeat UPDATE no longer
  changes `suggestion_score` (assert score unchanged; source-token merge still works).
- **`reelsMax` default**: update the Task-4 assertion — default is now `0`, and `0` means the
  discovery loop applies no reel cap.
- **Integration** (capture→score→serve): verified by running the backfill on prod and re-checking
  `suggestion_score` distribution + a `/suggested` sample (no unit harness for the network/DB glue,
  consistent with the existing capture path).

## Out of scope (YAGNI)

- Re-pulling reels / re-scoring on every discovery repeat (score is set once at capture).
- Blending collab-relevance back into the displayed score.
- Un-blocking the profile actor (residential proxies) — the reel-based score makes it unnecessary.
- Applying reel-performance scoring to Reel Radar's author rollup.
