# Targeted Suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Suggested Accounts surface female creator competitors (drop male, park unknown), score by collab strength, and let staff bulk-approve (as `paused`) and bulk-scrape (budget-gated).

**Architecture:** Add a set of **pure, unit-tested** discovery helpers to `scraper.js` (keyword gender classification, batch-response parsing, candidate aggregation with collab strength, scoring, female-first ordering). Wire them into the two existing discovery functions (`discoverRelated`, `runDiscovery`), then add the approve/scrape route changes and the frontend. One new column (`suggested_accounts.gender`). The "Scrape now respects the budget cap" guarantee reuses the base branch's `startScrapeJob` budget gate.

**Tech Stack:** Node.js (CommonJS), `node-fetch`, `@anthropic-ai/sdk` (Haiku classifier, already a dep), PostgreSQL/SQLite via `server/db.js`, `node:test` + `node:assert` + `better-sqlite3`. React/Tailwind client. No new dependencies.

## Global Constraints

- Base branch: `targeted-suggestions`, off current `main` (which already includes the merged cost-control budget gate from PR #3, plus PR #2). Bulk "Scrape now" reuses `startScrapeJob`'s budget gate — already present in `main`.
- Only ADD the `suggested_accounts.gender` column. No other schema change; no existing column repurposed.
- No new npm dependencies.
- "Unknown" gender is **never** treated as female: male is dropped, female ranks first, unknown ranks below all female (read-time tier).
- Gender classification must **never throw**: no Anthropic key or any error → affected candidates stay `'unknown'`.
- Discovery sources are caption `@mentions` + tagged/collab users **only**. The hashtag-overlap source is removed.
- Approvals insert `tracked_accounts` with `status = 'paused'`. Scraping is a separate, explicit, budget-gated action.
- Accounting/discovery failures must never break the run: per-candidate and per-account work is wrapped so a failure logs and continues.
- Tests run via `cd server && npm test` (`node --test`).

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `server/db.js` | Schema. | Add `gender` column to the `suggested_accounts` migration list. |
| `server/scraper.js` | Apify scraping + (new) discovery helpers + `discoverRelated`. | Add pure helpers (Task 1); rewire `_classifyGender`/`discoverRelated` (Task 2). |
| `server/scheduler.js` | Cron jobs. | `runDiscovery` aggregation + scoring + store `gender` (Task 3). |
| `server/index.js` | HTTP routes. | Female-first ordering, approve→paused, `approve-bulk` (Task 4); `scrape-bulk` (Task 5). |
| `server/targeted-suggestions.test.js` | Unit tests for the pure helpers. | Create (Task 1). |
| `client/src/api.js` | API client. | Add bulk endpoints (Task 6). |
| `client/src/pages/SuggestedAccountsTab.js` | Suggested UI. | Badges, unclassified expander, multi-select bulk approve/scrape (Task 6). |

---

## Task 1: Discovery precision data layer (column + pure helpers + tests)

**Files:**
- Modify: `server/db.js` (add `gender` to the `suggested_accounts` migrations)
- Modify: `server/scraper.js` (add pure functions after `calcER`/`extractUsageUsd` near the top; export at the bottom next to the cost exports)
- Test: `server/targeted-suggestions.test.js` (create)

**Interfaces — Produces (later tasks rely on these exact signatures):**
- `classifyGenderKeyword(username, bio) → 'female' | 'male' | 'unknown'`
- `parseGenderBatch(text, usernames) → { [usernameLower]: 'female'|'male'|'unknown' }`
- `scoreCandidate({ collabStrength, avgEr, postsPerWeek }) → number` (0–100 integer)
- `genderRank(gender) → 0 | 1` (0 for `'female'`, else 1)
- `aggregateCandidates(rawList) → Array<candidate & { collabStrength, relevanceReason }>`
- `suggestionsOrderClause(sort) → string` (SQL `ORDER BY` body, female-first)

- [ ] **Step 1: Add the `gender` column to `db.js`**

In `server/db.js`, the migration arrays add columns in both modes. Add a `gender` line to **both** the Postgres list (the `ADD COLUMN IF NOT EXISTS` block, ~line 270) and the sqlite fallback list (the `ADD COLUMN` block, ~line 281), matching the existing pattern:

Postgres block — add:
```js
      `ALTER TABLE suggested_accounts ADD COLUMN IF NOT EXISTS gender TEXT DEFAULT 'unknown'`,
```
sqlite block — add:
```js
      `ALTER TABLE suggested_accounts ADD COLUMN gender TEXT DEFAULT 'unknown'`,
```

- [ ] **Step 2: Write the failing test file**

Create `server/targeted-suggestions.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const scraper = require('./scraper');

const {
  classifyGenderKeyword, parseGenderBatch, scoreCandidate, genderRank,
  aggregateCandidates, suggestionsOrderClause,
} = scraper;

test('classifyGenderKeyword: pronouns win over keywords', () => {
  assert.strictEqual(classifyGenderKeyword('jane', 'she/her | dancer'), 'female');
  assert.strictEqual(classifyGenderKeyword('mike', 'he/him'), 'male');
});

test('classifyGenderKeyword: keyword signals', () => {
  assert.strictEqual(classifyGenderKeyword('queenbee', 'lady boss'), 'female');
  assert.strictEqual(classifyGenderKeyword('thatguy', 'just a dad'), 'male');
});

test('classifyGenderKeyword: ambiguous/empty → unknown', () => {
  assert.strictEqual(classifyGenderKeyword('user123', ''), 'unknown');
  assert.strictEqual(classifyGenderKeyword('alex', 'creator | she and he collab'), 'unknown'); // both signals
});

test('parseGenderBatch: maps verdicts, defaults missing to unknown', () => {
  const text = '{"verdicts":[{"username":"Aimee","gender":"female"},{"username":"bob","gender":"male"}]}';
  const out = parseGenderBatch(text, ['aimee', 'bob', 'casey']);
  assert.strictEqual(out.aimee, 'female');
  assert.strictEqual(out.bob, 'male');
  assert.strictEqual(out.casey, 'unknown'); // not in response
});

test('parseGenderBatch: tolerates junk/empty without throwing', () => {
  assert.deepStrictEqual(parseGenderBatch('not json', ['x']), { x: 'unknown' });
  assert.deepStrictEqual(parseGenderBatch('', ['x']), { x: 'unknown' });
  assert.deepStrictEqual(parseGenderBatch(null, ['x']), { x: 'unknown' });
});

test('scoreCandidate: collab strength, ER, frequency combine and cap', () => {
  assert.strictEqual(scoreCandidate({ collabStrength: 3, avgEr: 6, postsPerWeek: 5 }), 100);
  assert.strictEqual(scoreCandidate({ collabStrength: 1, avgEr: 0, postsPerWeek: 0 }), 17); // 50/3 rounded
  assert.ok(scoreCandidate({ collabStrength: 9, avgEr: 99, postsPerWeek: 99 }) === 100); // capped
});

test('genderRank: female ranks above everything else', () => {
  assert.strictEqual(genderRank('female'), 0);
  assert.strictEqual(genderRank('unknown'), 1);
  assert.strictEqual(genderRank('male'), 1);
});

test('aggregateCandidates: merges by username, counts distinct sources', () => {
  const merged = aggregateCandidates([
    { username: 'aimee', sourceAccount: 'creatorA', avgEr: 3, gender: 'female' },
    { username: 'Aimee', sourceAccount: 'creatorB', avgEr: 5, gender: 'unknown' },
    { username: 'bob', sourceAccount: 'creatorA', avgEr: 1, gender: 'male' },
  ]);
  const aimee = merged.find(c => c.username.toLowerCase() === 'aimee');
  assert.strictEqual(aimee.collabStrength, 2);
  assert.strictEqual(aimee.avgEr, 5);            // max kept
  assert.strictEqual(aimee.gender, 'female');    // confident verdict kept over unknown
  assert.match(aimee.relevanceReason, /2 of your creators/);
  const bob = merged.find(c => c.username.toLowerCase() === 'bob');
  assert.strictEqual(bob.collabStrength, 1);
});

test('suggestionsOrderClause: female-first, then the chosen sort', () => {
  assert.match(suggestionsOrderClause('score'), /gender = 'female'/);
  assert.match(suggestionsOrderClause('score'), /suggestion_score DESC/);
  assert.match(suggestionsOrderClause('er'), /avg_er DESC/);
  assert.match(suggestionsOrderClause('bogus'), /suggestion_score DESC/); // fallback
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && node --test targeted-suggestions.test.js`
Expected: FAIL — the imported helpers are `undefined`, so calls throw `TypeError`.

- [ ] **Step 4: Implement the pure helpers in `scraper.js`**

In `server/scraper.js`, after the cost helpers near the top (after `extractUsageUsd`, before `async function budgetStatus` is fine — anywhere at module scope above `class InstagramScraper`), add:

```js
// ── Targeted Suggestions: discovery precision helpers (pure) ──
const FEMALE_WORDS = /\b(woman|women|girl|girls|female|wife|mom|mama|mother|daughter|sister|gal|lady|ladies|miss|mrs|ms\.|queen|princess)\b/;
const MALE_WORDS = /\b(man|men|guy|guys|male|husband|dad|daddy|father|son|brother|king|prince|mr\.|sir|bro)\b/;

function classifyGenderKeyword(username, bio) {
  const text = `${username} ${bio || ''}`.toLowerCase();
  const femalePronouns = /\b(she\/her|she\s*\/\s*her|her\/she|she-her)\b/.test(text);
  const malePronouns = /\b(he\/him|he\s*\/\s*him|him\/he|he-him)\b/.test(text);
  if (femalePronouns && !malePronouns) return 'female';
  if (malePronouns && !femalePronouns) return 'male';
  const f = FEMALE_WORDS.test(text);
  const m = MALE_WORDS.test(text);
  if (f && !m) return 'female';
  if (m && !f) return 'male';
  return 'unknown';
}

function parseGenderBatch(text, usernames) {
  const out = {};
  for (const u of usernames) out[String(u).toLowerCase()] = 'unknown';
  if (!text) return out;
  let data;
  try {
    const block = (String(text).match(/\{[\s\S]*\}/) || [String(text)])[0];
    data = JSON.parse(block);
  } catch { return out; }
  const list = Array.isArray(data) ? data : (Array.isArray(data.verdicts) ? data.verdicts : []);
  for (const v of list) {
    const u = String((v && (v.username || v.user)) || '').toLowerCase();
    const g = String((v && v.gender) || '').toLowerCase();
    if (u in out && (g === 'female' || g === 'male')) out[u] = g;
  }
  return out;
}

function scoreCandidate({ collabStrength = 1, avgEr = 0, postsPerWeek = 0 } = {}) {
  const relevancePts = Math.min(collabStrength / 3, 1) * 50;
  const erPts = Math.min((avgEr || 0) / 6, 1) * 30;
  const freqPts = Math.min((postsPerWeek || 0) / 5, 1) * 20;
  return Math.round(relevancePts + erPts + freqPts);
}

function genderRank(gender) {
  return gender === 'female' ? 0 : 1;
}

function aggregateCandidates(rawList) {
  const map = new Map();
  for (const c of rawList || []) {
    const key = String(c.username).toLowerCase();
    if (!map.has(key)) {
      map.set(key, { ...c, sources: new Set([c.sourceAccount].filter(Boolean)) });
    } else {
      const ex = map.get(key);
      if (c.sourceAccount) ex.sources.add(c.sourceAccount);
      ex.followers = Math.max(ex.followers || 0, c.followers || 0);
      ex.avgEr = Math.max(ex.avgEr || 0, c.avgEr || 0);
      ex.postsPerWeek = Math.max(ex.postsPerWeek || 0, c.postsPerWeek || 0);
      if (!ex.bio && c.bio) ex.bio = c.bio;
      if (ex.gender === 'unknown' && c.gender && c.gender !== 'unknown') ex.gender = c.gender;
      if (!ex.captionSnippet && c.captionSnippet) ex.captionSnippet = c.captionSnippet;
    }
  }
  return [...map.values()].map((c) => {
    const collabStrength = c.sources.size || 1;
    const relevanceReason = collabStrength > 1
      ? `Collab'd with ${collabStrength} of your creators`
      : (c.relevanceReason || 'Tagged by a tracked creator');
    return { ...c, collabStrength, relevanceReason };
  });
}

