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
- **Media:** the browser loads videos and thumbnails straight from InstaScraper through **signed URLs**, so large files don't pass through HQ. The URL is `/film/v1/media/:reelId?exp=<unixSeconds>&sig=<hex>`, where `sig = HMAC-SHA256(FILM_MEDIA_SECRET, "<reelId>.<exp>")`, with a 6-hour expiry. Thumbnails use the same pattern at `/film/v1/thumb/:reelId`. Fetched React references use `/film/v1/react-media/:shortcode?exp=<unixSeconds>&sig=<hex>` and the separate signature payload `"react-media.<shortcode>.<exp>"`, also valid for 6 hours. No bearer is needed; a bad or expired signature returns 403. Video supports HTTP Range (206).

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
| POST | `/react-reference` | `{ "shortcode": "AbCdE123", "fetch": true }` (`fetch` optional) | `200 { videoUrl, durationSec }`, `202 { state: "fetching" }`, or 404 when unavailable |
| POST | `/react-prefetch` | `{ "shortcodes": ["AbCdE123"] }` | `202 { queued }`, the number of newly queued fetches |
| GET | `/react-media/:shortcode` | `exp, sig` | fetched mp4 (Range-capable), 404 unless ready |

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

## React mode

Film records the model's unmirrored camera while the reference plays above it. HQ requests a server-side
1080×1920 render, supplies a Drive resumable upload session, and receives the result through an authenticated
callback. The reference, prefetch and render routes use the existing `FILM_SERVICE_KEY` bearer authentication.

- `POST /film/v1/react-reference` with `{ "shortcode": "<5–64 letters, digits, _ or ->" }` returns
  `200 { "videoUrl": "<absolute signed media URL>", "durationSec": number|null }` for an existing playable reel.
  The optional `fetch` field is a boolean and defaults to `true`; any non-boolean value returns
  `400 { "error": "invalid_fetch" }`. With `fetch: false`, available posts/pins and ready fetched references
  still return 200. Unavailable references return `404 { "error": "reel_not_available" }`, including references
  already being fetched. This does not start a fetch or touch the daily cap or launch/cost ledgers, so non-React
  shots can check availability without spending Apify credits.
  Malformed shortcodes return 400. The worker downloads a missing
  cached MP4 and pins it by hardlink (copy across filesystems) as `<REACT_REF_DIR>/<shortcode>.mp4`.
  Pins survive video-cache pruning. Signed media checks the ordinary cache first, then the pin, then 404.
  Explicitly pinned references remain available through valid signed URLs even after feed visibility or cache
  status changes; ordinary unpinned feed media retains its existing visibility restrictions.
- When the shortcode is unknown or its existing post has no available video, the service checks the separate
  `film_react_refs` store. A ready reference returns 200 with a signed `/film/v1/react-media/:shortcode` URL.
  With `fetch` omitted or `true`, an absent reference or a failure at least 6 hours old starts an on-demand
  Apify Instagram reel fetch and returns `202 { "state": "fetching" }`; subsequent requests while it is queued
  or fetching also return 202.
  HQ can poll `react-reference` until it receives 200 or 404. A recent failure returns
  `404 { "error": "reel_not_available" }`. The rolling 24-hour launch cap or a blocked Apify budget returns
  the same 404 without launching a fetch. Fetches use the existing Apify token and record purpose `react_ref`;
  fetched references never create `posts` rows or enter feeds, discovery, cadence or creator statistics.
- `POST /film/v1/react-prefetch` accepts `{ "shortcodes": ["AbCdE123", "Other_123"] }`: 1–50 valid shortcodes,
  deduplicated after validation. Invalid input returns `400 { "error": "invalid_shortcodes" }` before any fetch
  is queued. Existing posts, pinned files, ready references and active fetches are skipped. Recent failures,
  the daily cap and blocked budgets also queue nothing. The response is `202 { "queued": n }`, counting only
  new fetches; old failures may retry after 6 hours.
- `GET /film/v1/react-media/:shortcode?exp&sig` needs only its signed URL and serves a ready, nonempty reference
  file with HTTP Range support. Invalid or expired signatures return 403; missing files or references that
  are not ready return `404 { "error": "reel_not_available" }`.
- Fetches are deduplicated by shortcode and run at concurrency 2 by default, with an overall 180-second timeout.
  Each download is capped by `VIDEO_MAX_MB`, must have a `video/*` content type, and publishes its MP4 atomically.
  Failures store static error codes. On startup, fetches stuck for more than 10 minutes become failed with
  `worker_restarted`. The render worker also resolves ready fetched references for Instagram references.
  A separate `film_react_ref_attempts` ledger retains launch timestamps across retries and reserves queued
  work against the daily cap. Queued and active claims send heartbeats; abandoned claims that age past
  10 minutes after startup are also recovered on request. Apify runs receive a remote timeout and are
  aborted on local cancellation; uncertain remote outcomes remain reserved in the Apify budget ledger.
