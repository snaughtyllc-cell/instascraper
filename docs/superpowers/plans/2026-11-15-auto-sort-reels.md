# Auto-sort Reels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every cached reel gets its own content type from Gemini automatically; unsure or no-fit reels go to a hidden "Needs a look" pile; models only ever see sorted reels.

**Architecture:** A new `sort_status` per reel (`unsorted | auto | needs_look | manual`) plus `ai_*` columns. One SQL expression (`effectiveNicheExpr`) decides a reel's visible niche everywhere a model can reach content. A runner classifies cached, unsorted reels with Gemini (describe step) and a pure rule (decide step), triggered after video sweeps and by a catch-up cron. An admin "Needs a look" tab handles the rest.

**Tech Stack:** Node 20 / Express, Postgres (prod) + better-sqlite3 (tests/local), `node:test`, React (CRA) + Tailwind, `@google/genai` (new).

**Spec:** `docs/superpowers/specs/2026-11-15-auto-sort-reels-design.md`

## Global Constraints

- Default model `GEMINI_MODEL` = Gemini 3.5 Flash-Lite. Before Task 4, confirm the exact model id string on ai.google.dev (expected `gemini-3.5-flash-lite`) and use that.
- Cheapest settings: low media resolution, low frame rate (≤ 1 fps), JSON-only output with the four fields, lowest thinking setting the model allows.
- Env knobs and defaults: `GEMINI_API_KEY` (unset ⇒ auto-sort is off, app runs normally), `GEMINI_MODEL`, `AUTO_SORT_MIN_CONFIDENCE=0.8`, `AUTO_SORT_BATCH=50`, `AUTO_SORT_DAILY_MAX=1000`, `AUTO_SORT_MAX_ATTEMPTS=3`, `GEMINI_PRICE_IN_PER_M=0.30`, `GEMINI_PRICE_OUT_PER_M=2.50`.
- Never overwrite a `manual` reel. Never let a reel without a decided type reach a model.
- No audio toggle in v1. The Docker image has no ffmpeg, so the video goes to Gemini as-is; the 3.5 Flash-Lite price already covers all input.
- Keep `posts.tag` and `creator_types` in the database; no data is dropped.
- SQLite adapter rewrites `$N` → `?` by appearance order: placeholders must appear in ascending order (see `server/audio.js` comment).
- `server/db.js` has an uncommitted local change (`SQLITE_PATH` support) on `main`. Build on a branch, and keep or commit that change deliberately; don't discard it.
- Tests: `cd server && npm test` (runs `node --test --test-concurrency=1`). The full suite must stay green after every task.

## Review Focus

1. **A new reel scraped from a creator who has a creator-level type** must stay hidden until sorted. The creator label must not leak it in (Task 3 test `unsorted reel with creator type is hidden`).
2. **The cached file was pruned before classification:** record the error, count an attempt, and don't crash the batch (Task 5 test `missing file records error and continues`).
3. **Gemini returns a type not in the list, or malformed JSON:** treat it as no type, so the reel goes to needs_look and never gets auto-typed (Task 4 test `unknown type coerced to null`, Task 5 test `describe throws → attempt counted`).
4. **Two runs overlap** (the sweep hook and the cron fire together): a reel must not be classified twice. Use an in-process lock (Task 5 test `concurrent runAutoSort calls run once`).
5. **A suggested type that slugifies to an existing type** (AI says "talking" or "Talking Head" while `talking` exists): "Create type & assign all" reuses the existing value instead of creating a duplicate (Task 6 test `create suggested type reuses existing value`).

---

### Task 1: Schema

**Files:**
- Create: `server/sort-migration.js`
- Modify: `server/db.js` (both migration lists, and call `ensureSortStatus` in `initDB` after the existing migrations)
- Test: `server/sort-migration.test.js`

**Interfaces:**
- Produces: `ensureSortStatus(db, { isPg }) -> Promise<{ added: boolean }>`; `AI_COLUMNS` (array of `{ name, type }`).
- Columns on `posts`: `sort_status TEXT DEFAULT 'unsorted'`, `ai_type TEXT`, `ai_confidence REAL`, `ai_description TEXT`, `ai_suggested_type TEXT`, `ai_model TEXT`, `ai_classified_at TEXT`, `ai_last_attempt_at TEXT`, `ai_attempts INTEGER DEFAULT 0`, `ai_error TEXT`, `ai_cost_usd REAL`.