function suggestionsOrderClause(sort) {
  const sortMap = { score: 'suggestion_score DESC', er: 'avg_er DESC', followers: 'followers DESC', newest: 'discovered_at DESC' };
  const tail = sortMap[sort] || 'suggestion_score DESC';
  return `CASE WHEN gender = 'female' THEN 0 ELSE 1 END, ${tail}`;
}
```

Then at the bottom of the file, alongside the existing cost exports (`module.exports.budgetStatus = ...`), append:

```js
module.exports.classifyGenderKeyword = classifyGenderKeyword;
module.exports.parseGenderBatch = parseGenderBatch;
module.exports.scoreCandidate = scoreCandidate;
module.exports.genderRank = genderRank;
module.exports.aggregateCandidates = aggregateCandidates;
module.exports.suggestionsOrderClause = suggestionsOrderClause;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && node --test targeted-suggestions.test.js`
Expected: PASS (all). Then `cd server && npm test` → full suite still green.

- [ ] **Step 6: Commit**

```bash
git add server/db.js server/scraper.js server/targeted-suggestions.test.js
git commit -m "feat(discovery): gender column + precision/scoring helpers (tested)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Rewire `discoverRelated` — batch classify, cut hashtags, drop male

**Files:** Modify `server/scraper.js` (`_classifyGender`, new `_classifyGenderBatch`, `discoverRelated`).

