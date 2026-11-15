# Auto-sort reels — design

Date: 2026-11-15 · Status: draft, awaiting approval

## Why

The team stopped using InstaScraper because sorting is a manual chore. Every scrape pulls ~50 reels per creator, and someone has to watch each one to set its content type (Talking, Dance, Skit, …). Labelling a whole creator doesn't work: most creators mix content (a "talking" creator also posts dance and lifestyle). The more creators you add, the worse it gets.

The goal is to **open the model app to the models again**, with each model's feed showing only reels that really match their niche — without a human watching every reel.

## Goals

- Every reel gets its own content type automatically, from something that actually looks at the video.
- Confident reels go live in the model feed with no human step.
- Unsure reels, and reels that fit no current type, land in one short **Needs a look** pile, hidden from models until someone decides.
- The AI proposes new types when it keeps seeing something that doesn't fit (e.g. "Lifestyle"); the admin approves a new type once.
- A creator's page shows their mix ("Talking 70% · Dance 20% · Lifestyle 10%"), computed from their reels.
- Remove the Recreate / Reference / Skip tag.

## Non-goals

- **Suggested accounts stay manual.** The user likes reviewing who comes in before they're added. No change to discovery or approve/dismiss.
- No Jev in v1 (see "Jev later" — the design leaves a slot for it).
- No processing on the user's Mac. The app runs on Railway; sorting must work when the Mac is off.
- No change to how models pick their niches or how the model app looks.

## Anti-goals (failure even if it "works")

- Wrong reels in a model's feed. When in doubt, hide the reel and put it in the pile; never guess it into a feed.
- A pile so big that reviewing it is the same chore as before.
- Surprise AI spend.

## Approaches considered

- **A. Gemini alone — chosen.** Gemini (cheapest tier) watches the cached video plus caption and returns type, confidence, a one-line description, and a suggested new type when nothing fits. One step, one new service, fractions of a cent per reel. The stored description lets reels be re-sorted later without re-watching.
- **B. Gemini describes, Jev decides.** Cheaper decisions and probably sharper probabilities, but adds a second, early-access, independently unbenchmarked service. Deferred, not rejected: the design keeps a slot for it.
- **C. Thumbnail + caption with Claude Haiku (existing key).** Cheapest to wire up, but one still frame often can't tell talking from dancing, so more reels land in the pile. Rejected.
- **Local on the Mac.** Rejected — sorting would stop whenever the computer is off.

The user picked A.

## Design

### What gets sorted, and when

- **Only reels with a cached video** (`posts.video_cache_status = 'cached'`). The model feed already shows only cached reels (`PLAYABLE_CLAUSE` in `server/me-feed.js`), so these are exactly the reels a model could ever see, and the cached mp4 on the volume is what Gemini watches. No thumbnail fallback.
- **Trigger:** after the video sweep caches new files (the post-scrape sweep in `server/scraper.js` and the `*/30` catch-up `runVideoSweep` in `server/scheduler.js`), classify newly cached, never-classified reels. Plus a catch-up cron so nothing is missed if a run fails.
- **Backfill:** a one-time admin action to classify all existing cached reels. Before running, it shows how many reels and the estimated cost; the admin confirms.
- Per-run batch limit and a daily cap (env-tunable), so a big scrape or backfill can't run away on cost.

### The Gemini call

Input: the cached mp4, the caption, the creator handle, and the current list of content types (value + label, read from the `content_types` table at call time so new types are picked up automatically).

Structured output:

- `type` — one of the current type values, or null if nothing fits
- `confidence` — 0 to 1
- `description` — one short line on what happens in the reel
- `suggested_type` — a short label for a new type, only when `type` is null or a poor fit

Key: `GEMINI_API_KEY` on the Railway `instascraper` service. Model name from `GEMINI_MODEL`.

**Run it as cheaply as possible (user decision).** These are competitor reels that only need putting in the right bucket, not a full analysis. Use:

- **Gemini 3.5 Flash-Lite** as the default `GEMINI_MODEL` (user decision, ~$18/month at 500 reels/day)
- low media resolution and a low frame-sampling rate for the video
- a tiny output: the four fields above and nothing more (no reasoning or extended thinking, short description)

If accuracy on real reels turns out too low, step up a tier via `GEMINI_MODEL`, with no code change.

**Estimated cost** (Nov 2026 list prices; verify on ai.google.dev before launch). A ~30s reel at low resolution is about 2,000 video tokens, plus ~1,000 audio tokens, ~400 prompt tokens and ~80 output tokens.

- Gemini 2.5 Flash-Lite ($0.10/M input, $0.50/M audio, $0.40/M output): about $0.0003 per reel without audio and $0.0008 with audio.
- Gemini 3.5 Flash-Lite ($0.30/M input, $2.50/M output): about $0.0012 per reel.
- At 500 reels/day, that's about $5–18 a month, depending on model and audio. A backfill costs roughly $0.30–1.20 per 1,000 reels.

