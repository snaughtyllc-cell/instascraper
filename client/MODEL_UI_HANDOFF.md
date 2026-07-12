# Model Portal UI Handoff

Last updated: 2026-07-12

## Current status

The model-facing portal is implemented, deployed, and ready for real-model phone testing. It is intentionally separate from the admin experience and is designed as a mobile-first creator workflow, not a smaller version of the admin dashboard.

- Live app: https://instascraper-production-7281.up.railway.app
- Production branch: `main`
- Latest redesign commit: `9e4de6e` (`Redesign model creator experience`)
- Latest hardening commit: `87d13d9` (`Harden model portal before pilot`)
- Health checks verified: `/live` is live and `/ready` reports the database is up.

## Pre-pilot hardening completed on 2026-07-12

The codebase received a full model-portal audit before the first real-model test. The changes are intentionally defensive and preserve the frozen four-tab UI and Save/X interaction model.

### Authentication and production safety

- Production sessions use PostgreSQL instead of Express MemoryStore, with a rolling seven-day, secure, HTTP-only, same-site cookie.
- Login regenerates the session identifier. Disabling, deleting, or changing a model account revokes its PostgreSQL sessions.
- Every model API, thumbnail, and video request rechecks that the model still exists, is active, and has login enabled.
- Missing or expired sessions return `401`; actually disabled/wrong-role accounts return `403`, so the login screen can show the correct message.
- Production CORS is same-origin by default with optional `CORS_ORIGINS`; security headers are set and the Express signature is disabled.
- The login throttle has a hard memory bound, and production refuses to boot without PostgreSQL, with weak auth/session secrets, or with an unwritable media volume.

### Model data and workflow integrity

- Model endpoints return an explicit creator-safe post DTO. Admin notes, tags, scrape queries, raw signed media URLs, and cache errors are not exposed.
- Save, unsave, and X are database transactions. Save and `want_to_make` cannot drift apart; X removes any save and records `not_my_style` atomically.
- Discovery excludes that model's assigned, saved, and not-interested reels. Assignments only contain playable cached reels and no longer duplicate discovery results.
- Feed pagination fetches one look-ahead row without skipping records between pages.
- Audio and idea examples must have cached playable video. Audio counts and examples remain scoped to the model's niches.
- Model creation now requires a valid email and an eight-character-or-longer password before login can be enabled.
- Idea delivery updates are scoped to both model and batch, and scheduler delivery totals count only successful sends.

### Model experience reliability

- The client uses same-origin API requests in production, a 20-second model-API timeout, and useful retry/error states instead of presenting failures as empty content.
- Tabs keep their rendered content and exact scroll positions while revalidating when re-opened.
- The first-tap video path no longer interrupts its own play request. Only one preview plays at a time, and hidden/offscreen media pauses.
- Feed requests are sequenced to prevent stale responses winning a niche/refresh race. Save and X lock while pending and roll back cleanly on failure.
- Niche chips are limited to the signed-in model's allowed niches. Refresh resets to page one, reshuffles results, and returns to the top.
- Login fields now have labels, autocomplete metadata, password visibility control, mobile-friendly focus behavior, and clearer connection/session messages.
- Sentry Replay masks all text and inputs and blocks media; model API and playback reports contain IDs/statuses rather than creator content.

## Frozen product decisions

- Use a light, editorial creator UI with an off-white canvas, dark ink, coral, sage, butter, and mist accents.
- Keep the four bottom tabs: Feed, Audio, Saved, and Ideas.
- The primary reel decisions are Save and X (not interested).
- Do not restore the old Want / Hard / Pass / Script / Done control row in the model UI.
- Keep admin management and model discovery workflows separate.
- Prefer plain creator language over internal workflow language.
- Optimize first for a model using the app one-handed on a phone.

## Feed behavior

- Feed combines team-picked assignments with the model's discovery feed.
- Niche chips switch the discovery feed and return the page to the top.
- Save is optimistic, adds the post to Saved, and records `want_to_make` feedback.
- X records `not_my_style` feedback and removes the post from Saved if needed.
- Each tab remembers its own scroll position. Moving from Feed to another tab and back restores the previous Feed position.
- Tapping the already-active bottom tab scrolls that tab to the top.
- A floating up-arrow appears after the user scrolls down and returns to the top.
- Refresh requests a fresh feed order, resets pagination to page 1, and returns to the top.
- Reel playback starts muted on first tap. A visible sound button lets the model turn audio on or off.
- Only the active in-view reel should autoplay.

Relevant implementation: `src/ModelApp.js`, `src/pages/model/FeedPage.js`, and `src/components/ReelCard.js`.

## Audio behavior and API contract

The model Audio tab is backed by:

```text
GET /me/audio/trending
```

The client expects `data.audio` to be an array whose entries can contain:

```text
audio_id
audio_title
audio_author
is_original_audio
reel_count
creator_count
total_views
exampleReels
```

Contract details:

- `creator_count` is the number of distinct `account_handle` values using the sound in the model's database-backed niche results.
- `reel_count` is the number of matching reels in the database.
- `total_views` is the combined view count for those reels.
- `exampleReels` contains playable reel objects; the UI displays up to three per sound.
- Missing counts render as zero and missing `exampleReels` render without an example section.
- The optional detail endpoint is `GET /me/audio/:audioId/reels`.

The tab supports All sounds, Original, and Music filters. Each card shows the sound title and author, sound type, unique creator count, reel count, total views, an Instagram audio link when `audio_id` exists, and up to three playable example reels from the database.