- [ ] **Step 1: Write failing tests** (in-memory sqlite, using `posts` + `creator_types` tables like `me-feed.test.js`):
  - `first run adds columns, every existing reel unsorted`: seed post A (`content_type='dance'`) and B (null). After `ensureSortStatus`: all `AI_COLUMNS` + `sort_status` exist, A and B are `unsorted`, `added === true`.
  - `second run is a no-op`: run again → `added === false`, no error.
- [ ] **Step 2: Run** `node --test sort-migration.test.js`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `ensureSortStatus`.** Detect columns (sqlite `PRAGMA table_info(posts)`; PG `information_schema.columns`) and add whichever of `sort_status` / `AI_COLUMNS` are missing. Existing reels are NOT re-checked (user decision: the old library will be scratched with Start fresh, Task 6), so they all start `unsorted` and are hidden from models.
- [ ] **Step 4: Run tests.** Expected: PASS. Then run the full `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(sort): add sort_status + ai columns`

### Task 2: Visibility expression and decide rule

**Files:**
- Create: `server/sort-status.js`
- Test: `server/sort-status.test.js`

**Interfaces:**
- Produces:
  - `effectiveNicheExpr(p = 'posts', ct = 'ct') -> string`, which returns exactly:
    `CASE WHEN p.sort_status IN ('auto','manual') THEN p.content_type ELSE NULL END` (with alias substituted; the `ct` parameter is kept so call sites keep their creator_types join, but the creator label no longer affects visibility).
  - `decideSort({ ai, typeValues, threshold }) -> { sortStatus: 'auto'|'needs_look', contentType: string|null }`, where `ai = { type, confidence }`.
  - `sortConfig(env = process.env) -> { minConfidence, batch, dailyMax, maxAttempts, model, priceInPerM, priceOutPerM, enabled }`.

- [ ] **Step 1: Write failing tests:**
  - `confident known type → auto`: `decideSort({ai:{type:'dance',confidence:0.9}, typeValues:['dance','talking'], threshold:0.8})` → `{sortStatus:'auto', contentType:'dance'}`.
  - `below threshold → needs_look, null type`; `type not in list → needs_look`; `null type → needs_look`.
  - `effectiveNicheExpr` (sqlite): rows with statuses unsorted (content_type set + creator type) / needs_look / auto / manual-null → niche values `null, null, <content_type>, null`.
  - `sortConfig defaults`: empty env → `minConfidence 0.8, batch 50, dailyMax 1000, maxAttempts 3, priceInPerM 0.30, priceOutPerM 2.50, enabled false`; with `GEMINI_API_KEY` set → `enabled true`.
- [ ] **Step 2: Run** `node --test sort-status.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement the three functions** in `server/sort-status.js`.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(sort): effective niche expression + decide rule`

### Task 3: Every model-facing path uses the expression

**Files:**
- Modify: `server/me-feed.js` (`nicheVisibilityClause`, `buildMeFeedQuery` niche select), `server/index.js` (`modelCanAccessPost` ~1398, `GET /me/saves` ~1492), `server/audio.js` (the three `COALESCE(posts.content_type, ct.content_type)` sites ~54/89/129), `server/ai-agent.js` (source-reel queries ~123–170), `server/notion-sync.js` (`countFreshNicheReels` ~138)
- Test: `server/me-feed.test.js`, `server/audio.test.js`, plus a new `server/model-access.test.js` if `modelCanAccessPost` must be extracted to be testable (extract it to `server/model-access.js` as `modelCanAccessPost(pool, modelId, postId, opts)`)

**Interfaces:**
- Consumes: `effectiveNicheExpr` (Task 2).
- Produces: `modelCanAccessPost(pool, modelId, postId, { requirePlayable }) -> Promise<boolean>` in `server/model-access.js`; index.js call sites pass `pool`.

- [ ] **Step 1: Write failing tests:**
  - me-feed: `unsorted reel with creator type is hidden`, `unsorted reel with content_type is hidden`, `needs_look reel hidden`, `auto reel visible`, `manual reel visible`. Add `sort_status` to `makePostsDb`.
  - model-access: `already-saved reel stays reachable after it becomes needs_look` (row in `model_saved_posts`); `reel with feedback stays reachable` (row in `model_post_feedback`); `unsorted unsaved reel → false`.
  - audio: one test per builder showing an unsorted reel's audio is excluded.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Replace every `COALESCE(posts.content_type, ct.content_type)` / `COALESCE(p.content_type, ct.content_type)` in the listed files with `effectiveNicheExpr(...)`.** In `modelCanAccessPost` and `/me/saves`, add `OR EXISTS (SELECT 1 FROM model_saved_posts s2 WHERE s2.post_id = posts.id AND s2.model_id = <model>)` and the same for `model_post_feedback` alongside the assigned-post clause. Keep placeholders in ascending appearance order.
