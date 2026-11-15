# Build Log: Auto-sort reels
Started 2026-11-15. MODEL=gpt-6.1-sol ultra (provider forced to openai; user config default is venice/deepseek). MAX_ROUNDS=5.
PLAN_FILE=docs/superpowers/plans/2026-11-15-auto-sort-reels.md · Spec: docs/superpowers/specs/2026-11-15-auto-sort-reels-design.md
Branch auto-sort-reels (worktree ../instascraper-autosort) off origin/main f2e3a89. Baseline: server 291/291 pass.
Plan revised before build: old library scratched via Start fresh (no legacy status).

## Round 1 — Codex build+self-review (thread 01a1dd55-328e-7b22-bcd9-4683fe51da4c)
Implemented all 8 tasks as uncommitted changes. No commits, stashes, checkouts, history rewrites, or real-key API calls.

1. **Schema:** Added idempotent sort-status and AI metadata migrations.
2. **Sort rules:** Added the shared visibility expression, confidence decision rule, and environment defaults.
3. **Model visibility:** Updated feed, audio, ideas, Notion, saves, and media access; preserved saved/feedback history exceptions.
4. **Gemini:** Installed `@google/genai@3.3.0`; added inline/Files video handling, structured output, usage/cost calculation, and bounded retries.
5. **Runner:** Added locking, attempt limits, daily cap, crash recovery, sweep hooks, and hourly catch-up.
6. **Admin API:** Added Needs a look, suggested-type assignment/reuse, redecision, backfill, usage, manual marking, and transactional Start fresh.
7. **Cleanup/export:** Protected sorted reels, added type-based exports, and removed post-tag actions.
8. **UI:** Added the pile, creator mix, usage/backfill controls, export picker, and confirmed Start fresh; removed deprecated controls.

Work was split across **visibility**, **admin_ui**, and **reviewer** agents. I handled Gemini, runner, integration, and final fixes. The reviewer independently inspected the tracked diff and new task files, including SQLite placeholder ordering and all Review Focus cases. Review fixes covered overlapping backfills, cleanup/manual-edit races, interrupted final attempts, redecision races, cached-video controls, and Delete Log failures.

Final verification:

```text
Server: tests 357 | pass 357 | fail 0
Client: Compiled successfully.
git diff --check: clean
```

Commands used `NODE_USE_SYSTEM_CA=0` because the inherited setting crashed Node; server tests also cleared `GEMINI_API_KEY`. The build emitted only the stale Browserslist-data advisory.

Deviations and limits:

- The required Superpowers sub-skill was unavailable; native sub-agents followed the workflow. Parallel execution changed task ordering and grouped full-suite checkpoints; server implementations used red/green tests.
- Added `SQLITE_PATH` support because the plan’s claimed existing change was absent.
- Daily accounting conservatively sums lifetime attempts on recently attempted rows, which can overcount.
- Graphical browsers failed to launch. All eight UI scenarios passed through actual React components against isolated local APIs, including restore; visual layout and media decoding remain unverified.

Before Task 4, official Google documentation and SDK types confirmed:

```js
model: 'gemini-3.5-flash-lite'
config.mediaResolution: 'MEDIA_RESOLUTION_LOW'
part.videoMetadata: { fps: 1 }
config.responseMimeType: 'application/json'
config.responseJsonSchema: { /* four required fields */ }
config.thinkingConfig: { thinkingLevel: 'MINIMAL' }
```

The source-backed findings are recorded in [Gemini verification](/Users/jefftingz/instascraper-autosort/docs/superpowers/plans/2026-11-15-auto-sort-reels-gemini-verification.md).
### Round 1 — Claude final review
Verified myself: server 357/357 pass; only admin-only COALESCE fallback remains (GET /content library filter). Model access, migration, cleanup protect, export, start-fresh confirm UI, needs-look actions look correct. Codex also fixed DeleteLogTab/route key mismatch (last_7_days/totalPages) — accepted. Artifacts .ask-claude/ .fable/ are tool dirs, exclude from commit.

### Claude's fix-list → Codex
Final review found these issues — fix each (delegate to sub-agents where it helps), add/adjust tests, then re-run `cd server && NODE_USE_SYSTEM_CA=0 GEMINI_API_KEY= npm test` and `cd client && NODE_USE_SYSTEM_CA=0 CI=true npm run build` and report the output. Do not commit.

1. server/index.js POST /content/:id/content-type — it calls redecideNeedsLook on every per-reel manual type change. That re-runs Gemini over the whole Needs-a-look pile on every tap in the pile (N taps × pile size calls). The spec only re-decides when a NEW content type is created. Remove that call there (keep it in POST /content-types and the suggested-type create route). Add a test proving a per-reel content-type set does not trigger redecide (extract a small testable helper if needed).

2. server/sort-runner.js — during a Gemini outage/rate-limit every candidate in the batch throws, each burns an attempt, and after maxAttempts runs (~1–2h) every new reel lands in needs_look. Stop the batch after 3 consecutive describe() failures (errors thrown by describe, not the missing-file fs.access error), leaving remaining candidates untouched (no attempt claimed). Test: describe always throws, 5 candidates → exactly 3 attempts claimed, loop stops, others have ai_attempts 0.

3. server/sort-routes.js POST /sort/start-fresh — it does 2 queries per reel inside one transaction; with thousands of reels on Railway Postgres this can exceed the HTTP request timeout. Make it set-based inside the transaction: one `INSERT INTO deletion_log (post_id, shortcode, account_handle, reason) SELECT id, shortcode, account_handle, 'manual:start_fresh' FROM posts WHERE (soft_deleted = 0 OR soft_deleted IS NULL)` then one `UPDATE posts SET soft_deleted = 1, soft_deleted_at = $1 WHERE (soft_deleted = 0 OR soft_deleted IS NULL)`; `hidden` = the UPDATE rowCount. Must work on both Postgres and the sqlite adapter (avoid RETURNING). Existing start-fresh tests must still pass.

## Round 2 — Codex fixes
Implemented and independently reviewed the fixes. No commits.

1. **Manual typing:** The current handler already had no redecision call. Added a regression proving per-reel changes make zero calls, while creating a new type triggers redecision.
2. **Outages:** Runner stops after three consecutive `describe()` failures. Success resets the counter; missing files don’t count. Remaining candidates stay untouched. Backfill also respects the stop.
3. **Start fresh:** Uses exactly two set-based queries inside the transaction, without `RETURNING`; returns the UPDATE row count. Tests cover rollback, idempotence, and deletion logs.

Two sub-agents implemented the runner and SQL changes; a separate reviewer verified them.

Both requested verification commands exited **0**:

```text
Server npm test:
tests 370
pass 370
fail 0
skipped 0

Client CI build:
Compiled successfully.
JS: 170.26 kB gzip
CSS: 8.42 kB gzip
```

Initial socket-based tests hit sandbox `EPERM`. Updated their harness to run through actual Express middleware in-process, preserving assertions. The build emitted only the stale Browserslist-data advisory.
### Round 2 — Claude final review: CLEAN
Verified myself: server 370/370 pass; client CI build compiles. Fix 1 was a misread on my part (redecide call was in POST /content-types, correct); regression test added. Fix 2: runner stops after 3 consecutive describe failures. Fix 3: start-fresh is two set-based statements. Visual check (local sqlite, seeded): cockpit Auto-sort card + Start fresh; Needs a look tab groups Lifestyle/lifestyle into one suggestion; Create type & assign all moved 2 reels out; Library has no Recreate controls. Not verified: real video playback in the pile (seed had no files), real Gemini calls (no key).
