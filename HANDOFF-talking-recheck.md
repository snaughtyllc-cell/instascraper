# Talking-recheck: state and how to resume

**17 Nov 2026. Parked at 278 remaining, run active.**

## What this queue is
`content_type='talking'` posts that the sorter thinks may be mislabelled. The recheck re-describes each one with Gemini and either confirms talking or reclassifies it. It is the last of the five sort queues; layout-recheck, look-backfill, transcript-backfill and lipsync-recheck are all at zero.

## The problem, precisely
Two bugs, one fixed, one open.

**Fixed (a9a0c47).** `retry()` in `server/gemini-sort.js` allowed 3 attempts at 250 ms and 500 ms. A Gemini 429 burned all three in under a second and the run died. It now reads `Retry-After` and the `retryDelay` in the response body, falls back to exponential backoff from 1s to 60s, and allows 6 attempts.

**Open.** Even with the fix the run stops after roughly 8-10 minutes. The key's requests-per-minute is the ceiling, and the scheduler's own `autoSort` competes for the same key. When three consecutive describes fail, line ~97 of `talking-recheck.js` sets `result.stoppedOnDescribeErrors` and `break`s — but the route handler discards the return value, so the stop is invisible anywhere in the UI. That is why it looks like an idle queue rather than a failure.

## Resume
Sign in at `/` (team login, email blank), then from the browser console or the app:

```
GET  /sort/talking-recheck/estimate   # watch count + max ai_classified_at
POST /sort/talking-recheck            # body {"confirm": true}
```

A POST refuses with `{"started":false}` if a run is already live. Re-fire whenever `max ai_classified_at` freezes; it resumes immediately.

## Two fixes worth making
1. **Surface the stop.** Return/log `stoppedOnDescribeErrors`, ideally to a row the UI reads, so a dead run is visible.
2. **Stop sharing the key.** Either raise `AUTO_SORT_BATCH` so a retry batch is bigger, or skip `autoSort` while a recheck is running. Both target the same RPM limit.

## Getting it to zero unattended
A watcher that polls `max ai_classified_at`, waits 2 minutes, and re-POSTs on staleness drained this reliably and needed no deploy. Ten minutes of that took 300 to 278. At the observed rate it wants 3-4 hours of it.
