const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { asyncHandler, dbErrorMiddleware } = require('./db-health');
const { buildMeFeedQuery, parseNiches, allowedNicheOptions } = require('./me-feed');
const { parseTagList, cleanModelLookTags } = require('./look-tags');
const { effectiveNicheExpr } = require('./sort-status');
const { modelCanAccessPost } = require('./model-access');
const modelTaste = require('./model-taste');
const modelReactions = require('./model-reactions');
const thumbnails = require('./thumbnails');
const { isValidShortcode, ensureReactReference, getPinnedReferencePath, markDanceReference,
  availableReferencePath, usableFile } = require('./react-reference');
const { createReactRenderWorker, validateRenderRequest } = require('./react-render');
const { createReactFetchWorker } = require('./react-fetch');
const { createReactAnalysisWorker } = require('./react-analysis');

const MEDIA_TTL_SECONDS = 6 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VISIBLE_SORTED = `posts.sort_status IN ('auto','manual')
  AND (posts.soft_deleted = 0 OR posts.soft_deleted IS NULL)
  AND (posts.archived = 0 OR posts.archived IS NULL)`;

function constantTimeEqual(left, right) {
  const digest = value => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(left), digest(right));
}

function reelId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id <= 2147483647 ? id : null;
}

function pagination(query, defaultLimit) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const limit = query.limit === undefined ? defaultLimit : Number(query.limit);
  if ((query.page !== undefined && typeof query.page !== 'string')
    || (query.limit !== undefined && typeof query.limit !== 'string')
    || !Number.isSafeInteger(page) || page < 1
    || !Number.isSafeInteger(limit) || limit < 1
    || !Number.isSafeInteger(limit + 1) || !Number.isSafeInteger((page - 1) * limit)) return null;
  return { page, limit };
}

function signature(id, exp, secret) {
  return crypto.createHmac('sha256', secret).update(`${id}.${exp}`).digest('hex');
}

function reactMediaSignature(shortcode, exp, secret, variant) {
  const scope = variant === 'original' ? `react-media.${shortcode}.original` : `react-media.${shortcode}`;
  return crypto.createHmac('sha256', secret).update(`${scope}.${exp}`).digest('hex');
}

function signedReactMedia(req, res, next) {
  const secret = process.env.FILM_MEDIA_SECRET;
  if (!secret) return res.status(503).json({ error: 'media_unavailable' });
  const { shortcode } = req.params;
  const { exp, sig, variant } = req.query;
  if (!isValidShortcode(shortcode) || (variant !== undefined && variant !== 'original')
    || typeof exp !== 'string' || !/^[1-9]\d*$/.test(exp)
    || !Number.isSafeInteger(Number(exp)) || Number(exp) <= Math.floor(Date.now() / 1000)
    || typeof sig !== 'string' || !/^[0-9a-f]{64}$/i.test(sig)
    || !crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(reactMediaSignature(shortcode, exp, secret, variant), 'hex'))) {
    return res.status(403).json({ error: 'invalid_signature' });
  }
  next();
}

function signedMedia(req, res, next) {
  const secret = process.env.FILM_MEDIA_SECRET;
  if (!secret) return res.status(503).json({ error: 'media_unavailable' });
  const id = reelId(req.params.reelId);
  const { exp, sig } = req.query;
  if (!id || typeof exp !== 'string' || !/^[1-9]\d*$/.test(exp)
    || !Number.isSafeInteger(Number(exp)) || Number(exp) <= Math.floor(Date.now() / 1000)
    || typeof sig !== 'string' || !/^[0-9a-f]{64}$/i.test(sig)
    || !crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(signature(id, exp, secret), 'hex'))) {
    return res.status(403).json({ error: 'invalid_signature' });
  }
  req.filmReelId = id;
  next();
}

