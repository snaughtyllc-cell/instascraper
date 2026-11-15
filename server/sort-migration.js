const AI_COLUMNS = [
  { name: 'ai_type', type: 'TEXT' },
  { name: 'ai_confidence', type: 'REAL' },
  { name: 'ai_description', type: 'TEXT' },
  { name: 'ai_transcript', type: 'TEXT' },
  { name: 'ai_suggested_type', type: 'TEXT' },
  { name: 'ai_model', type: 'TEXT' },
  { name: 'ai_classified_at', type: 'TEXT' },
  { name: 'ai_last_attempt_at', type: 'TEXT' },
  { name: 'ai_attempts', type: 'INTEGER DEFAULT 0' },
  { name: 'ai_error', type: 'TEXT' },
  { name: 'ai_cost_usd', type: 'REAL' },
];

const SORT_COLUMNS = [{ name: 'sort_status', type: "TEXT DEFAULT 'unsorted'" }, ...AI_COLUMNS];

async function ensureSortStatus(db, { isPg }) {
  const result = await db.query(isPg
    ? "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'posts'"
    : 'PRAGMA table_info(posts)');
  const existing = new Set(result.rows.map((row) => row.name));
  let added = false;
  for (const column of SORT_COLUMNS) {
    if (existing.has(column.name)) continue;
    await db.query(`ALTER TABLE posts ADD COLUMN ${isPg ? 'IF NOT EXISTS ' : ''}${column.name} ${column.type}`);
    added = true;
  }
  return { added };
}

module.exports = { ensureSortStatus, AI_COLUMNS, SORT_COLUMNS };
