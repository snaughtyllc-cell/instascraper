# Smarter AI Ideas — Design Spec

**Date:** 2026-06-29
**Status:** Approved design (brainstorm complete) → awaiting spec sign-off
**Scope:** `server/ai-agent.js` + one new unit test (`server/ai-agent.test.js`). No DB schema changes. No new dependencies.
**Sub-project:** B ("Smarter AI ideas"), following Sub-project A (reliability hardening, shipped).

---

## 1. Context & Problem

`server/ai-agent.js` is the content-idea generator. `ContentIdeaAgent.generateIdeasForModel(modelId)` loads a tracked model, queries top-performing posts in its niche(s), calls Claude via `_callClaude`, deduplicates, and writes rows into `idea_cards`. It runs from two entry points:

- **Daily 8am cron** — `runIdeaGeneration` in `scheduler.js` (cron `0 8 * * *`).
- **Manual "generate ideas" button** — `POST .../idea-generation/:modelId` → `index.js:516`.

### What is broken (verified against live code, 2026-06-29)

1. **Retired model → idea-gen is 404ing in prod right now.** [`server/ai-agent.js:148`](../../../server/ai-agent.js) pins `model: 'claude-sonnet-4-20250514'`. That model **retired 2026-06-15**; today is 2026-06-29. Every `messages.create` call returns `404 not_found_error`. Both the cron and the manual button are failing.
2. **Silent whole-batch drop.** [`_callClaude` lines 172–181](../../../server/ai-agent.js) read `response.content[0].text`, strip markdown fences, `JSON.parse`, and on **any** exception `return []`. A single malformed character silently discards the entire batch — the user sees "no ideas" with no signal why.
3. **Fragile content access.** `response.content[0].text` assumes the first content block is text. With adaptive thinking enabled, `content[0]` can be a `thinking` block (empty text under the default `display: "omitted"`), so `.text` is `undefined` and parsing fails.
4. **No refusal/empty handling.** If Claude returns `stop_reason: "refusal"` (empty `content`) or an empty batch, the code crashes on `content[0].text` or silently stores nothing. No warning card is written.

### Why now

This is the highest-value, lowest-risk fix available: idea generation is a core daily feature that is currently 100% failing in production, and the fix is contained to one file plus a test.

---

## 2. Goals & Non-Goals

### Goals
- Restore idea generation in production (un-retire the model).
- Make parsing **reliable** (structured outputs instead of "respond with ONLY a JSON array" + string-cleaning).
- Make failures **visible** (refusal / parse-failure / empty → a clear warning card, never a silent empty batch).
- Sharpen the prompt so ideas are more specific, tied to source posts, with stronger hooks.
- Add a unit test that runs offline (no network, no DB) via the existing `node:test` harness.

