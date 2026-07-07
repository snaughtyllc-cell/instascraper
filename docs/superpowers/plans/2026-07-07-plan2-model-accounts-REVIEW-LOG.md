# Plan Review Log: Plan 2 — Model Accounts + Personalization
Started 2026-07-07 session. MAX_ROUNDS=5. Reviewer: Codex (gpt-5.5, read-only). SECURITY-CRITICAL (auth + per-model isolation).

## Round 1 — Codex (thread 019f3cfe-781d-7770-be2c-accd2bdce219)

1. **/video/:id IDOR is REAL, not acceptable** — sequential ids guessable; /me/saves can surface guessed ids. Fix: for model sessions, scope /video/:id through the model-niche predicate or 404; admin/API-key keep full access.
2. **/me/saves leaks arbitrary post metadata** — insert accepts any :postId; GET returns posts.* with no niche/archived/soft-delete check. Fix: validate the post is visible to the session model before insert; apply the scoped visibility join in GET.
3. **/me/feed breaks in SQLite/dev** — `= ANY($1)` array binding unsupported by the SQLite adapter (only rewrites $n). Fix: dialect-safe `IN ($1,$2,...)` placeholders + a real better-sqlite3 execution test (not regex).
4. **Archived posts exposed to models** — feed filters soft_deleted but not archived (ai-agent hides archived). Fix: add `(archived = 0 OR archived IS NULL)` to /me/feed, /me/saves, the video visibility check.
5. **Logins not bound to active models + not promptly revocable** — login selects by email only; delete only marks status='inactive'; requireModel trusts the session forever. Fix: require status='active' AND login_enabled=1 at login AND per-request in requireModel; disable login on delete.
6. **Email not unique** — plain email TEXT → ambiguous resolution. Fix: case-insensitive unique index for non-empty emails, PG+SQLite compatible.
7. **role='admin' escalation via model form** — buildCredentialFields accepts body.role==='admin'; the admin-gated /models form could mint admin logins. Fix: remove role from model provisioning, force role='model'.
8. **Dynamic SET needs explicit allowlist** — build SQL only from a constant MODEL_WRITE_FIELDS, never Object.keys(req.body); test malicious keys ignored.
9. **GET /models SELECT * leak correctly identified**; no other route returns models.* to a client, but internal/admin export SELECT * should be narrowed defensively.
10. Dual migration handling correct; model_saved_posts test weak (copies DDL) — add an initDB/SQLite smoke test if possible.
11. Back-compat mostly preserved; minor test bug: curl check doesn't save the login cookie before /auth/check — use `curl -c /tmp/j -b /tmp/j`. No weakening in bcrypt/checkProdSecrets/session/x-api-key.

VERDICT: REVISE

### Claude's response (Round 1 → revised plan)

Verified before revising: `posts.archived` exists (db.js:130). All 11 findings incorporated:
- #1 → Task 6 Step 5: `/video/:id` branches on role — admin/x-api-key full; model sessions must pass `nicheVisibilityClause` else 404. Flagged as a relaxable HUMAN DECISION at the build gate (hard niche boundary vs. trusted-team browse-all).
- #2 → Task 6: `POST /me/saves` visibility-guards the insert (404 if the post isn't in the model's niche/visible); `GET /me/saves` re-applies the visibility join. `saveParams` also int4-bounds the id.
- #3 → Task 5: introduced `nicheVisibilityClause(niches, startIdx)` using `IN ($k,...)` placeholders (NOT `= ANY`, which the SQLite adapter can't bind); the me-feed test now EXECUTES against real in-memory sqlite (not regex).
- #4 → the shared visibility clause filters `archived` AND `soft_deleted` everywhere (feed, saves, video).
- #5 → `resolveLogin` requires `status='active'` + `login_enabled`; `requireModel` is now async and re-checks status+login_enabled per request (prompt revocation despite the 7-day cookie); `DELETE /models` also sets `login_enabled=0`.
- #6 → Task 1 adds a partial case-insensitive unique index `models_email_lower_uk` (PG+SQLite); Task 8 returns 409 on conflict.
- #7 → `buildCredentialFields` drops `role` entirely; `resolveLogin` always yields `role:'model'` for the model path (never trusts the column).
- #8 → dynamic SET built from a constant `MODEL_WRITE_FIELDS` allowlist, never `Object.keys(req.body)`; test asserts malicious keys ignored.
- #9 → `GET /models` off `SELECT *` (explicit columns, no `password_hash`); audit + narrow other `SELECT * FROM models`.
- #10 → accepted as documented tradeoff (model_saved_posts CREATE isn't in the exported array; columns tested non-vacuously via SQLITE_MIGRATIONS).
- #11 → curl cookie `-c`/`-b` fix in Task 3.
Shared helpers `nicheVisibilityClause` + `parseNiches` (me-feed.js) + `sessionModelNiches` (index.js) keep the visibility logic in one place across feed/saves/video.

