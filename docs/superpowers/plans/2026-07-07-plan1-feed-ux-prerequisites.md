# Plan 1 — Feed UX Prerequisites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Library/feed phone-friendly — inline autoplay-on-scroll video, an "Open on Instagram" button, and an editable content/creator-type list (which doubles as the niche vocabulary later) — so it's ready to become the models' mobile feed.

**Architecture:** Backend adds a `content_types` table + small CRUD endpoints, with all pure logic (slugify, defaults, validation) extracted into a testable `server/content-types.js` helper (mirrors the existing `content-bulk.js` pattern). Frontend replaces the two hardcoded type arrays with the fetched list, adds an "＋ Add new type…" affordance, gives `<video>` `playsInline`/`muted`, and adds an opt-in autoplay-in-view coordinator driven by a single `IntersectionObserver` in `LibraryTab`.

**Tech Stack:** Node + Express + `pg` (Postgres) / `better-sqlite3` (tests) backend; React (Create React App) frontend; `axios` client; Tailwind.

## Global Constraints

- **Backend tests:** `node --test` only. Extract pure logic into a helper module and test the helper with `better-sqlite3` in-memory where DB is involved — do NOT boot Express in tests. Pattern reference: `server/content-bulk.js` + `server/content-bulk.test.js`.
- **Frontend has NO test harness** (no `test` script, no testing-library, zero client tests). Do NOT add one. A frontend task's gate is: `cd client && npm run build` compiles clean, plus the manual browser/mobile checks written in the task.
- **Migrations:** use the idempotent pattern already in `server/db.js` — `CREATE TABLE IF NOT EXISTS` in the main block, and for Postgres-vs-SQLite differences follow the existing `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` list near `db.js:309` with its SQLite fallback branch.
- **Auth:** new endpoints sit behind the existing shared-password `requireAuth` (role gating arrives in Plan 2). Register new route prefixes with `app.use('<prefix>', requireAuth)` alongside the others at `index.js:99-113`.
- **File-reference style / commits:** frequent commits, one per task. Commit messages end with the repo's standard trailer already used in history.
- **No behavior change to the Radar tab:** `ContentCard` is shared by `LibraryTab` and `RadarTab`; all new video behavior is opt-in via props and must default OFF.

---

### Task 1: `content-types.js` helper (slugify + defaults + validation)

**Files:**
- Create: `server/content-types.js`
- Test: `server/content-types.test.js`

**Interfaces:**
- Produces:
  - `DEFAULT_CONTENT_TYPES: Array<{value: string, label: string}>` — the current six, in order.
  - `slugifyTypeLabel(label: string): string` — lowercase, trim, spaces/punctuation → single hyphen, strip leading/trailing hyphens.
  - `validateTypeLabel(label: string): { ok: true, value: string, label: string } | { ok: false, error: string }` — trims, rejects empty / >40 chars / slug that collapses to empty.

- [ ] **Step 1: Write the failing test**

```js
// server/content-types.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { DEFAULT_CONTENT_TYPES, slugifyTypeLabel, validateTypeLabel } = require('./content-types');

test('DEFAULT_CONTENT_TYPES holds the current six in order', () => {
  assert.deepStrictEqual(
    DEFAULT_CONTENT_TYPES.map(t => t.value),
    ['talking', 'dance', 'skit', 'snapchat', 'omegle', 'osc']
  );
});

test('slugifyTypeLabel lowercases, trims, hyphenates', () => {
  assert.strictEqual(slugifyTypeLabel('  Get Ready With Me '), 'get-ready-with-me');
  assert.strictEqual(slugifyTypeLabel('POV / Skit!!'), 'pov-skit');
  assert.strictEqual(slugifyTypeLabel('OSC'), 'osc');
});

test('validateTypeLabel accepts a normal label', () => {
  assert.deepStrictEqual(validateTypeLabel('Get Ready'), { ok: true, value: 'get-ready', label: 'Get Ready' });
});

test('validateTypeLabel rejects empty / whitespace / symbol-only', () => {
  assert.strictEqual(validateTypeLabel('   ').ok, false);
  assert.strictEqual(validateTypeLabel('!!!').ok, false);
});

test('validateTypeLabel rejects labels over 40 chars', () => {
  assert.strictEqual(validateTypeLabel('x'.repeat(41)).ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test content-types.test.js`
