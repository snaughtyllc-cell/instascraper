# Smarter AI Ideas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore and harden Instagram-Reels idea generation by migrating `_callClaude` off the retired Sonnet model to Opus 4.8 with structured outputs, and make every failure mode produce a visible warning card instead of a silent empty batch.

**Architecture:** All changes are contained to `server/ai-agent.js` plus one new offline unit test. `_callClaude` is rewritten to call `claude-opus-4-8` with adaptive thinking, `output_config.format` (JSON-schema-constrained output), and explicit refusal/empty/parse-failure handling; it returns `{ ideas, warning }`. Its single caller, `generateIdeasForModel`, consumes that shape — writing a warning card on `warning` and otherwise inserting ideas — while still always running the existing stale-niche warning loop.

**Tech Stack:** Node.js (CommonJS), `@anthropic-ai/sdk` (installed `0.85.0`), `node:test` + `node:assert` (no new test deps), PostgreSQL/SQLite via `server/db.js` (untouched).

## Global Constraints

Copied verbatim from the spec; every task's requirements implicitly include these.

- Model is exactly `claude-opus-4-8`.
- Do **not** send `temperature` / `top_p` / `top_k` (Opus 4.8 returns 400 on sampling params).
- Thinking: `thinking: { type: 'adaptive' }`.
- `output_config: { effort: 'high', format: { type: 'json_schema', schema: IDEAS_SCHEMA } }`.
- `max_tokens: 6000`. Non-streaming (safe below ~16K).
- No `idea_cards` schema changes. Card shape stays: `concept`, `format`, `why_working`, `hook_line`, `source_niche`, `source_posts` (→ `source_post_ids` column), `stale_warning`.
- No new npm dependencies. A version bump of the already-present `@anthropic-ai/sdk` is the only permitted dependency change, and only if Task 3 proves it necessary.
- Structured outputs cannot enforce array counts; "3–5 ideas" stays prompt guidance + `.slice(0, 5)`.
- Tests run via `cd server && npm test` (`node --test`).

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `server/ai-agent.js` | Idea generation: query content → call Claude → dedupe → write `idea_cards`. | Modify: add `IDEAS_SCHEMA`, rewrite `_callClaude`, update the `generateIdeasForModel` caller block. |
| `server/ai-agent.test.js` | Offline unit tests for `_callClaude` (mock client, no network, no DB). | Create. |

`server/db.js`, `server/scheduler.js`, `server/index.js` are **not** modified. (`require('./ai-agent')` transitively loads `db.js`, which only instantiates a DB handle at load — it does not connect or run `initDB` — and `_callClaude` never queries `pool`, so the unit test stays offline.)

---

## Task 1: Rewrite `_callClaude` with structured outputs + offline unit tests

**Files:**
- Modify: `server/ai-agent.js` (add `IDEAS_SCHEMA` const near top of module; rewrite `_callClaude`, currently lines 138–182)
- Test: `server/ai-agent.test.js` (create)

**Interfaces:**
- Consumes: `this.client.messages.create(params)` (Anthropic SDK); `posts` (array of post rows with `account_handle`, `niche`, `caption`, `view_count`, `like_count`, `er_percent`, `post_url`, `shortcode`), `model` (`{ name, primary_niche, secondary_niches }`), `staleNiches` (array; unused inside `_callClaude`, kept for signature stability).
- Produces: `_callClaude(posts, model, staleNiches) → Promise<{ ideas: Array<Idea>, warning: string | null }>` where `Idea = { concept, format, why_working, hook_line, source_niche, source_posts: string[] }`. Task 2 relies on this exact return shape.

- [ ] **Step 1: Write the failing test file**

