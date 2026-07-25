'use strict';
// ============================================================
// DHIS2 / Ministry of Health reporting routes
//
// MedVault is multi-tenant: each pharmacy/facility reports to its
// own country/ministry DHIS2 instance, with its own org unit and
// its own login. There is no single "MedVault DHIS2 instance" —
// so connection details and data-element UIDs are configured per
// pharmacy (dhis2_settings table), not hardcoded in the codebase.
//
// dhis2/dataElementMap.js still ships as a DEFAULT TEMPLATE: it
// defines which fields exist and their human-readable labels, but
// every UID in it is a placeholder until a pharmacy fills in its
// own values via PUT /api/dhis2/settings.
// ============================================================
const err = require('./_err');
const template = require('../dhis2/dataElementMap');
const { encrypt, decrypt } = require('../core/credsCrypto');

const isConfigured = (uid) => !!uid && !String(uid).startsWith('CHANGE_ME');

function resolvePeriod(req) {
  const now = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  return { start: req.query.start || firstOfMonth, end: req.query.end || today };
}

// Merge a pharmacy's saved element_map (from the DB) over the static
// template, so unset fields still fall back to the CHANGE_ME shape
// (and therefore still show up as "unconfigured" rather than silently
// vanishing).
function mergeMap(saved) {
  const out = JSON.parse(JSON.stringify(template)); // deep clone defaults
  if (!saved) return out;
  for (const section of ['hmis105', 'hmis106']) {
    if (!saved[section]) continue;
    if (saved[section].orgUnit) out[section].orgUnit = saved[section].orgUnit;
    if (saved[section].dataElements) {
      for (const [k, v] of Object.entries(saved[section].dataElements)) {
        out[section].dataElements[k] = { ...out[section].dataElements[k], ...v };
      }
    }
    if (section === 'hmis105' && saved[section].diagnosisMap) {
      out[section].diagnosisMap = { ...out[section].diagnosisMap, ...saved[section].diagnosisMap };
    }
    if (section === 'hmis106' && saved[section].drugMap) {
      out[section].drugMap = { ...out[section].drugMap, ...saved[section].drugMap };
    }
  }
  return out;
}

