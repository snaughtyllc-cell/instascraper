# Look tags — design (short)

Date: 2026-11-15 · Status: approved by user · Builds on: auto-sort (PR #41), model workspaces (PR #43)

## Why

The agency niches each model down finely ("brunette talking", "emo vibe"). Content types alone can't express that, so a model's feed and suggestions aren't as close to her look as they could be. Look tags add soft signals (hair, aesthetic, setting) so the closest matches rank first.

## Goals

- Gemini returns look tags in the same call that sorts each reel.
- Creators get a look profile built from their reels' tags plus manual team tags.
- Each model gets look tags.
- Ranking (never filtering) of her feed, proposed creators and suggestions by look match.

## Non-goals and anti-goals

- **Not a filter.** Content type still decides what a model can get. Look tags only reorder.
- **No inferred ethnicity.** Gemini tags only visibly styled things (hair, makeup, fashion, aesthetic, setting). Ethnicity-type niche tags are manual team tags on creators only.
- No HQ sync yet. The model's look is set in InstaScraper for now; project 2 will map it from HQ "signature visuals".
- No extra Gemini calls for new reels.

## Approaches

One sensible way: add a `look_tags` field to the existing describe call (extra cost is a few output tokens per reel). A separate Gemini call (double cost) and thumbnail-only tagging (can't see vibe/motion) were rejected.

## Design

- **Vocabulary:** a new `look_tags` table (`value`, `label`, `category` ∈ `hair | aesthetic | setting | custom`, `sort_order`), editable in admin like content types.
  - Seed hair: blonde, brunette, black-hair, red-hair, dyed-hair.
  - Seed aesthetic: emo, alt, e-girl, girl-next-door, glam, gym, cottagecore.
  - Seed setting: bedroom, car, outdoors, studio.
  - `custom` tags are manual-only and never sent to Gemini.
- **Gemini:** the describe/redecide JSON schema gains `look_tags: string[]`, constrained to the non-custom vocabulary (max 5). The prompt asks only for visible styling and setting, and explicitly says never to infer ethnicity, age or body attributes. Stored as `posts.ai_look_tags` (JSON array text) and `suggested_reels.ai_look_tags`.
- **Creator look profile:** for each creator, the share of their sorted reels carrying each tag, plus manual tags from a new `creator_look_tags (username, tag)` table, which count as share 1.0. Shown next to the type mix on creator rows and in workspaces.
- **Model look:** `models.look_tags` (JSON array text), set via a chip picker in the model edit form and the workspace header.
- **Look match score** (0–1): for a reel, |model tags ∩ reel tags| ÷ |model tags|. For a creator or candidate, the mean of the creator's share for each model tag. A model with no look tags makes every score 0, so order is unchanged.
- **Ranking:**
  - Her feed (`buildMeFeedQuery` when not shuffled) orders by look match desc, then `posted_at` desc. When shuffled, it stays random.
  - Workspace proposals order by share desc, then look match desc.
  - Workspace suggestions order by fit desc, then look match desc, then `suggestion_score`.
  - Routing fit itself is unchanged.
- **Backfill:** a cockpit button "Tag existing reels" shows a count and estimated cost first (reels with `sort_status` auto/manual/needs_look and no `ai_look_tags`, ~$0.0012 each). It re-describes those reels' cached videos and writes only `ai_look_tags`, leaving types and statuses alone. It shares the daily cap and the sort lock.

## Learns from her reactions (added by user, same session)

The user wants the feed to self-learn per model: whatever she saves or rejects should shape what comes next, so she scrolls less to find things she likes. InstaScraper already records the signals (`model_saved_posts`, `model_post_feedback` with `want_to_make` / `not_my_style`) but nothing uses them for ranking.

- **Signals (my call):** saved (+1), want_to_make (+1) and not_my_style (−1), per model. Film saves will later land in the same tables through InstaScraper's API (project 3).
- **Features of a reel:** its content type (`type:<value>`), each look tag (`tag:<value>`) and its creator (`creator:<handle>`).
- **Affinity per feature:** (positives − negatives) ÷ (positives + negatives + 2). This smooths toward 0 and ranges −1 to 1. Stored in `model_taste (model_id, feature, affinity, positives, negatives, updated_at)` and recomputed for a model whenever she reacts, plus a nightly full recompute.
- **Taste score** of a reel = sum of the affinities of its features that have a row.
- **Ranking:**
  - Feed order (not shuffled): look match + taste score, then `posted_at`.
  - Workspace suggestions and proposals also add the creator-level taste (`creator:` affinity + the candidate's tag affinities weighted by their share).
  - **Shuffle stays random**, as the "show me something different" path, so she isn't locked into one style.
- **Cold start:** with no reactions, taste is 0 and ordering is look match, then recency.
- **Still never filters:** disliked styles sink but stay reachable. Only the exact reel she marked "not my style" is hidden, as today.
- Admin sees her learned taste in her workspace: top liked and disliked types, tags and creators.

## Later: tracking (noted, not in scope)

Measuring what she actually posted and how it performed belongs in HQ's analytics, not InstaScraper. Once tracking exists, performance becomes a stronger signal than saves. Noted for a future project.

## Left to the builder

Column formats, the exact chip UI, the match-score SQL vs JS split (JS is fine for proposals and suggestions; the feed needs it in SQL or a bounded pre-sort), and the prompt wording within the rules above.
