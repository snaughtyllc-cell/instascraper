# InstaScraper → Film API contract (v1)

Date: 2026-11-15 · Status: agreed with user ("start both") · Consumers: HQ (OFM CC `projects/hq`), relaying for Film (OFM CC `projects/filming`)

## Why

Models will never use InstaScraper. They see reels picked for them inside **Film**, in Film's own UI: a "Find" area next to Socials and OF. They can save, skip, and "Film this". InstaScraper stays the backend that finds, sorts, tags, learns taste and stores the videos. Film talks only to HQ, and HQ relays to InstaScraper. Film never calls InstaScraper directly.

```
Film (UI)  ──/api/filming/find/*──▶  HQ (knows the model)  ──/film/v1/*──▶  InstaScraper
```

## Identity

- InstaScraper `models` gets a column `hq_project_id TEXT UNIQUE` (HQ's project UUID for that model). It's set in InstaScraper's model form (admin), and `PUT /models/:id` accepts it.
- Every v1 route takes `:hqProjectId`. An unknown or unlinked id returns **404 `{ "error": "model_not_linked" }`**, and HQ shows Film a friendly empty state.

## Auth

- **Server-to-server:** header `Authorization: Bearer <FILM_SERVICE_KEY>`. This is a new InstaScraper env var, shared with HQ as `INSTASCRAPER_FILM_KEY`. It's separate from `INSTASCRAPER_API_KEY` and grants only `/film/v1/*`. A missing or wrong key returns 401. The comparison is constant-time.
- **Media:** the browser loads videos and thumbnails straight from InstaScraper through **signed URLs**, so large files don't pass through HQ. The URL is `/film/v1/media/:reelId?exp=<unixSeconds>&sig=<hex>`, where `sig = HMAC-SHA256(FILM_MEDIA_SECRET, "<reelId>.<exp>")`, with a 6-hour expiry. Thumbnails use the same pattern at `/film/v1/thumb/:reelId`. No bearer is needed; a bad or expired signature returns 403. Video supports HTTP Range (206).

## Reel object

```json
{
  "id": 123,
  "type": "talking", "typeLabel": "Talking",
  "lookTags": ["brunette", "bedroom"],
  "caption": "…",
  "transcript": "The spoken words.\nThe next sentence.",
  "creatorHandle": "lenapolanski",
  "postedAt": "2026-11-10T18:22:00Z",
  "viewCount": 120000, "likeCount": 9100,
  "nicheMatch": true,
  "videoUrl": "https://<instascraper>/film/v1/media/123?exp=…&sig=…",
  "thumbUrl": "https://<instascraper>/film/v1/thumb/123?exp=…&sig=…",
  "instagramUrl": "https://www.instagram.com/reel/<shortcode>/",
  "saved": false
}
```

`transcript` is an additive `string | null` field, at most 4000 characters. It contains the verbatim clear speech by the person on screen in its original language, with line breaks between sentences or lines, for Film's teleprompter script. It has no speaker labels, timestamps or commentary, and never contains song lyrics. Missing transcripts and reels with no clear speech return `null` (including the internal empty-string sentinel).

## Endpoints (all under `/film/v1`, bearer required except media)

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/models/:hqProjectId` | — | `{ name, niches: [{value,label}], lookTags: [], linked: true }` |
| GET | `/models/:hqProjectId/feed` | `?page=1&limit=20&shuffle=0\|1&niche=<value>` | `{ reels: Reel[], page, hasMore }`, the same picks and order as her InstaScraper feed (niche first, then look match and learned taste; `niche` filters hard when given; shuffle is random) |
| GET | `/models/:hqProjectId/saves` | `?page=1&limit=50` | `{ reels: Reel[], page, hasMore }`, newest save first |
| POST | `/models/:hqProjectId/reels/:reelId/save` | `{ "saved": true\|false }` | `{ saved }`. Updates her taste. |
| POST | `/models/:hqProjectId/reels/:reelId/skip` | `{}` | `{ skipped: true }`. Records "not my style" (hidden from her feed, taste learns). |
| POST | `/models/:hqProjectId/reels/:reelId/filming` | `{ "hqItemId": "<uuid>" }` | `{ ok: true }`. HQ calls this after it creates the "Film this" item, so InstaScraper records `want_to_make` (strong positive) and links the reel to the HQ item. |
| GET | `/media/:reelId` | `exp, sig` | the mp4 (Range-capable) |
| GET | `/thumb/:reelId` | `exp, sig` | jpeg |

- Save, skip and filming on a reel she can't access (not sorted, not in her scope) return 404 `{ "error": "reel_not_available" }`.
- Errors are always JSON `{ error }`. 5xx means HQ should show "Couldn't load picks, try again".

## "Film this" (HQ's job)

HQ creates an item in the model's filming plan with:
- the reel's `instagramUrl` as the reference link
- the `typeLabel` as the format hint
- the caption as a note

Then HQ calls `POST …/filming`. Film's existing upload flow takes over, and the clip auto-submits like any Film shot.

## Env vars

- InstaScraper: `FILM_SERVICE_KEY`, `FILM_MEDIA_SECRET`, `PUBLIC_BASE_URL` (used to build absolute media URLs; defaults to the request host).
- HQ: `INSTASCRAPER_URL` (https://instascraper-production-7281.up.railway.app), `INSTASCRAPER_FILM_KEY` (= `FILM_SERVICE_KEY`).
