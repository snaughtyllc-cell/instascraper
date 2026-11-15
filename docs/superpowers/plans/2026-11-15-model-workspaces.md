# Model Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each model gets a workspace (her creators, her reels, AI-routed suggestions). Her feed draws only from creators added for her, falling back to niche-only while she has none.

**Architecture:** New `model_creators`, `model_creator_proposals` and `model_suggestions` tables. One SQL helper, `modelScopeClause`, adds "her creators, or no creators yet" to every model-facing query that already uses `effectiveNicheExpr`. Candidate creators found by discovery or Radar get 3 top reels sorted by the existing Gemini describe step and are routed to models by fit.

**Tech Stack:** Node 20 / Express, Postgres + better-sqlite3 tests, `node:test`, React (CRA) + Tailwind, existing `server/gemini-sort.js`.

**Spec:** `docs/superpowers/specs/2026-11-15-model-workspaces-design.md` (builds on `2026-11-15-auto-sort-reels-design.md`)

## Global Constraints

- Usernames compare case-insensitively: store `LOWER(username)` in new tables; match with `LOWER(posts.account_handle)`.
- Env knobs: `WORKSPACE_PROPOSE_MIN_SHARE=0.3`, `SUGGEST_MIN_FIT=0.34`, `SUGGEST_SOURCE_BOOST=0.25`; reuse `AUTO_SORT_MIN_CONFIDENCE` and `AUTO_SORT_DAILY_MAX`.
- Fallback: a model with zero `model_creators` rows sees today's niche-only results. With ≥1 row, only her creators.
- No new Apify calls. Candidate reels come from the existing `captureTopReels`.
- Scraping stays per creator. A creator is paused only when a VA removes their **last** model; adding a creator to any model sets `tracked_accounts.status='active'`.
- SQLite adapter: placeholders in ascending appearance order.
- Work on a branch off `origin/main` (currently `358f130`). Don't commit unless told; the codex-build flow commits after review.
- Tests: `cd server && NODE_USE_SYSTEM_CA=0 GEMINI_API_KEY= npm test` (baseline 370 passing) and `cd client && NODE_USE_SYSTEM_CA=0 CI=true npm run build`.

## Review Focus

1. **Handle casing:** a creator added as "Mia.Talks" while posts store `mia.talks` must still match (Task 2 test `scope matches handles case-insensitively`).
2. **Removing a creator who still belongs to another model** must NOT pause them (Task 3 test `remove keeps active when another model owns`).
3. **A candidate whose reel links are already expired** (download 403) gets no model rows and doesn't crash the discovery loop (Task 5 test `expired candidate reels → no routing, no throw`).
4. **Re-running proposals** must not re-propose a rejected pair, or one that's already owned (Task 4 test `rejected and owned pairs are not re-proposed`).
5. **The daily Gemini cap** counts candidate-reel sorts too, so discovery can't blow past `AUTO_SORT_DAILY_MAX` (Task 5 test `candidate sorting respects daily cap`).

---

### Task 1: Schema and scope helper

**Files:**
- Create: `server/model-scope.js`, `server/workspace-migration.js`
- Modify: `server/db.js` (call `ensureWorkspaceTables(db, { isPg })` after `ensureSortStatus`)
- Test: `server/model-scope.test.js`, `server/workspace-migration.test.js`

**Interfaces:**
- Produces:
  - Tables:
    - `model_creators (model_id INTEGER NOT NULL, username TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'va', added_at TEXT, PRIMARY KEY (model_id, username))`
    - `model_creator_proposals (model_id INTEGER NOT NULL, username TEXT NOT NULL, share REAL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT, decided_at TEXT, PRIMARY KEY (model_id, username))` with status `pending|confirmed|rejected`
    - `model_suggestions (model_id INTEGER NOT NULL, username TEXT NOT NULL, fit REAL NOT NULL, reason TEXT, status TEXT NOT NULL DEFAULT 'pending', snoozed_until TEXT, reviewed_at TEXT, created_at TEXT, PRIMARY KEY (model_id, username))` with status `pending|approved|dismissed`
    - New columns on `suggested_reels`: `ai_type TEXT, ai_confidence REAL, ai_error TEXT, ai_classified_at TEXT, ai_cost_usd REAL`
  - `ensureWorkspaceTables(db, { isPg }) -> Promise<void>` (idempotent).
  - `modelScopeClause(postsAlias = 'posts', startIdx) -> { clause: string, params: (modelId) => any[] }`. The clause is
    `(NOT EXISTS (SELECT 1 FROM model_creators mcz WHERE mcz.model_id = $a) OR EXISTS (SELECT 1 FROM model_creators mcs WHERE mcs.model_id = $b AND mcs.username = LOWER(<alias>.account_handle)))`, with `$a=$startIdx`, `$b=$startIdx+1`, and `params(modelId)` returning `[modelId, modelId]`.

