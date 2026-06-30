# Library "Faster Triage" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Library triage faster — bulk multi-select tag/archive/set-type, caption search, an "untagged only" focus filter, and a loading state.

**Architecture:** A pure, unit-tested helper (`server/content-bulk.js`) builds the validated bulk `UPDATE`; a single `POST /content/bulk` route uses it; `GET /content` gains an `untagged` filter. The client adds a selection `Set` + sticky `BulkActionBar`, a per-card checkbox, a debounced search input, an "Untagged" tag option, and a loading indicator.

**Tech Stack:** Node/Express, dual-mode DB (`pg` prod / `better-sqlite3` dev+test), React (CRA), `node:test`.

## Global Constraints

- **Test runner:** `node --test` from `server/` (`npm test`). Client has **no unit harness** — client tasks are verified by `cd client && npm run build` (must print `Compiled successfully`) and browser preview, not failing-unit-test-first.
- **Allow-lists (copy verbatim):** tag ∈ `['recreate','reference','skip', null]`; content-type ∈ `['talking','dance','skit','snapchat','omegle','osc', null]`; archive value is truthy→`1`, falsy→`0`.
- **SQL portability:** the dual-mode shim rewrites `$n`→`?` and runs better-sqlite3. The bulk UPDATE MUST use a dynamic `id IN ($2,$3,…)` placeholder list — **never** Postgres-only `= ANY()`.
- **Selection lifetime:** the client selection `Set` clears on any filter change and on page change.
- **"Untagged" wire format:** the tag `<select>` uses value `__untagged__`; the client sends `untagged=true` and **omits** `tag` for that case.
- **DRY / YAGNI / TDD (server) / frequent commits.** Deferred (do NOT build): infinite scroll/list-view, min-ER/trending sort, filter persistence, bulk notes/delete.

---

### Task 1: Server — bulk-update helper, `POST /content/bulk`, and `untagged` filter

**Files:**
- Create: `server/content-bulk.js`
- Create: `server/content-bulk.test.js`
- Modify: `server/index.js` — add `POST /content/bulk` (after the single-item content routes, ~L226); add `untagged` handling in `GET /content` (~L143, ~L150).

**Interfaces:**
- Produces: `buildBulkUpdate(action, value, ids) → { error } | { sql, params, ids }` — validates `action`/`value` against the allow-lists, coerces `ids` to positive integers. Returns `{ error: <string> }` for an unknown action or out-of-allow-list value; `{ sql: null, params: [], ids: [] }` when no valid ids; otherwise `{ sql: 'UPDATE posts SET <col> = $1 WHERE id IN ($2,…)', params: [value', ...ids], ids }`. `archive` maps `value` → `1|0`; `tag`/`content-type` accept `null` (clear).

- [ ] **Step 1: Write the failing test**

