// server/model-credentials.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { buildCredentialFields, buildModelWriteColumns, buildModelUpdate } = require('./model-credentials');
const { buildModelInsert, MODEL_WRITE_FIELDS, MODEL_NOTION_FIELDS } = require('./model-credentials');

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

// [R1-#8] The dynamic INSERT/UPDATE column builder must ONLY ever emit columns that are
// in the allowlist, and must take values from a hand-built `merged` object — never from
// Object.keys(req.body). This test proves both halves of that defense:
//   1. the real wiring (base fields pulled by name + buildCredentialFields(body) merged in)
//      never lets role/status/id/a client-supplied password_hash reach the column list;
//   2. even if a rogue key somehow ended up ON the merged object directly (a future
//      refactor mistake), buildModelWriteColumns still filters by the allowlist alone —
//      unlisted columns are structurally impossible to write.
test('buildModelWriteColumns: malicious body keys can never become writable columns [R1-#8]', () => {
  const ALLOWLIST = ['name', 'primary_niche', 'secondary_niches', 'delivery_method', 'delivery_contact', 'delivery_day', 'email', 'login_enabled', 'password_hash'];
  const maliciousBody = { name: 'x', primary_niche: 'y', role: 'admin', password_hash: 'client-supplied-hash', status: 'z', id: 99 };

  // (1) Simulates the real index.js wiring: base fields pulled by name, credential
  // fields merged in via buildCredentialFields(req.body) — never a raw spread of req.body.
  const merged = { name: maliciousBody.name, primary_niche: maliciousBody.primary_niche, ...buildCredentialFields(maliciousBody) };
  let built = buildModelWriteColumns(merged, ALLOWLIST);
  assert.deepStrictEqual(built.columns, ['name', 'primary_niche']);
  assert.deepStrictEqual(built.placeholders, ['$1', '$2']);
  assert.deepStrictEqual(built.params, ['x', 'y']);

  // (2) Defense in depth: even if role/status/id/password_hash were directly present on
  // the merged object, the allowlist alone keeps them out of the emitted column list.
  const contaminated = { ...merged, role: 'admin', status: 'inactive', id: 99 };
  built = buildModelWriteColumns(contaminated, ALLOWLIST);
  assert.ok(!built.columns.includes('role'), 'role must never be a writable column');
  assert.ok(!built.columns.includes('status'), 'status must never be a writable column');
  assert.ok(!built.columns.includes('id'), 'id must never be a writable column');
});

// [CRITICAL] The dev/test SQLite adapter converts $n → ? with a naive global regex and NO
// dedup, so placeholders must be numbered sequentially with no gaps and no reuse.
test('buildModelWriteColumns numbers placeholders sequentially with no gaps or reuse', () => {
  const ALLOWLIST = ['name', 'primary_niche', 'secondary_niches', 'delivery_method', 'delivery_contact', 'delivery_day', 'email', 'login_enabled', 'password_hash'];
  const merged = { name: 'x', primary_niche: 'y', email: 'a@b.com', login_enabled: 1 };
  const { columns, placeholders, params } = buildModelWriteColumns(merged, ALLOWLIST);
  assert.deepStrictEqual(columns, ['name', 'primary_niche', 'email', 'login_enabled']);
  assert.deepStrictEqual(placeholders, ['$1', '$2', '$3', '$4']);
  assert.deepStrictEqual(params, ['x', 'y', 'a@b.com', 1]);
});