**Interfaces — Consumes (Task 1):** `classifyGenderKeyword`, `parseGenderBatch`. **Produces:** `discoverRelated(username)` returns candidates each carrying `{ username, sourceAccount, captionSnippet, gender, avgEr, postsPerWeek, followers, bio, relevanceReason }`, with `gender === 'male'` excluded.

**Verification note:** these are live Apify/Anthropic paths (no unit harness in this repo, per the existing convention). Verification is code review against this task + `cd server && npm test` staying green; the pure logic they call is already unit-tested in Task 1.

- [ ] **Step 1: Make `_classifyGender` delegate to the keyword helper**

Replace the keyword block at the top of `_classifyGender` (the pronoun + `femaleWords`/`maleWords` logic, [scraper.js:136-149](../../../server/scraper.js)) with a single call, keeping the AI fallback below it:

```js
  async _classifyGender(username, bio) {
    const keyword = classifyGenderKeyword(username, bio);
    if (keyword !== 'unknown') return keyword;

    // Fall back to AI classifier
    const client = this._getAnthropic();
    if (!client) return 'unknown';
    // ... existing single-call AI block stays as-is ...
  }
```

(The single-call `_classifyGender` is retained for any other caller; `discoverRelated` will use the batch path below.)

- [ ] **Step 2: Add `_classifyGenderBatch`**

