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
  - `requireAdmin` on every existing admin route; models reach ONLY `/me/*`, `/auth/check`, `/login`, `/logout`, and the SHARED media routes `/thumb`, `/thumbnails`, `/video` (reels are public content — see the SOFT-isolation decision below). Private per-model data (`/me/saves`, `/me/ideas`) is always session-keyed and isolated.
  - Preserve the existing `checkProdSecrets` boot fail-fast and the `x-api-key` admin bypass (`API_KEY`).
  - Login attempts are throttled (per-identifier lockout) to blunt brute force.
- **Back-compat:** the current admin login (team `AUTH_PASSWORD`, no email) must keep working; existing behavior when `AUTH_PASSWORD` is unset (auth disabled → treat as admin) must be preserved.
- **Commits:** one per task, frequent.
- **This plan will be reviewed by `/codex-review` before execution.** Base branch: `model-accounts` off `main` (the deploy branch), which now contains **Plan 1** (auth + editable content types) AND **Plan 3** (video cache).

> **↳ RETARGETED to `main` (2026-07-07).** The plan was drafted against a pre-Plan-3 codebase; a reality-check updated its references. Key drift folded in below:
> - **`db.js` has TWO parallel migration arrays now** (Plan 3 refactor): the exported module-level `SQLITE_MIGRATIONS` (`db.js:8-24`, exported at line 373) AND a separate inline Postgres `migrations` array inside `initDB` (`db.js:339-355`). New `models` columns must be added to BOTH, kept in sync. (Task 1.)
> - **Schema tests are non-vacuous now:** import the real exported `SQLITE_MIGRATIONS` and run it against `:memory:`, mirroring `server/video-schema.test.js` — do NOT hand-write the DDL in the test. (Task 1.)
> - **Plan 3 added `app.use('/video', requireAuth)` (`index.js:110`).** It must stay on `requireAuth` (models need to watch their niche reels), NOT become `requireAdmin`. `GET /video/:id` (`index.js:958`) has no per-owner check — see the accepted-risk note in Task 4.
> - Current line refs (verified): auth block `index.js:75-100`; requireAuth prefixes `index.js:102-118`; `models` CREATE `db.js:259-272` (no auth columns yet); `GET/POST /models` `index.js:659/664-672`, `PUT /models/:id` `674-681` (fully positional — no dynamic SET exists yet); `GET /models` does `SELECT *` (line 659); `/ideas/:modelId` `index.js:699-705`; niche match `ai-agent.js:117,120` (posts aliased `p`) + `/content` route `index.js:182,192` (unaliased `posts.`); session middleware `index.js:61-70`; admin hash `bcrypt.hashSync(AUTH_PASSWORD,10)` `index.js:31`. `bcryptjs` + `express-session` already installed and wired.

---

### Task 1: Schema — model login columns + `model_saved_posts`

**Files:**
- Modify: `server/db.js` — add the four `models` ALTERs to BOTH migration arrays (exported `SQLITE_MIGRATIONS` at `db.js:8-24` AND the inline Postgres `migrations` array inside `initDB` at `db.js:339-355`); add the `model_saved_posts` CREATE TABLE right after the `models` table (`db.js:259-272`).
- Test: `server/model-schema.test.js`

**Interfaces:**
- Produces: `models` gains `email TEXT`, `password_hash TEXT`, `role TEXT DEFAULT 'model'`, `login_enabled INTEGER DEFAULT 0`. New table `model_saved_posts (model_id INTEGER, post_id INTEGER, saved_at TEXT, PRIMARY KEY(model_id, post_id))`. Exports `db.SQLITE_MIGRATIONS` already exist (Plan 3); this task extends it.

> **[RETARGET — dual arrays]** Plan 3 split the migrations into two hand-synced lists. The four `models` columns go in BOTH:
> - the exported `SQLITE_MIGRATIONS` array (`db.js:8-24`) as bare `ALTER TABLE models ADD COLUMN …` (SQLite has no `IF NOT EXISTS` on ADD COLUMN; the apply loop swallows "duplicate column").
> - the inline Postgres `migrations` array (`db.js:339-355`) as `ALTER TABLE models ADD COLUMN IF NOT EXISTS …`.
> `model_saved_posts` is a `CREATE TABLE`, so it lives directly in `initDB` (after the `models` CREATE, ~`db.js:272`), NOT in either array.