Create `server/content-bulk.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { buildBulkUpdate } = require('./content-bulk');

test('buildBulkUpdate: unknown action → error', () => {
  assert.deepStrictEqual(buildBulkUpdate('frobnicate', 'x', [1]), { error: 'Invalid action' });
});

test('buildBulkUpdate: tag value outside allow-list → error', () => {
  assert.deepStrictEqual(buildBulkUpdate('tag', 'bogus', [1]), { error: 'Invalid tag' });
});

test('buildBulkUpdate: content-type value outside allow-list → error', () => {
  assert.deepStrictEqual(buildBulkUpdate('content-type', 'bogus', [1]), { error: 'Invalid content type' });
});

test('buildBulkUpdate: null is a valid tag and content-type (clear)', () => {
  assert.strictEqual(buildBulkUpdate('tag', null, [5]).sql, 'UPDATE posts SET tag = $1 WHERE id IN ($2)');
  assert.deepStrictEqual(buildBulkUpdate('tag', null, [5]).params, [null, 5]);
  assert.strictEqual(buildBulkUpdate('content-type', null, [5]).params[0], null);
});

test('buildBulkUpdate: tag build with multiple ids + placeholder list', () => {
  const out = buildBulkUpdate('tag', 'skip', [3, 1, 2]);
  assert.strictEqual(out.sql, 'UPDATE posts SET tag = $1 WHERE id IN ($2,$3,$4)');
  assert.deepStrictEqual(out.params, ['skip', 3, 1, 2]);
  assert.deepStrictEqual(out.ids, [3, 1, 2]);
});

test('buildBulkUpdate: archive maps truthy/falsy → 1/0', () => {
  assert.deepStrictEqual(buildBulkUpdate('archive', true, [1]).params, [1, 1]);
  assert.deepStrictEqual(buildBulkUpdate('archive', false, [1]).params, [0, 1]);
});

test('buildBulkUpdate: non-integer/garbage ids dropped; empty → sql null', () => {
  assert.deepStrictEqual(buildBulkUpdate('tag', 'skip', ['x', 0, -2, null, 2.5]).sql, null);
  const out = buildBulkUpdate('tag', 'skip', ['4', 5, 'x']);
  assert.deepStrictEqual(out.ids, [4, 5]); // numeric strings coerced, garbage dropped
});

test('buildBulkUpdate: generated SQL actually updates the right rows (sqlite)', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE posts (id INTEGER PRIMARY KEY, tag TEXT)");
  db.exec("INSERT INTO posts (id, tag) VALUES (1,'recreate'),(2,NULL),(3,'reference')");
  const out = buildBulkUpdate('tag', 'skip', [1, 3]);
  const sqliteSql = out.sql.replace(/\$\d+/g, '?'); // mirror the dual-mode shim
  const info = db.prepare(sqliteSql).run(...out.params);
  assert.strictEqual(info.changes, 2);
  const rows = db.prepare('SELECT id, tag FROM posts ORDER BY id').all();
  assert.deepStrictEqual(rows, [{ id: 1, tag: 'skip' }, { id: 2, tag: null }, { id: 3, tag: 'skip' }]);
});

test('untagged WHERE clause selects only null/empty tags (sqlite)', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE posts (id INTEGER PRIMARY KEY, tag TEXT)");
  db.exec("INSERT INTO posts (id, tag) VALUES (1,'recreate'),(2,NULL),(3,''),(4,'skip')");
  const rows = db.prepare("SELECT id FROM posts WHERE (tag IS NULL OR tag = '') ORDER BY id").all();
  assert.deepStrictEqual(rows.map(r => r.id), [2, 3]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test content-bulk.test.js`
Expected: FAIL — `buildBulkUpdate` is not a function / Cannot find module './content-bulk'.

- [ ] **Step 3: Create the helper**

Create `server/content-bulk.js`:

```js
// Pure builder for the bulk content UPDATE. Validates against the same
// allow-lists the single-item /content routes use, coerces ids to positive
// integers, and returns a portable `id IN ($2,$3,…)` UPDATE (never ANY()).
const TAG_VALUES = ['recreate', 'reference', 'skip', null];
const CONTENT_TYPE_VALUES = ['talking', 'dance', 'skit', 'snapchat', 'omegle', 'osc', null];

function buildBulkUpdate(action, value, ids) {
  let column, param;
  if (action === 'tag') {
    if (!TAG_VALUES.includes(value)) return { error: 'Invalid tag' };
    column = 'tag'; param = value;
  } else if (action === 'content-type') {
    if (!CONTENT_TYPE_VALUES.includes(value)) return { error: 'Invalid content type' };
    column = 'content_type'; param = value;
  } else if (action === 'archive') {
    column = 'archived'; param = value ? 1 : 0;
  } else {
    return { error: 'Invalid action' };
  }

  const cleanIds = (Array.isArray(ids) ? ids : [])
    .map(n => Number(n))
    .filter(n => Number.isInteger(n) && n > 0);

  if (cleanIds.length === 0) return { sql: null, params: [], ids: [] };

  const placeholders = cleanIds.map((_, i) => `$${i + 2}`).join(',');
  const sql = `UPDATE posts SET ${column} = $1 WHERE id IN (${placeholders})`;
  return { sql, params: [param, ...cleanIds], ids: cleanIds };
}

module.exports = { buildBulkUpdate };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test content-bulk.test.js`
Expected: PASS (all 9 tests).