Add this method to the class (near `_classifyGender`):

```js
  // Classify many candidates in ONE call. items: [{ username, bio, captionSnippet, taggedBy }].
  // Returns { usernameLower: 'female'|'male'|'unknown' }. Never throws.
  async _classifyGenderBatch(items) {
    const result = {};
    const remaining = [];
    for (const it of items) {
      const kw = classifyGenderKeyword(it.username, it.bio);
      if (kw !== 'unknown') result[it.username.toLowerCase()] = kw;
      else remaining.push(it);
    }
    if (remaining.length === 0) return result;

    const client = this._getAnthropic();
    if (!client) {
      for (const it of remaining) result[it.username.toLowerCase()] = 'unknown';
      return result;
    }

    const t0 = Date.now();
    try {
      const lines = remaining.map((it, i) =>
        `${i + 1}. username: ${it.username} | bio: ${it.bio || '(none)'} | seen in caption: ${(it.captionSnippet || '').slice(0, 120) || '(none)'} | tagged by: ${it.taggedBy || '(none)'}`
      ).join('\n');
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        temperature: 0,
        system: 'You classify the likely gender of Instagram creators for a female-creator competitor list. Respond with ONLY JSON: {"verdicts":[{"username":"<as given>","gender":"female|male|unknown"}]}. Use "unknown" when unsure — do not guess.',
        messages: [{ role: 'user', content: `Classify each creator:\n${lines}` }],
      });
      const text = (response.content || []).map(b => b.text || '').join('');
      const verdicts = parseGenderBatch(text, remaining.map(it => it.username));
      Object.assign(result, verdicts);
    } catch (err) {
      console.log(`[Gender] Batch classify failed: ${err.message}`);
      for (const it of remaining) if (!(it.username.toLowerCase() in result)) result[it.username.toLowerCase()] = 'unknown';
    }
    console.log(`[Metric] classify_batch n=${remaining.length} ms=${Date.now() - t0}`);
    return result;
  }
```

- [ ] **Step 3: Remove the hashtag-overlap source from `discoverRelated`**

Delete the entire **"Phase 1b"** block ([scraper.js:498-534](../../../server/scraper.js)) — from the `// Phase 1b: Find accounts that share hashtags...` comment through the closing brace of `if (commonHashtags.length > 0) { ... }`. Caption mentions (Phase 1) and Phase 2 stay.

