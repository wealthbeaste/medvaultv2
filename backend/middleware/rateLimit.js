'use strict';

// ============================================================
// MedVault — In-Memory Rate Limiter
// No npm packages. Resets on server restart (acceptable for
// Railway — persistent Redis not needed at this scale).
//
// Usage:
//   const { rateLimit } = require('../middleware/rateLimit');
//
//   // Max 5 login attempts per IP per 15 minutes
//   app.post('/api/auth/login', rateLimit({ max: 5, windowMs: 15 * 60 * 1000 }), handler);
//
//   // Max 3 registrations per IP per hour
//   app.post('/api/auth/register', rateLimit({ max: 3, windowMs: 60 * 60 * 1000 }), handler);
// ============================================================

// store: { key -> { count, resetAt } }
const store = new Map();

// Clean up expired entries every 10 minutes to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of store.entries()) {
    if (now > val.resetAt) store.delete(key);
  }
}, 10 * 60 * 1000);

/**
 * @param {Object} opts
 * @param {number} opts.max        - Max requests allowed in window (default: 5)
 * @param {number} opts.windowMs   - Window duration in ms (default: 15 min)
 * @param {string} [opts.message]  - Custom error message
 */
function rateLimit({ max = 5, windowMs = 15 * 60 * 1000, message } = {}) {
  return (req, res, next) => {
    const ip  = req.headers['x-forwarded-for']?.split(',')[0].trim()
              || req.socket?.remoteAddress
              || 'unknown';

    // Key per IP + route so limits don't bleed across endpoints
    const key = `${ip}:${req.path}`;
    const now = Date.now();

    let entry = store.get(key);

    // First request or window expired — start fresh
    if (!entry || now > entry.resetAt) {
      entry = { count: 1, resetAt: now + windowMs };
      store.set(key, entry);
      return next();
    }

    entry.count += 1;

    if (entry.count > max) {
      const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', retryAfterSec);
      return res.status(429).json({
        success:    false,
        error:      message || `Too many attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minute(s).`,
        code:       'RATE_LIMITED',
        retryAfter: retryAfterSec,
      });
    }

    next();
  };
}

module.exports = { rateLimit };
