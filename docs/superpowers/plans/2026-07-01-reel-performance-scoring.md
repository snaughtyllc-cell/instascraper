# Reel-Performance Scoring + Pull-for-All Previews — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the suggested-account score around reliably-available reel performance (reach + engagement), pull reel previews for every suggestion, show reel-derived card stats, and collapse low-scoring suggestions behind a toggle.

**Architecture:** A pure `scoreReels()` turns an account's captured top reels into a 0–100 score; `captureTopReels` writes that score into the existing `suggestion_score` column. Discovery pulls reels for all new suggestions (cap removed) and stops corrupting the score with the old collab-bump. The client renders reel-derived stats and a non-destructive score-threshold collapse. A one-off backfill scores the existing pending list.

**Tech Stack:** Node/Express, `node --test`, better-sqlite3 (local) / Postgres (prod) dual-mode, React (CRA), Apify.

## Global Constraints

- Dual-mode SQL: placeholders `$1..$n` each appear **once, ascending**; the sqlite shim strips `$n → ?` positionally. Additive migrations only.
- Config helpers use the `num(v, d)` pattern: `const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };`.
- Reuse existing helpers — do NOT redefine `calcViewER`, `pickTopReels`, `extractViews`, `isErrorStubResponse`, `formatCount`, `erStyle`.
- Score is an integer **0–100** in the existing `suggested_accounts.suggestion_score` column (no new column).
- Tests: `node --test` from `server/`; no jest. Client has **no** JS test harness — client tasks are build-verified (`cd client && npm run build`).
- Score constant defaults (env-tunable): `viewFloor=1000`, `viewTarget=1000000`, `reachWeight=60`, `erTarget=6`, `erWeight=40`.

---

### Task 1: `scoreConfig` + `scoreReels` (pure)

**Files:**
- Modify: `server/scraper.js` (add two functions near `pickTopReels`; add two exports)
- Test: `server/reel-score.test.js` (create)

**Interfaces:**
- Consumes: `calcViewER(likes, comments, views) → { er_percent }` (already imported in scraper.js).
- Produces:
  - `scoreConfig(env = process.env) → { viewFloor, viewTarget, reachWeight, erTarget, erWeight }`
  - `scoreReels(reels, cfg = scoreConfig()) → integer 0..100` where each reel is `{ viewCount, likeCount, commentCount }` (the `pickTopReels` output shape).

- [ ] **Step 1: Write the failing test** — create `server/reel-score.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { scoreReels, scoreConfig } = require('./scraper');

const CFG = scoreConfig({}); // defaults: floor 1000, target 1e6, reach 60, erTarget 6, er 40

test('scoreReels: no reels -> 0', () => {
  assert.strictEqual(scoreReels([], CFG), 0);
  assert.strictEqual(scoreReels(null, CFG), 0);
  assert.strictEqual(scoreReels(undefined, CFG), 0);
});

test('scoreReels: 1M views + 6% ER -> 100 (both maxed)', () => {
  // 6% view-ER = (likes+comments)/views*100 => 60000/1e6*100 = 6
  assert.strictEqual(scoreReels([{ viewCount: 1_000_000, likeCount: 60_000, commentCount: 0 }], CFG), 100);
});

test('scoreReels: 100K views + 3% ER -> ~60 (40 reach + 20 er)', () => {
  assert.strictEqual(scoreReels([{ viewCount: 100_000, likeCount: 3_000, commentCount: 0 }], CFG), 60);
});

test('scoreReels: reach-only (1M views, 0 engagement) -> 60', () => {
  assert.strictEqual(scoreReels([{ viewCount: 1_000_000, likeCount: 0, commentCount: 0 }], CFG), 60);
});

test('scoreReels: engagement-only (floor views, 10% ER) -> 40 (reach 0, er capped)', () => {
  // 1000 views = floor => reach 0; ER 10% > target 6 => er capped at 40
  assert.strictEqual(scoreReels([{ viewCount: 1_000, likeCount: 100, commentCount: 0 }], CFG), 40);
});

test('scoreReels: views at/above target are capped at full reach', () => {
  assert.strictEqual(scoreReels([{ viewCount: 50_000_000, likeCount: 0, commentCount: 0 }], CFG), 60);
});

test('scoreReels: a reel with 0 views contributes 0 ER, not a crash', () => {
  assert.strictEqual(scoreReels([{ viewCount: 0, likeCount: 5, commentCount: 5 }], CFG), 0);
});

test('scoreReels: averages across reels', () => {
  // avgViews = (1e6 + 1e4)/2 = 505000 -> log10~5.70 -> (5.70-3)/3=0.90*60=54.1
  // avgER = (6% + 0%)/2 = 3% -> 3/6*40 = 20 ; total ~= round(54.1+20)=74
  const s = scoreReels([
    { viewCount: 1_000_000, likeCount: 60_000, commentCount: 0 },
    { viewCount: 10_000, likeCount: 0, commentCount: 0 },
  ], CFG);
  assert.ok(s >= 72 && s <= 76, `expected ~74, got ${s}`);
});

test('scoreConfig: defaults + env override + non-numeric fallback', () => {
  const d = scoreConfig({});
  assert.deepStrictEqual(d, { viewFloor: 1000, viewTarget: 1000000, reachWeight: 60, erTarget: 6, erWeight: 40 });
  const e = scoreConfig({ SUGGEST_REACH_WEIGHT: '70', SUGGEST_ER_WEIGHT: 'nope' });
  assert.strictEqual(e.reachWeight, 70);
  assert.strictEqual(e.erWeight, 40); // bad value -> default
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test reel-score.test.js`
Expected: FAIL — `scoreReels is not a function` / `scoreConfig is not a function`.