- [ ] **Step 4: Carry source + caption context on each candidate**

In the two caption-mention loops ([:488-493](../../../server/scraper.js) and [:557-562](../../../server/scraper.js)) and the tagged-users loop ([:571-576](../../../server/scraper.js)), add `sourceAccount: username` and `captionSnippet` to each pushed candidate. For caption mentions use the caption they were found in; for tagged users use the item caption. Example for the Phase 1 mention push:

```js
          candidates.push({
            username: handle,
            source: `mentioned_by:${username}`,
            sourceAccount: username,
            captionSnippet: (post.caption || '').slice(0, 160),
            relevanceReason: `Tagged by @${username}`,
            relevanceScore: 35,
          });
```

Apply the analogous `sourceAccount` + `captionSnippet` additions to the Phase 2 mention push (use `item.caption`) and the tagged-users push (use `item.caption`).

- [ ] **Step 5: Replace the per-candidate gender filter with the batch path**

Replace the gender-filter block ([scraper.js:649-661](../../../server/scraper.js), the `for (const c of filtered) { const gender = await this._classifyGender(...) ...}` loop) with:

```js
    // Gender: classify the whole batch once; drop male, keep female + unknown (unknown parks at read time).
    console.log(`[Discovery] Classifying gender for ${filtered.length} candidates...`);
    const verdicts = await this._classifyGenderBatch(
      filtered.map(c => ({ username: c.username, bio: c.bio || '', captionSnippet: c.captionSnippet, taggedBy: c.sourceAccount }))
    );
    const genderResults = [];
    for (const c of filtered) {
      const gender = verdicts[c.username.toLowerCase()] || 'unknown';
      if (gender === 'male') { console.log(`[Discovery] Filtered out @${c.username} (male)`); continue; }
      c.gender = gender;
      genderResults.push(c);
    }
    filtered = genderResults;
```

- [ ] **Step 6: Verify no regression and commit**

Run: `cd server && npm test`
Expected: all tests pass (no new tests here; logic covered by Task 1). Code-review that the hashtag source is gone, every candidate carries `sourceAccount`/`captionSnippet`/`gender`, and male is dropped.

```bash
git add server/scraper.js
git commit -m "feat(discovery): batch gender classify with caption context, cut hashtag source, drop male

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Rewire `runDiscovery` — aggregate, score, store gender

**Files:** Modify `server/scheduler.js` (`runDiscovery`).

**Interfaces — Consumes (Tasks 1–2):** `aggregateCandidates`, `scoreCandidate` (from `./scraper`); `discoverRelated` candidates now carry `sourceAccount`/`gender`. **Produces:** `suggested_accounts` rows with a real `gender` and a collab-strength-based `suggestion_score`.

**Verification note:** orchestration over the Task 1 pure functions (unit-tested) + a DB insert. Verification is code review + `cd server && npm test` green.

- [ ] **Step 1: Import the helpers**

At the top of `server/scheduler.js`, extend the existing scraper require (currently `const { BudgetExceededError } = require('./scraper');`) to:

```js
const { BudgetExceededError, aggregateCandidates, scoreCandidate } = require('./scraper');
```

- [ ] **Step 2: Collect candidates with their source, then aggregate + score + store**

Replace the body of `runDiscovery`'s candidate gathering + insert (the loop that builds `candidates` and the `for (const item of candidates.slice(0, 30))` insert loop, [scheduler.js:106-125](../../../server/scheduler.js)) with:

```js
    let raw = [];
    for (const account of trackedResult.rows.slice(0, 5)) {
      try {
        const related = await scraperInstance.discoverRelated(account.username);
        for (const profile of related) {
          if (!existing.has(profile.username)) raw.push({ ...profile, sourceAccount: profile.sourceAccount || account.username });
        }
      } catch (err) { console.error(`[Discovery] Failed for @${account.username}:`, err.message); }
      await new Promise(r => setTimeout(r, 10000));
    }

    const aggregated = aggregateCandidates(raw);
    const female = aggregated.filter(c => c.gender === 'female').length;
    const unknown = aggregated.filter(c => c.gender !== 'female').length;
    console.log(`[Metric] discovery candidates=${aggregated.length} female=${female} unknown=${unknown}`);

    let added = 0;
    for (const item of aggregated.slice(0, 50)) {
      if (existing.has(item.username)) continue;
      existing.add(item.username);
      const totalScore = scoreCandidate({ collabStrength: item.collabStrength, avgEr: item.avgEr, postsPerWeek: item.postsPerWeek });
      try {
        await pool.query(
          `INSERT INTO suggested_accounts (username, source, followers, avg_er, posts_per_week, bio, content_breakdown, top_hashtags, relevance_reason, suggestion_score, gender)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (username) DO NOTHING`,
          [item.username, item.source || 'discovery', item.followers || 0, item.avgEr || 0, item.postsPerWeek || 0,
           item.bio || '', item.contentBreakdown || '', item.topHashtags || '', item.relevanceReason || '', totalScore, item.gender || 'unknown']
        );
        added++;
      } catch (e) { /* skip */ }
    }