- `POST /film/v1/react-render` accepts:

  ```json
  {
    "jobId": "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb",
    "reference": { "kind": "instagram", "shortcode": "AbCdE123" },
    "rawUrl": "https://hq.example/raw-take",
    "uploadUrl": "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=...",
    "callbackUrl": "https://hq.example/api/filming/react/callback",
    "crop": { "top": 0, "height": 0.5 },
    "syncMs": 500,
    "output": "stitched",
    "referenceAudio": true
  }
  ```

  `reference` may instead be `{ "kind": "url", "url": "https://hq.example/reference" }`. Responses are
  `202 { "accepted": true }`, including duplicate job IDs, or `400 { "error": "<validation code>" }`.
  Job IDs are UUIDs, crop fractions must be finite with `top >= 0`, `height >= 0.2`, and `top + height <= 1`;
  `syncMs` is an integer from −7000 through 32000; `output` is `stitched` or `solo`; `referenceAudio` is a boolean.
  Every URL must use HTTPS without credentials or fragments. Raw/source/callback URLs must share the
  `HQ_PUBLIC_URL` origin. Uploads require exactly `www.googleapis.com`, path `/upload/drive/v3/files`, and
  `uploadType=resumable`. Transfers refuse redirects, and ffmpeg/ffprobe cannot open network protocols.

Stitched output places the selected reference crop above her camera, at 30 fps with H.264 (veryfast, CRF 20,
yuv420p), AAC 160k, and faststart. Positive sync delays the reference and clones its initial frame;
negative sync seeks into it. A seek beyond the reference duration fails the job. The final frame is padded
for 600 seconds and output ends with her take. Her mic stays at volume 1; optional reference audio is 0.8,
mixed without normalization and limited. Missing audio yields reference-only audio or silence as appropriate.
Solo output fills 1080×1920 with her camera and uses only her audio. Normal ffmpeg autorotation handles
iPhone rotation metadata. Raw downloads are streamed with a 10-minute timeout and configurable byte cap;
URL references are capped at 500 MB. Temporary files are removed after success or failure.

Drive uploads begin with a single PUT with Content-Length and `video/mp4`. A 308, network error, 429, or 5xx
causes a status query (`Content-Range: bytes */<size>`) and resumption at the confirmed offset, with at most
five attempts. A 403 is never retried. The final Drive response must contain its file ID.

Callbacks POST to the supplied URL with `Authorization: Bearer <FILM_SERVICE_KEY>` and one of:

```json
{ "jobId": "...", "state": "done", "driveFileId": "..." }
{ "jobId": "...", "state": "failed", "error": "render_failed" }
```

Errors are static codes under 300 characters, with no secrets or URLs. Callback delivery makes an initial
attempt and up to three retries with bounded backoff on network errors, 429, or 5xx; it never retries 403.
The durable `film_react_jobs` table records job state. It also stores `payload_json` and `drive_file_id` so
queued jobs and pending callbacks can recover after restart; request payloads are cleared after successful
callbacks or permanent HTTP rejections (including 403), which are never retried on restart.
On boot, interrupted running jobs fail with `worker_restarted` and receive a failure callback;
queued jobs resume, and undelivered terminal callbacks retry without re-rendering. Duplicate IDs, including
failed jobs, remain idempotent. Only one render runs at a time by default.

Each render caps libx264 and both filter thread pools to `REACT_FFMPEG_THREADS` (default 2).
Positive integers are clamped to 1–16; invalid, nonpositive, or fractional values use 2.
ffmpeg and ffprobe (including pinned-reference probes) run at CPU nice level `REACT_FFMPEG_NICE`
(default 10) to give the live app priority. Integer levels 1–19 are accepted; 0 disables the adjustment,
and invalid values use 10. Priority adjustment is best effort and never fails a render.
These settings come from the server environment and cannot be overridden by render request fields.

Runtime configuration:

| Variable | Default / purpose |
|---|---|
| `HQ_PUBLIC_URL` | Required HTTPS origin for raw/reference downloads and callbacks |
| `REACT_REF_DIR` | `<DEFAULT_VIDEO_DIR>/../react-refs`; persistent pinned references |
| `REACT_FETCH_DAILY_MAX` | `100` fetch launches per rolling 24 hours |
| `REACT_FETCH_CONCURRENCY` | `2` simultaneous on-demand reference fetches |
| `REACT_FETCH_TIMEOUT_SEC` | `180` wall-clock seconds per on-demand reference fetch |
| `REACT_RENDER_CONCURRENCY` | `1` |
| `REACT_RENDER_TIMEOUT_SEC` | `900` wall-clock seconds per ffmpeg render |
| `REACT_FFMPEG_THREADS` | `2`; encoder and filter thread caps, positive integer clamped to 1–16 |
| `REACT_FFMPEG_NICE` | `10`; best-effort CPU nice level 1–19; `0` disables |
| `REACT_RAW_MAX_MB` | `1024` |
| `FFMPEG_PATH` | `ffmpeg` |
| `FFPROBE_PATH` | `ffprobe` |

The runtime Docker image includes ffmpeg. The schema definition follows the existing idempotent Film
migration setup; it must be applied through the normal deployment process separately from implementation.
