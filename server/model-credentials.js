const { hashPassword } = require('./auth');

// [R1-#8] The ONLY columns model provisioning may write via credential fields. SQL is
// built from THIS constant, never from Object.keys(req.body). Note: 'role' is
// deliberately absent [R1-#7] — a model can never set its own (or another model's) role.
const MODEL_WRITE_FIELDS = ['email', 'login_enabled', 'password_hash'];

function buildCredentialFields(body = {}) {
  const f = {};
  if (body.email !== undefined) f.email = body.email ? String(body.email).trim().toLowerCase() : null;
  if (body.login_enabled !== undefined) f.login_enabled = body.login_enabled ? 1 : 0;
  if (body.password) f.password_hash = hashPassword(body.password);
  return f; // role is intentionally never included
}

// [R1-#8] Build INSERT/UPDATE columns/placeholders/params from a fixed allowlist
// (`fieldList`), reading values ONLY from `merged` — never from raw request-body keys.
// A field is included only if it is present as an own key on `merged`, so optional
// columns (email/login_enabled/password_hash, or any base field a caller omits) are
// skipped and DB defaults / existing values apply untouched. Placeholders are numbered
// sequentially starting at $1 with NO reuse and NO gaps — required because the SQLite
// dev/test adapter (server/db.js) converts $n → ? with a naive global regex and no
// dedup, so a repeated or out-of-order placeholder number would silently bind the
// wrong parameter.
function buildModelWriteColumns(merged, fieldList) {
  const columns = [];
  const placeholders = [];
  const params = [];
  for (const field of fieldList) {
    if (Object.prototype.hasOwnProperty.call(merged, field)) {
      params.push(merged[field]);
      placeholders.push(`$${params.length}`);
      columns.push(field);
    }
  }
  return { columns, placeholders, params };
}

// [Review fix — Task 8] Build the COMPLETE INSERT SQL for POST /models from
// buildModelWriteColumns, so the full assembly (not just the column builder) is a pure,
// testable function. No functional change vs. the inline version previously in index.js.
function buildModelInsert(merged, fieldList) {
  const { columns, placeholders, params } = buildModelWriteColumns(merged, fieldList);
  const sql = `INSERT INTO models (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`;
  return { sql, params };
}

// [Review fix — Task 8] Build the COMPLETE UPDATE SQL for PUT /models/:id — the SET
// clause from buildModelWriteColumns, PLUS the id placeholder appended as the LAST/highest
// $N (no reuse, no gaps) and the updated_at bump as a literal expression (never a param).
// This is the exact seam a prior review flagged: buildModelWriteColumns was unit-tested for
// sequential numbering, but the route's full assembly (SET clause + id append) was only
// manually verified. Extracting it here makes it independently, automatically testable —
// see the real-sqlite-execution test in model-credentials.test.js.
function buildModelUpdate(merged, fieldList, id) {
  const { columns, placeholders, params } = buildModelWriteColumns(merged, fieldList);
  const setClause = columns.map((col, i) => `${col}=${placeholders[i]}`).join(', ');
  params.push(Number(id));
  const idPlaceholder = `$${params.length}`; // [SQLite-safe] last + highest placeholder, no reuse
  const sql = `UPDATE models SET ${setClause}, updated_at=TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') WHERE id=${idPlaceholder}`;
  return { sql, params };
}

// [R1-#6] Tolerant detection of a models_email_lower_uk unique-constraint violation
// across both database backends: Postgres reports code 23505 with the constraint name
// in the message; the SQLite dev/test adapter reports SQLITE_CONSTRAINT_UNIQUE with the
// index name embedded in the message text instead of a structured code.
function isDuplicateEmailError(err) {
  if (!err) return false;
  if (err.code === '23505') return true;
  const msg = String(err.message || '').toLowerCase();
  if (msg.includes('models_email_lower_uk')) return true;
  return msg.includes('unique') && msg.includes('email');
}

module.exports = { buildCredentialFields, MODEL_WRITE_FIELDS, buildModelWriteColumns, buildModelInsert, buildModelUpdate, isDuplicateEmailError };