```

(Note: the candidate-level de-dup against `existing` — tracked + already-suggested usernames — happens *before* aggregation when pushing to `raw`, and again at insert; collab strength is computed across the `raw` list so a candidate surfaced by several creators still counts each.)

- [ ] **Step 3: Verify no regression and commit**

Run: `cd server && npm test`
Expected: all green. Code-review that rows now carry `gender` and a collab-strength score, and the `[Metric] discovery` line prints counts.

```bash
git add server/scheduler.js
git commit -m "feat(discovery): aggregate by collab strength, gender-aware score, store gender

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Female-first ordering + approve→paused + bulk approve

**Files:** Modify `server/index.js` (`GET /suggested`, `POST /suggested/:username/approve`, new `POST /suggested/approve-bulk`).

**Interfaces — Consumes (Task 1):** `suggestionsOrderClause` (from `./scraper`). **Produces:** female-first suggestion list; approvals insert Tracked as `paused`; a bulk approve endpoint.

**Verification note:** route wiring; `suggestionsOrderClause` is unit-tested in Task 1. Verification is code review + `cd server && npm test` green.

- [ ] **Step 1: Import `suggestionsOrderClause`**

Near the top of `server/index.js`, where `scraper` exports are pulled in (the file already does `const { BudgetExceededError, usageSummary } = require('./scraper');` from the base branch), extend it:

```js
const { BudgetExceededError, usageSummary, suggestionsOrderClause } = require('./scraper');
```

- [ ] **Step 2: Female-first ordering in `GET /suggested`**

In `GET /suggested` ([index.js:275-285](../../../server/index.js)), replace the `sortMap`/`orderBy` lines with the helper:

```js
  const orderBy = suggestionsOrderClause(sort);
  const result = await pool.query(`SELECT * FROM suggested_accounts ${where} ORDER BY ${orderBy}`, params);
```

- [ ] **Step 3: Approve inserts Tracked as `paused` (single)**

In `POST /suggested/:username/approve` ([index.js:294](../../../server/index.js)), change the tracked insert to set `status = 'paused'`:

```js
    await pool.query(
      `INSERT INTO tracked_accounts (username, status, tags, followers, bio, avg_er) VALUES ($1, 'paused', $2, $3, $4, $5)`,
      [username, 'discovered', s.followers || 0, s.bio || '', s.avg_er || 0]
    );
```

- [ ] **Step 4: Add `POST /suggested/approve-bulk`**

Add after the single approve route:

```js
app.post('/suggested/approve-bulk', async (req, res) => {
  const usernames = Array.isArray(req.body?.usernames) ? req.body.usernames : [];
  let approved = 0;
  for (const username of usernames) {
    try {
      const suggestion = await pool.query('SELECT * FROM suggested_accounts WHERE username = $1', [username]);
      if (suggestion.rows.length === 0) continue;
      const s = suggestion.rows[0];
      await pool.query("UPDATE suggested_accounts SET status = 'approved', reviewed_at = TO_CHAR(NOW(), 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') WHERE username = $1", [username]);
      try {
        await pool.query(
          `INSERT INTO tracked_accounts (username, status, tags, followers, bio, avg_er) VALUES ($1, 'paused', $2, $3, $4, $5)`,
          [username, 'discovered', s.followers || 0, s.bio || '', s.avg_er || 0]
        );
      } catch (e) { /* already tracked */ }
      approved++;
    } catch (e) { console.error(`[Suggested] bulk approve failed for ${username}:`, e.message); }
  }
  res.json({ approved, total: usernames.length, status: 'paused' });
});
```