- [ ] **Step 3: Write minimal implementation** — in `server/scraper.js`, add immediately AFTER the `pickTopReels` function:

```js
// Suggestion scoring from an account's captured top reels — reach (log-scaled avg
// views) + engagement (view-based ER). Returns an integer 0..100. Pure — unit-tested.
function scoreConfig(env = process.env) {
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
  return {
    viewFloor: num(env.SUGGEST_VIEW_FLOOR, 1000),
    viewTarget: num(env.SUGGEST_VIEW_TARGET, 1000000),
    reachWeight: num(env.SUGGEST_REACH_WEIGHT, 60),
    erTarget: num(env.SUGGEST_ER_TARGET, 6),
    erWeight: num(env.SUGGEST_ER_WEIGHT, 40),
  };
}

function scoreReels(reels, cfg = scoreConfig()) {
  if (!Array.isArray(reels) || reels.length === 0) return 0;
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const n = reels.length;
  const avgViews = reels.reduce((s, r) => s + (Number(r.viewCount) || 0), 0) / n;
  const avgER = reels.reduce((s, r) => s + calcViewER(r.likeCount, r.commentCount, r.viewCount).er_percent, 0) / n;
  const denom = Math.log10(cfg.viewTarget) - Math.log10(cfg.viewFloor);
  const reachFrac = denom > 0
    ? clamp((Math.log10(Math.max(avgViews, 1)) - Math.log10(cfg.viewFloor)) / denom, 0, 1)
    : 0;
  const reachPts = reachFrac * cfg.reachWeight;
  const erPts = clamp(avgER / (cfg.erTarget || 1), 0, 1) * cfg.erWeight;
  return Math.round(reachPts + erPts);
}
```

Then add to the exports block (near `module.exports.pickTopReels`):

```js
module.exports.scoreReels = scoreReels;
module.exports.scoreConfig = scoreConfig;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test reel-score.test.js`
Expected: PASS (9 tests). Then `cd server && npm test` — full suite stays green.

- [ ] **Step 5: Commit**

```bash
git add server/scraper.js server/reel-score.test.js
git commit -m "feat(suggested): scoreReels + scoreConfig — reel-performance score (pure)"
```

---

### Task 2: Write the reel score into `suggestion_score`

**Files:**
- Modify: `server/scraper.js` (`captureTopReels` method)

**Interfaces:**
- Consumes: `scoreReels`, `scoreConfig` (Task 1); the `reels` array already built inside `captureTopReels` via `pickTopReels`.
- Produces: `captureTopReels(username)` now returns `{ count, score }` (was: `count`). Callers that ignore the return are unaffected; the Task-6 backfill uses it.

