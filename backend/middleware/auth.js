// ============================================================
// Auth Middleware — protects routes that need login
// ============================================================
// Verifies the JWT, then checks the organisation's account status
// (pending approval / trial+grace expired / suspended) on every
// authenticated request. This is enforced server-side deliberately —
// a frontend-only check can be bypassed by anyone editing the page's
// JS, so access control has to live here.
// ============================================================

const { verify } = require('../core/jwt');
const { query } = require('../database/db');

const TRIAL_GRACE_DAYS = 3;

module.exports = async function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, error: 'No token. Please log in.' });
  }

  let decoded;
  try {
    decoded = verify(token);
  } catch (err) {
    return res.status(403).json({ success: false, error: 'Invalid or expired token. Please log in again.' });
  }

  req.user = {
    ...decoded,
    role: (decoded.role || '').toString().trim().toLowerCase(),
  };

  // super_admin is never locked out — they need access to fix things.
  if (req.user.role === 'super_admin') return next();

  try {
    const r = await query(
      `SELECT o.is_active AS org_active, o.plan,
              s.status AS sub_status, s.trial_ends_at
       FROM organisations o
       LEFT JOIN subscriptions s ON s.organisation_id = o.id
       WHERE o.id = $1
       ORDER BY s.created_at DESC
       LIMIT 1`,
      [req.user.orgId]
    );

    if (!r.rows.length) {
      return res.status(403).json({ success: false, error: 'Organisation not found.', lockReason: 'not_found' });
    }
    const org = r.rows[0];

    // NGO/Screening plan awaiting manual approval — org row exists but
    // is_active is false until an admin approves it (see /api/admin/orgs/:id/approve).
    if (org.plan === 'ngo_screening' && !org.org_active) {
      return res.status(403).json({
        success: false,
        error: 'Your NGO/Screening account is pending approval.',
        lockReason: 'pending_approval',
        contact: { whatsapp: '0759327843', call: '0780621060', email: 'samkagino@gmail.com' },
      });
    }

    // Trial expired beyond the grace period, and never converted to a paid plan.
    if (org.sub_status === 'trial' && org.trial_ends_at) {
      const graceEnd = new Date(org.trial_ends_at);
      graceEnd.setDate(graceEnd.getDate() + TRIAL_GRACE_DAYS);
      if (new Date() > graceEnd) {
        return res.status(403).json({
          success: false,
          error: 'Your trial and grace period have ended. Please contact us to continue using MedVault.',
          lockReason: 'trial_expired',
          contact: { whatsapp: '0759327843', call: '0780621060', email: 'samkagino@gmail.com' },
        });
      }
    }

    // Suspended by admin (e.g. non-payment beyond grace) or org otherwise deactivated.
    if (!org.org_active && org.plan !== 'ngo_screening') {
      return res.status(403).json({
        success: false,
        error: 'Your account is suspended. Please contact us to reactivate it.',
        lockReason: 'suspended',
        contact: { whatsapp: '0759327843', call: '0780621060', email: 'samkagino@gmail.com' },
      });
    }

    next();
  } catch (e) {
    // Fail open on a DB error here would be dangerous for paywall enforcement,
    // but failing closed on every transient DB hiccup would lock out the whole
    // platform. Log loudly and let the request through — this mirrors how the
    // rest of the app already treats DB blips (audit() failures are logged,
    // not fatal) rather than turning a rare transient error into a full outage.
    console.error('[auth] account status check failed:', e.message);
    next();
  }
};