(`req.body` is available — `express.json()` is mounted at [index.js:30](../../../server/index.js); the `/suggested` prefix is already behind `requireAuth` at [index.js:81](../../../server/index.js).)

- [ ] **Step 5: Verify and commit**

Run: `cd server && npm test`
Expected: all green. Code-review: list is female-first; single + bulk approve insert `status='paused'`.

```bash
git add server/index.js
git commit -m "feat(suggested): female-first ordering, approve as paused, bulk approve

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Bulk "Scrape now" (budget-gated, partial result)

**Files:** Modify `server/index.js` (new `POST /tracked/scrape-bulk`).

**Interfaces — Consumes:** `scraper.startScrapeJob` (budget-gated + collision-guarded on the base branch), `BudgetExceededError`. **Produces:** a budget-aware bulk scrape that stops cleanly when over budget and reports a partial result.

**Verification note:** route wiring over the already-budget-gated `startScrapeJob`. Verification is code review + `cd server && npm test` green.

- [ ] **Step 1: Add `POST /tracked/scrape-bulk`**

Add near the other `/tracked` routes in `server/index.js`:

```js
app.post('/tracked/scrape-bulk', async (req, res) => {
  const usernames = Array.isArray(req.body?.usernames) ? req.body.usernames : [];
  const results = [];
  let stopped = null;
  for (const username of usernames) {
    try {
      const r = await scraper.startScrapeJob({ query: username, queryType: 'username', minLikes: null, minViews: null, startDate: null, endDate: null, source: 'manual' });
      // also un-pause so the account stays in the active rotation once a manual scrape ran
      await pool.query("UPDATE tracked_accounts SET status = 'active' WHERE username = $1", [username]);
      results.push({ username, ...(r && r.skipped ? { skipped: true } : { status: 'running' }) });
    } catch (err) {
      if (err instanceof BudgetExceededError) { stopped = { username, message: err.message }; break; }
      results.push({ username, error: err.message });
    }
  }
  res.json({ started: results.filter(r => r.status === 'running').length, results, stopped });
});
```

(Decision: a manual bulk scrape flips the account to `active` so it joins the normal rotation afterward — staff explicitly chose to scrape it. The budget gate inside `startScrapeJob` still governs cost, and the loop stops at the first `BudgetExceededError` with a clear `stopped` payload.)

- [ ] **Step 2: Verify and commit**

Run: `cd server && npm test`
Expected: all green. Code-review: the loop stops on `BudgetExceededError` and returns `stopped`; non-budget errors are per-item and don't abort the batch.

```bash
git add server/index.js
git commit -m "feat(tracked): budget-gated bulk scrape-now with partial-result stop

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Frontend — badges, unclassified expander, multi-select bulk actions

**Files:** Modify `client/src/api.js`, `client/src/pages/SuggestedAccountsTab.js`.

**Interfaces — Consumes (Tasks 4–5):** `POST /suggested/approve-bulk`, `POST /tracked/scrape-bulk`; suggestion rows now include `gender`. **Produces:** the staffing UI — gender badge, female-default list with an unclassified expander, multi-select + bulk approve/scrape.

**Verification note:** frontend; verify with `cd client && CI=true npm run build` (compiles clean) + code review. (No client test runner is configured.)

- [ ] **Step 1: Add the bulk API client functions**

In `client/src/api.js`, in the "Suggested accounts" section, add:

```js
export const approveSuggestedBulk = (usernames) => api.post('/suggested/approve-bulk', { usernames });
export const scrapeTrackedBulk = (usernames) => api.post('/tracked/scrape-bulk', { usernames });
```

- [ ] **Step 2: Split suggestions into female vs unclassified, add a gender badge**

In `SuggestedAccountsTab.js`, after `suggestions` is loaded, derive:

```js
const female = suggestions.filter((s) => s.gender === 'female');
const unclassified = suggestions.filter((s) => s.gender !== 'female');
```

Render `female` always; render `unclassified` inside a collapsible block toggled by a `showUnclassified` state (`useState(false)`) with a header button `Show ${unclassified.length} unclassified`. On each card add a badge derived from `s.gender`:

```jsx
<span className={`px-2 py-0.5 rounded-full text-[10px] font-medium border ${
  s.gender === 'female' ? 'bg-green-500/10 text-green-400 border-green-500/30' : 'bg-gray-700/40 text-gray-400 border-gray-600/40'
}`}>
  {s.gender === 'female' ? '♀ Female' : 'Unclassified'}
</span>
```

