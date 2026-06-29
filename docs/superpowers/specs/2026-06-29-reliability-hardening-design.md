# Reliability Hardening — Design Spec

- **Date:** 2026-06-29
- **Status:** Approved (pending user spec review)
- **Scope:** Sub-project A of the InstaScraper improvement roadmap (A reliability → B AI ideas → C scraping reach/cost → D library UX)
- **Surface area:** Backend (`server/`) + Railway config only. No client/UI changes.

## Background

On 2026-04-08 the Railway trial lapsed and stopped both the app and Postgres. After recovery (2026-06-29) we found a second failure mode: the app service had **no persistent disk**, so every redeploy wiped the `server/thumbnails/` cache, and Instagram CDN thumbnail URLs are signed/short-lived — so old posts returned `502` (`HTTP 403` from Instagram). A persistent volume (`instascraper-volume` at `/app/server/thumbnails`) was added during recovery; this spec hardens the remaining fragility so the app degrades gracefully and the image asset stops rotting.

## Goals

1. Thumbnails become durable — captured while URLs are fresh, stored safely, and re-scrapes can heal broken ones.
2. The app survives a transient Postgres outage without crash-looping, and recovers on its own.
3. Railway can tell liveness from readiness; deploys and restarts behave predictably.
4. Postgres data is backed up with a verified restore path.
5. Enough logging to notice the next problem before the user does.

## Non-Goals (explicitly out of scope for now)

- Object storage (S3/R2) for thumbnails — Railway volume + managed backups are sufficient at current scale. Revisit if thumbnails become canonical "data."
- Cron advisory-locking / distributed job coordination — the service runs **1 replica** (`numReplicas: 1`), so in-process `node-cron` is safe. Becomes a prerequisite only if scaled horizontally.
- Any client/UI work, AI model changes, or scraping-cost work (those are sub-projects B–D).

## Components

### 1. Durable thumbnails

**1a. Shared download helper.** Extract the fetch-and-cache logic currently inline in the `/thumb/:postId` route ([server/index.js:729](../../server/index.js)) into `downloadThumbnail(post)` (new module, e.g. `server/thumbnails.js`). Behavior:
- Resolve cache path `THUMB_DIR/<shortcode>.jpg`.
- If a valid (non-zero-byte) cached file exists, return it.
- Fetch `post.thumbnail_url` with the existing browser User-Agent, **bounded timeout**.
- On success: write to a **temp file**, validate `Content-Type` is an image and size > 0, then **atomic rename** into place.
- On `403`/`404`: mark as expired, **do not retry aggressively**.
- **In-flight dedup:** an in-process map prevents two concurrent callers from downloading the same shortcode at once.
- The `/thumb` route and the sweep both call this helper (single code path).

**1b. Sweep.** `sweepThumbnails({ maxAgeDays = 14, batchLimit = 200 })`:
- **Selection (precise):** posts where `thumbnail_cache_status IS NULL OR thumbnail_cache_status = 'pending'` (i.e. never successfully cached and not marked `expired`/`error`), `scraped_at` within `maxAgeDays`, ordered newest-first, capped at `batchLimit` per run. This bounds cost and skips known-dead URLs.
- **Low concurrency (e.g. 3–4) with jitter** between requests to avoid hammering Instagram.
- Calls `downloadThumbnail` per post; records outcome into the cache-state columns.

