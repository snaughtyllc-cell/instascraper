require('./instrument'); // Sentry — must load before express/http (inert unless SENTRY_DSN set)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Sentry = require('@sentry/node');
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const pool = require('./db');
const InstagramScraper = require('./scraper');
const { BudgetExceededError, usageSummary, suggestionsOrderClause, attachTopReels } = InstagramScraper;
const { startScheduler, getSchedulerStatus, runAutoScrape, runEngagementRollup, runAutoCleanup, runDiscovery, runIdeaGeneration } = require('./scheduler');
const radar = require('./radar');
const notionSync = require('./notion-sync');
const { Client: NotionClient } = require('@notionhq/client');
const Anthropic = require('@anthropic-ai/sdk');
const audio = require('./audio');
const { asyncHandler, dbErrorMiddleware, initWithRetry, wrapAsyncRoutes } = require('./db-health');
const health = require('./health');
const { downloadThumbnail, DEFAULT_THUMB_DIR } = require('./thumbnails');
const { videoFilePath, DEFAULT_VIDEO_DIR } = require('./videos');
const { buildBulkUpdate } = require('./content-bulk');
const { calcViewER, engagementLabel, enrichViewsVsMedian, medianViewsByAccount } = require('./engagement-metrics');
const { validateTypeLabel } = require('./content-types');
const { buildCredentialFields, MODEL_WRITE_FIELDS, buildModelWriteColumns, buildModelInsert, buildModelUpdate, isDuplicateEmailError } = require('./model-credentials');

const app = express();
// Trust the first proxy hop (Railway) so req.ip is the real client IP, not the
// proxy's. The login throttle keys on req.ip; without this, all clients collapse
// to one bucket and the admin-login key degrades to a single global bucket an
// anonymous actor could lock out for 15 min (DoS). Also lets express-session see
// X-Forwarded-Proto for correct secure-cookie handling behind the proxy.
app.set('trust proxy', 1);
wrapAsyncRoutes(app);
const PORT = process.env.PORT || 4000;
const IS_PROD = process.env.NODE_ENV === 'production';

const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
const API_KEY = process.env.INSTASCRAPER_API_KEY || '';
let passwordHash = null;
if (AUTH_PASSWORD) {
  passwordHash = bcrypt.hashSync(AUTH_PASSWORD, 10);
}

const DEV_SESSION_SECRET = 'instascraper-dev-secret-change-me';
const WEAK_PASSWORDS = new Set(['test123', 'password', 'admin', 'changeme', 'instascraper', '123456', 'letmein']);

// Production fail-fast: refuse to boot with a forgeable session secret or with
// auth effectively disabled / trivially guessable. Pure (returns problems) so it
// is unit-testable and importing the app for tests never exits the process.
function checkProdSecrets(env = process.env) {
  if (env.NODE_ENV !== 'production') return [];
  const problems = [];
  const secret = env.SESSION_SECRET || '';
  if (!secret || secret === DEV_SESSION_SECRET) {
    problems.push('SESSION_SECRET is missing or still the dev default — set a long random string.');
  } else if (secret.length < 16) {
    problems.push('SESSION_SECRET is too short (<16 chars) — use a long random string.');
  }
  const pw = env.AUTH_PASSWORD || '';
  if (!pw) {
    problems.push('AUTH_PASSWORD is not set — auth would be disabled in production.');
  } else if (pw.length < 8 || WEAK_PASSWORDS.has(pw.toLowerCase())) {
    problems.push('AUTH_PASSWORD is weak (too short or a common value) — choose a strong team password.');
  }
  return problems;
}

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || DEV_SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: IS_PROD && process.env.FORCE_HTTPS === 'true',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

app.get('/live', health.liveHandler);
app.get('/ready', health.readyHandler());

const { resolveLogin, LoginThrottle } = require('./auth');
const loginThrottle = new LoginThrottle({ max: 5, windowMs: 15 * 60000 });

app.get('/auth/check', (req, res) => {
  if (!passwordHash) return res.json({ authenticated: true, authRequired: false, role: 'admin', modelId: null });
  const u = req.session.user;
  res.json({ authenticated: !!u, authRequired: true, role: u ? u.role : null, modelId: u ? u.modelId : null });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!passwordHash) { // auth disabled (dev) → admin
    req.session.user = { id: 0, role: 'admin', modelId: null };
    return res.json({ success: true, role: 'admin' });
  }
  const key = (email ? String(email).toLowerCase() : 'admin') + '|' + (req.ip || '');
  const gate = loginThrottle.check(key);
  if (gate.blocked) return res.status(429).json({ error: `Too many attempts. Try again in ${gate.retryInSec}s.` });

  let models = [];
  if (email) {
    const r = await pool.query('SELECT id, email, password_hash, role, login_enabled, status FROM models WHERE LOWER(email) = LOWER($1)', [email]);
    models = r.rows;
  }
  const out = resolveLogin({ email, password }, { adminPasswordHash: passwordHash, models });
  if (!out.ok) { loginThrottle.fail(key); return res.status(401).json({ error: 'Invalid credentials' }); }
  loginThrottle.reset(key);
  req.session.user = out.user;
  res.json({ success: true, role: out.user.role });
});

