'use strict';
const err = require('./_err');
const { generateAdrPdf } = require('../pharmacovigilance/pdfGenerator');

module.exports = function registerPharmacovigilanceRoutes(app, { query, auth, can, audit, getNextAdrNumber }) {

  // ── List reports for this pharmacy ──────────────────────
  app.get('/api/adr/reports', auth, can('reports:moh'), async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    try {
      const r = await query(
        `SELECT id, report_number, report_type, seriousness, product_type, patient_initials,
                reaction_description, status, created_at
         FROM adr_reports WHERE pharmacy_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [pharmacyId]
      );
      res.json({ reports: r.rows });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ── Get single report ─────────────────────────────────────
  app.get('/api/adr/reports/:id', auth, can('reports:moh'), async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const r = await query(`SELECT * FROM adr_reports WHERE id = $1 AND pharmacy_id = $2`, [req.params.id, pharmacyId]);
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Report not found.');
      res.json({ report: r.rows[0] });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ── Create/save a report (draft or submitted) ─────────────
  app.post('/api/adr/reports', auth, can('reports:moh'), async (req, res) => {
    const { pharmacyId, userId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    const b = req.body || {};

    try {
      const reportNumber = await getNextAdrNumber(pharmacyId);
      const r = await query(
        `INSERT INTO adr_reports (
           pharmacy_id, report_number, report_type, seriousness, product_type,
           patient_initials, patient_gender, patient_weight_kg, pregnancy_status,
           patient_dob, patient_age_at_onset, medical_history, medicines,
           reaction_description, onset_date, onset_time, stopped_date, lab_results,
           seriousness_reason, action_taken, outcome, causality,
           reporter_name, reporter_contact, reporter_designation, institution, district,
           status, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
         RETURNING *`,
        [
          pharmacyId, reportNumber, b.report_type || 'initial', b.seriousness || 'not_serious', b.product_type || 'drug',
          b.patient_initials || null, b.patient_gender || null, b.patient_weight_kg || null, b.pregnancy_status || null,
          b.patient_dob || null, b.patient_age_at_onset || null, b.medical_history || null, JSON.stringify(b.medicines || []),
          b.reaction_description || null, b.onset_date || null, b.onset_time || null, b.stopped_date || null, b.lab_results || null,
          JSON.stringify(b.seriousness_reason || []), b.action_taken || null, b.outcome || null, b.causality || null,
          b.reporter_name || null, b.reporter_contact || null, b.reporter_designation || null, b.institution || null, b.district || null,
          b.status || 'draft', userId || null,
        ]
      );

      if (audit) {
        await audit(query, { req, action: 'adr.create', entity: 'adr_report', entityId: r.rows[0].id,
          payload: { report_number: reportNumber, status: r.rows[0].status } });
      }

      res.json({ success: true, report: r.rows[0] });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ── Update a report (edit draft, mark submitted, etc.) ────
  app.put('/api/adr/reports/:id', auth, can('reports:moh'), async (req, res) => {
    const { pharmacyId } = req.user;
    const b = req.body || {};
    try {
      const existing = await query(`SELECT id FROM adr_reports WHERE id = $1 AND pharmacy_id = $2`, [req.params.id, pharmacyId]);
      if (!existing.rows.length) return err(res, 404, 'NOT_FOUND', 'Report not found.');

      const r = await query(
        `UPDATE adr_reports SET
           report_type=$1, seriousness=$2, product_type=$3, patient_initials=$4, patient_gender=$5,
           patient_weight_kg=$6, pregnancy_status=$7, patient_dob=$8, patient_age_at_onset=$9, medical_history=$10,
           medicines=$11, reaction_description=$12, onset_date=$13, onset_time=$14, stopped_date=$15, lab_results=$16,
           seriousness_reason=$17, action_taken=$18, outcome=$19, causality=$20, reporter_name=$21, reporter_contact=$22,
           reporter_designation=$23, institution=$24, district=$25, status=$26, updated_at=NOW()
         WHERE id = $27 AND pharmacy_id = $28 RETURNING *`,
        [
          b.report_type || 'initial', b.seriousness || 'not_serious', b.product_type || 'drug',
          b.patient_initials || null, b.patient_gender || null, b.patient_weight_kg || null, b.pregnancy_status || null,
          b.patient_dob || null, b.patient_age_at_onset || null, b.medical_history || null, JSON.stringify(b.medicines || []),
          b.reaction_description || null, b.onset_date || null, b.onset_time || null, b.stopped_date || null, b.lab_results || null,
          JSON.stringify(b.seriousness_reason || []), b.action_taken || null, b.outcome || null, b.causality || null,
          b.reporter_name || null, b.reporter_contact || null, b.reporter_designation || null, b.institution || null, b.district || null,
          b.status || 'draft', req.params.id, pharmacyId,
        ]
      );
      res.json({ success: true, report: r.rows[0] });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ── Delete a draft ──────────────────────────────────────
  app.delete('/api/adr/reports/:id', auth, can('reports:moh'), async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      await query(`DELETE FROM adr_reports WHERE id = $1 AND pharmacy_id = $2 AND status = 'draft'`, [req.params.id, pharmacyId]);
      res.json({ success: true });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ── Generate the official NDA-format PDF ──────────────────
  app.get('/api/adr/reports/:id/pdf', auth, can('reports:moh'), async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const r = await query(
        `SELECT ar.*, p.name AS pharmacy_name FROM adr_reports ar
         JOIN pharmacies p ON p.id = ar.pharmacy_id
         WHERE ar.id = $1 AND ar.pharmacy_id = $2`,
        [req.params.id, pharmacyId]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Report not found.');
      const report = r.rows[0];

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="ADR-${report.report_number || report.id}.pdf"`);

      const doc = generateAdrPdf(report, report.pharmacy_name);
      doc.pipe(res);
      doc.end();
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });
};
