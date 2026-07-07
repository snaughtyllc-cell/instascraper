# Design: Model Accounts + Mobile-ready Library + Trending Audio

**Date:** 2026-07-07
**Status:** Approved for planning
**Author:** brainstorming session (Jeff + Claude)

## Context

We want to open InstaScraper to our models on their **phones**, each with **their own login to a personalized account**, so they can scroll a niche-scoped feed like a normal social app, save references, see their AI ideas, and track trending sounds — without the admin tooling. Today the app is a desktop-first admin tool behind a **single shared password**, and "models" exist only as passive records the admin generates ideas for.

This splits into two epics:

- **Epic A — Model Accounts + Personalization** (the new foundation): per-model logins, roles, a mobile model surface, and niche-scoped personalization.
- **Epic B — Library / Feed UX** (the original six features): the video/feed/type/dedup/audio improvements that live inside the model surface (and also help admin).

Each decision below was made with Jeff during brainstorming.

## What exists today (verified)

- **Auth:** single shared `AUTH_PASSWORD` → one bcrypt hash; session flag `req.session.authenticated`; `requireAuth` gates every route with a boolean (`server/index.js:77-113`). No user identity, no roles. Good posture already: weak-password + forgeable-secret fail-fast at boot.
- **Models:** `models` table (`db.js:204`) — name, `primary_niche`, `secondary_niches`, delivery info, status. Passive records; **not logins**.
- **Niche → content scoping already works:** the AI-idea engine (`ai-agent.js:113-120`) selects a model's content via `COALESCE(posts.content_type, creator_types.content_type) IN (model's niches)`. **The editable content/creator-type list (Epic B, Feature 3) IS the niche vocabulary.**
- **`idea_cards`** are already `model_id`-scoped (`db.js:220`).
- **Video** renders inline but without `playsInline` (`ContentCard.js:127`); **thumbnails** are cached server-side, **videos** are not; **dedup** is by `shortcode` only (`db.js:88`); **no audio data** is captured at all.

## Decisions locked

**Epic A**
- **Login identity:** a model's login lives on the **`models` record** (add credentials + role); admin creates a model and its login together; admin gets an `admin` role.
- **Feed scope:** **by niche, automatic** — a model sees content whose type ∈ their niche(s), reusing the existing niche→content mechanism; auto-updates as new content is scraped.
- **Model abilities:** browse niche feed, **save/favorite reels** (per-model, separate from admin's global tags), **see their AI ideas** (`idea_cards`), **see niche-scoped trending audio**.
- **Two surfaces:** admin → existing full tool; model → a new **mobile-first app** (Feed / Saved / Ideas / Audio).

**Epic B**
- **Video UX:** IG/TikTok-style **autoplay-on-scroll**, muted, inline, one at a time, tap-to-unmute, never fullscreen.
- **Reliability:** **re-resolve on demand** + **log every expiry** to learn the real breakage rate before caching. No Railway volume / no video caching this round.
- **Types:** one shared **editable** list (= the niche vocabulary), addable on the fly.
- **Duplicates:** **auto-hide** via perceptual cover-hash, non-destructive.
- **IG link:** an **"Open on Instagram"** button per card.
- **Trending audio:** **within our niche** (a "Reel Radar for sounds"), scoped per-model in the model app.

---

# Epic A — Model Accounts + Personalization

## A1. Auth, identity & roles

**Files:** `server/db.js`, `server/index.js`, `client/src/components/LoginPage.js`, `client/src/App.js`, `client/src/api.js`

- **Schema:** extend `models` with `email TEXT UNIQUE`, `password_hash TEXT`, `role TEXT DEFAULT 'model'`, `login_enabled INTEGER DEFAULT 1` (idempotent `ADD COLUMN IF NOT EXISTS`, per `db.js:309`). Seed/bootstrap an **admin** identity from env (`ADMIN_EMAIL` + existing `AUTH_PASSWORD`) at boot so admin login keeps working.
- **Login:** `/login` accepts **identifier + password**. Resolve admin (env account, `role=admin`) or a model row (email + bcrypt `password_hash`, `login_enabled=1`). On success set `req.session.user = { id, role, modelId }` (modelId null for admin). Keep bcrypt (already a dep).
- **Route gating:** add `requireAdmin` (role check) to admin-only routes — `/scrape`, `/tracked`, `/suggested`, `/radar`, `/scheduler`, `/delete-log`, `/creators`, `/engagement`, `/export`, `/admin`, and `/models` management. Models reach only the new self-scoped `/me/*` routes.
- **`/auth/check`** returns `{ authenticated, role, modelId }` so the frontend picks the surface.
- **Security (Codex-conscious):** every `/me/*` handler derives `modelId` **from the session, never a client param** (prevents one model reading another's data). Add basic login throttling/lockout. Preserve the boot-time fail-fast.

## A2. Personalization data & self-scoped API

**Files:** `server/index.js` (new `/me/*` routes), `server/db.js`, `client/src/api.js`

- **`GET /me/feed`** — posts where `COALESCE(content_type, creator_types.content_type) IN (session model's niches)`, with `duplicate_of IS NULL` (Epic B/F4), performance/recency sort, paginated like `/content`. Reuses the existing content query shape + the niche filter from `ai-agent.js`.
- **Per-model saves:** new `model_saved_posts (model_id, post_id, saved_at, PRIMARY KEY(model_id, post_id))`. `POST /me/saves/:postId`, `DELETE /me/saves/:postId`, `GET /me/saves`. Separate from admin's global `posts.tag`/`notes`.
- **`GET /me/ideas`** — `idea_cards WHERE model_id = session.modelId` (self-scoped wrapper over existing idea logic).
- **`GET /me/audio/trending`** — the Epic B/F6 aggregation filtered to the model's niches.

## A3. Model mobile app surface

**Files:** new `client/src/ModelApp.js` (+ `client/src/pages/model/*`), `client/src/App.js`, `client/src/components/ContentCard.js`

- On login, `App.js` branches on `role`: **admin** → existing 8-tab tool; **model** → `ModelApp` — a mobile-first shell with bottom-nav **Feed / Saved / Ideas / Audio**.
- **Feed** = the niche `/me/feed` rendered with `ContentCard` + Epic B autoplay (Feature 1) and a save/heart button (writes `/me/saves`).
- **Saved / Ideas / Audio** = thin pages over `/me/saves`, `/me/ideas`, `/me/audio/trending`.
- **Admin management:** extend `ModelsTab` to set a model's `email`, (re)set password, and toggle `login_enabled` — this is how you provision a model's login.

---

# Epic B — Library / Feed UX

## B1 (Feature 1) — Mobile autoplay-on-scroll, inline video

**Files:** `client/src/components/ContentCard.js`, `client/src/pages/LibraryTab.js` (+ model Feed)

- Add `playsInline muted` to `<video>` (fixes iOS fullscreen; muted enables autoplay).
- **Autoplay-in-view, opt-in via prop** (`ContentCard` is shared by Library, Radar, and the new model Feed — don't change default). A single `IntersectionObserver` tracks the most-visible card → only it swaps thumbnail→muted `<video>`; one plays at a time; others revert to thumbnail. Scope to touch/small screens; preserve desktop hover→play. Speaker toggle to unmute (persists across cards).

## B2 (Feature 2) — Re-resolve dead videos + expiry telemetry

**Files:** `server/scraper.js`, `server/index.js`, `client/src/api.js`, `client/src/components/ContentCard.js`

- **`POST /content/:id/refresh-video`** — run the reel actor (`REEL_ACTOR_ID`) for that one post via `_startApifyRun`, `UPDATE posts SET video_url, thumbnail_url, thumbnail_cache_status='pending'`, return fresh URL.
- **Telemetry:** record each refresh as an `apify_runs` row with `purpose:'video_refresh'` via existing `recordRunLaunch`/`recordRunResult` → frequency + cost in the existing ledger, no new table. Emit `[Metric] video_expired`.
- **Budget guard:** reuse the $10/30-day ceiling check; over budget → clear UI message.
- **UI:** on `<video>` `onError`, show "Video expired — tap to reload" → spinner (~15–60s cold start) → new `src`.

## B3 (Feature 3) — Editable shared type list (= niche vocabulary)

**Files:** `server/db.js`, `server/index.js`, `client/src/api.js`, `client/src/components/ContentCard.js`, `client/src/components/FilterBar.js`, `client/src/pages/LibraryTab.js`

- **`content_types`** table (`id`, `value` slug, `label`, `sort_order`, `created_at`), seeded with the current six. `GET/POST/DELETE /content-types` (POST slugifies `{label}`, ignores dupes; DELETE removes only the pick-list entry — existing string assignments survive). Frontend fetches the list and replaces the two hardcoded arrays; dropdowns get a trailing **"＋ Add new type…"**. Because types = niches, this list also feeds a model's niche assignment in `ModelsTab`.

## B4 (Feature 4) — Auto-hide duplicate / trial reels

**Files:** `server/thumbnails.js`, `server/scraper.js`, `server/db.js`, `server/index.js`, `server/scheduler.js`, `server/package.json`, `client/src/pages/LibraryTab.js`, `client/src/components/FilterBar.js`

- **Signal:** 64-bit **dHash of the cached cover** (reposts/trial-reels reuse a near-identical cover frame). Compute in `downloadThumbnail` while the buffer is in memory. **Dep:** add `sharp` (node:20-slim/Debian → prebuilt binaries fine).
- **Schema:** `posts.thumb_dhash TEXT`, `posts.duplicate_of INTEGER`, `posts.video_duration REAL`.
- **Dedup pass** (sweep/scheduler): group by `account_handle`; cluster by Hamming ≤ ~6/64 (**calibrate on real dupes first**); if duration present require |Δ| ≤ ~1s; primary = highest `view_count`, tie-break newest; others get `duplicate_of = primary.id`.
- **Query:** default `WHERE duplicate_of IS NULL` (both `/content` and `/me/feed`); `?showDuplicates=true` toggle; primary shows "N duplicates" badge. Non-destructive.

## B5 (Feature 5) — "Open on Instagram" button

**Files:** `client/src/components/ContentCard.js`

- Button on card actions → `post.post_url` (fallback: build from `shortcode`) in a new tab; distinct from the profile link, so the model lands on the exact reel to save/repost.

## B6 (Feature 6) — Trending Audio (within our niche)

**Files:** `server/scraper.js`, `server/db.js`, new `server/audio.js` (+ `audio.test.js`), `server/index.js`, new `client/src/pages/AudioTab.js` + model Audio page, `client/src/App.js`, `client/src/api.js`

- **⚠️ Verification-first gate:** we capture zero audio today. Confirm the reel actor returns music metadata by inspecting a **real Apify payload** (expected `musicInfo`: `audio_id`, `song_name`, `artist_name`, `uses_original_audio`). If it doesn't, evaluate the generic/other actor before committing.
- **Capture** audio fields in the scraper mapping/INSERT. **Store** `posts.audio_id/audio_title/audio_author/is_original_audio`.
- **Aggregate (`server/audio.js`, mirroring `radar.js`):** group recent non-duplicate reels by `audio_id`; compute reel count, distinct creators, reach, recency → env-tunable **trend score**. Endpoints `GET /audio/trending` (admin, all) and the per-model `GET /me/audio/trending` (Epic A/A2).
- **Page:** trending sounds (title, author, original-vs-licensed badge, counts, reach, example reels + inline autoplay); **Open on Instagram** → `https://www.instagram.com/reels/audio/{audio_id}/` (confirm format).

---

## Cross-cutting

- **Migrations:** idempotent `ADD COLUMN/CREATE TABLE IF NOT EXISTS` pattern already in `db.js` (with its SQLite fallback branch).
- **New dependency:** `sharp` (B4).
- **Deferred on purpose:** no Railway volume / no video caching (waits on B2 telemetry).
- **Security:** per-model bcrypt; session-derived `modelId` on every `/me/*` route (no client-supplied ids); `requireAdmin` on admin routes; login throttling; keep boot fail-fast.
- **Tests (repo is TDD-heavy):** auth/role gating + `/me/*` self-scoping (cross-model access denied), model-login CRUD, dHash + Hamming, dedup grouping, `content_types` CRUD + slugify, `refresh-video` (mock actor), audio trend scoring. Follow existing style (`security.test.js`, `thumbnails.test.js`, `content-bulk.test.js`, `radar.test.js`).

## Suggested build order (likely 3 implementation plans)

1. **Plan 1 — Video/feed UX prerequisites:** B1 (autoplay video) + B5 (IG button) + B3 (editable types/niches). Frontend-heavy, unblocks the model feed and niche assignment.
2. **Plan 2 — Model Accounts + Personalization (Epic A):** A1 auth/roles → A2 `/me/*` (feed, saves, ideas) → A3 model mobile app. The foundation.
3. **Plan 3 — Reliability + dedup + audio:** B2 (re-resolve/telemetry) → B4 (dedup) → B6 (trending audio, after the payload check + `/me/audio`).

`writing-plans` will produce these as separate plans rather than one giant one.

## Verification (end-to-end)

- **Auth/roles:** create a model login in `ModelsTab`; log in as that model → land in the **model app**, not the admin tool; confirm admin routes 403; confirm a model **cannot** read another model's saves/ideas by changing an id.
- **Model feed:** confirm it shows only the model's niche content, `duplicate_of IS NULL`, mobile autoplay (one at a time, never fullscreen, tap-unmute); save a reel → appears under **Saved**; **Ideas** shows their `idea_cards`; **Audio** shows niche-scoped sounds.
- **Re-resolve:** garbage a `video_url` → reload overlay → fresh URL loads → `apify_runs` row `purpose='video_refresh'` recorded.
- **Types:** add one via "＋ Add new type…"; it appears in dropdowns, the filter, and as an assignable niche; persists across reload.
- **IG button:** opens the exact reel.
- **Duplicates:** seed two same-creator near-identical-cover posts → dedup hides one, primary shows "N duplicates"; toggle reveals it.
- **Trending audio:** after confirming payload has music data, scrape a batch, open Audio; sounds rank sensibly, example reels autoplay inline, Open-on-Instagram hits the audio page.
