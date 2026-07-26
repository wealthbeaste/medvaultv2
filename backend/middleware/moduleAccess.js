'use strict';
// ============================================================
// Module/feature-gating middleware — for paid add-on modules
// (e.g. Sickle Cell Screening) that aren't included in every
// organisation's base subscription.
//
// Checks the `modules` JSONB column on that org's most recent
// subscription row, e.g. { "sicklecell": true }. Toggle it via
// PATCH /api/admin/orgs/:id/modules (super-admin only).
//
// Usage (same shape as can()):
//   const requireModule = makeRequireModule(query);
//   app.get('/api/sicklecell/x', auth, can('patients:read'), requireModule('sicklecell'), handler);
// ============================================================

module.exports = function makeRequireModule(query) {
  return function requireModule(moduleName) {
    return async function (req, res, next) {
      const { orgId } = req.user || {};
      if (!orgId) {
        return res.status(400).json({ success: false, error: 'No organisation on this account.' });
      }
      try {
        const r = await query(
          `SELECT modules FROM subscriptions WHERE organisation_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [orgId]
        );
        const modules = r.rows[0]?.modules || {};
        if (modules[moduleName] === true) return next();
        return res.status(403).json({
          success: false,
          error: `The "${moduleName}" module is not included in your subscription. Contact MedVault to add it.`,
          code: 'MODULE_NOT_ENABLED',
          module: moduleName,
        });
      } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
      }
    };
  };
};
