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

module.exports = { ensureWorkspaceTables, SUGGESTED_REEL_AI_COLUMNS };
