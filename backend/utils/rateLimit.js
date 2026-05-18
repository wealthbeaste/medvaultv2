'use strict';

const store = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of store.entries()) {
    if (now > val.resetAt) store.delete(key);
  }
}, 10 * 60 * 1000);

function rateLimit({ max = 5, windowMs = 15 * 60 * 1000, message } = {}) {
  return (req, res, next) => {
    const ip  = req.headers['x-forwarded-for']?.split(',')[0].trim()
              || req.socket?.remoteAddress
              || 'unknown';

    const key = `${ip}:${req.path}`;
    const now = Date.now();

    let entry = store.get(key);

    if (!entry || now > entry.resetAt) {
      entry = { count: 1, resetAt: now + windowMs };
      store.set(key, entry);
      return next();
    }

    entry.count += 1;

    if (entry.count > max) {
      const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', retryAfterSec);
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