- [ ] **Step 5: Wire `POST /content/bulk` into `index.js`**

In `server/index.js`, immediately after the `POST /content/:id/archive` route (~L226), add:

```js
app.post('/content/bulk', async (req, res) => {
  const { action, value, ids } = req.body || {};
  const built = buildBulkUpdate(action, value, ids);
  if (built.error) return res.status(400).json({ error: built.error });
  if (!built.sql) return res.json({ updated: 0 });
  const result = await pool.query(built.sql, built.params);
  console.log(`[Content] bulk action=${action} value=${value} ids=${built.ids.length} updated=${result.rowCount}`);
  res.json({ updated: result.rowCount });
});
```

Add the require near the top of `index.js` with the other local requires (e.g. beside the `scheduler`/`scraper` requires):

```js
const { buildBulkUpdate } = require('./content-bulk');
```

- [ ] **Step 6: Add the `untagged` filter to `GET /content`**

In `server/index.js` `GET /content`, add `untagged` to the destructured query (~L143):

```js
  const { page = 1, limit = 24, sort = 'newest', tag, account, minViews, startDate, endDate, search, showArchived, contentType, untagged } = req.query;
```

Then, right after the `if (tag) { … }` line (~L150), add:

```js
  if (untagged === 'true') where.push(`(tag IS NULL OR tag = '')`);
```

- [ ] **Step 7: Run the full server suite**

Run: `cd server && npm test`
Expected: all existing tests + the new `content-bulk.test.js` pass (no regressions). `pool` is the shared dual-mode handle; the new route reuses it.

- [ ] **Step 8: Commit**

```bash
git add server/content-bulk.js server/content-bulk.test.js server/index.js
git commit -m "feat(content): bulk update endpoint + untagged filter

POST /content/bulk {ids,action,value} via pure buildBulkUpdate helper
(tag/archive/content-type, allow-list reuse, portable IN(...) UPDATE).
GET /content gains untagged=true → tag IS NULL OR tag=''."
```

---

### Task 2: Client — api helper, caption search, "Untagged" option

**Files:**
- Modify: `client/src/api.js` — add `bulkUpdateContent`.
- Modify: `client/src/components/FilterBar.js` — debounced search input; "Untagged" tag option.
- Modify: `client/src/pages/LibraryTab.js` — add `search` to filters; wire `search` + `untagged` into `loadContent`.

**Interfaces:**
- Consumes: `POST /content/bulk` (Task 1).
- Produces: `bulkUpdateContent(ids, action, value)` (used by Task 3). `filters.search` string; tag value `__untagged__` mapped to `untagged=true`.

- [ ] **Step 1: Add the api helper**

In `client/src/api.js`, after `setPostContentType` (~L18), add:

```js
export const bulkUpdateContent = (ids, action, value) => api.post('/content/bulk', { ids, action, value });
```

- [ ] **Step 2: Wire search + untagged into `LibraryTab.loadContent`**

In `client/src/pages/LibraryTab.js`, add `search: ''` to the initial `filters` state (after `sort: 'newest',`):

```js
    sort: 'newest',
    search: '',
```

In `loadContent`, change the `tag` and add `search`/`untagged` forwarding. Replace the existing `if (filters.tag) params.tag = filters.tag;` line with:

```js
      if (filters.tag === '__untagged__') params.untagged = 'true';
      else if (filters.tag) params.tag = filters.tag;
      if (filters.search) params.search = filters.search;
```

- [ ] **Step 3: Add the "Untagged" option + debounced search to `FilterBar`**

In `client/src/components/FilterBar.js`, add an "Untagged" `<option>` to the tag `<select>` (after the `skip` option):