- [ ] **Step 1: Write failing tests:**
  - migration: `creates the three tables and suggested_reels columns; second run no-op`.
  - scope (sqlite): `model with no creators sees all`; `model with creators sees only theirs`; `scope matches handles case-insensitively` (model_creators `mia.talks`, post handle `Mia.Talks` → visible).
- [ ] **Step 2: Run** `node --test model-scope.test.js workspace-migration.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement both modules and wire `db.js`.**
- [ ] **Step 4: Run the full suite.** Expected: all pass.

### Task 2: Apply scope to every model-facing path

**Files:**
- Modify: `server/me-feed.js` (`buildMeFeedQuery`: when `modelId` is valid, AND the scope clause into the niche branch), `server/model-access.js` (the niche branch becomes `(effectiveNicheExpr IN (...) AND scope)`; assigned/saved/feedback branches unchanged), `server/index.js` `/me/saves` (same) and `/me/audio/trending` + `/me/audio/:audioId/reels` (pass `modelId`), `server/audio.js` (`buildTrendingAudioQuery`, `buildAudioReelsQuery`, `trendingAudio` gain an option `modelId`; when set and not `all`, AND the scope), `server/ai-agent.js` (`generateIdeasForModel`'s source-reel queries AND the scope for that model)
- Unchanged: `server/notion-sync.js` (seeding stays library-wide, per spec)
- Test: `server/me-feed.test.js`, `server/model-access.test.js`, `server/audio.test.js`, `server/ai-agent.test.js`

**Interfaces:**
- Consumes: `modelScopeClause` (Task 1).
- Produces: `buildTrendingAudioQuery(niches, { all, cutoffIso, minReels, modelId })`, `buildAudioReelsQuery(audioId, niches, { all, limit, modelId })`, `trendingAudio(db, { niches, all, cfg, nowMs, examples, modelId })`.

- [ ] **Step 1: Write failing tests:**
  - me-feed: `fallback — no creators, niche reels from any creator visible`; `with creators — other creators' niche reels hidden`; `own creator's reel outside her niches hidden`.
  - model-access: `assigned reel from a non-owned creator still accessible`; `saved reel stays accessible after the creator is removed`.
  - audio: `trending audio for a model with creators only counts her creators' reels`.
  - ai-agent: `idea source reels limited to her creators when she has some` (fake pool asserting the SQL contains `model_creators` and the params include the model id).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Keep placeholder order ascending.
- [ ] **Step 4: Run the full suite.** Expected: all pass.

### Task 3: Ownership service and workspace endpoints

**Files:**
- Create: `server/workspaces.js` (service), `server/workspace-routes.js` (`registerWorkspaceRoutes(app, { pool })`, mounted under `/workspaces` behind `requireAdmin` in `index.js`)
- Modify: `server/creators-mix.js` (`getCreators` also returns `owners: [{ modelId, name }]`), `server/index.js` `GET /tracked` (adds `owners` per account; supports `?unassigned=true`)
- Test: `server/workspaces.test.js`