- [ ] **Step 3: Multi-select + bulk action bar**

Add `const [selected, setSelected] = useState(new Set());` and a per-card checkbox that toggles `s.username` in `selected`. Add a sticky action bar shown when `selected.size > 0`:

```jsx
{selected.size > 0 && (
  <div className="sticky top-2 z-10 bg-gray-900 border border-gold/40 rounded-xl p-3 flex items-center gap-3">
    <span className="text-sm text-gray-300">{selected.size} selected</span>
    <button onClick={handleBulkApprove} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-green-600 hover:bg-green-500 text-white">
      Approve {selected.size} (paused)
    </button>
    <button onClick={handleBulkApproveScrape} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-gold hover:bg-gold-light text-gray-950">
      Approve &amp; Scrape {selected.size}
    </button>
    <button onClick={() => setSelected(new Set())} className="px-3 py-1.5 rounded-lg text-xs text-gray-400 hover:text-white">Clear</button>
  </div>
)}
```

Handlers (import the new api functions + existing `scrapeTrackedBulk`):

```js
const handleBulkApprove = async () => {
  const usernames = [...selected];
  await approveSuggestedBulk(usernames);
  setSelected(new Set());
  load();
};

const handleBulkApproveScrape = async () => {
  const usernames = [...selected];
  await approveSuggestedBulk(usernames);
  const { data } = await scrapeTrackedBulk(usernames);
  setSelected(new Set());
  if (data.stopped) alert(`Stopped at budget: ${data.stopped.message}`);
  load();
};
```

- [ ] **Step 4: Update header copy + provenance**

Change the subtitle ([SuggestedAccountsTab.js:94-96](../../../client/src/pages/SuggestedAccountsTab.js)) to: `Female creators discovered from caption mentions and collab tags on your tracked accounts.` The existing `relevance_reason` line already renders the new `Collab'd with N of your creators` text from Task 3 — no change needed there. Remove the top-hashtags chip block ([:177-185](../../../client/src/pages/SuggestedAccountsTab.js)) since hashtags are no longer a source.

- [ ] **Step 5: Verify and commit**

Run: `cd client && CI=true npm run build`
Expected: `Compiled successfully.` Code-review: females show by default, unclassified behind the expander, multi-select bulk approve (paused) and approve+scrape work, no hashtag chips.

```bash
git add client/src/api.js client/src/pages/SuggestedAccountsTab.js
git commit -m "feat(suggested-ui): gender badges, unclassified expander, bulk approve/scrape

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Ranked: male dropped + female-first + unknown parked → Task 2 (drop male) + Task 4 (`suggestionsOrderClause`) + Task 6 (expander). ✓
- Gender a first-class signal, "unknown" ≠ female → `genderRank`/ordering (Task 1/4), store `gender` (Task 3). ✓
- Batch classify with caption + source context → `_classifyGenderBatch` (Task 2), fed `captionSnippet`/`taggedBy` (Task 2 Step 4). ✓
- Collab strength replaces hashtags → hashtag source cut (Task 2 Step 3), `aggregateCandidates`/`scoreCandidate` (Task 1/3). ✓
- Approve → paused; bulk approve; bulk scrape budget-gated → Tasks 4–5. ✓
- New `suggested_accounts.gender` column, no other schema change → Task 1 Step 1. ✓
- Never throws without Anthropic key → `_classifyGenderBatch` no-key branch (Task 2) + `parseGenderBatch` tolerance (Task 1). ✓
- Observability `[Metric] discovery` / `classify_batch` → Task 3 / Task 2. ✓
- Frontend badges + multi-select → Task 6. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code. The "retain `_classifyGender` single-call" note in Task 2 is intentional (keeps the existing method working) — not a placeholder.

**3. Type consistency:** `aggregateCandidates` output (`collabStrength`, `avgEr`, `postsPerWeek`, `gender`, `relevanceReason`) is consumed by `scoreCandidate({collabStrength, avgEr, postsPerWeek})` and the Task 3 insert. `parseGenderBatch` returns `{usernameLower: verdict}`, consumed by `_classifyGenderBatch` via `verdicts[c.username.toLowerCase()]`. `suggestionsOrderClause(sort)` returns the `ORDER BY` body used in Task 4 Step 2. Consistent.
