# Plan: reliable lip sync vs talking

Date: 2026-11-16 · Approved by user ("Yes, build it") · Branch `lipsync-check` off `main` · Worktree `../instascraper-lipsync`

## Goal
Destiny uses Film now. Film treats **talking** reels as transcript-only (teleprompter) and **lip sync** reels as "play the reel audio while recording". Some lip-sync reels are labelled `talking`, so Film shows her a transcript with no audio. The user wants talking vs lip sync to be as close to 100% right as possible, with as little manual review as possible.

**Root cause (measured on prod):**
- 279 talking reels. 238 are AI-sorted and all have `ai_audio_kind='own_speech'`.
- On 270 of them, Instagram credits the creator herself as the audio author, because lip-sync creators often download a sound and re-upload it.
- So both the single-pass sort and IG metadata get fooled.
- Strong extra evidence: @imjustpeechi has several "talking" reels with near-identical transcripts (same audio reused). People don't say the same words twice live.

## Approach
Three independent signals. A reel stays `talking` only when they agree it's live speech.

1. **Repeated-audio signal** (free, deterministic). New `server/lipsync-signals.js`:
   - Pure `transcriptShingles(text, n=5)`: lowercase, strip non-letters, word 5-grams.
   - Pure `overlap(a, b)` = |A∩B| / min(|A|,|B|).
   - `findRepeatedAudio(rows)`. Rows are `{id, account_handle, ai_transcript}` for all non-deleted posts with a transcript of ≥ 12 words. It returns `Map<id, {matchId, score}>` for reels whose transcript overlaps another reel's with score ≥ `LIPSYNC_REPEAT_MIN` (default 0.6), same or different creator.
   - Shorter transcripts are never matched.