- [ ] **Step 4: Run the full** `npm test`. Expected: all pass. Also run `grep -n "COALESCE(posts.content_type, ct.content_type)\|COALESCE(p.content_type, ct.content_type)" server/*.js | grep -v test`. Expected: only admin-only uses remain (`GET /content` library filter), none model-facing.
- [ ] **Step 5: Commit** `feat(sort): model-facing paths show only sorted reels`

### Task 4: Gemini describe client

**Files:**
- Create: `server/gemini-sort.js`
- Modify: `server/package.json` (add `@google/genai`, then run `npm install` in `server/`)
- Test: `server/gemini-sort.test.js`

**Interfaces:**
- Produces:
  - `describeReel({ filePath, caption, handle, types }, { client, model }) -> Promise<{ type: string|null, confidence: number, description: string, suggestedType: string|null, usage: { inTokens: number, outTokens: number } }>`, where `types` = `[{ value, label }]`.
  - `redecideFromDescription({ description, caption, types }, { client, model })` → same shape (text-only call).
  - `estimateCostUsd(usage, cfg) -> number` = `inTokens/1e6*priceInPerM + outTokens/1e6*priceOutPerM`.
  - `makeGeminiClient(apiKey)` → `@google/genai` client instance.

- [ ] **Step 1: Write failing tests** with a fake client recording `models.generateContent` args:
  - `request uses low media resolution, json schema and the model`: assert the config carries `mediaResolution` low, `responseMimeType: 'application/json'`, a response schema with `type, confidence, description, suggested_type`, and `model === 'gemini-3.5-flash-lite'` (or the verified id). The prompt text lists every `types` value.
  - `unknown type coerced to null`: fake returns `{"type":"lifestyle",...}` with types lacking lifestyle → `type === null`, and `suggestedType` is kept.
  - `confidence clamped to 0..1`; `malformed JSON throws`.
  - `usage read from usageMetadata` (`promptTokenCount`, `candidatesTokenCount`).
  - `estimateCostUsd({inTokens:3400,outTokens:80}, {priceInPerM:0.30,priceOutPerM:2.50})` ≈ `0.00122`.
- [ ] **Step 2: Run** `node --test gemini-sort.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Send the video inline as base64 when the file is ≤ 18 MB; above that, use the Files API (upload, wait until ACTIVE, delete after the call). Set video sampling to ≤ 1 fps via the part's video metadata. Check exact `@google/genai` field names against its README; the fake-client test pins the intent.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(sort): gemini describe client (3.5 flash-lite, low-res)`

### Task 5: Sort runner, scheduling, backfill

**Files:**
- Create: `server/sort-runner.js`
- Modify: `server/scheduler.js` (call after `runVideoSweep`; cron `15 * * * *` catch-up; expose in `getSchedulerStatus`), `server/scraper.js` (chain `runAutoSort` after both post-scrape `sweepVideos(...)` promises ~743/~1162)
- Test: `server/sort-runner.test.js`

**Interfaces:**
- Consumes: `decideSort`, `sortConfig` (Task 2); `describeReel`, `estimateCostUsd` (Task 4); `videoFilePath` from `server/videos.js`.
- Produces:
  - `runAutoSort({ pool, describe, cfg, limit }) -> Promise<{ classified, auto, needsLook, errored, skippedCap }>`. `describe` is injectable; it defaults to `describeReel` with a real client.
  - `backfillEstimate(pool, cfg) -> Promise<{ count, estUsd }>`, using 3,400 in / 80 out tokens per reel.
  - `sortUsage(pool, cfg) -> Promise<{ reels30d, usd30d, today, dailyMax }>`.

- [ ] **Step 1: Write failing tests** (sqlite, fake `describe`, temp dir for video files):
  - `classifies cached unsorted reels, skips uncached and manual`.
  - `auto writes content_type and ai fields; needs_look leaves content_type null` (writes `ai_type, ai_confidence, ai_description, ai_suggested_type, ai_model, ai_classified_at, ai_cost_usd`).
  - `missing file records error and continues`: `ai_error` set, `ai_attempts` 1, the other reel still classified.
  - `describe throws → attempt counted; after maxAttempts → needs_look with ai_error`.
  - `daily cap stops the batch`: with `dailyMax 1` and two candidates → 1 classified, `skippedCap 1`.
  - `concurrent runAutoSort calls run once`: second call while the first is pending resolves with zeros.
  - `disabled config does nothing`.
