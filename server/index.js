require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const db = require('./db');
const InstagramScraper = require('./scraper');

const app = express();
const PORT = process.env.PORT || 4000;
const THUMB_DIR = path.join(__dirname, 'thumbnails');
const IS_PROD = process.env.NODE_ENV === 'production';

if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR);

// Hash the auth password on startup (if set)
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
let passwordHash = null;
if (AUTH_PASSWORD) {
  passwordHash = bcrypt.hashSync(AUTH_PASSWORD, 10);
}

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Session middleware
app.use(session({
  secret: process.env.SESSION_SECRET || 'instascraper-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: IS_PROD && process.env.FORCE_HTTPS === 'true',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));

// ─── Auth Routes (public) ────────────────────────────────────────

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

// ─── Auth Middleware ──────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (!passwordHash) return next(); // No password set = no auth required
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

app.use('/scrape', requireAuth);
app.use('/content', requireAuth);
app.use('/creators', requireAuth);
app.use('/export', requireAuth);
app.use('/thumb', requireAuth);
app.use('/thumbnails', requireAuth);

const scraper = new InstagramScraper(process.env.APIFY_API_KEY || '');

// ─── Scrape Routes ───────────────────────────────────────────────

app.post('/scrape', async (req, res) => {
  const { query, queryType, minLikes, minViews, startDate, endDate } = req.body;

  if (!query || !queryType) {
    return res.status(400).json({ error: 'query and queryType are required' });
  }

  if (!process.env.APIFY_API_KEY) {
    return res.status(400).json({ error: 'APIFY_API_KEY not configured. Set it in .env' });
  }

  try {
    const result = await scraper.startScrapeJob({
      query,
      queryType,
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

app.get('/scrape/jobs', (req, res) => {
  const jobs = scraper.getAllJobs();
  res.json(jobs);
});

app.get('/scrape/jobs/:id', (req, res) => {
  const job = scraper.getJobStatus(Number(req.params.id));
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ─── Content Routes ──────────────────────────────────────────────

app.get('/content', (req, res) => {
  const {
    page = 1,
    limit = 24,
    sort = 'newest',
    tag,
    account,
    minViews,
    startDate,
    endDate,
    search,
    showArchived,
    contentType,
  } = req.query;

  let where = [];

  // Hide archived by default
  if (showArchived !== 'true') {
    where.push('(archived = 0 OR archived IS NULL)');
  }
  let params = {};

  let joinClause = 'LEFT JOIN creator_types ct ON posts.account_handle = ct.account_handle';
  if (contentType) {
    // Post-level content_type overrides creator-level
    where.push('COALESCE(posts.content_type, ct.content_type) = @contentType');
    params.contentType = contentType;
  }
  if (tag) {
    where.push('tag = @tag');
    params.tag = tag;
  }
  if (account) {
    where.push('account_handle = @account');
    params.account = account;
  }
  if (minViews) {
    where.push('view_count >= @minViews');
    params.minViews = Number(minViews);
  }
  if (startDate) {
    where.push('posted_at >= @startDate');
    params.startDate = startDate;
  }
  if (endDate) {
    where.push('posted_at <= @endDate');
    params.endDate = endDate;
  }
  if (search) {
    where.push('caption LIKE @search');
    params.search = `%${search}%`;
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const sortMap = {
    newest: 'posted_at DESC',
    oldest: 'posted_at ASC',
    most_viewed: 'view_count DESC',
    most_liked: 'like_count DESC',
  };
  const orderBy = sortMap[sort] || 'posted_at DESC';

  const offset = (Number(page) - 1) * Number(limit);

  const total = db.prepare(`SELECT COUNT(*) as count FROM posts ${joinClause} ${whereClause}`).get(params).count;
  const posts = db.prepare(
    `SELECT posts.* FROM posts ${joinClause} ${whereClause} ORDER BY ${orderBy} LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit: Number(limit), offset });

  const accounts = db.prepare("SELECT DISTINCT account_handle FROM posts WHERE account_handle != ''").all()
    .map(r => r.account_handle);

  res.json({
    posts,
    total,
    page: Number(page),
    totalPages: Math.ceil(total / Number(limit)),
    accounts,
  });
});

app.post('/content/:id/tag', (req, res) => {
  const { tag } = req.body;
  const validTags = ['recreate', 'reference', 'skip', null];
  if (!validTags.includes(tag)) {
    return res.status(400).json({ error: 'Invalid tag. Use: recreate, reference, skip, or null' });
  }

  const result = db.prepare('UPDATE posts SET tag = ? WHERE id = ?').run(tag, Number(req.params.id));
  if (result.changes === 0) return res.status(404).json({ error: 'Post not found' });
  res.json({ success: true });
});

app.post('/content/:id/notes', (req, res) => {
  const { notes } = req.body;
  const result = db.prepare('UPDATE posts SET notes = ? WHERE id = ?').run(notes || '', Number(req.params.id));
  if (result.changes === 0) return res.status(404).json({ error: 'Post not found' });
  res.json({ success: true });
});

app.post('/content/:id/content-type', (req, res) => {
  const { contentType } = req.body;
  const valid = ['talking', 'dance', 'skit', 'snapchat', 'omegle', 'osc', null];
  if (!valid.includes(contentType)) {
    return res.status(400).json({ error: 'Invalid content type' });
  }
  const result = db.prepare('UPDATE posts SET content_type = ? WHERE id = ?').run(contentType, Number(req.params.id));
  if (result.changes === 0) return res.status(404).json({ error: 'Post not found' });
  res.json({ success: true });
});

// ─── Creator Type Routes ─────────────────────────────────────────

app.post('/creators/:handle/type', (req, res) => {
  const { contentType } = req.body;
  const valid = ['talking', 'dance', 'skit', 'snapchat', 'omegle', 'osc', null];
  if (!valid.includes(contentType)) {
    return res.status(400).json({ error: 'Invalid content type' });
  }
  if (contentType) {
    db.prepare('INSERT OR REPLACE INTO creator_types (account_handle, content_type) VALUES (?, ?)').run(req.params.handle, contentType);
  } else {
    db.prepare('DELETE FROM creator_types WHERE account_handle = ?').run(req.params.handle);
  }
  res.json({ success: true });
});

app.get('/creators', (req, res) => {
  const creators = db.prepare(`
    SELECT p.account_handle, ct.content_type, COUNT(*) as post_count
    FROM posts p
    LEFT JOIN creator_types ct ON p.account_handle = ct.account_handle
    WHERE p.account_handle != ''
    GROUP BY p.account_handle
    ORDER BY post_count DESC
  `).all();
  res.json(creators);
});

app.post('/content/:id/archive', (req, res) => {
  const { archived } = req.body;
  const val = archived ? 1 : 0;
  const result = db.prepare('UPDATE posts SET archived = ? WHERE id = ?').run(val, Number(req.params.id));
  if (result.changes === 0) return res.status(404).json({ error: 'Post not found' });
  res.json({ success: true });
});

// ─── Export Route ────────────────────────────────────────────────

app.get('/export', (req, res) => {
  const { format = 'json', tag = 'recreate' } = req.query;

  const posts = db.prepare('SELECT * FROM posts WHERE tag = ?').all(tag);

  if (format === 'csv') {
    const { Parser } = require('json2csv');
    const fields = ['id', 'shortcode', 'video_url', 'thumbnail_url', 'caption', 'like_count', 'comment_count', 'view_count', 'posted_at', 'account_handle', 'post_url', 'tag', 'notes'];
    const parser = new Parser({ fields });
    const csv = parser.parse(posts);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=recreate-content.csv');
    return res.send(csv);
  }

  res.setHeader('Content-Disposition', 'attachment; filename=recreate-content.json');
  res.json(posts);
});

// ─── Thumbnail Proxy ─────────────────────────────────────────────

app.use('/thumbnails', express.static(THUMB_DIR));

app.get('/thumb/:postId', async (req, res) => {
  const post = db.prepare('SELECT thumbnail_url, shortcode FROM posts WHERE id = ?').get(Number(req.params.postId));
  if (!post || !post.thumbnail_url) return res.status(404).send('No thumbnail');

  const filename = `${post.shortcode}.jpg`;
  const filepath = path.join(THUMB_DIR, filename);

  // Serve cached version
  if (fs.existsSync(filepath)) {
    return res.sendFile(filepath);
  }

  // Download and cache
  try {
    const response = await fetch(post.thumbnail_url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.buffer();
    fs.writeFileSync(filepath, buffer);
    res.setHeader('Content-Type', 'image/jpeg');
    res.send(buffer);
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch thumbnail: ' + err.message });
  }
});

// ─── Production Static Serving ───────────────────────────────────

const clientBuild = path.join(__dirname, '..', 'client', 'build');
if (fs.existsSync(clientBuild)) {
  app.use(express.static(clientBuild));
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientBuild, 'index.html'));
  });
}

// ─── Start ───────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  if (passwordHash) console.log('Auth enabled — password required');
  else console.log('Auth disabled — no AUTH_PASSWORD set');
});