## Round 2 — Codex

"Main security direction much better than round 1", but:
1. Unique-email index created BEFORE `models.email` exists (index placed after the models CREATE, but auth columns are added later in the migration loop) → fails + silently skipped → uniqueness NOT enforced. Fix: create the index AFTER both migration loops; don't just log-and-continue on failure.
2. Task 5 uses `parseNiches` before it exists (deferred to Task 6). Fix: implement/export/test `parseNiches` in Task 5.
3. Duplicate `require('./me-feed')` / `const parseNiches` across Task 5 + Task 6 = syntax error. Fix: one consolidated top-level import.
4. Disabled model sessions can still hit `/video` (it's requireAuth not requireModel; sessionModelNiches loads only niches, not status/login_enabled). Fix: media visibility helper must require an active+enabled model, or a `requireActiveModelOrAdmin` media middleware.
5. Hard boundary still leaks THUMBNAILS: `/thumb/:postId` fetches any post's thumbnail by id; `/thumbnails` serves cached files statically. Fix: scope `/thumb/:postId` too; don't expose raw `/thumbnails` static to models unless tokenized.
6. Global route policy inconsistent: Global Constraints says models reach only /me/*, auth, /thumb, /thumbnails, but Task 4 leaves /video accessible. Fix: reconcile the allowlist; specify /thumb scoping if the hard boundary remains.

VERDICT: REVISE

### Note: findings 4-6 hinge on a HARD-vs-SOFT isolation decision (surfaced to the human). Hard isolation = scope video+thumb+thumbnails-static + active-model media middleware (big). Soft = isolate only private data (saves/ideas) + niche-scope the feed as a UX filter; media stays shared (reels are public content). Fixes 1-3 apply either way.

### Claude's response (Round 2 → revised plan) + HUMAN DECISION: SOFT isolation

The human chose SOFT isolation: media (`/video`/`/thumb`/`/thumbnails`) is shared public content across all authed users; isolation is enforced only on private per-model data (saves/ideas, session-keyed) + the feed is niche-scoped as a relevance filter. This makes R2-#4/#5/#6 (media revocation/thumbnail-leak/route-policy) MOOT and REVERTS R1-#1 (/video niche branch) and R1-#2 (/me/saves visibility guard) to the simpler session-keyed versions.

Fixes applied (decision-independent, findings 1-3):
- R2-#1: unique-email index moved to AFTER both migration loops (email exists by then); on a real duplicate it now THROWS (fail boot) instead of log-and-continue — uniqueness is genuinely enforced. (Task 1)
- R2-#2: `parseNiches` is defined/exported/tested in Task 5 (was deferred to Task 6). (Task 5)
- R2-#3: ONE consolidated `const { buildMeFeedQuery, nicheVisibilityClause, parseNiches } = require('./me-feed')` at the top of Task 5; Task 6 reuses it and never re-declares (no duplicate-const syntax error). (Tasks 5/6)

SOFT reverts:
- Task 6 `/me/saves` POST/GET → simple session-keyed (owner always the session modelId; GET filters soft_deleted for quality; no niche/visibility guard). Removed `sessionModelNiches`.
- Task 6 Step 5 (`/video` niche branch) → removed entirely; `/video` stays shared `requireAuth`.
- Global Constraints route allowlist now lists `/video` as a shared media route (reconciles R2-#6).

Kept (real security regardless of isolation): dialect-safe IN() feed + sqlite exec test (R1-#3), archived filter in feed (R1-#4), active+enabled login + per-request requireModel re-check + disable-on-delete (R1-#5), unique email + 409 (R1-#6), no role escalation (R1-#7), allowlist SET (R1-#8), GET /models off SELECT* (R1-#9), curl fix (R1-#11).

## Round 3 — Codex

"No material security blockers under the stated SOFT isolation model." Private data paths session-keyed, role separation preserved, login hardening intact, index-order + parseNiches + import bugs fixed. Four NON-BLOCKING consistency nits:
1. Task 5 interface still said nicheVisibilityClause is reused by /me/saves + /video (contradicts SOFT). Fix: feed-only.
2. Task 5 test import omitted parseNiches though the prose requires a parseNiches test. Fix: add it.
3. Task 2 "PASS (5 tests)" after adding a 6th test. Fix count.
4. Self-review type-consistency still listed `role` in buildCredentialFields keys. Fix: remove.

VERDICT: APPROVED

### Claude's response (Round 3 → final)
All 4 nits folded in (feed-only wording; parseNiches in the test import; test-count wording; role removed from the type-consistency line).

## OUTCOME: APPROVED after 3 rounds
R1: 11 security findings (all incorporated). R2: 6 findings — 3 real bugs fixed, 3 mooted by the SOFT-isolation human decision. R3: APPROVED + 4 consistency nits (folded in). Plan is ready for subagent-driven implementation on branch `model-accounts` off main. Isolation = SOFT (media shared; private data + feed scoped).