- [ ] **Step 2: Run** `node --test sort-runner.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Candidates: `video_cache_status='cached' AND sort_status = 'unsorted' AND ai_attempts < maxAttempts AND not soft-deleted/archived`, newest `posted_at` first, `LIMIT min(batch, dailyMax − attemptsLast24h)`. Count the daily cap by `ai_last_attempt_at` in the last 24h. Use a module-level lock flag. Read the type list from `content_types` once per run. An `unsorted` reel that already has a `content_type` (pre-existing data) is classified like any other and its type is overwritten by the decision.
- [ ] **Step 4: Wire scheduling** (scheduler and scraper hooks as listed). Errors are logged with a `[Sort]` prefix and never thrown into the sweep.
- [ ] **Step 5: Run the full** `npm test`. Expected: all pass.
- [ ] **Step 6: Commit** `feat(sort): auto-sort runner, cron + post-sweep hooks`

### Task 6: Admin API for the pile, backfill, usage, manual marking

**Files:**
- Create: `server/sort-routes.js` (`registerSortRoutes(app, { pool, runAutoSort, redecide })`, mounted in `index.js` behind `requireAdmin`)
- Modify: `server/index.js` (`POST /content/:id/content-type` and `POST /content-types` hooks), `server/content-bulk.js` (content-type action also sets `sort_status='manual'`)
- Test: `server/sort-routes.test.js`, `server/content-bulk.test.js`

**Interfaces:**
- Consumes: Task 5 functions, `validateTypeLabel`/`slugifyTypeLabel` from `server/content-types.js`, `redecideFromDescription` (Task 4).
- Produces (HTTP):
  - `GET /sort/needs-look?page=&limit=` → `{ suggestions: [{ value, label, count }], posts: [...posts with ai_* fields], total }`. Suggestions group needs_look reels by `slugifyTypeLabel(ai_suggested_type)`, most first.
  - `POST /sort/suggested-types/:value/create` → creates or reuses the content type, sets those reels `content_type=value, sort_status='manual'`, then triggers redecide → `{ type: {value,label}, assigned }`.
  - `GET /sort/backfill/estimate` → `{ count, estUsd }`; `POST /sort/backfill` → starts `runAutoSort` repeatedly until there are no candidates or the cap is hit; returns `{ started: true }` immediately.
  - `GET /admin/sort-usage` → `sortUsage(...)`.
  - `GET /sort/start-fresh/preview` → `{ count }` (non-deleted reels). `POST /sort/start-fresh` with body `{ confirm: true }` (else 400) → soft-deletes every non-deleted reel: `soft_deleted=1, soft_deleted_at=now`, one `deletion_log` row each with reason `'manual:start_fresh'` (so the existing `POST /delete-log/:id/restore` can undo it), in one transaction → `{ hidden }`. Does not touch `tracked_accounts`, `suggested_accounts`, `content_types` or video files.
  - Pure helpers exported for tests: `groupSuggestions(rows)`, `redecideNeedsLook({ pool, redecide, cfg })`.
- Manual marking: any human content-type set (single, bulk) writes `sort_status='manual'` (with null type too, so the reel stays hidden and untouched). `POST /content-types` calls `redecideNeedsLook` in the background after creating a type.

- [ ] **Step 1: Write failing tests:**
  - `groupSuggestions` merges "Lifestyle"/"lifestyle " into one group with count 2.
  - `create suggested type reuses existing value`: suggestion "Talking" while `talking` exists → no new row, reels assigned `talking`.
  - `redecideNeedsLook` promotes a needs_look reel when the fake redecide returns the new type at 0.9, and leaves a 0.5 one alone.
  - content-bulk: `content-type action sets sort_status manual`.
  - `start fresh hides all reels and logs each`: 3 reels (1 already soft-deleted) → `hidden === 2`, 2 `deletion_log` rows with reason `manual:start_fresh`, tracked_accounts row untouched; `confirm` missing → 400.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the routes and hooks.
- [ ] **Step 4: Run the full** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(sort): needs-look, suggested types, backfill + usage endpoints`

### Task 7: Cleanup, export, remove the tag (server)

**Files:**
- Modify: `server/scheduler.js` (cleanup query ~203), `server/index.js` (`GET /export` ~1295, delete `POST /content/:id/tag`, drop `tag`/`untagged` filters in `GET /content`), `server/content-bulk.js` (delete the `tag` action)
- Test: `server/cleanup-protect.test.js`, `server/content-bulk.test.js`

