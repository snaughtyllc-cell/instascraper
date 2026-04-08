require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const pool = require('./db');
const InstagramScraper = require('./scraper');
const { startScheduler, getSchedulerStatus, runAutoScrape, runEngagementRollup, runAutoCleanup, runDiscovery } = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 4000;
const THUMB_DIR = path.join(__dirname, 'thumbnails');
const IS_PROD = process.env.NODE_ENV === 'production';

if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR);

const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
let passwordHash = null;
if (AUTH_PASSWORD) {
  passwordHash = bcrypt.hashSync(AUTH_PASSWORD, 10);
}

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'instascraper-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: IS_PROD && process.env.FORCE_HTTPS === 'true',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

app.get('/auth/check', (req, res) => {
  if (!passwordHash) return res.json({ authenticated: true, authRequired: false });
  res.json({ authenticated: !!req.session.authenticated, authRequired: true });
});

app.post('/login', (req, res) => {
  const { password } = req.body;
  if (!passwordHash) return res.json({ success: true });
  if (bcrypt.compareSync(password || '', passwordHash)) {
    req.session.authenticated = true;
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Wrong password' });
});

app.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

function requireAuth(req, res, next) {
  if (!passwordHash) return next();
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

app.use('/scrape', requireAuth);
app.use('/content', requireAuth);
app.use('/creators', requireAuth);
app.use('/engagement', requireAuth);
app.use('/export', requireAuth);
app.use('/thumb', requireAuth);
app.use('/thumbnails', requireAuth);
app.use('/tracked', requireAuth);
app.use('/suggested', requireAuth);
app.use('/delete-log', requireAuth);
app.use('/scheduler', requireAuth);

const scraper = new InstagramScraper(process.env.APIFY_API_KEY || '');
startScheduler(scraper);

// ─── Scrape Routes ──────────────────────────────────────────────

app.post('/scrape', async (req, res) => {
  const { query, queryType, minLikes, minViews, startDate, endDate } = req.body;
  if (!query || !queryType) return res.status(400).json({ error: 'query and queryType are required' });
  if (!process.env.APIFY_API_KEY) return res.status(400).json({ error: 'APIFY_API_KEY not configured' });
  try {
    const result = await scraper.startScrapeJob({
      query, queryType,
      minLikes: minLikes ? Number(minLikes) : null,
      minViews: minViews ? Number(minViews) : null,
      startDate: startDate || null,
      endDate: endDate || null,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/scrape/jobs', async (req, res) => {
  const jobs = await scraper.getAllJobs();
  res.json(jobs);
});

app.get('/scrape/jobs/:id', async (req, res) => {
  const job = await scraper.getJobStatus(Number(req.params.id));
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ─── Content Routes ─────────────────────────────────────────────

app.get('/content', async (req, res) => {
  const { page = 1, limit = 24, sort = 'newest', tag, account, minViews, startDate, endDate, search, showArchived, contentType } = req.query;
  let where = [];
  let params = [];
  let paramIdx = 1;

  where.push(`(soft_deleted = 0 OR soft_deleted IS NULL)`);
  if (showArchived !== 'true') where.push(`(archived = 0 OR archived IS NULL)`);
  if (contentType) { where.push(`COALESCE(posts.content_type, ct.content_type) = $${paramIdx++}`); params.push(contentType); }
  if (tag) { where.push(`tag = $${paramIdx++}`); params.push(tag); }
  if (account) { where.push(`posts.account_handle = $${paramIdx++}`); params.push(account); }
  if (minViews) { where.push(`view_count >= $${paramIdx++}`); params.push(Number(minViews)); }
  if (startDate) { where.push(`posted_at >= $${paramIdx++}`); params.push(startDate); }
  if (endDate) { where.push(`posted_at <= $${paramIdx++}`); params.push(endDate); }
  if (search) { where.push(`caption ILIKE $${paramIdx++}`); params.push(`%${search}%`); }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const joinClause = 'LEFT JOIN creator_types ct ON posts.account_handle = ct.account_handle';
  const sortMap = { newest: 'posted_at DESC', oldest: 'posted_at ASC', most_viewed: 'view_count DESC', most_liked: 'like_count DESC', highest_er: 'er_percent DESC', lowest_er: 'er_percent ASC' };
  const orderBy = sortMap[sort] || 'posted_at DESC';
  const offset = (Number(page) - 1) * Number(limit);

  const countResult = await pool.query(`SELECT COUNT(*) as count FROM posts ${joinClause} ${whereClause}`, params);
  const total = parseInt(countResult.rows[0].count);
  const postsResult = await pool.query(`SELECT posts.* FROM posts ${joinClause} ${whereClause} ORDER BY ${orderBy} LIMIT $${paramIdx++} OFFSET $${paramIdx++}`, [...params, Number(limit), offset]);
  const accountsResult = await pool.query(`SELECT DISTINCT account_handle FROM posts WHERE account_handle != ''`);

  res.json({
    posts: postsResult.rows, total, page: Number(page),
    totalPages: Math.ceil(total / Number(limit)),
    accounts: accountsResult.rows.map(r => r.account_handle),
  });
});

app.post('/content/:id/tag', async (req, res) => {
  const { tag } = req.body;
  const validTags = ['recreate', 'reference', 'skip', null];
  if (!validTags.includes(tag)) return res.status(400).json({ error: 'Invalid tag' });
  const result = await pool.query('UPDATE posts SET tag = $1 WHERE id = $2', [tag, Number(req.params.id)]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Post not found' });
  res.json({ success: true });
});

app.post('/content/:id/notes', async (req, res) => {
  const { notes } = req.body;
  const result = await pool.query('UPDATE posts SET notes = $1 WHERE id = $2', [notes || '', Number(req.params.id)]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Post not found' });
  res.json({ success: true });
});

app.post('/content/:id/content-type', async (req, res) => {
  const { contentType } = req.body;
  const valid = ['talking', 'dance', 'skit', 'snapchat', 'omegle', 'osc', null];
  if (!valid.includes(contentType)) return res.status(400).json({ error: 'Invalid content type' });
  const result = await pool.query('UPDATE posts SET content_type = $1 WHERE id = $2', [contentType, Number(req.params.id)]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Post not found' });
  res.json({ success: true });
});

app.post('/creators/:handle/type', async (req, res) => {
  const { contentType } = req.body;
  const valid = ['talking', 'dance', 'skit', 'snapchat', 'omegle', 'osc', null];
  if (!valid.includes(contentType)) return res.status(400).json({ error: 'Invalid content type' });
  if (contentType) {
    await pool.query('INSERT INTO creator_types (account_handle, content_type) VALUES ($1, $2) ON CONFLICT (account_handle) DO UPDATE SET content_type = $2', [req.params.handle, contentType]);
  } else {
    await pool.query('DELETE FROM creator_types WHERE account_handle = $1', [req.params.handle]);
  }
  res.json({ success: true });
});

app.get('/creators', async (req, res) => {
  const result = await pool.query(`SELECT p.account_handle, ct.content_type, COUNT(*) as post_count FROM posts p LEFT JOIN creator_types ct ON p.account_handle = ct.account_handle WHERE p.account_handle != '' GROUP BY p.account_handle, ct.content_type ORDER BY post_count DESC`);
  res.json(result.rows);
});

app.post('/content/:id/archive', async (req, res) => {
  const { archived } = req.body;
  const result = await pool.query('UPDATE posts SET archived = $1 WHERE id = $2', [archived ? 1 : 0, Number(req.params.id)]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Post not found' });
  res.json({ success: true });
});

// ─── Tracked Accounts Routes ────────────────────────────────────

app.get('/tracked', async (req, res) => {
  const result = await pool.query('SELECT * FROM tracked_accounts ORDER BY added_at DESC');
  res.json(result.rows);
});

app.post('/tracked', async (req, res) => {
  const { username, tags } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  const clean = username.replace('@', '').toLowerCase();
  try {
    await pool.query('INSERT INTO tracked_accounts (username, tags) VALUES ($1, $2)', [clean, tags || '']);
    res.json({ success: true, username: clean });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Already tracked' });
    throw e;
  }
});

app.post('/tracked/:username/scrape', async (req, res) => {
  try {
    const result = await scraper.startScrapeJob({ query: req.params.username, queryType: 'username', minLikes: null, minViews: null, startDate: null, endDate: null, source: 'manual' });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/tracked/:username', async (req, res) => {
  const { status, tags } = req.body;
  const sets = []; const params = []; let idx = 1;
  if (status) { sets.push(`status = $${idx++}`); params.push(status); }
  if (tags !== undefined) { sets.push(`tags = $${idx++}`); params.push(tags); }
  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  sets.push(`updated_at = TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`);
  params.push(req.params.username);
  await pool.query(`UPDATE tracked_accounts SET ${sets.join(', ')} WHERE username = $${idx}`, params);
  res.json({ success: true });
});

app.delete('/tracked/:username', async (req, res) => {
  await pool.query('DELETE FROM tracked_accounts WHERE username = $1', [req.params.username]);
  res.json({ success: true });
});

// ─── Suggested Accounts Routes ──────────────────────────────────

app.get('/suggested', async (req, res) => {
  const { status = 'pending', sort = 'score' } = req.query;
  let where = 'WHERE 1=1';
  const params = [];
  let idx = 1;
  if (status) { where += ` AND status = $${idx++}`; params.push(status); }
  const sortMap = { score: 'suggestion_score DESC', er: 'avg_er DESC', followers: 'followers DESC', newest: 'discovered_at DESC' };
  const orderBy = sortMap[sort] || 'suggestion_score DESC';
  const result = await pool.query(`SELECT * FROM suggested_accounts ${where} ORDER BY ${orderBy}`, params);
  res.json(result.rows);
});

app.post('/suggested/:username/approve', async (req, res) => {
  const username = req.params.username;
  const suggestion = await pool.query('SELECT * FROM suggested_accounts WHERE username = $1', [username]);
  if (suggestion.rows.length === 0) return res.status(404).json({ error: 'Not found' });
  await pool.query("UPDATE suggested_accounts SET status = 'approved', reviewed_at = TO_CHAR(NOW(), 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') WHERE username = $1", [username]);
  const s = suggestion.rows[0];
  try {
    await pool.query('INSERT INTO tracked_accounts (username, tags, followers, bio, avg_er) VALUES ($1, $2, $3, $4, $5)', [username, 'discovered', s.followers || 0, s.bio || '', s.avg_er || 0]);
  } catch (e) { /* already tracked */ }
  res.json({ success: true });
});

app.post('/suggested/:username/dismiss', async (req, res) => {
  await pool.query("UPDATE suggested_accounts SET status = 'dismissed', reviewed_at = TO_CHAR(NOW(), 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') WHERE username = $1", [req.params.username]);
  res.json({ success: true });
});

app.post('/suggested/:username/snooze', async (req, res) => {
  await pool.query("UPDATE suggested_accounts SET snoozed_until = TO_CHAR(NOW() + INTERVAL '7 days', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), reviewed_at = TO_CHAR(NOW(), 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') WHERE username = $1", [req.params.username]);
  res.json({ success: true });
});

// ─── Delete Log Routes ──────────────────────────────────────────

app.get('/delete-log', async (req, res) => {
  const result = await pool.query(`
    SELECT dl.*, p.view_count, p.like_count FROM deletion_log dl
    LEFT JOIN posts p ON dl.post_id = p.id
    ORDER BY dl.deleted_at DESC LIMIT 100
  `);
  const stats = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE deleted_at > TO_CHAR(NOW() - INTERVAL '7 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) as last_7d,
      COUNT(*) FILTER (WHERE deleted_at > TO_CHAR(NOW() - INTERVAL '30 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) as last_30d,
      COUNT(*) FILTER (WHERE restored_at IS NOT NULL) as restored
    FROM deletion_log
  `);
  res.json({ entries: result.rows, stats: stats.rows[0] });
});

app.post('/delete-log/:id/restore', async (req, res) => {
  const logEntry = await pool.query('SELECT * FROM deletion_log WHERE id = $1', [Number(req.params.id)]);
  if (logEntry.rows.length === 0) return res.status(404).json({ error: 'Not found' });
  const entry = logEntry.rows[0];
  await pool.query('UPDATE posts SET soft_deleted = 0, soft_deleted_at = NULL WHERE id = $1', [entry.post_id]);
  await pool.query("UPDATE deletion_log SET restored_at = TO_CHAR(NOW(), 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') WHERE id = $1", [Number(req.params.id)]);
  res.json({ success: true });
});

// ─── Scheduler Routes ───────────────────────────────────────────

app.get('/scheduler/status', (req, res) => {
  res.json(getSchedulerStatus());
});

app.post('/scheduler/run/:job', async (req, res) => {
  const job = req.params.job;
  const jobs = { 'auto-scrape': runAutoScrape, 'rollup': runEngagementRollup, 'cleanup': runAutoCleanup, 'discovery': runDiscovery };
  if (!jobs[job]) return res.status(400).json({ error: `Unknown job: ${job}` });
  jobs[job]();
  res.json({ success: true, message: `Job '${job}' started` });
});

// ─── Engagement Routes ──────────────────────────────────────────

app.get('/engagement/summary/:handle', async (req, res) => {
  const handle = req.params.handle;
  const result = await pool.query(`SELECT shortcode, posted_at, like_count, comment_count, followers_at_scrape, er_percent, er_label FROM posts WHERE account_handle = $1 AND (archived = 0 OR archived IS NULL) AND (soft_deleted = 0 OR soft_deleted IS NULL) ORDER BY posted_at ASC`, [handle]);
  const posts = result.rows;
  if (posts.length === 0) return res.json({ handle, postCount: 0, avgER: 0, erLabel: null, best: null, worst: null, trend: 'Stable' });

  const totalER = posts.reduce((sum, p) => sum + (p.er_percent || 0), 0);
  const avgER = Math.round((totalER / posts.length) * 100) / 100;
  let avgLabel = 'Low';
  if (avgER >= 6) avgLabel = 'Viral';
  else if (avgER >= 3) avgLabel = 'Good';
  else if (avgER >= 1) avgLabel = 'Average';

  const sorted = [...posts].sort((a, b) => (b.er_percent || 0) - (a.er_percent || 0));
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];

  const mid = Math.floor(posts.length / 2);
  const firstHalf = posts.slice(0, mid || 1);
  const secondHalf = posts.slice(mid || 1);
  const firstAvg = firstHalf.reduce((s, p) => s + (p.er_percent || 0), 0) / firstHalf.length;
  const secondAvg = secondHalf.length > 0 ? secondHalf.reduce((s, p) => s + (p.er_percent || 0), 0) / secondHalf.length : firstAvg;
  const diff = secondAvg - firstAvg;
  let trend = 'Stable';
  if (diff > 0.5) trend = 'Up';
  else if (diff < -0.5) trend = 'Down';

  res.json({
    handle, postCount: posts.length, avgER, erLabel: avgLabel,
    best: { shortcode: best.shortcode, er_percent: best.er_percent, er_label: best.er_label, posted_at: best.posted_at },
    worst: { shortcode: worst.shortcode, er_percent: worst.er_percent, er_label: worst.er_label, posted_at: worst.posted_at },
    trend, firstHalfAvg: Math.round(firstAvg * 100) / 100, secondHalfAvg: Math.round(secondAvg * 100) / 100,
  });
});

app.get('/engagement/leaderboard', async (req, res) => {
  const result = await pool.query(`SELECT account_handle, COUNT(*) as post_count, ROUND(AVG(er_percent)::numeric, 2) as avg_er, MAX(er_percent) as best_er, MIN(er_percent) as worst_er, MAX(followers_at_scrape) as followers FROM posts WHERE account_handle != '' AND (archived = 0 OR archived IS NULL) AND (soft_deleted = 0 OR soft_deleted IS NULL) GROUP BY account_handle ORDER BY avg_er DESC`);
  const labeled = result.rows.map(a => {
    let label = 'Low';
    if (a.avg_er >= 6) label = 'Viral';
    else if (a.avg_er >= 3) label = 'Good';
    else if (a.avg_er >= 1) label = 'Average';
    return { ...a, er_label: label };
  });
  res.json(labeled);
});

app.get('/engagement/export/:handle', async (req, res) => {
  const handle = req.params.handle;
  const result = await pool.query(`SELECT shortcode, posted_at, like_count, comment_count, view_count, followers_at_scrape, er_percent, er_label, post_url, caption FROM posts WHERE account_handle = $1 AND (archived = 0 OR archived IS NULL) ORDER BY posted_at DESC`, [handle]);
  const format = req.query.format || 'json';
  if (format === 'csv') {
    const { Parser } = require('json2csv');
    const fields = ['shortcode', 'posted_at', 'like_count', 'comment_count', 'view_count', 'followers_at_scrape', 'er_percent', 'er_label', 'post_url'];
    const parser = new Parser({ fields });
    const csv = parser.parse(result.rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${handle}-engagement.csv`);
    return res.send(csv);
  }
  res.json({ handle, posts: result.rows });
});

// ─── Export Routes ──────────────────────────────────────────────

app.get('/export', async (req, res) => {
  const { format = 'json', tag = 'recreate' } = req.query;
  const result = await pool.query('SELECT * FROM posts WHERE tag = $1', [tag]);
  if (format === 'csv') {
    const { Parser } = require('json2csv');
    const fields = ['id', 'shortcode', 'video_url', 'thumbnail_url', 'caption', 'like_count', 'comment_count', 'view_count', 'posted_at', 'account_handle', 'post_url', 'tag', 'notes'];
    const parser = new Parser({ fields });
    const csv = parser.parse(result.rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=recreate-content.csv');
    return res.send(csv);
  }
  res.setHeader('Content-Disposition', 'attachment; filename=recreate-content.json');
  res.json(result.rows);
});

// ─── Thumbnail Proxy ────────────────────────────────────────────

app.use('/thumbnails', express.static(THUMB_DIR));

app.get('/thumb/:postId', async (req, res) => {
  const result = await pool.query('SELECT thumbnail_url, shortcode FROM posts WHERE id = $1', [Number(req.params.postId)]);
  const post = result.rows[0];
  if (!post || !post.thumbnail_url) return res.status(404).send('No thumbnail');
  const filename = `${post.shortcode}.jpg`;
  const filepath = path.join(THUMB_DIR, filename);
  if (fs.existsSync(filepath)) return res.sendFile(filepath);
  try {
    const response = await fetch(post.thumbnail_url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.buffer();
    fs.writeFileSync(filepath, buffer);
    res.setHeader('Content-Type', 'image/jpeg');
    res.send(buffer);
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch thumbnail: ' + err.message });
  }
});

// ─── Static Files ───────────────────────────────────────────────

const clientBuild = path.join(__dirname, '..', 'client', 'build');
if (fs.existsSync(clientBuild)) {
  app.use(express.static(clientBuild));
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientBuild, 'index.html'));
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  if (passwordHash) console.log('Auth enabled — password required');
  else console.log('Auth disabled — no AUTH_PASSWORD set');
});
