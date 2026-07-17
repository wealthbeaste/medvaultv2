// ============================================================
// Auth Middleware — protects routes that need login
// ============================================================
// FIX: normalise req.user.role to lowercase after token verify
// so role comparisons in can() and route handlers are consistent
// regardless of how the role was stored in the DB or JWT.
// ============================================================

const { verify } = require('../core/jwt');

module.exports = function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, error: 'No token. Please log in.' });
  }

  try {
    const decoded = verify(token);
    // FIX: normalise role to lowercase immediately so every downstream
    // comparison (can(), hasPermission(), route-level role checks) is
    // immune to mixed-case values stored in the database.
    req.user = {
      ...decoded,
      role: (decoded.role || '').toString().trim().toLowerCase(),
    };
    next();
  } catch (err) {
    return res.status(403).json({ success: false, error: 'Invalid or expired token. Please log in again.' });
  }
};