```jsx
          <option value="skip">Skip</option>
          <option value="__untagged__">Untagged</option>
```

Add a debounced search input. At the top of the `FilterBar` component body add local state synced to `filters.search`:

```jsx
  const [searchText, setSearchText] = React.useState(filters.search || '');
  React.useEffect(() => { setSearchText(filters.search || ''); }, [filters.search]);
  React.useEffect(() => {
    const t = setTimeout(() => {
      if (searchText !== (filters.search || '')) onChange('search', searchText);
    }, 300);
    return () => clearTimeout(t);
  }, [searchText]); // eslint-disable-line react-hooks/exhaustive-deps
```

Render the input just before the Sort `<select>` (first control in the row):

```jsx
        <input
          type="text"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder="Search captions…"
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 w-44"
        />
```

(`React` is already imported as the default import in this file.)

- [ ] **Step 4: Verify build**

Run: `cd client && npm run build`
Expected: `Compiled successfully` (no eslint errors about the hooks/deps; the disable comment covers the intended debounce dep).

- [ ] **Step 5: Browser-verify**

Start the dev server (preview tooling). Confirm: typing in the search box filters the grid after a brief pause; selecting "Untagged" in the tag dropdown shows only untagged posts and the post-count reflects the backlog; clearing search/untagged restores results.

- [ ] **Step 6: Commit**

```bash
git add client/src/api.js client/src/components/FilterBar.js client/src/pages/LibraryTab.js
git commit -m "feat(library): caption search + untagged filter in FilterBar

Debounced caption search input (wires existing /content search param);
'Untagged' tag option maps to untagged=true. bulkUpdateContent api helper."
```

---

### Task 3: Client — multi-select (card checkbox, BulkActionBar, LibraryTab selection/loading)

**Files:**
- Create: `client/src/components/BulkActionBar.js`
- Modify: `client/src/components/ContentCard.js` — selection checkbox + `selected`/`onToggleSelect` props.
- Modify: `client/src/pages/LibraryTab.js` — `selected` Set + `loading` state, bulk handler, render `BulkActionBar`, pass selection props to cards.

**Interfaces:**
- Consumes: `bulkUpdateContent(ids, action, value)` (Task 2); `ContentCard` (modified); `BulkActionBar` (new).
- Produces: none (terminal task).

- [ ] **Step 1: Create `BulkActionBar`**

Create `client/src/components/BulkActionBar.js`:

```jsx
import React from 'react';

const TYPES = ['talking', 'dance', 'skit', 'snapchat', 'omegle', 'osc'];

export default function BulkActionBar({ count, onTag, onArchive, onSetType, onSelectAll, onClear }) {
  if (count === 0) return null;
  return (
    <div className="sticky top-2 z-20 bg-gray-900 border border-gold/40 rounded-xl p-3 flex flex-wrap items-center gap-2 shadow-lg">
      <span className="text-sm font-semibold text-gold mr-1">{count} selected</span>

      <span className="text-xs text-gray-500">Tag:</span>
      <button onClick={() => onTag('recreate')} className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-gray-800 border border-gray-700 text-gray-300 hover:text-white">♻️ Recreate</button>
      <button onClick={() => onTag('reference')} className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-gray-800 border border-gray-700 text-gray-300 hover:text-white">🔖 Reference</button>
      <button onClick={() => onTag('skip')} className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-gray-800 border border-gray-700 text-gray-300 hover:text-white">⏭️ Skip</button>

      <button onClick={() => onArchive(true)} className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-gray-800 border border-gray-700 text-gray-300 hover:text-white">📦 Archive</button>
      <button onClick={() => onArchive(false)} className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-gray-800 border border-gray-700 text-gray-300 hover:text-white">📤 Unarchive</button>

      <select
        defaultValue=""
        onChange={(e) => { if (e.target.value) { onSetType(e.target.value); e.target.value = ''; } }}
        className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300"
      >
        <option value="">Set type…</option>
        {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>

      <div className="flex-1" />
      <button onClick={onSelectAll} className="px-2.5 py-1.5 rounded-lg text-xs text-gray-400 hover:text-white">Select all on page</button>
      <button onClick={onClear} className="px-2.5 py-1.5 rounded-lg text-xs text-gray-400 hover:text-white">Clear</button>
    </div>
  );
}
```

