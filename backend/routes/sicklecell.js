const err = require('./_err');
// ============================================================
// SICKLE CELL SCREENING — paid add-on module
// Covers both newborn and community screening. Gated behind
// subscriptions.modules->>'sicklecell' via requireModule
// (see middleware/moduleAccess.js) — orgs without the add-on
// get a clean 403 rather than silent access.
// ============================================================
module.exports = function registerSicklecellRoutes(app, { query, auth, can, audit, requireModule }) {
  const gate = requireModule('sicklecell');

  app.get('/api/sicklecell/screenings', auth, can('patients:read'), gate, async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    try {
      const r = await query(
        `SELECT sc.*, p.name AS patient_name, p.patient_number
         FROM sicklecell_screenings sc JOIN patients p ON p.id = sc.patient_id
         WHERE sc.pharmacy_id = $1 ORDER BY sc.screening_date DESC LIMIT 200`,
        [pharmacyId]
      );
      res.json({ screenings: r.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/sicklecell/screenings', auth, can('patients:write'), gate, async (req, res) => {
    const { pharmacyId, orgId, userId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    const b = req.body || {};
    if (!b.patient_id) return err(res, 400, 'VALIDATION_INVALID', 'patient_id is required.');
    try {
      const r = await query(
        `INSERT INTO sicklecell_screenings (org_id, pharmacy_id, patient_id, screening_type, screening_date, test_method,
           genotype_result, symptomatic, family_history, counseling_given, referred_for_management, referral_facility,
           follow_up_date, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [orgId, pharmacyId, b.patient_id, b.screening_type || 'community',
         b.screening_date || new Date().toISOString().slice(0, 10), b.test_method || null,
         b.genotype_result || null, !!b.symptomatic, b.family_history || null, !!b.counseling_given,
         !!b.referred_for_management, b.referral_facility || null, b.follow_up_date || null,
         b.notes || null, userId || null]
      );
      if (audit) await audit(query, { req, action: 'sicklecell.screen', entity: 'sicklecell_screening', entityId: r.rows[0].id, payload: {} });
      res.json({ success: true, screening: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.put('/api/sicklecell/screenings/:id', auth, can('patients:write'), gate, async (req, res) => {
    const { pharmacyId } = req.user;
    const b = req.body || {};
    try {
      const r = await query(
        `UPDATE sicklecell_screenings SET test_method=$1, genotype_result=$2, symptomatic=$3, family_history=$4,
           counseling_given=$5, referred_for_management=$6, referral_facility=$7, follow_up_date=$8, notes=$9, updated_at=NOW()
         WHERE id=$10 AND pharmacy_id=$11 RETURNING *`,
        [b.test_method || null, b.genotype_result || null, !!b.symptomatic, b.family_history || null,
         !!b.counseling_given, !!b.referred_for_management, b.referral_facility || null, b.follow_up_date || null,
         b.notes || null, req.params.id, pharmacyId]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Screening not found.');
      res.json({ success: true, screening: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });
};