### Non-Goals (explicitly out of scope)
- No `idea_cards` schema changes. The card shape stays: `concept`, `format`, `why_working`, `hook_line`, `source_niche`, `source_posts` (→ `source_post_ids` column), `stale_warning`.
- No changes to `_queryTopContent`, `_deduplicateIdeas`, the cron, or the route handlers (beyond what `_callClaude`'s new return shape requires inside `ai-agent.js`).
- No streaming (non-streaming is safe below ~16K `max_tokens`).
- No new npm dependencies. (A version bump of the already-present `@anthropic-ai/sdk` is permitted if §7 verification requires it.)

---

## 3. Design Decisions (approved)

All seven approved decisions, with exact JS syntax for `@anthropic-ai/sdk` (CommonJS). The SDK doc in the `claude-api` skill is the source of truth for these shapes.

| # | Decision | Detail |
|---|----------|--------|
| 1 | **Model → `claude-opus-4-8`** | Replaces the retired `claude-sonnet-4-20250514`. |
| 1b | **Remove `temperature`** | Opus 4.8 rejects sampling params (`temperature`/`top_p`/`top_k`) with a 400. Delete the `temperature: 0.8` line. |
| 2 | **Adaptive thinking + effort HIGH** | `thinking: { type: 'adaptive' }` and `output_config: { effort: 'high', ... }`. (Default `display: "omitted"` is fine — we never surface thinking text.) |
| 3 | **Structured outputs** | Replace the "ONLY a JSON array, no fences" instruction + string-clean + try/catch with `output_config.format` (`type: 'json_schema'`). Schema in §4. |
| 4 | **`max_tokens` 1500 → 6000** | Room for thinking + 3–5 detailed ideas. Non-streaming is fine under ~16K. |
| 5 | **Sharpen the prompt** | Same idea structure; sharper hooks, explicit "why now", concrete formats, and each idea tied to specific source post URLs. |
| 6 | **Refusal + empty handling** | Check `stop_reason` before reading content; on refusal / parse-failure / empty, surface a **warning** that becomes a clear warning card — not a silent empty batch. |
| 7 | **Unit test** | Injected mock Anthropic client (no network, no DB): asserts request params (model, no temperature, adaptive thinking, `output_config.format`, `max_tokens`), parses a structured response, and degrades gracefully on refusal / empty / unparseable. |

---

## 4. Structured-output JSON schema

Top-level object wraps the ideas array (structured outputs require an object root, and `additionalProperties: false` + `required` on every object).

```js
const IDEAS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ideas'],
  properties: {
    ideas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['concept', 'format', 'why_working', 'hook_line', 'source_niche', 'source_posts'],
        properties: {
          concept:      { type: 'string' },
          format:       { type: 'string' },
          why_working:  { type: 'string' },
          hook_line:    { type: 'string' },
          source_niche: { type: 'string' },
          source_posts: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  }
};
```

**Schema-limitation note:** structured outputs do **not** support array-count constraints (`minItems`/`maxItems`) or string-length constraints. So the "3–5 ideas" target stays as **prompt guidance**, and the code still applies `.slice(0, 5)` after parsing. This is acceptable — the schema's job is to guarantee a parseable, correctly-shaped object, which kills the silent whole-batch drop. The count is a soft preference, not a correctness invariant.

This shape exactly matches what the `idea_cards` insert already consumes (`idea.concept`, `idea.format`, `idea.why_working`, `idea.hook_line`, `idea.source_niche`, `idea.source_posts` joined to `source_post_ids`). No DB change.

---

## 5. New `_callClaude` shape

`_callClaude` changes its **return type** from `Array<idea>` to `{ ideas: Array<idea>, warning: string | null }` so it can signal refusal/parse-failure up to `generateIdeasForModel` (the only caller, line 41) without throwing. This is the only ripple outside `_callClaude`, and it stays within `ai-agent.js`.

```js
async _callClaude(posts, model, staleNiches) {
  const secondaryText = model.secondary_niches ? ` (secondary niches: ${model.secondary_niches})` : '';
  const postList = /* unchanged: numbered list of posts with handle, niche, caption, views, likes, ER, URL */;

  let response;
  try {
    response = await this.client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 6000,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'high',
        format: { type: 'json_schema', schema: IDEAS_SCHEMA }
      },
      system: SHARPENED_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: SHARPENED_USER_PROMPT }]
    });
  } catch (e) {
    console.error('[AI Agent] Claude request failed:', e.message);
    return { ideas: [], warning: `Idea generation request failed: ${e.message}` };
  }

  // Refusal: stop_reason is the source of truth; content may be empty.
  if (response.stop_reason === 'refusal') {
    console.warn('[AI Agent] Claude refused idea generation:', response.stop_details?.explanation);
    return { ideas: [], warning: 'Idea generation was declined by the safety system this run. No ideas were generated — try again or adjust the niche.' };
  }

  // Find the text block (with adaptive thinking, content[0] may be a thinking block).
  const textBlock = (response.content || []).find(b => b.type === 'text');
  if (!textBlock || !textBlock.text) {
    const why = response.stop_reason === 'max_tokens' ? ' (response was cut off — too long)' : '';
    return { ideas: [], warning: `Idea generation returned no usable content${why}. Try again.` };
  }

  try {
    const parsed = JSON.parse(textBlock.text);
    const ideas = Array.isArray(parsed.ideas) ? parsed.ideas.slice(0, 5) : [];
    if (ideas.length === 0) {
      return { ideas: [], warning: 'Idea generation produced no ideas this run. Try again.' };
    }
    return { ideas, warning: null };
  } catch (e) {
    // With structured outputs this should be near-impossible unless truncated by max_tokens.
    console.error('[AI Agent] Failed to parse structured response:', textBlock.text.slice(0, 200));
    return { ideas: [], warning: 'Idea generation returned malformed data. Try again.' };
  }
}
```

### Caller change in `generateIdeasForModel` (line ~41)

```js
const { ideas, warning } = await this._callClaude(allPosts, model, staleNiches);

if (warning) {
  // Surface as a clear warning card instead of silently storing nothing.
  await pool.query(
    `INSERT INTO idea_cards (model_id, batch_id, concept, format, why_working, hook_line, source_niche, stale_warning, status)
     VALUES ($1, $2, $3, '', '', '', $4, $5, 'pending')`,
    [modelId, batchId, warning, model.primary_niche, warning]
  );
  return { batchId, ideaCount: 0, warning };
}

const freshIdeas = await this._deduplicateIdeas(modelId, ideas);
// ... existing insert loop, unchanged ...
```

This reuses the existing warning-card pattern (the "No trending content found" card already written when `allPosts.length === 0`).

---

## 6. Sharpened prompt

Keep the existing structure and field set; sharpen for specificity. Guidance for the rewrite (final wording produced during implementation):

- **System:** Drop the "respond with ONLY a JSON array — no other text, no markdown fences" instruction entirely (structured outputs enforce format now). Keep the "content strategist for Instagram Reels, specific & actionable, reference the data" framing, and add: every idea must cite the specific source posts that inspired it, and the hook must be a scroll-stopping first-3-seconds line, not a topic label.
- **User:** Keep the 70/30 primary/secondary weighting and the "3–5 ideas" target. Sharpen the per-field asks:
  - `concept`: 2–3 sentences, concrete and producible this week (not generic advice).
  - `why_working`: tie to an observable pattern in the data (a recurring hook, format, or topic driving the high views/ER above), and say *why now*.
  - `hook_line`: the literal opening line for the first 3 seconds.
  - `source_posts`: 1–3 post URLs from the list above that most directly inspired the idea.

The prompt no longer needs to describe the JSON shape (the schema does), which frees prompt budget for sharper guidance.

---

## 7. Risks & verification

1. **SDK `output_config` passthrough (installed `@anthropic-ai/sdk` is `0.85.0`).** Stainless SDKs serialize the params object and send unknown body keys through, so `output_config` and `thinking` should reach the API even on 0.85.0. **Verify at implementation time** with one of: a `--debug`/raw-request inspection, or a single live smoke call against the real key. **Fallback:** if the API ignores or rejects `output_config` on 0.85.0, bump `@anthropic-ai/sdk` to latest (an existing-dep version bump, still "no new deps") and re-verify. The unit test covers the *params we pass*; this step covers *the wire*.
2. **Thinking budget vs. truncation.** With `effort: 'high'` + adaptive thinking, thinking tokens count against `max_tokens: 6000`. For a 3–5 idea task this is comfortable, but if `stop_reason: 'max_tokens'` shows up in practice, the `max_tokens` is the knob to raise. The code already degrades to a clear warning card on truncation rather than crashing.
3. **Structured-outputs availability on the account.** Supported on Opus 4.8 per the API; first call with a new schema pays a one-time compile latency, then 24h-cached. No action needed beyond awareness.

---

## 8. Testing approach

New file: `server/ai-agent.test.js`, using `node:test` + `node:assert` (matches the 6 existing `server/*.test.js` files; runs under `cd server && npm test`).

**Seam:** `_callClaude` does not touch `pool`. Construct `const agent = new ContentIdeaAgent('test-key')` (truthy key → `this.client` is created), then replace `agent.client` with a mock that records the params and returns a canned response:

```js
function mockClient(response) {
  const calls = [];
  return {
    calls,
    messages: { create: async (params) => { calls.push(params); return response; } }
  };
}
```

**Test cases:**
1. **Request params** — happy-path response; assert the recorded `create` params: `model === 'claude-opus-4-8'`, **no** `temperature`, `thinking.type === 'adaptive'`, `output_config.format.type === 'json_schema'`, `output_config.effort === 'high'`, `max_tokens === 6000`.
2. **Parses structured ideas** — response with a `text` block of `{"ideas":[...]}` (and a leading empty `thinking` block, to prove `.find(type==='text')` works); assert `ideas` parsed, capped at 5, `warning === null`.
3. **Refusal** — response `{ stop_reason: 'refusal', stop_details: {...}, content: [] }`; assert `ideas: []` and a non-null `warning`.
4. **Empty / no text block** — `content: []` or thinking-only; assert `ideas: []` + warning.
5. **Unparseable / truncated** — `stop_reason: 'max_tokens'` with a truncated text block; assert `ideas: []` + warning (no throw).

`generateIdeasForModel`'s DB writes are **not** unit-tested here (they need `pool`); the warning-card path is covered by reasoning + the existing integration test harness if extended later. Keeping the test on `_callClaude` keeps it network- and DB-free, matching the approved scope.

---

## 9. Summary of changes

| File | Change |
|------|--------|
| `server/ai-agent.js` | Rewrite `_callClaude`: Opus 4.8, drop `temperature`, adaptive thinking + effort high, `output_config.format` with `IDEAS_SCHEMA`, `max_tokens` 6000, sharpened prompts, refusal/empty/parse handling, return `{ ideas, warning }`, find text block via `.find(type==='text')`. Update the one caller (`generateIdeasForModel`) to write a warning card when `warning` is set. |
| `server/ai-agent.test.js` | New. 5 offline `node:test` cases with an injected mock client. |

No schema, no deps, no other files.