**1c. Triggers.**
- After each scrape: call the sweep for the just-scraped account at the end of `_fetchAndStoreResults` ([server/scraper.js:306](../../server/scraper.js)) — non-blocking (don't fail the scrape if a download fails).
- A **once-daily** safety-net cron in `startScheduler` ([server/scheduler.js:154](../../server/scheduler.js)) running `sweepThumbnails({ recentOnly: true })`.

**1d. Cache-state columns.** Add to `posts`: `thumbnail_cache_status` (`pending` | `cached` | `expired` | `error`) and `thumbnail_cache_error` (text, nullable). Used to skip known-expired URLs and to power observability counts. Added via the existing idempotent `ADD COLUMN IF NOT EXISTS` pattern in `initDB`.

**1e. Upsert fix (heals old thumbnails).** Change the posts insert at [server/scraper.js:283](../../server/scraper.js) from `ON CONFLICT (shortcode) DO NOTHING` to `ON CONFLICT (shortcode) DO UPDATE SET` for **scrape-derived fields only** — `thumbnail_url`, `video_url`, `like_count`, `comment_count`, `view_count`, `followers_at_scrape`, `er_percent`, `er_label` — while **preserving user-owned fields** (`tag`, `notes`, `content_type`, `archived`, `soft_deleted`). When `thumbnail_url` changes, reset `thumbnail_cache_status` to `pending` so the sweep re-downloads the fresh image. This is what makes a re-scrape repair a previously-broken thumbnail.

### 2. DB-blip resilience

**2a. Bounded, classified boot retry.** Wrap `initDB()` ([server/db.js:78](../../server/db.js)) in retry-with-backoff:
- Retry on transient errors (DNS `ENOTFOUND`, `ECONNREFUSED`, connection timeouts) with exponential backoff + cap.
- **Fail loudly** (log and exit non-zero) on non-transient errors: authentication failure, malformed `DATABASE_URL`, missing database. Do not loop forever masking a misconfiguration.

**2b. Pool error handling.** Add `pool.on('error', ...)` for idle-client errors so an unexpected socket drop doesn't become an uncaught exception.

**2c. Async error middleware.** Add a wrapper so async route handlers' rejections are caught, plus centralized Express error middleware that **classifies**:
- DB-connection/availability errors → **503** `{ error: "temporarily unavailable" }`.
- Everything else → **500** (real bugs stay visible; we do not blanket-mask them as 503).

Once Postgres returns, the `pg` Pool reconnects on the next query and the app recovers without a manual restart.

### 3. Healthcheck (liveness vs readiness)

- `GET /live` (no auth) → always `200` if the process is responding. Pure process liveness; used for monitoring, **not** the Railway gate.
- `GET /ready` (no auth) → **readiness latch:** `200` once `initDB` has succeeded **at least once** since boot, and **stays `200`** thereafter (one-way latch); `503` before the first successful init. The JSON body includes a `db: "up" | "down"` field reflecting *current* reachability (informational — does not flip the latch).
- **Railway healthcheck → `/ready`** (corrected; was `/live`). This gates the deploy correctly in both directions:
  - A deploy with a broken DB (bad `DATABASE_URL`, failed schema init, unreachable DB) **never becomes ready, so it is never promoted** — the previous good deployment keeps serving instead of shipping a broken release.
  - Once an instance has initialized, the latch holds `/ready` at `200` through transient **runtime** DB blips, so Railway does **not** kill a recovering app. Runtime DB errors surface as clean `503`s on data routes (component 2c) and recover via pool reconnect.
- Set Railway's healthcheck **timeout** generously enough to cover the bounded boot-retry window (component 2a), so a brief DB-startup delay doesn't fail an otherwise-good deploy.
- This pairs with 2a's fail-loud behavior: a non-transient config error exits the process, which also fails the deploy rather than promoting it.
- **Volume sanity check at boot:** log `THUMB_DIR`, assert it exists and is writable; warn loudly if it's not the mounted volume.

### 4. Backups & observability

**4a. Backups.** Enable **Railway's built-in scheduled Postgres backups** (managed, off-host snapshots — satisfies DR without external storage). Verify the upgraded plan includes scheduled backups; if not, the fallback is a daily `pg_dump` cron that uploads **off-platform** (not to the same volume). Perform **one manual restore drill** to confirm a backup is actually restorable.

**4b. Observability.** Structured log counters for: thumbnail cache hit / miss / fail, sweep duration + failure count, DB-unavailable intervals (entered/recovered), backup success/failure, scrape-job failures by account.

## Data Model Changes

`posts` table — two new nullable columns (idempotent `ADD COLUMN IF NOT EXISTS`):
- `thumbnail_cache_status TEXT` — `pending` | `cached` | `expired` | `error`
- `thumbnail_cache_error TEXT`

No other schema changes. Dual-mode (`db.js`) must keep working for local SQLite: the `ON CONFLICT DO UPDATE` and new columns need SQLite-compatible handling (the existing translation layer already maps `ON CONFLICT`/`ADD COLUMN`; verify `DO UPDATE SET ... EXCLUDED` translates or is guarded by `USE_PG`).

## Testing Strategy (TDD)

Write tests first, per unit:
- `downloadThumbnail`: success (atomic write), `403`/`404` (marks expired, no retry storm), already-cached (no refetch), zero-byte/corrupt response rejected, in-flight dedup.
- `sweepThumbnails`: selects only uncached recent posts, respects concurrency cap, records per-post outcome, never throws out of the trigger.
- Upsert: re-inserting an existing shortcode updates `thumbnail_url` + resets cache status, but leaves `tag`/`notes`/`content_type` untouched.
- DB resilience: transient error → retries then succeeds; auth/config error → fails fast; route DB error → 503; non-DB error → 500.
- `/live` returns 200 with DB up and DB down; `/ready` returns 200 only with DB up.

## Rollout / Deployment Notes

- Volume `instascraper-volume` at `/app/server/thumbnails` is already attached (done during recovery).
- Set Railway service **healthcheck path** to `/ready` (readiness latch), with a healthcheck timeout that covers the boot-retry window.
- Enable Railway Postgres **backups** in the dashboard.
- Deploy via the normal path (GitHub `main` auto-deploy, or `railway up`); confirm `/live`, `/ready`, and a freshly-scraped `/thumb` all behave post-deploy.

## Open Questions

- Does the current Railway plan include scheduled Postgres backups? (Verify in dashboard; affects whether 4a uses built-in or the `pg_dump` fallback.)
- Off-platform target for the `pg_dump` fallback if needed (R2/S3/Backblaze) — only relevant if built-in backups are unavailable.
