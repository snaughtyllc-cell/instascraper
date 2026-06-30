# Targeted Suggestions — Design Spec

**Date:** 2026-06-30
**Status:** Approved design (brainstorm complete) → awaiting spec sign-off
**Scope:** `server/scraper.js` (`discoverRelated`, `_classifyGender`, new batched classify), `server/scheduler.js` (`runDiscovery` aggregation + scoring), `server/index.js` (approve → paused, bulk approve, bulk scrape-now), `server/db.js` (one new column on `suggested_accounts`), `client/src/pages/SuggestedAccountsTab.js` + `client/src/api.js`. No new dependencies.
**Base branch:** `targeted-suggestions`, off current `main` — which now includes the merged cost-control work (PR #3) and smarter-ai-ideas (PR #2). The budget-gated "Scrape now" reuses the (now in-`main`) `startScrapeJob` budget gate + `BudgetExceededError`; no stacking dependency remains.
**Sub-project:** "Targeted Suggestions" — discovery precision + fast approve (an offshoot of Sub-C reach/discovery, pulled forward for staffing throughput).

---

## 1. Context & Problem

Suggested Accounts discovery (`discoverRelated` → `runDiscovery`) finds new accounts to track from the networks of tracked creators. Today it is **too broad** — it surfaces male and off-topic accounts. Verified against the code:

- **"Unknown" is treated as female.** The gender filter keeps everything that is not *confidently* male: `if (gender !== 'male')` ([scraper.js:654](../../../server/scraper.js)). Empty bio, ambiguous handle, AI returns "unknown," or AI unavailable → kept as if female.
- **Most candidates are never given a bio to classify.** Bio enrichment is capped at **4 Apify calls per run** ([scraper.js:625](../../../server/scraper.js)); everyone past that keeps `bio=''`, so the classifier sees a username only → "unknown" → kept.
- **The AI classifier silently no-ops without an Anthropic key.** `if (!client) return 'unknown'` ([scraper.js:152-153](../../../server/scraper.js)). With no `ANTHROPIC_API_KEY` set, gender classification is effectively *off* and everything passes.
- **Gender plays no role in scoring.** Score = relevance(source type) + ER + frequency ([scheduler.js:116-124](../../../server/scheduler.js)); gender is only a hard filter. A random "unknown" with decent ER can outrank a real female creator.
- **A hashtag-overlap source adds the noisiest candidates** (the "Shares hashtags" block, `relevanceScore: 25`, [scraper.js:~500-530](../../../server/scraper.js)).

The business only wants **female creator competitors**. Random/male accounts waste staff review time and Apify spend — and because an approved account is inserted `active` and auto-scraped by the 3-day cron, broad approvals turn into real, silent cost.

## 2. Goals & Non-Goals

### Goals
- **Ranked precision:** confident-female ranked to the top, **confident-male dropped**, **"unknown" parked at the bottom** (visible behind a toggle/expander, never mixed into the top).
- Make **gender a first-class ranking signal**, not just a hard filter; "unknown" no longer counts as female.
- **Classify cheaply and better:** keep the free keyword pass, replace the capped one-by-one AI fallback with **one batched AI call** over the still-ambiguous candidates, fed with **caption snippet + the tagging creator** as context (not username-only).
- **Reward real competitor overlap:** a candidate tagged/mentioned by **multiple** tracked creators ranks higher ("collab strength") — this replaces the cut hashtag signal.
- **Fast, safe approve:** staff **bulk-approve** a batch into Tracked as **`paused`**, then **bulk "Scrape now"** (budget-gated) — nothing scrapes silently.

### Non-Goals (deferred)
- **Collab-capture at scrape time** (persisting `taggedUsers`/collaborator handles per reel) is the **Phase-2 fast-follow**, not this spec. This spec mines caption @mentions (back-catalog) + tagged users surfaced by the discovery run.
- No changes to idea generation, the engagement pipeline, or the Library (separate tracks).
- No new gender data source beyond username / bio / caption / source context.
- No guarantee of zero misclassification — the ranked model *tolerates* unknowns by parking them, rather than trying to perfectly classify every account.

## 3. Decisions (from brainstorm)

| Decision | Choice |
|----------|--------|
| Precision model | **Ranked** — male dropped, female on top, unknown parked at bottom. |
| "Unknown" handling | **Not female.** Ranks below every confident-female regardless of ER/followers. |
| Classification | Free keyword/pronoun pass per candidate → **one batched AI call** for the remainder, with caption snippet + tagging-creator context. |
| Sources | **Caption @mentions + collab/tagged users only.** Hashtag-overlap source **cut**. |
| Scoring | **Female-confidence tier first** (read-time), then `collab_strength × ER × frequency` as the quality score. |
| Approve | Inserts Tracked as **`status='paused'`** (single + bulk). Scraping is an explicit, budget-gated action. |
| Bulk | Multi-select **Approve (paused)** + multi-select **Scrape now** (budget-gated). |

## 4. Architecture

### 4a. Classification — keyword pass + batched AI (`scraper.js`)
Keep the free keyword/pronoun pass in `_classifyGender` (returns `female` / `male` / `unknown`). **Replace the per-candidate AI fallback** with a single batched call:

`_classifyGenderBatch(items) → Map<username, 'female'|'male'|'unknown'>`, where each item is `{ username, bio, captionSnippet, taggedBy }`. One Haiku call returns a verdict per username (JSON/structured). Defensive: a missing/extra username, a parse failure, or **no API key** → those candidates stay `unknown` (graceful — they park, discovery continues; never throws).

The batched call is fed the **caption snippet** the candidate was mentioned in and **which tracked creator** surfaced them — strictly more signal than username-only. *(Honest caveat: without a real bio the verdict is still weak; that is acceptable precisely because unknowns park rather than pollute.)*

### 4b. Discovery sources — `discoverRelated` (`scraper.js`)
- Keep **Phase 1** caption `@mention` mining (DB, free) and **Phase 2** caption mentions + `taggedUsers`/`usertags` from the discovery Apify run.
- **Remove the hashtag-overlap block** (the "Shares hashtags" candidates).
- Carry per-candidate **context** for classification: the caption snippet of the mention + the tracked creator that surfaced them (`taggedBy`).
- After batch-classify, set `candidate.gender` and **drop `gender === 'male'`**. Female and unknown both flow downstream (unknown carries its flag).

### 4c. Aggregation + scoring — `runDiscovery` (`scheduler.js`)
Today candidates are de-duplicated across accounts by keeping the *first* occurrence ([scheduler.js:110](../../../server/scheduler.js)), which **discards collab strength**. Change to **aggregate by username**, counting the number of **distinct tracked creators** that surfaced each candidate → `collabStrength`, and keep the strongest provenance reason (`Collab'd with N of your creators`).

New score (per candidate):
- `relevancePts = min(collabStrength / 3, 1) * 50`  *(replaces source-type/hashtag relevance)*
- `erPts = min(avgEr / 6, 1) * 30`  *(unchanged)*
- `freqPts = min(postsPerWeek / 5, 1) * 20`  *(unchanged)*
- `suggestion_score = round(relevancePts + erPts + freqPts)` (0–100, quality only)
- `gender` stored alongside.

**Female-first tiering happens at read time**, not in the score: the suggestions query orders `CASE WHEN gender='female' THEN 0 ELSE 1 END, suggestion_score DESC`. This keeps `suggestion_score` interpretable as "quality" while guaranteeing every confident-female ranks above every unknown.

### 4d. Approve flow — paused + bulk (`index.js`)
- `POST /suggested/:username/approve`: insert `tracked_accounts` with **`status='paused'`** (was implicit `active`).
- `POST /suggested/approve-bulk` `{ usernames: [...] }`: approve + insert all as `paused` in one call; returns counts.
- `POST /tracked/scrape-bulk` `{ usernames: [...] }`: iterate `startScrapeJob` (already budget-gated + collision-guarded on the base branch); returns per-username `{ status | skipped | budgetBlocked }`; **stops cleanly on `BudgetExceededError`** with a partial result (same pattern as `runAutoScrape`).
- Single "Scrape now" reuses the existing `POST /tracked/:username/scrape`.

### 4e. Frontend — `SuggestedAccountsTab.js` + `api.js`
- **Gender badge** per card: `♀ Female` (green) / `Unclassified` (gray) from `s.gender`. Males never appear.
- **Default view** = confident-female, sorted by score; **unclassified collapsed** under a "Show N unclassified" expander at the bottom.
- **Multi-select:** per-card checkbox + "select all (visible female)"; sticky action bar with **"Approve N (paused)"** and **"Approve & Scrape N"**.
- **Provenance** shows collab strength (`Collab'd with N of your creators`).
- Header copy updated; the hashtag-chip emphasis removed (sources no longer include hashtags).

## 5. Data Model

`ALTER TABLE suggested_accounts ADD COLUMN gender TEXT DEFAULT 'unknown'` — added via the existing dual-mode `ALTER ... ADD COLUMN IF NOT EXISTS` migration list in `db.js` (Postgres) with the sqlite fallback already in place. No other schema change. `tracked_accounts.status` is reused with values `'paused'` (new approvals) and `'active'`.

## 6. Configuration (env)

No new **required** env. Reuses the `APIFY_*` budget vars so "Scrape now" respects the soft cap. `ANTHROPIC_API_KEY` improves classification (same key idea-gen needs); without it, keyword classification still runs and the rest park as unknown. Optional `DISCOVERY_UNKNOWN_PARKED` is not needed — parking is read-time behavior.

## 7. Observability

- `[Metric] discovery candidates=<n> female=<f> unknown=<u> male_dropped=<m> added=<a>` on each run.
- `[Metric] classify_batch n=<n> ms=<t>` on the batched call.
- Bulk approve / scrape-bulk log counts and any budget stop (one line, like `runAutoScrape`).

## 8. Error Handling

- No Anthropic key / classify failure → candidates stay `unknown` (park); discovery never throws.
- Bulk approve/scrape wrap each item; one failure does not abort the batch. A budget block stops `scrape-bulk` mid-batch and returns a clear partial result (`stoppedAt`, `message`), never a stack trace.

## 9. Testing (`node:test`, sqlite in-memory, matching existing `server/*.test.js`)

- **Keyword pass:** female/male/unknown incl. pronoun precedence over keyword.
- **`_classifyGenderBatch`:** parses per-username verdicts; tolerates missing/extra usernames; no key → all `unknown`, no throw.
- **Scoring/tiering:** a confident-female ranks above an unknown even when the unknown has higher ER; `collabStrength` boosts; male excluded; no hashtag-sourced candidates remain.
- **Aggregation:** the same candidate surfaced by two tracked creators → `collabStrength=2` and the merged provenance reason.
- **Approve:** single + bulk insert `tracked_accounts` with `status='paused'`; `ON CONFLICT` no-dup.
- **`scrape-bulk`:** a `BudgetExceededError` stops the batch mid-way and returns the partial result.

## 10. Risks & Verification

1. **Username-only classification is weak.** Mitigated by the ranked model (unknowns park, don't pollute the top). Verify the batch prompt on a real candidate sample before trusting it for auto-hide.
2. **Small tracked set → most `collabStrength=1`.** Still fine: female-confidence (tier) + ER + frequency drive ranking when overlap is thin.
3. **Back-catalog has only caption mentions** (tagged users aren't persisted yet). Phase-2 collab-capture improves recall; this spec ships without it.
4. **Stacking on cost-control.** This branch assumes PR #3's budget gate. If PR #3 changes in review, rebase before merge.

## 11. Summary of Changes

| File | Change |
|------|--------|
| `server/db.js` | `suggested_accounts.gender TEXT DEFAULT 'unknown'` (dual-mode migration). |
| `server/scraper.js` | Keyword pass kept; new `_classifyGenderBatch`; `discoverRelated` cuts hashtag source, carries caption/`taggedBy` context, drops male, sets `gender`. |
| `server/scheduler.js` | `runDiscovery` aggregates by username (collab strength), new gender-aware scoring, stores `gender`. |
| `server/index.js` | `approve` → `paused`; `POST /suggested/approve-bulk`; `POST /tracked/scrape-bulk` (budget-gated, partial result). |
| `client/src/pages/SuggestedAccountsTab.js`, `client/src/api.js` | Gender badge, female-first list + unclassified expander, multi-select bulk approve/scrape, collab provenance. |
| `server/*.test.js` | New tests per §9. |