Create `server/ai-agent.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const ContentIdeaAgent = require('./ai-agent');

// --- helpers -------------------------------------------------------------
function mockClient(response) {
  const calls = [];
  return { calls, messages: { create: async (params) => { calls.push(params); return response; } } };
}
function oneIdea(concept = 'Test concept') {
  return {
    concept,
    format: 'POV reel',
    why_working: 'Recurring hook pattern driving views',
    hook_line: 'Wait for it…',
    source_niche: 'fitness',
    source_posts: ['https://www.instagram.com/reel/abc/'],
  };
}
function happyResponse(ideas) {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ ideas }) }] };
}
function samplePost() {
  return {
    account_handle: 'creator', niche: 'fitness', caption: 'great workout',
    view_count: 1000, like_count: 100, er_percent: 5,
    post_url: 'https://www.instagram.com/reel/abc/', shortcode: 'abc',
  };
}
function sampleModel() {
  return { name: 'TestModel', primary_niche: 'fitness', secondary_niches: '' };
}
function agentWith(response) {
  const agent = new ContentIdeaAgent('test-key'); // truthy key → this.client is created
  const mock = mockClient(response);
  agent.client = mock; // replace real client with the mock
  return { agent, mock };
}

// --- tests ---------------------------------------------------------------
test('_callClaude sends Opus 4.8 with adaptive thinking, structured output, and no temperature', async () => {
  const { agent, mock } = agentWith(happyResponse([oneIdea()]));
  await agent._callClaude([samplePost()], sampleModel(), []);
  const params = mock.calls[0];
  assert.strictEqual(params.model, 'claude-opus-4-8');
  assert.strictEqual(params.temperature, undefined);
  assert.strictEqual(params.thinking.type, 'adaptive');
  assert.strictEqual(params.output_config.effort, 'high');
  assert.strictEqual(params.output_config.format.type, 'json_schema');
  assert.ok(params.output_config.format.schema, 'schema present');
  assert.strictEqual(params.max_tokens, 6000);
});

test('_callClaude parses structured ideas, caps at 5, and skips a leading thinking block', async () => {
  const six = Array.from({ length: 6 }, (_, i) => oneIdea(`concept ${i}`));
  const { agent } = agentWith({
    stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify({ ideas: six }) }],
  });
  const { ideas, warning } = await agent._callClaude([samplePost()], sampleModel(), []);
  assert.strictEqual(warning, null);
  assert.strictEqual(ideas.length, 5);
  assert.strictEqual(ideas[0].concept, 'concept 0');
});

test('_callClaude returns a warning (not a throw) on refusal', async () => {
  const { agent } = agentWith({ stop_reason: 'refusal', stop_details: { explanation: 'declined' }, content: [] });
  const { ideas, warning } = await agent._callClaude([samplePost()], sampleModel(), []);
  assert.deepStrictEqual(ideas, []);
  assert.ok(warning && warning.length > 0);
});

test('_callClaude returns a warning when there is no text block', async () => {
  const { agent } = agentWith({ stop_reason: 'end_turn', content: [] });
  const { ideas, warning } = await agent._callClaude([samplePost()], sampleModel(), []);
  assert.deepStrictEqual(ideas, []);
  assert.ok(warning);
});

test('_callClaude returns a warning on truncated/unparseable JSON without throwing', async () => {
  const { agent } = agentWith({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"ideas":[{"concept":"x"' }] });
  const { ideas, warning } = await agent._callClaude([samplePost()], sampleModel(), []);
  assert.deepStrictEqual(ideas, []);
  assert.ok(warning);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && node --test ai-agent.test.js`
Expected: FAIL. The current `_callClaude` returns a bare array (so `warning`/`ideas` destructure to `undefined`) and sends `model: 'claude-sonnet-4-20250514'` with `temperature: 0.8`; the thinking-first test throws a `TypeError` on `content[0].text`. Several assertions fail.

- [ ] **Step 3: Add `IDEAS_SCHEMA` and rewrite `_callClaude`**

In `server/ai-agent.js`, add the schema constant just below the `require` lines (above `class ContentIdeaAgent`):

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
          concept: { type: 'string' },
          format: { type: 'string' },
          why_working: { type: 'string' },
          hook_line: { type: 'string' },
          source_niche: { type: 'string' },
          source_posts: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};
