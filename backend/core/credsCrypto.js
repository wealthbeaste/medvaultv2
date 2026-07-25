'use strict';
// ============================================================
// Reversible encryption for third-party credentials at rest
// (e.g. each pharmacy's DHIS2 password). Not for user account
// passwords — those stay one-way hashed via core/password.js.
//
// Key source: process.env.CREDS_ENC_KEY (32-byte, base64 or hex).
// Falls back to deriving a key from JWT_SECRET so the app still
// runs in dev without extra setup — set CREDS_ENC_KEY explicitly
// in production so credential encryption isn't tied to the JWT
// signing secret.
// ============================================================
const crypto = require('crypto');

function getKey() {
  const raw = process.env.CREDS_ENC_KEY;
  if (raw) {
    const buf = Buffer.from(raw, raw.length === 64 ? 'hex' : 'base64');
    if (buf.length === 32) return buf;
  }
  const fallbackSeed = process.env.JWT_SECRET || 'medvault-dev-fallback-seed';
  return crypto.createHash('sha256').update(fallbackSeed).digest();
}

function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(payload) {
  if (!payload) return null;
  try {
    const key = getKey();
    const buf = Buffer.from(payload, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch (e) {
    return null; // wrong key / corrupted value — treat as unset rather than crashing
  }
}

module.exports = { encrypt, decrypt };
