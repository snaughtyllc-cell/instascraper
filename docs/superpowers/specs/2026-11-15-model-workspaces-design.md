# Model workspaces — design

Date: 2026-11-15 · Status: draft, awaiting approval (builder check done) · Builds on: `2026-11-15-auto-sort-reels-design.md` (shipped, PR #41)

## Why

Today a model's feed is every sorted reel in her niches, from any creator, and tracked creators and suggestions are one shared list. Nobody can say exactly what a given model is getting or why, and a VA reviewing suggestions has to guess which model each one fits. The user wants each model to have her own workspace, the way each model has her own project in HQ (the agency's internal workspace app). A VA can then open one model, see exactly what she gets, and add creators for her.

## Goals

- A **workspace per model** showing her creators, her reels (exactly what her app shows), and AI-picked suggestions for her.
- **Model ↔ creator ownership:** a model's feed only draws from creators added for her. The same creator can be added to several models.
- **AI-routed suggestions:** each suggested creator appears in the workspaces of the models it fits, ranked for that model, with the reason ("found via @x, Logan's creator").
- Keep today's **overall view** for seeing everything at once.

## Non-goals

- Per-VA logins or permissions. VAs keep the team password and can open any workspace.
- A separate Apify search per model (approach B, rejected below).
- Per-model Reel Radar keywords. Radar stays global; its finds go through the same routing.
- Any change to how the model app looks.

## Anti-goals

- A model **with creators** getting reels from a creator nobody added for her. (A model with zero creators falls back to niche-only, by user decision.)
- Doubling Apify spend. A creator shared by several models is scraped once.
- A VA's dismissal in one workspace hiding the suggestion from other models.

## Approaches considered

**Ownership (user picked "per-model ownership"):**
- **Per-model ownership — chosen.** A model's feed = reels from her creators that are sorted into her niches. Clear and auditable. A model with no creators yet falls back to today's niche-only feed (user decision), so neither launch nor a new model shows an empty feed.
- **Niche-only, like today.** The workspace just filters the shared pool. Rejected: a VA's choices for one model leak to every model with that niche.

**Suggestions (user picked A):**
- **A. One shared discovery run, routed per model — chosen.** Discovery runs once over all creators as it does now. Each new candidate's top reels are sorted by Gemini, and the candidate is shown to every model whose niches match, ranked highest for the model whose creator led to it. One Apify run; Gemini adds about $0.004 per candidate (3 reels).
- **B. A discovery run per model.** More tailored, but Apify cost grows with each model on a $25/30d budget. Rejected.

## Design

### Ownership

- New table `model_creators (model_id, username, added_at, source)`, primary key `(model_id, username)`. `source` is `'va'`, `'suggestion'` or `'proposal'`.
- **Feed rule.** A model sees a reel when (a) its sorted type (`effectiveNicheExpr`) is in her niches **and** the reel's `account_handle` is one of her creators. Or (b) the reel is assigned to her (`model_assigned_posts`). Or (c) she already saved it or gave feedback on it (the existing exception).
- **Fallback (user decision):** a model with **zero** `model_creators` rows uses today's niche-only rule (any creator's reel sorted into her niches). As soon as she has one creator, the strict rule applies. This covers launch, before proposals are confirmed, and newly added models. Her workspace shows a banner: "No creators yet — showing every reel in her niches."
- Apply the rule on every model-facing path that already uses `effectiveNicheExpr`: `/me/feed` (me-feed.js), `modelCanAccessPost` (model-access.js), `/me/saves`, `/me/audio/*` (audio.js), the idea agent's source reels (ai-agent.js, which needs a model id), and Notion fresh-reel counts (notion-sync.js, per model).
- Scraping stays per creator and shared. Nothing is scraped twice.
- **Removing** a creator from a model removes her reels from that model's feed only. **My call:** pausing happens only when a VA removes a creator's *last* model; that creator goes to **Unassigned** and is set to `paused` so the app stops paying to scrape them. Never-assigned creators (all 52 at ship) keep their current status, so scraping, discovery and creator mixes keep working while proposals are confirmed. The Unassigned list has Pause / Remove buttons. Adding a creator to a model sets them `active`.

### Moving the current 52 creators in