Relevant implementation: `src/pages/model/SoundsPage.js`, `src/components/IdeaReel.js`, and `src/api.js`.

## Saved and Ideas

- Saved is the model's shortlist of reels she wants to revisit or make.
- A reel can be removed from Saved without returning to Feed.
- Ideas presents the model's action queue in a quieter, production-oriented layout under the `Ready to make` heading.
- Empty, loading, and error states use the same visual language as Feed and Audio.

Relevant implementation: `src/pages/model/SavedPage.js` and `src/pages/model/IdeasPage.js`.

## Visual system

- Shared model colors and typography tokens live in `tailwind.config.js`.
- The model shell and bottom navigation live in `src/ModelApp.js`.
- The shared login page received the same visual restyle plus accessibility, timeout, and expired-session handling improvements.
- Cards use restrained 8px rounding, compact mobile spacing, clear counts, and 44px-class touch targets where practical.
- The UI avoids marketing-page composition and keeps the actual creator workflow in the first viewport.

## Files changed in the completed redesign

```text
client/src/ModelApp.js
client/src/components/IdeaReel.js
client/src/components/LoginPage.js
client/src/components/ReelCard.js
client/src/pages/model/FeedPage.js
client/src/pages/model/IdeasPage.js
client/src/pages/model/SavedPage.js
client/src/pages/model/SoundsPage.js
client/tailwind.config.js
```

## Verification completed

- Client production build passed with `npm run build`.
- Full server suite passed: 291/291 tests.
- Browser smoke passed at 390x844 and 900x900.
- No horizontal overflow was found at either viewport.
- Feed, Audio, Saved, and Ideas all populated in smoke data.
- Feed tab scroll restoration returned to the exact prior position.
- Active-tab return-to-top and Feed refresh return-to-top both passed.
- Feed and Audio example reel playback both started muted and played.
- Audio filters, unique creator counts, reel counts, view counts, and example reels rendered correctly.
- Browser console had no errors or warnings during the final smoke.
- Temporary smoke-test models, posts, and media were removed after verification.
- The deployed bundle was checked for the final UI labels and health endpoints were rechecked after deploy.

### Hardening verification on 2026-07-12

- Client production build compiled successfully (`main.5aec6a8e.js`, `main.325dcd9e.css`).
- Full server suite passed: 291/291 tests, including model DTO, atomic reaction, feed exclusion, pagination, credential, CORS, and expired-session coverage.
- Browser smoke passed at 320x700, 390x844, and 1280x800 with no horizontal overflow.
- Feed-to-Saved-to-Feed restored the exact scroll position (`1560px` before and after).
- A second regression smoke after a manual shuffle preserved both the exact scroll position (`1350px`) and the identical reel order after leaving and returning to Feed.
- Back-to-top, active Feed-tab return-to-top, reshuffle refresh, Save, unsave, and persistent X dismissal passed.
- The model feed showed only Beauty/Makeup smoke niches and excluded an intentionally seeded Fitness reel.
- Audio showed two database creators, two reels, 344K total views, and two playable examples. Audio and Ideas kept one active preview and paused it on tab change.
- A controlled server outage preserved already-loaded Saved content and displayed a connection error instead of an empty state.
- A forced session expiry returned the model to login with `Your session expired. Sign in again.`
- Direct API smoke confirmed the creator-safe post fields and no internal notes, tags, scrape queries, raw media URLs, or cache errors.
- The two-stage production Docker build passed. The 113 MB runtime image contains `client/build/index.html` and does not contain `client/node_modules`.
- A PostgreSQL-backed production container passed `/live`, `/ready`, and static-client checks with no MemoryStore warning. A login session remained authenticated after restarting only the app container.
- Railway deployed the hardening successfully with bundle `main.8efccee9.js`. Production logs show PostgreSQL, a writable media volume, and no MemoryStore warning; the 390px deployed login smoke had no overflow or browser console errors.
- Final dependency audit: server has one moderate Anthropic SDK advisory in an unused filesystem-memory feature; client reports 28 Create React App build/test advisories (9 low, 6 moderate, 13 high, 0 critical), and that toolchain is excluded from the runtime image.
- All 11 disposable posts, both disposable models, cookies, and generated media were removed; follow-up database counts were zero.

## Commit trail

- `464271b` - Improve model feed navigation
- `7676474` - Clarify model audio tab
- `e25ef1b` - Simplify model reel reactions
- `9e4de6e` - Redesign model creator experience

## Next real-world checks

1. Have one real model sign in on her own phone and use all four tabs.
2. Confirm the Save and X meanings are obvious without coaching.
3. Confirm first-tap video playback and the sound toggle behave correctly on her mobile browser.
4. Ask whether Audio creator/reel/view counts help her choose a sound and whether the three examples are enough.
5. Check that Saved feels like a useful shortlist and Ideas feels like a clear next-action queue.
6. Record device, browser, confusing labels, missed taps, slow media, and any content that looks irrelevant.

## Remaining non-model checks

1. Run and document a Railway PostgreSQL backup/restore drill before relying on the portal for irreplaceable model feedback.
2. Plan a future migration away from Create React App to clear its old build-tool advisories; the current multi-stage image keeps that toolchain out of production runtime.
3. Upgrade the Anthropic SDK in a separate compatibility change. The remaining moderate advisory concerns an optional filesystem-backed memory tool that InstaScraper does not use.

Do not expand the reaction model or merge admin controls into this UI before that real-model test. The next product decisions should be driven by observed use, not additional speculative controls.
