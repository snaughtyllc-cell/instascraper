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
const { startScheduler, getSchedulerStatus, runAutoScrape, runEngagementRollup, runAutoCleanup, runDiscovery, runIdeaGeneration } = require('./scheduler');

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
app.use('/models', requireAuth);
app.use('/ideas', requireAuth);

const ContentIdeaAgent = require('./ai-agent');
const { deliverBatch } = require('./delivery');

const scraper = new InstagramScraper(process.env.APIFY_API_KEY || '');
const ideaAgent = new ContentIdeaAgent(process.env.ANTHROPIC_API_KEY || '');
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

app.post('/scrape/import-urls', async (req, res) => {
  const { urls } = req.body;
  if (!urls || !Array.isArray(urls) || urls.length === 0) return res.status(400).json({ error: 'urls array required' });
  if (urls.length > 20) return res.status(400).json({ error: 'Max 20 URLs at once' });
  if (!process.env.APIFY_API_KEY) return res.status(400).json({ error: 'APIFY_API_KEY not configured' });
  try {
    const result = await scraper.importByUrls(urls);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  const jobs = { 'auto-scrape': runAutoScrape, 'rollup': runEngagementRollup, 'cleanup': runAutoCleanup, 'discovery': runDiscovery, 'idea-generation': runIdeaGeneration };
  if (!jobs[job]) return res.status(400).json({ error: `Unknown job: ${job}` });
  jobs[job]();
  res.json({ success: true, message: `Job '${job}' started` });
});

// ─── Engagement Routes ──────────────────────────────────────────

// Backfill: set followers for an account and recalc ER for all posts
app.post('/engagement/backfill', async (req, res) => {
  try {
    const { handle, followers } = req.body;
    if (handle && followers) {
      await pool.query('UPDATE posts SET followers_at_scrape = $1 WHERE account_handle = $2', [Number(followers), handle]);
    }
    // Recalc ER for all posts with followers
    const postsResult = await pool.query('SELECT id, like_count, comment_count, followers_at_scrape FROM posts WHERE followers_at_scrape > 0');
    let count = 0;
    for (const post of postsResult.rows) {
      const likes = post.like_count || 0;
      const comments = post.comment_count || 0;
      const f = post.followers_at_scrape;
      if (f <= 0) continue;
      const er = ((likes + comments) / f) * 100;
      const erPercent = Math.round(er * 100) / 100;
      let erLabel = 'Low';
      if (er >= 6) erLabel = 'Viral';
      else if (er >= 3) erLabel = 'Good';
      else if (er >= 1) erLabel = 'Average';
      await pool.query('UPDATE posts SET er_percent = $1, er_label = $2 WHERE id = $3', [erPercent, erLabel, post.id]);
      count++;
    }
    res.json({ success: true, updated: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk set followers for multiple accounts at once
app.post('/engagement/backfill-bulk', async (req, res) => {
  try {
    const { accounts } = req.body; // [{ handle, followers }, ...]
    if (!accounts || !Array.isArray(accounts)) return res.status(400).json({ error: 'accounts array required' });
    for (const { handle, followers } of accounts) {
      if (handle && followers) {
        await pool.query('UPDATE posts SET followers_at_scrape = $1 WHERE account_handle = $2', [Number(followers), handle]);
      }
    }
    // Recalc ER for all posts with followers
    const postsResult = await pool.query('SELECT id, like_count, comment_count, followers_at_scrape FROM posts WHERE followers_at_scrape > 0');
    let count = 0;
    for (const post of postsResult.rows) {
      const f = post.followers_at_scrape;
      if (f <= 0) continue;
      const er = (((post.like_count || 0) + (post.comment_count || 0)) / f) * 100;
      const erPercent = Math.round(er * 100) / 100;
      let erLabel = 'Low';
      if (er >= 6) erLabel = 'Viral';
      else if (er >= 3) erLabel = 'Good';
      else if (er >= 1) erLabel = 'Average';
      await pool.query('UPDATE posts SET er_percent = $1, er_label = $2 WHERE id = $3', [erPercent, erLabel, post.id]);
      count++;
    }
    res.json({ success: true, updated: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/engagement/summary/:handle', async (req, res) => {
  const handle = req.params.handle;
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const result = await pool.query(`SELECT shortcode, posted_at, like_count, comment_count, followers_at_scrape, er_percent, er_label FROM posts WHERE account_handle = $1 AND (archived = 0 OR archived IS NULL) AND (soft_deleted = 0 OR soft_deleted IS NULL) AND posted_at >= $2 ORDER BY posted_at ASC`, [handle, thirtyDaysAgo]);
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
  try {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const result = await pool.query(`SELECT account_handle, COUNT(*) as post_count, ROUND(AVG(er_percent)::numeric, 2) as avg_er, MAX(er_percent) as best_er, MIN(er_percent) as worst_er, MAX(followers_at_scrape) as followers FROM posts WHERE account_handle != '' AND (archived = 0 OR archived IS NULL) AND (soft_deleted = 0 OR soft_deleted IS NULL) AND posted_at >= $1 GROUP BY account_handle ORDER BY avg_er DESC`, [thirtyDaysAgo]);
  const labeled = result.rows.map(a => {
    const avgEr = parseFloat(a.avg_er) || 0;
    let label = 'Low';
    if (avgEr >= 6) label = 'Viral';
    else if (avgEr >= 3) label = 'Good';
    else if (avgEr >= 1) label = 'Average';
    return { ...a, avg_er: avgEr, er_label: label };
  });
  res.json(labeled);
  } catch (err) {
    console.error('Leaderboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
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

// ─── Model Routes ──────────────────────────────────────────────

app.get('/models/niches/available', async (req, res) => {
  const result = await pool.query('SELECT DISTINCT content_type FROM creator_types WHERE content_type IS NOT NULL ORDER BY content_type');
  res.json(result.rows.map(r => r.content_type));
});

app.get('/models', async (req, res) => {
  const result = await pool.query("SELECT * FROM models WHERE status = 'active' ORDER BY created_at DESC");
  res.json(result.rows);
});

app.post('/models', async (req, res) => {
  const { name, primary_niche, secondary_niches, delivery_method, delivery_contact, delivery_day } = req.body;
  if (!name || !primary_niche) return res.status(400).json({ error: 'name and primary_niche required' });
  const result = await pool.query(
    `INSERT INTO models (name, primary_niche, secondary_niches, delivery_method, delivery_contact, delivery_day) VALUES ($1, $2, $3, $4, $5, $6)`,
    [name, primary_niche, secondary_niches || '', delivery_method || 'whatsapp', delivery_contact || '', delivery_day || 'monday']
  );
  res.json({ success: true, id: result.rows[0]?.id });
});

app.put('/models/:id', async (req, res) => {
  const { name, primary_niche, secondary_niches, delivery_method, delivery_contact, delivery_day } = req.body;
  await pool.query(
    `UPDATE models SET name=$1, primary_niche=$2, secondary_niches=$3, delivery_method=$4, delivery_contact=$5, delivery_day=$6, updated_at=TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') WHERE id=$7`,
    [name, primary_niche, secondary_niches || '', delivery_method || 'whatsapp', delivery_contact || '', delivery_day || 'monday', Number(req.params.id)]
  );
  res.json({ success: true });
});

app.delete('/models/:id', async (req, res) => {
  await pool.query("UPDATE models SET status = 'inactive' WHERE id = $1", [Number(req.params.id)]);
  res.json({ success: true });
});

// ─── Idea Generation Routes ────────────────────────────────────

app.post('/ideas/generate/:modelId', async (req, res) => {
  try {
    const result = await ideaAgent.generateIdeasForModel(Number(req.params.modelId));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/ideas/:modelId', async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM idea_cards WHERE model_id = $1 ORDER BY created_at DESC LIMIT 50',
    [Number(req.params.modelId)]
  );
  res.json(result.rows);
});

app.get('/ideas/:modelId/batches', async (req, res) => {
  const result = await pool.query(
    `SELECT batch_id, MIN(created_at) as created_at, COUNT(*) as idea_count, MAX(status) as status
     FROM idea_cards WHERE model_id = $1
     GROUP BY batch_id ORDER BY MIN(created_at) DESC LIMIT 20`,
    [Number(req.params.modelId)]
  );
  res.json(result.rows);
});

app.post('/ideas/deliver/:modelId/:batchId', async (req, res) => {
  try {
    const result = await deliverBatch(Number(req.params.modelId), req.params.batchId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/ideas/delivery-log/:modelId', async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM idea_delivery_log WHERE model_id = $1 ORDER BY sent_at DESC LIMIT 20',
    [Number(req.params.modelId)]
  );
  res.json(result.rows);
});

app.get('/ideas/export/:modelId', async (req, res) => {
  const modelResult = await pool.query('SELECT * FROM models WHERE id = $1', [Number(req.params.modelId)]);
  const model = modelResult.rows[0];
  if (!model) return res.status(404).json({ error: 'Model not found' });
  const result = await pool.query(
    'SELECT * FROM idea_cards WHERE model_id = $1 ORDER BY created_at DESC',
    [Number(req.params.modelId)]
  );
  const format = req.query.format || 'csv';

  if (format === 'pdf') {
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${model.name.toLowerCase()}-ideas.pdf`);
    doc.pipe(res);

    // Title
    doc.fontSize(22).font('Helvetica-Bold').text(`Content Ideas — ${model.name}`, { align: 'center' });
    doc.fontSize(10).font('Helvetica').fillColor('#666666')
      .text(`${model.primary_niche}${model.secondary_niches ? ` + ${model.secondary_niches}` : ''} | Generated ${new Date().toLocaleDateString()}`, { align: 'center' });
    doc.moveDown(1.5);

    const ideas = result.rows.filter(r => !r.stale_warning || r.concept.length > 80);
    ideas.forEach((idea, i) => {
      // Check if we need a new page
      if (doc.y > 650) doc.addPage();

      // Idea number + format badge
      doc.fontSize(14).font('Helvetica-Bold').fillColor('#000000')
        .text(`${i + 1}. ${idea.concept}`);
      doc.moveDown(0.3);

      if (idea.format) {
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#4A90D9').text(`FORMAT: ${idea.format.toUpperCase()}`);
      }
      if (idea.hook_line) {
        doc.fontSize(10).font('Helvetica-Oblique').fillColor('#333333').text(`Hook: "${idea.hook_line}"`);
      }
      if (idea.why_working) {
        doc.fontSize(9).font('Helvetica').fillColor('#555555').text(`Why it works: ${idea.why_working}`);
      }
      if (idea.source_niche) {
        doc.fontSize(9).font('Helvetica').fillColor('#888888').text(`Niche: ${idea.source_niche}`);
      }
      if (idea.source_post_ids) {
        const urls = idea.source_post_ids.split(',').filter(Boolean);
        urls.forEach((url, j) => {
          const cleanUrl = url.trim();
          doc.fontSize(8).font('Helvetica').fillColor('#7B61FF')
            .text(`Reference ${j + 1}: ${cleanUrl}`, { link: cleanUrl.startsWith('http') ? cleanUrl : `https://www.instagram.com/reel/${cleanUrl}/`, underline: true });
        });
      }
      doc.moveDown(1);
      // Divider line
      doc.strokeColor('#E0E0E0').lineWidth(0.5)
        .moveTo(50, doc.y).lineTo(560, doc.y).stroke();
      doc.moveDown(0.8);
    });

    doc.end();
    return;
  }

  if (format === 'csv') {
    const { Parser } = require('json2csv');
    const fields = ['concept', 'format', 'why_working', 'hook_line', 'source_niche', 'source_post_ids', 'status', 'created_at'];
    const parser = new Parser({ fields });
    const csv = parser.parse(result.rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${model.name.toLowerCase()}-ideas.csv`);
    return res.send(csv);
  }
  res.setHeader('Content-Disposition', `attachment; filename=${model.name.toLowerCase()}-ideas.json`);
  res.json(result.rows);
});

// Send ideas to Notion database
app.post('/ideas/export-notion/:modelId', async (req, res) => {
  const { pageId } = req.body;
  const notionKey = process.env.NOTION_API_KEY;
  if (!notionKey) return res.status(400).json({ error: 'NOTION_API_KEY not configured on server' });
  if (!pageId) return res.status(400).json({ error: 'Notion page ID required' });

  const modelResult = await pool.query('SELECT * FROM models WHERE id = $1', [Number(req.params.modelId)]);
  const model = modelResult.rows[0];
  if (!model) return res.status(404).json({ error: 'Model not found' });

  const ideas = await pool.query(
    'SELECT * FROM idea_cards WHERE model_id = $1 ORDER BY created_at DESC LIMIT 20',
    [Number(req.params.modelId)]
  );

  try {
    const children = [
      { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: `Content Ideas — ${model.name} — ${new Date().toLocaleDateString()}` } }] } },
    ];

    for (const idea of ideas.rows) {
      if (idea.stale_warning && idea.concept.length < 80) continue;
      children.push({
        object: 'block', type: 'callout',
        callout: {
          icon: { emoji: '💡' },
          rich_text: [{ text: { content: `${idea.format ? `[${idea.format}] ` : ''}${idea.concept}` } }],
        },
      });
      if (idea.hook_line) {
        children.push({ object: 'block', type: 'quote', quote: { rich_text: [{ text: { content: `Hook: "${idea.hook_line}"` } }] } });
      }
      if (idea.why_working) {
        children.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: idea.why_working } }] } });
      }
      if (idea.source_post_ids) {
        const urls = idea.source_post_ids.split(',').filter(Boolean);
        const linkText = urls.map((u, i) => {
          const url = u.trim().startsWith('http') ? u.trim() : `https://www.instagram.com/reel/${u.trim()}/`;
          return { text: { content: `Reference ${i + 1}`, link: { url } } };
        });
        if (linkText.length > 0) {
          // Add spaces between links
          const richText = [];
          linkText.forEach((lt, i) => {
            if (i > 0) richText.push({ text: { content: '  |  ' } });
            richText.push(lt);
          });
          children.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: richText } });
        }
      }
      children.push({ object: 'block', type: 'divider', divider: {} });
    }

    const notionRes = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${notionKey}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ children }),
    });

    if (!notionRes.ok) {
      const text = await notionRes.text();
      throw new Error(`Notion API error: ${notionRes.status} — ${text}`);
    }
    res.json({ success: true, blocksAdded: children.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
