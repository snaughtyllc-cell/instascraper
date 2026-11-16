# Plan: TikTok creators in InstaScraper

Date: 2026-11-16 · Requested by user ("yes plan it") · Branch `tiktok-scraping` off `main` · Worktree `../instascraper-tiktok`

## Goal
Some creators the team wants are age-restricted on Instagram, and the Instagram scraper can't log in to see them. Today that's @pardiss.carello (dance), @loganxcole and @nicolexyaps. Many of them post the same content on TikTok, where it's public. Let a VA add a creator **by TikTok handle** to a model's workspace. Her TikTok videos then flow into the same library and pipeline as Instagram reels: video cache, Gemini auto-sort (type, layout, look tags, transcript), perf score, model feed, Film. First user: TikTok `@pardisscarelllo` for Destiny (model 9), for her dance content.

## Verified facts (one real Apify run, 2026-11-16)
- Actor: `clockworks~tiktok-scraper`.
- Input: `{ profiles: [handle], resultsPerPage: 50, shouldDownloadVideos: true, shouldDownloadCovers: false, profileScrapeSections: ['videos'] }`.
- Each item has these fields:
  - `id`, `text`, `createTimeISO`, `playCount`, `diggCount`, `commentCount`, `shareCount`, `collectCount`, `webVideoUrl`
  - `videoMeta.coverUrl`, `videoMeta.duration`
  - `authorMeta.name` (the handle), `authorMeta.fans` (followers), `authorMeta.privateAccount`
  - `musicMeta.musicId`, `musicMeta.musicName`, `musicMeta.musicAuthor`, `musicMeta.musicOriginal`
  - `isSlideshow`, `isPinned`, `isAd`
- `mediaUrls[0]` (also `videoMeta.downloadAddr`) is an Apify key-value-store mp4 URL. It downloads with HTTP 200 `video/mp4` and **no token**.
- These Apify run storages expire, so the existing video sweep must cache the mp4 soon after the scrape. It already runs right after a scrape.

## Approach
1. **Schema** (idempotent, PG + SQLite, same pattern as `server/sort-migration.js`):
   - `posts.platform TEXT` (NULL = instagram). `tracked_accounts.platform TEXT` (NULL = instagram).
   - TikTok post rows use `shortcode = 'tt_' + id`, so they can never collide with IG shortcodes.
2. **Scraper (`server/scraper.js`):**
   - New `queryType: 'tiktok_username'`. `_buildInput` returns the TikTok actor and input above. Strip a leading `@`, and accept a full `tiktok.com/@handle…` URL, reducing it to the handle.
   - New pure `mapTikTokItem(item, { query, nowIso })` returns the same `post` shape the IG loop builds:
     - `platform: 'tiktok'`
     - `videoUrl = mediaUrls[0] || videoMeta.downloadAddr`
     - `thumbnailUrl = videoMeta.coverUrl`
     - `caption = text`; likes = `diggCount`; comments = `commentCount`; views = `playCount`; `postedAt = createTimeISO`
     - `accountHandle = authorMeta.name` lowercased; `postUrl = webVideoUrl`; `followersAtScrape = authorMeta.fans`
     - Audio fields from `musicMeta`: `audioId = 'tt_' + musicId`, so TikTok sounds never merge with IG audio ids.
     - ER via the existing `calcER`.
   - Skip slideshows (`isSlideshow`) and ads. In `_pollAndStore`, route TikTok runs through `mapTikTokItem`. The INSERT gains the `platform` column; IG rows keep writing NULL.
   - **Empty or private result = job `failed`** with a clear message ("TikTok account private or not found"). It must never write stub rows. Do not use the IG generic-actor fallback for TikTok.
   - After saving, call the same `refreshPerfScores(pool, [handle])` as IG.
