# Plan 2 — Model Accounts + Personalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each model their own login to a personalized, mobile-first account — a niche-scoped feed, personal saves, and their AI ideas — while the admin keeps the full tool, with hard per-model data isolation.

**Architecture:** Extend the existing `models` table into login identities (email + bcrypt hash + role). Replace the single boolean session (`req.session.authenticated`) with `req.session.user = { id, role, modelId }`, keeping the current team-password admin login working (back-compat). Admin routes get a `requireAdmin` gate; a new `/me/*` route family derives `modelId` **from the session only** and serves the model's niche-scoped feed / saves / ideas. The frontend branches on role at login: admin → existing 8-tab tool; model → a new mobile `ModelApp` (Feed / Saved / Ideas). "Niche" = the `content_types` vocabulary (Plan 1), matched via `COALESCE(posts.content_type, creator_types.content_type)` exactly as `ai-agent.js` already does.

**Tech Stack:** Node + Express + `express-session` + `bcryptjs` + `pg` / `better-sqlite3` (tests); React (CRA) + `axios` + Tailwind.

## Global Constraints

- **Backend tests:** `node --test` only, on extracted pure logic + `better-sqlite3` in-memory (pattern: `server/content-bulk.js` + `.test.js`; `server/content-types.js` + seed test). Do NOT boot Express in tests.
- **Frontend has NO test harness** — do NOT add one. Gate = `cd client && npm run build` compiles clean + explicit manual checks.
- **Migrations:** idempotent `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`, following `server/db.js` (with its SQLite fallback branch); seed/bootstrap after tables exist (pattern: `seedContentTypes` call in `initDB`).
- **SECURITY — non-negotiable, Codex will scrutinize:**
  - Every `/me/*` handler derives `modelId` **from `req.session.user.modelId`**, NEVER from a route param, query, or body. A model must not read/write another model's data by changing an id.
  - Bcrypt (cost 10, matching the existing `bcrypt.hashSync(AUTH_PASSWORD, 10)`) for model passwords; never store or log plaintext.
  - `requireAdmin` on every existing admin route; models reach ONLY `/me/*`, `/auth/check`, `/login`, `/logout`, `/thumb`, `/thumbnails`.
  - Preserve the existing `checkProdSecrets` boot fail-fast and the `x-api-key` admin bypass (`API_KEY`).
  - Login attempts are throttled (per-identifier lockout) to blunt brute force.
- **Back-compat:** the current admin login (team `AUTH_PASSWORD`, no email) must keep working; existing behavior when `AUTH_PASSWORD` is unset (auth disabled → treat as admin) must be preserved.
- **Commits:** one per task, frequent.
- **This plan will be reviewed by `/codex-review` before execution.** Base branch: `mobile-model-accounts` (off the merged `reel-radar-discovery`, which contains Plan 1).

---

### Task 1: Schema — model login columns + `model_saved_posts`

**Files:**
- Modify: `server/db.js` (add ALTERs to the migration list near the existing `ADD COLUMN IF NOT EXISTS` block ~`db.js:318`; add `model_saved_posts` in the `CREATE TABLE` block)
- Test: `server/model-schema.test.js`

**Interfaces:**
- Produces: `models` gains `email TEXT`, `password_hash TEXT`, `role TEXT DEFAULT 'model'`, `login_enabled INTEGER DEFAULT 0`. New table `model_saved_posts (model_id INTEGER, post_id INTEGER, saved_at TEXT, PRIMARY KEY(model_id, post_id))`. A partial-unique index on `models(email)` where email is not null (Postgres) — for SQLite dev, a plain index is acceptable.

- [ ] **Step 1: Write the failing test**