app.post('/logout', (req, res) => { req.session.destroy(() => res.json({ success: true })); });

function requireAuth(req, res, next) {
  if (!passwordHash) return next();
  if (API_KEY && req.headers['x-api-key'] === API_KEY) return next();
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'Not authenticated' });
}
function requireAdmin(req, res, next) {
  if (!passwordHash) return next();
  if (API_KEY && req.headers['x-api-key'] === API_KEY) return next();
  if (req.session && req.session.user && req.session.user.role === 'admin') return next();
  res.status(403).json({ error: 'Admin only' });
}
async function requireModel(req, res, next) {
  const u = req.session && req.session.user;
  if (!u || u.role !== 'model' || !u.modelId) {
    // In no-auth dev mode there is no model context; 403 is correct.
    return res.status(403).json({ error: 'Model account required' });
  }
  // [R1-#5] Re-verify the model is still active + login-enabled on EVERY request, so an
  // admin disabling/deleting a model revokes access promptly despite the 7-day session
  // cookie. One indexed PK lookup per /me/* request.
  try {
    const r = await pool.query('SELECT status, login_enabled FROM models WHERE id = $1', [u.modelId]);
    const m = r.rows[0];
    if (!m || m.status !== 'active' || !m.login_enabled) {
      return req.session.destroy(() => res.status(403).json({ error: 'Account disabled' }));
    }
  } catch (e) { return res.status(503).json({ error: 'auth check failed' }); }
  next();
}

app.use('/scrape', requireAdmin);
app.use('/content', requireAdmin);
app.use('/content-types', requireAdmin);
app.use('/creators', requireAdmin);
app.use('/engagement', requireAdmin);
app.use('/export', requireAdmin);
app.use('/thumb', requireAuth);
app.use('/thumbnails', requireAuth);
app.use('/video', requireAuth);
app.use('/tracked', requireAdmin);
app.use('/suggested', requireAdmin);
app.use('/delete-log', requireAdmin);
app.use('/scheduler', requireAdmin);
app.use('/models', requireAdmin);
app.use('/ideas', requireAdmin);
app.use('/admin', requireAdmin);
app.use('/notion', requireAdmin);
app.use('/radar', requireAdmin);
app.use('/audio', requireAdmin);
app.use('/me', requireModel);

const ContentIdeaAgent = require('./ai-agent');
const { deliverBatch } = require('./delivery');

const scraper = new InstagramScraper(process.env.APIFY_API_KEY || '');
const ideaAgent = new ContentIdeaAgent(process.env.ANTHROPIC_API_KEY || '');

const notionCfg = notionSync.notionConfig(process.env);
const notionClient = notionCfg.enabled ? new NotionClient({ auth: notionCfg.apiKey }) : null;
const notionClaude = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

