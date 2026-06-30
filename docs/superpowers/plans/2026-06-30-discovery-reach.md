# Discovery Reach (Sub-C, Thrust 3) Implementation Plan

> **For agentic workers:** TDD, DRY/YAGNI, frequent commits. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Widen weekly discovery from a fixed first-5 to a rotating coverage of all active accounts, enrich each unique candidate at most once per cycle (global deduped pass), and accumulate collab strength/score across cycles — all within the existing budget gate and at ≤ today's per-cycle Apify cost.

**Architecture:** A pure, exported `selectDiscoverySources` helper in `scheduler.js` (rotation by `last_discovery_at`, unit-tested). `discoverRelated(username, {enrich})` gains a harvest-only mode; its per-source enrichment becomes a reusable `enrichCandidates(list, max)` so `runDiscovery` can run one global pass. `runDiscovery` becomes: select sources → harvest (no enrich) → aggregate → enrich top-N once → gender-classify once → score + accumulate-upsert. New `tracked_accounts.last_discovery_at` column.

**Tech Stack:** Node/Express, dual-mode DB (`pg` prod / `better-sqlite3` dev+test), `node-cron`, `node:test`.

## Global Constraints

- **Test runner:** `node --test` from `server/` (`npm test`). Pure helpers exported from `server/scheduler.js`.
- Config defaults (verbatim): `DISCOVERY_MAX_SOURCES=5`, `DISCOVERY_ENRICH_MAX=8`.
- Backward compatibility: `discoverRelated`'s default (`enrich: true`) must reproduce today's behavior exactly (existing callers/tests untouched).
- Accumulation upsert must not demote or resurrect reviewed suggestions.
- No change to budget gate, auto-scrape, rollup, cleanup, idea-gen.

---

### Task 1: DB column + pure source-selection helper + tests
- [ ] `db.js`: add `last_discovery_at` to both migration arrays (IF-NOT-EXISTS prod twin + plain sqlite twin), mirroring `last_attempt_at`.
- [ ] `scheduler.js`: add `selectDiscoverySources(accounts, max)` (NULL/never first, then `last_discovery_at` asc, tie-break username asc, slice max); export it.
- [ ] `discovery-reach.test.js`: cover ordering, NULL-first, cap, tie-break, empty.

### Task 2: harvest mode + reusable enrichment in scraper.js
- [ ] `discoverRelated(username, opts = {})`: destructure `enrich = true`; when false, `return candidates` right after Phase-2 (before the enrichment block); keep the `enrich:true` path identical.
- [ ] Extract the existing per-candidate enrichment block into `enrichCandidates(candidates, max)` (DB-first for all; `_fetchProfileQuick` for ≤ max lacking DB data; followers ≤ 500k filter stays in caller). Keep `enrich:true` path calling it so behavior is unchanged.

### Task 3: runDiscovery rewrite + accumulation upsert
- [ ] Add `discoveryConfig(env)` (or inline reads) for the two env knobs.
- [ ] Rewrite `runDiscovery`: select sources via helper; harvest each with `{enrich:false}`; stamp `last_discovery_at` best-effort per source; aggregate; `enrichCandidates(sorted, DISCOVERY_ENRICH_MAX)`; gender-classify once + drop males; score + upsert with `ON CONFLICT (username) DO UPDATE` accumulating source/score (MAX, only where `status NOT IN ('approved','dismissed','snoozed')` or equivalent guard); retain `slice(0,50)`; new metric line.
- [ ] Test accumulation SQL semantics on a sqlite fixture.

### Task 4: verify + commit
- [ ] `npm test` green (existing 85 + new).
- [ ] Commit spec, plan, and code.
