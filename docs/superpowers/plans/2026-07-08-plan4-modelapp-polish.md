# Plan 4 — Model App Polish (niche switcher, adaptive video, idea reels, open UI)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Refine the just-shipped mobile ModelApp so it's fast and Instagram-clean: a niche *switcher* on the feed (not one endless list), reels that display in their true shape (no crop), each AI idea showing the actual reels that inspired it (playable in-app), and an "open, not crowded" spacing/typography pass across the surface.

**Architecture:** Backend changes are additive to the existing `/me/*` API (SOFT isolation unchanged — media is shared, so viewing any niche is allowed). `/me/feed` gains an optional `niche` filter + returns the niche vocabulary for the toggle; `/me/ideas` enriches each idea with its source reels resolved from `source_post_ids`. Frontend: a niche chip-row on `FeedPage`, an adaptive-aspect media mode on the shared `ContentCard` (model-only — the admin Library keeps its 4:5 grid), inline source-reel players on `IdeasPage`, and a whitespace/typography pass across `ModelApp`.

**Tech Stack:** Node + Express + `pg`/`better-sqlite3` (tests); React (CRA) + axios + Tailwind.

## Global Constraints

- **Backend tests:** `node --test` on extracted pure logic + `better-sqlite3` in-memory (pattern: `server/me-feed.test.js`). Do NOT boot Express in tests.
- **Frontend has NO test harness** — gate = `cd client && npm run build` compiles clean + explicit manual checks.
- **Dual backend:** the SQLite adapter does naive `$n`→`?` with NO placeholder dedup and NO `= ANY(array)`. Use `IN ($k, …)`, number placeholders sequentially, never reuse a `$N`.
- **SOFT isolation holds:** every `/me/*` handler derives `modelId` from `req.session.user.modelId` ONLY. The niche `param` is a *filter over shared public content* — any value is safe; it is never an ownership key. Private data (saves/ideas) stays session-keyed.
- **Do NOT regress the admin surface:** `ContentCard` is shared with `LibraryTab` (which passes the default `variant`/no adaptive prop). All model-only visual changes MUST be behind a new opt-in prop so the admin Library renders byte-identically. `LibraryTab.js` must not be modified.
- **Design principle for the UI pass:** *open, not crowded* — Instagram-like. Generous whitespace, restrained type scale, calm buttons. Do not just shrink; give it air.
- **Commits:** one per task.

---

### Task 1: `/me/feed` niche switcher (backend)

**Files:**
- Modify: `server/me-feed.js` (extend the builder for single-niche + "all" mode)
- Modify: `server/index.js` (the `GET /me/feed` route at ~1067)
- Test: `server/me-feed.test.js` (extend)

