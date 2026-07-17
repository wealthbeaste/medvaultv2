// ============================================================
// Password Hashing (bcrypt-style using Node crypto)
// No external packages needed
// ============================================================

const crypto = require('crypto');

// Hash a password before saving to database
function hash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hashed = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hashed}`;
}

// Compare a plain password to a stored hash
function compare(password, stored) {
  try {
    const [salt, hashed] = stored.split(':');
    const attempt = crypto.scryptSync(password, salt, 64).toString('hex');
    return attempt === hashed;
  } catch {
    return false;
  }
}

module.exports = { hash, compare };