2. **Dedicated lip-sync detector** (Gemini, video+audio). New `detectLipSync({ filePath, caption, handle }, { client, model })` in `server/gemini-sort.js`, reusing `withVideoPart` and `retry`.
   - Model from env `LIPSYNC_MODEL`, default `'gemini-3.5-flash'`: stronger than the flash-lite sorter.
   - Structured output `{ verdict: 'live_speech'|'lip_sync'|'unsure', confidence: 0..1, evidence: string[≤4], words: string|null }`.
   - The prompt asks one question: is the person speaking live in their own voice, or mouthing pre-recorded audio? It tells the model to weigh:
     - audio acoustics vs the visible room (studio-clean or compressed voice in a car or bathroom, no room echo, no ambient noise matching the scene)
     - whether the voice timbre, age and gender fit the face
     - lip/teeth/tongue articulation and timing vs the syllables
     - breaths and mouth noises
     - famous movie/podcast/TV soundbite phrasing
     - captions that quote the audio
     - an edited-audio feel: cuts in the audio that don't match the video cuts
   - It must answer `unsure` when evidence is weak.
   - `words` = verbatim spoken words of the audio when it is speech (own or someone else's). Null for songs or music; never song lyrics. Same cleaning as `cleanTranscript`.
   - Pure `cleanLipSyncResult` validates the output.
3. **Decision** (pure `decideTalkingVsLipSync({ detector, repeated, audioKind, minConfidence })` in `server/lipsync-signals.js`):
   - `lip_sync` with confidence ≥ `LIPSYNC_MIN_CONFIDENCE` (default 0.7), OR a repeated-audio hit, gives **lipsync** (`sort_status='auto'`, `content_type='lipsync'`).
   - `live_speech` with confidence ≥ 0.7 AND no repeat hit gives **talking** (unchanged).
   - Anything else (unsure, low confidence, or a repeat hit vs a confident live_speech) gives **needs a look**: `sort_status` set to the existing needs-look value used by `decideSort`. `content_type` is left as-is and `ai_suggested_type='lipsync'` is set so the reviewer sees the question.
   - `manual` rows are never touched.
4. **Storage:** new nullable columns on `posts` in `server/sort-migration.js` SORT_COLUMNS (PG + SQLite):
   - `ai_lipsync_verdict TEXT`, `ai_lipsync_confidence REAL`, `ai_lipsync_evidence TEXT` (JSON), `ai_lipsync_checked_at TEXT`, `lipsync_repeat_of INTEGER`.
   - Transcript: when a reel becomes lipsync and `words` is non-null, write it to `ai_transcript`, so Film shows the words she's mouthing. When verdict is talking, keep the existing transcript.
5. **Runs:**
   - **New reels:** in `server/sort-runner.js`, after a reel is auto-sorted as `talking`, run the repeat check plus the detector in the same pass, under the same daily cap, ledger and `withSortLock`.
   - **Backlog:** new `server/lipsync-recheck.js`, modelled on `server/talking-recheck.js`.
     - Eligible: `content_type='talking'`, `sort_status='auto'`, cached video, `ai_lipsync_checked_at IS NULL`, not archived or deleted.
     - Order: the given model's workspace creators first, then newest.
     - Records attempts in `look_backfill_attempts` and respects `attemptsToday`. A 3-consecutive-failure stop.
     - Routes in `server/sort-routes.js`: `GET /sort/lipsync-recheck/estimate?modelId=` returns `{count, priorityCount, estUsd}`, and `POST /sort/lipsync-recheck` `{modelId?, limit?}` returns `{started}`, guarded against concurrent runs.
     - Cockpit button "Check talking reels for lip sync" with count and cost confirm, like the other backfills.
   - The repeat check also runs once at the start of each recheck/sort batch across all transcripts, so a new reel can flag an older one.
6. **Team correction:**
   - Workspace reels (`client/src/pages/ModelWorkspace.js`): talking reels get a "Lip sync, not talking" button, and lipsync reels get "Talking, not lip sync". Each calls the existing `POST /content/:id/content-type` (sets `sort_status='manual'`, so the AI never overrides it).
   - Show the lip-sync verdict and evidence in the reel's admin details/tooltip.
   - The existing Needs a look pile shows these reels with the suggested type lipsync, and one click confirms.
7. **Film API:** no shape change. `transcript` for lipsync reels now carries the mouthed words (spoken audio only). Update the comment in `docs/superpowers/specs/2026-11-15-film-api-contract.md`: for lipsync reels, `transcript` = the words being mouthed, never song lyrics.

## Key decisions & tradeoffs
- **Two independent signals plus humans only on disagreement**: closest to "bulletproof" without hand-checking every reel.
- **Stronger model only for talking reels.** About 280 now, a handful per day after that. Cheap.
- **Repeat hit vs confident live_speech goes to needs a look, not auto-lipsync.** A creator can legitimately repost the same video.
- **Manual always wins.**

## Out of scope
Audio fingerprinting against external sound libraries; changing how other types are classified; Film UI (handled in the OFM CC Film session).

## Acceptance criteria & verification
- Unit tests:
  - Shingles/overlap: identical text gives 1.0, unrelated gives ~0, short text is excluded.
  - `findRepeatedAudio`: same-creator and cross-creator matches.
  - `decideTalkingVsLipSync`: every branch, including manual untouched.
  - `cleanLipSyncResult`: rejects a bad enum and clamps confidence. Detector request config is in structured-output form.
  - `runLipSyncRecheck` with a fake detector:
    - writes verdict columns
    - moves a lip_sync reel to lipsync with words in `ai_transcript`
    - sends unsure to needs-look
    - respects the cap
    - a second run finds 0 eligible
  - sort-runner: a newly auto-sorted talking reel gets the lip-sync check in the same pass.
  - Routes: estimate and start work; concurrent run is rejected.
- Commands (must pass):
  - `cd server && NODE_USE_SYSTEM_CA=0 GEMINI_API_KEY= npm test`
  - `cd client && NODE_USE_SYSTEM_CA=0 CI=true npm run build`
- After deploy (Claude):
  - Run the recheck for Destiny's creators first (modelId 9), then the rest.
  - Report how many talking reels became lipsync, how many went to Needs a look, and spot-check @imjustpeechi's repeated reels are now lipsync.