```js
// server/model-schema.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

// Mirrors the columns/table the migration must add; if db.js drifts, this fails.
test('model login columns + model_saved_posts exist after applying the migration DDL', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE models (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, primary_niche TEXT)`);
  // The migration statements (SQLite forms) — keep in sync with db.js:
  db.exec(`ALTER TABLE models ADD COLUMN email TEXT`);
  db.exec(`ALTER TABLE models ADD COLUMN password_hash TEXT`);
  db.exec(`ALTER TABLE models ADD COLUMN role TEXT DEFAULT 'model'`);
  db.exec(`ALTER TABLE models ADD COLUMN login_enabled INTEGER DEFAULT 0`);
  db.exec(`CREATE TABLE IF NOT EXISTS model_saved_posts (model_id INTEGER, post_id INTEGER, saved_at TEXT, PRIMARY KEY(model_id, post_id))`);
  const cols = db.prepare(`PRAGMA table_info(models)`).all().map(c => c.name);
  for (const c of ['email', 'password_hash', 'role', 'login_enabled']) assert.ok(cols.includes(c), `models.${c} missing`);
  const saved = db.prepare(`PRAGMA table_info(model_saved_posts)`).all().map(c => c.name);
  assert.deepStrictEqual(saved.sort(), ['model_id', 'post_id', 'saved_at'].sort());
});
```

- [ ] **Step 2: Run test to verify it passes (it asserts the DDL shape the migration must add)**

Run: `cd server && node --test model-schema.test.js` → PASS (locks the contract).

- [ ] **Step 3: Add the migrations to `db.js`**

In the `ADD COLUMN IF NOT EXISTS` migration array (the Postgres branch near `db.js:309-320`, plus the SQLite `ADD COLUMN` fallback branch near `db.js:325-334`), add the four `models` columns following the existing pattern exactly. In the `CREATE TABLE` block (after `models`, near `db.js:214`), add:

```js
  await db.query(`
    CREATE TABLE IF NOT EXISTS model_saved_posts (
      model_id INTEGER NOT NULL,
      post_id INTEGER NOT NULL,
      saved_at TEXT DEFAULT ${NOW_DEFAULT},
      PRIMARY KEY (model_id, post_id)
    )
  `);
```

- [ ] **Step 4: Boot check**

Run: `cd server && node -e "require('./db').initDB().then(()=>console.log('ok')).catch(e=>{console.error(e);process.exit(1)})"` → prints `ok`.

- [ ] **Step 5: Commit**

```bash
git add server/db.js server/model-schema.test.js
git commit -m "feat(auth): model login columns + model_saved_posts schema"
```

---

### Task 2: `server/auth.js` helper (hashing, login resolution, throttle)

**Files:**
- Create: `server/auth.js`
- Test: `server/auth.test.js`

**Interfaces:**
- Produces:
  - `hashPassword(plain): string` and `verifyPassword(plain, hash): boolean` (bcrypt cost 10).
  - `resolveLogin({ email, password }, ctx): { ok, user } | { ok:false, error }` — pure resolution given `ctx = { adminPasswordHash, models: [{id,email,password_hash,role,login_enabled}] }`. Rules: if no `email` → admin path (verify `password` against `adminPasswordHash`, yield `{id:0, role:'admin', modelId:null}`); if `email` → find a model with that email AND `login_enabled` AND matching `password_hash`, yield `{id: m.id, role: m.role||'model', modelId: m.id}`; else `{ok:false, error:'Invalid credentials'}`.
  - `LoginThrottle` — `new LoginThrottle({max=5, windowMs=15*60000})` with `check(key)`, `fail(key)`, `reset(key)`; `check` returns `{blocked, retryInSec}`.

- [ ] **Step 1: Write the failing test**

```js
// server/auth.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { hashPassword, verifyPassword, resolveLogin, LoginThrottle } = require('./auth');

test('hash/verify round-trips and rejects wrong password', () => {
  const h = hashPassword('s3cret!');
  assert.ok(verifyPassword('s3cret!', h));
  assert.strictEqual(verifyPassword('nope', h), false);
});

test('resolveLogin: no email → admin when team password matches', () => {
  const adminPasswordHash = hashPassword('teampw');
  const r = resolveLogin({ password: 'teampw' }, { adminPasswordHash, models: [] });
  assert.deepStrictEqual(r, { ok: true, user: { id: 0, role: 'admin', modelId: null } });
});

test('resolveLogin: wrong admin password rejected', () => {
  const r = resolveLogin({ password: 'x' }, { adminPasswordHash: hashPassword('teampw'), models: [] });
  assert.strictEqual(r.ok, false);
});

test('resolveLogin: model email+password, login_enabled required', () => {
  const models = [{ id: 7, email: 'mia@x.com', password_hash: hashPassword('pw'), role: 'model', login_enabled: 1 }];
  const ok = resolveLogin({ email: 'mia@x.com', password: 'pw' }, { adminPasswordHash: null, models });
  assert.deepStrictEqual(ok, { ok: true, user: { id: 7, role: 'model', modelId: 7 } });
  const disabled = resolveLogin({ email: 'mia@x.com', password: 'pw' }, { adminPasswordHash: null, models: [{ ...models[0], login_enabled: 0 }] });
  assert.strictEqual(disabled.ok, false);
  const wrong = resolveLogin({ email: 'mia@x.com', password: 'bad' }, { adminPasswordHash: null, models });
  assert.strictEqual(wrong.ok, false);
});

