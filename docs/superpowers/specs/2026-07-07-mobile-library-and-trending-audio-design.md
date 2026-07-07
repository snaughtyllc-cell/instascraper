# Design: Mobile-ready Library + Trending Audio (for the models)

**Date:** 2026-07-07
**Status:** Approved for planning
**Author:** brainstorming session (Jeff + Claude)

## Context

We want to open the InstaScraper **Library** to our models on their **phones** so they can scroll it like a normal social feed and act on it themselves. Today it's a desktop-first admin tool, and six things block a good phone experience. Each decision below was made with Jeff during brainstorming.

## Problems being solved

1. **Video hijacks the screen.** Tapping play on mobile throws the video into iOS fullscreen; the model must back out to keep scrolling or make an edit. Root cause: `client/src/components/ContentCard.js:127-133` renders `<video controls autoPlay>` **without `playsInline`**, so iOS takes over. There's also no scroll-based autoplay — everything is tap-to-play.
2. **Videos sometimes don't load.** Videos stream from Instagram's raw signed `video_url`, which expires fast (hours-to-a-day, keyed to *scrape time*, not post age). Thumbnails are cached server-side (`/thumb/:id`); videos are not.
3. **Content/creator types are hardcoded** in two frontend files (`ContentCard.js:12-19`, `FilterBar.js:82-89`); adding one needs a code change.
4. **No fast path back to Instagram.** Cards link only to the creator *profile* (`ContentCard.js:230-237`); a model who wants to save/repost a specific reel has to hunt for it.
5. **Duplicate / trial reels clutter the feed.** Dedup is by `shortcode` only (`server/db.js:88`), so the same video re-posted with a new caption becomes separate rows and the model scrolls past repeats.
6. **No trending-audio insight.** Models want to know which sounds are heating up in their lane so they can make reels with them. We capture **zero** audio data today.

## Decisions locked

- **Video UX:** IG/TikTok-style **autoplay-on-scroll**, muted, inline, one at a time, tap-to-unmute, never fullscreen.
- **Reliability:** **Re-resolve on demand** (one-tap "reload" when a video is dead) **+ log every expiry** so we learn the real breakage rate before investing in caching. No Railway volume / no video caching this round.
- **Types:** **One shared editable list** powering the creator default, the per-video override, and the filter — addable on the fly.
- **Duplicates:** **Auto-hide** in the library (keep the primary, hide the rest behind a toggle), matched by **perceptual cover-image hash**, non-destructive.
- **IG link:** an **"Open on Instagram"** button on every card → the specific reel.
- **Trending audio:** **trending within our niche** (aggregate audio from reels we already scrape), not global IG — a "Reel Radar for sounds."

---

## Feature 1 — Mobile autoplay-on-scroll, inline video

**Files:** `client/src/components/ContentCard.js`, `client/src/pages/LibraryTab.js`

- Add `playsInline muted` to the `<video>` (fixes iOS fullscreen takeover; muted is required for autoplay).
- **Autoplay-in-view, opt-in via prop.** `ContentCard` is shared by Library **and** `RadarTab.js`, so gate behind a new prop (e.g. `autoplayInView`); do not change default behavior. Enable from `LibraryTab` only for now.
  - A single `IntersectionObserver` (owned by `LibraryTab` or a small `useActiveInView` hook) tracks the **most-visible card** and passes `isActive` down. Only the active card swaps its thumbnail `<img>` for an autoplaying muted `<video>`; others show the cached thumbnail. This gives "one at a time" and avoids 24 simultaneous decodes.
  - Scope to **touch/small screens** (`window.matchMedia('(pointer: coarse)')` or a `max-width` check). Preserve the existing desktop hover→play-button flow.
- **Unmute control:** small speaker toggle overlay on the active card; unmute persists across cards for the session.
- Keep the existing tap-to-play button as fallback for non-autoplay contexts.

## Feature 2 — Re-resolve dead videos on demand + expiry telemetry

**Files:** `server/scraper.js`, `server/index.js`, `client/src/api.js`, `client/src/components/ContentCard.js`

