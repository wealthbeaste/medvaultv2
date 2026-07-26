'use strict';
// ============================================================
// E-Prescriptions — portable, QR-coded prescriptions any pharmacy
// can fulfill, MedVault or not. See eprescription/pdfGenerator.js
// for the PDF/QR generation, and the public /rx/:code verify page
// (frontend/rx-verify.html) for non-MedVault pharmacy access.
// ============================================================
const err = require('./_err');
const { generateErxPdf } = require('../eprescription/pdfGenerator');

module.exports = function registerErxRoutes(app, { query, auth, can, audit, generateUniqueErxCode }) {
  const APP_URL = process.env.APP_URL || 'https://medvaultv3.vercel.app';

  // ── Create a new e-prescription (authenticated, issuing pharmacy) ──
  app.post('/api/erx', auth, can('patients:write'), async (req, res) => {
    const { pharmacyId, orgId, userId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    const b = req.body || {};
    if (!b.patient_display_name) return err(res, 400, 'VALIDATION_INVALID', 'patient_display_name is required.');
    if (!Array.isArray(b.items) || !b.items.length) return err(res, 400, 'VALIDATION_INVALID', 'At least one prescribed item is required.');

    try {
      const code = await generateUniqueErxCode();
      const r = await query(
        `INSERT INTO e_prescriptions (code, org_id, pharmacy_id, patient_id, prescription_id, patient_display_name,
           doctor_name, doctor_license_no, items, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [code, orgId, pharmacyId, b.patient_id || null, b.prescription_id || null, b.patient_display_name,
         b.doctor_name || null, b.doctor_license_no || null, JSON.stringify(b.items), userId || null]
      );
      if (audit) await audit(query, { req, action: 'erx.create', entity: 'e_prescription', entityId: r.rows[0].id, payload: { code } });
      res.json({ success: true, prescription: r.rows[0], verifyUrl: `${APP_URL}/rx/${code}` });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ── List this pharmacy's issued e-prescriptions ──────────
  app.get('/api/erx', auth, can('patients:read'), async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const r = await query(
        `SELECT * FROM e_prescriptions WHERE pharmacy_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [pharmacyId]
      );
      res.json({ prescriptions: r.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ── Authenticated detail view (issuing pharmacy staff) ────
  app.get('/api/erx/:id', auth, can('patients:read'), async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const r = await query(`SELECT * FROM e_prescriptions WHERE id = $1 AND pharmacy_id = $2`, [req.params.id, pharmacyId]);
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Prescription not found.');
      res.json({ prescription: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ── PDF download (issuing pharmacy staff) ─────────────────
  app.get('/api/erx/:id/pdf', auth, can('patients:read'), async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const r = await query(
        `SELECT rx.*, p.name AS pharmacy_name FROM e_prescriptions rx
         JOIN pharmacies p ON p.id = rx.pharmacy_id WHERE rx.id = $1 AND rx.pharmacy_id = $2`,
        [req.params.id, pharmacyId]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Prescription not found.');
      const rx = r.rows[0];

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${rx.code}.pdf"`);
      const doc = await generateErxPdf(rx, rx.pharmacy_name, APP_URL);
      doc.pipe(res);
      doc.end();
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ═══════════════════════════════════════════════════════════
  // PUBLIC ROUTES — no auth. Lets a non-MedVault pharmacy (or the
  // patient themselves) verify and fulfill a prescription by code.
  // Deliberately returns LIMITED data — no full patient identity
  // beyond the display name already meant to be shown on the printout.
  // ═══════════════════════════════════════════════════════════

  app.get('/api/public/erx/:code', async (req, res) => {
    try {
      const r = await query(
        `SELECT rx.code, rx.patient_display_name, rx.doctor_name, rx.doctor_license_no, rx.items,
                rx.status, rx.issued_at, rx.expires_at, p.name AS issuing_pharmacy
         FROM e_prescriptions rx JOIN pharmacies p ON p.id = rx.pharmacy_id
         WHERE rx.code = $1`,
        [req.params.code]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Prescription code not found.');
      const rx = r.rows[0];
      const isExpired = new Date(rx.expires_at) < new Date();
      res.json({ prescription: rx, isExpired });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // Record a fulfillment — works for MedVault pharmacies (send a Bearer
  // token to also link fulfilling_pharmacy_id) and non-MedVault ones
  // (send fulfilling_pharmacy_name as free text instead).
  app.post('/api/public/erx/:code/fulfill', async (req, res) => {
    const b = req.body || {};
    if (!Array.isArray(b.fulfilled_items) || !b.fulfilled_items.length) {
      return err(res, 400, 'VALIDATION_INVALID', 'fulfilled_items is required.');
    }
    try {
      const rxRow = await query(`SELECT id, status FROM e_prescriptions WHERE code = $1`, [req.params.code]);
      if (!rxRow.rows.length) return err(res, 404, 'NOT_FOUND', 'Prescription code not found.');
      const rx = rxRow.rows[0];
      if (rx.status === 'filled') return err(res, 400, 'VALIDATION_INVALID', 'This prescription has already been fully filled.');

      // Optional auth — if a valid MedVault token is present, link the fulfilling pharmacy properly.
      let fulfillingPharmacyId = null, fulfilledBy = null;
      const authHeader = req.headers['authorization'];
      if (authHeader) {
        try {
          const { verify } = require('../core/jwt');
          const decoded = verify(authHeader.split(' ')[1]);
          fulfillingPharmacyId = decoded.pharmacyId || null;
          fulfilledBy = decoded.userId || null;
        } catch (e) { /* invalid/missing token — proceed as external, non-MedVault fulfillment */ }
      }

      await query(
        `INSERT INTO e_prescription_fulfillments (e_prescription_id, fulfilling_pharmacy_id, fulfilling_pharmacy_name, fulfilled_items, sale_id, fulfilled_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [rx.id, fulfillingPharmacyId, b.fulfilling_pharmacy_name || null, JSON.stringify(b.fulfilled_items), b.sale_id || null, fulfilledBy]
      );

      const newStatus = b.fully_filled ? 'filled' : 'partially_filled';
      await query(`UPDATE e_prescriptions SET status = $1 WHERE id = $2`, [newStatus, rx.id]);

      res.json({ success: true, status: newStatus });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });
};