Expected: FAIL — `Cannot find module './content-types'`.

- [ ] **Step 3: Write minimal implementation**

```js
// server/content-types.js
const DEFAULT_CONTENT_TYPES = [
  { value: 'talking', label: 'Talking' },
  { value: 'dance', label: 'Dance' },
  { value: 'skit', label: 'Skit' },
  { value: 'snapchat', label: 'Snapchat' },
  { value: 'omegle', label: 'Omegle' },
  { value: 'osc', label: 'OSC' },
];

function slugifyTypeLabel(label) {
  return String(label || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function validateTypeLabel(label) {
  const trimmed = String(label || '').trim();
  if (!trimmed) return { ok: false, error: 'Label is required' };
  if (trimmed.length > 40) return { ok: false, error: 'Label too long (max 40)' };
  const value = slugifyTypeLabel(trimmed);
  if (!value) return { ok: false, error: 'Label must contain letters or numbers' };
  return { ok: true, value, label: trimmed };
}

module.exports = { DEFAULT_CONTENT_TYPES, slugifyTypeLabel, validateTypeLabel };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test content-types.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/content-types.js server/content-types.test.js
git commit -m "feat(types): content-types helper (slugify, defaults, validation)"
```

---

### Task 2: `content_types` table + seed in schema

**Files:**
- Modify: `server/db.js` (add table in the `CREATE TABLE` block near `db.js:130`; seed after tables are created)
- Test: `server/content-types-seed.test.js`

**Interfaces:**
- Consumes: `DEFAULT_CONTENT_TYPES` from Task 1.
- Produces: a `content_types` table (`id`, `value` UNIQUE, `label`, `sort_order`, `created_at`) seeded with the six defaults on an empty table. Exposes `seedContentTypes(db)` from a shared spot so it's testable. Put `seedContentTypes` in `server/content-types.js` (extends Task 1's module) and call it from `db.js`.

- [ ] **Step 1: Write the failing test**

```js
// server/content-types-seed.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { seedContentTypes } = require('./content-types');

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE content_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    value TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT '')`);
  // Adapter matching the `db.query(sql, params)` shape used in db.js
  return {
    query: async (sql, params = []) => {
      const norm = sql.replace(/\$\d+/g, '?');
      if (/^\s*select/i.test(norm)) return { rows: sqlite.prepare(norm).all(...params) };
      sqlite.prepare(norm).run(...params);
      return { rows: [] };
    },
  };
}

test('seedContentTypes inserts the six defaults into an empty table', async () => {
  const db = makeDb();
  await seedContentTypes(db);
  const { rows } = await db.query('SELECT value FROM content_types ORDER BY sort_order');
  assert.deepStrictEqual(rows.map(r => r.value), ['talking', 'dance', 'skit', 'snapchat', 'omegle', 'osc']);
});

