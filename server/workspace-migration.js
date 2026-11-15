const SUGGESTED_REEL_AI_COLUMNS = [
  { name: 'ai_type', type: 'TEXT' },
  { name: 'ai_confidence', type: 'REAL' },
  { name: 'ai_error', type: 'TEXT' },
  { name: 'ai_classified_at', type: 'TEXT' },
  { name: 'ai_cost_usd', type: 'REAL' },
];

async function ensureWorkspaceTables(db, { isPg }) {
  await db.query(`CREATE TABLE IF NOT EXISTS model_creators (
    model_id INTEGER NOT NULL, username TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'va', added_at TEXT,
    PRIMARY KEY (model_id, username)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS model_creator_proposals (
    model_id INTEGER NOT NULL, username TEXT NOT NULL, share REAL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
    created_at TEXT, decided_at TEXT,
    PRIMARY KEY (model_id, username)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS model_suggestions (
    model_id INTEGER NOT NULL, username TEXT NOT NULL, fit REAL NOT NULL, reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'dismissed')),
    snoozed_until TEXT, reviewed_at TEXT, created_at TEXT,
    PRIMARY KEY (model_id, username)
  )`);
  const { rows } = await db.query(isPg
    ? "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'suggested_reels'"
    : 'PRAGMA table_info(suggested_reels)');
  const existing = new Set(rows.map(row => row.name));
  for (const { name, type } of SUGGESTED_REEL_AI_COLUMNS) {
    if (!existing.has(name)) await db.query(`ALTER TABLE suggested_reels ADD COLUMN ${isPg ? 'IF NOT EXISTS ' : ''}${name} ${type}`);
  }
}

async function ensureLookTables(db, { isPg }) {
  const id = isPg ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  await db.query(`CREATE TABLE IF NOT EXISTS look_tags (
    id ${id}, value TEXT UNIQUE NOT NULL, label TEXT NOT NULL,
    category TEXT NOT NULL, sort_order INTEGER DEFAULT 0, created_at TEXT
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS creator_look_tags (
    username TEXT NOT NULL, tag TEXT NOT NULL, added_at TEXT,
    PRIMARY KEY (username, tag)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS model_taste (
    model_id INTEGER NOT NULL, feature TEXT NOT NULL, affinity REAL NOT NULL,
    positives INTEGER DEFAULT 0, negatives INTEGER DEFAULT 0, updated_at TEXT,
    PRIMARY KEY (model_id, feature)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS look_backfill_attempts (
    id ${id}, post_id INTEGER NOT NULL, attempted_at TEXT NOT NULL,
    cost_usd REAL NOT NULL DEFAULT 0
  )`);
  for (const [table, column] of [['posts', 'ai_look_tags'], ['suggested_reels', 'ai_look_tags'], ['models', 'look_tags']]) {
    const { rows } = await db.query(isPg
      ? `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${table}'`
      : `PRAGMA table_info(${table})`);
    if (!rows.some(row => row.name === column)) {
      await db.query(`ALTER TABLE ${table} ADD COLUMN ${isPg ? 'IF NOT EXISTS ' : ''}${column} TEXT`);
    }
  }
}

module.exports = { ensureWorkspaceTables, ensureLookTables, SUGGESTED_REEL_AI_COLUMNS };