async function availableNiches() {
  const r = await pool.query('SELECT value FROM content_types ORDER BY sort_order, label');
  const vals = r.rows.map((x) => x.value);
  if (vals.length) return vals;
  const d = await pool.query('SELECT DISTINCT content_type FROM creator_types WHERE content_type IS NOT NULL ORDER BY content_type');
  return d.rows.map((x) => x.content_type);
}
function notionDeps(niches) {
  return { notionClient, claude: notionClaude, pool, scraper, radar, cfg: notionCfg, availableNiches: niches };
}

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
    if (result && result.skipped) return res.json({ skipped: true, message: 'A scrape for this account is already running.' });
    res.json(result);
  } catch (err) {
    if (err instanceof BudgetExceededError) return res.status(429).json({ error: err.message, budget: err.budget });
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
  const { page = 1, limit = 24, sort = 'newest', tag, account, minViews, startDate, endDate, search, showArchived, contentType, untagged } = req.query;
  let where = [];
  let params = [];
  let paramIdx = 1;

  where.push(`(soft_deleted = 0 OR soft_deleted IS NULL)`);
  if (showArchived !== 'true') where.push(`(archived = 0 OR archived IS NULL)`);
  if (contentType) { where.push(`COALESCE(posts.content_type, ct.content_type) = $${paramIdx++}`); params.push(contentType); }
  if (tag) { where.push(`tag = $${paramIdx++}`); params.push(tag); }
  if (untagged === 'true') where.push(`(tag IS NULL OR tag = '')`);
  if (account) { where.push(`posts.account_handle = $${paramIdx++}`); params.push(account); }
  if (minViews) { where.push(`view_count >= $${paramIdx++}`); params.push(Number(minViews)); }
  if (startDate) { where.push(`posted_at >= $${paramIdx++}`); params.push(startDate); }
  if (endDate) { where.push(`posted_at <= $${paramIdx++}`); params.push(endDate); }
  if (search) { where.push(`caption ILIKE $${paramIdx++}`); params.push(`%${search}%`); }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const joinClause = 'LEFT JOIN creator_types ct ON posts.account_handle = ct.account_handle';
  const sortMap = { newest: 'posted_at DESC', oldest: 'posted_at ASC', most_viewed: 'view_count DESC NULLS LAST', most_liked: 'like_count DESC', highest_er: 'er_percent DESC', lowest_er: 'er_percent ASC' };
  const orderBy = sortMap[sort] || 'posted_at DESC';
  const offset = (Number(page) - 1) * Number(limit);

  const countResult = await pool.query(`SELECT COUNT(*) as count FROM posts ${joinClause} ${whereClause}`, params);
  const total = parseInt(countResult.rows[0].count);
  let posts;
  if (sort === 'views_vs_median') {
    const allResult = await pool.query(`SELECT posts.* FROM posts ${joinClause} ${whereClause}`, params);
    const allMedians = await medianViewsByAccount(pool, allResult.rows.map((post) => post.account_handle));
    posts = enrichViewsVsMedian(allResult.rows, allMedians)
      .sort((a, b) => (b.views_vs_median || 0) - (a.views_vs_median || 0))
      .slice(offset, offset + Number(limit));
  } else {
    const postsResult = await pool.query(`SELECT posts.* FROM posts ${joinClause} ${whereClause} ORDER BY ${orderBy} LIMIT $${paramIdx++} OFFSET $${paramIdx++}`, [...params, Number(limit), offset]);
    const medians = await medianViewsByAccount(pool, postsResult.rows.map((post) => post.account_handle));
    posts = enrichViewsVsMedian(postsResult.rows, medians);
  }
  const accountsResult = await pool.query(`SELECT DISTINCT account_handle FROM posts WHERE account_handle != ''`);

  res.json({
    posts, total, page: Number(page),
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
  if (contentType) {
    const ok = await pool.query('SELECT 1 FROM content_types WHERE value = $1', [contentType]);
    if (ok.rowCount === 0) return res.status(400).json({ error: 'Invalid content type' });
  }
  const result = await pool.query('UPDATE posts SET content_type = $1 WHERE id = $2', [contentType, Number(req.params.id)]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Post not found' });
  res.json({ success: true });
});

app.post('/creators/:handle/type', async (req, res) => {
  const { contentType } = req.body;
  if (contentType) {
    const ok = await pool.query('SELECT 1 FROM content_types WHERE value = $1', [contentType]);
    if (ok.rowCount === 0) return res.status(400).json({ error: 'Invalid content type' });
  }
  if (contentType) {
    await pool.query('INSERT INTO creator_types (account_handle, content_type) VALUES ($1, $2) ON CONFLICT (account_handle) DO UPDATE SET content_type = $2', [req.params.handle, contentType]);
  } else {
    await pool.query('DELETE FROM creator_types WHERE account_handle = $1', [req.params.handle]);
  }
  res.json({ success: true });
});

app.get('/content-types', asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT id, value, label, sort_order FROM content_types ORDER BY sort_order, label');
  res.json(result.rows);
}));

app.post('/content-types', asyncHandler(async (req, res) => {
  const v = validateTypeLabel(req.body && req.body.label);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const existing = await pool.query('SELECT id, value, label FROM content_types WHERE value = $1', [v.value]);
  if (existing.rows.length) return res.status(200).json(existing.rows[0]); // idempotent add
  const max = await pool.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM content_types');
  const ins = await pool.query(
    'INSERT INTO content_types (value, label, sort_order, created_at) VALUES ($1,$2,$3,$4) RETURNING id, value, label',
    [v.value, v.label, Number(max.rows[0].next) || 0, new Date().toISOString()]
  );
  res.status(201).json(ins.rows[0]);
}));