- [ ] **Step 1: Confirm no caller depends on the numeric return**

Run: `cd server && grep -rn "captureTopReels" .`
Expected: the only call site is in `server/scheduler.js` `runDiscovery`, which does `await scraperInstance.captureTopReels(...)` and does NOT use the return value. (If any other caller reads it as a number, stop and reconcile.)

- [ ] **Step 2: Read the current method**

Read `server/scraper.js` `captureTopReels`. It fetches reels (`const reels = await this._fetchTopReels(username)`), inserts each into `suggested_reels`, fire-and-forget caches thumbnails, and ends with `return reels.length;` (or similar). Note the exact final `return` line.

- [ ] **Step 3: Add scoring + score update, change the return**

Replace the method's final `return reels.length;` with:

```js
    // Reel-performance score → the account's suggestion_score (0 when no reels got through,
    // which correctly sinks blocked/private accounts below the display threshold).
    const score = scoreReels(reels, scoreConfig());
    try {
      await pool.query('UPDATE suggested_accounts SET suggestion_score = $1 WHERE username = $2', [score, username]);
    } catch (e) {
      console.error(`[Reels] score update failed for @${username}:`, e.message);
    }
    return { count: reels.length, score };
```

(Leave the rest of the method unchanged. `pool`, `scoreReels`, `scoreConfig` are all in module scope.)

- [ ] **Step 4: Verify the suite still passes**

Run: `cd server && npm test`
Expected: PASS (no regressions). This method is Apify+DB glue with no unit test; correctness of the score itself is covered by Task 1, and end-to-end behavior is verified by the Task-6 backfill.

- [ ] **Step 5: Commit**

```bash
git add server/scraper.js
git commit -m "feat(suggested): captureTopReels writes reel score into suggestion_score"
```

---

### Task 3: Discovery — pull for all + stop the collab score-bump

**Files:**
- Modify: `server/scheduler.js` (`discoveryConfig`, the reel-capture guard in `runDiscovery`, the `repeats` accumulation UPDATE)
- Test: `server/discovery-reach.test.js` (update the `reelsMax` and accumulation tests)

**Interfaces:**
- Consumes: `captureTopReels` (Task 2).
- Produces: `discoveryConfig().reelsMax` default is now `0` (meaning "no cap").

- [ ] **Step 1: Update the failing tests first** — in `server/discovery-reach.test.js`:

(a) In the `discoveryConfig` test, change the `reelsMax` assertions to the new default `0`:

```js
  assert.strictEqual(d.reelsMax, 0);                                   // 0 = no cap
  assert.strictEqual(discoveryConfig({ DISCOVERY_REELS_MAX: '3' }).reelsMax, 3);
  assert.strictEqual(discoveryConfig({ DISCOVERY_REELS_MAX: 'nope' }).reelsMax, 0);
```

(b) Replace the accumulation `ACC_SQL`, its `acc` helper, and the "bumps score upward" test. New `ACC_SQL` + helper (no score clause; placeholders `$n → ?` positional, so `?` order = `[token, token, reason, username]`):

```js
const ACC_SQL = `UPDATE suggested_accounts
   SET source = CASE WHEN (',' || source || ',') LIKE ('%,' || ? || ',%') THEN source ELSE source || ',' || ? END,
       relevance_reason = ?
 WHERE username = ? AND status = 'pending'`;
const acc = (db, { token, reason, username }) =>
  db.prepare(ACC_SQL).run(token, token, reason, username);
```

Replace the `test('accumulation: bumps score upward, never demotes', ...)` with:

```js
test('accumulation: leaves suggestion_score untouched (score is reel-based now)', () => {
  const db = makeDb();
  db.prepare("INSERT INTO suggested_accounts (username, source, suggestion_score) VALUES ('x','creatorA',72)").run();
  acc(db, { token: 'creatorB', reason: 'r1', username: 'x' });
  assert.strictEqual(db.prepare("SELECT suggestion_score s FROM suggested_accounts WHERE username='x'").get().s, 72);
});
```