Audio (resolved in planning): no toggle in v1. Removing the audio needs ffmpeg, which the Docker image doesn't have, so the video is sent as-is. Gemini 3.5 Flash-Lite bills all input at one rate, so the ~$0.0012/reel estimate already includes audio, and hearing speech vs. music helps tell talking from dance.

### The decision rule

- `type` is a current type **and** `confidence ≥ AUTO_SORT_MIN_CONFIDENCE` (env; default 0.8) → set `posts.content_type`, status `auto`. The reel is live in matching models' feeds.
- Anything else → status `needs_look`; `posts.content_type` stays empty, so the reel is hidden from models.
- Errors (Gemini down, file missing) → recorded on the reel and retried on a later run; never shown to models.

The "describe" step (Gemini) and the "decide" step (the rule above) are separate functions, so Jev can replace "decide" later without re-watching videos.

### Humans always win

- Any content type set by a person marks the reel `manual`. The classifier never overwrites a manual reel.
- New `posts` columns (names are the builder's call): AI type, confidence, description, suggested type, model used, classified-at, last error, and a sort status of `unsorted | auto | needs_look | manual`.

### Model feed visibility

- Models see a reel only if **that reel** has a content type. The creator-level fallback (`COALESCE(posts.content_type, ct.content_type)` in `nicheVisibilityClause`) is removed from the model feed; otherwise unsorted reels would leak in through a creator label.
- Cutover: models' feeds will be empty between Start fresh and the first sorted reels from the refill scrape.
- **Every model-facing path follows the same rule (my call):** `/me/feed`, `modelCanAccessPost` (feedback + saves), `/me/saves`, `/me/audio/*` (server/audio.js), the idea agent's source-reel selection (server/ai-agent.js) and notion-sync. Exception: a reel a model has already saved or given feedback on stays reachable for that model, so nothing they bookmarked disappears.

### Start fresh (user decision, replaces re-checking existing labels)

The existing library doesn't play reliably anymore, so it is scratched rather than re-checked. A **Start fresh** admin action soft-deletes every current reel (each logged in the Delete Log, so it can be restored), keeps tracked creators, and the next scrapes refill the library through the new sort. Existing reels start `unsorted` and are hidden from models; there is no `legacy` status.

### Old-reel cleanup (user decision)

The nightly cleanup (server/scheduler.js ~203) currently spares only reels with a `tag`. New rule: reels with a content type (`auto` or `manual`) are never cleaned up. Unsorted, needs-look and archived reels follow the existing 30-day rule.

### Export (my call)

`/export` currently exports only `tag = recreate`. Change it to filter by content type.

### The Needs a look pile (admin)

A new admin view (its own tab, or a Library filter — builder's call). For each reel:

- the video, the AI's best guess and confidence, and its one-line description
- one tap to pick the right type (marks it `manual`)
- **Not useful** → archive (hidden everywhere)

Suggested new types are grouped at the top: "**Lifestyle** — 14 reels · *Create type & assign all*". One click creates the content type and assigns those reels. A model whose niches include the new type then sees them.

When a new type is created, reels still in the pile are automatically re-decided against the updated list using their stored descriptions (text only, no re-watching).

### Creator mix

- The creator / tracked-account view shows each creator's mix as percentages, computed from their reels' content types.
- The manual "set creator type" control goes away. The `creator_types` table stays in the database but no longer drives the model feed.

### Remove Recreate / Reference / Skip

- Remove it from the UI: `ContentCard`, `FilterBar`, `BulkActionBar`, `LibraryTab`, `ScrapeTab`, `TrackedAccountsTab`, and `client/src/api.js`.
- Remove `POST /content/:id/tag`, the `tag` filters on `GET /content`, and the bulk tag action.
- Keep the `posts.tag` column; no data is dropped.

### Cost visibility

- Log each classification with an estimated cost. Show the running 30-day spend next to the existing Apify usage (`/admin/apify-usage` or a sibling endpoint).

## Jev later

The Jev API key is on the user's computer but not on Railway. Follow-up, after v1 is live: add the key to Railway and swap Jev in as the "decide" step, using the stored Gemini descriptions. No re-watching needed.

## Setup the user must do

- Add `GEMINI_API_KEY` to the Railway `instascraper` service (Google AI Studio key).

## Left to the builder

Column names, file layout, batch sizes and cron timing, the exact default for the confidence threshold after looking at real results, whether the pile is a tab or a filter, and the prompt wording. Follow the repo's existing patterns: `node:test` tests, the sqlite test adapter, env-tunable knobs, and the dual Postgres/sqlite `server/db.js`.

Note: `server/db.js` has uncommitted local changes on `main` that predate this work. Check them before building on that file.
