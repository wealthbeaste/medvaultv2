'use strict';
const err = require('./_err');

// ── VALID ROLES that can be assigned to staff ─────────────────────────────
// FIX: added 'pharmacist' and 'inventory_manager' to the allowed list.
// Previously these roles existed in the frontend UI dropdown but were never
// validated server-side, and—critically—were not in the PERMISSIONS map,
// so any user with those roles received 403 on every protected API call.
const VALID_STAFF_ROLES = ['manager', 'cashier', 'dispensor', 'pharmacist', 'inventory_manager', 'staff', 'doctor', 'nurse', 'lab_technician', 'receptionist'];

module.exports = function registerOrgRoutes(app, { query, pool, auth, can, validate, audit }) {

  // ─── BRANCHES ──────────────────────────────────────────────────────────────
  // Frontend calls /api/branches; backend model is "pharmacies".
  // Register both paths so existing and frontend code both work.

  async function listBranches(req, res) {
    const { orgId } = req.user;
    try {
      const result = await query(
        `SELECT p.id,p.name,p.address,p.phone,p.is_head_office,p.is_active,p.created_at,
                COUNT(DISTINCT u.id) as staff_count
         FROM pharmacies p
         LEFT JOIN users u ON u.pharmacy_id=p.id AND u.is_active=true
         WHERE p.organisation_id=$1
         GROUP BY p.id ORDER BY p.is_head_office DESC,p.name`,
        [orgId]
      );
      res.json({ pharmacies: result.rows, branches: result.rows });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  }

  async function createBranch(req, res) {
    const { orgId } = req.user;
    const { name, address, phone } = req.body;
    try {
      const dup = await query(
        `SELECT id FROM pharmacies WHERE organisation_id=$1 AND LOWER(name)=LOWER($2)`,
        [orgId, name.trim()]
      );
      if (dup.rows.length) return err(res, 409, 'DUPLICATE', `Branch "${name}" already exists`, 'name');

      const r = await query(
        `INSERT INTO pharmacies (organisation_id,name,address,phone,is_head_office)
         VALUES ($1,$2,$3,$4,false) RETURNING id,name,address,phone,is_head_office,is_active,created_at`,
        [orgId, name.trim(), address || null, phone || null]
      );
      await audit(query, { req, action: 'branch.create', entity: 'pharmacy', entityId: r.rows[0].id, payload: { name } });
      res.status(201).json({ message: `✅ Branch "${name}" created`, pharmacy: r.rows[0] });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  }

  const branchValidation = validate({ name: { required: true, type: 'string', minLen: 1, maxLen: 255 } });

  // Both paths work — frontend uses /api/branches, legacy uses /api/pharmacies
  app.get('/api/pharmacies',  auth, can('branches:read'),  listBranches);
  app.get('/api/branches',    auth, can('branches:read'),  listBranches);
  app.post('/api/pharmacies', auth, can('branches:write'), branchValidation, createBranch);
  app.post('/api/branches',   auth, can('branches:write'), branchValidation, createBranch);

  // ─── STOCK TRANSFERS ──────────────────────────────────────────────────────
  // Frontend calls /api/transfers for inter-branch stock transfers

  // GET /api/transfers — list all transfers for this org
  app.get('/api/transfers', auth, can('transfers:read'), async (req, res) => {
    const { orgId } = req.user;
    try {
      const result = await query(
        `SELECT st.*,
                fp.name as from_pharmacy_name,
                tp.name as to_pharmacy_name,
                ru.name as requested_by_name,
                au.name as approved_by_name
         FROM stock_transfers st
         LEFT JOIN pharmacies fp ON fp.id = st.from_pharmacy_id
         LEFT JOIN pharmacies tp ON tp.id = st.to_pharmacy_id
         LEFT JOIN users ru ON ru.id = st.requested_by
         LEFT JOIN users au ON au.id = st.approved_by
         WHERE st.organisation_id = $1
         ORDER BY st.created_at DESC
         LIMIT 100`,
        [orgId]
      );
      res.json({ transfers: result.rows });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // POST /api/transfers — request a new stock transfer
  app.post('/api/transfers', auth, can('transfers:request'), async (req, res) => {
    const { orgId, userId, pharmacyId } = req.user;
    const { from_pharmacy_id, to_pharmacy_id, drug_id, drug_name, quantity, notes } = req.body;

    if (!from_pharmacy_id || !to_pharmacy_id) return err(res, 400, 'VALIDATION_REQUIRED', 'Both from and to pharmacy are required');
    if (!drug_id || !drug_name) return err(res, 400, 'VALIDATION_REQUIRED', 'Drug is required');
    if (!quantity || quantity < 1) return err(res, 400, 'VALIDATION_REQUIRED', 'Quantity must be at least 1');

    try {
      // Verify both pharmacies belong to this org
      const check = await query(
        `SELECT id FROM pharmacies WHERE id IN ($1, $2) AND organisation_id = $3`,
        [from_pharmacy_id, to_pharmacy_id, orgId]
      );
      if (check.rows.length < 2) return err(res, 400, 'VALIDATION_INVALID', 'Both pharmacies must belong to your organisation');

      const result = await query(
        `INSERT INTO stock_transfers
           (organisation_id, from_pharmacy_id, to_pharmacy_id, drug_id, drug_name, quantity, status, requested_by, notes)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
         RETURNING *`,
        [orgId, from_pharmacy_id, to_pharmacy_id, drug_id, drug_name, parseInt(quantity), userId, notes || null]
      );
      await audit(query, {
        req, action: 'transfer.request', entity: 'stock_transfer', entityId: result.rows[0].id,
        payload: { drug_name, quantity, from_pharmacy_id, to_pharmacy_id },
      });
      res.status(201).json({ success: true, message: '✅ Transfer requested', transfer: result.rows[0] });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // PATCH /api/transfers/:id/approve — approve and execute a stock transfer
  app.patch('/api/transfers/:id/approve', auth, can('transfers:approve'), async (req, res) => {
    const { orgId, userId } = req.user;
    const { id } = req.params;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const tf = await client.query(
        `SELECT * FROM stock_transfers WHERE id = $1 AND organisation_id = $2 AND status = 'pending' FOR UPDATE`,
        [id, orgId]
      );
      if (!tf.rows.length) {
        await client.query('ROLLBACK');
        return err(res, 404, 'NOT_FOUND', 'Transfer not found or already processed');
      }
      const t = tf.rows[0];

      // Deduct from source pharmacy
      const src = await client.query(
        `UPDATE drugs SET quantity = GREATEST(0, quantity - $1), updated_at = NOW()
         WHERE id = $2 AND pharmacy_id = $3
         RETURNING quantity`,
        [t.quantity, t.drug_id, t.from_pharmacy_id]
      );

      // Add to destination pharmacy (find or create the drug record)
      const destDrug = await client.query(
        `SELECT id FROM drugs WHERE pharmacy_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
        [t.to_pharmacy_id, t.drug_name]
      );
      if (destDrug.rows.length) {
        await client.query(
          `UPDATE drugs SET quantity = quantity + $1, updated_at = NOW() WHERE id = $2`,
          [t.quantity, destDrug.rows[0].id]
        );
      } else {
        // Copy drug details from source
        const srcDrug = await client.query(`SELECT * FROM drugs WHERE id = $1`, [t.drug_id]);
        if (srcDrug.rows.length) {
          const d = srcDrug.rows[0];
          await client.query(
            `INSERT INTO drugs (pharmacy_id, name, generic_name, category, quantity, unit_price, cost_price, threshold, expiry_date, supplier, barcode, sku, requires_rx)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [t.to_pharmacy_id, d.name, d.generic_name, d.category, t.quantity, d.unit_price, d.cost_price, d.threshold, d.expiry_date, d.supplier, d.barcode, d.sku, d.requires_rx]
          );
        }
      }

      // Mark transfer as approved
      await client.query(
        `UPDATE stock_transfers SET status = 'approved', approved_by = $1 WHERE id = $2`,
        [userId, id]
      );

      await client.query('COMMIT');

      await audit(query, {
        req, action: 'transfer.approve', entity: 'stock_transfer', entityId: id,
        payload: { drug_name: t.drug_name, quantity: t.quantity },
      });
      res.json({ success: true, message: '✅ Transfer approved and stock moved' });
    } catch (e) {
      await client.query('ROLLBACK');
      return err(res, 500, 'SERVER_ERROR', e.message);
    } finally {
      client.release();
    }
  });

  // PATCH /api/transfers/:id/reject — reject a pending transfer
  app.patch('/api/transfers/:id/reject', auth, can('transfers:approve'), async (req, res) => {
    const { orgId, userId } = req.user;
    try {
      const r = await query(
        `UPDATE stock_transfers SET status = 'rejected', approved_by = $1
         WHERE id = $2 AND organisation_id = $3 AND status = 'pending'
         RETURNING *`,
        [userId, req.params.id, orgId]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Transfer not found or already processed');
      await audit(query, { req, action: 'transfer.reject', entity: 'stock_transfer', entityId: req.params.id, payload: null });
      res.json({ success: true, message: '✅ Transfer rejected' });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // GET /api/staff — list all staff in this organisation
  app.get('/api/staff', auth, async (req, res) => {
    const { orgId } = req.user;
    try {
      const result = await query(
        `SELECT u.id,u.name,u.email,u.role,u.is_active,u.created_at,p.name as pharmacy_name
         FROM users u LEFT JOIN pharmacies p ON p.id=u.pharmacy_id
         WHERE u.organisation_id=$1 ORDER BY u.created_at DESC`,
        [orgId]
      );
      res.json({ staff: result.rows });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // POST /api/staff/invite — create a new staff account
  app.post('/api/staff/invite', auth, can('staff:invite'), validate({
    name:     { required: true, type: 'string', minLen: 1, maxLen: 255 },
    email:    { required: true, type: 'string', minLen: 3, maxLen: 255 },
    password: { required: true, type: 'string', minLen: 6 },
  }), async (req, res) => {
    const { orgId, pharmacyId: ownerPharmacyId } = req.user;
    const { name, email, password, staffRole, pharmacyId } = req.body;
    if (!name)     return err(res, 400, 'VALIDATION_REQUIRED', 'Staff name is required', 'name');
    if (!email)    return err(res, 400, 'VALIDATION_REQUIRED', 'Email is required', 'email');
    if (!password) return err(res, 400, 'VALIDATION_REQUIRED', 'Password is required', 'password');

    // FIX: validate that the role being assigned is one we actually support
    const assignedRole = (staffRole || 'staff').toLowerCase();
    if (!VALID_STAFF_ROLES.includes(assignedRole)) {
      return err(res, 400, 'VALIDATION_INVALID_ROLE',
        `Invalid role "${staffRole}". Allowed: ${VALID_STAFF_ROLES.join(', ')}`, 'staffRole');
    }

    const { hash } = require('../core/password');
    try {
      const exists = await query(`SELECT id FROM users WHERE email=$1`, [email.toLowerCase()]);
      if (exists.rows.length) return err(res, 409, 'CONFLICT_EMAIL_EXISTS', 'Email already registered', 'email');
      const pw = await hash(password);

      // FIX: ensure the assigned pharmacy belongs to this organisation
      const assignedPharmacyId = pharmacyId || ownerPharmacyId;
      if (pharmacyId) {
        const pharmCheck = await query(
          `SELECT id FROM pharmacies WHERE id=$1 AND organisation_id=$2`,
          [pharmacyId, orgId]
        );
        if (!pharmCheck.rows.length) {
          return err(res, 400, 'VALIDATION_INVALID_PHARMACY',
            'The specified pharmacy does not belong to your organisation', 'pharmacyId');
        }
      }

      const result = await query(
        `INSERT INTO users (organisation_id,pharmacy_id,name,email,password_hash,role)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,name,email,role`,
        [orgId, assignedPharmacyId, name, email.toLowerCase(), pw, assignedRole]
      );
      await audit(query, {
        req, action: 'staff.invite', entity: 'user', entityId: result.rows[0].id,
        payload: { name, email: email.toLowerCase(), role: assignedRole },
      });
      res.json({ success: true, message: '✅ Staff member added!', user: result.rows[0] });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  app.patch('/api/staff/:id/deactivate', auth, async (req, res) => {
    const { orgId } = req.user;
    try {
      await query(`UPDATE users SET is_active=false WHERE id=$1 AND organisation_id=$2`, [req.params.id, orgId]);
      await audit(query, { req, action: 'staff.deactivate', entity: 'user', entityId: req.params.id, payload: null });
      res.json({ message: '✅ Deactivated' });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  app.patch('/api/staff/:id/activate', auth, async (req, res) => {
    const { orgId } = req.user;
    try {
      await query(`UPDATE users SET is_active=true WHERE id=$1 AND organisation_id=$2`, [req.params.id, orgId]);
      await audit(query, { req, action: 'staff.activate', entity: 'user', entityId: req.params.id, payload: null });
      res.json({ message: '✅ Reactivated' });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // PATCH /api/staff/:id/role — change a staff member's role
  app.patch('/api/staff/:id/role', auth, can('staff:invite'), async (req, res) => {
    const { orgId } = req.user;
    const { role } = req.body;
    if (!role) return err(res, 400, 'VALIDATION_REQUIRED', 'role is required', 'role');
    const normRole = role.toLowerCase();
    if (!VALID_STAFF_ROLES.includes(normRole)) {
      return err(res, 400, 'VALIDATION_INVALID_ROLE',
        `Invalid role "${role}". Allowed: ${VALID_STAFF_ROLES.join(', ')}`, 'role');
    }
    try {
      const r = await query(
        `UPDATE users SET role=$1 WHERE id=$2 AND organisation_id=$3 RETURNING id,name,email,role`,
        [normRole, req.params.id, orgId]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Staff member not found');
      await audit(query, { req, action: 'staff.role_change', entity: 'user', entityId: req.params.id, payload: { role: normRole } });
      res.json({ success: true, message: `✅ Role updated to ${normRole}`, user: r.rows[0] });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // PATCH /api/staff/:id/pharmacy — reassign a staff member to a different branch
  app.patch('/api/staff/:id/pharmacy', auth, can('staff:invite'), async (req, res) => {
    const { orgId } = req.user;
    const { pharmacyId } = req.body;
    if (!pharmacyId) return err(res, 400, 'VALIDATION_REQUIRED', 'pharmacyId is required', 'pharmacyId');
    try {
      const pharmCheck = await query(
        `SELECT id FROM pharmacies WHERE id=$1 AND organisation_id=$2`,
        [pharmacyId, orgId]
      );
      if (!pharmCheck.rows.length) {
        return err(res, 400, 'VALIDATION_INVALID_PHARMACY', 'Pharmacy does not belong to your organisation', 'pharmacyId');
      }
      const r = await query(
        `UPDATE users SET pharmacy_id=$1 WHERE id=$2 AND organisation_id=$3 RETURNING id,name,email,role,pharmacy_id`,
        [pharmacyId, req.params.id, orgId]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Staff member not found');
      await audit(query, { req, action: 'staff.pharmacy_change', entity: 'user', entityId: req.params.id, payload: { pharmacyId } });
      res.json({ success: true, message: '✅ Branch updated', user: r.rows[0] });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });
};