Leave the "merges new source token once" and "does not touch reviewed" tests, but update their `acc(...)` calls to drop the `score:` field (the helper signature changed): e.g. `acc(db, { token: 'creatorB', reason: 'r', username: 'x' });`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && node --test discovery-reach.test.js`
Expected: FAIL — `reelsMax` is `8` not `0`; the accumulation test still expects a bumped score.

- [ ] **Step 3: Implement — `discoveryConfig` default**

In `server/scheduler.js` `discoveryConfig`, change the `reelsMax` line to default `0`:

```js
    reelsMax: Math.floor(num(env.DISCOVERY_REELS_MAX, 0)),
```

- [ ] **Step 4: Implement — uncap the reel-capture guard**

In `runDiscovery`, the reel-capture guard currently reads `!reelsBudgetStop && reelsCaptured < dcfg.reelsMax`. Change it so `0` means unlimited:

```js
      if (!reelsBudgetStop && (dcfg.reelsMax === 0 || reelsCaptured < dcfg.reelsMax)) {
```

(Leave the body — the `captureTopReels` call, `reelsCaptured++`, and `BudgetExceededError` handling — unchanged.)

- [ ] **Step 5: Implement — drop the collab score-bump on repeats**

In `runDiscovery`, the `repeats` loop currently computes `const totalScore = scoreCandidate(...)` and runs an UPDATE whose `SET` includes `suggestion_score = CASE WHEN $1 > suggestion_score THEN $2 ELSE suggestion_score END`. Replace that whole `for (const item of repeats) { ... }` body with a version that keeps the source-token merge + reason refresh but no score:

```js
    for (const item of repeats) {
      const token = item.sourceAccount || item.source || 'discovery';
      try {
        const upd = await pool.query(
          `UPDATE suggested_accounts
             SET source = CASE WHEN (',' || source || ',') LIKE ('%,' || $1 || ',%') THEN source ELSE source || ',' || $2 END,
                 relevance_reason = $3
           WHERE username = $4 AND status = 'pending'`,
          [token, token, item.relevanceReason || '', item.username]
        );
        if (upd.rowCount > 0) bumped++;
      } catch (e) { console.error(`[Discovery] accumulate failed for @${item.username}:`, e.message); }
    }
```

(The initial INSERT for NEW suggestions keeps using `scoreCandidate` as a provisional score — `captureTopReels` overwrites it moments later. Do NOT change the INSERT.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd server && node --test discovery-reach.test.js` then `cd server && npm test`
Expected: PASS (both).

- [ ] **Step 7: Commit**

```bash
git add server/scheduler.js server/discovery-reach.test.js
git commit -m "feat(discovery): pull reels for all suggestions; stop collab score-bump (reel score is authoritative)"
```

---

### Task 4: Serving — expose like/comment on `top_reels`

**Files:**
- Modify: `server/index.js` (`GET /suggested` reels query)

**Interfaces:**
- Produces: each `top_reels` item now includes `like_count` and `comment_count` (consumed by the Task-5 client `reelStats`).

- [ ] **Step 1: Add the two columns**

In `server/index.js`, the `GET /suggested` handler queries `suggested_reels` with a SELECT like `SELECT id, username, shortcode, view_count, video_url, permalink, rank FROM suggested_reels WHERE username IN (...) ORDER BY ...`. Add `like_count, comment_count`:

```js
    `SELECT id, username, shortcode, view_count, like_count, comment_count, video_url, permalink, rank
       FROM suggested_reels WHERE username IN (${placeholders}) ORDER BY username, rank`
```

(Do not change the `placeholders` generation or the params — only the selected columns. `attachTopReels` spreads each row, so the two fields flow through automatically.)

- [ ] **Step 2: Verify the suite still passes**

Run: `cd server && npm test`
Expected: PASS. (Contract-only change; the `attachTopReels` unit test is unaffected since it operates on passed-in objects.)

- [ ] **Step 3: Commit**

```bash
git add server/index.js
git commit -m "feat(suggested): include like/comment on served top_reels for ER display"
```

---

### Task 5: Frontend — reel-derived stats + score-threshold collapse

**Files:**
- Modify: `client/src/pages/SuggestedAccountsTab.js`

**Interfaces:**
- Consumes: `s.top_reels[]` with `{ view_count, like_count, comment_count, ... }` (Task 4); `s.suggestion_score` (Task 2).

- [ ] **Step 1: Add the `reelStats` helper**

In `client/src/pages/SuggestedAccountsTab.js`, add right after the `formatCount` function (near line 11):

```js
function reelStats(reels) {
  if (!reels || reels.length === 0) return { avgViews: 0, avgER: 0 };
  const n = reels.length;
  const avgViews = Math.round(reels.reduce((sum, r) => sum + (Number(r.view_count) || 0), 0) / n);
  const avgER = Math.round((reels.reduce((sum, r) => {
    const v = Number(r.view_count) || 0;
    return sum + (v > 0 ? ((Number(r.like_count) || 0) + (Number(r.comment_count) || 0)) / v * 100 : 0);
  }, 0) / n) * 100) / 100;
  return { avgViews, avgER };
}
```

- [ ] **Step 2: Replace the Stats grid with reel-derived stats**

In `renderCard`, replace the entire `{/* Stats */}` block (the `<div className="grid grid-cols-3 gap-2">...</div>` showing Followers / Avg ER / Posts/wk, ~lines 207-221) with:

```jsx
      {/* Stats (reel-derived) */}
      {(() => {
        const { avgViews, avgER } = reelStats(s.top_reels);
        const reelCount = (s.top_reels || []).length;
        return (
          <div className="grid grid-cols-3 gap-2">
            <div className="bg-gray-800/50 rounded-lg p-2 text-center border border-gray-700/50">
              <div className="text-sm font-bold text-white">{reelCount ? formatCount(avgViews) : '—'}</div>
              <div className="text-[10px] text-gray-500">Avg Views</div>
            </div>
            <div className={`rounded-lg p-2 text-center border ${erStyle(avgER)}`}>
              <div className="text-sm font-bold">{reelCount ? `${avgER}%` : '—'}</div>
              <div className="text-[10px] opacity-75">Reel ER</div>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center border border-gray-700/50">
              <div className="text-sm font-bold text-white">{s.followers > 0 ? formatCount(s.followers) : reelCount}</div>
              <div className="text-[10px] text-gray-500">{s.followers > 0 ? 'Followers' : 'Reels'}</div>
            </div>
          </div>
        );
      })()}
```

- [ ] **Step 3: Add the threshold state + control**

Add state inside `SuggestedAccountsTab` (near the other `useState` calls, ~line 75):

```js
  const [threshold, setThreshold] = useState(() => {
    const v = Number(localStorage.getItem('suggestScoreThreshold'));
    return Number.isFinite(v) && v > 0 ? v : 60;
  });
  useEffect(() => { localStorage.setItem('suggestScoreThreshold', String(threshold)); }, [threshold]);
```

Add a control in the header, right before the `<select value={sort}...>` (~line 280):

```jsx
            <label className="flex items-center gap-1.5 text-xs text-gray-400">
              Min score
              <input
                type="number" min="0" max="100" value={threshold}
                onChange={(e) => setThreshold(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                className="w-16 bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-white"
              />
            </label>
```

- [ ] **Step 4: Split the female list by threshold with a collapse toggle**

Add collapse state near the other `useState` calls:

```js
  const [showLowScore, setShowLowScore] = useState(false);
```

The `female` list is already sorted by score (server `sort=score`). Split it and render above-threshold normally, below-threshold behind a toggle. Replace the female section's card grid (`<div className="grid ...">{female.map(renderCard)}</div>`, ~line 339) with:

```jsx
              {(() => {
                const above = female.filter((s) => (s.suggestion_score || 0) >= threshold);
                const below = female.filter((s) => (s.suggestion_score || 0) < threshold);
                return (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                      {above.map(renderCard)}
                    </div>
                    {below.length > 0 && (
                      <div className="mt-3">
                        <button
                          onClick={() => setShowLowScore((v) => !v)}
                          className="text-sm text-gray-400 hover:text-white transition-colors mb-3"
                        >
                          {showLowScore ? '▾' : '▸'} Show {below.length} lower-scoring (under {threshold}%)
                        </button>
                        {showLowScore && (
                          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                            {below.map(renderCard)}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                );
              })()}
```

- [ ] **Step 5: Build to verify it compiles**

Run: `cd client && npm run build`
Expected: compiles successfully, no errors (warnings OK).

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/SuggestedAccountsTab.js
git commit -m "feat(suggested): reel-derived card stats + score-threshold collapse"
```

---

### Task 6: Backfill script (+ run once against prod after deploy)

**Files:**
- Create: `server/scripts/backfill-reel-scores.js`

**Interfaces:**
- Consumes: `captureTopReels(username) → { count, score }` (Task 2); `BudgetExceededError` (from `./scraper`); `pool` (from `./db`).

- [ ] **Step 1: Write the script**

Create `server/scripts/backfill-reel-scores.js`:

```js
// One-off: pull reels + compute the reel-performance score for pending suggestions.
// Usage (in prod container): node scripts/backfill-reel-scores.js [--all]
//   default: only pending accounts that have no reels yet;  --all: every pending account.
const pool = require('../db');
const InstagramScraper = require('../scraper');
const { BudgetExceededError } = require('../scraper');

const scraper = new InstagramScraper(process.env.APIFY_API_KEY || '');

(async () => {
  const all = process.argv.includes('--all');
  const sql = all
    ? "SELECT username FROM suggested_accounts WHERE status = 'pending' ORDER BY discovered_at DESC"
    : `SELECT s.username FROM suggested_accounts s
        WHERE s.status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM suggested_reels r WHERE r.username = s.username)
        ORDER BY s.discovered_at DESC`;
  const { rows } = await pool.query(sql);
  console.log(`[Backfill] ${rows.length} pending accounts (all=${all})`);
  let done = 0, withReels = 0;
  for (const r of rows) {
    try {
      const { count, score } = await scraper.captureTopReels(r.username);
      done++; if (count > 0) withReels++;
      console.log(`[Backfill] @${r.username} -> ${count} reels, score ${score}`);
    } catch (e) {
      if (e instanceof BudgetExceededError) { console.log(`[Backfill] budget reached — stopping: ${e.message}`); break; }
      console.log(`[Backfill] @${r.username} FAILED: ${e.message}`);
    }
  }
  console.log(`[Backfill] done=${done} withReels=${withReels}`);
  process.exit(0);
})().catch((e) => { console.error('[Backfill] FATAL', e.message); process.exit(1); });
```

- [ ] **Step 2: Smoke-check it loads (no run)**

Run: `cd server && node -e "require('./scripts/backfill-reel-scores.js')" </dev/null` is NOT appropriate (it would execute). Instead: `cd server && node --check scripts/backfill-reel-scores.js`
Expected: no output, exit 0 (syntax valid).

- [ ] **Step 3: Commit**

```bash
git add server/scripts/backfill-reel-scores.js
git commit -m "chore(suggested): one-off backfill script for reel scores"
```

- [ ] **Step 4: Run against prod — AFTER this branch is merged and Railway has redeployed**

This step runs during the completion/verification phase (the controller does it), not in the worktree:

```bash
cd /Users/jefftingz/instascraper/server && railway ssh "cd /app/server && node scripts/backfill-reel-scores.js"
```

Then re-check: the `suggestion_score` distribution should now spread (not all 17), and a `/suggested` sample should show non-zero `top_reels` + scores. Expected cost ~$1.70 for ~84 accounts; blocked/private accounts log 0 reels / score 0 (correctly collapsed).

---

## Self-Review

**Spec coverage:**
- scoreReels + scoreConfig (reach+engagement, env-tunable) → Task 1 ✅
- score written to suggestion_score (0 when no reels) → Task 2 ✅
- pull-for-all (remove reelsMax cap) → Task 3 ✅
- stop collab score-bump on repeats → Task 3 ✅
- serve like/comment for ER display → Task 4 ✅
- reel-derived card stats + threshold collapse (default 60, localStorage, non-destructive) → Task 5 ✅
- backfill existing pending → Task 6 ✅

**Type consistency:** `scoreReels(reels, cfg)`, `scoreConfig(env)`, `captureTopReels → { count, score }`, `reelStats(top_reels) → { avgViews, avgER }` — used consistently across tasks. Reel object uses `viewCount/likeCount/commentCount` server-side (pickTopReels shape) and `view_count/like_count/comment_count` client-side (DB row shape) — correct for each side.

**Placeholder scan:** none — every step has concrete code/commands.