**Interfaces:**
- Produces: `buildMeFeedQuery(niches, { page, limit, all })` — when `all === true`, build a query with NO niche `IN` clause but STILL the `archived`/`soft_deleted` filters, ordered newest, paginated (so "All" shows everything visible). When `all` is falsy and `niches` is non-empty → current behavior. When `all` falsy and `niches` empty → `{ sql: null, params: [] }` (unchanged).
- `GET /me/feed` accepts `?niche=<value>` and `?niche=all`:
  - no `niche` param → the model's own niches (current default).
  - `niche=all` → everything (`all:true`).
  - `niche=<value>` → that single niche only (`buildMeFeedQuery([value], …)`).
  - Response gains `availableNiches` (the `content_types` vocabulary — `[{value,label}]`) and `activeNiche` (the resolved selection: `'all'`, a niche value, or `null` for the default my-niches view) alongside the existing `posts` + `niches` (the model's own niches).

- [ ] **Step 1 — extend `nicheVisibilityClause` to support an all/visibility-only mode.** Add a helper `visibilityOnlyClause()` returning just `(posts.soft_deleted = 0 OR posts.soft_deleted IS NULL) AND (posts.archived = 0 OR posts.archived IS NULL)` (no params). Have `buildMeFeedQuery` use it when `all:true`:

```js
function visibilityOnlyClause() {
  return `(posts.soft_deleted = 0 OR posts.soft_deleted IS NULL)`
    + ` AND (posts.archived = 0 OR posts.archived IS NULL)`;
}

function buildMeFeedQuery(niches, { page = 1, limit = 24, all = false } = {}) {
  let clause, params;
  if (all) {
    clause = visibilityOnlyClause(); params = [];
  } else {
    ({ clause, params } = nicheVisibilityClause(niches, 1));
    if (!clause) return { sql: null, params: [] };
  }
  const offset = (Math.max(1, Number(page)) - 1) * limit;
  const limIdx = params.length + 1, offIdx = params.length + 2;
  const sql = `
    SELECT posts.*, COALESCE(posts.content_type, ct.content_type) AS niche
    FROM posts
    LEFT JOIN creator_types ct ON posts.account_handle = ct.account_handle
    WHERE ${clause}
    ORDER BY posts.posted_at DESC
    LIMIT $${limIdx} OFFSET $${offIdx}`;
  return { sql, params: [...params, limit, offset] };
}
```
Export `visibilityOnlyClause` too. Keep `parseNiches`/`nicheVisibilityClause` as-is.

- [ ] **Step 2 — tests (extend `me-feed.test.js`, execute against real sqlite):**
  - `buildMeFeedQuery([], { all:true })` returns non-null sql with NO `IN (` and WITH `soft_deleted`/`archived`; executing it against a seeded table returns ALL non-archived/non-deleted posts across niches (incl. a `skit` post the niche filter would exclude), newest first.
  - a single-niche call `buildMeFeedQuery(['dance'], {})` returns only dance posts (already covered pattern — add if not present).
  - placeholder numbering for `all` mode: LIMIT/OFFSET are `$1`/`$2` (params length 0 + 1/2). Assert via a real execution (no "too few parameters" throw).

- [ ] **Step 3 — route.** Rewrite `GET /me/feed`:

```js
app.get('/me/feed', asyncHandler(async (req, res) => {
  const modelId = req.session.user.modelId;
  const m = await pool.query('SELECT primary_niche, secondary_niches FROM models WHERE id = $1', [modelId]);
  if (m.rows.length === 0) return res.status(404).json({ error: 'Model not found' });
  const myNiches = parseNiches(m.rows[0]);
  const page = Number(req.query.page) || 1;
  const sel = (req.query.niche || '').trim();

  let build, activeNiche;
  if (sel === 'all') { build = buildMeFeedQuery([], { page, limit: 24, all: true }); activeNiche = 'all'; }
  else if (sel)      { build = buildMeFeedQuery([sel], { page, limit: 24 }); activeNiche = sel; }
  else               { build = buildMeFeedQuery(myNiches, { page, limit: 24 }); activeNiche = null; }

  // The content-type vocabulary powers the switcher (models can't hit the admin /content-types route).
  const av = await pool.query('SELECT value, label FROM content_types ORDER BY sort_order, label');
  const availableNiches = av.rows;

  if (!build.sql) return res.json({ posts: [], niches: myNiches, availableNiches, activeNiche });
  const r = await pool.query(build.sql, build.params);
  res.json({ posts: r.rows, niches: myNiches, availableNiches, activeNiche });
}));
```
Confirm `content_types` has `value`, `label`, `sort_order` (it does — `server/content-types.js`). Update the single top-level me-feed import if a new export is used.

- [ ] **Step 4** — run `cd server && node --test me-feed.test.js` → PASS; `node --check index.js`; full suite green. Commit `feat(me): /me/feed niche switcher (single niche + all) + availableNiches`.

---

### Task 2: `/me/ideas` source-reel enrichment (backend)

**Files:**
- Create: `server/idea-reels.js` (pure `parseSourceShortcodes`) + `server/idea-reels.test.js`
- Modify: `server/index.js` (the `GET /me/ideas` route at ~1105)

**Interfaces:**
- `parseSourceShortcodes(sourcePostIds: string): string[]` — split the comma-separated `source_post_ids` (which stores IG reel/post URLs, per `ai-agent.js`), extract each shortcode via `/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/`, dedupe, drop empties. Tolerates bare shortcodes (no URL) by falling back to a `[A-Za-z0-9_-]{5,}` token match.
- `GET /me/ideas` attaches `sourceReels` (array of matched post objects) to each idea, resolved by shortcode from OUR posts (so only reels we actually have + can play via `/video/:id` appear). Ideas whose sources we don't have simply get `sourceReels: []`.

- [ ] **Step 1 — pure parser + test:**

```js
// server/idea-reels.js
function parseSourceShortcodes(sourcePostIds) {
  const raw = String(sourcePostIds || '').split(',').map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const item of raw) {
    const m = item.match(/(?:reels?|p)\/([A-Za-z0-9_-]+)/) || item.match(/^([A-Za-z0-9_-]{5,})$/);
    if (m && m[1] && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}
module.exports = { parseSourceShortcodes };
```
Test: a URL list `https://www.instagram.com/reel/ABC123/,https://www.instagram.com/p/XYZ_9/` → `['ABC123','XYZ_9']`; a bare shortcode passes through; dupes/empties dropped; `''` → `[]`.

- [ ] **Step 2 — route enrichment.** Gather all shortcodes across the batch, one `IN (...)` lookup (sequential placeholders, dialect-safe), then attach matched reels per idea preserving order:

```js
const { parseSourceShortcodes } = require('./idea-reels');
app.get('/me/ideas', asyncHandler(async (req, res) => {
  const r = await pool.query(
    'SELECT * FROM idea_cards WHERE model_id = $1 ORDER BY created_at DESC LIMIT 50',
    [req.session.user.modelId]);
  const ideas = r.rows;
  const perIdea = ideas.map(i => parseSourceShortcodes(i.source_post_ids));
  const all = [...new Set(perIdea.flat())];
  let byCode = {};
  if (all.length) {
    const ph = all.map((_, i) => `$${i + 1}`).join(', ');
    const pr = await pool.query(
      `SELECT id, shortcode, video_url, thumbnail_url, view_count, caption, post_url, content_type, account_handle, posted_at
       FROM posts WHERE shortcode IN (${ph})`, all);
    byCode = Object.fromEntries(pr.rows.map(p => [p.shortcode, p]));
  }
  const enriched = ideas.map((idea, k) => ({
    ...idea,
    sourceReels: perIdea[k].map(code => byCode[code]).filter(Boolean),
  }));
  res.json({ ideas: enriched });
}));
```

- [ ] **Step 3** — `node --test idea-reels.test.js` → PASS; `node --check index.js`; full suite green. Commit `feat(me): resolve idea source reels for in-app playback`.

---

### Task 3: API client — feed niche param (frontend)

**Files:** Modify `client/src/api.js`

- [ ] Change `getMyFeed` to accept an optional niche: `export const getMyFeed = (page = 1, niche) => api.get('/me/feed', { params: { page, ...(niche ? { niche } : {}) } });`. Build check. Commit `feat(me): getMyFeed niche param`.

---

### Task 4: ContentCard adaptive-aspect media (frontend, model-only)

**Files:** Modify `client/src/components/ContentCard.js`

**Interfaces:** new optional prop `adaptiveMedia = false`. When true, the media frame is NOT locked to `aspect-[4/5]`; instead it matches the media's natural shape (no cropping). When false (default — the admin Library), behavior is byte-identical to today.

- [ ] The current media wrapper is `<div className="relative aspect-[4/5] bg-gray-800 overflow-hidden">` (~line 144) with `object-cover` on the `<img>`/`<video>`. Under `adaptiveMedia`:
  - drop the fixed `aspect-[4/5]` (use e.g. `className={\`relative bg-black overflow-hidden ${adaptiveMedia ? '' : 'aspect-[4/5]'}\`}`),
  - and on the media elements use `object-contain` + natural height when adaptive (e.g. `className={adaptiveMedia ? 'w-full h-auto max-h-[80vh] object-contain' : 'w-full h-full object-cover'}`) so a 9:16 reel shows tall and a 16:9 shows wide, both fully visible, capped so nothing dominates the screen.
  - Keep the poster/`onError`/autoplay/heart overlays working — they position off the same relative wrapper. Verify the heart + sound toggle still sit correctly.
- [ ] Do NOT change any behavior when `adaptiveMedia` is falsy. Build check. Commit `feat(model-app): adaptive-aspect media on ContentCard (opt-in)`.

---

### Task 5: FeedPage niche switcher + adaptive cards (frontend)

**Files:** Modify `client/src/pages/model/FeedPage.js`

- [ ] Read `availableNiches` + `activeNiche` from the `getMyFeed` response; keep a local `activeNiche` state (default `null` = my niches). Render a **horizontal chip row** pinned above the feed: first chip **"My Feed"** (my niches, `activeNiche=null`), then one chip per `availableNiches` entry (label), then **"All"**. The selected chip is visually active. Tapping a chip sets `activeNiche` and refetches `getMyFeed(1, chipValue)` (`'all'` for All, the niche `value` for a niche, `undefined` for My Feed) and resets to page 1.
- [ ] Pass `adaptiveMedia` to each `ContentCard` so reels show in true shape.
- [ ] Chip row styling: Instagram-clean — a single scrollable row, generous horizontal padding, pill chips with calm active/inactive states, comfortable tap targets, NOT crowded. Build check. Commit `feat(model-app): feed niche switcher + adaptive cards`.

---

### Task 6: IdeasPage — playable source reels (frontend)

**Files:** Modify `client/src/pages/model/IdeasPage.js`

- [ ] For each idea, render its `sourceReels` (from Task 2) as small inline players below the idea text — reuse `ContentCard` with `adaptiveMedia` + `autoplayInView` (or a compact still-with-tap-to-play if a full card is too heavy; prefer the shared card for consistency). If `sourceReels` is empty, show nothing (no broken placeholder). Label the block e.g. "Reels that inspired this".
- [ ] Keep the idea fields already shown (concept/format/hook_line/why_working). Build check. Commit `feat(model-app): idea cards show their source reels inline`.

---

### Task 7: "Open, not crowded" density pass (frontend)

**Files:** Modify `client/src/ModelApp.js`, `client/src/pages/model/FeedPage.js`, `client/src/pages/model/SavedPage.js`, `client/src/pages/model/IdeasPage.js`

**Principle:** Instagram-open. This is a deliberate spacing/typography pass, not a feature.

- [ ] Increase breathing room: consistent vertical rhythm between cards (feed items separated by clear gaps, not stacked tight), comfortable page/section padding, a calm max-width so content isn't edge-to-edge cramped on larger phones.
- [ ] Restrain typography: a clear, small-but-legible type scale (one prominent size for titles, one muted size for meta), avoid heavy/multiple bold weights competing.
- [ ] Calm the chrome: the top bar and bottom nav should feel light (adequate padding, muted inactive states, one clear active state), tap targets ≥44px but not visually bulky.
- [ ] Reduce clutter: hide/limit secondary metadata on the model surface; let the media be the focus (Instagram lets the content breathe).
- [ ] Do NOT touch admin components or `LibraryTab`. Build check + a device-mode look on Feed/Saved/Ideas. Commit `style(model-app): open, Instagram-like spacing & typography`.

---

## Verification
- Backend: `cd server && node --test` green (new me-feed all-mode + idea-reels tests).
- Client `npm run build` clean.
- Manual (phone/device-mode): feed chips switch niche/all and the feed swaps; reels show uncropped in true aspect; each idea shows its source reels playing inline; the surface feels open, not crowded; admin Library unchanged.

## Out of scope
- Video cache mechanics / the 60MB cap (separate; raise the cap only if the user reports specific large reels stuck on the poster).
- The follow-up tickets from Plan 2's final review (posts.* narrowing, etc.).
