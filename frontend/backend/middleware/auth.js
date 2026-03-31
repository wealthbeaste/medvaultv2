// ============================================================
// Auth Middleware — protects routes that need login
// ============================================================

const { verify } = require('../core/jwt');

module.exports = function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    res.json({ error: 'No token. Please log in.' }, 401);
    return;
  }

  try {
    req.user = verify(token);
    next();
  } catch (err) {
    res.json({ error: 'Invalid or expired token. Please log in again.' }, 403);
  }
};
