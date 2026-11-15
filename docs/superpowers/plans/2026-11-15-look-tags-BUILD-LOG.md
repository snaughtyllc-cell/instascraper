# Build Log: Look tags + learned taste
Started 2026-11-15. MODEL=gpt-6.1-sol ultra (provider forced to openai). MAX_ROUNDS=5.
PLAN_FILE=docs/superpowers/plans/2026-11-15-look-tags.md · Spec: docs/superpowers/specs/2026-11-15-look-tags-design.md
Branch look-tags (worktree ../instascraper-autosort) off origin/main 38d2a74.

## Round 1 — Codex build+self-review
Implemented all seven tasks; changes remain uncommitted.

1. Added vocabulary/schema, admin CRUD, and validated model tags.
2. Added Gemini’s five-tag schema, explicit no-ethnicity rule, custom-tag exclusion, and persistence.
3. Added creator/candidate profiles, manual tags at 100%, and match scores.
4. Added feed/proposal/suggestion ranking without additional filtering.
5. Added backfill estimates, shared cap/lock, and updates restricted to `ai_look_tags`.
6. Added transactional taste recomputation after reactions and nightly, plus taste ranking/API.
7. Added tag pickers/chips, creator controls, taste display, vocabulary management, and confirmed backfill.

Work split: `vocabulary_profiles` handled Tasks 1/3/7; `gemini_backfill` handled 2/5; I handled 4/6 and integration. `skeptical_review` independently reviewed the full implementation diff and new files.

Review fixes included PostgreSQL fractional parameters, workspace tag parsing, candidate denominators, bounded profile shares, and concurrent taste recomputation. All six Review Focus cases are covered; no remaining confirmed blockers.

Actual verification, with the required environment overrides:

```text
Server baseline: tests 421, pass 421, fail 0
Server final:    tests 478, pass 478, fail 0
Client build:   Compiled successfully.
Client tests:   2 suites passed, 11 tests passed
git diff --check: clean
```

Deviations:
- Skipped branch-switch/commit steps under your Git restrictions.
- Added an attempt ledger and shared redecide accounting to preserve backfill metadata while enforcing the daily cap.
- Used native sub-agents because the plan’s Superpowers helpers were unavailable; red/green runs used integrated full-suite checkpoints during parallel work.
- Browser visual verification was blocked by sandbox/browser-host failures. Seeded SQLite HTTP checks and mocked React DOM interaction tests passed instead; visual rendering remains unverified.
### Round 1 — Claude final review: CLEAN
Verified myself: server 478/478; client build compiles. Prompt forbids inferring ethnicity/race/age/body; custom tags excluded from Gemini schema; quoted-JSON LIKE matching; feed only reorders (shuffle stays random); taste recompute serialized per model. Seeded preview: Logan (look brunette+bedroom, saved a brunette/bedroom reel, disliked a blonde/car reel) -> workspace reels rank the brunette reel first, saved/disliked reels excluded as before; Her taste panel shows Likes Bedroom/Brunette +0.33, Less her style Blonde/Car -0.33; look chips + Edit look in header; creator rows have + tag picker. Minor accepted: a reel both saved and marked not_my_style counts on both sides. Not verified: real Gemini look tags on live reels.
