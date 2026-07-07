# Plan Review Log: Plan 3 — Rolling Video Cache
Started 2026-07-07 session. MAX_ROUNDS=5. Reviewer: Codex (gpt-5.5, read-only).

## Round 1 — Codex

**Findings**

1. `posts.posted_at` exists, but the plan conflates retention age with URL freshness. Thumbnail sweep uses `scraped_at` for legacy null-status rows because signed URLs expire by scrape time, not post date. Fix: `posted_at >= retentionCutoff` for the 30-day window AND `scraped_at >= freshnessCutoff` (or `status='pending'`) for URL freshness.
2. Task 4's selector lets every `pending` row through even if `posted_at` is older than 30 days, contradicting the rolling window. Fix: put `posted_at >= retentionCutoff` OUTSIDE the pending/null-status OR.
3. Concurrent sweeps can race with re-scrapes: a slow download selected with an old `video_url` can later overwrite a freshly re-scraped row's status. Fix: `UPDATE ... WHERE id=$id AND video_url=$selectedVideoUrl`, or a claimed/leased status keyed by URL.
4. The in-flight map only dedups inside one Node process; scheduler + post-scrape sweeps + deploy overlap + multiple instances can still duplicate. Fix: DB claim step `pending -> downloading` with a lease timestamp before fetching.
5. In-flight key is just `id`/`shortcode`, so a refreshed `video_url` during an in-flight old download can reuse the wrong promise and cache stale bytes. Fix: key in-flight by post id + `video_url`/URL hash.
6. Size guard bypassable when `content-length` is absent or lies; `res.buffer()` can load an unlimited MP4 into memory. Fix: enforce max byte count while streaming (body size cap + post-buffer check, delete temp on overflow).
7. `GET /video/:id` returns `302` to the raw IG URL when uncached — leaks the signed CDN URL in `Location` and does not solve expired-URL gray screens (won't loop; target is external, but preserves the failure mode). Fix: remove redirect, return `404`/`202` so the client shows the poster.
8. Range handling incomplete: invalid/unsatisfiable ranges become full `200` instead of `416 Content-Range: bytes */size`; multi-range silently ignored. Fix: distinguish absent from invalid Range, return proper `416`; reject multi-range.
9. Streaming route TOCTOU crash: `statSync` succeeds, prune unlinks, then `createReadStream` emits an async error with no handler. Fix: `stream.pipeline` or `error` handlers → `404`.
10. Prune can delete a file/status after a concurrent scrape re-marked the post `pending`. Fix: claim / re-check the predicate in the same conditional UPDATE immediately before unlinking.
11. Task 7 only updates the main scrape upsert (`scraper.js:667`); URL imports at `scraper.js:1112` insert posts with video URLs but never enqueue caching. Fix: add `video_cache_status='pending'` to every insert path that writes a fresh `video_url`.
12. Auth prefix planned correctly, but no unauthenticated `/video/:id` test and no verification media requests carry session cookies. Fix: add a route/auth test; confirm same-origin/cookie behavior.
13. The schema test is vacuous: it creates and alters its OWN in-memory table, so it passes even if `db.js` is never changed. Fix: test `initDB()` against an isolated SQLite DB, assert the actual migration path.
14. Tests miss the risky behavior: no over-cap-without-header test, no in-flight dedup test, no stale URL race test, no `416` range test, no prune/sweep race test, no client/auth test. Fix: add focused pure tests per failure mode.
15. Simpler alternative: skip custom streaming + 302; mount `express.static(DEFAULT_VIDEO_DIR)` behind `requireAuth`, let Express handle ranges, client falls back to poster on `404`.

VERDICT: REVISE

### Claude's response (Round 1 → revised plan)

**Verified against real code before revising:** `posted_at` (db.js:102, TEXT) and `scraped_at` (db.js:107, TEXT DEFAULT NOW) both exist; thumbnail sweep freshness gate is `scraped_at` (thumbnails.js:74) — Codex #1 confirmed. Two scrape insert paths write `video_url`: main upsert (scraper.js:668) and URL-import `DO NOTHING` (scraper.js:1113) — Codex #11 confirmed. `/thumb` already serves via `res.sendFile` (index.js:911); `requireAuth` prefixes at index.js:101-116; client served by same Express app (index.js:928) → same-origin. `radar.test.js`/`content-types-seed.test.js` establish the in-memory sqlite adapter test pattern.

**Incorporated (9 findings):**
- #1/#2 → Task 4 selector split into retention (`posted_at >= retentionCutoff OR NULL`) and freshness (`pending OR (NULL AND scraped_at >= freshnessCutoff)`); freshness uses `scraped_at`, retention uses `posted_at`.
- #3 → per-item UPDATE guarded `WHERE id=$id AND video_url=$selectedUrl` so a re-scrape mid-flight can't be clobbered; stale write leaves row `pending` for next sweep. Added a stale-URL race test.
- #5 → in-flight key is `${key}:${video_url}` so a fresh URL starts a new download. Added a dedup test.
- #6 → `downloadVideo` streams `res.body` to a temp file with a running byte cap (abort+unlink over VIDEO_MAX_MB) instead of `res.buffer()`; enforces the cap with absent/lying `content-length` and never buffers a whole MP4 into memory. Added an over-cap-no-header test.
- #8/#9/#15 → `GET /video/:id` uses `res.sendFile(file, {acceptRanges:true}, errCb)`; Express gives correct Range/206/416/Content-Type and passes TOCTOU/stream errors to `errCb`→404. Dropped `parseRangeHeader` entirely (dead code). Added a `416` manual-verify curl.
- #10 → prune's status-clear UPDATE guarded `WHERE id=$id AND posted_at < cutoff`; ENOENT-safe unlink. Added a missing-file test.
- #11 → Task 7 now edits BOTH insert paths (scraper.js:668 upsert + scraper.js:1113 URL-import).
- #12 → Task 6 adds an extracted-handler test for the 404/sendFile/302/404 branches; documented same-origin cookie flow (client served by same Express app).
- #13 → Task 1 test now runs the REAL `initDB()` and SELECTs the three columns (throws if db.js untouched) instead of hand-writing its own DDL.
- #14 → the specific risky-path tests above folded into Tasks 3/4/5/6.

**Rejected (2 findings), with reasons:**
- #4 (cross-process `pending→downloading` DB lease): rejected. The app runs single-instance on Railway; the URL-guarded UPDATE (#3) + unique-temp atomic rename + url-scoped in-flight map (#5) eliminate the actual harms (stale overwrite, temp collision, stale-promise reuse). Worst residual = one redundant download to an idempotent atomic path (wasted bandwidth, bounded by batchLimit×concurrency). A lease adds a `downloading` state + stuck-lease reclamation for zero benefit at one instance. Noted as a future item if we ever scale horizontally.
- #7 (remove the 302 fallback because it "leaks" the signed URL and doesn't fix expired URLs): the *removal* is rejected; the 302 is kept but narrowed to the uncached branch. It lets a freshly-scraped-but-not-yet-swept video play immediately from its still-fresh URL; for an expired URL it degrades to `302→403→onError→poster`, identical to the already-shipped behavior, so it never does worse than a 404. No new exposure: the request is authenticated and same-origin, and the client already held that exact signed URL as its direct `<video src>` before Plan 3. (Codex's cleaner 404-and-poster was seriously considered; the fresh-play win tipped it.)