module.exports = function registerDhis2Routes(app, { query, auth, can }) {

  // ── Phase 1 — static module list (kept for backward compat) ──
  app.get('/api/dhis2/reports', (req, res) => {
    res.json({ modules: ['HMIS105', 'HMIS106', 'DHIS2 Export', 'NDW Export'] });
  });

  // ── Settings: read this pharmacy's DHIS2 connection config ──
  app.get('/api/dhis2/settings', auth, can('reports:moh'), async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    try {
      const r = await query(`SELECT base_url, username, org_unit_uid, element_map, is_active, password_enc, updated_at
                              FROM dhis2_settings WHERE pharmacy_id = $1`, [pharmacyId]);
      if (!r.rows.length) {
        return res.json({ configured: false, base_url: null, username: null, org_unit_uid: null, element_map: {}, is_active: false, has_password: false });
      }
      const row = r.rows[0];
      res.json({
        configured: true,
        base_url: row.base_url,
        username: row.username,
        org_unit_uid: row.org_unit_uid,
        element_map: row.element_map || {},
        is_active: row.is_active,
        has_password: !!row.password_enc,
        updated_at: row.updated_at,
      });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ── Settings: save/update this pharmacy's DHIS2 connection ──
  // Owner/manager only — these are real third-party login credentials.
  app.put('/api/dhis2/settings', auth, can('settings:write'), async (req, res) => {
    const { pharmacyId, userId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    const { base_url, username, password, org_unit_uid, element_map, is_active } = req.body || {};

    if (base_url && !/^https?:\/\//i.test(base_url)) {
      return err(res, 400, 'VALIDATION_INVALID', 'base_url must start with http:// or https://', 'base_url');
    }

    try {
      const existing = await query(`SELECT password_enc FROM dhis2_settings WHERE pharmacy_id = $1`, [pharmacyId]);
      const passwordEnc = password ? encrypt(password) : (existing.rows[0]?.password_enc || null);

      await query(
        `INSERT INTO dhis2_settings (pharmacy_id, base_url, username, password_enc, org_unit_uid, element_map, is_active, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
         ON CONFLICT (pharmacy_id) DO UPDATE SET
           base_url = EXCLUDED.base_url,
           username = EXCLUDED.username,
           password_enc = EXCLUDED.password_enc,
           org_unit_uid = EXCLUDED.org_unit_uid,
           element_map = EXCLUDED.element_map,
           is_active = EXCLUDED.is_active,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()`,
        [pharmacyId, base_url || null, username || null, passwordEnc, org_unit_uid || null,
         JSON.stringify(element_map || {}), !!is_active, userId || null]
      );
      res.json({ success: true });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ── HMIS 105 — OPD Attendance & Morbidity (pure MedVault data, no DHIS2 creds needed) ──
  app.get('/api/dhis2/hmis105', auth, can('reports:moh'), async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    const { start, end } = resolvePeriod(req);

    try {
      const attendance = await query(
        `SELECT
           COUNT(*)::int AS total_attendance,
           COUNT(*) FILTER (WHERE p.gender ILIKE 'male')::int   AS male,
           COUNT(*) FILTER (WHERE p.gender ILIKE 'female')::int AS female,
           COUNT(*) FILTER (WHERE p.dob IS NOT NULL AND AGE(c.created_at, p.dob) < INTERVAL '1 year')::int AS age_under1,
           COUNT(*) FILTER (WHERE p.dob IS NOT NULL AND AGE(c.created_at, p.dob) >= INTERVAL '1 year'  AND AGE(c.created_at, p.dob) < INTERVAL '5 years')::int  AS age_1to4,
           COUNT(*) FILTER (WHERE p.dob IS NOT NULL AND AGE(c.created_at, p.dob) >= INTERVAL '5 years'  AND AGE(c.created_at, p.dob) < INTERVAL '15 years')::int AS age_5to14,
           COUNT(*) FILTER (WHERE p.dob IS NOT NULL AND AGE(c.created_at, p.dob) >= INTERVAL '15 years' AND AGE(c.created_at, p.dob) < INTERVAL '18 years')::int AS age_15to17,
           COUNT(*) FILTER (WHERE p.dob IS NOT NULL AND AGE(c.created_at, p.dob) >= INTERVAL '18 years' AND AGE(c.created_at, p.dob) < INTERVAL '50 years')::int AS age_18to49,
           COUNT(*) FILTER (WHERE p.dob IS NOT NULL AND AGE(c.created_at, p.dob) >= INTERVAL '50 years' AND AGE(c.created_at, p.dob) < INTERVAL '60 years')::int AS age_50to59,
           COUNT(*) FILTER (WHERE p.dob IS NOT NULL AND AGE(c.created_at, p.dob) >= INTERVAL '60 years')::int AS age_60plus,
           COUNT(*) FILTER (
             WHERE NOT EXISTS (
               SELECT 1 FROM consultations c2
               WHERE c2.patient_id = c.patient_id AND c2.created_at < c.created_at
             )
           )::int AS new_cases
         FROM consultations c
         JOIN patients p ON p.id = c.patient_id
         WHERE c.pharmacy_id = $1 AND c.created_at::date BETWEEN $2 AND $3`,
        [pharmacyId, start, end]
      );

      const diagnoses = await query(
        `SELECT diagnosis, COUNT(*)::int AS count
         FROM consultations
         WHERE pharmacy_id = $1 AND created_at::date BETWEEN $2 AND $3
           AND diagnosis IS NOT NULL AND TRIM(diagnosis) <> ''
         GROUP BY diagnosis
         ORDER BY count DESC
         LIMIT 20`,
        [pharmacyId, start, end]
      );

      const row = attendance.rows[0];
      row.reattendance = row.total_attendance - row.new_cases;

      res.json({ period: { start, end }, opd: row, topDiagnoses: diagnoses.rows });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ── HMIS 106 — Pharmacy / Commodity Logistics ────────────
  app.get('/api/dhis2/hmis106', auth, can('reports:moh'), async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    const { start, end } = resolvePeriod(req);

    try {
      const consumed = await query(
        `SELECT si.drug_id, si.drug_name, SUM(si.quantity)::int AS quantity_consumed
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         WHERE s.pharmacy_id = $1 AND s.voided_at IS NULL
           AND s.created_at::date BETWEEN $2 AND $3
           AND si.drug_id IS NOT NULL
         GROUP BY si.drug_id, si.drug_name`,
        [pharmacyId, start, end]
      );
      const stock = await query(
        `SELECT id AS drug_id, name AS drug_name, quantity AS closing_stock FROM drugs WHERE pharmacy_id = $1`,
        [pharmacyId]
      );

      const consumedById = new Map(consumed.rows.map(r => [r.drug_id, r.quantity_consumed]));
      const commodities = stock.rows.map(r => ({
        drug_id: r.drug_id,
        drug_name: r.drug_name,
        closing_stock: r.closing_stock,
        quantity_consumed: consumedById.get(r.drug_id) || 0,
        currently_stocked_out: r.closing_stock <= 0,
      }));

      res.json({
        period: { start, end },
        commodities,
        note: 'closing_stock reflects current quantity on hand at request time, not a historical end-of-period snapshot. Stockout-day counts require daily stock snapshots, which MedVault does not yet capture.',
      });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ── DHIS2-compatible dataValueSet export (uses this pharmacy's own settings) ──
  app.get('/api/dhis2/export', auth, can('reports:moh'), async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    const { start, end } = resolvePeriod(req);
    const period = start.slice(0, 7).replace('-', '');

    try {
      const settingsRow = await query(`SELECT element_map FROM dhis2_settings WHERE pharmacy_id = $1`, [pharmacyId]);
      const map = mergeMap(settingsRow.rows[0]?.element_map);

      const attendance = await query(
        `SELECT
           COUNT(*)::int AS opd_total_attendance,
           COUNT(*) FILTER (WHERE p.gender ILIKE 'male')::int   AS opd_male,
           COUNT(*) FILTER (WHERE p.gender ILIKE 'female')::int AS opd_female,
           COUNT(*) FILTER (WHERE p.dob IS NOT NULL AND AGE(c.created_at, p.dob) < INTERVAL '1 year')::int AS opd_age_under1,
           COUNT(*) FILTER (WHERE p.dob IS NOT NULL AND AGE(c.created_at, p.dob) >= INTERVAL '1 year'  AND AGE(c.created_at, p.dob) < INTERVAL '5 years')::int  AS opd_age_1to4,
           COUNT(*) FILTER (WHERE p.dob IS NOT NULL AND AGE(c.created_at, p.dob) >= INTERVAL '5 years'  AND AGE(c.created_at, p.dob) < INTERVAL '15 years')::int AS opd_age_5to14,
           COUNT(*) FILTER (WHERE p.dob IS NOT NULL AND AGE(c.created_at, p.dob) >= INTERVAL '15 years' AND AGE(c.created_at, p.dob) < INTERVAL '18 years')::int AS opd_age_15to17,
           COUNT(*) FILTER (WHERE p.dob IS NOT NULL AND AGE(c.created_at, p.dob) >= INTERVAL '18 years' AND AGE(c.created_at, p.dob) < INTERVAL '50 years')::int AS opd_age_18to49,
           COUNT(*) FILTER (WHERE p.dob IS NOT NULL AND AGE(c.created_at, p.dob) >= INTERVAL '50 years' AND AGE(c.created_at, p.dob) < INTERVAL '60 years')::int AS opd_age_50to59,
           COUNT(*) FILTER (WHERE p.dob IS NOT NULL AND AGE(c.created_at, p.dob) >= INTERVAL '60 years')::int AS opd_age_60plus,
           COUNT(*) FILTER (
             WHERE NOT EXISTS (
               SELECT 1 FROM consultations c2
               WHERE c2.patient_id = c.patient_id AND c2.created_at < c.created_at
             )
           )::int AS opd_new_cases
         FROM consultations c
         JOIN patients p ON p.id = c.patient_id
         WHERE c.pharmacy_id = $1 AND c.created_at::date BETWEEN $2 AND $3`,
        [pharmacyId, start, end]
      );
      const opd = attendance.rows[0];
      opd.opd_reattendance = opd.opd_total_attendance - opd.opd_new_cases;

      const consumed = await query(
        `SELECT si.drug_name, SUM(si.quantity)::int AS quantity_consumed
         FROM sale_items si JOIN sales s ON s.id = si.sale_id
         WHERE s.pharmacy_id = $1 AND s.voided_at IS NULL AND s.created_at::date BETWEEN $2 AND $3
         GROUP BY si.drug_name`,
        [pharmacyId, start, end]
      );
      const stock = await query(`SELECT name AS drug_name, quantity AS closing_stock FROM drugs WHERE pharmacy_id = $1`, [pharmacyId]);

      const dataValues = [];
      const unconfigured = [];

      if (isConfigured(map.hmis105.orgUnit)) {
        for (const [key, def] of Object.entries(map.hmis105.dataElements)) {
          if (!isConfigured(def.id) || !isConfigured(def.coc)) { unconfigured.push(`hmis105.${key}`); continue; }
          const value = opd[key];
          if (value === undefined) continue;
          dataValues.push({ dataElement: def.id, categoryOptionCombo: def.coc, orgUnit: map.hmis105.orgUnit, period, value: String(value) });
        }
      } else {
        unconfigured.push('hmis105.orgUnit');
      }

      if (isConfigured(map.hmis106.orgUnit)) {
        const totalClosing = stock.rows.reduce((s, r) => s + r.closing_stock, 0);
        const totalConsumed = consumed.rows.reduce((s, r) => s + r.quantity_consumed, 0);
        const totals = { commodity_closing_stock: totalClosing, commodity_consumed: totalConsumed };

        for (const [key, def] of Object.entries(map.hmis106.dataElements)) {
          if (key === 'commodity_stockout_days') continue;
          if (!isConfigured(def.id) || !isConfigured(def.coc)) { unconfigured.push(`hmis106.${key}`); continue; }
          dataValues.push({ dataElement: def.id, categoryOptionCombo: def.coc, orgUnit: map.hmis106.orgUnit, period, value: String(totals[key]) });
        }

        for (const row of stock.rows) {
          const mapped = map.hmis106.drugMap[row.drug_name.toLowerCase()];
          if (mapped && isConfigured(mapped.id) && isConfigured(mapped.coc)) {
            dataValues.push({ dataElement: mapped.id, categoryOptionCombo: mapped.coc, orgUnit: map.hmis106.orgUnit, period, value: String(row.closing_stock) });
          }
        }
      } else {
        unconfigured.push('hmis106.orgUnit');
      }

      res.json({
        period,
        dataValueSet: { dataValues },
        unconfigured,
        readyToPush: unconfigured.length === 0,
        note: unconfigured.length
          ? 'This pharmacy has not configured all DHIS2 UIDs yet — go to DHIS2 Settings and fill in the missing org unit / data element / category option combo IDs from your own DHIS2 instance.'
          : 'All mapped elements are configured. POST dataValueSet to {your DHIS2 base_url}/api/dataValueSets to push (use this pharmacy\'s saved credentials).',
      });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });
};