- **New endpoint `POST /content/:id/refresh-video`:** run the **reel actor** (`REEL_ACTOR_ID` — not the generic import path, which is `ON CONFLICT DO NOTHING` and won't refresh) for that one post via the existing `_startApifyRun`, then `UPDATE posts SET video_url, thumbnail_url, thumbnail_cache_status='pending' WHERE id=$1`, and return the fresh `video_url`.
- **Telemetry ("measure first"):** record each refresh as an Apify run with `purpose: 'video_refresh'` via the existing `recordRunLaunch`/`recordRunResult`. That gives both **frequency** (video_refresh runs / 7d = real breakage rate) and **cost** in the existing `apify_runs` ledger — no new table. Also emit `[Metric] video_expired`.
- **Budget guard:** reuse the existing $10/30-day ceiling check before launching; if over budget, return a clear message the UI shows instead of silently spending.
- **UI:** on `<video>` `onError` (403/expired), show a "Video expired — tap to reload" overlay → spinner → `refreshVideo(id)` → set new `src` and play. Communicate the ~15–60s Apify cold start with the spinner.

## Feature 3 — Editable shared type list

**Files:** `server/db.js`, `server/index.js`, `client/src/api.js`, `client/src/components/ContentCard.js`, `client/src/components/FilterBar.js`, `client/src/pages/LibraryTab.js`

- **New table `content_types`** (`id`, `value` slug, `label`, `sort_order`, `created_at`), seeded with the current six: talking, dance, skit, snapchat, omegle, osc. Add via the migration pattern at `db.js:309-333`.
- **Endpoints:** `GET /content-types`, `POST /content-types` (`{label}` → slugify → `value`, ignore dupes), `DELETE /content-types/:id`. Deletion removes only the pick-list entry; existing `posts.content_type` / `creator_types.content_type` are plain strings, so assignments survive (safe delete, loose coupling).
- **Frontend:** fetch the list once in `LibraryTab` (alongside `getCreators()`), pass into `ContentCard` (both dropdowns) and `FilterBar` (type filter), replacing the two hardcoded arrays.
- **"On the fly":** dropdowns get a trailing **"＋ Add new type…"** → inline input → `POST` → refetch → auto-select. No settings page needed.

## Feature 4 — Auto-hide duplicate / trial reels (perceptual cover hash)

**Files:** `server/thumbnails.js`, `server/scraper.js`, `server/db.js`, `server/index.js`, `server/scheduler.js`, `server/package.json`, `client/src/pages/LibraryTab.js`, `client/src/components/FilterBar.js`

**Detection signal:** a **64-bit dHash of the cached cover image.** We already download the cover in `downloadThumbnail`, so hash it there while the buffer is in memory. Reposts and trial-reels reuse a near-identical cover frame, so their hashes sit within a small Hamming distance even when caption/shortcode/URL all differ.

- **Dependency:** add `sharp` to server deps (decode → resize 9×8 grayscale → dHash). Dockerfile uses `node:20-slim` (Debian/glibc), so sharp prebuilt binaries install cleanly.
- **Schema:** `posts.thumb_dhash TEXT`, `posts.duplicate_of INTEGER`, `posts.video_duration REAL` (capture `videoDuration` from the reel actor as an optional secondary signal).
- **Hashing:** compute `thumb_dhash` inside `downloadThumbnail`; backfill rows where `thumb_dhash IS NULL` but a cached file exists (one-time sweep over already-cached thumbnails).
- **Dedup pass** (part of the thumbnail sweep / a scheduler job): group by `account_handle`; cluster by Hamming distance ≤ threshold (**start ~6/64, calibrate against real dupes as step 1**); if `video_duration` present require |Δduration| ≤ ~1s. Primary = highest `view_count`, tie-break newest; set others' `duplicate_of = primary.id`.
- **Library query** (`server/index.js` content route): default `WHERE duplicate_of IS NULL`; add `?showDuplicates=true` + a `FilterBar` toggle; primary card shows an "N duplicates" badge.
- **Non-destructive:** nothing deleted; a wrong match is re-hidden/re-shown by clearing `duplicate_of`.

## Feature 5 — "Open on Instagram" button

**Files:** `client/src/components/ContentCard.js`

- Add an **"Open on Instagram"** button to card actions that opens `post.post_url` (already stored; fall back to constructing from `shortcode`) in a new tab. Distinct from the profile link so the model lands on the exact reel to save/repost.

## Feature 6 — Trending Audio page (trending within our niche)

**Files:** `server/scraper.js`, `server/db.js`, new `server/audio.js` (+ `server/audio.test.js`), `server/index.js`, new `client/src/pages/AudioTab.js`, `client/src/App.js`, `client/src/api.js`

"Reel Radar, but for sounds": rank the audio tracks used by the reels **we already scrape** so models can see which sounds are heating up in their lane.

- **⚠️ Verification-first gate (before building):** we capture **zero** audio today. Confirm what `REEL_ACTOR_ID` returns for music by inspecting a **real Apify payload** — expected shape is a `musicInfo`/`musicMetadata` object (`audio_id`, `song_name`, `artist_name`, `uses_original_audio`). **If the reel actor doesn't return it**, evaluate the generic actor or an audio-specific actor before committing. This is the one workstream with real data-availability risk.
- **Capture:** extend the post mapping (~`scraper.js:525-542`) and INSERT/UPDATE (~`scraper.js:549-569`) to read audio fields.
- **Store:** `posts.audio_id TEXT`, `audio_title TEXT`, `audio_author TEXT`, `is_original_audio INTEGER` (idempotent). Columns-on-posts suffice — "trending" is an aggregation; no separate `audios` table initially.
- **Aggregate (`server/audio.js`, mirroring `server/radar.js`):** group recent, non-duplicate reels (last N days, roster/tracked) by `audio_id`; compute reel count, distinct-creator count, total/median views, recency. **Trend score** = weighted (distinct creators × recency × reach), env-tunable — same philosophy as the reel-performance `suggestion_score`/radar scoring.
- **Endpoints:** `GET /audio/trending` (ranked + example reels per audio), `GET /audio/:audioId/reels`.
- **Page (`AudioTab.js`, new "Audio" tab in `App.js`):** mobile-first list of trending sounds — title, author, original-vs-licensed badge, # reels, # creators, total reach, example reel thumbnails. Actions: **Open on Instagram** (`https://www.instagram.com/reels/audio/{audio_id}/` — confirm during build), expand to view example reels (reuse `ContentCard` + Feature 1 autoplay).
- **Separable:** capture → aggregate → new page is independent of Features 1–5; `writing-plans` may split it into its own plan.

---

## Cross-cutting

- **Migrations:** all new columns/tables use the idempotent `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` pattern already in `db.js` (with the SQLite fallback branch it maintains).
- **New dependency:** `sharp` (Feature 4 only).
- **Deferred on purpose:** no Railway volume, no video caching — waits on the Feature 2 expiry telemetry.
- **Tests (repo is TDD-heavy):** units for dHash + Hamming (fixture image), dedup grouping/primary-selection, `content_types` CRUD + slugify, `refresh-video` endpoint (mock actor), and audio trend scoring. Follow existing style (`server/thumbnails.test.js`, `server/content-bulk.test.js`, `server/radar.test.js`).

## Suggested build order

1. **Features 1 + 5** — pure frontend, highest daily impact for models, lowest risk. Ship first.
2. **Feature 3** — editable types (small schema + CRUD + wire-up).
3. **Feature 2** — re-resolve + telemetry; starts collecting breakage data immediately.
4. **Feature 4** — dupe hashing/hiding; new dep + calibration.
5. **Feature 6** — trending audio; gated on the audio-payload verification, so it goes last (or splits into its own plan).

## Verification (end-to-end, not just tests)

- Run server (`server/index.js` :4000) + CRA client locally.
- **Mobile:** load Library in Chrome device-mode **and a real phone**. Confirm a video **autoplays muted as it scrolls into view**, only **one** plays at a time, it **never goes fullscreen**, tap **unmutes**; desktop still uses hover→play.
- **Re-resolve:** point a post at a garbage/expired `video_url`; confirm the reload overlay, tap it, confirm a fresh URL loads and an `apify_runs` row with `purpose='video_refresh'` is recorded.
- **Types:** add a type via "＋ Add new type…"; confirm it appears in both card dropdowns + the filter, assign it, filter by it, reload — it persists.
- **IG button:** tap "Open on Instagram"; confirm the exact reel opens.
- **Duplicates:** seed two posts (same creator, near-identical cover, different captions); run sweep/dedup; confirm one hides and the primary shows an "N duplicates" badge; toggle "show duplicates" to reveal.
- **Trending audio:** after confirming the payload has music data, scrape a batch, open the Audio tab; confirm sounds rank sensibly, example reels load with inline autoplay, and "Open on Instagram" hits the audio page.
