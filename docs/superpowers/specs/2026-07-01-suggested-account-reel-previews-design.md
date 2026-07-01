# Suggested-Account Reel Previews — Design

**Date:** 2026-07-01
**Status:** Approved (pending spec review)
**Branch:** `feat/suggested-reel-previews`

## Goal

Let the team vibe-check a discovered creator in seconds — **without leaving the app**. Each
card in the **Suggested Accounts** tab shows that account's **top 3 reels by views** as
glanceable thumbnails; clicking one plays the reel inline. Today the card shows only
name + stats + bio, forcing a trip to Instagram to judge whether a creator is worth
pursuing. Previewing the actual content in-place makes triage far faster.

## Locked decisions (from brainstorming)

1. **Preview style:** glanceable **thumbnails** in the card → **click one to watch inline**
   (reuse the existing `ContentCard` `<video>` play pattern). Not autoplay loops, not
   link-out-only.
2. **When captured:** **eagerly at discovery** — when discovery inserts a *new* suggestion,
   fetch its top reels then, so thumbnails are cached and instantly visible.
3. **Ranking:** **top 3 by views** (the reel actor's real view counts).
4. **Storage:** dedicated **`suggested_reels` child table** (approach A), so we reuse the
   existing shortcode-keyed thumbnail cache and a `/thumb`-style serving route.
5. **Cost bound:** the eager reel fetch is **bounded + env-tunable** — `DISCOVERY_REELS_MAX`
   (default 8, matching `enrichMax`) reel-actor calls per discovery cycle.
6. **Video freshness (v1):** play the stored `video_url`; if it's expired (404/403), **fall
   back to opening the reel on Instagram** via the stored permalink. No per-click Apify cost.

## Architecture

Data flows: **reel actor → `pickTopReels` → `suggested_reels` (+ cached thumbnails) →
`/suggested` join → card reel strip → inline `<video>`**.

### 1. Capture — `server/scraper.js`

- **`pickTopReels(items, n = 3)`** — *pure, the primary TDD target.* Given raw reel-actor
  dataset items: keep only videos/reels, sort by view count descending, take the top `n`,
  and map each to the stored shape:
  `{ shortcode, thumbnailUrl, videoUrl, viewCount, likeCount, commentCount, permalink, postedAt }`.
  - Views via the existing `extractViews(item)` helper (real from the reel actor).
  - `permalink` = `item.url` or `https://www.instagram.com/reel/{shortCode}/`.
  - If the account has fewer than `n` reels, return what exists (0–2 is valid).
  - Skips error-stub responses: `pickTopReels` on an `isErrorStubResponse` input returns `[]`
    (reuse the existing predicate so blocked/not-found accounts simply yield no previews).
- **`_fetchTopReels(username)`** — runs the **reel actor** for `username` with a small
  `resultsLimit` (12 — a pool big enough to rank a top-3 without full-scrape cost), waits
  for the run, and returns `pickTopReels(items, 3)`. One Apify call. Returns `[]` on
  failure/blocked (never throws into discovery).

### 2. Discovery wiring — `server/scheduler.js`

- Extend `discoveryConfig(env)` with `reelsMax: Math.floor(num(env.DISCOVERY_REELS_MAX, 8))`.
- In `runDiscovery`, after a candidate is **successfully inserted** as a new suggestion
  (`ins.rowCount > 0`), and while the per-cycle count is under `reelsMax`, call
  `_fetchTopReels(item.username)` and persist the results into `suggested_reels`. Then
  fire-and-forget `downloadThumbnail(reel)` for each (same pattern as the post-scrape
  `sweepThumbnails` call) so thumbnails are cached immediately.
- Bounded and best-effort: a reel-fetch failure for one account never aborts the cycle;
  the account still appears (just without previews). Respects the existing
  `BudgetExceededError` flow — if budget trips mid-cycle, we stop fetching reels like any
  other Apify call.

### 3. Storage — `server/db.js` (additive, dual-mode PG + sqlite twins)

```
CREATE TABLE IF NOT EXISTS suggested_reels (
  id            <SERIAL>,
  username      TEXT NOT NULL,          -- the suggested account (suggested_accounts.username)
  shortcode     TEXT UNIQUE NOT NULL,
  thumbnail_url TEXT,
  video_url     TEXT,
  view_count    INTEGER DEFAULT 0,
  like_count    INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  permalink     TEXT,
  posted_at     TEXT,
  rank          INTEGER DEFAULT 0,      -- 1..3, by views desc
  captured_at   TEXT DEFAULT <NOW_DEFAULT>
)
```

- Insert with `ON CONFLICT (shortcode) DO NOTHING` (a reel is captured once).
- Follows the dual-mode conventions: `$1..$n` each once ascending; `NOW_DEFAULT` format;
  added to **both** the PG `CREATE TABLE` block and the sqlite twin (this is a new table, so
  it lives in the create-table section, not the `ADD COLUMN` migration arrays).
- No FK constraint (matches the repo's existing loose relational style, e.g. `posts` ↔
  `tracked_accounts`); `username` is the join key.

### 4. Serving — `server/index.js`

- **`GET /suggested/reels/:id/thumb`** (behind `requireAuth`, mirrors `/thumb/:postId`):
  look up the reel by id, `downloadThumbnail({ shortcode, thumbnail_url })`, `sendFile` the
  cached jpg, else 502. This heals expiry on view (re-download if the cache missed).
- **`GET /suggested`** response gains a `top_reels` array per account (joined from
  `suggested_reels`, ordered by `rank`), each item:
  `{ id, shortcode, view_count, video_url, permalink }` (+ whatever the strip renders).

### 5. Frontend — `client/src/pages/SuggestedAccountsTab.js`

- New **`<SuggestedReelStrip reels={s.top_reels} />`** rendered inside `renderCard`, between
  the stats grid and the action buttons. A row of up to 3 tiles; each tile:
  - thumbnail `<img src={`${API_URL}/suggested/reels/${reel.id}/thumb`} />` with an
    `onError` fallback to the raw `thumbnail_url` (mirrors `ContentCard`);
  - a **view-count badge** (`2.1M`, reuse `formatCount`);
  - a play button that, on click, swaps that tile to an inline
    `<video src={reel.video_url} controls autoPlay>` — reuse `ContentCard`'s `showVideo`
    state pattern. On video error, fall back to opening `reel.permalink` on Instagram.
- If `top_reels` is empty (older suggestions, blocked accounts), render nothing (card looks
  like today).

## Error handling & edge cases

| Case | Behavior |
|---|---|
| Account has 0 reels / <3 | Store what exists; strip shows 0–2 tiles (or nothing). |
| Reel actor blocked / not_found | `_fetchTopReels` → `[]` (via `isErrorStubResponse`); card shows no strip. |
| Reel-fetch Apify error | Caught; account still inserted without previews. |
| Thumbnail URL expired on view | `/suggested/reels/:id/thumb` re-downloads; if still 403/404 → `onError` shows raw URL, else broken-image placeholder. |
| Video URL expired on click | `<video>` error → fall back to opening `permalink` on Instagram. |
| Budget exceeded mid-cycle | Reel fetch obeys `BudgetExceededError` like other Apify calls; remaining accounts get no previews this cycle. |

## Cost

Bounded: **≤ `DISCOVERY_REELS_MAX` (default 8) reel-actor calls per discovery cycle**, one
per newly-inserted suggestion. Each is a small `resultsLimit: 12` reel run. No per-view or
per-click Apify cost (thumbnails cached; video plays the stored URL or links out).

## Testing (TDD, `node --test`, server suite)

- **`pickTopReels`** (pure — primary target): filters non-videos out; sorts by views desc;
  caps at N; handles `<3` reels; handles missing/zero views; returns `[]` for an
  `isErrorStubResponse` input; maps fields (permalink fallback, shortcode).
- **`discoveryConfig.reelsMax`**: default 8, env override, non-numeric fallback (mirrors the
  existing `discovery-reach.test.js` config test).
- **`suggested_reels` insert round-trip**: dual-mode `$n → ?` shape validated against an
  in-memory sqlite (mirrors the existing reel_share persistence test), incl. `ON CONFLICT
  (shortcode) DO NOTHING`.
- Frontend (`SuggestedReelStrip`) has no test harness in this repo (server-only
  `node --test`); backend pure logic carries the TDD, with a manual UI check before merge.

## Out of scope (YAGNI)

- Backfilling reels for suggestions discovered before this ships.
- Auto-refreshing expired `video_url`s (on-click refetch) — revisit only if stale playback
  is a real annoyance.
- Applying reel previews to **Reel Radar** (`server/radar.js`) — separate track, on hold.
- Cleaning up `suggested_reels` when an account is approved/dismissed (harmless to keep).
