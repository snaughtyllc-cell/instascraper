# Notion-Driven Model Onboarding — Design

**Date:** 2026-07-09
**Branch:** `feat/notion-onboarding` (off `main`)

## Problem

Onboarding a model into InstaScraper is manual on both ends: an admin creates the
model row, hand-types the niche, *and* sets up the login. Meanwhile the model's
real brand definition already lives in Notion — the **Creator Personas** database
(persona statement, comfort ceiling, content topics, formats, brand don'ts),
which the agency fills out during onboarding (SOP-driven, human-reviewed).

Goal: make onboarding one step. The admin picks an **Approved** persona from
Notion; InstaScraper reads it, proposes the model's niche(s), builds an AI
"character context," and — after the admin confirms and adds email/password — the
model logs into a feed that is **already curated and not empty**.

This also creates the backbone for later work (persona-aware idea cards now;
persona-driven feed re-ranking and a model-health dashboard as separate specs).

## Decisions locked (from the user)

- **Source of truth:** the **Creator Personas** DB (`collection://f4e78f05-903e-4d95-bee0-6781e3172345`), *not* the 📇 Character Sheets DB. The persona is what exists at onboarding time; the Character Sheet is populated downstream.
- **Import gate:** only personas with `Persona Status = Approved` are eligible. No curating off a draft/rejected persona.
- **Niche mapping:** the Persona DB has **no niche field** — so InstaScraper **derives** niche(s) from the persona via Claude, ranked against InstaScraper's existing niche set, and the **admin confirms/edits** before commit ("auto-map, you confirm").
- **Character context:** InstaScraper **generates its own** ≤30-line context block from the persona (existing `ANTHROPIC_API_KEY`), rather than copying the Character Sheet's `Claude Context Block`.
- **Sync trigger:** pull **on onboard** + a manual **"Re-sync from Notion"** button. No automatic nightly job. Re-sync is always confirm-first — never silently overwrites an admin-tuned niche.
- **Day-one seeding:** after import, **seed only if the mapped niche is thin** — auto-add a Reel Radar term + queue one scrape, through the existing budget guard. Stocked niche → do nothing.
- **Credentials stay manual:** admin adds email/password. InstaScraper is **read-only** on Notion (no write-back of niche/status).
- **Match key:** persona `Model Name` ↔ `models.name`.

## Source data — Creator Personas DB

Fields we read (properties, one API call per persona):

| Notion property | Type | Use |
|---|---|---|
| `Model Name` | title | match key → `models.name` |
| `Persona Statement` | text | primary input to niche derivation + context generation |
| `Comfort Ceiling` | select (`Implied only`…`Explicit`) | brand-safety signal stored on the model |
| `Auto-Draft Tensions` | text | nuance/contradictions fed to the context generator |
| `Persona Status` | select | import gate (`Approved` only) |
| `Status` | select (`Active`/`Paused`/`Onboarding`/`Offboarded`) | → `models.status` on import + re-sync |

The persona's rich **page body** (trait matrix, Content Topic Seed List, formats,
brand don'ts) is *not* read in v1 — see "Out of scope." The `Persona Statement`
one-liner is dense, and the admin confirm-step covers any roughness in the
derived niche.

## Approach

One new isolated module (`server/notion-sync.js`) plus a thin admin flow. Nothing
else in the app depends on Notion. All shaping/mapping logic is pure functions,
unit-tested with fixture persona payloads; the two I/O boundaries (Notion fetch,
Claude derivation) are mockable.

Flow:

```
Admin opens "Import from Notion"
  → GET /notion/personas            (list Approved personas)
  → admin picks one
  → POST /notion/personas/:id/preview   (derive niches + context; NO write)
  → admin confirms/edits niches, enters email + password
  → POST /notion/personas/:id/import    (write model, stamp notion_page_id, seed if thin)
  → model can log in to a curated feed
Later:
  → POST /models/:id/resync-notion      (re-pull, show diff, admin confirms)
```

## Components

### 1. Connection (one-time setup)
A Notion **internal integration** token, with the Creator Personas DB shared to
it. Two Railway env vars:

| Env | Meaning |
|---|---|
| `NOTION_API_KEY` | integration secret |
| `NOTION_PERSONAS_DB_ID` | the Creator Personas database id |

If either is unset, the feature is **disabled gracefully** — endpoints return a
clear "Notion not configured" and the admin UI hides the import controls (same
env-gated pattern as Sentry / the Apify budget). Read via the official
`@notionhq/client` SDK (robust pagination + typed errors) — one new server
dependency.

### 2. `server/notion-sync.js` (new)
- `notionConfig(env)` — env-tunable (see table below); returns `{ enabled }` false when creds absent.
- `fetchApprovedPersonas(client, cfg)` — queries the personas DB filtered to `Persona Status = Approved`; returns normalized rows `{ pageId, name, personaStatement, comfortCeiling, tensions, status }`. I/O boundary.
- `normalizePersona(page)` — **pure**: Notion API page object → the normalized row above. Unit-tested with a fixture page payload. Tolerates missing/empty properties (returns nulls, never throws).
- `deriveProfile(persona, niches, claude)` — sends persona text + comfort ceiling + tensions to Claude with the **current InstaScraper niche list**; returns `{ proposedPrimary, proposedSecondary[], characterContext }`. The comfort ceiling and brand don'ts are folded **into** `characterContext` (which the idea agent reads) — no separate safety field/column in v1. I/O boundary (mock Claude in tests).
- `rankNiches(aiNiches, availableNiches)` — **pure**: reconcile Claude's suggestions against the real niche set — the `content_type` taxonomy the feed is scoped by (exact + case/alias match) — returns ranked valid niches + any unmatched (surfaced to the admin as "no InstaScraper niche yet"). Unit-tested.
- `buildModelPatch(persona, confirmed)` — **pure**: assemble the `models` row/update from persona + admin-confirmed niches. Unit-tested.

### 3. Data model (`models` table — idempotent, dual-mode migrations)
Add columns (SQLite `ADD COLUMN` list + PG `ADD COLUMN IF NOT EXISTS`, matching the existing pattern in `db.js`):

| Column | Purpose |
|---|---|
| `notion_page_id TEXT` | links model ↔ persona for re-sync; unique when non-empty |
| `character_context TEXT` | the AI persona summary — consumed by the idea agent |
| `persona_statement TEXT` | raw one-liner, for admin reference |
| `comfort_ceiling TEXT` | brand-safety signal |

Existing `name` / `primary_niche` / `secondary_niches` / `status` are populated by
the import. `primary_niche` is `NOT NULL`, so import requires at least one
confirmed niche before commit.

### 4. Routes (`server/index.js`, behind `requireAdmin`)
- `GET /notion/personas` — list Approved personas (name, pageId, status, whether already linked to a model). Returns `{ enabled:false }` when creds absent.
- `POST /notion/personas/:pageId/preview` — derive and return `{ proposedPrimary, proposedSecondary, characterContext, comfortCeiling, unmatchedNiches }`. **No DB write.**
- `POST /notion/personas/:pageId/import` — body: confirmed niches + `email` + `password`. Creates the model (reusing the existing model-create + credential path), stamps `notion_page_id`, then runs day-one seeding (§6). Rejects if a model with that `notion_page_id` or `name` already exists (offer re-sync instead).
- `POST /models/:id/resync-notion` — re-pull the linked persona, return a **diff** (niche/status/context changed?) for the admin to confirm; on confirm, apply. Syncs `Status` (`Offboarded` → set `models.status` inactive / disable app access). Never overwrites a hand-tuned niche without the confirm step.

### 5. Idea-agent payoff (small, high-value)
`server/ai-agent.js` currently prompts from the niche tag only. Inject
`character_context` into the `generateIdeasForModel` prompt when present. This is
the immediate reason to sync the persona — idea cards become persona-aware with a
one-field change. (Full persona-driven **feed** re-ranking is deferred — separate
spec.)

### 6. Day-one seeding (B)
After a successful import, in `notion-sync` (or a small `seeding.js` helper):
- Count **fresh** reels in the confirmed `primary_niche` (cached + within the freshness window).
- If below `NOTION_SEED_MIN_REELS` → add a Reel Radar `watch_term` derived from the niche + fire **one** `runRadar`/scrape, **through the existing `BudgetExceededError` guard**. Over budget → skip, keep the model, return a clear "couldn't seed — Apify budget" message the UI shows.
- At/above threshold → do nothing (the shared cached pool already fills the feed).

Reuses `server/radar.js` + the existing scrape/budget infrastructure; adds no new scraping path.

### 7. Config (`notionConfig`, env-tunable)
| Field | Env | Default |
|---|---|---|
| `enabled` | derived from creds | — |
| `personasDbId` | `NOTION_PERSONAS_DB_ID` | — |
| `apiKey` | `NOTION_API_KEY` | — |
| `seedMinReels` | `NOTION_SEED_MIN_REELS` | 15 |
| `importGate` | `NOTION_IMPORT_GATE` | `Approved` |

## Testing (TDD, `node --test`)
- **`normalizePersona`** (pure): fixture Notion page → normalized row; missing properties → nulls, no throw.
- **`rankNiches`** (pure): AI niches reconciled against the real set — exact/case/alias match, unmatched surfaced.
- **`buildModelPatch`** (pure): persona + confirmed niches → correct `models` patch; primary-niche-required enforced.
- **`notionConfig`**: creds present → enabled; missing → disabled (mirrors existing config tests).
- **Endpoint tests** with a **mocked Notion client + mocked Claude**: `preview` returns a proposal and writes nothing; `import` creates the model + stamps `notion_page_id`; duplicate import rejected; `resync` produces a diff and applies on confirm.
- **Seeding**: below-threshold → term added + scrape attempted; over budget → skipped with message; at/above threshold → no-op. (Budget + scrape mocked.)
- **Migration contract**: dual-mode `models` new-column round-trip (inline sqlite, mirrors existing db-contract tests).

## Setup / prerequisite (one-time, manual)
1. Create a Notion internal integration → copy the secret.
2. Share **only** the Creator Personas DB with the integration.
3. Set `NOTION_API_KEY` + `NOTION_PERSONAS_DB_ID` on Railway.
Exact click-by-click steps provided at build time.

## Out of scope (YAGNI / deferred)
- **Reading the persona page body** (trait matrix, topic list, formats). v1 uses persona properties; body enrichment is a fast-follow only if derived niches prove too rough.
- **Character Sheets DB** integration (Suggested Niches / Claude Context Block) — the persona is the chosen source.
- **Automatic nightly sync** — manual re-sync only in v1.
- **Write-back to Notion** — read-only, one direction.
- **C — model-health dashboard** (next spec), **D — persona-driven feed re-ranking**, **E — taste feedback loop**. All build on this backbone.
