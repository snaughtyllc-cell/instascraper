const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
      ? { rejectUnauthorized: false }
          : false,
});

async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS posts (
              id SERIAL PRIMARY KEY,
                    shortcode TEXT UNIQUE NOT NULL,
                          video_url TEXT,
                                thumbnail_url TEXT,
                                      caption TEXT,
                                            like_count INTEGER DEFAULT 0,
                                                  comment_count INTEGER DEFAULT 0,
                                                        view_count INTEGER DEFAULT 0,
                                                              posted_at TEXT,
                                                                    account_handle TEXT,
                                                                          post_url TEXT,
                                                                                tag TEXT DEFAULT NULL,
                                                                                      notes TEXT DEFAULT '',
                                                                                            scraped_at TEXT DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                                                                                                  source_query TEXT,
                                                                                                        archived INTEGER DEFAULT 0,
                                                                                                              content_type TEXT DEFAULT NULL,
                                                                                                                    followers_at_scrape INTEGER DEFAULT 0,
                                                                                                                          er_percent REAL DEFAULT 0,
                                                                                                                                er_label TEXT DEFAULT NULL
                                                                                                                                    )
                                                                                                                                      `);

  await pool.query(`
      CREATE TABLE IF NOT EXISTS scrape_jobs (
            id SERIAL PRIMARY KEY,
                  query TEXT NOT NULL,
                        query_type TEXT NOT NULL,
                              status TEXT DEFAULT 'pending',
                                    apify_run_id TEXT,
                                          posts_found INTEGER DEFAULT 0,
                                                progress INTEGER DEFAULT 0,
                                                      status_message TEXT DEFAULT '',
                                                            error TEXT,
                                                                  created_at TEXT DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                                                                        completed_at TEXT
                                                                            )
                                                                              `);

  await pool.query(`
      CREATE TABLE IF NOT EXISTS creator_types (
            account_handle TEXT PRIMARY KEY,
                  content_type TEXT NOT NULL
                      )
                        `);

  console.log('Database initialized');
}

initDB().catch(console.error);

module.exports = pool;
