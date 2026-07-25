'use strict';
const err = require('./_err');

// ============================================================
// DHIS2 PHASE 4 — HIV/ART, PMTCT, TB program data entry.
// This is the data-capture layer feeding the national ART Cohort,
// PMTCT, and TB DHIS2/NDW exports. Reuses patients/consultations
// from the clinic module; nothing here duplicates that schema.
// ============================================================

module.exports = function registerHivTbRoutes(app, { query, auth, can, audit }) {

  // ═══════════════════════════════════════════════════════════
  // ART ENROLLMENTS
  // ═══════════════════════════════════════════════════════════

  app.get('/api/hiv/art-enrollments', auth, can('patients:read'), async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    try {
      const r = await query(
        `SELECT ae.*, p.name AS patient_name, p.patient_number
         FROM art_enrollments ae JOIN patients p ON p.id = ae.patient_id
         WHERE ae.pharmacy_id = $1 ORDER BY ae.created_at DESC LIMIT 200`,
        [pharmacyId]
      );
      res.json({ enrollments: r.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/hiv/art-enrollments', auth, can('patients:write'), async (req, res) => {
    const { pharmacyId, orgId, userId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    const b = req.body || {};
    if (!b.patient_id || !b.start_date) return err(res, 400, 'VALIDATION_INVALID', 'patient_id and start_date are required.');
    try {
      const r = await query(
        `INSERT INTO art_enrollments (org_id, pharmacy_id, patient_id, art_number, regimen, regimen_line, start_date, status, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [orgId, pharmacyId, b.patient_id, b.art_number || null, b.regimen || null, b.regimen_line || 'first_line',
         b.start_date, b.status || 'active', b.notes || null, userId || null]
      );
      if (audit) await audit(query, { req, action: 'art.enroll', entity: 'art_enrollment', entityId: r.rows[0].id, payload: {} });
      res.json({ success: true, enrollment: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.put('/api/hiv/art-enrollments/:id', auth, can('patients:write'), async (req, res) => {
    const { pharmacyId } = req.user;
    const b = req.body || {};
    try {
      const r = await query(
        `UPDATE art_enrollments SET regimen=$1, regimen_line=$2, status=$3, status_date=$4, transfer_facility=$5, notes=$6, updated_at=NOW()
         WHERE id=$7 AND pharmacy_id=$8 RETURNING *`,
        [b.regimen || null, b.regimen_line || 'first_line', b.status || 'active', b.status_date || null,
         b.transfer_facility || null, b.notes || null, req.params.id, pharmacyId]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Enrollment not found.');
      res.json({ success: true, enrollment: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ═══════════════════════════════════════════════════════════
  // VIRAL LOAD RESULTS
  // ═══════════════════════════════════════════════════════════

  app.get('/api/hiv/viral-load/:enrollmentId', auth, can('patients:read'), async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const r = await query(
        `SELECT * FROM viral_load_results WHERE art_enrollment_id = $1 AND pharmacy_id = $2 ORDER BY sample_date DESC`,
        [req.params.enrollmentId, pharmacyId]
      );
      res.json({ results: r.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/hiv/viral-load', auth, can('patients:write'), async (req, res) => {
    const { pharmacyId, userId } = req.user;
    const b = req.body || {};
    if (!b.art_enrollment_id || !b.sample_date) return err(res, 400, 'VALIDATION_INVALID', 'art_enrollment_id and sample_date are required.');
    try {
      const isSuppressed = b.copies_per_ml != null ? Number(b.copies_per_ml) < 1000 : null;
      const r = await query(
        `INSERT INTO viral_load_results (art_enrollment_id, pharmacy_id, lab_result_id, sample_date, result_date, copies_per_ml, is_suppressed, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [b.art_enrollment_id, pharmacyId, b.lab_result_id || null, b.sample_date, b.result_date || null,
         b.copies_per_ml ?? null, b.is_suppressed ?? isSuppressed, b.notes || null, userId || null]
      );
      res.json({ success: true, result: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ═══════════════════════════════════════════════════════════
  // PMTCT ENROLLMENTS
  // ═══════════════════════════════════════════════════════════

  app.get('/api/pmtct/enrollments', auth, can('patients:read'), async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const r = await query(
        `SELECT pe.*, p.name AS mother_name FROM pmtct_enrollments pe
         JOIN patients p ON p.id = pe.mother_patient_id
         WHERE pe.pharmacy_id = $1 ORDER BY pe.created_at DESC LIMIT 200`,
        [pharmacyId]
      );
      res.json({ enrollments: r.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/pmtct/enrollments', auth, can('patients:write'), async (req, res) => {
    const { pharmacyId, orgId, userId } = req.user;
    const b = req.body || {};
    if (!b.mother_patient_id) return err(res, 400, 'VALIDATION_INVALID', 'mother_patient_id is required.');
    try {
      const r = await query(
        `INSERT INTO pmtct_enrollments (org_id, pharmacy_id, mother_patient_id, hiv_status, art_enrollment_id, lmp_date, edd_date, status, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [orgId, pharmacyId, b.mother_patient_id, b.hiv_status || null, b.art_enrollment_id || null,
         b.lmp_date || null, b.edd_date || null, b.status || 'active', b.notes || null, userId || null]
      );
      res.json({ success: true, enrollment: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.put('/api/pmtct/enrollments/:id', auth, can('patients:write'), async (req, res) => {
    const { pharmacyId } = req.user;
    const b = req.body || {};
    try {
      const r = await query(
        `UPDATE pmtct_enrollments SET infant_patient_id=$1, delivery_date=$2, infant_prophylaxis=$3,
           infant_test_result=$4, status=$5, notes=$6 WHERE id=$7 AND pharmacy_id=$8 RETURNING *`,
        [b.infant_patient_id || null, b.delivery_date || null, b.infant_prophylaxis || null,
         b.infant_test_result || null, b.status || 'active', b.notes || null, req.params.id, pharmacyId]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'PMTCT enrollment not found.');
      res.json({ success: true, enrollment: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ═══════════════════════════════════════════════════════════
  // TB SCREENINGS
  // ═══════════════════════════════════════════════════════════

  app.get('/api/tb/screenings', auth, can('patients:read'), async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const r = await query(
        `SELECT ts.*, p.name AS patient_name FROM tb_screenings ts
         JOIN patients p ON p.id = ts.patient_id
         WHERE ts.pharmacy_id = $1 ORDER BY ts.screening_date DESC LIMIT 200`,
        [pharmacyId]
      );
      res.json({ screenings: r.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/tb/screenings', auth, can('patients:write'), async (req, res) => {
    const { pharmacyId, orgId, userId } = req.user;
    const b = req.body || {};
    if (!b.patient_id) return err(res, 400, 'VALIDATION_INVALID', 'patient_id is required.');
    try {
      const r = await query(
        `INSERT INTO tb_screenings (org_id, pharmacy_id, patient_id, consultation_id, screening_date, symptoms,
           presumptive_tb, referred_for_test, test_result, treatment_started, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [orgId, pharmacyId, b.patient_id, b.consultation_id || null, b.screening_date || new Date().toISOString().slice(0, 10),
         JSON.stringify(b.symptoms || []), !!b.presumptive_tb, !!b.referred_for_test, b.test_result || null,
         !!b.treatment_started, b.notes || null, userId || null]
      );
      res.json({ success: true, screening: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.put('/api/tb/screenings/:id', auth, can('patients:write'), async (req, res) => {
    const { pharmacyId } = req.user;
    const b = req.body || {};
    try {
      const r = await query(
        `UPDATE tb_screenings SET test_result=$1, treatment_started=$2, notes=$3 WHERE id=$4 AND pharmacy_id=$5 RETURNING *`,
        [b.test_result || null, !!b.treatment_started, b.notes || null, req.params.id, pharmacyId]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Screening not found.');
      res.json({ success: true, screening: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });
};
