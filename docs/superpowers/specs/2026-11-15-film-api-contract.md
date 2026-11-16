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
- **Media:** the browser loads videos and thumbnails straight from InstaScraper through **signed URLs**, so large files don't pass through HQ. The URL is `/film/v1/media/:reelId?exp=<unixSeconds>&sig=<hex>`, where `sig = HMAC-SHA256(FILM_MEDIA_SECRET, "<reelId>.<exp>")`, with a 6-hour expiry. Thumbnails use the same pattern at `/film/v1/thumb/:reelId`. React-ready references use `/film/v1/react-media/:shortcode?exp=<unixSeconds>&sig=<hex>` and the separate signature payload `"react-media.<shortcode>.<exp>"`. Originals use `/film/v1/react-media/:shortcode?variant=original&exp=<unixSeconds>&sig=<hex>` with payload `"react-media.<shortcode>.original.<exp>"`. Both React variants expire after 6 hours, and their signatures cannot authorize each other. No bearer is needed; a bad or expired signature returns 403. Video supports HTTP Range (206).

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
  "platform": "instagram",
  "sourceUrl": "https://www.instagram.com/reel/<shortcode>/",
  "saved": false
}
```

`transcript` is an additive `string | null` field, at most 4000 characters. For talking reels it contains the verbatim clear speech by the person on screen in its original language, with line breaks between sentences or lines, for Film's teleprompter script. For lipsync reels it contains the spoken words being mouthed from the recorded audio. It has no speaker labels, timestamps or commentary, and never contains song lyrics. Missing transcripts and reels with no clear speech return `null` (including the internal empty-string sentinel).

`platform` is an additive `"instagram" | "tiktok"` field; legacy rows are Instagram.
`sourceUrl` is the stored source post URL, falling back to the built Instagram reel URL.
The existing `instagramUrl` field keeps its Instagram behavior and contains the TikTok
post URL for TikTok reels. TikTok references support cached dance media; React mode
and on-demand Instagram reference fetching exclude TikTok shortcodes (`tt_` prefix).

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
| POST | `/react-reference` | `{ "shortcode": "AbCdE123", "fetch": true, "mode": "react" }` (`fetch` and `mode` optional) | `200 { videoUrl, originalVideoUrl, durationSec, analysis }`, `202 { state: "fetching" }`, or 404 when unavailable |
| POST | `/react-prefetch` | `{ "shortcodes": ["AbCdE123"] }` | `202 { queued }`, the number of newly queued fetches |
| GET | `/react-media/:shortcode` | `exp, sig, variant?` | React-ready mp4 or original fallback by default; `variant=original` serves only the original mp4 (Range-capable), for posts and fetched references |

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

Film records the model's unmirrored camera while `originalVideoUrl` plays the whole original reel, including
the creator, so she can mimic the performance. Film may also play its original audio while filming.
`videoUrl` supplies the React-ready variant separately. HQ requests a server-side
1080×1920 render, supplies a Drive resumable upload session, and receives the result through an authenticated
callback. The reference, prefetch and render routes use the existing `FILM_SERVICE_KEY` bearer authentication.

- `POST /film/v1/react-reference` with `{ "shortcode": "<5–64 letters, digits, _ or ->" }` returns
  `200 { "videoUrl": "<absolute signed react-media URL>", "originalVideoUrl": "<absolute signed original URL>", "durationSec": number|null, "analysis": Analysis|null }`
  for an existing playable reel. Every 200 response includes both URLs, including posts-based pins and
  references without analysis. `videoUrl` uses `/film/v1/react-media/<shortcode>?exp&sig` with the
  `react-media.<shortcode>.<exp>` signature payload and serves the analyzed pin when ready, otherwise the original pin.
  `originalVideoUrl` uses `/film/v1/react-media/<shortcode>?variant=original&exp&sig`, with
  `sig = HMAC-SHA256(FILM_MEDIA_SECRET, "react-media.<shortcode>.original.<exp>")`, and always serves the original
  MP4 with the creator's video and audio intact. Without analysis, both URLs serve the same original media.
  The optional `fetch` field is a boolean and defaults to `true`; any non-boolean value returns
  `400 { "error": "invalid_fetch" }`. The optional `mode` accepts only `"react"` (default) or `"dance"`;
  any other value returns `400 { "error": "invalid_mode" }`. With `fetch: false` in React mode, available posts/pins and ready fetched references
  proceed to analysis, and references already being fetched return `202 { "state": "fetching" }`.
  Unavailable references return `404 { "error": "reel_not_available" }`. This does not start a fetch or touch the
  Apify daily cap or launch/cost ledgers, so non-React
  shots can check availability without spending Apify credits.
  Malformed shortcodes return 400. The worker downloads a missing
  cached MP4 and pins it by hardlink (copy across filesystems) as `<REACT_REF_DIR>/<shortcode>.mp4`.
  Pins survive video-cache pruning. Choosing the original for filming does not change the final render's
  React-ready audio, seam crop, or full-screen freeze behavior.
  Explicitly pinned references remain available through valid signed URLs even after feed visibility or cache
  status changes; ordinary unpinned feed media retains its existing visibility restrictions.
- When the shortcode is unknown or its existing post has no available video, the service checks the separate
  `film_react_refs` store. A ready reference returns 200 with both signed `/film/v1/react-media/:shortcode` URLs.
  With `fetch` omitted or `true`, an absent reference or a retryable failure starts an on-demand Apify
  Instagram reel fetch and returns `202 { "state": "fetching" }`; subsequent requests while it is queued
  or fetching also return 202. Failures with `apify_no_key`, `apify_failed`, `apify_busy`, `apify_network`,
  `fetch_timeout` or `worker_restarted` retry after 10 minutes, including existing `apify_failed` rows. Permanent failures
  such as `no_video`, `apify_error_stub`, `download_too_large` and `invalid_video_type` retry after 6 hours.
  HQ can poll `react-reference` until it receives 200 or 404. A recent failure returns
  `404 { "error": "reel_not_available" }`. The rolling 24-hour launch cap or a blocked Apify budget returns
  the same 404 without launching a fetch. Fetches use `REACT_APIFY_API_KEY`, falling back to `APIFY_API_KEY`,
  and record purpose `react_ref`. The React-only key does not enable scheduled daily scraping, discovery,
  or radar; those continue to require `APIFY_API_KEY`. If neither key is configured, the reference fails
  with `apify_no_key` without consuming the daily cap or writing the attempts or Apify cost ledgers. Startup
  and missing-key requests share one process-wide log line:
  `[React fetch] no Apify key configured (set REACT_APIFY_API_KEY)`.
  Fetched references never create `posts` rows or enter feeds, discovery, cadence or creator statistics.
- `POST /film/v1/react-prefetch` accepts `{ "shortcodes": ["AbCdE123", "Other_123"] }`: 1–50 valid shortcodes,
  deduplicated after validation. Invalid input returns `400 { "error": "invalid_shortcodes" }` before any fetch
  is queued. Existing posts, pinned files, ready references and active fetches are skipped. Recent failures,
  the daily cap and blocked budgets also queue nothing. The response is `202 { "queued": n }`, counting only
  new fetches. New work enters an in-process queue and runs serially by default; failed references use
  the same 10-minute transient or 6-hour permanent retry windows as `react-reference`.
- `GET /film/v1/react-media/:shortcode?exp&sig` needs only its signed URL and serves a ready, nonempty reference
  file with HTTP Range support. The optional `variant` query parameter accepts only the scalar value `original`;
  omitted means React-ready media with original fallback. Unsupported, empty, repeated, or structured variants
  return `403 { "error": "invalid_signature" }`, as do invalid or expired signatures. The signature binds the
  variant: a default signature cannot authorize `variant=original`, and an original signature cannot authorize
  a request without it. Original requests skip analysis and serve only the original pin; a missing original
  returns 404 even if a derivative exists. Missing files or references that are not ready return
  `404 { "error": "reel_not_available" }`.
- Once a React fetched reference or posts-based pin is available, a serial analysis job runs automatically.
  Existing ready references without analysis are also discovered at startup and on React reference requests,
  except originals acquired only for Dance, which remain excluded from automatic discovery. Explicit React
  requests for those same shortcodes still analyze normally.
  While queued or analyzing, `react-reference` returns the unchanged `202 { "state": "fetching" }` shape.
  Analysis failure, blocked Gemini budget, missing Gemini key, or exceeding `REACT_ANALYSIS_TIMEOUT_SEC`
  (default 120 seconds including queue time) returns the original MP4 with `analysis: null`; React remains usable.
  Successful analysis is cached in `film_react_analysis` and `<REACT_REF_DIR>/<shortcode>.react.mp4`.
  The MP4 preserves the original video and mutes creator speech spans with 40 ms transitions, encoding audio
  as stereo AAC at 48 kHz. It does not separate simultaneous overlapping voices or background music.
  Silence detection (`-35dB`, at least 150 ms) expands creator boundaries to nearby silence edges within 350 ms.
  Analysis uses deterministic 4 fps, 90×160 grayscale seam/layout detection and Gemini role transcription.
  A weak seam in the current or next sampled frame marks the current frame full, followed by minimum-segment smoothing.
  Gemini identifies the creator in the bottom pane or full screen, and strangers in the top video-call pane.
  Calls reuse `GEMINI_API_KEY`, `GEMINI_MODEL`, the shared `AUTO_SORT_DAILY_MAX` cap and cost accounting;
  failed paid attempts consume the cap too. The existing Gemini ledger records React attempts with `post_id=0`.

  ```ts
  type Analysis = {
    version: 1;
    seam: number | null; // 0..1 frame-height fraction; top pane is the stranger
    layout: { start: number; end: number; kind: 'split' | 'full' }[]; // sorted, non-overlapping, whole duration
    cues: { start: number; end: number; text: string }[]; // original creator's lines, <=200, <=300 chars each
    creatorMuted: boolean; // true when creator cues were removed from served audio
  };
  ```
- Fetches are deduplicated by shortcode and run at concurrency 1 by default, with an overall 180-second timeout.
  Apify authenticates with the existing token query parameter. Each fetch first uses
  `apify~instagram-reel-scraper` with `{ directUrls: ["https://www.instagram.com/reel/<shortcode>/"], resultsLimit: 1 }`.
  A successful run without a usable `videoUrl` falls back once to the generic Instagram actor with the same
  `directUrls`, `resultsType: "posts"` and `resultsLimit: 1`. Runs request `REACT_FETCH_MEMORY_MB` MB of memory
  (default 512). HTTP 402, 429, 5xx and Apify limit, memory, concurrency or rate errors keep the reference
  fetching while retrying with bounded backoff within the overall timeout; exhausted retries fail with `apify_busy`.
  Each download is capped by `VIDEO_MAX_MB`, must have a `video/*` content type, and publishes its MP4 atomically.
  Failures store static error codes. On startup, fetches stuck for more than 10 minutes become failed with
  `worker_restarted`. The render worker also resolves ready fetched references for Instagram references.
  A separate `film_react_ref_attempts` ledger retains launch timestamps across retries and reserves queued
  work against the daily cap. Only accepted Apify runs count as launches, including the generic fallback;
  rejected or failed starts do not consume the cap or prevent an old `apify_failed` row from retrying.
  Queued and active claims send heartbeats; abandoned claims that age past
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
  `syncMs` is an integer from −7000 through 32000; `output` is `stitched`, `solo`, or `dance`; `referenceAudio` is a boolean
  and must be `true` for `dance` (otherwise `400 { "error": "invalid_reference_audio" }`).
  Every URL must use HTTPS without credentials or fragments. Raw/source/callback URLs must share the
  `HQ_PUBLIC_URL` origin. Uploads require exactly `www.googleapis.com`, path `/upload/drive/v3/files`, and
  `uploadType=resumable`. Transfers refuse redirects, and ffmpeg/ffprobe cannot open network protocols.

Stitched output places the selected reference crop above her camera at 1080×1920, 30 fps with H.264
(veryfast, CRF 20, yuv420p), stereo 48 kHz AAC 192k, and faststart. Film can default the crop height to
`analysis.seam`; the render honors the supplied crop. Instagram renders use cached React-ready media and layout
when available. During full-screen creator segments the top pane freezes the last preceding safe split frame;
an initial full segment uses the first following safe split frame. Selection ends `REACT_FREEZE_MARGIN_SEC`
(default 0.35 seconds, clamped to 0..1) before a split-to-full boundary and starts 0.15 seconds after a
full-to-split boundary. If these margins would leave less than 0.2 seconds, selection uses the original
split midpoint ±0.1 seconds. URL references use the new mix without layout analysis.
Positive sync delays the reference and clones its initial frame;
negative sync seeks into it. A seek beyond the reference duration fails the job. The final frame is padded
for 600 seconds and output ends with her take. Her mic uses an 80 Hz high-pass filter,
`dynaudnorm=f=150:g=11:p=0.9:m=20`, and normalization to -16 LUFS / -1.5 dBTP with `linear=true`.
Optional reference audio is normalized to -22 LUFS / -2 dBTP and ducked by her processed mic
(sidechain threshold 0.03, ratio 6, attack 5 ms, release 350 ms).
The mix disables normalization and uses a 0.89 limiter. Missing audio yields reference-only audio or silence as appropriate.
Solo output fills 1080×1920 with her camera and uses only her processed mic audio. Normal ffmpeg autorotation handles
iPhone rotation metadata. Raw downloads are streamed with a 10-minute timeout and configurable byte cap;
URL references are capped at 500 MB. Temporary files are removed after success or failure.

## Dance mode

Film records video only while the original reel plays for synchronization. Requesting
`POST /film/v1/react-reference` with `mode: "dance"` returns 200 as soon as the original MP4 is available,
without running or waiting for Gemini, seam detection, or creator muting. Both `videoUrl` and
`originalVideoUrl` are the same signed `/film/v1/react-media/:shortcode?variant=original&exp&sig` URL,
`durationSec` is the original duration (or null when unavailable), and `analysis` is always null, even when
React analysis for that shortcode already exists or is pending. Fetching still returns 202, `fetch: false`
still checks availability without launching a fetch, and failure behavior is unchanged. A Dance request
does not enqueue analysis; React requests for the same shortcode retain their normal analysis behavior.

`POST /film/v1/react-render` with `output: "dance"` requires `referenceAudio: true`. The crop must satisfy
the same validation rules but does not affect the output. Her unmirrored raw camera fills the frame using
`scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30`; no reference video,
seam crop, or freeze layout is composited. Instagram references use the original pin, never the creator-muted
React derivative, and do not request analysis. Her microphone is never used, including when it is present;
raw takes without any audio stream are supported.

Original reference audio follows the stitched sync convention: positive `syncMs` delays it with `adelay`,
and negative values seek into it. A seek at or beyond the reference duration fails with
`reference_seek_out_of_range`. Audio uses `loudnorm=I=-14:TP=-1.5:LRA=11:linear=true` and is padded with
silence and trimmed to her take duration. The output is 1080×1920 H.264 at 30 fps with one stereo 48 kHz
AAC 192k stream, and ends with her take. Dance uses the same thread/priority caps, temporary-file cleanup,
durable queue, Drive upload, and authenticated callback behavior as React.

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
| `REACT_APIFY_API_KEY` | React-only Apify token; falls back to `APIFY_API_KEY`; does not enable scheduled scraping, discovery or radar |
| `REACT_FETCH_DAILY_MAX` | `100` fetch launches per rolling 24 hours |
| `REACT_FETCH_CONCURRENCY` | `1` simultaneous on-demand reference fetch by default; prefetch queues in process |
| `REACT_FETCH_MEMORY_MB` | `512` MB per Apify run |
| `REACT_FETCH_TIMEOUT_SEC` | `180` wall-clock seconds per on-demand reference fetch |
| `REACT_ANALYSIS_TIMEOUT_SEC` | `120` seconds for queued + active analysis; failure falls back to original media and null analysis |
| `GEMINI_API_KEY` | Existing Gemini key; missing key disables analysis with original-media fallback |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite`; same model as sorting |
| `AUTO_SORT_DAILY_MAX` | `1000` shared Gemini attempts per rolling 24 hours across sorting, backfills, candidate reels and React analysis |
| `GEMINI_PRICE_IN_PER_M` | `0.30`; Gemini input cost estimate per million tokens |
| `GEMINI_PRICE_OUT_PER_M` | `2.50`; Gemini output cost estimate per million tokens |
| `REACT_RENDER_CONCURRENCY` | `1` |
| `REACT_RENDER_TIMEOUT_SEC` | `900` wall-clock seconds per ffmpeg render |
| `REACT_FREEZE_MARGIN_SEC` | `0.35` seconds excluded before split-to-full boundaries, clamped to 0..1; full-to-split selection starts 0.15 seconds late |
| `REACT_FFMPEG_THREADS` | `2`; encoder and filter thread caps, positive integer clamped to 1–16 |
| `REACT_FFMPEG_NICE` | `10`; best-effort CPU nice level 1–19; `0` disables |
| `REACT_RAW_MAX_MB` | `1024` |
| `FFMPEG_PATH` | `ffmpeg` |
| `FFPROBE_PATH` | `ffprobe` |

The runtime Docker image includes ffmpeg. The schema definition follows the existing idempotent Film
migration setup; it must be applied through the normal deployment process separately from implementation.
