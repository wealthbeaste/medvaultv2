'use strict';
// ============================================================
// EFRIS routes — URA e-invoicing via an accredited aggregator.
// Mirrors the dhis2.js pattern: per-pharmacy settings, encrypted
// credential storage, test-connection, and manual submission.
// ⚠️ See efris/client.js header — field names/endpoints are
// placeholders pending confirmed EFRISBuddy API docs.
// ============================================================
const err = require('./_err');
const { encrypt, decrypt } = require('../core/credsCrypto');
const { testConnection, buildInvoicePayload, submitInvoice } = require('../efris/client');

module.exports = function registerEfrisRoutes(app, { query, auth, can, audit }) {

  // ── Settings: read this pharmacy's EFRIS connection config ──
  app.get('/api/efris/settings', auth, can('settings:write'), async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    try {
      const r = await query(
        `SELECT provider, environment, client_id, tin, device_no, is_active, api_key_enc, updated_at
         FROM efris_settings WHERE pharmacy_id = $1`,
        [pharmacyId]
      );
      if (!r.rows.length) {
        return res.json({ configured: false, provider: 'efrisbuddy', environment: 'sandbox', client_id: null, tin: null, device_no: null, is_active: false, has_api_key: false });
      }
      const row = r.rows[0];
      res.json({
        configured: true,
        provider: row.provider,
        environment: row.environment,
        client_id: row.client_id,
        tin: row.tin,
        device_no: row.device_no,
        is_active: row.is_active,
        has_api_key: !!row.api_key_enc,
        updated_at: row.updated_at,
      });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ── Settings: save/update ──────────────────────────────────
  app.put('/api/efris/settings', auth, can('settings:write'), async (req, res) => {
    const { pharmacyId, userId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    const { provider, environment, api_key, client_id, tin, device_no, is_active } = req.body || {};

    try {
      const existing = await query(`SELECT api_key_enc FROM efris_settings WHERE pharmacy_id = $1`, [pharmacyId]);
      const apiKeyEnc = api_key ? encrypt(api_key) : (existing.rows[0]?.api_key_enc || null);

      await query(
        `INSERT INTO efris_settings (pharmacy_id, provider, environment, api_key_enc, client_id, tin, device_no, is_active, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
         ON CONFLICT (pharmacy_id) DO UPDATE SET
           provider = EXCLUDED.provider,
           environment = EXCLUDED.environment,
           api_key_enc = EXCLUDED.api_key_enc,
           client_id = EXCLUDED.client_id,
           tin = EXCLUDED.tin,
           device_no = EXCLUDED.device_no,
           is_active = EXCLUDED.is_active,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()`,
        [pharmacyId, provider || 'efrisbuddy', environment || 'sandbox', apiKeyEnc, client_id || null, tin || null, device_no || null, !!is_active, userId || null]
      );
      res.json({ success: true });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ── Test connection ────────────────────────────────────────
  app.post('/api/efris/test-connection', auth, can('settings:write'), async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    try {
      const row = await query(`SELECT environment, api_key_enc, client_id FROM efris_settings WHERE pharmacy_id = $1`, [pharmacyId]);
      if (!row.rows.length || !row.rows[0].api_key_enc) {
        return err(res, 400, 'VALIDATION_INVALID', 'Save your EFRIS API key in settings first.');
      }
      const { environment, api_key_enc, client_id } = row.rows[0];
      const api_key = decrypt(api_key_enc);
      const base_url = environment === 'production' ? 'https://api.efris.dev' : 'https://sandbox.efris.dev';
      const result = await testConnection({ base_url, api_key, client_id });
      res.json(result);
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ── Preview the invoice payload for a given sale (no submission) ──
  app.get('/api/efris/preview/:saleId', auth, can('settings:write'), async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const settingsRow = await query(`SELECT * FROM efris_settings WHERE pharmacy_id = $1`, [pharmacyId]);
      if (!settingsRow.rows.length) return err(res, 400, 'VALIDATION_INVALID', 'Configure EFRIS settings first.');
      const settings = settingsRow.rows[0];

      const saleRow = await query(`SELECT * FROM sales WHERE id = $1 AND pharmacy_id = $2`, [req.params.saleId, pharmacyId]);
      if (!saleRow.rows.length) return err(res, 404, 'NOT_FOUND', 'Sale not found.');
      const itemsRow = await query(`SELECT * FROM sale_items WHERE sale_id = $1`, [req.params.saleId]);

      const payload = buildInvoicePayload(saleRow.rows[0], itemsRow.rows, settings);
      res.json({ payload });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ── Submit a sale's invoice to EFRIS (manual trigger) ──────
  app.post('/api/efris/submit/:saleId', auth, can('settings:write'), async (req, res) => {
    const { pharmacyId, userId } = req.user;
    try {
      const already = await query(`SELECT id, status, fdn FROM efris_submissions WHERE sale_id = $1`, [req.params.saleId]);
      if (already.rows.length && already.rows[0].status === 'success') {
        return err(res, 400, 'VALIDATION_INVALID', 'This sale was already submitted to EFRIS (FDN: ' + already.rows[0].fdn + ').');
      }

      const settingsRow = await query(`SELECT * FROM efris_settings WHERE pharmacy_id = $1`, [pharmacyId]);
      if (!settingsRow.rows.length || !settingsRow.rows[0].api_key_enc) {
        return err(res, 400, 'VALIDATION_INVALID', 'Configure and save EFRIS settings (with API key) first.');
      }
      const settings = settingsRow.rows[0];
      const api_key = decrypt(settings.api_key_enc);
      const base_url = settings.environment === 'production' ? 'https://api.efris.dev' : 'https://sandbox.efris.dev';

      const saleRow = await query(`SELECT * FROM sales WHERE id = $1 AND pharmacy_id = $2`, [req.params.saleId, pharmacyId]);
      if (!saleRow.rows.length) return err(res, 404, 'NOT_FOUND', 'Sale not found.');
      const itemsRow = await query(`SELECT * FROM sale_items WHERE sale_id = $1`, [req.params.saleId]);

      const payload = buildInvoicePayload(saleRow.rows[0], itemsRow.rows, settings);
      const result = await submitInvoice({ base_url, api_key }, payload);

      await query(
        `INSERT INTO efris_submissions (pharmacy_id, sale_id, status, fdn, invoice_id, qr_code_url, request_payload, response_payload, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (sale_id) DO UPDATE SET
           status = EXCLUDED.status, fdn = EXCLUDED.fdn, invoice_id = EXCLUDED.invoice_id,
           qr_code_url = EXCLUDED.qr_code_url, request_payload = EXCLUDED.request_payload,
           response_payload = EXCLUDED.response_payload, error = EXCLUDED.error, created_at = NOW()`,
        [pharmacyId, req.params.saleId, result.success ? 'success' : 'failed', result.fdn || null,
         result.invoiceId || null, result.qrCodeUrl || null, JSON.stringify(payload), JSON.stringify(result.raw || {}), result.error || null]
      );

      if (audit) {
        await audit(query, { req, action: 'efris.submit', entity: 'efris_submission', entityId: req.params.saleId,
          payload: { success: result.success, fdn: result.fdn } });
      }

      if (!result.success) return err(res, 502, 'SERVER_ERROR', result.error || 'EFRIS submission failed.');
      res.json({ success: true, fdn: result.fdn, invoiceId: result.invoiceId, qrCodeUrl: result.qrCodeUrl });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ── Submission history ─────────────────────────────────────
  app.get('/api/efris/submissions', auth, can('settings:write'), async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const r = await query(
        `SELECT es.id, es.sale_id, s.receipt_number, es.status, es.fdn, es.qr_code_url, es.error, es.created_at
         FROM efris_submissions es LEFT JOIN sales s ON s.id = es.sale_id
         WHERE es.pharmacy_id = $1 ORDER BY es.created_at DESC LIMIT 100`,
        [pharmacyId]
      );
      res.json({ submissions: r.rows });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });
};
