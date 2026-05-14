// ============================================================
// Auth Middleware — protects routes that need login
// ============================================================

const { verify } = require('../core/jwt');

module.exports = function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    // FIX: res.json({}, 401) is wrong — Express ignores the 2nd arg
    // Must use res.status(401).json({})
    return res.status(401).json({ success: false, error: 'No token. Please log in.' });
  }

  try {
    req.user = verify(token);
    return next();
  } catch (err) {
    return res.status(403).json({ success: false, error: 'Invalid or expired token. Please log in again.' });
  }
};