```

Replace the entire `_callClaude` method (current lines 138–182) with:

```js
  async _callClaude(posts, model, staleNiches) {
    const secondaryText = model.secondary_niches
      ? ` (secondary niches: ${model.secondary_niches})`
      : '';

    const postList = posts.slice(0, 25).map((p, i) =>
      `${i + 1}. @${p.account_handle} [${p.niche || 'unknown'}] — ${(p.caption || '').slice(0, 120).replace(/\n/g, ' ')}... | Views: ${(p.view_count || 0).toLocaleString()} | Likes: ${(p.like_count || 0).toLocaleString()} | ER: ${p.er_percent || 0}% | URL: ${p.post_url || `https://www.instagram.com/reel/${p.shortcode}/`}`
    ).join('\n');

    const system = `You are a content strategist for Instagram Reels creators. You analyze trending content performance data and generate specific, producible content ideas — never generic advice. Ground every idea in observable patterns from the data you are given (recurring hooks, formats, or topics driving high views and engagement), and cite the specific source posts that inspired each idea. Each hook line must be a literal, scroll-stopping opening for the first 3 seconds — not a topic label.`;

    const userPrompt = `Generate 3-5 content ideas for ${model.name}, who creates "${model.primary_niche}" content${secondaryText}.

Here are the top-performing posts in their niche from the last 30 days:

${postList}

For each idea provide:
- concept: a specific, producible-this-week idea in 2-3 sentences (not generic advice).
- format: the production format (POV reel, talking head, trend audio, skit, duet, etc.).
- why_working: the observable pattern in the data above that makes this work right now, and why now (1-2 sentences).
- hook_line: the literal opening line for the first 3 seconds.
- source_niche: the niche this idea comes from ("${model.primary_niche}"${model.secondary_niches ? ` or one of: ${model.secondary_niches}` : ''}).
- source_posts: 1-3 post URLs from the list above that most directly inspired this idea.

Weight "${model.primary_niche}" content (70%) over secondary niches (30%). Focus on recurring themes, hooks, formats, and topics driving high engagement in the data.`;

    let response;
    try {
      response = await this.client.messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 6000,
        thinking: { type: 'adaptive' },
        output_config: {
          effort: 'high',
          format: { type: 'json_schema', schema: IDEAS_SCHEMA },
        },
        system,
        messages: [{ role: 'user', content: userPrompt }],
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

    // With adaptive thinking, content[0] may be a thinking block — find the text block.
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
      console.error('[AI Agent] Failed to parse structured response:', textBlock.text.slice(0, 200));
      return { ideas: [], warning: 'Idea generation returned malformed data. Try again.' };
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && node --test ai-agent.test.js`
Expected: PASS, 5 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add server/ai-agent.js server/ai-agent.test.js
git commit -m "feat(ai-agent): Opus 4.8 + structured outputs in _callClaude, with refusal/empty handling

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Consume `{ ideas, warning }` in `generateIdeasForModel`

**Files:**
- Modify: `server/ai-agent.js` (the `generateIdeasForModel` body, current lines 41–68)

**Interfaces:**
- Consumes: `_callClaude(...) → { ideas, warning }` (Task 1).
- Produces: no signature change to `generateIdeasForModel`; return value gains an optional `warning` field on the failure path.

**Note on testing:** this path writes to `pool`, so it is verified by (a) the full existing suite staying green — this change must not break any current test — and (b) code review against the rule below. It is intentionally not unit-tested here (keeping Task 1's test offline and DB-free, per the spec).

- [ ] **Step 1: Replace the post-`_callClaude` block**

In `server/ai-agent.js`, the current block is:

```js
    // Call Claude to generate ideas
    const ideas = await this._callClaude(allPosts, model, staleNiches);

    // Deduplicate against previous ideas
    const freshIdeas = await this._deduplicateIdeas(modelId, ideas);

    // Store idea cards
    for (const idea of freshIdeas) {
      await pool.query(
        `INSERT INTO idea_cards (model_id, batch_id, concept, format, why_working, hook_line, source_niche, source_post_ids, stale_warning)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [modelId, batchId, idea.concept, idea.format || '', idea.why_working || '',
         idea.hook_line || '', idea.source_niche || model.primary_niche,
         Array.isArray(idea.source_posts) ? idea.source_posts.join(',') : (idea.source_post_ids || ''), idea.stale_warning || null]
      );
    }
```

Replace it with (note: the stale-niche loop that follows it, current lines 57–65, stays exactly as-is and now runs on both paths):

```js
    // Call Claude to generate ideas
    const { ideas, warning } = await this._callClaude(allPosts, model, staleNiches);

    let freshIdeas = [];
    if (warning) {
      // Surface the failure as a clear warning card instead of silently storing nothing.
      await pool.query(
        `INSERT INTO idea_cards (model_id, batch_id, concept, format, why_working, hook_line, source_niche, stale_warning, status)
         VALUES ($1, $2, $3, '', '', '', $4, $5, 'pending')`,
        [modelId, batchId, warning, model.primary_niche, warning]
      );
    } else {
      // Deduplicate against previous ideas
      freshIdeas = await this._deduplicateIdeas(modelId, ideas);

      // Store idea cards
      for (const idea of freshIdeas) {
        await pool.query(
          `INSERT INTO idea_cards (model_id, batch_id, concept, format, why_working, hook_line, source_niche, source_post_ids, stale_warning)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [modelId, batchId, idea.concept, idea.format || '', idea.why_working || '',
           idea.hook_line || '', idea.source_niche || model.primary_niche,
           Array.isArray(idea.source_posts) ? idea.source_posts.join(',') : (idea.source_post_ids || ''), idea.stale_warning || null]
        );
      }
    }
```

Then update the final `return` of `generateIdeasForModel` (current line 68) from:

```js
    return { batchId, ideaCount: freshIdeas.length, staleNiches };
```

to:

```js
    return { batchId, ideaCount: freshIdeas.length, staleNiches, warning: warning || undefined };
```

(The stale-niche warning loop on lines 57–65 and the `console.log` on line 67 are unchanged and remain between the block above and this return.)

- [ ] **Step 2: Run the full suite to verify no regression**

Run: `cd server && npm test`
Expected: PASS. All previously-passing tests (21 from Sub-A) plus the 5 from Task 1 still pass; no new failures.

- [ ] **Step 3: Commit**

```bash
git add server/ai-agent.js
git commit -m "feat(ai-agent): write a warning card on generation failure; preserve stale-niche warnings

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Verify `output_config` reaches the wire (live, gated)

**Files:** none (verification only).

**Why:** the unit test proves the params we *pass*; this proves the installed `@anthropic-ai/sdk@0.85.0` actually *transmits* `output_config` and the API honors it on Opus 4.8. Stainless SDKs pass unknown body keys through, so this is expected to succeed — but it must be confirmed before relying on it in prod.

- [ ] **Step 1: Run a live smoke call (requires a real `ANTHROPIC_API_KEY`)**

Run (logs the outgoing request body via `ANTHROPIC_LOG=debug`):

```bash
cd server && ANTHROPIC_LOG=debug node -e '
const A = require("@anthropic-ai/sdk");
const c = new A({ apiKey: process.env.ANTHROPIC_API_KEY });
c.messages.create({
  model: "claude-opus-4-8", max_tokens: 200,
  thinking: { type: "adaptive" },
  output_config: { effort: "high", format: { type: "json_schema",
    schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } } } },
  messages: [{ role: "user", content: "Return {\"ok\":true}" }],
}).then(r => console.log("OK stop_reason=", r.stop_reason, JSON.stringify(r.content)))
  .catch(e => console.error("FAILED", e.status, e.message));
'
```

Expected: prints `OK stop_reason= end_turn [{"type":"text","text":"{\"ok\":true}"}]` (a thinking block may precede the text block), and the debug log shows `output_config` in the request body. No 400 mentioning `output_config`.

- [ ] **Step 2: If — and only if — the API rejects `output_config` on 0.85.0, bump the SDK and re-verify**

```bash
cd server && npm install @anthropic-ai/sdk@latest && cd server && npm test
```

Then re-run Step 1. (Bumping the existing dependency is permitted by the Global Constraints; adding a *new* dependency is not.)

- [ ] **Step 3: Record the outcome**

No commit unless Step 2 changed `package.json`/`package-lock.json`; if so:

```bash
git add server/package.json server/package-lock.json
git commit -m "chore(ai-agent): bump @anthropic-ai/sdk to transmit output_config

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Decision #1 (Opus 4.8) → Task 1 Step 3 + test assert. ✓
- Decision #1b (remove `temperature`) → Task 1 Step 3 (omitted) + test asserts `undefined`. ✓
- Decision #2 (adaptive thinking + effort high) → Task 1 Step 3 + test asserts. ✓
- Decision #3 (structured outputs, `IDEAS_SCHEMA`) → Task 1 Step 3 + test asserts `format.type==='json_schema'`. ✓
- Decision #4 (`max_tokens` 6000) → Task 1 Step 3 + test asserts. ✓
- Decision #5 (sharpened prompt) → Task 1 Step 3 (full `system` + `userPrompt`). ✓
- Decision #6 (refusal/empty → warning card, not silent) → Task 1 Step 3 (refusal/empty/parse branches return `warning`) + Task 2 (writes the card) + 3 warning tests. ✓
- Decision #7 (unit test, mock client, offline) → Task 1 test file, 5 cases. ✓
- Spec §5 stale-niche fall-through (CX-002 fix) → Task 2 Step 1 (loop stays on both paths; explicit note). ✓
- Spec §7 SDK passthrough verification → Task 3. ✓
- Spec "no schema / no deps" → Global Constraints + Task 2 reuses existing columns; Task 3 bump gated. ✓

**2. Placeholder scan:** No `TBD`/`TODO`/"add error handling"/"similar to Task N". Every code step shows full code; prompts are literal, not "to be written". ✓

**3. Type consistency:** `_callClaude` returns `{ ideas, warning }` in Task 1 and is destructured as `{ ideas, warning }` in Task 2. `IDEAS_SCHEMA` defined once (Task 1) and referenced by name in `_callClaude`. Idea fields (`concept`/`format`/`why_working`/`hook_line`/`source_niche`/`source_posts`) match the schema, the insert columns, and the test fixtures. ✓