- At ship time no model has creators, so every model is on the fallback until proposals are confirmed. The app proposes owners. For each tracked creator, compute their mix from sorted reels (what the creator page already shows). Propose every model whose niches cover **at least 30% of that creator's sorted reels** (env `WORKSPACE_PROPOSE_MIN_SHARE=0.3`, my call).
- Each workspace has a **Proposed creators** list ("@kay.moves — 80% Dance") with Confirm / Reject per creator and **Confirm all**. Only confirmed proposals count for the feed.
- Creators with no proposal and no model appear under **Unassigned** in the overall Tracked view.
- **Proposals are ongoing, not one-off (my call):** a weekly job (and one at deploy) recomputes proposals for every tracked creator against every model, including creators already owned by other models, so a creator owned by Logan can still be proposed to Gigi. It costs nothing (it uses already-sorted reels) and never re-proposes a pair a VA rejected.

### Suggestions routed per model

- After discovery captures a candidate's top reels (`captureTopReels` → `suggested_reels`), download up to 3 of those videos to a temp file **right away** (Instagram links expire within hours). Sort each with the existing Gemini describe step (`describeReel`), store `ai_type` / `ai_confidence` on the `suggested_reels` row, then delete the temp file. Reel Radar candidates (radar.js) get the same treatment.
- **Fit per model (my call)** = (candidate reels whose `ai_type` is in her niches **and** confidence ≥ `AUTO_SORT_MIN_CONFIDENCE`) ÷ (candidate reels that sorted without error). Computed only when at least 2 reels sorted; otherwise no model rows. **Boost:** +0.25 (capped at 1) when the candidate was found via one of that model's creators (`suggested_accounts.source` tokens).
- New table `model_suggestions (model_id, username, fit, reason, status, snoozed_until, reviewed_at, created_at)`, primary key `(model_id, username)`, with status `pending | approved | dismissed`. A row is created for each model with `fit ≥ SUGGEST_MIN_FIT` (env, default 0.34, i.e. at least 1 of 3 reels). The reason is e.g. "2 of 3 reels Talking · found via @mia.talks (Logan's creator)".
- **Status of record (my call):** per-model status lives in `model_suggestions`. `suggested_accounts.status` becomes `approved` once any model approves; that candidate stays pending (and approvable as an extra owner) in other models' workspaces until each decides. The overall Suggested view shows per-model chips (pending / approved / dismissed). The old global **Approve** buttons (single and bulk) open a model picker, pre-checked with the routed models, instead of adding an ownerless paused creator.
- **Approve in a workspace:** add a `model_creators` row (source `'suggestion'`) and make sure the creator is tracked and `active`. **My call: active, not paused like today's global approve**, because the VA's approval is the point and the cadence plus the Apify budget cap already limit spend. Dismiss and snooze are per model only.
- A candidate whose reels couldn't be sorted (expired link, Gemini error) gets no model rows and stays visible in the overall Suggested view only. **Existing pending suggestions at ship** have expired reel links, so they stay overall-only. No Apify backfill (my call); the global Approve model picker still lets a VA assign them.
- **Notion seeding (my call):** `seedNicheIfThin` keeps counting fresh reels per niche across the whole library, so importing a model doesn't trigger a Radar run by itself. Only the displayed count is per model.
- Gemini spend for candidate reels is logged like reel sorting and counts toward the same daily cap (`AUTO_SORT_DAILY_MAX`) and the cockpit spend card.

### Screens

- **Models tab → click a model → her workspace**, with three sections:
  - **Creators:** her list (handle, mix, last scraped, a remove button), an "Add creator" box by username, and the Proposed list.
  - **Reels:** exactly what her app shows (same query), newest first, with type and confidence.
  - **Suggested:** her pending suggestions ranked by fit then `suggestion_score`, with reason, top reels (thumbnails / Instagram links as in today's Suggested tab), and Approve / Dismiss / Snooze.
- **Overall view stays.** The Suggested tab shows model chips on each suggestion (which models it was routed to), the Tracked tab shows which models own each creator plus an **Unassigned** filter, and the cockpit is unchanged.

```
Models ▸ Logan                                   talking + skit, osc
┌ Creators (12) ┬ Reels (184) ┬ Suggested (7) ┐
  @mia.talks     Talking 70% · Skit 30%   ✕
  Proposed: @kay.moves  OSC 60%   [Confirm] [Reject]   [Confirm all]
```

## Cost

No extra Apify: candidate reels are already captured. Gemini adds about $0.004 per new candidate. At the current ~50 new candidates/week, that's about $0.20/week.

## Left to the builder

Table and column names beyond those above, file layout, how the temp download reuses `server/videos.js` helpers, exact UI layout within the sketch, and whether the workspace is a route or a panel inside the Models tab. Follow the repo's patterns: `node:test`, the sqlite test adapter (ascending placeholders), env-tunable knobs, and the dual Postgres/sqlite `db.js`.
