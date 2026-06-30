# Engagement Honesty + Collab-Capture — Design Spec

**Date:** 2026-06-30
**Status:** Approved design (brainstorm) → awaiting spec sign-off
**Scope:** `server/scraper.js` (two persistence paths + `discoverRelated` Phase-1 mining), `server/db.js` (one new column), `server/index.js` (one sort clause), `client/src/components/ContentCard.js` + `client/src/pages/DeleteLogTab.js` (display). No new dependencies.
**Base branch:** `engagement-collab-capture`, off current `main` (PRs #2–#5 merged & live).
**Relationship to prior work:** Delivers the **Phase-2 fast-follow** that the approved `2026-06-30-targeted-suggestions` spec explicitly deferred (its §3.2 non-goal: "Collab-capture at scrape time … is the Phase-2 fast-follow, not this spec"). Task 1 (views honesty) is the engagement-audit finding logged in the handoff.

---

## 1. Context & Problem

Two independent honesty/recall gaps in the scraper persistence layer, shipped together because they touch the **same two insert paths**:

### 1a. Views are stored as a fake `0`
Both persistence paths compute views as `item.videoPlayCount || item.videoViewCount || 0`:
- `_fetchAndStoreResults` ([scraper.js:453](../../../server/scraper.js)) — reel actor results **and** the `≤3-item` generic-actor fallback.
- `importByUrls` ([scraper.js:813](../../../server/scraper.js)) — URL imports via the generic actor.

The dedicated **reel actor** returns a real `videoPlayCount`. The **generic actor** (used by URL imports and the small-result fallback) returns **no play/view field at all**, so views collapse to `0`. A genuine zero and "no data" are then indistinguishable — the UI shows a confident `0 views` that is actually unknown. Verified across ~20 Apify datasets; **shares/reposts are confirmed absent** from Apify (Instagram does not expose them) and are explicitly out of scope.

### 1b. Collaborator tags are captured live but never persisted
The reel actor returns `taggedUsers`/`usertags` per post. The discovery **live** path already mines them ([scraper.js:609-622](../../../server/scraper.js)), but the **post mapping** ([scraper.js:465-482](../../../server/scraper.js)) drops them and there is no `posts` column to hold them. Consequently the **Phase-1 DB mining** in `discoverRelated` ([scraper.js:553-575](../../../server/scraper.js)) can only mine **caption @mentions** from already-scraped posts — it never sees photo-tag collaborators we already paid Apify to fetch. The Suggested funnel under-recalls real collab partners.

## 2. Goals & Non-Goals

### Goals
- **Honest views:** store `null` ("unknown") when no view field is present; render `—` in the UI. A genuine `0` still shows `0`.
- **Persist collaborators:** add a `posts.tagged_users` column; write normalized handles from every scrape/import that exposes them.
- **Improve discovery recall:** Phase-1 DB mining in `discoverRelated` also reads `tagged_users`, surfacing collab partners from reels already in the DB — no new Apify spend, no custom Actor.

### Non-Goals
- **Shares/reposts** — confirmed unavailable from Apify; not pursued.
- **Backfilling `tagged_users` on existing rows** — Apify does not re-expose tags without a re-scrape; collab-mining is forward-looking and strengthens as accounts re-scrape on the 3-day cron.
- No change to scoring/aggregation in `runDiscovery` (already aggregates by distinct creator → `collabStrength`; new candidates flow through it unchanged).
- No change to idea generation, gender classification, or the Library beyond the view-display sentinel.

## 3. Decisions (from brainstorm)

| Decision | Choice |
|----------|--------|
| Unknown views storage | Store **`null`** (not `0`) when `videoPlayCount`/`videoViewCount` both absent. `view_count` column already nullable. |
| Unknown views display | New `formatViews(n)` → `—` for `null`/`undefined`; genuine `0` → `0`. Shared `formatCount` left untouched (followers/likes unaffected). |
| `most_viewed` sort | `view_count DESC NULLS LAST` so unknown-views don't float to the top. |
| `minViews` filter + unknown views | **Hide** them (current SQL `view_count >= $n` excludes `null`). We can't confirm they clear the bar; zero extra code. |
| `tagged_users` storage | New `posts.tagged_users TEXT` holding a JSON array of lowercased handles (`null`/absent when none). TEXT+JSON keeps sqlite/PG parity (no JSONB). |
| Collab persistence paths | Write tags in `_fetchAndStoreResults` and `importByUrls` wherever `taggedUsers`/`usertags` is present. |
| Collab mining | Phase-1 of `discoverRelated` selects `tagged_users`, parses JSON, adds each handle as a `tagged_by:` candidate (relevanceScore 40, reason `Photo-tagged by @<creator>`) — matching the existing live Phase-2 path. |

## 4. Architecture

### 4a. Views helper (`scraper.js`, both paths)
Replace `item.videoPlayCount || item.videoViewCount || 0` with a single shared expression `item.videoPlayCount ?? item.videoViewCount ?? null`. A small internal helper (`extractViews(item)`) keeps the two paths identical and testable. `_passesFilters` ([scraper.js:536](../../../server/scraper.js)) already coerces with `post.viewCount || 0`, so `null` views behave as `0` for the in-scraper `minViews` gate — consistent with the SQL-side decision above; no change needed there.

### 4b. Tag normalization + persistence (`scraper.js`, both paths)
A pure helper `normalizeTaggedUsers(item) → string[] | null` extracts handles from `item.taggedUsers || item.usertags` (array of strings, or objects with `.username` / `.user.username`), lowercases, de-dupes, drops the owner, and returns `null` when empty. Both insert statements add `tagged_users` to the column list and bind `taggedJson = handles ? JSON.stringify(handles) : null`. `_fetchAndStoreResults`' `ON CONFLICT … DO UPDATE` also refreshes `tagged_users` (a re-scrape can only add signal). `importByUrls`' `ON CONFLICT … DO NOTHING` is unchanged in conflict behavior.

### 4c. Discovery Phase-1 mining (`scraper.js` `discoverRelated`)
Phase-1 query becomes `SELECT caption, tagged_users FROM posts WHERE account_handle = $1`. For each row: keep the existing caption-@mention extraction, then parse `tagged_users` (guard against malformed JSON → skip), and for each handle not already in `seen` (and not the source account) push a candidate identical in shape to the live Phase-2 tagged path. Provenance reason: `Photo-tagged by @<username>`. The existing `seen` Set prevents intra-run dupes; `runDiscovery` aggregation already turns cross-creator overlap into `collabStrength`.

### 4d. Display (`client`)
Add `formatViews(n)` (returns `—` for `null`/`undefined`, else delegates to existing count formatting) and use it for `post.view_count` in `ContentCard.js` and the deletion-log row in `DeleteLogTab.js`. No other metric changes.

### 4e. Sort (`server/index.js`)
`sortMap.most_viewed` → `view_count DESC NULLS LAST`. Confirmed portable: the prod Postgres honors it, and the test/dev SQLite (better-sqlite3, SQLite 3.51.3) parses `NULLS LAST` natively — verified `ORDER BY v DESC NULLS LAST` orders `NULL` last. No `IS_SQLITE` branch needed.

## 5. Data Model

`ALTER TABLE posts ADD COLUMN IF NOT EXISTS tagged_users TEXT DEFAULT NULL` — appended to **both** arms of the existing dual-mode migration list in `db.js` (Postgres `IF NOT EXISTS` arm ~L270-275; sqlite plain-`ADD COLUMN` arm ~L282-287, which the code wraps in try/catch for idempotency). `view_count` is unchanged (already nullable `INTEGER DEFAULT 0`); new unknown-view rows write explicit `NULL`.

## 6. Configuration (env)

No new env. No change to `APIFY_*`/`ANTHROPIC_API_KEY` usage.

## 7. Observability

- `_fetchAndStoreResults` / `importByUrls`: existing completion logs unchanged; views now `null` where unknown (visible as `—`).
- `discoverRelated`: extend the Phase-1 log to note tagged-handle candidates, e.g. `[Discovery] Phase-1 DB mining: <m> mention + <t> tagged candidates`.

## 8. Error Handling

- Malformed/absent `tagged_users` JSON → `normalizeTaggedUsers` returns `null` on write; the mining parse is wrapped so a bad row is skipped, never throwing.
- Missing view fields → `null`, never an exception.
- No behavior change to budget gating, ON CONFLICT semantics, or run polling.

## 9. Testing (`node:test`, sqlite in-memory, matching existing `server/*.test.js`)

- **`extractViews`:** present `videoPlayCount` → that number; only `videoViewCount` → that; neither → `null`; genuine `0` → `0` (not `null`).
- **`normalizeTaggedUsers`:** array of strings; array of `{username}`; `{user:{username}}`; mixed/empty → `null`; lowercases, de-dupes, drops owner; malformed input → `null`.
- **Persistence:** a scraped item with `taggedUsers` stores a JSON array in `tagged_users`; an item with no views stores `view_count IS NULL`; ON CONFLICT update refreshes `tagged_users`.
- **Phase-1 mining:** a post row with `tagged_users=["alice","bob"]` yields `alice`/`bob` candidates with `tagged_by:` source and the photo-tag reason; malformed JSON row is skipped without throwing; `seen` prevents duplicates against a caption @mention of the same handle.
- **Sort:** `most_viewed` orders real numbers above `NULL` (NULLS LAST) in the dual-mode environment used by tests.
- (Client `formatViews` is trivial; covered by a unit assertion if a client test harness exists, else verified in prod smoke.)

## 10. Risks & Verification

1. **`NULLS LAST` portability.** Resolved during spec review — both engines parse it (Postgres prod + SQLite 3.51.3 in test/dev). No fallback branch required.
2. **Forward-only collab-mining.** Existing rows have no tags; recall improves only as accounts re-scrape. Acceptable and expected (§2 non-goal). Verify by re-scraping one tracked account and confirming new `tagged_users` populate, then a discovery run surfaces a tagged handle.
3. **Generic actor occasionally *does* return a view field.** The `??` chain still captures it; only true absence yields `null`. No regression for reel-actor rows (real counts preserved).
4. **Display regressions.** `formatViews` is additive; `formatCount` untouched, so followers/likes/comments rendering is unchanged.

## 11. Summary of Changes

| File | Change |
|------|--------|
| `server/db.js` | `posts.tagged_users TEXT DEFAULT NULL` (dual-mode migration, both arms). |
| `server/scraper.js` | `extractViews` + `normalizeTaggedUsers` helpers; both insert paths store `null` views + `tagged_users`; `discoverRelated` Phase-1 mines `tagged_users`. |
| `server/index.js` | `sortMap.most_viewed` → `view_count DESC NULLS LAST`. |
| `client/src/components/ContentCard.js`, `client/src/pages/DeleteLogTab.js` | `formatViews(n)` → `—` for unknown views. |
| `server/*.test.js` | New tests per §9. |
