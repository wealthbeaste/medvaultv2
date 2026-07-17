// ============================================================
// JWT — JSON Web Tokens
// Built using Node.js crypto module (no jsonwebtoken package)
// Used to secure login sessions
// ============================================================

const crypto = require('crypto');

const SECRET = process.env.JWT_SECRET || 'medvault_secret_2026';

function base64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

// Create a signed JWT token
function sign(payload, expiresInDays = 7) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const exp = Math.floor(Date.now() / 1000) + (expiresInDays * 86400);
  const data = base64url(JSON.stringify({ ...payload, exp, iat: Math.floor(Date.now() / 1000) }));
  const sig = crypto.createHmac('sha256', SECRET).update(`${header}.${data}`).digest('base64url');
  return `${header}.${data}.${sig}`;
}

// Verify and decode a JWT token
function verify(token) {
  if (!token) throw new Error('No token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token format');
  const [header, data, sig] = parts;
  const expected = crypto.createHmac('sha256', SECRET).update(`${header}.${data}`).digest('base64url');
  if (sig !== expected) throw new Error('Invalid signature');
  const payload = JSON.parse(base64urlDecode(data));
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Token expired');
  return payload;
}

module.exports = { sign, verify };