- [ ] **Step 1: Write the failing test — against the REAL exported migration array** (mirrors `server/video-schema.test.js`; a self-DDL test would be vacuous and is forbidden by the Global Constraints):

```js
// server/model-schema.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { SQLITE_MIGRATIONS } = require('./db');

test('SQLITE_MIGRATIONS adds the four model login columns to models', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE models (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, primary_niche TEXT)`);
  for (const sql of SQLITE_MIGRATIONS) {
    // Tolerate other-table statements (no such table) and re-runs (duplicate column).
    try { db.exec(sql); } catch (e) { if (!/duplicate column|no such table/i.test(e.message)) throw e; }
  }
  const cols = db.prepare(`PRAGMA table_info(models)`).all().map(c => c.name);
  for (const c of ['email', 'password_hash', 'role', 'login_enabled']) {
    assert.ok(cols.includes(c), `models.${c} missing from the real migration array`);
  }
});

test('model_saved_posts DDL (copied verbatim from db.js) has the expected shape', () => {
  // model_saved_posts is a CREATE TABLE in initDB, not in SQLITE_MIGRATIONS, so it can't be
  // exercised via the array. Copy the CREATE verbatim from db.js to keep this self-consistent.
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS model_saved_posts (
    model_id INTEGER NOT NULL, post_id INTEGER NOT NULL, saved_at TEXT, PRIMARY KEY (model_id, post_id))`);
  const saved = db.prepare(`PRAGMA table_info(model_saved_posts)`).all().map(c => c.name).sort();
  assert.deepStrictEqual(saved, ['model_id', 'post_id', 'saved_at'].sort());
});
```

> The first test is non-vacuous (fails if `db.js`'s array isn't updated). The second only checks the CREATE's shape against a copy — a weaker guarantee for that one table (flagged, acceptable per the same tradeoff `video-schema.test.js` documents).

- [ ] **Step 2: Run → the first test FAILS** (`cd server && node --test model-schema.test.js`) — `models.email missing…`, because the columns aren't in `SQLITE_MIGRATIONS` yet. This failure proves the test is non-vacuous.

- [ ] **Step 3: Add the migrations to `db.js`** — append to the exported `SQLITE_MIGRATIONS` (`db.js:8-24`):

```js
`ALTER TABLE models ADD COLUMN email TEXT`,
`ALTER TABLE models ADD COLUMN password_hash TEXT`,
`ALTER TABLE models ADD COLUMN role TEXT DEFAULT 'model'`,
`ALTER TABLE models ADD COLUMN login_enabled INTEGER DEFAULT 0`,
```

and to the inline Postgres `migrations` array (`db.js:339-355`):

```js
`ALTER TABLE models ADD COLUMN IF NOT EXISTS email TEXT`,
`ALTER TABLE models ADD COLUMN IF NOT EXISTS password_hash TEXT`,
`ALTER TABLE models ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'model'`,
`ALTER TABLE models ADD COLUMN IF NOT EXISTS login_enabled INTEGER DEFAULT 0`,
```

and add the `model_saved_posts` CREATE directly in `initDB` after the `models` CREATE (~`db.js:272`) — this table has no dependency on the new columns:

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

> **[R2-#1 — index ORDER matters].** The unique-email index references `models.email`, which is added by the migration LOOPS (which run AFTER all `CREATE TABLE`s, ~`db.js:356-363`). Creating the index up here would fail ("no such column: email") and be silently skipped → uniqueness NOT enforced. So put the index creation **AFTER both migration loops** (right before or after the `seedContentTypes` call, ~`db.js:365`):

```js
  // [R1-#6] AFTER the migration loops (email now exists). Case-insensitive unique for
  // non-empty emails; partial + expression index works on Postgres AND SQLite.
  try {
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS models_email_lower_uk
      ON models (LOWER(email)) WHERE email IS NOT NULL AND email <> ''`);
  } catch (e) {
    // A failure here means real DUPLICATE emails exist (not just "already created") — this
    // must not pass silently, or logins become ambiguous. Surface it loudly. [R2-#1]
    console.error('[db] FATAL: models_email_lower_uk could not be created (duplicate emails?):', e.message);
    throw e;
  }
```

(On a fresh `email` column there are no duplicates, so this won't trip on first migration; the `throw` guards against a future duplicate slipping in.)

- [ ] **Step 4: Run → PASS**, then boot check: `cd server && node -e "delete process.env.DATABASE_URL; require('./db').initDB().then(()=>console.log('ok')).catch(e=>{console.error(e);process.exit(1)})"` → prints `ok`.

- [ ] **Step 5: Commit**

```bash
git add server/db.js server/model-schema.test.js
git commit -m "feat(auth): model login columns (both migration arrays) + model_saved_posts"
```

---

### Task 2: `server/auth.js` helper (hashing, login resolution, throttle)

**Files:**
- Create: `server/auth.js`
- Test: `server/auth.test.js`

**Interfaces:**
- Produces:
  - `hashPassword(plain): string` and `verifyPassword(plain, hash): boolean` (bcrypt cost 10).
  - `resolveLogin({ email, password }, ctx): { ok, user } | { ok:false, error }` — pure resolution given `ctx = { adminPasswordHash, models: [{id,email,password_hash,role,login_enabled,status}] }`. Rules: if no `email` → admin path (verify `password` against `adminPasswordHash`, yield `{id:0, role:'admin', modelId:null}`); if `email` → find a model with that email AND `login_enabled` AND **`status === 'active'`** [R1-#5] AND matching `password_hash`, yield `{id: m.id, role: 'model', modelId: m.id}` (**always `'model'` — never trust a `role` column for privilege escalation** [R1-#7]); else `{ok:false, error:'Invalid credentials'}`.
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

test('resolveLogin: model email+password requires login_enabled AND status=active', () => {
  const models = [{ id: 7, email: 'mia@x.com', password_hash: hashPassword('pw'), role: 'model', login_enabled: 1, status: 'active' }];
  const ok = resolveLogin({ email: 'mia@x.com', password: 'pw' }, { adminPasswordHash: null, models });
  assert.deepStrictEqual(ok, { ok: true, user: { id: 7, role: 'model', modelId: 7 } });
  const disabled = resolveLogin({ email: 'mia@x.com', password: 'pw' }, { adminPasswordHash: null, models: [{ ...models[0], login_enabled: 0 }] });
  assert.strictEqual(disabled.ok, false);
  const inactive = resolveLogin({ email: 'mia@x.com', password: 'pw' }, { adminPasswordHash: null, models: [{ ...models[0], status: 'inactive' }] });
  assert.strictEqual(inactive.ok, false, 'deleted/deactivated model cannot log in [R1-#5]');
  const wrong = resolveLogin({ email: 'mia@x.com', password: 'bad' }, { adminPasswordHash: null, models });
  assert.strictEqual(wrong.ok, false);
});
test('resolveLogin: a stored role=admin on a model row does NOT grant admin [R1-#7]', () => {
  const models = [{ id: 9, email: 'x@x.com', password_hash: hashPassword('pw'), role: 'admin', login_enabled: 1, status: 'active' }];
  const r = resolveLogin({ email: 'x@x.com', password: 'pw' }, { adminPasswordHash: null, models });
  assert.deepStrictEqual(r, { ok: true, user: { id: 9, role: 'model', modelId: 9 } });
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
  // [R1-#5] active + enabled required; [R1-#7] role is ALWAYS 'model' here, never from the row
  if (m && m.login_enabled && m.status === 'active' && verifyPassword(password, m.password_hash)) {
    return { ok: true, user: { id: m.id, role: 'model', modelId: m.id } };
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

Run: `cd server && node --test auth.test.js` → PASS (all tests, incl. the active/enabled + role-escalation cases).

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
- Produces: `req.session.user = { id, role, modelId }`; `/auth/check` → `{ authenticated, authRequired, role, modelId }`; middlewares `requireAuth` (any valid user or API key), `requireAdmin` (role==='admin' or API key), `requireModel` (**async** — role==='model' with a modelId AND a per-request DB re-check that the model is still `status='active'` + `login_enabled`, [R1-#5]).

- [ ] **Step 1: Rewrite `/login`, `/auth/check`, `/logout`, and add middleware**

Replace the block at `server/index.js:75-100` (`/auth/check` → `requireAuth`; `req.session.authenticated` is currently a plain boolean) with:

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
    const r = await pool.query('SELECT id, email, password_hash, role, login_enabled, status FROM models WHERE LOWER(email) = LOWER($1)', [email]);
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
async function requireModel(req, res, next) {
  const u = req.session && req.session.user;
  if (!u || u.role !== 'model' || !u.modelId) {
    // In no-auth dev mode there is no model context; 403 is correct.
    return res.status(403).json({ error: 'Model account required' });
  }
  // [R1-#5] Re-verify the model is still active + login-enabled on EVERY request, so an
  // admin disabling/deleting a model revokes access promptly despite the 7-day session
  // cookie. One indexed PK lookup per /me/* request.
  try {
    const r = await pool.query('SELECT status, login_enabled FROM models WHERE id = $1', [u.modelId]);
    const m = r.rows[0];
    if (!m || m.status !== 'active' || !m.login_enabled) {
      return req.session.destroy(() => res.status(403).json({ error: 'Account disabled' }));
    }
  } catch (e) { return res.status(503).json({ error: 'auth check failed' }); }
  next();
}
```

> Note: `passwordHash` (admin team hash), `API_KEY`, and `pool` already exist above this block.

- [ ] **Step 2: Verify the server boots and admin login still works (back-compat)**

Run: `cd server && AUTH_PASSWORD=teampw SESSION_SECRET=dev node index.js &` then **save the login cookie** [R1-#11]: `curl -s -c /tmp/j -XPOST localhost:4000/login -H 'Content-Type: application/json' -d '{"password":"teampw"}'` → `{"success":true,"role":"admin"}`; then `curl -s -b /tmp/j localhost:4000/auth/check` shows `"role":"admin"`. (Kill the server after.) Document the exact commands/outputs in the report.

- [ ] **Step 3: Commit**

```bash
git add server/index.js
git commit -m "feat(auth): session user + role login, throttle, requireAdmin/requireModel"
```

---

### Task 4: Gate admin routes with `requireAdmin`

**Files:**
- Modify: `server/index.js` (the `app.use('<prefix>', requireAuth)` block at `index.js:102-118`)
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

In `server/index.js:102-118`, change these prefixes from `requireAuth` to `requireAdmin`: `/scrape`, `/content`, `/content-types`, `/creators`, `/engagement`, `/export`, `/tracked`, `/suggested`, `/delete-log`, `/scheduler`, `/models`, `/ideas`, `/admin`, `/radar`. **Leave `/thumb`, `/thumbnails`, AND `/video` (`index.js:110`, added by Plan 3) on `requireAuth`** — models need thumbnails AND videos for their niche feed. Add `app.use('/me', requireModel);` (routes added in Tasks 5–7).

> **[ISOLATION DECISION — SOFT, chosen by the human 2026-07-07]** Media routes (`/video`, `/thumb`, `/thumbnails`) stay on `requireAuth` and are SHARED across all authenticated users (admin + models) — reels are public Instagram content, and the models are the operator's own trusted team. No per-request niche gating on media, no active-model media middleware (Codex R2-#4/#5/#6 are moot under SOFT). **Isolation is enforced only where it matters: private per-model data** — `/me/saves` and `/me/ideas` are strictly session-keyed (a model can only ever read/write their OWN saves/ideas). The **feed** is niche-scoped purely as a relevance filter (a "talking" model sees talking reels), NOT as a security boundary. If requirements later change to adversarial/multi-tenant models, revisit hard isolation (scope `/video` + `/thumb` + tokenize `/thumbnails` + active-model media middleware).

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
- Produces (in `server/me-feed.js`):
  - `nicheVisibilityClause(niches, startIdx)` → `{ clause, params }` — the niche-scoping SQL fragment for the FEED ONLY (under SOFT isolation it is not used by `/me/saves` or `/video`). `clause` = `COALESCE(posts.content_type, ct.content_type) IN ($k,$k+1,...) AND (posts.soft_deleted = 0 OR posts.soft_deleted IS NULL) AND (posts.archived = 0 OR posts.archived IS NULL)`, with one `$` placeholder per niche starting at `startIdx`; `params` = the niche list. Returns `{ clause: null, params: [] }` for empty niches.
  - `buildMeFeedQuery(niches, { page=1, limit=24 })` → `{ sql, params }` selecting visible posts (via `nicheVisibilityClause`), newest first, paginated.
- Mirrors the niche match in `ai-agent.js:117,120` (`_queryTopContent`, aliases posts as `p`) and the `/content` route at `index.js:182,192` (unaliased `posts.content_type` + `LEFT JOIN creator_types ct ON posts.account_handle = ct.account_handle` — the style `me-feed.js` mirrors). `posts.archived` exists (`db.js:130`); `duplicate_of` does NOT exist on `main` — do NOT reference it.

> **[R1-#3 CRITICAL — no `= ANY($1)`].** The SQLite dev adapter (`db.js:49`) only rewrites `$n`→`?` and does NOT support Postgres `= ANY(array)` binding — the plan's original `= ANY($1)` would throw in dev/tests. Use `IN ($k, $k+1, ...)` with ONE `$` placeholder per niche (works on both Postgres and SQLite). The test MUST execute against a real in-memory `better-sqlite3` (via the `db.query`→sqlite adapter), not just regex-match the SQL string.
> **[R1-#4].** Every model-visible query filters `archived` AND `soft_deleted` (idea selection already hides archived at `ai-agent.js:120`).

- [ ] **Step 1: Write the failing test — with a REAL sqlite execution (not just regex) [R1-#3]**

```js
// server/me-feed.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { buildMeFeedQuery, nicheVisibilityClause, parseNiches } = require('./me-feed');

test('empty niches → sql null (nothing to show)', () => {
  assert.deepStrictEqual(buildMeFeedQuery([], {}), { sql: null, params: [] });
});
test('nicheVisibilityClause uses IN() placeholders (not ANY) + archived + soft_deleted', () => {
  const { clause, params } = nicheVisibilityClause(['talking', 'dance'], 5);
  assert.match(clause, /COALESCE\(posts\.content_type, ct\.content_type\) IN \(\$5, \$6\)/);
  assert.match(clause, /archived/);
  assert.match(clause, /soft_deleted/);
  assert.doesNotMatch(clause, /ANY/);
  assert.deepStrictEqual(params, ['talking', 'dance']);
});
test('buildMeFeedQuery actually EXECUTES against sqlite and scopes by niche + archived', () => {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE posts (id INTEGER PRIMARY KEY, content_type TEXT, account_handle TEXT, posted_at TEXT, soft_deleted INTEGER DEFAULT 0, archived INTEGER DEFAULT 0)`);
  sqlite.exec(`CREATE TABLE creator_types (account_handle TEXT, content_type TEXT)`);
  sqlite.prepare(`INSERT INTO posts (id, content_type, posted_at, archived) VALUES (1,'talking','2026-07-01',0),(2,'dance','2026-07-02',0),(3,'skit','2026-07-03',0),(4,'talking','2026-07-04',1)`).run();
  const { sql, params } = buildMeFeedQuery(['talking', 'dance'], { page: 1, limit: 24 });
  const rows = sqlite.prepare(sql.replace(/\$\d+/g, '?')).all(...params);
  const ids = rows.map(r => r.id).sort();
  assert.deepStrictEqual(ids, [1, 2], 'only non-archived talking/dance posts; skit + archived excluded');
});
```

- [ ] **Step 2: Run → FAIL** (`Cannot find module './me-feed'`).

- [ ] **Step 3: Implement `server/me-feed.js`**

```js
// [R2-#2] parseNiches lives HERE (Task 5) — the /me/feed route uses it immediately, and
// /me/saves (Task 6) reuses it. One definition, one import site.
function parseNiches(modelRow = {}) {
  return [modelRow.primary_niche, ...String(modelRow.secondary_niches || '').split(',')]
    .map(s => (s || '').trim()).filter(Boolean);
}

function nicheVisibilityClause(niches, startIdx = 1) {
  const list = (Array.isArray(niches) ? niches : []).filter(Boolean);
  if (list.length === 0) return { clause: null, params: [] };
  const ph = list.map((_, i) => `$${startIdx + i}`).join(', ');
  const clause =
    `COALESCE(posts.content_type, ct.content_type) IN (${ph})` +
    ` AND (posts.soft_deleted = 0 OR posts.soft_deleted IS NULL)` +
    ` AND (posts.archived = 0 OR posts.archived IS NULL)`;
  return { clause, params: list };
}

function buildMeFeedQuery(niches, { page = 1, limit = 24 } = {}) {
  const { clause, params } = nicheVisibilityClause(niches, 1);
  if (!clause) return { sql: null, params: [] };
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
module.exports = { buildMeFeedQuery, nicheVisibilityClause, parseNiches };
```

> `ORDER BY posts.posted_at DESC` (no `NULLS LAST` — SQLite doesn't support that syntax; Postgres defaults NULLs first on DESC, acceptable here since scraped reels always have `posted_at`).
> Add a `parseNiches` unit test: `parseNiches({primary_niche:'talking', secondary_niches:'dance, skit'})` → `['talking','dance','skit']`; `parseNiches({primary_niche:'talking'})` → `['talking']`.
> **[R2-#3] Single import in `index.js`:** all of Task 5/6's me-feed usage goes through ONE top-level `const { buildMeFeedQuery, nicheVisibilityClause, parseNiches } = require('./me-feed');`. Task 6 must NOT re-`require` or re-declare `parseNiches` (duplicate `const` = syntax error) — it reuses the single import.

- [ ] **Step 4: Run → PASS.** Then add the route to `server/index.js`:

```js
// [R2-#3] THE single top-level me-feed import — Task 6 reuses these, never re-requires.
const { buildMeFeedQuery, nicheVisibilityClause, parseNiches } = require('./me-feed');
app.get('/me/feed', asyncHandler(async (req, res) => {
  const modelId = req.session.user.modelId; // requireModel guarantees this
  const m = await pool.query('SELECT primary_niche, secondary_niches FROM models WHERE id = $1', [modelId]);
  if (m.rows.length === 0) return res.status(404).json({ error: 'Model not found' });
  const niches = parseNiches(m.rows[0]);
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
- Produces: saves keyed by `(session modelId, postId)`. The OWNER is always `req.session.user.modelId` — never a client value. `GET /me/saves` returns the model's own saved posts joined to `posts` (soft-deleted filtered out for quality). **[SOFT isolation]** no niche/visibility guard on the save — reels are shared public content; the only isolation guarantee is that a model reads/writes ONLY their OWN saves (session-keyed). `saveParams` still int4-bounds the id.
- New in `server/me-saves.js`: `saveParams(modelId, postId)` (pure id coercion). No dependency on `me-feed.js`.

- [ ] **Step 1: Write the failing test (pure id coercion)**

```js
// server/me-saves.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { saveParams } = require('./me-saves');
test('saveParams uses the session modelId, coerces postId to int', () => {
  assert.deepStrictEqual(saveParams(7, '42'), { modelId: 7, postId: 42 });
});
test('saveParams rejects a non-numeric or out-of-int4 postId', () => {
  assert.strictEqual(saveParams(7, 'abc'), null);
  assert.strictEqual(saveParams(7, '3000000000'), null); // > int4 max
});
```

- [ ] **Step 2: Run → FAIL.** Implement `server/me-saves.js`:

```js
function saveParams(modelId, postId) {
  const pid = Number(postId);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) return null;
  return { modelId: Number(modelId), postId: pid };
}
module.exports = { saveParams };
```

- [ ] **Step 3: Run → PASS.** Add routes to `server/index.js` — session-keyed only (SOFT isolation; the owner is ALWAYS the session modelId, never a client value):

```js
const { saveParams } = require('./me-saves');
// NOTE: buildMeFeedQuery/nicheVisibilityClause/parseNiches were already imported once at
// the top of Task 5 — do NOT re-require me-feed here [R2-#3].

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
    `SELECT posts.* FROM model_saved_posts s
       JOIN posts ON posts.id = s.post_id
     WHERE s.model_id = $1 AND (posts.soft_deleted = 0 OR posts.soft_deleted IS NULL)
     ORDER BY s.saved_at DESC`, [req.session.user.modelId]);
  res.json({ posts: r.rows });
}));
```

- [ ] **Step 4: Manual verify per-model isolation** — model A saves post X; log in as model B, `GET /me/saves` does NOT include X (the key isolation check — a model reads only their OWN saves). Document.

- [ ] **Step 5: Commit**

```bash
git add server/me-saves.js server/me-saves.test.js server/index.js
git commit -m "feat(me): per-model saves (session-keyed owner, soft isolation)"
```

---

### Task 7: `GET /me/ideas` — self-scoped idea cards

**Files:**
- Modify: `server/index.js` (add `GET /me/ideas`)

**Interfaces:**
- Produces: `GET /me/ideas` → the session model's `idea_cards` (reuses the exact query shape from the existing `GET /ideas/:modelId` at `index.js:699-705`, but scoped to `req.session.user.modelId`, NOT a route param). `idea_cards.model_id` exists (`db.js:278`).

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
- Modify: `server/index.js` — extend `POST /models` (`index.js:664-672`) and `PUT /models/:id` (`index.js:674-681`) to accept `email`, `password`, `login_enabled`; hash the password. AND change `GET /models` (`index.js:659`) off `SELECT *`.
- Test: `server/model-credentials.test.js` (the credential-merge builder)

> **[RETARGET — two required edits the plan didn't anticipate]**
> 1. **`GET /models` does `SELECT * FROM models` (`index.js:659`).** Once `password_hash` exists, `SELECT *` would leak every model's hash to the admin client. Change it to an explicit column list that EXCLUDES `password_hash` (include `email`, `role`, `login_enabled` so the admin UI can show login status). This is REQUIRED, not optional.
> 2. **`POST`/`PUT /models` are fully positional today** (fixed `$1..$6`/`$7`, no dynamic SET builder exists anywhere). Merging `buildCredentialFields` means INTRODUCING dynamic column building here for the first time — build the column/placeholder/params lists from a base object spread with `buildCredentialFields(req.body)`. Don't assume a reusable dynamic-SET helper exists.

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
test('role is NEVER settable from the model form [R1-#7]', () => {
  const f = buildCredentialFields({ email: 'a@b.com', role: 'admin', password: 'pw' });
  assert.ok(!('role' in f), 'role must not appear in the credential fields');
});
```

- [ ] **Step 2: Run → FAIL.** Implement `server/model-credentials.js`:

```js
const { hashPassword } = require('./auth');
// [R1-#8] the ONLY columns model provisioning may write. SQL is built from THIS constant,
// never from Object.keys(req.body). Note: 'role' is deliberately absent [R1-#7].
const MODEL_WRITE_FIELDS = ['email', 'login_enabled', 'password_hash'];
function buildCredentialFields(body = {}) {
  const f = {};
  if (body.email !== undefined) f.email = body.email ? String(body.email).trim().toLowerCase() : null;
  if (body.login_enabled !== undefined) f.login_enabled = body.login_enabled ? 1 : 0;
  if (body.password) f.password_hash = hashPassword(body.password);
  return f; // role is intentionally never included
}
module.exports = { buildCredentialFields, MODEL_WRITE_FIELDS };
```

- [ ] **Step 3: Run → PASS.** Wire into `POST /models` and `PUT /models/:id` — build the dynamic SET/INSERT from the **allowlist**, never from request keys [R1-#8]:
  - Merge the existing base fields (`name`, `primary_niche`, `secondary_niches`, `delivery_*`) with `buildCredentialFields(req.body)`.
  - Build columns/placeholders by iterating a CONSTANT field list (the base fields + `MODEL_WRITE_FIELDS`), taking values from the merged object — NEVER `Object.keys(req.body)`. A rogue key like `role` or `id` in the body is impossible to write because it isn't in the allowlist.
  - **`GET /models` (`index.js:659`) must stop using `SELECT *`** — select an explicit column list that includes `email, role, login_enabled` but EXCLUDES `password_hash` [R1-#9]. Audit every other `SELECT * FROM models` in the codebase (admin export helpers) and narrow them defensively so `password_hash` can never reach a response body.
  - Add a test asserting a malicious body key (e.g. `role`, `password_hash`, `status`, `id`) is ignored by the column builder.

- [ ] **Step 3b: Disable login on model delete [R1-#5].** The current `DELETE /models/:id` (`index.js:683`) only sets `status='inactive'`. Also set `login_enabled = 0` in that UPDATE, so a deleted model both fails `resolveLogin` (status check) AND is rejected by the per-request `requireModel` check — belt and suspenders for prompt revocation.

- [ ] **Step 3c: Handle the unique-email violation gracefully [R1-#6].** `POST`/`PUT /models` with an email already used by another model will hit the `models_email_lower_uk` constraint — catch the DB error and return `409 { error: 'Email already in use' }` rather than a 500.

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

- [ ] **Step 2: `App.js` — capture role.** `App.js` (`checkAuth` at lines 30-41) has NO `role` state today — add it. Store `role`/`modelId` from `/auth/check` into state. When `authState==='app'`: if `role==='model'` render `<ModelApp onLogout={handleLogout} />`; else render the existing admin header + tabs unchanged. **The current `onLogin={() => setAuthState('app')}` (`App.js:57`) is the literal to replace** — change it to re-run `checkAuth()` so `role`/`modelId` load before rendering the surface (otherwise a fresh model login renders the admin app with a null role).

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

**Type consistency:** `req.session.user = {id, role, modelId}` used identically across Tasks 3–7; `resolveLogin` returns that exact shape (Task 2) and `/login` stores it (Task 3); `/auth/check` surfaces `role`/`modelId` (Task 3) which `App.js` branches on (Task 10); `buildCredentialFields` keys (`email`, `password_hash`, `login_enabled` — NOT `role`, which is never settable [R1-#7]) match the Task 1 columns.

**Security self-check:** every `/me/*` handler reads `req.session.user.modelId` and never a param; `requireModel` guarantees a modelId AND re-checks active+enabled per request; admin routes are `requireAdmin`; passwords are bcrypt-only and `password_hash` is never returned (`GET /models` narrowed off `SELECT *`); login is throttled and requires active+enabled; the prod fail-fast and API-key bypass are preserved.

**ISOLATION MODEL = SOFT (human decision, 2026-07-07):** media routes (`/video`/`/thumb`/`/thumbnails`) are shared across all authenticated users; isolation is enforced only on private per-model data (`/me/saves`, `/me/ideas`, strictly session-keyed) and the feed is niche-scoped as a relevance filter. R1-#1 (`/video` niche-scope) and R1-#2 (`/me/saves` visibility guard) were implemented then REVERTED per this decision — the secure hard-boundary versions live in the review log if requirements ever change.

**Round-1 findings — disposition (kept under SOFT):** R1-#3 (dialect-safe `IN()` not `= ANY()` + real sqlite execution test — Task 5, still used by the niche-scoped feed), R1-#4 (`archived` filter in `nicheVisibilityClause` — Task 5 feed), R1-#5 (login requires active+enabled; `requireModel` re-checks per request; delete disables login — Tasks 2/3/8), R1-#6 (unique email index + 409 — Tasks 1/8), R1-#7 (`role` never settable; `resolveLogin` always yields `'model'` — Tasks 2/8), R1-#8 (`MODEL_WRITE_FIELDS` allowlist SET — Task 8), R1-#9 (`GET /models` off `SELECT *` — Task 8), R1-#11 (curl cookie fix — Task 3). R1-#10 accepted as documented tradeoff. `models.role` column stays but is reserved/unused for auth.

**Round-2 findings — disposition:** R2-#1 (unique-email index moved AFTER the migration loops so `email` exists; `throw` on real duplicate rather than silent skip — Task 1), R2-#2 (`parseNiches` defined/exported/tested in Task 5, not Task 6), R2-#3 (single consolidated `require('./me-feed')`; Task 6 does not re-declare — Tasks 5/6). R2-#4/#5/#6 (media-route revocation gaps + thumbnail leak + route-policy inconsistency) are **moot under SOFT** — media is intentionally shared; the Global Constraints route allowlist now lists `/video` as a shared media route.

## Execution Handoff

Plan 2 saved. Per the chosen approach, it goes to **`/codex-review`** (adversarial cross-model review of the auth/schema/isolation design) BEFORE execution; after Codex converges, execute subagent-driven like Plan 1. Plan 3 (re-resolve, dedup, trending audio incl. `/me/audio/trending`) is written last.