test('seedContentTypes is idempotent (no duplicates on second run)', async () => {
  const db = makeDb();
  await seedContentTypes(db);
  await seedContentTypes(db);
  const { rows } = await db.query('SELECT COUNT(*) AS n FROM content_types');
  assert.strictEqual(Number(rows[0].n), 6);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test content-types-seed.test.js`
Expected: FAIL — `seedContentTypes is not a function`.

- [ ] **Step 3: Add `seedContentTypes` to the helper**

Append to `server/content-types.js` (and add to `module.exports`):

```js
async function seedContentTypes(db) {
  for (let i = 0; i < DEFAULT_CONTENT_TYPES.length; i++) {
    const t = DEFAULT_CONTENT_TYPES[i];
    // ON CONFLICT keeps this idempotent on both Postgres and the sqlite test adapter
    await db.query(
      'INSERT INTO content_types (value, label, sort_order, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (value) DO NOTHING',
      [t.value, t.label, i, new Date(0).toISOString()]
    );
  }
}
module.exports = { DEFAULT_CONTENT_TYPES, slugifyTypeLabel, validateTypeLabel, seedContentTypes };
```

> Note: replace the earlier `module.exports = {...}` line so there is exactly one export statement.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test content-types-seed.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the table + seed into `db.js`**

In `server/db.js`, in the main table-creation block (after the `creator_types` table near `db.js:134`), add:

```js
  await db.query(`
    CREATE TABLE IF NOT EXISTS content_types (
      id ${SERIAL},
      value TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT ${NOW_DEFAULT}
    )
  `);
```

Then, after all tables are created (end of the init function, before it returns), call the seed:

```js
  const { seedContentTypes } = require('./content-types');
  await seedContentTypes(db);
```

- [ ] **Step 6: Verify the server boots and seeds**

Run: `cd server && node -e "require('./db').init().then(()=>console.log('db init ok')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: prints `db init ok` with no error. (If `init`'s exact name/signature differs, match the export used by `index.js`.)

- [ ] **Step 7: Commit**

```bash
git add server/content-types.js server/content-types-seed.test.js server/db.js
git commit -m "feat(types): content_types table + idempotent seed of defaults"
```

---

### Task 3: `GET/POST/DELETE /content-types` endpoints

**Files:**
- Modify: `server/index.js` (register route prefix at the `app.use(..., requireAuth)` block ~`index.js:99-113`; add handlers near the other content routes)
- Test: `server/content-types-route.test.js` (unit-test the request→SQL logic via a small extracted helper)

**Interfaces:**
- Consumes: `validateTypeLabel` from Task 1.
- Produces HTTP:
  - `GET /content-types` → `200 [{ id, value, label, sort_order }]` ordered by `sort_order, label`.
  - `POST /content-types` body `{ label }` → `201 { id, value, label }` or `400 { error }`.
  - `DELETE /content-types/:id` → `200 { ok: true }`.

- [ ] **Step 1: Write the failing test (validation branch is the pure logic)**

```js
// server/content-types-route.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { validateTypeLabel } = require('./content-types');

// The route's only branching logic is validation; assert it directly so the
// handler stays a thin wrapper (same approach as content-bulk).
test('POST /content-types rejects a blank label before touching the DB', () => {
  const v = validateTypeLabel('   ');
  assert.strictEqual(v.ok, false);
});

test('POST /content-types normalizes a good label to value+label', () => {
  assert.deepStrictEqual(validateTypeLabel('Get Ready'), { ok: true, value: 'get-ready', label: 'Get Ready' });
});
```

- [ ] **Step 2: Run test to verify it passes against the Task 1 helper**

Run: `cd server && node --test content-types-route.test.js`
Expected: PASS (2 tests). (This locks the contract the handler must honor.)

- [ ] **Step 3: Add the route prefix to the auth block**

In `server/index.js`, alongside the existing `app.use('/content', requireAuth);` lines (~`index.js:100`), add:

```js
app.use('/content-types', requireAuth);
```

- [ ] **Step 4: Add the handlers**

In `server/index.js`, near the other `/content` handlers, add (adjust `pool`/`asyncHandler` to match the file's existing names):

```js
const { validateTypeLabel } = require('./content-types');

app.get('/content-types', asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT id, value, label, sort_order FROM content_types ORDER BY sort_order, label');
  res.json(result.rows);
}));

app.post('/content-types', asyncHandler(async (req, res) => {
  const v = validateTypeLabel(req.body && req.body.label);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const existing = await pool.query('SELECT id, value, label FROM content_types WHERE value = $1', [v.value]);
  if (existing.rows.length) return res.status(200).json(existing.rows[0]); // idempotent add
  const max = await pool.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM content_types');
  const ins = await pool.query(
    'INSERT INTO content_types (value, label, sort_order, created_at) VALUES ($1,$2,$3,$4) RETURNING id, value, label',
    [v.value, v.label, Number(max.rows[0].next) || 0, new Date().toISOString()]
  );
  res.status(201).json(ins.rows[0]);
}));

app.delete('/content-types/:id', asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM content_types WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
}));
```

- [ ] **Step 5: Manually verify against a running server**

Run (in one shell): `cd server && npm start`
Run (in another): `curl -s localhost:4000/content-types` (with auth cookie if `AUTH_PASSWORD` is set — or unset it locally) 
Expected: JSON array containing the six seeded types. Then `curl -s -XPOST localhost:4000/content-types -H 'Content-Type: application/json' -d '{"label":"Get Ready"}'` → `{ "id":..., "value":"get-ready", "label":"Get Ready" }`, and it now appears in the GET list.

- [ ] **Step 6: Commit**

```bash
git add server/index.js server/content-types-route.test.js
git commit -m "feat(types): GET/POST/DELETE /content-types endpoints"
```

---

### Task 4: API client functions for content types

**Files:**
- Modify: `client/src/api.js`

**Interfaces:**
- Produces: `getContentTypes()`, `addContentType(label)`, `deleteContentType(id)` (axios calls returning the standard `{ data }`).

- [ ] **Step 1: Add the client functions**

In `client/src/api.js`, near the other content exports (~`api.js:19`), add:

```js
export const getContentTypes = () => api.get('/content-types');
export const addContentType = (label) => api.post('/content-types', { label });
export const deleteContentType = (id) => api.delete(`/content-types/${id}`);
```

- [ ] **Step 2: Verify the client still builds**

Run: `cd client && npm run build`
Expected: `Compiled successfully` (warnings OK, no errors).

- [ ] **Step 3: Commit**

```bash
git add client/src/api.js
git commit -m "feat(types): api client for content-types CRUD"
```

---

### Task 5: Dynamic type list in the Library UI (replace hardcoded arrays + "＋ Add new type…")

**Files:**
- Modify: `client/src/pages/LibraryTab.js` (fetch types; pass down; add-type handler)
- Modify: `client/src/components/ContentCard.js` (consume `contentTypes` prop for both dropdowns; add-new option)
- Modify: `client/src/components/FilterBar.js` (consume `contentTypes` prop for the type filter)

**Interfaces:**
- Consumes: `getContentTypes`, `addContentType` from Task 4.
- Produces: `ContentCard` and `FilterBar` both accept a `contentTypes` prop: `Array<{ value, label }>`. `ContentCard` accepts `onAddContentType: (label) => Promise<{value,label}>`.

- [ ] **Step 1: Fetch + hold types in `LibraryTab`**

In `client/src/pages/LibraryTab.js`, add state and a loader (mirroring the existing `loadCreatorTypes` at `LibraryTab.js:33`):

```js
const [contentTypes, setContentTypes] = useState([]);

const loadContentTypes = useCallback(async () => {
  try {
    const { data } = await getContentTypes();
    setContentTypes(data);
  } catch {}
}, []);

const handleAddContentType = useCallback(async (label) => {
  const { data } = await addContentType(label);
  await loadContentTypes();
  return data; // { value, label }
}, [loadContentTypes]);
```

Call `loadContentTypes()` in the existing mount effect (`LibraryTab.js:71`), and import `getContentTypes, addContentType` from `../api`.

- [ ] **Step 2: Pass the props into `FilterBar` and each `ContentCard`**

In `LibraryTab.js`, update the `<FilterBar ... />` (`LibraryTab.js:172`) to add `contentTypes={contentTypes}`, and the `<ContentCard ... />` (`LibraryTab.js:205`) to add `contentTypes={contentTypes}` and `onAddContentType={handleAddContentType}`.

- [ ] **Step 3: Consume the prop in `ContentCard`, delete the hardcoded array**

In `client/src/components/ContentCard.js`: delete the `CONTENT_TYPES` const (`ContentCard.js:12-19`). Add `contentTypes = [], onAddContentType` to the destructured props (`ContentCard.js:57`). In both `<select>` blocks (`ContentCard.js:290` and `:305`), map over `contentTypes` instead of `CONTENT_TYPES`, and add a trailing add-new option:

```jsx
{contentTypes.map((ct) => (
  <option key={ct.value} value={ct.value}>{ct.label}</option>
))}
<option value="__add__">＋ Add new type…</option>
```

Update `handleCreatorType`/`handlePostType` so selecting `__add__` prompts and adds instead of saving:

```js
const maybeAdd = async (val, apply) => {
  if (val === '__add__') {
    const label = window.prompt('New type name:');
    if (!label || !onAddContentType) return;
    const created = await onAddContentType(label);
    if (created && created.value) await apply(created.value);
    return;
  }
  await apply(val || null);
};

const handleCreatorType = (e) => maybeAdd(e.target.value, (v) => setCreatorType(post.account_handle, v).then(onUpdate));
const handlePostType = (e) => maybeAdd(e.target.value, (v) => setPostContentType(post.id, v).then(onUpdate));
```

- [ ] **Step 4: Consume the prop in `FilterBar`, delete its hardcoded options**

In `client/src/components/FilterBar.js`, change the signature to accept `contentTypes = []` (`FilterBar.js:4`) and replace the hardcoded `<option>`s (`FilterBar.js:83-88`) with:

```jsx
{contentTypes.map((ct) => (
  <option key={ct.value} value={ct.value}>{ct.label}</option>
))}
```

- [ ] **Step 5: Verify build + manual check**

Run: `cd client && npm run build`
Expected: `Compiled successfully`.
Manual (run `npm start` for client + server): open Library → the type dropdowns and the filter show the six types; pick "＋ Add new type…", enter "Test Type", confirm it saves, appears everywhere, and persists after a reload. Then remove it isn't required here (delete UI is admin-side later) — leaving it is fine.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/LibraryTab.js client/src/components/ContentCard.js client/src/components/FilterBar.js
git commit -m "feat(types): dynamic editable type list in Library UI"
```

---

### Task 6: "Open on Instagram" button on the card

**Files:**
- Modify: `client/src/components/ContentCard.js`

**Interfaces:**
- Produces: a button in the card actions linking to the specific reel.

- [ ] **Step 1: Add the reel URL + button**

In `client/src/components/ContentCard.js`, compute the reel URL near the top of the component:

```js
const reelUrl = post.post_url || (post.shortcode ? `https://www.instagram.com/reel/${post.shortcode}/` : null);
```

In the actions area (inside the `isLibrary` block, after the Archive button ~`ContentCard.js:330`, and also outside `isLibrary` so the model feed gets it later), add:

```jsx
{reelUrl && (
  <a
    href={reelUrl}
    target="_blank"
    rel="noopener noreferrer"
    className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium border border-gray-700 bg-gray-800 text-gray-300 hover:text-white hover:border-gray-600"
  >
    <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2.2c3.2 0 3.6 0 4.9.1 1.2.1 1.8.3 2.2.4.6.2 1 .5 1.4.9.4.4.7.8.9 1.4.1.4.3 1 .4 2.2.1 1.3.1 1.7.1 4.9s0 3.6-.1 4.9c-.1 1.2-.3 1.8-.4 2.2-.2.6-.5 1-.9 1.4-.4.4-.8.7-1.4.9-.4.1-1 .3-2.2.4-1.3.1-1.7.1-4.9.1s-3.6 0-4.9-.1c-1.2-.1-1.8-.3-2.2-.4a3.9 3.9 0 0 1-1.4-.9 3.9 3.9 0 0 1-.9-1.4c-.1-.4-.3-1-.4-2.2C2.2 15.6 2.2 15.2 2.2 12s0-3.6.1-4.9c.1-1.2.3-1.8.4-2.2.2-.6.5-1 .9-1.4.4-.4.8-.7 1.4-.9.4-.1 1-.3 2.2-.4C8.4 2.2 8.8 2.2 12 2.2Zm0 3.2A6.6 6.6 0 1 0 18.6 12 6.6 6.6 0 0 0 12 5.4Zm0 10.9A4.3 4.3 0 1 1 16.3 12 4.3 4.3 0 0 1 12 16.3Zm6.9-11.1a1.5 1.5 0 1 0 1.5 1.5 1.5 1.5 0 0 0-1.5-1.5Z"/></svg>
    Open on Instagram
  </a>
)}
```

Place one copy so it renders for both variants (e.g. just before `{actionSlot}` at `ContentCard.js:334`, which is outside the `isLibrary` guard).

- [ ] **Step 2: Verify build + manual check**

Run: `cd client && npm run build`
Expected: `Compiled successfully`.
Manual: open Library, click "Open on Instagram" on a card → a new tab opens the exact reel (not just the profile).

- [ ] **Step 3: Commit**

```bash
git add client/src/components/ContentCard.js
git commit -m "feat(library): Open on Instagram button linking to the exact reel"
```

---

### Task 7: Inline autoplay-on-scroll video (opt-in, mobile-scoped)

**Files:**
- Modify: `client/src/components/ContentCard.js` (playsInline/muted; active-in-view rendering; sound toggle)
- Modify: `client/src/pages/LibraryTab.js` (IntersectionObserver coordinator; enable only on touch/small screens; shared sound state)

**Interfaces:**
- Consumes: nothing new.
- Produces: `ContentCard` accepts `autoplayInView: boolean`, `isActive: boolean`, `soundOn: boolean`, `onToggleSound: () => void`, and (via a ref) reports its DOM node for observation through a new `registerRef?: (id, node) => void` prop. Default all OFF so `RadarTab` is unaffected.

- [ ] **Step 1: Give the existing `<video>` inline + muted behavior**

In `client/src/components/ContentCard.js`, the tap-to-play `<video>` (`ContentCard.js:127-133`) gains `playsInline` and respects the shared sound state:

```jsx
<video
  src={post.video_url}
  controls
  autoPlay
  playsInline
  muted={autoplayInView ? !soundOn : false}
  loop
  className="w-full h-full object-cover"
/>
```

- [ ] **Step 2: Render an autoplaying muted video when the card is the active one**

Add `autoplayInView = false, isActive = false, soundOn = false, onToggleSound, registerRef` to the destructured props (`ContentCard.js:57`). Replace the thumbnail/video branch (`ContentCard.js:127`) so that, when `autoplayInView` and this card `isActive` and there is a `video_url`, it shows the autoplaying muted video with a sound toggle; otherwise it shows the thumbnail exactly as today:

```jsx
{(showVideo || (autoplayInView && isActive)) && post.video_url ? (
  <>
    <video
      src={post.video_url}
      autoPlay
      playsInline
      muted={autoplayInView ? !soundOn : false}
      loop
      controls={!autoplayInView}
      className="w-full h-full object-cover"
      onError={() => { /* Plan 3 wires re-resolve here */ }}
    />
    {autoplayInView && (
      <button
        onClick={(e) => { e.stopPropagation(); onToggleSound && onToggleSound(); }}
        className="absolute bottom-2 right-2 z-10 w-9 h-9 rounded-full bg-black/60 text-white flex items-center justify-center"
        title={soundOn ? 'Mute' : 'Unmute'}
      >
        {soundOn ? '🔊' : '🔇'}
      </button>
    )}
  </>
) : (
  /* existing thumbnail <img> + play-button block, unchanged */
)}
```

Wrap the outer card `<div>` (`ContentCard.js:114`) with a ref that reports to the parent when `autoplayInView`:

```jsx
const cardRef = useRef(null);
useEffect(() => {
  if (autoplayInView && registerRef && cardRef.current) registerRef(cardId, cardRef.current);
}, [autoplayInView, registerRef, cardId]);
// ...
<div ref={cardRef} className={...}>
```

- [ ] **Step 3: Add the IntersectionObserver coordinator in `LibraryTab`**

In `client/src/pages/LibraryTab.js`, add touch detection, a shared sound state, an active-id state, and the observer:

```js
const autoplayInView = typeof window !== 'undefined'
  && window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
const [activeCardId, setActiveCardId] = useState(null);
const [soundOn, setSoundOn] = useState(false);
const nodeMap = useRef(new Map());       // id -> DOM node
const ratioMap = useRef(new Map());      // id -> intersectionRatio
const observerRef = useRef(null);

const registerRef = useCallback((id, node) => {
  if (!autoplayInView || !node) return;
  nodeMap.current.set(id, node);
  node.dataset.cardId = String(id);
  if (observerRef.current) observerRef.current.observe(node);
}, [autoplayInView]);

useEffect(() => {
  if (!autoplayInView) return;
  const obs = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const id = e.target.dataset.cardId;
      ratioMap.current.set(id, e.isIntersecting ? e.intersectionRatio : 0);
    }
    let bestId = null, best = 0;
    for (const [id, r] of ratioMap.current.entries()) {
      if (r > best) { best = r; bestId = id; }
    }
    setActiveCardId(best >= 0.6 ? (isNaN(Number(bestId)) ? bestId : Number(bestId)) : null);
  }, { threshold: [0, 0.6, 1] });
  observerRef.current = obs;
  for (const node of nodeMap.current.values()) obs.observe(node);
  return () => obs.disconnect();
}, [autoplayInView, posts]);
```

Then pass the new props to each card:

```jsx
<ContentCard
  key={post.id}
  post={post}
  /* ...existing props... */
  contentTypes={contentTypes}
  onAddContentType={handleAddContentType}
  autoplayInView={autoplayInView}
  isActive={post.id === activeCardId}
  soundOn={soundOn}
  onToggleSound={() => setSoundOn((s) => !s)}
  registerRef={registerRef}
