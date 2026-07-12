function configuredOrigins(env = process.env) {
  return new Set(String(env.CORS_ORIGINS || '')
    .split(',')
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter(Boolean));
}

function isAllowedOrigin(origin, host, env = process.env) {
  if (!origin) return true;
  if (env.NODE_ENV !== 'production') return true;
  const normalized = String(origin).replace(/\/$/, '');
  if (configuredOrigins(env).has(normalized)) return true;
  try {
    return new URL(normalized).host.toLowerCase() === String(host || '').toLowerCase();
  } catch {
    return false;
  }
}

function corsOptionsForRequest(req, env = process.env) {
  const origin = req.get('Origin');
  const allowed = isAllowedOrigin(origin, req.get('Host'), env);
  return {
    origin: allowed && origin ? origin : false,
    credentials: true,
  };
}

function browserSecurityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

module.exports = { configuredOrigins, isAllowedOrigin, corsOptionsForRequest, browserSecurityHeaders };
