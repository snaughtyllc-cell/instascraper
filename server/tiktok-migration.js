// NULL remains the legacy Instagram platform on both database backends.
async function ensureTikTokPlatform(db, { isPg }) {
  let added = false;
  for (const table of ['posts', 'tracked_accounts']) {
    const result = await db.query(isPg
      ? `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${table}'`
      : `PRAGMA table_info(${table})`);
    if (result.rows.some(row => row.name === 'platform')) continue;
    await db.query(`ALTER TABLE ${table} ADD COLUMN ${isPg ? 'IF NOT EXISTS ' : ''}platform TEXT`);
    added = true;
  }
  return { added };
}

module.exports = { ensureTikTokPlatform };