**Interfaces:**
- Produces:
  - `addCreator(pool, modelId, username, source='va') -> Promise<{ added: boolean }>`: lowercases; inserts the tracked account as `active` if missing (same columns as today's approve insert), else sets `status='active'`; inserts into `model_creators` (ON CONFLICT DO NOTHING); marks any proposal for the pair `confirmed`.
  - `removeCreator(pool, modelId, username) -> Promise<{ removed: boolean, paused: boolean }>`: deletes the pair; if no `model_creators` rows remain for that username, sets the tracked status to `paused`.
  - `listWorkspaceCreators(pool, modelId) -> Promise<Array<{ username, source, added_at, mix, last_scraped_at, status }>>` (mix as in `creators-mix.js`).
  - HTTP:
    - `GET /workspaces/:modelId` → `{ model, creatorCount, fallback: boolean }`
    - `GET /workspaces/:modelId/creators` → list
    - `POST /workspaces/:modelId/creators` `{ username }` → `addCreator`
    - `DELETE /workspaces/:modelId/creators/:username` → `removeCreator`
    - `GET /workspaces/:modelId/reels?page=` → the same SQL as her `/me/feed` (`buildMeFeedQuery(her niches, { modelId, page })`)

- [ ] **Step 1: Write failing tests:**
  - `add creates the tracked account active and links it`
  - `add reactivates a paused creator`
  - `remove pauses when it was the last model`
  - `remove keeps active when another model owns`
  - `invalid modelId → 400`
  - `unknown model → 404`
- [ ] **Step 2: Run** `node --test workspaces.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite.** Expected: all pass.

### Task 4: Owner proposals

**Files:**
- Create: `server/proposals.js`
- Modify: `server/workspace-routes.js`, `server/scheduler.js` (weekly cron `30 4 * * 1`, plus one run ~60s after boot)
- Test: `server/proposals.test.js`

**Interfaces:**
- Consumes: `addCreator` (Task 3), `effectiveNicheExpr`, `parseNiches`.
- Produces:
  - `computeProposals(pool, { minShare = Number(process.env.WORKSPACE_PROPOSE_MIN_SHARE || 0.3) } = {}) -> Promise<{ proposed: number }>`. For each tracked creator with ≥1 sorted reel and each active model: share = (her-niche sorted reels) ÷ (all sorted reels). Insert a `pending` proposal when share ≥ minShare, the pair isn't owned, and no proposal row exists for it (any status). Updates `share` on existing pending rows.
  - HTTP:
    - `GET /workspaces/:modelId/proposals` → pending, ordered by share desc
    - `POST /workspaces/:modelId/proposals/:username/confirm` → `addCreator(..., 'proposal')`
    - `POST .../:username/reject` → status `rejected`
    - `POST /workspaces/:modelId/proposals/confirm-all` → `{ confirmed }`

- [ ] **Step 1: Write failing tests:**
  - `proposes when share ≥ 0.3` (creator with 3 sorted reels, 1 talking → 0.33 proposed to a talking model; a dance-only model not proposed)
  - `rejected and owned pairs are not re-proposed`
  - `confirm-all links every pending pair and sets creators active`
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite.** Expected: all pass.

### Task 5: Sort candidate reels and route them to models

**Files:**
- Create: `server/candidate-routing.js`
- Modify: `server/scraper.js` (`captureTopReels`: after inserting reels, `await routeCandidate(username)` inside try/catch, logging `[Route]`), `server/sort-runner.js` (`attemptsToday` and `sortUsage` also count/sum `suggested_reels` rows with `ai_classified_at` in the window)
- Test: `server/candidate-routing.test.js`

**Interfaces:**
- Consumes: `describeReel`, `estimateCostUsd`, `makeGeminiClient` (gemini-sort.js), `sortConfig`, `downloadVideo` and `tempVideoPath` from `server/videos.js`.
- Produces:
  - `computeFit({ reels, niches, minConfidence, sourceOwned, boost }) -> number | null`: `null` when fewer than 2 reels sorted without error; otherwise (count with `ai_type ∈ niches` and `ai_confidence ≥ minConfidence`) ÷ (sorted-without-error count), plus `boost` if `sourceOwned`, capped at 1.
  - `routeCandidate(username, { pool, describe, download, cfg, videoDir }) -> Promise<{ sorted: number, routed: number[] }>`:
    1. If `!cfg.enabled`, return zeros.
    2. Take up to 3 `suggested_reels` for the username (by rank) with no `ai_classified_at`. Respect the daily cap (skip when the cap is reached).
    3. For each: download to a temp path, `describe`, store `ai_type/ai_confidence/ai_classified_at/ai_cost_usd` (or `ai_error`), and delete the temp file in `finally`.
    4. For each active model: `sourceOwned` = any token in `suggested_accounts.source` (comma-separated) is one of her creators. If `fit ≥ SUGGEST_MIN_FIT`, upsert a `model_suggestions` row (keep an existing non-pending status) with reason `"<n> of <m> reels <Label> · found via @<src> (<Model>'s creator)"` (omit the "found via" part when there's no owned source).

- [ ] **Step 1: Write failing tests:**
  - `computeFit`: 2/3 talking at 0.9 with niches [talking] → 0.667; with sourceOwned → 0.917; 1 sorted → null; low-confidence reels don't count.
  - `routes to matching models only` (fake describe/download; talking candidate routed to the talking model and not the dance model; reason string matches).
  - `source boost uses that model's creators`.
  - `expired candidate reels → no routing, no throw` (download returns `{status:'expired'}`).
  - `candidate sorting respects daily cap`.
  - `existing dismissed suggestion keeps status`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite.** Expected: all pass.

### Task 6: Per-model suggestion endpoints and global approve

**Files:**
- Modify: `server/workspace-routes.js`, `server/index.js` (`GET /suggested` adds `models: [{ modelId, name, fit, status }]` per account; `POST /suggested/:username/approve` and `/suggested/approve-bulk` require `modelIds: number[]` (non-empty → 400 otherwise) and call `approveForModel` per id)
- Test: `server/workspace-suggestions.test.js`

**Interfaces:**
- Consumes: `addCreator` (Task 3).
- Produces:
  - `approveForModel(pool, modelId, username) -> Promise<void>`: `addCreator(..., 'suggestion')`; upserts `model_suggestions.status='approved'`; sets `suggested_accounts.status='approved'` + `reviewed_at`.
  - HTTP:
    - `GET /workspaces/:modelId/suggestions` → pending rows not snoozed, joined with `suggested_accounts` and top reels (`attachTopReels`), ordered by `fit DESC, suggestion_score DESC`
    - `POST /workspaces/:modelId/suggestions/:username/approve`
    - `.../dismiss` (that model only)
    - `.../snooze` (7 days, that model only)

- [ ] **Step 1: Write failing tests:**
  - `approve in one workspace leaves it pending in another`
  - `dismiss affects only that model`
  - `global approve without modelIds → 400`
  - `global approve with two modelIds links both and creator active`
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite.** Expected: all pass.

### Task 7: Admin UI

**Files:**
- Create: `client/src/pages/ModelWorkspace.js`
- Modify: `client/src/pages/ModelsTab.js` (an "Open workspace" button per model renders `ModelWorkspace` with a back link), `client/src/api.js` (functions for every Task 3/4/6 endpoint), `client/src/pages/SuggestedAccountsTab.js` (model chips with per-model status; Approve opens a model picker pre-checked with routed models and sends `modelIds`), `client/src/pages/TrackedAccountsTab.js` (owner chips; "Unassigned" filter with Pause / Remove)
- Test: client build plus a browser check

**Interfaces:**
- Consumes: Task 3/4/6 HTTP endpoints.
- Workspace layout:
  - Header: model name and niches. A fallback banner shows when `fallback` is true: "No creators yet — showing every reel in her niches."
  - Three tabs:
    - **Creators:** list with mix and a remove ✕, an "Add creator" input, and a Proposed list with Confirm / Reject / Confirm all
    - **Reels:** a grid using `/video/:id`
    - **Suggested:** ranked cards with reason, top reels, and Approve / Dismiss / Snooze

- [ ] **Step 1: Implement the client changes.**
- [ ] **Step 2: Run** `cd client && NODE_USE_SYSTEM_CA=0 CI=true npm run build`. Expected: "Compiled successfully."
- [ ] **Step 3: Browser check** (local sqlite, seeded with 2 models, 3 creators, proposals, routed suggestions):
  - The fallback banner disappears after the first creator is added.
  - Confirm all moves the proposals into Creators.
  - Approving a suggestion in one workspace leaves it pending in the other.
  - The global Approve asks for models.
  - Removing a last owner shows the creator under Unassigned as paused.

## After the build (user steps)

1. Deploy. Every model starts on the fallback, so feeds look the same as today.
2. In each workspace, review the Proposed creators and press **Confirm all** (or pick individually). That model then switches to her own creators.
3. New suggestions get routed after the next discovery (Mondays 04:00) or a manual Radar run.
