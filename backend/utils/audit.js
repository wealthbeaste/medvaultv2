'use strict';

// ============================================================
// MedVault — Audit Logger
// Phase 1: Write audit rows for all data-modifying actions.
// Healthcare compliance requirement for licensed pharmacies.
// ============================================================

const { query } = require('../database/db');

/**
 * Write an audit log entry.
 * Fire-and-forget — never throws (audit failure should not fail the request).
 *
 * @param {object} params
 * @param {number}  params.orgId
 * @param {number}  [params.pharmacyId]
 * @param {number}  [params.userId]
 * @param {string}  params.action      e.g. 'sale.create', 'drug.delete'
 * @param {string}  [params.entity]    e.g. 'sale', 'drug', 'user'
 * @param {*}       [params.entityId]  row id of the affected record
 * @param {object}  [params.payload]   what changed (keep concise)
 * @param {string}  [params.ip]        client IP address
 */
async function audit({ orgId, pharmacyId, userId, action, entity, entityId, payload, ip }) {
  try {
    await query(
      `INSERT INTO audit_logs
         (org_id, pharmacy_id, user_id, action, entity, entity_id, payload, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        orgId,
        pharmacyId || null,
        userId || null,
        action,
        entity || null,
        entityId !== undefined ? String(entityId) : null,
        payload ? JSON.stringify(payload) : null,
        ip || null,
      ]
    );
  } catch (e) {
    // Audit failure must never crash the request — log and continue
    console.error('⚠️  Audit log failed:', e.message, { action, entity, entityId });
  }
}

/**
 * Helper to extract client IP from a request object.
 */
function getIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.connection?.remoteAddress ||
    null
  );
}

module.exports = { audit, getIp };