- [ ] **Step 2: Add the selection checkbox to `ContentCard`**

In `client/src/components/ContentCard.js`, change the component signature (~L45) to accept the new props:

```jsx
export default function ContentCard({ post, creatorTypes = {}, onUpdate, selected = false, onToggleSelect }) {
```

Inside the thumbnail container (`<div className="relative aspect-[4/5] …">`, ~L88), add a checkbox overlay as the first child (top-left, opposite the tag badge):

```jsx
        {onToggleSelect && (
          <label className="absolute top-2 left-2 z-10 cursor-pointer" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggleSelect(post.id)}
              className="w-5 h-5 rounded accent-gold"
            />
          </label>
        )}
```

And give the card a highlight ring when selected — change the outer card `<div>` (~L86) to:

```jsx
    <div className={`bg-gray-900 rounded-xl border overflow-hidden group transition-colors ${selected ? 'border-gold ring-1 ring-gold/50' : 'border-gray-800 hover:border-gray-700'}`}>
```

- [ ] **Step 3: Add selection + loading state and the bulk handler to `LibraryTab`**

In `client/src/pages/LibraryTab.js`:

Import the new component (top, with the other imports):

```js
import BulkActionBar from '../components/BulkActionBar';
import { getContent, getCreators, exportContent, importUrls, bulkUpdateContent } from '../api';
```

Add state (after the existing `useState` hooks, ~L17):

```js
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(false);
```

Wrap the `getContent` call in `loadContent` with loading flags:

```js
  const loadContent = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: 24 };
      if (filters.sort) params.sort = filters.sort;
      if (filters.tag === '__untagged__') params.untagged = 'true';
      else if (filters.tag) params.tag = filters.tag;
      if (filters.search) params.search = filters.search;
      if (filters.account) params.account = filters.account;
      if (filters.contentType) params.contentType = filters.contentType;
      if (filters.minViews) params.minViews = filters.minViews;
      if (filters.startDate) params.startDate = filters.startDate;
      if (filters.endDate) params.endDate = filters.endDate;
      if (filters.showArchived) params.showArchived = 'true';

      const { data } = await getContent(params);
      setPosts(data.posts);
      setTotal(data.total);
      setTotalPages(data.totalPages);
      setAccounts(data.accounts || []);
    } catch (err) {
      console.error('Failed to load content:', err);
    } finally {
      setLoading(false);
    }
  }, [page, filters]);
```

(This supersedes the Task 2 edit to `loadContent`; the search/untagged forwarding is already folded in above.)

Clear selection on filter/page change — update `handleFilterChange` and add selection helpers:

```js
  const handleFilterChange = (key, value) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
    setSelected(new Set());
  };

  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const selectAllOnPage = () => setSelected(new Set(posts.map((p) => p.id)));
  const clearSelection = () => setSelected(new Set());

  const handleBulk = async (action, value) => {
    if (selected.size === 0) return;
    try {
      await bulkUpdateContent([...selected], action, value);
      clearSelection();
      loadContent();
      loadCreatorTypes();
    } catch (err) {
      console.error('Bulk action failed:', err);
      alert('Bulk action failed: ' + (err.response?.data?.error || err.message));
    }
  };
```

Also clear selection when paging — wrap the pagination buttons' handlers. Change the Previous/Next `onClick` to clear selection too:

