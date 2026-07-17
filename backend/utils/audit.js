'use strict';

// ============================================================
// MedVault — Audit Log Helper
// Phase 1: Every action touching money, stock, or users is
// recorded. This is a legal requirement for licensed pharmacies.
//
// Usage:
//   const { audit } = require('../middleware/audit');
//   await audit(query, { req, action: 'drug.create', entity: 'drug', entityId: drugId, payload: { name } });
//
// The helper is fire-and-forget safe: it never throws.
// If the audit write fails, it logs to console but does NOT
// fail the parent request — the business operation already
// succeeded and we must not roll it back over an audit error.
// ============================================================

/**
 * @param {Function} query   - The db query function from db.js
 * @param {Object}   opts
 * @param {Object}   opts.req        - Express request (for user + IP)
 * @param {string}   opts.action     - Dot-namespaced action e.g. 'drug.create'
 * @param {string}   [opts.entity]   - Entity type e.g. 'drug', 'sale', 'user'
 * @param {string|number} [opts.entityId] - ID of the affected record
 * @param {Object}   [opts.payload]  - What changed (sanitised — no passwords)
 */
async function audit(query, { req, action, entity, entityId, payload }) {
  try {
    const user       = req.user || {};
    const orgId      = user.orgId      || null;
    const pharmacyId = user.pharmacyId || null;
    const userId     = user.userId     || user.id || null;
    const ip         = req.headers['x-forwarded-for']?.split(',')[0].trim()
                    || req.socket?.remoteAddress
                    || null;

    await query(
      `INSERT INTO audit_logs
         (org_id, pharmacy_id, user_id, action, entity, entity_id, payload, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        orgId,
        pharmacyId,
        userId,
        action,
        entity     || null,
        entityId   != null ? String(entityId) : null,
        payload    ? JSON.stringify(payload)  : null,
        ip,
      ]
    );
  } catch (err) {
    // Never let an audit failure break the main request
    console.error('[audit] write failed:', err.message, '| action:', action);
  }
}

module.exports = { audit };