function sendCachedFile(res, file, { acceptRanges = false } = {}) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0) return res.status(404).json({ error: 'reel_not_available' });
  } catch { return res.status(404).json({ error: 'reel_not_available' }); }
  res.set('Cache-Control', 'private, no-store');
  return res.sendFile(file, { acceptRanges }, error => {
    if (error && !res.headersSent) {
      const status = error.status || error.statusCode || 404;
      res.status(status).type('json').json({ error: status === 416 ? 'range_not_satisfiable' : 'reel_not_available' });
    }
  });
}

async function reelPresenter(pool, req, res) {
  const secret = process.env.FILM_MEDIA_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'media_unavailable' });
    return null;
  }
  const base = new URL(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Invalid PUBLIC_BASE_URL');
  const exp = Math.floor(Date.now() / 1000) + MEDIA_TTL_SECONDS;
  const types = await pool.query('SELECT value, label FROM content_types ORDER BY sort_order, label');
  const labels = new Map(types.rows.map(row => [row.value, row.label]));
  const niches = parseNiches(req.filmModel);
  return (post, saved) => {
    const id = Number(post.id);
    const sig = signature(id, exp, secret);
    const url = kind => {
      const result = new URL(`/film/v1/${kind}/${id}`, base);
      result.searchParams.set('exp', String(exp));
      result.searchParams.set('sig', sig);
      return result.href;
    };
    const type = post.niche || post.content_type || '';
    return {
      id,
      type,
      typeLabel: labels.get(type) || allowedNicheOptions([type], [])[0]?.label || type,
      lookTags: parseTagList(post.ai_look_tags),
      caption: post.caption || '',
      transcript: post.ai_transcript || null,
      creatorHandle: post.account_handle || '',
      postedAt: post.posted_at || null,
      viewCount: Number(post.view_count) || 0,
      likeCount: Number(post.like_count) || 0,
      nicheMatch: niches.includes(type),
      videoUrl: url('media'),
      thumbUrl: url('thumb'),
      instagramUrl: `https://www.instagram.com/reel/${encodeURIComponent(post.shortcode)}/`,
      saved,
    };
  };
}