/>
```

- [ ] **Step 4: Verify build**

Run: `cd client && npm run build`
Expected: `Compiled successfully`.

- [ ] **Step 5: Manual verification (the important gate — real mobile behavior)**

With client + server running, open the Library in Chrome DevTools **device mode** (or a real phone) and confirm:
1. As you scroll, the most-visible card's video **autoplays muted, inline** — it does **not** go fullscreen.
2. Only **one** video plays at a time; scrolling to the next swaps play to it and the previous reverts to its thumbnail.
3. Tapping the 🔇/🔊 button **unmutes**, and the unmuted state carries to the next card.
4. On **desktop** (mouse), behavior is unchanged: thumbnails with the hover play-button, tap-to-play as before (no mass autoplay).
5. The **Radar tab** is visually unchanged (no autoplay), confirming the opt-in default held.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/ContentCard.js client/src/pages/LibraryTab.js
git commit -m "feat(library): inline autoplay-on-scroll video on mobile (opt-in, one at a time)"
```

---

## Self-Review

**Spec coverage (Plan 1 slice = B1, B3, B5):**
- B3 editable types → Tasks 1–5 (helper, table+seed, endpoints, api client, UI wiring). ✅
- B5 Open-on-Instagram → Task 6. ✅
- B1 autoplay/inline/playsInline/one-at-a-time/unmute/desktop-preserved/Radar-unaffected → Task 7. ✅
- B2/B4/B6 and Epic A → deliberately out of scope for Plan 1 (separate plans). The `onError` hook in Task 7 Step 2 is a stub comment reserved for Plan 3's re-resolve; no dangling call.

**Placeholder scan:** no TBD/TODO; every code step shows real code; manual-check steps list concrete, observable expectations.

**Type consistency:** `contentTypes: Array<{value,label}>` used identically in `ContentCard` and `FilterBar`; `onAddContentType(label) → {value,label}` matches `handleAddContentType`'s return; `registerRef(id, node)` matches the observer's `nodeMap`/`dataset.cardId` usage; `soundOn`/`onToggleSound` consistent across `LibraryTab` and `ContentCard`.

## Execution Handoff

Plan 1 is complete and saved to `docs/superpowers/plans/2026-07-07-plan1-feed-ux-prerequisites.md`. Plans 2 (Model Accounts + Personalization) and 3 (Reliability + Dedup + Audio) will be written next, informed by how Plan 1 lands.
