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
//
// Payload-building and submission logic live in dhis2/dhis2Service.js
// so the scheduler (automated monthly submission + retries) shares
// the exact same code path as these manual routes.
// ============================================================
const err = require('./_err');
const { encrypt, decrypt } = require('../core/credsCrypto');
const { testConnection, pushDataValueSet } = require('../dhis2/client');
const { buildDataValueSet } = require('../dhis2/dhis2Service');
const { validateIndicators } = require('../dhis2/validator');

function resolvePeriod(req) {
  const now = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  return { start: req.query.start || firstOfMonth, end: req.query.end || today };
}


module.exports = function registerDhis2Routes(app, { query, auth, can, audit }) {

  // ── Phase 1 — static module list (kept for backward compat) ──
  app.get('/api/dhis2/reports', (req, res) => {
    res.json({ modules: ['HMIS105', 'HMIS106', 'DHIS2 Export', 'NDW Export'] });
  });

  // ── Settings: read this pharmacy's DHIS2 connection config ──
  app.get('/api/dhis2/settings', auth, can('reports:moh'), async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    try {
      const r = await query(`SELECT base_url, username, org_unit_uid, district, element_map, is_active, password_enc, updated_at
                              FROM dhis2_settings WHERE pharmacy_id = $1`, [pharmacyId]);
      if (!r.rows.length) {
        return res.json({ configured: false, base_url: null, username: null, org_unit_uid: null, district: null, element_map: {}, is_active: false, has_password: false });
      }
      const row = r.rows[0];
      res.json({
        configured: true,
        base_url: row.base_url,
        username: row.username,
        org_unit_uid: row.org_unit_uid,
        district: row.district,
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
    const { base_url, username, password, org_unit_uid, district, element_map, is_active } = req.body || {};

    if (base_url && !/^https?:\/\//i.test(base_url)) {
      return err(res, 400, 'VALIDATION_INVALID', 'base_url must start with http:// or https://', 'base_url');
    }

    try {
      const existing = await query(`SELECT password_enc FROM dhis2_settings WHERE pharmacy_id = $1`, [pharmacyId]);
      const passwordEnc = password ? encrypt(password) : (existing.rows[0]?.password_enc || null);

      await query(
        `INSERT INTO dhis2_settings (pharmacy_id, base_url, username, password_enc, org_unit_uid, district, element_map, is_active, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
         ON CONFLICT (pharmacy_id) DO UPDATE SET
           base_url = EXCLUDED.base_url,
           username = EXCLUDED.username,
           password_enc = EXCLUDED.password_enc,
           org_unit_uid = EXCLUDED.org_unit_uid,
           district = EXCLUDED.district,
           element_map = EXCLUDED.element_map,
           is_active = EXCLUDED.is_active,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()`,
        [pharmacyId, base_url || null, username || null, passwordEnc, org_unit_uid || null, district || null,
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

  // ── DHIS2-compatible dataValueSet export — PREVIEW ONLY (uses this pharmacy's own settings) ──
  app.get('/api/dhis2/export', auth, can('reports:moh'), async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    const { start, end } = resolvePeriod(req);

    try {
      const built = await buildDataValueSet(query, pharmacyId, start, end);
      res.json({
        ...built,
        note: built.unconfigured.length
          ? 'This pharmacy has not configured all DHIS2 UIDs yet — go to DHIS2 Settings and fill in the missing org unit / data element / category option combo IDs from your own DHIS2 instance.'
          : 'All mapped elements are configured. Use "Push to DHIS2" to submit this payload, or POST it yourself to {your DHIS2 base_url}/api/dataValueSets.',
      });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ── DHIS2-compatible dataValueSet export — CSV ────────────
  // Same underlying payload as GET /export, flattened to one row per
  // data value for spreadsheet review / manual upload to DHIS2's
  // "Import/Export" CSV importer.
  app.get('/api/dhis2/export/csv', auth, can('reports:moh'), async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    const { start, end } = resolvePeriod(req);

    try {
      const built = await buildDataValueSet(query, pharmacyId, start, end);
      const header = ['dataElement', 'period', 'orgUnit', 'categoryOptionCombo', 'value'];
      const escape = (v) => {
        const s = String(v ?? '');
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const rows = built.dataValueSet.dataValues.map(dv =>
        [dv.dataElement, dv.period, dv.orgUnit, dv.categoryOptionCombo, dv.value].map(escape).join(',')
      );
      const csv = [header.join(','), ...rows].join('\n');

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="dhis2-export-${built.period}.csv"`);
      res.send(csv);
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ── NDW (National Data Warehouse) export — standard indicator codes ──
  // Unlike GET /export, this doesn't depend on a pharmacy's DHIS2 UID
  // configuration at all — NDW feeds are typically keyed by standard
  // indicator codes, not instance-specific data element UIDs. Runs
  // through dhis2/validator.js first so obvious data gaps are visible
  // before submission rather than after a national reviewer notices.
  app.get('/api/dhis2/export/ndw', auth, can('reports:moh'), async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    const { start, end } = resolvePeriod(req);
    const period = start.slice(0, 7).replace('-', '');

    try {
      const facilityRow = await query(
        `SELECT p.id, p.name, p.address, s.org_unit_uid, s.district
         FROM pharmacies p LEFT JOIN dhis2_settings s ON s.pharmacy_id = p.id
         WHERE p.id = $1`,
        [pharmacyId]
      );
      const facility = facilityRow.rows[0] || {};

      const attendance = await query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE p.gender ILIKE 'male')::int   AS male,
           COUNT(*) FILTER (WHERE p.gender ILIKE 'female')::int AS female,
           COUNT(*) FILTER (WHERE p.dob IS NOT NULL AND AGE(c.created_at, p.dob) < INTERVAL '5 years')::int AS under5,
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
      const opd = attendance.rows[0];
      const reattendance = opd.total - opd.new_cases;

      const consumed = await query(
        `SELECT COALESCE(SUM(si.quantity), 0)::int AS total
         FROM sale_items si JOIN sales s ON s.id = si.sale_id
         WHERE s.pharmacy_id = $1 AND s.voided_at IS NULL AND s.created_at::date BETWEEN $2 AND $3`,
        [pharmacyId, start, end]
      );
      const stock = await query(
        `SELECT COUNT(*)::int AS total_drugs, COUNT(*) FILTER (WHERE quantity <= 0)::int AS stocked_out,
                COALESCE(SUM(quantity), 0)::int AS closing_stock
         FROM drugs WHERE pharmacy_id = $1`,
        [pharmacyId]
      );
      const st = stock.rows[0];
      const stockoutRate = st.total_drugs > 0 ? Math.round((st.stocked_out / st.total_drugs) * 1000) / 10 : 0;

      const indicators = [
        { code: 'OPD_ATTENDANCE_TOTAL',        label: 'Total OPD Attendance',        value: opd.total },
        { code: 'OPD_ATTENDANCE_NEW_CASES',    label: 'New Cases',                   value: opd.new_cases },
        { code: 'OPD_ATTENDANCE_REATTENDANCE', label: 'Re-attendance',               value: reattendance },
        { code: 'OPD_ATTENDANCE_MALE',         label: 'Attendance — Male',           value: opd.male },
        { code: 'OPD_ATTENDANCE_FEMALE',       label: 'Attendance — Female',         value: opd.female },
        { code: 'OPD_ATTENDANCE_UNDER5',       label: 'Attendance — Under 5yrs',     value: opd.under5 },
        { code: 'COMMODITY_CLOSING_STOCK',     label: 'Total Closing Stock (units)', value: st.closing_stock },
        { code: 'COMMODITY_CONSUMED',          label: 'Total Consumed (units)',      value: consumed.rows[0].total },
        { code: 'COMMODITY_STOCKOUT_RATE',     label: 'Stockout Rate (%)',           value: stockoutRate },
      ];

      const validation = validateIndicators(indicators);

      res.json({
        source: 'MedVault',
        facility: {
          id: facility.id,
          name: facility.name,
          address: facility.address || null,
          district: facility.district || null,
          orgUnitUid: facility.org_unit_uid || null,
        },
        period: { code: period, start, end },
        indicators,
        validation,
      });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ── Test this pharmacy's saved DHIS2 connection ──────────
  app.post('/api/dhis2/test-connection', auth, can('reports:moh'), async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    try {
      const row = await query(`SELECT base_url, username, password_enc FROM dhis2_settings WHERE pharmacy_id = $1`, [pharmacyId]);
      if (!row.rows.length || !row.rows[0].base_url) {
        return err(res, 400, 'VALIDATION_INVALID', 'Save your DHIS2 base URL, username, and password in settings first.');
      }
      const { base_url, username, password_enc } = row.rows[0];
      const password = decrypt(password_enc);
      if (!password) {
        return err(res, 400, 'VALIDATION_INVALID', 'No password saved for this connection yet.');
      }
      const result = await testConnection({ base_url, username, password });
      res.json(result);
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ── Push this period's report to DHIS2 ───────────────────
  app.post('/api/dhis2/push', auth, can('reports:moh'), async (req, res) => {
    const { pharmacyId, userId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    const { start, end } = resolvePeriod(req);

    try {
      const settingsRow = await query(`SELECT base_url, username, password_enc FROM dhis2_settings WHERE pharmacy_id = $1`, [pharmacyId]);
      if (!settingsRow.rows.length || !settingsRow.rows[0].base_url) {
        return err(res, 400, 'VALIDATION_INVALID', 'Save your DHIS2 base URL, username, and password in settings first.');
      }
      const { base_url, username, password_enc } = settingsRow.rows[0];
      const password = decrypt(password_enc);
      if (!password) {
        return err(res, 400, 'VALIDATION_INVALID', 'No password saved for this connection yet.');
      }

      const built = await buildDataValueSet(query, pharmacyId, start, end);
      if (!built.readyToPush) {
        return err(res, 400, 'VALIDATION_INVALID',
          'Not all DHIS2 UIDs are configured yet: ' + built.unconfigured.join(', ') + '. Fill these in under DHIS2 Settings before pushing.');
      }
      if (!built.dataValueSet.dataValues.length) {
        return err(res, 400, 'VALIDATION_INVALID', 'Nothing to push — no data values were generated for this period.');
      }

      const result = await pushDataValueSet({ base_url, username, password }, built.dataValueSet);

      await query(
        `INSERT INTO dhis2_push_log (pharmacy_id, period, success, value_count, imported, updated_count, ignored, error, pushed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [pharmacyId, built.period, !!result.success, built.dataValueSet.dataValues.length,
         result.imported || 0, result.updated || 0, result.ignored || 0, result.error || null, userId || null]
      );

      if (audit) {
        await audit(query, { req, action: 'dhis2.push', entity: 'dhis2_push', entityId: null,
          payload: { period: built.period, success: result.success, imported: result.imported, updated: result.updated } });
      }

      if (!result.success) {
        return err(res, 502, 'SERVER_ERROR', result.error || 'DHIS2 rejected the push.');
      }
      res.json({ success: true, period: built.period, imported: result.imported, updated: result.updated, ignored: result.ignored });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ── Analytics — trends for the DHIS2 dashboard ────────────
  // months: how many calendar months back to include (default 6, max 24).
  app.get('/api/dhis2/analytics', auth, can('reports:moh'), async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 6, 1), 24);

    try {
      // Medicine consumption trend — real historical data from sales.
      const consumption = await query(
        `SELECT to_char(date_trunc('month', s.created_at), 'YYYY-MM') AS month,
                COALESCE(SUM(si.quantity), 0)::int AS quantity_dispensed
         FROM sales s JOIN sale_items si ON si.sale_id = s.id
         WHERE s.pharmacy_id = $1 AND s.voided_at IS NULL
           AND s.created_at >= date_trunc('month', NOW()) - ($2 || ' months')::interval
         GROUP BY 1 ORDER BY 1`,
        [pharmacyId, months - 1]
      );

      // Disease / diagnosis patterns — top 5 diagnoses per month, real data from consultations.
      const diagnoses = await query(
        `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month, diagnosis, COUNT(*)::int AS count
         FROM consultations
         WHERE pharmacy_id = $1
           AND created_at >= date_trunc('month', NOW()) - ($2 || ' months')::interval
           AND diagnosis IS NOT NULL AND TRIM(diagnosis) <> ''
         GROUP BY 1, 2 ORDER BY 1, count DESC`,
        [pharmacyId, months - 1]
      );
      const diseaseTrend = {};
      for (const row of diagnoses.rows) {
        if (!diseaseTrend[row.month]) diseaseTrend[row.month] = [];
        if (diseaseTrend[row.month].length < 5) diseaseTrend[row.month].push({ diagnosis: row.diagnosis, count: row.count });
      }

      // Stockout trend — only as far back as dhis2_stock_snapshots has been
      // running (see jobs/scheduler.js: writeDhis2StockSnapshots). MedVault
      // never tracked historical stock levels before this, so early months
      // may be empty — that's expected, not a bug.
      const stockout = await query(
        `SELECT snapshot_date, total_drugs, stocked_out_count
         FROM dhis2_stock_snapshots
         WHERE pharmacy_id = $1 AND snapshot_date >= (NOW() - ($2 || ' months')::interval)::date
         ORDER BY snapshot_date`,
        [pharmacyId, months]
      );

      // Facility performance summary — OPD attendance this month vs last
      // month, and on-time DHIS2 reporting rate (submitted within the
      // first 5 days of the following month, per dhis2_push_log).
      const attendanceByMonth = await query(
        `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month, COUNT(*)::int AS attendance
         FROM consultations
         WHERE pharmacy_id = $1 AND created_at >= date_trunc('month', NOW()) - INTERVAL '1 month'
         GROUP BY 1 ORDER BY 1`,
        [pharmacyId]
      );
      const submissionRate = await query(
        `SELECT period,
                MIN(created_at) FILTER (WHERE success) AS first_success_at
         FROM dhis2_push_log
         WHERE pharmacy_id = $1 AND success = true
         GROUP BY period
         ORDER BY period DESC LIMIT 12`,
        [pharmacyId]
      );
      const onTime = submissionRate.rows.filter(r => {
        const y = Number(r.period.slice(0, 4)), m = Number(r.period.slice(4, 6));
        const deadline = new Date(y, m, 5); // 5th of the month following the reporting period
        return new Date(r.first_success_at) <= deadline;
      }).length;

      res.json({
        months,
        consumptionTrend: consumption.rows,
        diseaseTrend,
        stockoutTrend: stockout.rows,
        stockoutTrendNote: stockout.rows.length
          ? null
          : 'No stock-history data yet — daily snapshots started recently, so the trend will fill in over the coming days.',
        facilityPerformance: {
          attendanceByMonth: attendanceByMonth.rows,
          reportsSubmittedLast12Periods: submissionRate.rows.length,
          reportsOnTimeLast12Periods: onTime,
        },
      });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ── Push history for this pharmacy ───────────────────────
  app.get('/api/dhis2/push-history', auth, can('reports:moh'), async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    try {
      const r = await query(
        `SELECT period, success, value_count, imported, updated_count, ignored, error, created_at
         FROM dhis2_push_log WHERE pharmacy_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [pharmacyId]
      );

      // A failed row is "queued for retry" (rather than permanently failed) if:
      //  - no later row for the same period succeeded, and
      //  - fewer than 3 total attempts have been logged for that period.
      // This mirrors the cap used by jobs/scheduler.js's retryFailedDhis2Submissions,
      // so what the user sees here always matches what the background job will do next.
      const attemptCounts = {}, everSucceeded = {};
      for (const row of r.rows) {
        attemptCounts[row.period] = (attemptCounts[row.period] || 0) + 1;
        if (row.success) everSucceeded[row.period] = true;
      }
      const history = r.rows.map(row => ({
        ...row,
        status: row.success
          ? 'success'
          : (everSucceeded[row.period] ? 'failed_then_recovered'
              : (attemptCounts[row.period] < 3 ? 'queued_for_retry' : 'failed_permanently')),
      }));

      res.json({ history });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });
};
