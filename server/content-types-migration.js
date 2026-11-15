async function ensureContentTypeDescriptions(db, { isPg }) {
  const { rows } = await db.query(isPg
    ? "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'content_types'"
    : 'PRAGMA table_info(content_types)');
  if (rows.some(row => row.name === 'description')) return;
  await db.query(`ALTER TABLE content_types ADD COLUMN ${isPg ? 'IF NOT EXISTS ' : ''}description TEXT`);
}

module.exports = { ensureContentTypeDescriptions };
