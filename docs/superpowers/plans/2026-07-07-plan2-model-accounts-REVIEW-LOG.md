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
