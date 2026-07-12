const bcrypt = require('bcryptjs');

function hashPassword(plain) { return bcrypt.hashSync(String(plain || ''), 10); }
function verifyPassword(plain, hash) { return !!hash && bcrypt.compareSync(String(plain || ''), hash); }

function resolveLogin({ email, password } = {}, ctx = {}) {
  const { adminPasswordHash = null, models = [] } = ctx;
  if (!email) {
    if (adminPasswordHash && verifyPassword(password, adminPasswordHash)) {
      return { ok: true, user: { id: 0, role: 'admin', modelId: null } };
    }
    return { ok: false, error: 'Invalid credentials' };
  }
  const m = models.find(x => x.email && x.email.toLowerCase() === String(email).toLowerCase());
  // [R1-#5] active + enabled required; [R1-#7] role is ALWAYS 'model' here, never from the row
  if (m && m.login_enabled && m.status === 'active' && verifyPassword(password, m.password_hash)) {
    return { ok: true, user: { id: m.id, role: 'model', modelId: m.id } };
  }
  return { ok: false, error: 'Invalid credentials' };
}

function modelAccessErrorStatus(user, { authEnabled = false } = {}) {
  if (!user) return authEnabled ? 401 : 403;
  if (user.role !== 'model' || !user.modelId) return 403;
  return null;
}

class LoginThrottle {
  constructor({ max = 5, windowMs = 15 * 60000, maxEntries = 5000, now = () => Date.now() } = {}) {
    this.max = max; this.windowMs = windowMs; this.maxEntries = maxEntries; this.now = now; this.hits = new Map();
  }
  _fresh(key) {
    const e = this.hits.get(key);
    if (e && this.now() - e.first > this.windowMs) { this.hits.delete(key); return null; }
    return e || null;
  }
  check(key) {
    const e = this._fresh(key);
    if (e && e.count >= this.max) return { blocked: true, retryInSec: Math.ceil((e.first + this.windowMs - this.now()) / 1000) };
    return { blocked: false, retryInSec: 0 };
  }
  fail(key) {
    if (!this.hits.has(key) && this.hits.size >= this.maxEntries) {
      const now = this.now();
      for (const [candidate, entry] of this.hits) {
        if (now - entry.first > this.windowMs) this.hits.delete(candidate);
      }
      while (this.hits.size >= this.maxEntries) this.hits.delete(this.hits.keys().next().value);
    }
    const e = this._fresh(key) || { count: 0, first: this.now() };
    e.count += 1; this.hits.set(key, e);
  }
  reset(key) { this.hits.delete(key); }
}

module.exports = { hashPassword, verifyPassword, resolveLogin, modelAccessErrorStatus, LoginThrottle };