3. **Creators and workspaces:**
   - `POST /workspaces/:modelId/creators` accepts an optional `platform` (`'instagram' | 'tiktok'`, default instagram).
   - `addCreator` / `linkCreator` store `tracked_accounts.platform` on insert. On an existing row they only update platform when one is explicitly given.
   - Scrape calls that take a tracked username (`server/scheduler.js:147` nightly re-scrape, `server/index.js:543`, `server/index.js:582`) choose `queryType` from `tracked_accounts.platform`: `'tiktok_username'` when tiktok, `'username'` otherwise.
4. **Links (no hardcoded instagram.com for TikTok rows):**
   - Film API (`server/film-api.js:136`): keep the `instagramUrl` field (contract), but fill it from `post_url` when the platform is tiktok. Add additive fields `platform` (`'instagram'|'tiktok'`) and `sourceUrl` (= post_url, or the built IG URL).
   - Client:
     - Creator profile links in `ModelWorkspace.js`, `TrackedAccountsTab.js` and `ContentCard.js` (line ~276) go to `https://www.tiktok.com/@<handle>` when the platform is tiktok.
     - Reel links already prefer `post_url`; leave them.
     - Show a small "TikTok" badge on creator rows and content cards for tiktok items.
   - Workspace "Add creator" input gets an Instagram/TikTok toggle. It also auto-detects a pasted `tiktok.com/@…` URL and selects TikTok.
   - Scrape tab gets a "TikTok username" query type.
5. **Out of the TikTok path:** Omegle React fetch (`server/react-fetch.js`, IG-only), discovery, Reel Radar, suggestions, collab mining and the Audio tab's IG audio links. These keep working for IG and must skip or ignore `platform='tiktok'` rows where they'd build IG URLs. AudioTab and SoundsPage only link out when the audio id doesn't start with `tt_`.

## Key decisions & tradeoffs
- **One library, not a separate TikTok silo.** Everything downstream (sort, look tags, perf, feed, Film) works on the cached mp4, so TikTok videos get it all for free.
- **`tt_` prefixes** on shortcode and audio id avoid collisions without changing unique keys.
- **Username uniqueness stays global** in `tracked_accounts`. A TikTok handle identical to a different IG account would collide. Rare, accepted; the handles differ here (`pardisscarelllo` vs IG `pardiss.carello`).
- **Cost:** about the same as IG per video. `shouldDownloadVideos` adds a little; it's still under the same `APIFY_BUDGET_USD_30D` budget guard (must go through `_startApifyRun`, so budget and run accounting apply).

## Risks / open questions
- TikTok may rate-limit the actor. If so, the job fails cleanly (no stubs) and retries on the nightly run.
- The Apify KV video URL expires. If the sweep misses it, the row goes `expired` like IG. Re-scrape refreshes it.

## Out of scope
TikTok hashtag/keyword discovery, TikTok suggestions, logged-in Instagram scraping, TikTok in React mode.

## Acceptance criteria & verification
- Unit tests:
  - `mapTikTokItem`, using a fixture built from the verified field list above: maps every field, `tt_` prefixes, lowercased handle, skips slideshow and ad.
  - `_buildInput('tiktok_username')`: handle, `@handle` and full URL all produce the right actor and input.
  - An empty TikTok dataset marks the job failed and inserts 0 rows.
  - `linkCreator` stores platform. The scheduler picks `tiktok_username` for a tiktok tracked account and `username` otherwise.
  - Film API: a tiktok reel returns `instagramUrl = sourceUrl = post_url` and `platform: 'tiktok'`; an IG reel is unchanged plus `platform: 'instagram'`.
  - Workspace route accepts `platform`.
- Existing tests all pass:
  - `cd server && NODE_USE_SYSTEM_CA=0 GEMINI_API_KEY= npm test`
  - `cd client && NODE_USE_SYSTEM_CA=0 CI=true npm run build`
- After deploy (Claude, with the user's go-ahead):
  - Add TikTok `pardisscarelllo` to Destiny with platform tiktok and run the scrape.
  - Expect about 50 rows with `platform='tiktok'`, the videos caching, auto-sort labelling them (mostly `dance`), and them appearing in Destiny's workspace reels.