```jsx
          <button onClick={() => { setPage((p) => Math.max(1, p - 1)); setSelected(new Set()); }} disabled={page === 1} className="px-3 py-1.5 rounded-lg text-sm bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-30">Previous</button>
```
```jsx
          <button onClick={() => { setPage((p) => Math.min(totalPages, p + 1)); setSelected(new Set()); }} disabled={page === totalPages} className="px-3 py-1.5 rounded-lg text-sm bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-30">Next</button>
```

- [ ] **Step 4: Render the bulk bar, loading state, and pass selection props to cards**

In `LibraryTab.js`, add the `BulkActionBar` directly under the `<FilterBar … />` element:

```jsx
      <BulkActionBar
        count={selected.size}
        onTag={(t) => handleBulk('tag', t)}
        onArchive={(a) => handleBulk('archive', a)}
        onSetType={(ct) => handleBulk('content-type', ct)}
        onSelectAll={selectAllOnPage}
        onClear={clearSelection}
      />
```

Replace the grid block so it shows a loading indicator and passes selection props. Change the `posts.map(...)` render to:

```jsx
      {loading ? (
        <div className="flex items-center justify-center py-20 text-gray-500">
          <svg className="w-6 h-6 animate-spin mr-2" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          Loading…
        </div>
      ) : posts.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-gray-500 text-lg">No content found.</p>
          <p className="text-gray-600 text-sm mt-1">Try adjusting your filters or scrape some content first.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {posts.map((post) => (
            <ContentCard
              key={post.id}
              post={post}
              creatorTypes={creatorTypes}
              onUpdate={handleUpdate}
              selected={selected.has(post.id)}
              onToggleSelect={toggleSelect}
            />
          ))}
        </div>
      )}
```

(This replaces the existing `posts.length === 0 ? (…) : (…)` ternary.)

- [ ] **Step 5: Verify build**

Run: `cd client && npm run build`
Expected: `Compiled successfully`.

- [ ] **Step 6: Browser-verify**

In the preview: tick a few card checkboxes → the sticky bar shows "N selected"; click **Skip** → those cards update to the skip tag and selection clears; **Select all on page** then **Archive** archives the page; changing a filter clears the selection; the loading spinner appears briefly on each fetch.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/BulkActionBar.js client/src/components/ContentCard.js client/src/pages/LibraryTab.js
git commit -m "feat(library): multi-select bulk tag/archive/set-type + loading state

Per-card checkbox + sticky BulkActionBar (mirrors Suggested tab); selection
Set clears on filter/page change; loading indicator during fetch."
```

---

## Self-Review

**1. Spec coverage:**
- §4a bulk endpoint → Task 1 (helper + route). ✓
- §4b `untagged` filter → Task 1 Step 6. ✓
- §4c selection + loading + search/untagged wiring → Task 3 Steps 3–4 (+ Task 2 search/untagged forwarding, superseded cleanly by Task 3's full `loadContent`). ✓
- §4d card checkbox → Task 3 Step 2. ✓
- §4e BulkActionBar → Task 3 Step 1. ✓
- §4f FilterBar search + "Untagged" + api helper → Task 2. ✓
- §7 observability log → Task 1 Step 5. ✓
- §9 tests (bulk validation/update/archive, untagged, portability) → Task 1 Step 1. ✓
- Non-goals (scale browsing, sort, persistence, bulk notes/delete) → not built. ✓

**2. Placeholder scan:** No TBD/TODO/vague steps — all code shown inline. The Task 2 `loadContent` edit is explicitly superseded by Task 3's full replacement (noted in-step) to avoid a stale-diff conflict. ✓

**3. Type consistency:** `buildBulkUpdate(action, value, ids)→{error}|{sql,params,ids}` used identically in helper, tests, and route. `bulkUpdateContent(ids, action, value)` argument order consistent across api.js, LibraryTab `handleBulk`, and BulkActionBar callbacks (`handleBulk('tag', t)` → `bulkUpdateContent(ids,'tag',t)`). Tag sentinel `__untagged__` consistent between FilterBar option and LibraryTab mapping. Props `selected`/`onToggleSelect` consistent between ContentCard and LibraryTab. ✓