test('LoginThrottle blocks after max failures and resets', () => {
  const t = new LoginThrottle({ max: 2, windowMs: 60000, now: () => 1000 });
  assert.strictEqual(t.check('a').blocked, false);
  t.fail('a'); t.fail('a');
  assert.strictEqual(t.check('a').blocked, true);
  t.reset('a');
  assert.strictEqual(t.check('a').blocked, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test auth.test.js` → FAIL (`Cannot find module './auth'`).

- [ ] **Step 3: Implement `server/auth.js`**

```js
const bcrypt = require('bcryptjs');

function hashPassword(plain) { return bcrypt.hashSync(String(plain || ''), 10); }
function verifyPassword(plain, hash) { return !!hash && bcrypt.compareSync(String(plain || ''), hash); }

function resolveLogin({ email, password } = {}, ctx = {}) {
  const { adminPasswordHash = null, models = [] } = ctx;
  if (!email) {
    if (adminPasswordHash && verifyPassword(password, adminPasswordHash)) {
      return { ok: true, user: { id: 0, role: 'admin', modelId: null } };
    }
    return { ok: false, error: 'Invalid credentials' };
  }
  const m = models.find(x => x.email && x.email.toLowerCase() === String(email).toLowerCase());
  if (m && m.login_enabled && verifyPassword(password, m.password_hash)) {
    return { ok: true, user: { id: m.id, role: m.role || 'model', modelId: m.id } };
  }
  return { ok: false, error: 'Invalid credentials' };
}

class LoginThrottle {
  constructor({ max = 5, windowMs = 15 * 60000, now = () => Date.now() } = {}) {
    this.max = max; this.windowMs = windowMs; this.now = now; this.hits = new Map();
  }
  _fresh(key) {
    const e = this.hits.get(key);
    if (e && this.now() - e.first > this.windowMs) { this.hits.delete(key); return null; }
    return e || null;
  }
  check(key) {
    const e = this._fresh(key);
    if (e && e.count >= this.max) return { blocked: true, retryInSec: Math.ceil((e.first + this.windowMs - this.now()) / 1000) };
    return { blocked: false, retryInSec: 0 };
  }
  fail(key) {
    const e = this._fresh(key) || { count: 0, first: this.now() };
    e.count += 1; this.hits.set(key, e);
  }
  reset(key) { this.hits.delete(key); }
}

module.exports = { hashPassword, verifyPassword, resolveLogin, LoginThrottle };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test auth.test.js` → PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/auth.js server/auth.test.js
git commit -m "feat(auth): auth helper — hashing, login resolution, throttle"
```

---

### Task 3: Session-based login/roles wiring in `index.js`

**Files:**
- Modify: `server/index.js` (`/login`, `/logout`, `/auth/check`, `requireAuth`; add `requireAdmin`, `requireModel`)

**Interfaces:**
- Consumes: `resolveLogin`, `LoginThrottle`, `hashPassword` from Task 2.
- Produces: `req.session.user = { id, role, modelId }`; `/auth/check` → `{ authenticated, authRequired, role, modelId }`; middlewares `requireAuth` (any valid user or API key), `requireAdmin` (role==='admin' or API key), `requireModel` (role==='model' with a modelId).

- [ ] **Step 1: Rewrite `/login`, `/auth/check`, `/logout`, and add middleware**

Replace the block at `server/index.js:73-98` with:

```js
const { resolveLogin, LoginThrottle } = require('./auth');
const loginThrottle = new LoginThrottle({ max: 5, windowMs: 15 * 60000 });

app.get('/auth/check', (req, res) => {
  if (!passwordHash) return res.json({ authenticated: true, authRequired: false, role: 'admin', modelId: null });
  const u = req.session.user;
  res.json({ authenticated: !!u, authRequired: true, role: u ? u.role : null, modelId: u ? u.modelId : null });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!passwordHash) { // auth disabled (dev) → admin
    req.session.user = { id: 0, role: 'admin', modelId: null };
    return res.json({ success: true, role: 'admin' });
  }
  const key = (email ? String(email).toLowerCase() : 'admin') + '|' + (req.ip || '');
  const gate = loginThrottle.check(key);
  if (gate.blocked) return res.status(429).json({ error: `Too many attempts. Try again in ${gate.retryInSec}s.` });

  let models = [];
  if (email) {
    const r = await pool.query('SELECT id, email, password_hash, role, login_enabled FROM models WHERE LOWER(email) = LOWER($1)', [email]);
    models = r.rows;
  }
  const out = resolveLogin({ email, password }, { adminPasswordHash: passwordHash, models });
  if (!out.ok) { loginThrottle.fail(key); return res.status(401).json({ error: 'Invalid credentials' }); }
  loginThrottle.reset(key);
  req.session.user = out.user;
  res.json({ success: true, role: out.user.role });
});

app.post('/logout', (req, res) => { req.session.destroy(() => res.json({ success: true })); });

function requireAuth(req, res, next) {
  if (!passwordHash) return next();
  if (API_KEY && req.headers['x-api-key'] === API_KEY) return next();
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'Not authenticated' });
}
function requireAdmin(req, res, next) {
  if (!passwordHash) return next();
  if (API_KEY && req.headers['x-api-key'] === API_KEY) return next();
  if (req.session && req.session.user && req.session.user.role === 'admin') return next();
  res.status(403).json({ error: 'Admin only' });
}
function requireModel(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'model' && req.session.user.modelId) return next();
  // In no-auth dev mode there is no model context; 403 is correct.
  res.status(403).json({ error: 'Model account required' });
}
```

> Note: `passwordHash` (admin team hash), `API_KEY`, and `pool` already exist above this block.

- [ ] **Step 2: Verify the server boots and admin login still works (back-compat)**

Run: `cd server && AUTH_PASSWORD=teampw node -e "require('./index')" &` then `curl -s -XPOST localhost:4000/login -H 'Content-Type: application/json' -d '{"password":"teampw"}'` → `{"success":true,"role":"admin"}`; `curl -s localhost:4000/auth/check --cookie-jar /tmp/j --cookie /tmp/j` shows `role:"admin"`. (Kill the server after.) Document the exact commands/outputs in the report.

- [ ] **Step 3: Commit**

```bash
git add server/index.js
git commit -m "feat(auth): session user + role login, throttle, requireAdmin/requireModel"
```

---

### Task 4: Gate admin routes with `requireAdmin`

**Files:**
- Modify: `server/index.js` (the `app.use('<prefix>', requireAuth)` block at `index.js:100-115`)
- Test: `server/route-gating.test.js`

**Interfaces:**
- Consumes: `requireAdmin` from Task 3.
- Produces: admin route prefixes use `requireAdmin`; `/me` (new) uses `requireModel`. A model session gets 403 on admin routes.

- [ ] **Step 1: Write the failing test (pure role-gate logic)**

```js
// server/route-gating.test.js
const { test } = require('node:test');
const assert = require('node:assert');
// A tiny pure model of the gate to lock the intended policy.
function gate(kind, user) {
  if (kind === 'admin') return user && user.role === 'admin';
  if (kind === 'model') return user && user.role === 'model' && !!user.modelId;
  return !!user;
}
test('admin gate: model session denied, admin allowed', () => {
  assert.strictEqual(gate('admin', { role: 'model', modelId: 7 }), false);
  assert.strictEqual(gate('admin', { role: 'admin', modelId: null }), true);
});
test('model gate: admin (no modelId) denied, model allowed', () => {
  assert.strictEqual(gate('model', { role: 'admin', modelId: null }), false);
  assert.strictEqual(gate('model', { role: 'model', modelId: 7 }), true);
});
```

- [ ] **Step 2: Run test → PASS** (documents the policy). `cd server && node --test route-gating.test.js`.

- [ ] **Step 3: Swap admin prefixes to `requireAdmin`**

In `server/index.js:100-115`, change these prefixes from `requireAuth` to `requireAdmin`: `/scrape`, `/content`, `/content-types`, `/creators`, `/engagement`, `/export`, `/tracked`, `/suggested`, `/delete-log`, `/scheduler`, `/models`, `/ideas`, `/admin`, `/radar`. Leave `/thumb` and `/thumbnails` on `requireAuth` (models need images). Add `app.use('/me', requireModel);` (routes added in Tasks 5–7).

- [ ] **Step 4: Manual verify** a model session is 403 on `/content` and 200 on `/thumb`. Start server with `AUTH_PASSWORD` set, create a model login (Task 8 or a direct DB insert), log in as the model, `curl` `/content` → 403, `/me/feed` → 200. Document in report. (If Task 8's admin UI isn't built yet, insert a model row with a bcrypt hash via a one-off `node -e`.)

- [ ] **Step 5: Commit**

```bash
git add server/index.js server/route-gating.test.js
git commit -m "feat(auth): requireAdmin on admin routes, /me behind requireModel"
```

---

### Task 5: `GET /me/feed` — niche-scoped feed

**Files:**
- Create: `server/me-feed.js` (pure query builder) + `server/me-feed.test.js`
- Modify: `server/index.js` (add `GET /me/feed`)

**Interfaces:**
- Produces: `buildMeFeedQuery(niches, { page=1, limit=24 })` → `{ sql, params }` selecting non-duplicate (`duplicate_of IS NULL` if the column exists — it does not yet in Plan 2, so guard: only add that clause when a `hasDuplicateOf` flag is passed; default false), non-soft-deleted posts where `COALESCE(posts.content_type, ct.content_type) = ANY(niches)`, newest first, paginated. Mirrors the niche match in `ai-agent.js:117-120` and the `LEFT JOIN creator_types ct` at `index.js:188`.

- [ ] **Step 1: Write the failing test**

```js
// server/me-feed.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildMeFeedQuery } = require('./me-feed');

test('empty niches → sql null (nothing to show)', () => {
  assert.deepStrictEqual(buildMeFeedQuery([], {}), { sql: null, params: [] });
});
test('scopes by niche via COALESCE(content_type, ct.content_type) and paginates', () => {
  const { sql, params } = buildMeFeedQuery(['talking', 'dance'], { page: 2, limit: 10 });
  assert.match(sql, /COALESCE\(posts\.content_type, ct\.content_type\)/);
  assert.match(sql, /LEFT JOIN creator_types ct/);
  assert.match(sql, /ORDER BY/i);
  // page 2, limit 10 → OFFSET 10
  assert.ok(params.includes(10));
});
```

- [ ] **Step 2: Run → FAIL** (`Cannot find module './me-feed'`).

- [ ] **Step 3: Implement `server/me-feed.js`**

```js
function buildMeFeedQuery(niches, { page = 1, limit = 24 } = {}) {
  const list = (Array.isArray(niches) ? niches : []).filter(Boolean);
  if (list.length === 0) return { sql: null, params: [] };
  const offset = (Math.max(1, Number(page)) - 1) * limit;
  // $1 = niches array (pg ANY); $2 = limit; $3 = offset
  const sql = `
    SELECT posts.*, COALESCE(posts.content_type, ct.content_type) AS niche
    FROM posts
    LEFT JOIN creator_types ct ON posts.account_handle = ct.account_handle
    WHERE (posts.soft_deleted = 0 OR posts.soft_deleted IS NULL)
      AND COALESCE(posts.content_type, ct.content_type) = ANY($1)
    ORDER BY posts.posted_at DESC NULLS LAST
    LIMIT $2 OFFSET $3`;
  return { sql, params: [list, limit, offset] };
}
module.exports = { buildMeFeedQuery };
```

- [ ] **Step 4: Run → PASS.** Then add the route to `server/index.js`:

```js
const { buildMeFeedQuery } = require('./me-feed');
app.get('/me/feed', asyncHandler(async (req, res) => {
  const modelId = req.session.user.modelId; // requireModel guarantees this
  const m = await pool.query('SELECT primary_niche, secondary_niches FROM models WHERE id = $1', [modelId]);
  if (m.rows.length === 0) return res.status(404).json({ error: 'Model not found' });
  const niches = [m.rows[0].primary_niche, ...String(m.rows[0].secondary_niches || '').split(',')]
    .map(s => (s || '').trim()).filter(Boolean);
  const { sql, params } = buildMeFeedQuery(niches, { page: Number(req.query.page) || 1, limit: 24 });
  if (!sql) return res.json({ posts: [], niches });
  const r = await pool.query(sql, params);
  res.json({ posts: r.rows, niches });
}));
```

- [ ] **Step 5: Manual verify** as a logged-in model: `curl` `/me/feed` returns only posts whose type ∈ the model's niches. Document.

- [ ] **Step 6: Commit**

```bash
git add server/me-feed.js server/me-feed.test.js server/index.js
git commit -m "feat(me): GET /me/feed — niche-scoped, session-derived modelId"
```

---

### Task 6: `model_saved_posts` + `/me/saves` (session-scoped)

**Files:**
- Modify: `server/index.js` (add `POST /me/saves/:postId`, `DELETE /me/saves/:postId`, `GET /me/saves`)
- Test: `server/me-saves.test.js` (guard logic)

**Interfaces:**
- Produces: saves keyed by `(session modelId, postId)`. `GET /me/saves` returns the model's saved posts joined to `posts`. The `:postId` is the SAVED item, but the OWNER is always `req.session.user.modelId` — never a client value.

- [ ] **Step 1: Write the failing test (the save-target builder is pure)**

```js
// server/me-saves.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { saveParams } = require('./me-saves');
test('saveParams uses the session modelId, coerces postId to int', () => {
  assert.deepStrictEqual(saveParams(7, '42'), { modelId: 7, postId: 42 });
});
test('saveParams rejects a non-numeric postId', () => {
  assert.strictEqual(saveParams(7, 'abc'), null);
});
```

- [ ] **Step 2: Run → FAIL.** Implement `server/me-saves.js`:

```js
function saveParams(modelId, postId) {
  const pid = Number(postId);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { modelId: Number(modelId), postId: pid };
}
module.exports = { saveParams };
```

- [ ] **Step 3: Run → PASS.** Add routes to `server/index.js`:

```js
const { saveParams } = require('./me-saves');
app.post('/me/saves/:postId', asyncHandler(async (req, res) => {
  const p = saveParams(req.session.user.modelId, req.params.postId);
  if (!p) return res.status(400).json({ error: 'Invalid post id' });
  await pool.query(
    'INSERT INTO model_saved_posts (model_id, post_id, saved_at) VALUES ($1,$2,$3) ON CONFLICT (model_id, post_id) DO NOTHING',
    [p.modelId, p.postId, new Date().toISOString()]);
  res.json({ ok: true });
}));
app.delete('/me/saves/:postId', asyncHandler(async (req, res) => {
  const p = saveParams(req.session.user.modelId, req.params.postId);
  if (!p) return res.status(400).json({ error: 'Invalid post id' });
  await pool.query('DELETE FROM model_saved_posts WHERE model_id = $1 AND post_id = $2', [p.modelId, p.postId]);
  res.json({ ok: true });
}));
app.get('/me/saves', asyncHandler(async (req, res) => {
  const r = await pool.query(
    `SELECT posts.* FROM model_saved_posts s JOIN posts ON posts.id = s.post_id
     WHERE s.model_id = $1 ORDER BY s.saved_at DESC`, [req.session.user.modelId]);
  res.json({ posts: r.rows });
}));
```

- [ ] **Step 4: Manual verify isolation** — as model A save post X; as model B, `GET /me/saves` does NOT include X. Document (the key security check).

- [ ] **Step 5: Commit**

```bash
git add server/me-saves.js server/me-saves.test.js server/index.js
git commit -m "feat(me): per-model saves, owner always from session"
```

---

### Task 7: `GET /me/ideas` — self-scoped idea cards

**Files:**
- Modify: `server/index.js` (add `GET /me/ideas`)

**Interfaces:**
- Produces: `GET /me/ideas` → the session model's `idea_cards` (reuses the existing query shape from `index.js:648`, but scoped to `req.session.user.modelId`, NOT a route param).

- [ ] **Step 1: Add the route**

```js
app.get('/me/ideas', asyncHandler(async (req, res) => {
  const r = await pool.query(
    'SELECT * FROM idea_cards WHERE model_id = $1 ORDER BY created_at DESC LIMIT 50',
    [req.session.user.modelId]);
  res.json({ ideas: r.rows });
}));
```

- [ ] **Step 2: Manual verify** a model sees only their own ideas; changing no param can reveal another model's. Document.

- [ ] **Step 3: Commit**

```bash
git add server/index.js
git commit -m "feat(me): GET /me/ideas self-scoped to session model"
```

---

### Task 8: Admin — provision model logins

**Files:**
- Modify: `server/index.js` (extend `POST /models` and `PUT /models/:id` at `index.js:611-628` to accept `email`, `password`, `login_enabled`; hash the password)
- Test: `server/model-credentials.test.js` (the credential-merge builder)

**Interfaces:**
- Consumes: `hashPassword` from Task 2.
- Produces: creating/updating a model can set `email`, `login_enabled`, and (when a non-empty `password` is provided) `password_hash = hashPassword(password)`. An empty/omitted `password` on update leaves the existing hash untouched. Never returns `password_hash` to the client.

- [ ] **Step 1: Write the failing test**

```js
// server/model-credentials.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildCredentialFields } = require('./model-credentials');
test('password provided → includes a bcrypt hash, never plaintext', () => {
  const f = buildCredentialFields({ email: 'a@b.com', password: 'pw', login_enabled: 1 });
  assert.strictEqual(f.email, 'a@b.com');
  assert.strictEqual(f.login_enabled, 1);
  assert.ok(f.password_hash && f.password_hash !== 'pw' && f.password_hash.startsWith('$2'));
});
test('no password → no password_hash key (leave existing untouched)', () => {
  const f = buildCredentialFields({ email: 'a@b.com' });
  assert.ok(!('password_hash' in f));
});
```

- [ ] **Step 2: Run → FAIL.** Implement `server/model-credentials.js`:

```js
const { hashPassword } = require('./auth');
function buildCredentialFields(body = {}) {
  const f = {};
  if (body.email !== undefined) f.email = body.email ? String(body.email).trim() : null;
  if (body.login_enabled !== undefined) f.login_enabled = body.login_enabled ? 1 : 0;
  if (body.role !== undefined) f.role = body.role === 'admin' ? 'admin' : 'model';
  if (body.password) f.password_hash = hashPassword(body.password);
  return f;
}
module.exports = { buildCredentialFields };
```

- [ ] **Step 3: Run → PASS.** Wire into `POST /models` and `PUT /models/:id`: after building the base insert/update, merge `buildCredentialFields(req.body)` into the columns set (dynamic SET clause). Ensure the SELECT that returns the model to the client excludes `password_hash` (select explicit columns, not `*`, or delete the key before `res.json`).

- [ ] **Step 4: Manual verify** — create a model with email+password via `POST /models`, then log in as that model (`/login` with the email+password) → `role:"model"`; confirm `password_hash` never appears in any `/models` response. Document.

- [ ] **Step 5: Commit**

```bash
git add server/model-credentials.js server/model-credentials.test.js server/index.js
git commit -m "feat(auth): admin can provision model email/password/login_enabled"
```

---

### Task 9: API client — auth + `/me` + admin credentials

**Files:**
- Modify: `client/src/api.js`

**Interfaces:**
- Produces: `login(email, password)` (email optional → admin), `getMyFeed(page)`, `getMySaves`, `saveMyPost(id)`, `unsaveMyPost(id)`, `getMyIdeas`. Extend the admin `createModel`/`updateModel` to already pass through the new fields (they post `data`, so no change needed beyond the form). `authCheck` returns `{ role, modelId, ... }` (already via `/auth/check`).

- [ ] **Step 1: Add client functions**

```js
export const login = (email, password) => api.post('/login', email ? { email, password } : { password });
export const getMyFeed = (page = 1) => api.get('/me/feed', { params: { page } });
export const getMySaves = () => api.get('/me/saves');
export const saveMyPost = (id) => api.post(`/me/saves/${id}`);
export const unsaveMyPost = (id) => api.delete(`/me/saves/${id}`);
export const getMyIdeas = () => api.get('/me/ideas');
```

- [ ] **Step 2: Build check** `cd client && npm run build` → compiles.
- [ ] **Step 3: Commit** `git commit -am "feat(me): api client for login/me endpoints"`

---

### Task 10: Role branching + email/password login

**Files:**
- Modify: `client/src/App.js` (branch on role), `client/src/components/LoginPage.js` (email + password)

**Interfaces:**
- Consumes: `/auth/check` role; `login(email,password)`.
- Produces: after auth, `App` renders the existing admin app when `role==='admin'`, and the new `ModelApp` (Task 11) when `role==='model'`. `LoginPage` gains an optional email field (empty email = admin/team login, preserving today's flow).

- [ ] **Step 1: `LoginPage` — add an email field**, keep password. Submit `login(email || undefined, password)`. Keep the existing styling; add a small "Model? enter your email" affordance (email input above password; leaving it blank logs in as admin/team).

- [ ] **Step 2: `App.js` — capture role.** In `checkAuth`, store `role`/`modelId` from `/auth/check` into state. When `authState==='app'`: if `role==='model'` render `<ModelApp onLogout={handleLogout} />`; else render the existing admin header + tabs unchanged. `LoginPage.onLogin` should re-run `checkAuth` (so role is loaded) rather than blindly setting `'app'`.

- [ ] **Step 3: Build check** → compiles.
- [ ] **Step 4: Manual** — admin login (blank email) → admin tool; model login → model app shell. Document.
- [ ] **Step 5: Commit** `git commit -am "feat(model-app): role-based surface + email/password login"`

---

### Task 11: Model mobile app (Feed / Saved / Ideas)

**Files:**
- Create: `client/src/ModelApp.js`, `client/src/pages/model/FeedPage.js`, `client/src/pages/model/SavedPage.js`, `client/src/pages/model/IdeasPage.js`
- Modify: `client/src/components/ContentCard.js` (add an optional `onToggleSave`/`isSaved` heart button, defaulting off so Library/Radar are unaffected)

**Interfaces:**
- Consumes: `getMyFeed`, `getMySaves`, `saveMyPost`, `unsaveMyPost`, `getMyIdeas`; the Plan 1 autoplay props.
- Produces: a mobile-first shell with a bottom nav (Feed / Saved / Ideas). Feed renders `ContentCard` with `autoplayInView` (touch) + a save heart. Saved lists saved posts. Ideas lists `idea_cards`.

- [ ] **Step 1: `ModelApp.js`** — a `useState` tab (`feed|saved|ideas`), a top bar with the logo + logout, a fixed bottom nav (3 buttons), and the active page. Mobile-first (full-width, large tap targets).
- [ ] **Step 2: `FeedPage.js`** — fetch `getMyFeed(page)`; render the grid of `ContentCard` with `autoplayInView` (reuse Plan 1's `LibraryTab` observer pattern — extract the observer into a small `useActiveInView` hook if cleaner, else copy the coordinator) + `onToggleSave`/`isSaved` (from a saved-id set fetched via `getMySaves`).
- [ ] **Step 3: `SavedPage.js`** — `getMySaves` → grid of `ContentCard` (autoplay + unsave).
- [ ] **Step 4: `IdeasPage.js`** — `getMyIdeas` → list of idea cards (concept, format, hook, why_working).
- [ ] **Step 5: `ContentCard` heart** — add `onToggleSave`/`isSaved` props (default undefined/false); render a heart button only when `onToggleSave` is provided (so admin Library/Radar are unchanged).
- [ ] **Step 6: Build check** → compiles.
- [ ] **Step 7: Manual (mobile device-mode)** — model app: Feed autoplays + niche-scoped; save a reel → appears in Saved; Ideas shows their cards; bottom nav works; nothing shows admin tabs. Document.
- [ ] **Step 8: Commit** `git commit -am "feat(model-app): Feed/Saved/Ideas mobile surface"`

---

### Task 12: Admin — manage model logins in `ModelsTab`

**Files:**
- Modify: `client/src/pages/ModelsTab.js`

**Interfaces:**
- Consumes: existing `createModel`/`updateModel` (now pass `email`, `password`, `login_enabled`).
- Produces: the model create/edit form gains `email`, a `password` field (set/reset; blank = leave unchanged), and a `login_enabled` toggle. A small "login: enabled/disabled" indicator per model.

- [ ] **Step 1: Extend the model form** with `email` (text), `password` (password; placeholder "set / reset — blank keeps current"), and a `login_enabled` checkbox. Include them in the create/update payload.
- [ ] **Step 2: Row indicator** — show whether each model has login enabled + its email.
- [ ] **Step 3: Build check** → compiles.
- [ ] **Step 4: Manual** — admin creates a model with email+password+enabled; logs out; logs in as that model → lands in the model app. Document.
- [ ] **Step 5: Commit** `git commit -am "feat(model-app): admin provisions model logins in ModelsTab"`

---

## Self-Review

**Spec coverage (Epic A):** A1 auth/identity/roles → Tasks 1–4, 8, 10. A2 `/me/*` (feed, saves, ideas) → Tasks 5–7 (+ 9 client). A3 model mobile app → Tasks 10–11 (+ 12 admin provisioning). `/me/audio/trending` is intentionally deferred to **Plan 3** (trending audio) — not in this plan.

**Placeholder scan:** none — every step carries real code or a concrete, observable manual check.

**Type consistency:** `req.session.user = {id, role, modelId}` used identically across Tasks 3–7; `resolveLogin` returns that exact shape (Task 2) and `/login` stores it (Task 3); `/auth/check` surfaces `role`/`modelId` (Task 3) which `App.js` branches on (Task 10); `buildCredentialFields` keys (`email`, `password_hash`, `role`, `login_enabled`) match the Task 1 columns.

**Security self-check:** every `/me/*` handler reads `req.session.user.modelId` and never a param; `requireModel` guarantees a modelId exists; admin routes are `requireAdmin`; passwords are bcrypt-only and `password_hash` is never returned; login is throttled; the prod fail-fast and API-key bypass are preserved.

## Execution Handoff

Plan 2 saved. Per the chosen approach, it goes to **`/codex-review`** (adversarial cross-model review of the auth/schema/isolation design) BEFORE execution; after Codex converges, execute subagent-driven like Plan 1. Plan 3 (re-resolve, dedup, trending audio incl. `/me/audio/trending`) is written last.