function registerFilmApi(app, { pool,
  reactAnalysisWorker = createReactAnalysisWorker({ pool }),
  reactWorker = createReactRenderWorker({ pool,
    lookupAnalysis: (shortcode, reference) => reactAnalysisWorker.request(shortcode, reference) }),
  reactFetchWorker = createReactFetchWorker({ pool,
    onReady: (shortcode, reference) => reactAnalysisWorker.request(shortcode, reference) }) }) {
  const router = express.Router();

  router.get('/react-media/:shortcode', signedReactMedia, asyncHandler(async (req, res) => {
    const shortcode = req.params.shortcode;
    const result = await pool.query('SELECT state FROM film_react_refs WHERE shortcode = $1', [shortcode]);
    const post = result.rows[0]?.state === 'ready' ? null
      : (await pool.query('SELECT id FROM posts WHERE shortcode = $1 LIMIT 1', [shortcode])).rows[0];
    if (result.rows[0]?.state !== 'ready' && !post) return res.status(404).json({ error: 'reel_not_available' });
    let file = getPinnedReferencePath(shortcode);
    if (req.query.variant !== 'original') {
      try {
        const ready = await reactAnalysisWorker.getResult(shortcode);
        if (ready.state === 'ready' && ready.analysis && usableFile(ready.path)) file = ready.path;
      } catch { console.error('[React analysis] media_fallback'); }
    }
    if (!file) return res.status(404).json({ error: 'reel_not_available' });
    return sendCachedFile(res, file, { acceptRanges: true });
  }));

  router.get('/media/:reelId', signedMedia, asyncHandler(async (req, res) => {
    const result = await pool.query(`SELECT posts.id, posts.shortcode, posts.video_cache_status,
      CASE WHEN ${VISIBLE_SORTED} THEN 1 ELSE 0 END AS film_visible
      FROM posts WHERE posts.id = $1`, [req.filmReelId]);
    const post = result.rows[0];
    // Explicit service-authorized pins are also valid references when a reel
    // has left the Find feed, including after the normal cache is pruned.
    if (!post || (!getPinnedReferencePath(post.shortcode)
      && (!post.film_visible || post.video_cache_status !== 'cached'))) {
      return res.status(404).json({ error: 'reel_not_available' });
    }
    const file = availableReferencePath(post);
    if (!file) return res.status(404).json({ error: 'reel_not_available' });
    return sendCachedFile(res, file, { acceptRanges: true });
  }));

  router.get('/thumb/:reelId', signedMedia, asyncHandler(async (req, res) => {
    const result = await pool.query(`SELECT posts.shortcode FROM posts
      WHERE posts.id = $1 AND ${VISIBLE_SORTED}`, [req.filmReelId]);
    const post = result.rows[0];
    if (!post || !/^[A-Za-z0-9_-]+$/.test(post.shortcode || '')) return res.status(404).json({ error: 'reel_not_available' });
    return sendCachedFile(res, path.join(thumbnails.DEFAULT_THUMB_DIR, `${post.shortcode}.jpg`));
  }));

  router.use((req, res, next) => {
    const key = process.env.FILM_SERVICE_KEY;
    if (!key || !constantTimeEqual(req.get('authorization') || '', `Bearer ${key}`)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  });
  router.use(express.json());

  router.post('/react-reference', asyncHandler(async (req, res) => {
    if (!isValidShortcode(req.body?.shortcode)) return res.status(400).json({ error: 'invalid_shortcode' });
    if (req.body.fetch !== undefined && typeof req.body.fetch !== 'boolean') {
      return res.status(400).json({ error: 'invalid_fetch' });
    }
    const mode = req.body.mode === undefined ? 'react' : req.body.mode;
    if (!['react', 'dance'].includes(mode)) return res.status(400).json({ error: 'invalid_mode' });
    const secret = process.env.FILM_MEDIA_SECRET;
    if (!secret) return res.status(503).json({ error: 'media_unavailable' });
    const shortcode = req.body.shortcode;
    if (mode === 'dance') markDanceReference(shortcode);
    const reference = await ensureReactReference(pool, shortcode);
    let durationSec = reference?.durationSec;
    if (!reference) {
      if (req.body.fetch === false) {
        const existing = await pool.query('SELECT state FROM film_react_refs WHERE shortcode = $1', [shortcode]);
        if (existing.rows[0]?.state === 'fetching') return res.status(202).json({ state: 'fetching' });
        return res.status(404).json({ error: 'reel_not_available' });
      }
      const result = await reactFetchWorker.request(shortcode, { analyze: mode === 'react' });
      if (result.state === 'fetching') return res.status(202).json({ state: 'fetching' });
      if (result.state !== 'ready') return res.status(404).json({ error: 'reel_not_available' });
      durationSec = result.durationSec;
    }
    let analysis = null;
    if (mode === 'react') {
      try {
        const result = await reactAnalysisWorker.request(shortcode, reference || {
          path: getPinnedReferencePath(shortcode), durationSec,
        });
        if (result.state === 'fetching') return res.status(202).json({ state: 'fetching' });
        if (result.state === 'ready' && usableFile(result.path)) analysis = result.analysis;
      } catch { console.error('[React analysis] reference_fallback'); }
    }
    const base = new URL(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`);
    if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Invalid PUBLIC_BASE_URL');
    const exp = Math.floor(Date.now() / 1000) + MEDIA_TTL_SECONDS;
    const url = new URL(`/film/v1/react-media/${shortcode}`, base);
    url.searchParams.set('exp', String(exp));
    url.searchParams.set('sig', reactMediaSignature(shortcode, exp, secret));
    const originalUrl = new URL(`/film/v1/react-media/${shortcode}`, base);
    originalUrl.searchParams.set('variant', 'original');
    originalUrl.searchParams.set('exp', String(exp));
    originalUrl.searchParams.set('sig', reactMediaSignature(shortcode, exp, secret, 'original'));
    return res.json({ videoUrl: mode === 'dance' ? originalUrl.href : url.href,
      originalVideoUrl: originalUrl.href, durationSec: durationSec ?? null, analysis });
  }));

  router.post('/react-prefetch', asyncHandler(async (req, res) => {
    const shortcodes = req.body?.shortcodes;
    if (!Array.isArray(shortcodes) || shortcodes.length < 1 || shortcodes.length > 50
      || shortcodes.some(shortcode => !isValidShortcode(shortcode))) {
      return res.status(400).json({ error: 'invalid_shortcodes' });
    }
    let queued = 0;
    for (const shortcode of new Set(shortcodes)) {
      if (getPinnedReferencePath(shortcode)) continue;
      const existing = await pool.query('SELECT id FROM posts WHERE shortcode = $1 LIMIT 1', [shortcode]);
      if (existing.rows.length) continue;
      const result = await reactFetchWorker.request(shortcode);
      if (result.launched) queued++;
    }
    return res.status(202).json({ queued });
  }));

  router.post('/react-render', asyncHandler(async (req, res) => {
    const error = validateRenderRequest(req.body);
    if (error) return res.status(400).json({ error });
    try { await reactWorker.enqueue(req.body); }
    catch { return res.status(503).json({ error: 'render_unavailable' }); }
    return res.status(202).json({ accepted: true });
  }));

  router.use('/models/:hqProjectId', asyncHandler(async (req, res, next) => {
    const result = await pool.query("SELECT * FROM models WHERE hq_project_id = $1 AND status = 'active'", [req.params.hqProjectId.toLowerCase()]);
    if (!result.rows.length) return res.status(404).json({ error: 'model_not_linked' });
    req.filmModel = result.rows[0];
    next();
  }));

  router.get('/models/:hqProjectId', asyncHandler(async (req, res) => {
    const types = await pool.query('SELECT value, label FROM content_types ORDER BY sort_order, label');
    const vocabulary = await pool.query('SELECT value FROM look_tags');
    res.json({
      name: req.filmModel.name,
      niches: allowedNicheOptions(parseNiches(req.filmModel), types.rows),
      lookTags: cleanModelLookTags(parseTagList(req.filmModel.look_tags), vocabulary.rows),
      linked: true,
    });
  }));

  router.get('/models/:hqProjectId/feed', asyncHandler(async (req, res) => {
    const paging = pagination(req.query, 20);
    if (!paging) return res.status(400).json({ error: 'invalid_pagination' });
    const niches = parseNiches(req.filmModel);
    if (req.query.niche !== undefined && typeof req.query.niche !== 'string') return res.status(400).json({ error: 'invalid_niche' });
    const niche = (req.query.niche || '').trim();
    if (niche && !niches.includes(niche)) return res.status(403).json({ error: 'niche_not_available' });
    if (req.query.shuffle !== undefined && !['0', '1'].includes(req.query.shuffle)) return res.status(400).json({ error: 'invalid_shuffle' });
    const present = await reelPresenter(pool, req, res);
    if (!present) return;
    const vocabulary = await pool.query('SELECT value FROM look_tags');
    const lookTags = cleanModelLookTags(parseTagList(req.filmModel.look_tags), vocabulary.rows);
    const taste = modelTaste.tasteForFeed(await modelTaste.loadTaste(pool, req.filmModel.id), new Set(vocabulary.rows.map(row => row.value)));
    const { page, limit } = paging;
    const shuffle = req.query.shuffle === '1';
    const modelId = req.filmModel.id;
    const built = buildMeFeedQuery(niches, {
      page, limit: limit + 1, pageSize: limit, shuffle,
      modelId, lookTags, taste, niche: niche || null,
    });
    const result = built.sql ? await pool.query(built.sql, built.params) : { rows: [] };
    res.json({ reels: result.rows.slice(0, limit).map(post => present(post, false)), page, hasMore: result.rows.length > limit });
  }));

  router.get('/models/:hqProjectId/saves', asyncHandler(async (req, res) => {
    const paging = pagination(req.query, 50);
    if (!paging) return res.status(400).json({ error: 'invalid_pagination' });
    const present = await reelPresenter(pool, req, res);
    if (!present) return;
    const { page, limit } = paging;
    const result = await pool.query(`SELECT posts.*, ${effectiveNicheExpr()} AS niche
      FROM model_saved_posts s JOIN posts ON posts.id = s.post_id
      WHERE s.model_id = $1 AND ${VISIBLE_SORTED}
      ORDER BY s.saved_at DESC LIMIT $2 OFFSET $3`, [req.filmModel.id, limit + 1, (page - 1) * limit]);
    res.json({ reels: result.rows.slice(0, limit).map(post => present(post, true)), page, hasMore: result.rows.length > limit });
  }));

  const accessibleReel = asyncHandler(async (req, res, next) => {
    const id = reelId(req.params.reelId);
    if (!id) return res.status(404).json({ error: 'reel_not_available' });
    const sorted = await pool.query(`SELECT posts.id FROM posts WHERE posts.id = $1 AND ${VISIBLE_SORTED}`, [id]);
    if (!sorted.rows.length || !(await modelCanAccessPost(pool, req.filmModel.id, id))) {
      return res.status(404).json({ error: 'reel_not_available' });
    }
    req.filmReelId = id;
    next();
  });

  router.post('/models/:hqProjectId/reels/:reelId/save', accessibleReel, asyncHandler(async (req, res) => {
    if (typeof req.body?.saved !== 'boolean') return res.status(400).json({ error: 'invalid_saved' });
    const state = await modelReactions.applyModelReaction(pool, {
      modelId: req.filmModel.id, postId: req.filmReelId, reaction: req.body.saved ? 'save' : 'unsave',
    });
    res.json({ saved: state.saved });
  }));

  router.post('/models/:hqProjectId/reels/:reelId/skip', accessibleReel, asyncHandler(async (req, res) => {
    await modelReactions.applyModelReaction(pool, { modelId: req.filmModel.id, postId: req.filmReelId, reaction: 'not_interested' });
    res.json({ skipped: true });
  }));

  router.post('/models/:hqProjectId/reels/:reelId/filming', accessibleReel, asyncHandler(async (req, res) => {
    if (typeof req.body?.hqItemId !== 'string' || !UUID.test(req.body.hqItemId)) return res.status(400).json({ error: 'invalid_hq_item_id' });
    const modelId = req.filmModel.id, postId = req.filmReelId;
    const nowIso = new Date().toISOString();
    await pool.transaction(async tx => {
      await modelReactions.upsertFeedback(tx, { modelId, postId, feedback: 'want_to_make', nowIso });
      await tx.query(`INSERT INTO film_reel_items (model_id, post_id, hq_item_id, created_at)
        VALUES ($1,$2,$3,$4) ON CONFLICT (model_id, post_id) DO UPDATE SET hq_item_id = excluded.hq_item_id`,
      [modelId, postId, req.body.hqItemId, nowIso]);
    });
    await modelTaste.refreshTaste(pool, modelId);
    res.json({ ok: true });
  }));

  router.use((req, res) => res.status(404).json({ error: 'not_found' }));
  router.use((error, req, res, next) => {
    if (error.type === 'entity.parse.failed' && !res.headersSent) return res.status(400).json({ error: 'invalid_json' });
    return dbErrorMiddleware(error, req, res, next);
  });
  app.use('/film/v1', router);
  return reactWorker;
}

module.exports = { registerFilmApi };