**Interfaces:**
- Produces: `cleanupProtectClause() -> string` exported from `scheduler.js`, which returns
  `NOT (sort_status = 'auto' OR (sort_status = 'manual' AND content_type IS NOT NULL)) AND tag IS NULL`.
- `GET /export?format=json|csv&contentType=<value>`: all non-deleted reels of that type (by `effectiveNicheExpr`), or all sorted reels when it's omitted. The `tag` field is dropped from the CSV fields and `content_type` added. Filename `content-<type|all>.<ext>`.

- [ ] **Step 1: Write failing tests:**
  - cleanup (sqlite): old reels with statuses auto / manual+type are protected; unsorted / needs_look / manual-null are candidates.
  - content-bulk: `tag action rejected`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(sort): protect sorted reels from cleanup, export by type, drop tag`

### Task 8: Admin UI

**Files:**
- Create: `client/src/pages/NeedsLookTab.js`
- Modify: `client/src/App.js` (tab `needslook`, label "Needs a look" with a count badge from `total`), `client/src/api.js` (add `getNeedsLook`, `createSuggestedType`, `getBackfillEstimate`, `startBackfill`, `getSortUsage`, `getStartFreshPreview`, `startFresh`; remove `tagPost`, `setCreatorType`; `exportContent(format, contentType)`), `client/src/components/ContentCard.js` (remove the Recreate/Reference/Skip buttons and the creator-type control; show `sort_status` and AI confidence on hover), `client/src/components/BulkActionBar.js` and `client/src/components/FilterBar.js` (remove tag actions/filters), `client/src/pages/LibraryTab.js` (remove tag state and export-by-tag; add a content-type picker to export), `client/src/pages/ScrapeTab.js` (remove tag usage), `client/src/pages/TrackedAccountsTab.js` (show the creator mix "Talking 70% · Dance 20%" from a `GET /creators` that now returns `mix: [{ type, pct }]`), `client/src/pages/AdminCockpitTab.js` (an auto-sort card with 30-day reels/spend, today vs cap, a "Sort existing reels" button that shows the estimate and asks for confirmation before `startBackfill`, and a red "Start fresh" button that shows `GET /sort/start-fresh/preview`'s count — "Hide all N reels? Tracked creators stay; next scrape refills; undo from Delete Log" — and only calls `POST /sort/start-fresh` with `{confirm:true}` after the admin confirms)
- Modify: `server/index.js` `GET /creators` to return `mix` computed by `effectiveNicheExpr` grouped per handle
- Test: `server/creators-mix.test.js` (server side); client verified by build + browser

**Interfaces:**
- Consumes: the Task 6 and Task 7 HTTP endpoints.
- Needs a look tab layout: a suggestions strip at the top ("**Lifestyle** — 14 reels · Create type & assign all"), then a grid of reels with video (`/video/:id`), the AI guess + confidence %, the description, one-tap type chips (`setPostContentType`), and a "Not useful" button (`archivePost`). A reel leaves the grid on any action.

- [ ] **Step 1: Write a failing test** `creators mix percentages`: creator with 3 sorted reels (2 talking, 1 dance) + 1 unsorted → `[{type:'talking',pct:67},{type:'dance',pct:33}]` (unsorted excluded, pct rounded).
- [ ] **Step 2: Implement the `/creators` mix, then the client changes.**
- [ ] **Step 3: Run** `cd server && npm test`. Expected: all pass. Then run `cd client && CI=true npm run build`. Expected: compiles with no errors and no unused-import warnings from the removed tag code.
- [ ] **Step 4: Browser check** (local, sqlite seeded): the Needs a look tab lists seeded needs_look reels; creating a suggested type moves them out; Library cards show no Recreate/Reference/Skip; the cockpit backfill shows an estimate and asks before starting; Start fresh shows the count, asks, hides all reels, and one can be restored from Delete Log.
- [ ] **Step 5: Commit** `feat(sort): needs-a-look tab, creator mix, remove tag UI`

## After the build (user steps, not tasks)

1. Add `GEMINI_API_KEY` to the Railway `instascraper` service.
2. Deploy, open the cockpit, press **Start fresh** (hides the old, non-playing library), then scrape the tracked creators to refill. New reels are sorted automatically as their videos cache. Watch the Apify budget ($25/30d): a full re-scrape of every tracked creator may need a temporary bump.
3. Spot-check the pile and a few auto-sorted reels per type; tune `AUTO_SORT_MIN_CONFIDENCE` if needed.
4. Follow-up: Jev as the decide step (add the key to Railway; swap `redecideFromDescription`/`decideSort` input).