// [Review fix — Task 8, Important finding] buildModelWriteColumns' sequential-numbering
// test above only covers the pure SET-clause builder. The route (PUT /models/:id) also
// appends an id placeholder and a literal updated_at expression — that FULL assembly was
// only manually verified. This test exercises buildModelUpdate (the extracted full-assembly
// helper) by actually RUNNING the SQL it produces against a real in-memory better-sqlite3
// db, mirroring the me-feed.test.js pattern. A misnumbered/reused $N would throw ("too few
// parameter values to run query" or a silently wrong bind) before the assertions below ever
// run — this is the exact bug class the dev/test SQLite adapter (server/db.js) is exposed
// to, since it does a naive global $n → ? replace with no dedup.
test('buildModelUpdate: PUT SQL assembly actually EXECUTES against sqlite — id placeholder last/highest, updated_at bumped [review fix]', () => {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      primary_niche TEXT,
      secondary_niches TEXT,
      delivery_method TEXT,
      delivery_contact TEXT,
      delivery_day TEXT,
      email TEXT,
      password_hash TEXT,
      role TEXT DEFAULT 'model',
      login_enabled INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      updated_at TEXT
    )
  `);
  const insertInfo = sqlite.prepare(
    `INSERT INTO models (name, primary_niche, email, password_hash, login_enabled) VALUES (?, ?, ?, ?, ?)`
  ).run('Old Name', 'talking', 'old@example.com', 'old-hash', 0);
  const id = insertInfo.lastInsertRowid;

  const ALLOWLIST = ['name', 'primary_niche', 'secondary_niches', 'delivery_method', 'delivery_contact', 'delivery_day', 'email', 'login_enabled', 'password_hash'];
  // Multiple columns, including a credential field (password_hash) — this is what would
  // expose a placeholder-count mismatch in the SET clause + id append.
  const merged = {
    name: 'New Name',
    primary_niche: 'talking',
    secondary_niches: '',
    delivery_method: 'whatsapp',
    delivery_contact: '',
    delivery_day: 'monday',
    email: 'new@example.com',
    login_enabled: 1,
    password_hash: 'new-hash',
  };
  const { sql, params } = buildModelUpdate(merged, ALLOWLIST, id);

  // id must be the LAST/highest placeholder, appended after every SET-clause param — never
  // reused mid-clause — and updated_at must be a literal expression, not a bound param.
  assert.strictEqual(params[params.length - 1], id);
  assert.ok(sql.endsWith(`WHERE id=$${params.length}`));
  assert.match(sql, /updated_at=TO_CHAR\(NOW\(\)/);

  // Mirror exactly what server/db.js's SQLite dev/test adapter does at runtime:
  // TO_CHAR(NOW(), '...') → datetime('now'), then $n → ? (naive global replace, no dedup).
  const sqliteSql = sql
    .replace(/TO_CHAR\(NOW\(\),\s*'[^']*'\)/gi, "datetime('now')")
    .replace(/\$(\d+)/g, '?');

  // A misnumbered/reused $N throws here ("too few/too many parameter values") before any
  // assertion below runs — this execution IS the guard.
  sqlite.prepare(sqliteSql).run(...params);

  const row = sqlite.prepare('SELECT * FROM models WHERE id = ?').get(id);
  assert.strictEqual(row.name, 'New Name');
  assert.strictEqual(row.email, 'new@example.com');
  assert.strictEqual(row.login_enabled, 1);
  assert.strictEqual(row.password_hash, 'new-hash');
  assert.ok(row.updated_at, 'updated_at should be bumped to a non-null value');
});

test('MODEL_NOTION_FIELDS are the four persona-sync columns', () => {
  assert.deepStrictEqual(MODEL_NOTION_FIELDS,
    ['notion_page_id', 'character_context', 'persona_statement', 'comfort_ceiling']);
});

test('buildModelInsert with notion fields: sequential placeholders + real sqlite round-trip', () => {
  const s = new Database(':memory:');
  s.exec(`CREATE TABLE models (id INTEGER PRIMARY KEY, name TEXT, primary_niche TEXT,
    secondary_niches TEXT, email TEXT, login_enabled INTEGER, password_hash TEXT,
    notion_page_id TEXT, character_context TEXT, persona_statement TEXT, comfort_ceiling TEXT)`);
  const merged = {
    name: 'Jayden', primary_niche: 'talking', secondary_niches: 'dance',
    email: 'j@x.com', login_enabled: 1, password_hash: 'h',
    notion_page_id: 'pg1', character_context: 'ctx', persona_statement: 'ps', comfort_ceiling: 'Full nude',
  };
  const fields = ['name', 'primary_niche', 'secondary_niches', ...MODEL_WRITE_FIELDS, ...MODEL_NOTION_FIELDS];
  const { sql, params } = buildModelInsert(merged, fields);
  // placeholders must be $1..$N ascending, no gaps
  const nums = [...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1]));
  assert.deepStrictEqual(nums, params.map((_, i) => i + 1));
  s.prepare(sql.replace(/\$\d+/g, '?')).run(...params);
  const row = s.prepare('SELECT * FROM models WHERE notion_page_id = ?').get('pg1');
  assert.strictEqual(row.name, 'Jayden');
  assert.strictEqual(row.character_context, 'ctx');
  assert.strictEqual(row.comfort_ceiling, 'Full nude');
});
