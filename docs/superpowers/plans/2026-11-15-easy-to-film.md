# Plan: "easy to film" filter for model feeds

Date: 2026-11-15 · Requested by user · Branch `easy-to-film` off `main`

## Goal
Models should only see reels they can copy right away with just themselves and a phone ("see it, hit Film, film it"). The new gamer creators brought many split-screen and gameplay-overlay talking reels: her face next to or over game footage. Those need extra footage, so they're not quick to film. The sorter must label each reel's **layout**, and every model-facing feed must hide reels that need other footage. The admin library keeps them.

## Approach
1. **Column:** `posts.ai_layout TEXT`, nullable. Add it via the existing idempotent column list in `server/sort-migration.js` (PG + SQLite). Values: `self_filmed | split_screen | gameplay_overlay | needs_footage`.
2. **Gemini (`server/gemini-sort.js`):** the video describe call (`requestConfig` / `prompt` / `generate` / `describeReel`) returns a new required field `layout` (enum above).
   - Add a pure `cleanLayout(value)` that returns the value or null.
   - Prompt definitions, to be added to the prompt:
     - `self_filmed`: everything on screen is the person filmed with a phone or camera, any number of cuts. On-screen text, captions and subtitles are fine, and so is any real background (including a gaming desk or monitors behind her).
     - `split_screen`: the frame is divided into two or more separate video feeds (e.g. her plus gameplay, reaction plus clip, stitch/duet side by side).
     - `gameplay_overlay`: game, stream or screen-recording footage fills a major part of the frame, with the person inset, overlaid or voicing over.
     - `needs_footage`: anything else that needs outside clips: green screen over a video or image, B-roll montage, screenshots or screen recordings, someone else's clip inserted.
   - `redecideFromDescription` (text-only) must NOT set or overwrite layout.
3. **Writes:** every place that stores a video describe result also writes `ai_layout`. That covers:
   - `server/sort-runner.js` (`runAutoSort`)
   - `server/sort-routes.js` re-sort paths that use the video
   - `server/talking-recheck.js`
   - `server/candidate-routing.js` (add `suggested_reels.ai_layout` the same way if that table stores describe results)
   - `server/transcript-backfill.js` and `server/look-backfill.js`. Only make those two write layout if they already call `describeReel` and get the field for free; they keep writing only their own columns otherwise.
4. **Hide from model feeds:** in `server/me-feed.js`, add `EASY_FILM_CLAUSE` = `(posts.ai_layout IS NULL OR posts.ai_layout = 'self_filmed')`.
   - AND it into `buildMeFeedQuery` next to `PLAYABLE_CLAUSE`. That covers `/me/feed`, workspace reels and Film `/film/v1/models/:id/feed`.
   - NULL stays visible, so feeds don't empty out before the re-check runs.
   - Env `FEED_REQUIRE_EASY_FILM` (default on). The values `0`/`false`/`off` disable the clause.
   - Don't apply it to saves lists. Things she already saved stay. Don't apply it to the admin library, needs-look, or the Film save/skip availability checks.
5. **Re-check existing reels** (new `server/layout-recheck.js`, modelled on `server/look-backfill.js`):
   - Eligible reels: `sort_status IN ('auto','manual')`, `video_cache_status='cached'`, `ai_layout IS NULL`, not archived or soft-deleted.
   - Order: `content_type='talking'` first, then `posted_at DESC`.
   - Re-describe the cached video and write ONLY `ai_layout`. Type, status, tags and transcript are left alone.
   - Use the same sort lock and daily cap (`attemptsToday`, `withSortLock`). Record attempts so they count toward the cap, the same way look-backfill does. Batch by `cfg.batch`, and loop batches until done or capped.
   - Routes in `server/sort-routes.js`: `GET /sort/layout-recheck/estimate` returns `{count, estUsd}`. `POST /sort/layout-recheck` returns `{started}` and is guarded against concurrent runs.
   - Cockpit (`client/src/.../AdminCockpitTab.js`): add an "Check filmability of existing reels" button with a count and cost confirmation, like the other backfill buttons.
6. **Visibility for the team:** in the workspace reels list and the admin library card, show a small badge when `ai_layout` isn't `self_filmed` ("Split screen", "Gameplay", "Needs footage"). Admin views only.

## Key decisions & tradeoffs
- **Applies to every content type**, not just talking. The user's rule is "what can we film quickly", and it fits every format.
- **Hide, don't rank lower.** The user said split-screen should "virtually be taken out."
- **NULL = visible until checked**, so nothing empties out mid-deploy.
- No extra Gemini call for new reels: it's one more output field.

## Out of scope
Removing creators automatically; per-model overrides; changing suggestion scoring.

## Acceptance criteria & verification
- Unit tests:
  - `cleanLayout`.
  - The describe parse returns `layout`.
  - The redecide path leaves layout unchanged.
  - Runner and recheck write `ai_layout` only. The recheck respects the cap, does talking first, and a second run finds 0 eligible.
- Feed tests:
  - `split_screen`, `gameplay_overlay` and `needs_footage` reels are excluded from `buildMeFeedQuery` results. `self_filmed` and NULL are included.
  - `FEED_REQUIRE_EASY_FILM=0` includes all of them.
  - Saves are unaffected.
- Film API test: the feed excludes a split_screen reel.
- Commands (must pass):
  - `cd server && NODE_USE_SYSTEM_CA=0 GEMINI_API_KEY= npm test`
  - `cd client && NODE_USE_SYSTEM_CA=0 CI=true npm run build`

## Fix (round 2): exempt React-mode types
React mode (live in Film) makes Omegle reels filmable: the stranger's half comes from the reel, and she films her own half. Those reels are `split_screen` by nature, and Destiny has a whole Omegle section. So:
- `EASY_FILM_CLAUSE` becomes: `(posts.ai_layout IS NULL OR posts.ai_layout = 'self_filmed' OR posts.content_type IN (<exempt types>))`.
- Exempt types come from env `FEED_EASY_FILM_EXEMPT_TYPES` (comma-separated content_type values), default `omegle`. Pass them as bound params in ascending placeholder order, or as validated `[a-z0-9-]` literals. An empty list means no exemptions.
- In admin views, the layout badge still shows on exempt reels.
- Tests:
  - A `split_screen` reel with `content_type='omegle'` stays in the feed, and a `split_screen` talking reel is excluded.
  - Setting the env to a custom list works.
  - The Film feed test covers the omegle exemption.
