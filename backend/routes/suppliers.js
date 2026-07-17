'use strict';
const err = require('./_err');

module.exports = function registerSuppliersAndNotificationsRoutes(app, { query, auth, can, validate, schemas, audit }) {

  // ── SUPPLIERS ────────────────────────────────────────────
  // Suppliers are PLATFORM-WIDE — every pharmacy sees all active suppliers
  // so they can place purchase orders and you earn commission.
  // Only the org that owns a supplier (or a super_admin) can edit/delete it.

  // GET /api/suppliers — ALL active platform suppliers, visible to every pharmacy
  app.get('/api/suppliers', auth, async (req, res) => {
    try {
      const result = await query(
        `SELECT s.id, s.name, s.contact_name, s.phone, s.email,
                s.address, s.payment_terms, s.notes,
                s.org_id, s.is_active, s.created_at,
                COUNT(d.id) AS drug_count
         FROM suppliers s
         LEFT JOIN drugs d ON d.supplier_id = s.id
         WHERE s.is_active = true
         GROUP BY s.id
         ORDER BY s.name ASC`
      );
      res.json({ suppliers: result.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/suppliers/:id — any pharmacy can view; drugs scoped to their pharmacy
  app.get('/api/suppliers/:id', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const [supplier, drugs] = await Promise.all([
        query(`SELECT * FROM suppliers WHERE id=$1 AND is_active=true`, [req.params.id]),
        query(
          `SELECT id,name,quantity,unit_price,expiry_date
           FROM drugs WHERE supplier_id=$1 AND pharmacy_id=$2 ORDER BY name`,
          [req.params.id, pharmacyId]
        ),
      ]);
      if (!supplier.rows.length) return res.status(404).json({ error: 'Supplier not found' });
      res.json({ supplier: supplier.rows[0], drugs: drugs.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/suppliers — add a platform supplier (admin/owner only)
  app.post('/api/suppliers', auth, can('inventory:write'), validate(schemas.supplier), async (req, res) => {
    const { orgId, pharmacyId } = req.user;
    const { name, contact_name, phone, email, address, notes, payment_terms } = req.body;
    try {
      const result = await query(
        `INSERT INTO suppliers (org_id,pharmacy_id,name,contact_name,phone,email,address,payment_terms,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [orgId, pharmacyId, name.trim(), contact_name || null, phone || null,
         email || null, address || null, payment_terms || null, notes || null]
      );
      await audit(query, { req, action: 'supplier.create', entity: 'supplier',
        entityId: result.rows[0].id, payload: { name: name.trim() } });
      res.status(201).json({ message: '✅ Supplier added!', supplier: result.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PUT /api/suppliers/:id — only the owning org or super_admin can edit
  app.put('/api/suppliers/:id', auth, can('inventory:write'), validate(schemas.supplier), async (req, res) => {
    const { orgId, role } = req.user;
    const { name, contact_name, phone, email, address, notes, payment_terms } = req.body;
    // super_admin can edit any supplier; others only their own org's
    const orgFilter = role === 'super_admin' ? 'TRUE' : `org_id = ${parseInt(orgId)}`;
    try {
      const result = await query(
        `UPDATE suppliers
         SET name=$1,contact_name=$2,phone=$3,email=$4,address=$5,
             payment_terms=$6,notes=$7,updated_at=NOW()
         WHERE id=$8 AND ${orgFilter} RETURNING *`,
        [name.trim(), contact_name || null, phone || null, email || null,
         address || null, payment_terms || null, notes || null, req.params.id]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Supplier not found or not authorised' });
      await audit(query, { req, action: 'supplier.update', entity: 'supplier',
        entityId: req.params.id, payload: { name: name.trim() } });
      res.json({ message: '✅ Supplier updated!', supplier: result.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // DELETE /api/suppliers/:id — only the owning org or super_admin can deactivate
  app.delete('/api/suppliers/:id', auth, can('inventory:write'), async (req, res) => {
    const { orgId, role } = req.user;
    const orgFilter = role === 'super_admin' ? 'TRUE' : `org_id = ${parseInt(orgId)}`;
    try {
      const result = await query(
        `UPDATE suppliers SET is_active=false,updated_at=NOW()
         WHERE id=$1 AND ${orgFilter} RETURNING id,name`,
        [req.params.id]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Supplier not found or not authorised' });
      await audit(query, { req, action: 'supplier.delete', entity: 'supplier',
        entityId: req.params.id, payload: { name: result.rows[0].name } });
      res.json({ message: '✅ Supplier removed!' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PATCH /api/suppliers/:id/assign-drug — link a drug to a supplier (any pharmacy, their own drugs)
  app.patch('/api/suppliers/:id/assign-drug', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const { drug_id } = req.body;
    if (!drug_id) return res.status(400).json({ error: 'drug_id is required' });
    try {
      await query(
        `UPDATE drugs SET supplier_id=$1 WHERE id=$2 AND pharmacy_id=$3`,
        [req.params.id, drug_id, pharmacyId]
      );
      res.json({ message: '✅ Drug linked to supplier!' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── NOTIFICATIONS ────────────────────────────────────────

  app.get('/api/notifications', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const result = await query(
        `SELECT id,type,title,body,data,is_read,created_at
         FROM notifications WHERE pharmacy_id=$1 ORDER BY created_at DESC LIMIT 50`,
        [pharmacyId]
      );
      const unread = result.rows.filter(n => !n.is_read).length;
      res.json({ notifications: result.rows, unread_count: unread });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  app.patch('/api/notifications/:id/read', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      await query(
        `UPDATE notifications SET is_read=true WHERE id=$1 AND pharmacy_id=$2`,
        [req.params.id, pharmacyId]
      );
      res.json({ success: true });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  app.post('/api/notifications/read-all', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      await query(
        `UPDATE notifications SET is_read=true WHERE pharmacy_id=$1 AND is_read=false`,
        [pharmacyId]
      );
      res.json({ success: true });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });
};
