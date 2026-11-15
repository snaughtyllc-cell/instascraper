async function ensureFilmTables(db, { isPg }) {
  const { rows } = await db.query(isPg
    ? "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'models'"
    : 'PRAGMA table_info(models)');
  if (!rows.some(row => row.name === 'hq_project_id')) {
    await db.query(`ALTER TABLE models ADD COLUMN ${isPg ? 'IF NOT EXISTS ' : ''}hq_project_id TEXT`);
  }
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS models_hq_project_uk
    ON models (hq_project_id) WHERE hq_project_id IS NOT NULL`);
  const now = isPg ? `TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')` : `(datetime('now'))`;
  await db.query(`CREATE TABLE IF NOT EXISTS film_reel_items (
    model_id INTEGER NOT NULL, post_id INTEGER NOT NULL, hq_item_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${now},
    PRIMARY KEY (model_id, post_id)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS film_react_jobs (
    job_id ${isPg ? 'UUID' : 'TEXT'} PRIMARY KEY,
    state TEXT NOT NULL,
    error TEXT,
    payload_json TEXT,
    drive_file_id TEXT,
    created_at TEXT NOT NULL DEFAULT ${now},
    updated_at TEXT NOT NULL DEFAULT ${now}
  )`);
}

module.exports = { ensureFilmTables };
