# Model Portal UI Handoff

Last updated: 2026-07-11

## Current status

The model-facing portal is implemented, deployed, and ready for real-model phone testing. It is intentionally separate from the admin experience and is designed as a mobile-first creator workflow, not a smaller version of the admin dashboard.

- Live app: https://instascraper-production-7281.up.railway.app
- Production branch: `main`
- Latest redesign commit: `9e4de6e` (`Redesign model creator experience`)
- Health checks verified: `/live` is live and `/ready` reports the database is up.

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
- The shared login page received the same visual restyle; authentication behavior was not changed.
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
- Full server suite passed: 277/277 tests.
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

Do not expand the reaction model or merge admin controls into this UI before that real-model test. The next product decisions should be driven by observed use, not additional speculative controls.
