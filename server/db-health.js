const TRANSIENT_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', '57P03']);
const AUTH_CODES = new Set(['28P01', '28000', '3D000']);

function isTransientDbError(err) {
  if (!err) return false;
  if (TRANSIENT_CODES.has(err.code)) return true;
  if (typeof err.code === 'string' && err.code.startsWith('08')) return true; // connection exceptions
  return false;
}

function classifyDbError(err) {
  if (isTransientDbError(err)) return 'transient';
  if (err && AUTH_CODES.has(err.code)) return 'auth';
  return 'other';
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function dbErrorMiddleware(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (isTransientDbError(err)) {
    console.error('[DB] transient error on request:', err.code || err.message);
    return res.status(503).json({ error: 'temporarily unavailable' });
  }
  console.error('[Error]', err && err.stack ? err.stack : err);
  return res.status(500).json({ error: 'internal error' });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function initWithRetry(initFn, opts = {}) {
  const { maxAttempts = 30, baseDelayMs = 1000, maxDelayMs = 15000 } = opts;
  for (let attempt = 1; ; attempt++) {
    try { return await initFn(); }
    catch (err) {
      const kind = classifyDbError(err);
      if (kind !== 'transient' || attempt >= maxAttempts) {
        console.error(`[Boot] DB init failed (${kind}, attempt ${attempt}):`, err.code || err.message);
        throw err;
      }
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      console.warn(`[Boot] DB not ready (${err.code || err.message}); retry ${attempt} in ${delay}ms`);
      await sleep(delay);
    }
  }
}

function wrapAsyncRoutes(app) {
  for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
    const orig = app[m].bind(app);
    app[m] = (path, ...handlers) =>
      orig(path, ...handlers.map(h => (typeof h === 'function' && h.length < 4) ? asyncHandler(h) : h));
  }
  return app;
}

module.exports = { isTransientDbError, classifyDbError, asyncHandler, dbErrorMiddleware, initWithRetry, wrapAsyncRoutes };