app.delete('/content-types/:id', asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM content_types WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

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

app.post('/content/bulk', async (req, res) => {
  const { action, value, ids } = req.body || {};
  const vt = (await pool.query('SELECT value FROM content_types')).rows.map(r => r.value);
  const built = buildBulkUpdate(action, value, ids, vt);
  if (built.error) return res.status(400).json({ error: built.error });
  if (!built.sql) return res.json({ updated: 0 });
  const result = await pool.query(built.sql, built.params);
  console.log(`[Content] bulk action=${action} value=${value} ids=${built.ids.length} updated=${result.rowCount}`);
  res.json({ updated: result.rowCount });
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
    if (result && result.skipped) return res.json({ skipped: true, message: 'A scrape for this account is already running.' });
    res.json(result);
  } catch (err) {
    if (err instanceof BudgetExceededError) return res.status(429).json({ error: err.message, budget: err.budget });
    res.status(500).json({ error: err.message });
  }
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

app.post('/tracked/scrape-bulk', async (req, res) => {
  const usernames = (Array.isArray(req.body?.usernames) ? req.body.usernames : [])
    .filter(u => typeof u === 'string' && u.trim())
    .map(u => u.trim());
  const results = [];
  let stopped = null;
  for (const username of usernames) {
    try {
      const r = await scraper.startScrapeJob({ query: username, queryType: 'username', minLikes: null, minViews: null, startDate: null, endDate: null, source: 'manual' });
      if (!(r && r.skipped)) {
        // un-pause only when a scrape actually started, so the account joins the active rotation
        await pool.query("UPDATE tracked_accounts SET status = 'active' WHERE username = $1", [username]);
      }
      results.push({ username, ...(r && r.skipped ? { skipped: true } : { status: 'running' }) });
    } catch (err) {
      if (err instanceof BudgetExceededError) { stopped = { username, message: err.message }; break; }
      results.push({ username, error: err.message });
    }
  }
  res.json({ started: results.filter(r => r.status === 'running').length, results, stopped });
});

// ─── Suggested Accounts Routes ──────────────────────────────────

app.get('/suggested', async (req, res) => {
  const { status = 'pending', sort = 'score' } = req.query;
  let where = 'WHERE 1=1';
  const params = [];
  let idx = 1;
  if (status) { where += ` AND status = $${idx++}`; params.push(status); }
  const orderBy = suggestionsOrderClause(sort);
  const result = await pool.query(`SELECT * FROM suggested_accounts ${where} ORDER BY ${orderBy}`, params);
  const accounts = result.rows;
  let reels = [];
  if (accounts.length) {
    const names = accounts.map(a => a.username);
    const ph = names.map((_, i) => `$${i + 1}`).join(',');
    reels = (await pool.query(
      `SELECT id, username, shortcode, view_count, like_count, comment_count, video_url, permalink, rank
       FROM suggested_reels WHERE username IN (${ph}) ORDER BY rank`,
      names
    )).rows;
  }
  res.json(attachTopReels(accounts, reels));
});

app.post('/suggested/:username/approve', async (req, res) => {
  const username = req.params.username;
  const suggestion = await pool.query('SELECT * FROM suggested_accounts WHERE username = $1', [username]);
  if (suggestion.rows.length === 0) return res.status(404).json({ error: 'Not found' });
  await pool.query("UPDATE suggested_accounts SET status = 'approved', reviewed_at = TO_CHAR(NOW(), 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') WHERE username = $1", [username]);
  const s = suggestion.rows[0];
  try {
    await pool.query(
      `INSERT INTO tracked_accounts (username, status, tags, followers, bio, avg_er) VALUES ($1, 'paused', $2, $3, $4, $5)`,
      [username.toLowerCase(), 'discovered', s.followers || 0, s.bio || '', s.avg_er || 0]
    );
  } catch (e) { /* already tracked */ }
  res.json({ success: true });
});

app.post('/suggested/approve-bulk', async (req, res) => {
  const usernames = (Array.isArray(req.body?.usernames) ? req.body.usernames : [])
    .filter(u => typeof u === 'string' && u.trim())
    .map(u => u.trim());
  let approved = 0;
  for (const username of usernames) {
    try {
      const suggestion = await pool.query('SELECT * FROM suggested_accounts WHERE username = $1', [username]);
      if (suggestion.rows.length === 0) continue;
      const s = suggestion.rows[0];
      await pool.query("UPDATE suggested_accounts SET status = 'approved', reviewed_at = TO_CHAR(NOW(), 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') WHERE username = $1", [username]);
      try {
        await pool.query(
          `INSERT INTO tracked_accounts (username, status, tags, followers, bio, avg_er) VALUES ($1, 'paused', $2, $3, $4, $5)`,
          [username.toLowerCase(), 'discovered', s.followers || 0, s.bio || '', s.avg_er || 0]
        );
      } catch (e) { /* already tracked */ }
      approved++;
    } catch (e) { console.error(`[Suggested] bulk approve failed for ${username}:`, e.message); }
  }
  res.json({ approved, total: usernames.length, status: 'paused' });
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

// ─── Trending Audio Routes ──────────────────────────────────────
// Admin: roster-wide. Model (/me/audio): scoped to the model's niches.
app.get('/audio/trending', asyncHandler(async (req, res) => {
  const rows = await audio.trendingAudio(pool, { all: true });
  res.json({ audio: rows });
}));
app.get('/audio/:audioId/reels', asyncHandler(async (req, res) => {
  const { sql, params } = audio.buildAudioReelsQuery(String(req.params.audioId), [], { all: true, limit: 24 });
  const r = await pool.query(sql, params);
  res.json({ reels: r.rows });
}));

app.get('/me/audio/trending', asyncHandler(async (req, res) => {
  const m = await pool.query('SELECT primary_niche, secondary_niches FROM models WHERE id = $1', [req.session.user.modelId]);
  if (m.rows.length === 0) return res.status(404).json({ error: 'Model not found' });
  const niches = parseNiches(m.rows[0]);
  const rows = await audio.trendingAudio(pool, { niches });
  res.json({ audio: rows, niches });
}));
app.get('/me/audio/:audioId/reels', asyncHandler(async (req, res) => {
  const m = await pool.query('SELECT primary_niche, secondary_niches FROM models WHERE id = $1', [req.session.user.modelId]);
  const niches = m.rows.length ? parseNiches(m.rows[0]) : [];
  const { sql, params } = audio.buildAudioReelsQuery(String(req.params.audioId), niches, { limit: 24 });
  if (!sql) return res.json({ reels: [] });
  const r = await pool.query(sql, params);
  res.json({ reels: r.rows });
}));

// ─── Notion Onboarding Routes ──────────────────────────────────
app.get('/notion/personas', asyncHandler(async (req, res) => {
  if (!notionClient) return res.json({ enabled: false, personas: [] });
  const personas = await notionSync.fetchApprovedPersonas(notionClient, notionCfg);
  const linked = await pool.query("SELECT notion_page_id FROM models WHERE notion_page_id IS NOT NULL AND notion_page_id <> ''");
  const linkedIds = new Set(linked.rows.map((r) => r.notion_page_id));
  res.json({ enabled: true, personas: personas.map((p) => ({ pageId: p.pageId, name: p.name, status: p.status, linked: linkedIds.has(p.pageId) })) });
}));

app.post('/notion/personas/:pageId/preview', asyncHandler(async (req, res) => {
  if (!notionClient) return res.status(400).json({ error: 'Notion not configured' });
  if (!notionClaude) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not configured' });
  const preview = await notionSync.previewPersona(notionDeps(await availableNiches()), req.params.pageId);
  res.json(preview);
}));

app.post('/notion/personas/:pageId/import', asyncHandler(async (req, res) => {
  if (!notionClient) return res.status(400).json({ error: 'Notion not configured' });
  const { primary_niche, secondary_niches, character_context, email, password, seedKeywords } = req.body || {};
  if (!primary_niche || !email || !password) return res.status(400).json({ error: 'primary_niche, email, password required' });
  try {
    const out = await notionSync.importPersona(notionDeps(await availableNiches()), req.params.pageId, { primary_niche, secondary_niches, character_context, email, password, seedKeywords });
    res.json({ success: true, ...out });
  } catch (err) {
    if (isDuplicateEmailError(err)) return res.status(409).json({ error: 'Email already in use' });
    if (/already|UNIQUE|notion_page/i.test(String(err.message))) return res.status(409).json({ error: 'This persona is already linked to a model' });
    res.status(400).json({ error: err.message });
  }
}));

app.post('/models/:id/resync-notion', asyncHandler(async (req, res) => {
  if (!notionClient) return res.status(400).json({ error: 'Notion not configured' });
  if (!notionClaude) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not configured' });
  const m = await pool.query('SELECT id, name, primary_niche, secondary_niches, character_context, status, notion_page_id FROM models WHERE id = $1', [Number(req.params.id)]);
  const model = m.rows[0];
  if (!model || !model.notion_page_id) return res.status(404).json({ error: 'Model not linked to a Notion persona' });
  if (req.body && req.body.confirm && !req.body.confirmed) return res.status(400).json({ error: 'confirmed proposal required to apply re-sync' });
  const out = await notionSync.resyncModel(notionDeps(await availableNiches()), model, { confirm: Boolean(req.body && req.body.confirm), confirmed: req.body && req.body.confirmed });
  res.json(out);
}));

// ─── Reel Radar Routes ──────────────────────────────────────────
app.get('/radar/terms', async (req, res) => {
  const rows = await pool.query(
    'SELECT id, term, kind, source, status, last_run_at FROM watch_terms ORDER BY status, term'
  );
  res.json({ terms: rows.rows });
});

app.post('/radar/terms', async (req, res) => {
  const { term } = req.body || {};
  if (!term || !String(term).trim()) return res.status(400).json({ ok: false, error: 'term_required' });
  const norm = String(term).replace(/^#/, '').trim().toLowerCase();
  await pool.query(
    `INSERT INTO watch_terms (term, kind, source, status) VALUES ($1,'keyword','user','active')
     ON CONFLICT (term, kind) DO UPDATE SET status = 'active'`,
    [norm]
  );
  const idRow = (await pool.query("SELECT id FROM watch_terms WHERE term = $1 AND kind = 'keyword'", [norm])).rows[0];
  res.json({ ok: true, id: idRow && idRow.id });
});

app.patch('/radar/terms/:id', async (req, res) => {
  const { status } = req.body || {};
  if (!['active', 'paused'].includes(status)) return res.status(400).json({ ok: false, error: 'bad_status' });
  await pool.query('UPDATE watch_terms SET status = $1 WHERE id = $2', [status, Number(req.params.id)]);
  res.json({ ok: true });
});

app.delete('/radar/terms/:id', async (req, res) => {
  await pool.query('DELETE FROM watch_terms WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
});

app.post('/radar/run', (req, res) => {
  if (radar.getRadarStatus().running) return res.json({ ok: true, started: false, reason: 'already_running' });
  if (!scraper || !scraper.apiKey) return res.json({ ok: true, started: false, reason: 'no_api_key' });
  radar.runRadar(scraper).catch(e => console.error('[Radar] run failed:', e.message));
  res.json({ ok: true, started: true });
});

// ─── Admin Routes ───────────────────────────────────────────────

app.get('/admin/apify-usage', async (req, res) => {
  try {
    const summary = await usageSummary(pool);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Engagement Routes ──────────────────────────────────────────

// Backfill: set followers for an account and recalc ER for all posts
app.post('/engagement/backfill', async (req, res) => {
  try {
    const { handle, followers } = req.body;
    if (handle && followers) {
      await pool.query('UPDATE posts SET followers_at_scrape = $1 WHERE account_handle = $2', [Number(followers), handle]);
    }
    // Recalc view-based ER for all posts with view counts.
    const postsResult = await pool.query('SELECT id, like_count, comment_count, view_count FROM posts WHERE view_count > 0');
    let count = 0;
    for (const post of postsResult.rows) {
      const { er_percent, er_label } = calcViewER(post.like_count || 0, post.comment_count || 0, post.view_count);
      await pool.query('UPDATE posts SET er_percent = $1, er_label = $2 WHERE id = $3', [er_percent, er_label, post.id]);
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
    // Recalc view-based ER for all posts with view counts.
    const postsResult = await pool.query('SELECT id, like_count, comment_count, view_count FROM posts WHERE view_count > 0');
    let count = 0;
    for (const post of postsResult.rows) {
      const { er_percent, er_label } = calcViewER(post.like_count || 0, post.comment_count || 0, post.view_count);
      await pool.query('UPDATE posts SET er_percent = $1, er_label = $2 WHERE id = $3', [er_percent, er_label, post.id]);
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
  const avgLabel = engagementLabel(avgER);

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
    return { ...a, avg_er: avgEr, er_label: engagementLabel(avgEr) };
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

// [R1-#8] The only columns POST/PUT /models may ever write. Base fields have always
// been positional; MODEL_WRITE_FIELDS (email/login_enabled/password_hash) are the new
// credential columns from model-credentials.js. 'role' is deliberately excluded — see
// buildCredentialFields. Both handlers below build columns/placeholders/params by
// iterating THIS constant against a hand-built `merged` object — never Object.keys(req.body).
const MODEL_BASE_FIELDS = ['name', 'primary_niche', 'secondary_niches', 'delivery_method', 'delivery_contact', 'delivery_day'];
const MODEL_ALL_WRITE_FIELDS = [...MODEL_BASE_FIELDS, ...MODEL_WRITE_FIELDS];

// [R1-#9] Explicit column list — deliberately excludes password_hash so it can never
// reach the admin client. Includes email/role/login_enabled so the admin UI can show
// login status. This is the ONLY `SELECT * FROM models` that serialized a raw row
// straight to an HTTP response; the other SELECT * FROM models call sites (PDF/Notion
// export, ai-agent.js, delivery.js, scheduler.js) read named fields only and never echo
// the row, so they were left as-is.
app.get('/models', async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, primary_niche, secondary_niches, delivery_method, delivery_contact, delivery_day, status, email, role, login_enabled, notion_page_id, created_at, updated_at
     FROM models WHERE status = 'active' ORDER BY created_at DESC`
  );
  res.json(result.rows);
});

app.post('/models', async (req, res) => {
  const { name, primary_niche, secondary_niches, delivery_method, delivery_contact, delivery_day } = req.body;
  if (!name || !primary_niche) return res.status(400).json({ error: 'name and primary_niche required' });
  const merged = {
    name, primary_niche,
    secondary_niches: secondary_niches || '',
    delivery_method: delivery_method || 'whatsapp',
    delivery_contact: delivery_contact || '',
    delivery_day: delivery_day || 'monday',
    ...buildCredentialFields(req.body),
  };
  const { sql, params } = buildModelInsert(merged, MODEL_ALL_WRITE_FIELDS);
  try {
    const result = await pool.query(sql, params);
    res.json({ success: true, id: result.rows[0]?.id });
  } catch (err) {
    if (isDuplicateEmailError(err)) return res.status(409).json({ error: 'Email already in use' });
    throw err;
  }
});

app.put('/models/:id', async (req, res) => {
  const { name, primary_niche, secondary_niches, delivery_method, delivery_contact, delivery_day } = req.body;
  const merged = {
    name, primary_niche,
    secondary_niches: secondary_niches || '',
    delivery_method: delivery_method || 'whatsapp',
    delivery_contact: delivery_contact || '',
    delivery_day: delivery_day || 'monday',
    ...buildCredentialFields(req.body),
  };
  const { sql, params } = buildModelUpdate(merged, MODEL_ALL_WRITE_FIELDS, req.params.id);
  try {
    await pool.query(sql, params);
    res.json({ success: true });
  } catch (err) {
    if (isDuplicateEmailError(err)) return res.status(409).json({ error: 'Email already in use' });
    throw err;
  }
});

app.delete('/models/:id', async (req, res) => {
  // [R1-#5] Also disable login so a deleted model fails BOTH resolveLogin (status check)
  // AND the per-request requireModel re-check — belt and suspenders for prompt revocation.
  await pool.query("UPDATE models SET status = 'inactive', login_enabled = 0 WHERE id = $1", [Number(req.params.id)]);
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

app.use('/thumbnails', express.static(DEFAULT_THUMB_DIR));

app.get('/thumb/:postId', asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT thumbnail_url, shortcode FROM posts WHERE id = $1', [Number(req.params.postId)]);
  const post = result.rows[0];
  if (!post || !post.thumbnail_url) return res.status(404).send('No thumbnail');
  const r = await downloadThumbnail(post);
  if (r.status === 'cached') return res.sendFile(r.path);
  return res.status(502).json({ error: `thumbnail ${r.status}: ${r.error || ''}` });
}));

// ─── Video Cache Route ──────────────────────────────────────────

// [R2-1, R3-2, R3-3, R5-1] Worth 302-ing the raw IG URL? Only if refreshed recently AND
// not mid-prune. Reads video_url_refreshed_at — NOT status-pending (eternal) and NOT
// scraped_at (stale on re-scrape). Self-expiring: a pending row refreshed 20d ago is NOT fresh.
function videoUrlIsFresh(post, freshnessDays = Number(process.env.VIDEO_FRESHNESS_DAYS || 2)) {
  if (post.video_cache_status === 'pruning') return false;   // [R5-1] mid-delete → poster, never 302
  if (!post.video_url_refreshed_at) return false;
  const cutoff = new Date(Date.now() - freshnessDays * 86400000).toISOString();
  return post.video_url_refreshed_at >= cutoff;
}

// [R2-10, R4-4] reject non-ids AND values past Postgres int4 max (would overflow the comparison)
function isValidVideoId(id) {
  return Number.isSafeInteger(id) && id > 0 && id <= 2147483647;
}

// [R5-2] Extracted so the sendFile/302/404 branches are unit-testable with a fake
// fs/res, without booting Express or touching the DB. `fs`/`videoDir` are injectable
// for tests; production calls use the module-level `fs` and `DEFAULT_VIDEO_DIR`.
function serveVideo(post, { fs: fsDep = fs, videoDir = DEFAULT_VIDEO_DIR, res }) {
  const file = videoFilePath(post, videoDir);
  let cached = false;
  // [R4-2] a 'pruning' row's file is mid-delete — do not serve it; fall through to poster.
  if (post.video_cache_status !== 'pruning') {
    try { cached = fsDep.statSync(file).size > 0; } catch { cached = false; }
  }
  if (cached) {
    return res.sendFile(file, { acceptRanges: true }, (err) => {
      // [CX-fix] Express's `send` EMITS errors to this callback instead of writing the
      // response — a beyond-EOF Range request lands here with err.status === 416, which
      // must stay 416 (Task 6 acceptance criteria), not be forced to 404. A genuine
      // vanished-file (TOCTOU/ENOENT) error carries err.status === 404, so preserving the
      // error's own status handles both correctly.
      if (err && !res.headersSent) res.status(err.status || err.statusCode || 404).end();
    });
  }
  if (post.video_url && videoUrlIsFresh(post)) return res.redirect(302, post.video_url);  // [R2-1] gated
  return res.status(404).send('no video');    // known-dead or absent → client shows poster
}

app.get('/video/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!isValidVideoId(id)) return res.status(404).send('not found');
  const r = await pool.query(
    'SELECT id, video_url, video_url_refreshed_at, video_cache_status FROM posts WHERE id = $1', [id]);
  const post = r.rows[0];
  if (!post) return res.status(404).send('not found');
  return serveVideo(post, { res });
}));

app.get('/suggested/reels/:id/thumb', asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT thumbnail_url, shortcode FROM suggested_reels WHERE id = $1', [Number(req.params.id)]);
  const reel = result.rows[0];
  if (!reel || !reel.thumbnail_url) return res.status(404).send('No thumbnail');
  const r = await downloadThumbnail(reel);
  if (r.status === 'cached') return res.sendFile(r.path);
  return res.status(502).json({ error: `thumbnail ${r.status}: ${r.error || ''}` });
}));

// ─── Model (Me) Routes ──────────────────────────────────────────

// [R2-#3] THE single top-level me-feed import — Task 6 reuses these, never re-requires.
const { buildMeFeedQuery, nicheVisibilityClause, parseNiches } = require('./me-feed');
app.get('/me/feed', asyncHandler(async (req, res) => {
  const modelId = req.session.user.modelId; // requireModel guarantees this
  const m = await pool.query('SELECT primary_niche, secondary_niches FROM models WHERE id = $1', [modelId]);
  if (m.rows.length === 0) return res.status(404).json({ error: 'Model not found' });
  const myNiches = parseNiches(m.rows[0]);
  const page = Number(req.query.page) || 1;
  const sel = (req.query.niche || '').trim();

  let build, activeNiche;
  if (sel === 'all') { build = buildMeFeedQuery([], { page, limit: 24, all: true }); activeNiche = 'all'; }
  else if (sel)      { build = buildMeFeedQuery([sel], { page, limit: 24 }); activeNiche = sel; }
  else               { build = buildMeFeedQuery(myNiches, { page, limit: 24 }); activeNiche = null; }

  // The content-type vocabulary powers the switcher (models can't hit the admin /content-types route).
  const av = await pool.query('SELECT value, label FROM content_types ORDER BY sort_order, label');
  const availableNiches = av.rows;

  if (!build.sql) return res.json({ posts: [], niches: myNiches, availableNiches, activeNiche });
  const r = await pool.query(build.sql, build.params);
  res.json({ posts: r.rows, niches: myNiches, availableNiches, activeNiche });
}));

const { saveParams } = require('./me-saves');

app.post('/me/saves/:postId', asyncHandler(async (req, res) => {
  const p = saveParams(req.session.user.modelId, req.params.postId);
  if (!p) return res.status(400).json({ error: 'Invalid post id' });
  await pool.query(
    'INSERT INTO model_saved_posts (model_id, post_id, saved_at) VALUES ($1,$2,$3) ON CONFLICT (model_id, post_id) DO NOTHING',
    [p.modelId, p.postId, new Date().toISOString()]);
  res.json({ ok: true });
}));

app.delete('/me/saves/:postId', asyncHandler(async (req, res) => {
  const p = saveParams(req.session.user.modelId, req.params.postId);
  if (!p) return res.status(400).json({ error: 'Invalid post id' });
  await pool.query('DELETE FROM model_saved_posts WHERE model_id = $1 AND post_id = $2', [p.modelId, p.postId]);
  res.json({ ok: true });
}));

app.get('/me/saves', asyncHandler(async (req, res) => {
  const r = await pool.query(
    `SELECT posts.* FROM model_saved_posts s
       JOIN posts ON posts.id = s.post_id
     WHERE s.model_id = $1 AND (posts.soft_deleted = 0 OR posts.soft_deleted IS NULL)
     ORDER BY s.saved_at DESC`, [req.session.user.modelId]);
  res.json({ posts: r.rows });
}));

const { parseSourceShortcodes } = require('./idea-reels');
app.get('/me/ideas', asyncHandler(async (req, res) => {
  const r = await pool.query(
    'SELECT * FROM idea_cards WHERE model_id = $1 ORDER BY created_at DESC LIMIT 50',
    [req.session.user.modelId]);
  const ideas = r.rows;
  const perIdea = ideas.map(i => parseSourceShortcodes(i.source_post_ids));
  const all = [...new Set(perIdea.flat())];
  let byCode = {};
  if (all.length) {
    const ph = all.map((_, i) => `$${i + 1}`).join(', ');
    const pr = await pool.query(
      `SELECT id, shortcode, video_url, thumbnail_url, view_count, caption, post_url, content_type, account_handle, posted_at
       FROM posts WHERE shortcode IN (${ph})
         AND (soft_deleted = 0 OR soft_deleted IS NULL)
         AND (archived = 0 OR archived IS NULL)`, all);
    byCode = Object.fromEntries(pr.rows.map(p => [p.shortcode, p]));
  }
  const enriched = ideas.map((idea, k) => ({
    ...idea,
    sourceReels: perIdea[k].map(code => byCode[code]).filter(Boolean),
  }));
  res.json({ ideas: enriched });
}));

// ─── Static Files ───────────────────────────────────────────────

const clientBuild = path.join(__dirname, '..', 'client', 'build');
if (fs.existsSync(clientBuild)) {
  app.use(express.static(clientBuild));
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientBuild, 'index.html'));
  });
}

// Sentry error capture — after all routes, before our own error responder so it
// sees every route error. No-op unless SENTRY_DSN is set.
if (process.env.SENTRY_DSN) Sentry.setupExpressErrorHandler(app);

app.use(dbErrorMiddleware); // must be last

// Defense-in-depth: wrapAsyncRoutes already forwards route-handler rejections to
// dbErrorMiddleware; this guard catches any non-route async rejection (e.g. a
// background job) so a stray rejection can never crash the process.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', (err && (err.code || err.message)) || err);
});

async function boot() {
  health.assertThumbDirWritable(DEFAULT_THUMB_DIR);
  try {
    await initWithRetry(() => pool.initDB());
    health.markReady();
    console.log('Database ready');
  } catch (err) {
    console.error('[Boot] fatal DB init error; exiting:', err.code || err.message);
    process.exit(1); // fail the deploy rather than promote a broken release
  }
}

if (require.main === module) {
  const secProblems = checkProdSecrets();
  if (secProblems.length) {
    console.error('[Security] Refusing to start in production:\n - ' + secProblems.join('\n - '));
    process.exit(1); // fail the deploy rather than run with insecure auth/session config
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    if (passwordHash) console.log('Auth enabled — password required'); else console.log('Auth disabled — no AUTH_PASSWORD set');
  });
  boot().then(() => startScheduler(scraper));
}

module.exports = app;
module.exports.checkProdSecrets = checkProdSecrets;
module.exports.videoUrlIsFresh = videoUrlIsFresh;
module.exports.isValidVideoId = isValidVideoId;
module.exports.serveVideo = serveVideo;
