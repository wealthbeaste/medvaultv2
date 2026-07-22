'use strict';
const err = require('./_err');

// ============================================================
// MedVault — Shared Drug Catalog
// ============================================================
// A canonical list of drugs (generic name + strength + form) that both
// a pharmacy's own `drugs` table and a supplier's `marketplace_products`
// can optionally link to via catalog_id, instead of matching on free
// text. See db.js migration for the full rationale.
//
// Routes:
//   GET  /api/drug-catalog/search   (public)      — typeahead search
//   POST /api/drug-catalog          (login req'd) — find-or-create entry
// ============================================================

module.exports = function registerDrugCatalogRoutes(app, { query, sign }) {
  const { verify } = require('../core/jwt');

  // Accepts either a regular pharmacy-user token or a supplier token —
  // this catalog is shared by both sides of the marketplace, and unlike
  // the app's normal `auth` middleware, a supplier's token has role
  // 'supplier' with no pharmacyId, so we just need *some* valid actor
  // for accountability, not a specific token shape.
  function identifyActor(req) {
    const header = req.headers['authorization'];
    const token  = header && header.split(' ')[1];
    if (!token) return null;
    try {
      const payload = verify(token);
      if (payload.role === 'supplier') {
        return { type: 'supplier', id: payload.supplierId };
      }
      return { type: 'pharmacy_user', id: payload.id || payload.userId || null };
    } catch (e) {
      return null;
    }
  }

  function normalizedKey(generic_name, strength, form) {
    return [generic_name, strength, form]
      .map(x => (x || '').toString().trim().toLowerCase())
      .join('|');
  }

  // ──────────────────────────────────────────────────────────
  // GET /api/drug-catalog/search?q=paracetamol
  // Public typeahead — no PII here, just generic drug metadata, so it's
  // usable from both the supplier portal and the pharmacy app without
  // juggling two different auth schemes on one input box.
  // ──────────────────────────────────────────────────────────
  app.get('/api/drug-catalog/search', async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ results: [] });

    try {
      const like    = `%${q}%`;
      const starts  = `${q}%`;
      const result = await query(
        `SELECT id, generic_name, brand_name, category, strength, form, unit, requires_rx
         FROM drug_catalog
         WHERE generic_name ILIKE $1 OR brand_name ILIKE $1
         ORDER BY (CASE WHEN generic_name ILIKE $2 OR brand_name ILIKE $2 THEN 0 ELSE 1 END), generic_name ASC
         LIMIT 15`,
        [like, starts]
      );
      res.json({ results: result.rows });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ──────────────────────────────────────────────────────────
  // POST /api/drug-catalog — find-or-create a catalog entry
  // Requires login (pharmacy user or supplier) for accountability, but
  // deliberately does not require any special permission — this is meant
  // to be the natural "can't find it? add it" fallback in a typeahead,
  // not an admin-gated action.
  //
  // Dedup: entries are matched on a normalized key of
  // generic_name+strength+form. An exact repeat returns the existing
  // row instead of creating a duplicate. Near-duplicates from typos or
  // inconsistent naming are NOT caught by this v1 — that's a curation
  // problem to revisit if it turns out to matter in practice.
  // ──────────────────────────────────────────────────────────
  app.post('/api/drug-catalog', async (req, res) => {
    const actor = identifyActor(req);
    if (!actor) return err(res, 401, 'AUTH_NO_TOKEN', 'Please log in to add a new catalog entry.');

    const { generic_name, brand_name, category, strength, form, unit, requires_rx } = req.body;
    if (!generic_name || !generic_name.trim()) {
      return err(res, 400, 'VALIDATION_REQUIRED', 'Generic name is required', 'generic_name');
    }

    try {
      const normKey = normalizedKey(generic_name, strength, form);
      const result = await query(
        `INSERT INTO drug_catalog
           (generic_name, brand_name, category, strength, form, unit, requires_rx,
            normalized_key, created_by_type, created_by_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (normalized_key) DO UPDATE SET updated_at = NOW()
         RETURNING *`,
        [
          generic_name.trim(), (brand_name || '').trim() || null, category || 'General',
          (strength || '').trim() || null, (form || '').trim() || null, unit || 'Pack',
          requires_rx === true || requires_rx === 'true',
          normKey, actor.type, actor.id,
        ]
      );
      res.status(201).json({ success: true, entry: result.rows[0] });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });
};
