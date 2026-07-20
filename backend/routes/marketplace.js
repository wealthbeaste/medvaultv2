'use strict';
const err = require('./_err');

// ============================================================
// MedVault Marketplace — Supplier Portal API
// ============================================================
// Auth model:
//   Suppliers get their OWN JWT where role = 'supplier'
//   and supplierId is embedded in the token.
//   They are NOT users in the users table — they are rows
//   in marketplace_suppliers and authenticate via
//   their own email + password_hash columns.
//
// Routes:
//   POST /api/marketplace/supplier/register
//   POST /api/marketplace/supplier/login
//   GET  /api/marketplace/supplier/me          (supplier auth)
//   GET  /api/marketplace/supplier/products    (supplier auth)
//   POST /api/marketplace/supplier/products    (supplier auth)
//   PUT  /api/marketplace/supplier/products/:id(supplier auth)
//   DELETE /api/marketplace/supplier/products/:id (supplier auth)
//   GET  /api/marketplace/supplier/orders      (supplier auth)
//   PATCH /api/marketplace/supplier/orders/:id/status (supplier auth)
//
//   POST /api/marketplace/orders               (pharmacy auth) — place order
//   GET  /api/marketplace/orders               (pharmacy auth) — own orders
//
//   GET  /api/admin/marketplace/suppliers      (super_admin)
//   POST /api/admin/marketplace/suppliers/:id/approve  (super_admin)
//   POST /api/admin/marketplace/suppliers/:id/reject   (super_admin)
//   POST /api/admin/marketplace/suppliers/:id/suspend  (super_admin)
//   GET  /api/admin/marketplace/products       (super_admin)
//   GET  /api/admin/marketplace/orders         (super_admin)
// ============================================================

module.exports = function registerMarketplaceRoutes(app, { query, hash, compare, sign, auth, can, rateLimit }) {

  const adminOnly    = can('admin:platform');
  const supplierAuth = _supplierAuth(sign);  // separate middleware

  // ── helper: verify supplier token ──────────────────────────
  function _supplierAuth(sign) {
    const { verify } = require('../core/jwt');
    return function(req, res, next) {
      const header = req.headers['authorization'];
      const token  = header && header.split(' ')[1];
      if (!token) return err(res, 401, 'AUTH_NO_TOKEN', 'No token. Please log in.');
      try {
        const payload = verify(token);
        if (payload.role !== 'supplier') return err(res, 403, 'AUTH_FORBIDDEN', 'Not a supplier token.');
        req.supplier = payload;  // { supplierId, email, role }
        next();
      } catch(e) {
        return err(res, 403, 'AUTH_INVALID_TOKEN', 'Invalid or expired token.');
      }
    };
  }

  // ──────────────────────────────────────────────────────────
  // PUBLIC: Register as a marketplace supplier
  // POST /api/marketplace/supplier/register
  // ──────────────────────────────────────────────────────────
  // ── PUBLIC endpoints (no auth required) ──────────────────

  // GET /api/marketplace/public/stats — hero numbers shown to all pharmacies
  app.get('/api/marketplace/public/stats', async (req, res) => {
    try {
      const [suppliers, products] = await Promise.all([
        query(`SELECT COUNT(*) AS cnt FROM marketplace_suppliers WHERE status='approved'`),
        query(`SELECT COUNT(*) AS cnt FROM marketplace_products mp
               JOIN marketplace_suppliers ms ON ms.id=mp.supplier_id
               WHERE ms.status='approved' AND mp.is_active=true`),
      ]);
      res.json({
        supplierCount: parseInt(suppliers.rows[0].cnt),
        productCount:  parseInt(products.rows[0].cnt),
      });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // GET /api/marketplace/public/suppliers — approved suppliers + their products
  app.get('/api/marketplace/public/suppliers', async (req, res) => {
    try {
      const suppliersRes = await query(
        `SELECT ms.id, ms.business_name AS company_name, ms.supplier_type,
                ms.contact_name, ms.phone, ms.email,
                ms.address, ms.commission_rate, ms.verified_at,
                COUNT(mp.id) AS product_count
         FROM marketplace_suppliers ms
         LEFT JOIN marketplace_products mp ON mp.supplier_id=ms.id AND mp.is_active=true
         WHERE ms.status='approved'
         GROUP BY ms.id
         ORDER BY ms.verified_at DESC`
      );
      res.json({ suppliers: suppliersRes.rows, total: suppliersRes.rowCount });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // GET /api/marketplace/public/suppliers/:id/products — ALL active brands/products
  // for one approved supplier. Paginated + searchable so the Marketplace "Browse"
  // button can show a supplier's full catalogue without loading everything at once.
  // Query params: page (default 1), limit (default 24, max 100), search (optional)
  app.get('/api/marketplace/public/suppliers/:id/products', async (req, res) => {
    try {
      const supplierId = parseInt(req.params.id);
      if (!supplierId) return err(res, 400, 'VALIDATION_INVALID', 'Invalid supplier id', 'id');

      const page   = Math.max(parseInt(req.query.page)  || 1, 1);
      const limit  = Math.min(Math.max(parseInt(req.query.limit) || 24, 1), 100);
      const offset = (page - 1) * limit;
      const search = (req.query.search || '').trim();

      // Only expose products for suppliers that are publicly approved
      const supRes = await query(
        `SELECT id, business_name AS name, supplier_type FROM marketplace_suppliers
         WHERE id = $1 AND status = 'approved'`,
        [supplierId]
      );
      if (!supRes.rows.length) return err(res, 404, 'NOT_FOUND_SUPPLIER', 'Supplier not found');

      const params = [supplierId];
      let searchClause = '';
      if (search) {
        params.push(`%${search}%`);
        searchClause = ` AND (name ILIKE $${params.length} OR generic_name ILIKE $${params.length} OR category ILIKE $${params.length})`;
      }

      const countRes = await query(
        `SELECT COUNT(*) AS cnt FROM marketplace_products
         WHERE supplier_id = $1 AND is_active = true${searchClause}`,
        params
      );
      const total = parseInt(countRes.rows[0].cnt) || 0;

      params.push(limit, offset);
      const productsRes = await query(
        `SELECT id, name, generic_name, category, unit, pack_size, wholesale_price,
                min_order_qty, stock_qty, description, image_url, requires_rx
         FROM marketplace_products
         WHERE supplier_id = $1 AND is_active = true${searchClause}
         ORDER BY name ASC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );

      res.json({
        supplier:   supRes.rows[0],
        products:   productsRes.rows,
        total,
        page,
        limit,
        totalPages: Math.max(Math.ceil(total / limit), 1),
      });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ─────────────────────────────────────────────────────────

  app.post('/api/marketplace/supplier/register',
    rateLimit({ max: 5, windowMs: 60 * 60 * 1000, message: 'Too many registrations. Try again in 1 hour.' }),
    async (req, res) => {
      const { business_name, supplier_type, contact_name, phone, email, password,
              registration_number, nda_permit, address } = req.body;

      if (!business_name)  return err(res, 400, 'VALIDATION_REQUIRED', 'Business name is required', 'business_name');
      if (!supplier_type)  return err(res, 400, 'VALIDATION_REQUIRED', 'Supplier type is required', 'supplier_type');
      if (!contact_name)   return err(res, 400, 'VALIDATION_REQUIRED', 'Contact name is required', 'contact_name');
      if (!phone)          return err(res, 400, 'VALIDATION_REQUIRED', 'Phone is required', 'phone');
      if (!email)          return err(res, 400, 'VALIDATION_REQUIRED', 'Email is required', 'email');
      if (!password || password.length < 6) return err(res, 400, 'VALIDATION_REQUIRED', 'Password must be at least 6 characters', 'password');

      const validTypes = ['manufacturer', 'importer', 'distributor'];
      if (!validTypes.includes(supplier_type)) return err(res, 400, 'VALIDATION_INVALID', 'supplier_type must be manufacturer, importer, or distributor', 'supplier_type');

      try {
        const exists = await query('SELECT id FROM marketplace_suppliers WHERE email=$1', [email.toLowerCase()]);
        if (exists.rows.length) return err(res, 409, 'CONFLICT_EMAIL_EXISTS', 'Email already registered. Please log in.', 'email');

        const pwHash = await hash(password);

        const result = await query(
          `INSERT INTO marketplace_suppliers
             (business_name, supplier_type, contact_name, phone, email, password_hash,
              registration_number, nda_permit, address, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
           RETURNING id, business_name, supplier_type, contact_name, phone, email, status, created_at`,
          [business_name.trim(), supplier_type, contact_name.trim(),
           phone.trim(), email.toLowerCase(), pwHash,
           registration_number || null, nda_permit || null, address || null]
        );

        const supplier = result.rows[0];

        // Create a trial subscription
        await query(
          `INSERT INTO supplier_subscriptions (supplier_id, plan, amount_ugx, status)
           VALUES ($1, 'basic', 200000, 'trial')`,
          [supplier.id]
        );

        res.status(201).json({
          success: true,
          message: '✅ Application submitted! A MedVault admin will review and approve your account within 2 business days.',
          supplier: {
            id: supplier.id,
            business_name: supplier.business_name,
            status: supplier.status,
          },
        });
      } catch(e) {
        return err(res, 500, 'SERVER_ERROR', 'Registration failed: ' + e.message);
      }
    }
  );

  // ──────────────────────────────────────────────────────────
  // PUBLIC: Supplier login
  // POST /api/marketplace/supplier/login
  // ──────────────────────────────────────────────────────────
  app.post('/api/marketplace/supplier/login',
    rateLimit({ max: 10, windowMs: 15 * 60 * 1000, message: 'Too many login attempts. Try again in 15 minutes.' }),
    async (req, res) => {
      const { email, password } = req.body;
      if (!email)    return err(res, 400, 'VALIDATION_REQUIRED', 'Email is required', 'email');
      if (!password) return err(res, 400, 'VALIDATION_REQUIRED', 'Password is required', 'password');

      try {
        const result = await query(
          `SELECT id, business_name, supplier_type, contact_name, phone, email,
                  password_hash, status, rejection_reason, commission_rate
           FROM marketplace_suppliers
           WHERE email = $1`,
          [email.toLowerCase()]
        );

        if (!result.rows.length) return err(res, 401, 'AUTH_NOT_FOUND', 'No supplier account found with this email.', 'email');

        const supplier = result.rows[0];

        if (supplier.status === 'rejected') {
          return err(res, 403, 'AUTH_REJECTED',
            `Your application was rejected. Reason: ${supplier.rejection_reason || 'See admin for details.'}. Please contact support@medvault.ug.`
          );
        }
        if (supplier.status === 'suspended') {
          return err(res, 403, 'AUTH_SUSPENDED', 'Your supplier account has been suspended. Contact support@medvault.ug.');
        }

        const valid = await compare(password, supplier.password_hash);
        if (!valid) return err(res, 401, 'AUTH_BAD_PASSWORD', 'Incorrect password.', 'password');

        const token = sign(
          { supplierId: supplier.id, email: supplier.email, role: 'supplier' },
          30  // 30 days
        );

        res.json({
          token,
          supplier: {
            id:              supplier.id,
            business_name:   supplier.business_name,
            supplier_type:   supplier.supplier_type,
            contact_name:    supplier.contact_name,
            phone:           supplier.phone,
            email:           supplier.email,
            status:          supplier.status,
            commission_rate: supplier.commission_rate,
          },
        });
      } catch(e) {
        return err(res, 500, 'SERVER_ERROR', 'Login failed: ' + e.message);
      }
    }
  );

  // ──────────────────────────────────────────────────────────
  // SUPPLIER: Get own profile
  // GET /api/marketplace/supplier/me
  // ──────────────────────────────────────────────────────────
  app.get('/api/marketplace/supplier/me', supplierAuth, async (req, res) => {
    try {
      const result = await query(
        `SELECT ms.id, ms.business_name, ms.supplier_type, ms.contact_name, ms.phone,
                ms.email, ms.address, ms.registration_number, ms.nda_permit,
                ms.status, ms.rejection_reason, ms.commission_rate,
                ms.verified_at, ms.created_at,
                ss.plan AS sub_plan, ss.status AS sub_status, ss.trial_ends_at,
                (SELECT COUNT(*) FROM marketplace_products WHERE supplier_id=ms.id AND is_active=true) AS product_count,
                (SELECT COUNT(*) FROM marketplace_orders WHERE supplier_id=ms.id) AS order_count,
                (SELECT COALESCE(SUM(total_amount),0) FROM marketplace_orders WHERE supplier_id=ms.id AND status='delivered') AS total_revenue
         FROM marketplace_suppliers ms
         LEFT JOIN supplier_subscriptions ss ON ss.supplier_id = ms.id
         WHERE ms.id = $1
         ORDER BY ss.created_at DESC LIMIT 1`,
        [req.supplier.supplierId]
      );
      if (!result.rows.length) return err(res, 404, 'NOT_FOUND_SUPPLIER', 'Supplier not found');
      res.json({ supplier: result.rows[0] });
    } catch(e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ──────────────────────────────────────────────────────────
  // SUPPLIER: List own products
  // GET /api/marketplace/supplier/products
  // ──────────────────────────────────────────────────────────
  app.get('/api/marketplace/supplier/products', supplierAuth, async (req, res) => {
    try {
      const result = await query(
        `SELECT id, name, generic_name, category, unit, pack_size, wholesale_price,
                min_order_qty, stock_qty, description, requires_rx, is_active, created_at, updated_at
         FROM marketplace_products
         WHERE supplier_id = $1
         ORDER BY name ASC`,
        [req.supplier.supplierId]
      );
      res.json({ products: result.rows });
    } catch(e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ──────────────────────────────────────────────────────────
  // SUPPLIER: Add a product (only if approved)
  // POST /api/marketplace/supplier/products
  // ──────────────────────────────────────────────────────────
  app.post('/api/marketplace/supplier/products', supplierAuth, async (req, res) => {
    const { name, generic_name, category, unit, pack_size, wholesale_price,
            min_order_qty, stock_qty, description, requires_rx } = req.body;

    if (!name)            return err(res, 400, 'VALIDATION_REQUIRED', 'Product name is required', 'name');
    if (!wholesale_price) return err(res, 400, 'VALIDATION_REQUIRED', 'Wholesale price is required', 'wholesale_price');

    try {
      // Ensure supplier is approved
      const sup = await query('SELECT status FROM marketplace_suppliers WHERE id=$1', [req.supplier.supplierId]);
      if (!sup.rows.length)                return err(res, 404, 'NOT_FOUND_SUPPLIER', 'Supplier not found');
      if (sup.rows[0].status !== 'approved') return err(res, 403, 'AUTH_FORBIDDEN', 'Your account must be approved before listing products.');

      const result = await query(
        `INSERT INTO marketplace_products
           (supplier_id, name, generic_name, category, unit, pack_size, wholesale_price,
            min_order_qty, stock_qty, description, requires_rx)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          req.supplier.supplierId,
          name.trim(),
          generic_name  || null,
          category      || 'General',
          unit          || 'Pack',
          parseInt(pack_size)     || 1,
          parseFloat(wholesale_price),
          parseInt(min_order_qty) || 1,
          parseInt(stock_qty)     || 0,
          description   || null,
          requires_rx === true || requires_rx === 'true',
        ]
      );
      res.status(201).json({ success: true, product: result.rows[0] });
    } catch(e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ──────────────────────────────────────────────────────────
  // SUPPLIER: Update a product
  // PUT /api/marketplace/supplier/products/:id
  // ──────────────────────────────────────────────────────────
  app.put('/api/marketplace/supplier/products/:id', supplierAuth, async (req, res) => {
    const { name, generic_name, category, unit, pack_size, wholesale_price,
            min_order_qty, stock_qty, description, requires_rx, is_active } = req.body;

    if (!name)            return err(res, 400, 'VALIDATION_REQUIRED', 'Product name is required', 'name');
    if (!wholesale_price) return err(res, 400, 'VALIDATION_REQUIRED', 'Wholesale price is required', 'wholesale_price');

    try {
      const result = await query(
        `UPDATE marketplace_products SET
           name=$1, generic_name=$2, category=$3, unit=$4, pack_size=$5,
           wholesale_price=$6, min_order_qty=$7, stock_qty=$8, description=$9,
           requires_rx=$10, is_active=$11, updated_at=NOW()
         WHERE id=$12 AND supplier_id=$13
         RETURNING *`,
        [
          name.trim(), generic_name || null, category || 'General',
          unit || 'Pack', parseInt(pack_size) || 1,
          parseFloat(wholesale_price), parseInt(min_order_qty) || 1,
          parseInt(stock_qty) || 0, description || null,
          requires_rx === true || requires_rx === 'true',
          is_active !== false,
          req.params.id, req.supplier.supplierId,
        ]
      );
      if (!result.rows.length) return err(res, 404, 'NOT_FOUND_PRODUCT', 'Product not found or not yours');
      res.json({ success: true, product: result.rows[0] });
    } catch(e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ──────────────────────────────────────────────────────────
  // SUPPLIER: Delete (deactivate) a product
  // DELETE /api/marketplace/supplier/products/:id
  // ──────────────────────────────────────────────────────────
  app.delete('/api/marketplace/supplier/products/:id', supplierAuth, async (req, res) => {
    try {
      const result = await query(
        `UPDATE marketplace_products SET is_active=false, updated_at=NOW()
         WHERE id=$1 AND supplier_id=$2 RETURNING id`,
        [req.params.id, req.supplier.supplierId]
      );
      if (!result.rows.length) return err(res, 404, 'NOT_FOUND_PRODUCT', 'Product not found or not yours');
      res.json({ success: true });
    } catch(e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ──────────────────────────────────────────────────────────
  // SUPPLIER: Update password
  // POST /api/marketplace/supplier/change-password
  // ──────────────────────────────────────────────────────────
  app.post('/api/marketplace/supplier/change-password', supplierAuth, async (req, res) => {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return err(res, 400, 'VALIDATION_REQUIRED', 'Both current and new password are required');
    if (new_password.length < 6) return err(res, 400, 'VALIDATION_INVALID', 'New password must be at least 6 characters');
    try {
      const sup = await query('SELECT password_hash FROM marketplace_suppliers WHERE id=$1', [req.supplier.supplierId]);
      if (!sup.rows.length) return err(res, 404, 'NOT_FOUND_SUPPLIER', 'Supplier not found');
      const valid = await compare(current_password, sup.rows[0].password_hash);
      if (!valid) return err(res, 401, 'AUTH_BAD_PASSWORD', 'Current password is incorrect', 'current_password');
      const pwHash = await hash(new_password);
      await query('UPDATE marketplace_suppliers SET password_hash=$1, updated_at=NOW() WHERE id=$2', [pwHash, req.supplier.supplierId]);
      res.json({ success: true, message: 'Password updated.' });
    } catch(e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ══════════════════════════════════════════════════════════
  // SUPER ADMIN — Marketplace management
  // ══════════════════════════════════════════════════════════

  // GET /api/admin/marketplace/suppliers
  app.get('/api/admin/marketplace/suppliers', auth, adminOnly, async (req, res) => {
    try {
      const result = await query(
        `SELECT ms.id, ms.business_name, ms.supplier_type, ms.contact_name,
                ms.phone, ms.email, ms.address, ms.registration_number, ms.nda_permit,
                ms.status, ms.rejection_reason, ms.commission_rate,
                ms.verified_at, ms.created_at, ms.updated_at,
                u.name AS verified_by_name,
                ss.plan AS sub_plan, ss.status AS sub_status, ss.trial_ends_at,
                (SELECT COUNT(*) FROM marketplace_products mp WHERE mp.supplier_id=ms.id AND mp.is_active=true) AS product_count,
                (SELECT COUNT(*) FROM marketplace_orders mo WHERE mo.supplier_id=ms.id) AS order_count,
                (SELECT COALESCE(SUM(total_amount),0) FROM marketplace_orders mo WHERE mo.supplier_id=ms.id AND mo.status='delivered') AS total_revenue
         FROM marketplace_suppliers ms
         LEFT JOIN users u ON u.id = ms.verified_by
         LEFT JOIN supplier_subscriptions ss ON ss.supplier_id = ms.id
         ORDER BY
           CASE ms.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 WHEN 'suspended' THEN 2 WHEN 'rejected' THEN 3 END,
           ms.created_at DESC`,
        []
      );
      res.json({ suppliers: result.rows });
    } catch(e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // POST /api/admin/marketplace/suppliers/:id/approve
  app.post('/api/admin/marketplace/suppliers/:id/approve', auth, adminOnly, async (req, res) => {
    const { commission_rate } = req.body;
    try {
      const result = await query(
        `UPDATE marketplace_suppliers SET
           status='approved', rejection_reason=NULL,
           commission_rate=COALESCE($1, commission_rate),
           verified_at=NOW(), verified_by=$2, updated_at=NOW()
         WHERE id=$3 RETURNING id, business_name, email`,
        [commission_rate ? parseFloat(commission_rate) : null, req.user.userId, req.params.id]
      );
      if (!result.rows.length) return err(res, 404, 'NOT_FOUND_SUPPLIER', 'Supplier not found');
      res.json({ success: true, supplier: result.rows[0] });
    } catch(e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // POST /api/admin/marketplace/suppliers/:id/reject
  app.post('/api/admin/marketplace/suppliers/:id/reject', auth, adminOnly, async (req, res) => {
    const { reason } = req.body;
    if (!reason) return err(res, 400, 'VALIDATION_REQUIRED', 'Rejection reason is required', 'reason');
    try {
      const result = await query(
        `UPDATE marketplace_suppliers SET
           status='rejected', rejection_reason=$1, updated_at=NOW()
         WHERE id=$2 RETURNING id, business_name, email`,
        [reason.trim(), req.params.id]
      );
      if (!result.rows.length) return err(res, 404, 'NOT_FOUND_SUPPLIER', 'Supplier not found');
      res.json({ success: true, supplier: result.rows[0] });
    } catch(e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // POST /api/admin/marketplace/suppliers/:id/suspend
  app.post('/api/admin/marketplace/suppliers/:id/suspend', auth, adminOnly, async (req, res) => {
    try {
      const result = await query(
        `UPDATE marketplace_suppliers SET status='suspended', updated_at=NOW()
         WHERE id=$1 RETURNING id, business_name`,
        [req.params.id]
      );
      if (!result.rows.length) return err(res, 404, 'NOT_FOUND_SUPPLIER', 'Supplier not found');
      res.json({ success: true });
    } catch(e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // POST /api/admin/marketplace/suppliers/:id/unsuspend
  app.post('/api/admin/marketplace/suppliers/:id/unsuspend', auth, adminOnly, async (req, res) => {
    try {
      const result = await query(
        `UPDATE marketplace_suppliers SET status='approved', updated_at=NOW()
         WHERE id=$1 RETURNING id, business_name`,
        [req.params.id]
      );
      if (!result.rows.length) return err(res, 404, 'NOT_FOUND_SUPPLIER', 'Supplier not found');
      res.json({ success: true });
    } catch(e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // GET /api/admin/marketplace/products  — view all supplier products
  app.get('/api/admin/marketplace/products', auth, adminOnly, async (req, res) => {
    try {
      const result = await query(
        `SELECT mp.*, ms.business_name AS supplier_name, ms.status AS supplier_status
         FROM marketplace_products mp
         JOIN marketplace_suppliers ms ON ms.id = mp.supplier_id
         WHERE mp.is_active = true
         ORDER BY ms.business_name, mp.name`,
        []
      );
      res.json({ products: result.rows });
    } catch(e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // PATCH /api/admin/marketplace/suppliers/:id/commission
  app.patch('/api/admin/marketplace/suppliers/:id/commission', auth, adminOnly, async (req, res) => {
    const { commission_rate } = req.body;
    if (commission_rate === undefined) return err(res, 400, 'VALIDATION_REQUIRED', 'commission_rate is required', 'commission_rate');
    const rate = parseFloat(commission_rate);
    if (isNaN(rate) || rate < 0 || rate > 50) return err(res, 400, 'VALIDATION_INVALID', 'commission_rate must be 0–50', 'commission_rate');
    try {
      const result = await query(
        `UPDATE marketplace_suppliers SET commission_rate=$1, updated_at=NOW() WHERE id=$2 RETURNING id`,
        [rate, req.params.id]
      );
      if (!result.rows.length) return err(res, 404, 'NOT_FOUND_SUPPLIER', 'Supplier not found');
      res.json({ success: true });
    } catch(e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // GET /api/admin/marketplace/stats
  app.get('/api/admin/marketplace/stats', auth, adminOnly, async (req, res) => {
    try {
      const [pending, approved, total, products, orders, commissions] = await Promise.all([
        query(`SELECT COUNT(*) AS cnt FROM marketplace_suppliers WHERE status='pending'`),
        query(`SELECT COUNT(*) AS cnt FROM marketplace_suppliers WHERE status='approved'`),
        query(`SELECT COUNT(*) AS cnt FROM marketplace_suppliers`),
        query(`SELECT COUNT(*) AS cnt FROM marketplace_products WHERE is_active=true`),
        query(`SELECT COUNT(*) AS cnt FROM marketplace_orders`),
        query(`
          SELECT
            COALESCE(SUM(mo.total_amount * ms.commission_rate / 100), 0) AS total_commission_earned,
            COALESCE(SUM(mo.total_amount), 0) AS total_gmv,
            COUNT(mo.id) AS delivered_order_count
          FROM marketplace_orders mo
          JOIN marketplace_suppliers ms ON ms.id = mo.supplier_id
          WHERE mo.status = 'delivered'
        `),
      ]);
      res.json({
        pendingCount:          parseInt(pending.rows[0].cnt),
        approvedCount:         parseInt(approved.rows[0].cnt),
        totalCount:            parseInt(total.rows[0].cnt),
        productCount:          parseInt(products.rows[0].cnt),
        orderCount:            parseInt(orders.rows[0].cnt),
        totalCommissionEarned: parseFloat(commissions.rows[0].total_commission_earned || 0),
        totalGMV:              parseFloat(commissions.rows[0].total_gmv || 0),
        deliveredOrderCount:   parseInt(commissions.rows[0].delivered_order_count || 0),
      });
    } catch(e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });
  // GET /api/admin/marketplace/commissions — per-supplier commission breakdown
  app.get('/api/admin/marketplace/commissions', auth, adminOnly, async (req, res) => {
    try {
      const result = await query(`
        SELECT
          ms.id,
          ms.business_name,
          ms.commission_rate,
          COUNT(mo.id)                                              AS delivered_orders,
          COALESCE(SUM(mo.total_amount), 0)                        AS total_gmv,
          COALESCE(SUM(mo.total_amount * ms.commission_rate / 100), 0) AS commission_earned
        FROM marketplace_suppliers ms
        LEFT JOIN marketplace_orders mo
          ON mo.supplier_id = ms.id AND mo.status = 'delivered'
        WHERE ms.status = 'approved'
        GROUP BY ms.id, ms.business_name, ms.commission_rate
        ORDER BY commission_earned DESC
      `);
      res.json({ commissions: result.rows });
    } catch(e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ──────────────────────────────────────────────────────────
  // PHARMACY: Place a marketplace order
  // POST /api/marketplace/orders
  // ──────────────────────────────────────────────────────────
  app.post('/api/marketplace/orders', auth, async (req, res) => {
    const { supplier_id, items, payment_method, delivery_address, notes } = req.body;
    if (!supplier_id)        return err(res, 400, 'VALIDATION_REQUIRED', 'supplier_id is required');
    if (!Array.isArray(items) || !items.length)
                             return err(res, 400, 'VALIDATION_REQUIRED', 'items array is required');

    for (const it of items) {
      if (!it.name || !it.quantity || it.quantity < 1)
        return err(res, 400, 'VALIDATION_ITEMS', 'Each item needs a name and quantity > 0');
    }

    const pharmacyId = req.user.pharmacyId;
    if (!pharmacyId) return err(res, 400, 'NO_PHARMACY', 'User has no pharmacy assigned');

    try {
      // Verify supplier is approved
      const supRes = await query(
        `SELECT id FROM marketplace_suppliers WHERE id = $1 AND status = 'approved'`,
        [supplier_id]
      );
      if (!supRes.rows.length) return err(res, 404, 'SUPPLIER_NOT_FOUND', 'Supplier not found or not approved');

      // Generate order number atomically
      const ctrRes = await query(
        `UPDATE pharmacies SET mkt_order_counter = mkt_order_counter + 1
         WHERE id = $1 RETURNING mkt_order_counter`,
        [pharmacyId]
      );
      const n = ctrRes.rows[0]?.mkt_order_counter || Date.now();
      const order_number = `MKT-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`;

      // Calculate total
      const total_amount = items.reduce((sum, it) => sum + ((it.unit_price || 0) * it.quantity), 0);

      // Insert order
      const orderRes = await query(
        `INSERT INTO marketplace_orders
           (order_number, pharmacy_id, supplier_id, placed_by, total_amount,
            delivery_address, notes, payment_method, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
         RETURNING *`,
        [order_number, pharmacyId, supplier_id, req.user.id,
         total_amount, delivery_address || null, notes || null, payment_method || 'MTN MoMo']
      );
      const order = orderRes.rows[0];

      // Insert items
      for (const it of items) {
        await query(
          `INSERT INTO marketplace_order_items
             (order_id, product_id, product_name, unit, pack_size, unit_price, quantity, subtotal)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [order.id, it.product_id || null, it.name,
           it.unit || 'Pack', it.pack_size || 1,
           it.unit_price || 0, it.quantity,
           (it.unit_price || 0) * it.quantity]
        );
      }

      res.json({ success: true, order_number: order.order_number, order_id: order.id });
    } catch(e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ──────────────────────────────────────────────────────────
  // PHARMACY: Get own marketplace orders
  // GET /api/marketplace/orders
  // ──────────────────────────────────────────────────────────
  app.get('/api/marketplace/orders', auth, async (req, res) => {
    const pharmacyId = req.user.pharmacyId;
    if (!pharmacyId) return err(res, 400, 'NO_PHARMACY', 'User has no pharmacy assigned');
    try {
      const result = await query(
        `SELECT mo.*, ms.business_name AS supplier_name, ms.phone AS supplier_phone
         FROM marketplace_orders mo
         JOIN marketplace_suppliers ms ON ms.id = mo.supplier_id
         WHERE mo.pharmacy_id = $1
         ORDER BY mo.placed_at DESC LIMIT 100`,
        [pharmacyId]
      );
      const orderIds = result.rows.map(o => o.id);
      let itemsByOrder = {};
      if (orderIds.length) {
        const items = await query(
          `SELECT * FROM marketplace_order_items WHERE order_id = ANY($1)`, [orderIds]
        );
        items.rows.forEach(i => {
          if (!itemsByOrder[i.order_id]) itemsByOrder[i.order_id] = [];
          itemsByOrder[i.order_id].push(i);
        });
      }
      const orders = result.rows.map(o => ({ ...o, items: itemsByOrder[o.id] || [] }));
      res.json({ orders });
    } catch(e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ──────────────────────────────────────────────────────────
  // ADMIN: List all marketplace orders
  // GET /api/admin/marketplace/orders
  // ──────────────────────────────────────────────────────────
  app.get('/api/admin/marketplace/orders', auth, adminOnly, async (req, res) => {
    try {
      const { status, limit = 200 } = req.query;
      let sql = `SELECT mo.*, ms.business_name AS supplier_name, p.name AS pharmacy_name
                 FROM marketplace_orders mo
                 JOIN marketplace_suppliers ms ON ms.id = mo.supplier_id
                 JOIN pharmacies p ON p.id = mo.pharmacy_id`;
      const params = [];
      if (status) { sql += ` WHERE mo.status = $1`; params.push(status); }
      sql += ` ORDER BY mo.placed_at DESC LIMIT ${parseInt(limit)}`;
      const result = await query(sql, params);
      res.json({ orders: result.rows });
    } catch(e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ──────────────────────────────────────────────────────────
  // SUPPLIER: Get incoming orders
  // GET /api/marketplace/supplier/orders
  // ──────────────────────────────────────────────────────────
  app.get('/api/marketplace/supplier/orders', supplierAuth, async (req, res) => {
    try {
      const { status } = req.query;
      let sql = `SELECT mo.*, p.name AS pharmacy_name, p.phone AS pharmacy_phone
                 FROM marketplace_orders mo
                 JOIN pharmacies p ON p.id = mo.pharmacy_id
                 WHERE mo.supplier_id = $1`;
      const params = [req.supplier.supplierId];
      if (status) { sql += ` AND mo.status = $2`; params.push(status); }
      sql += ` ORDER BY mo.placed_at DESC LIMIT 100`;
      const result = await query(sql, params);

      // Attach items to each order
      const orderIds = result.rows.map(o => o.id);
      let items = { rows: [] };
      if (orderIds.length) {
        items = await query(
          `SELECT * FROM marketplace_order_items WHERE order_id = ANY($1)`,
          [orderIds]
        );
      }
      const itemsByOrder = {};
      items.rows.forEach(i => {
        if (!itemsByOrder[i.order_id]) itemsByOrder[i.order_id] = [];
        itemsByOrder[i.order_id].push(i);
      });

      const orders = result.rows.map(o => ({ ...o, items: itemsByOrder[o.id] || [] }));
      res.json({ orders });
    } catch(e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ──────────────────────────────────────────────────────────
  // SUPPLIER: Update order status
  // PATCH /api/marketplace/supplier/orders/:id/status
  // ──────────────────────────────────────────────────────────
  app.patch('/api/marketplace/supplier/orders/:id/status', supplierAuth, async (req, res) => {
    const { status } = req.body;
    const validTransitions = {
      pending:    ['confirmed', 'cancelled'],
      confirmed:  ['processing', 'shipped', 'cancelled'],
      processing: ['shipped', 'cancelled'],
      shipped:    ['delivered'],
    };
    if (!status) return err(res, 400, 'VALIDATION_REQUIRED', 'status is required', 'status');
    try {
      // Verify order belongs to this supplier
      const orderRes = await query(
        `SELECT * FROM marketplace_orders WHERE id = $1 AND supplier_id = $2`,
        [req.params.id, req.supplier.supplierId]
      );
      if (!orderRes.rows.length) return err(res, 404, 'NOT_FOUND', 'Order not found');
      const order = orderRes.rows[0];

      const allowed = validTransitions[order.status] || [];
      if (!allowed.includes(status)) {
        return err(res, 400, 'INVALID_TRANSITION',
          `Cannot move from '${order.status}' to '${status}'. Allowed: ${allowed.join(', ') || 'none'}`);
      }

      const tsField = {
        confirmed: 'confirmed_at', shipped: 'shipped_at',
        delivered: 'delivered_at', cancelled: 'cancelled_at',
      }[status];

      const result = await query(
        `UPDATE marketplace_orders
         SET status = $1,
             ${tsField ? tsField + ' = NOW(),' : ''}
             updated_at = NOW()
         WHERE id = $2 AND supplier_id = $3
         RETURNING *`,
        [status, req.params.id, req.supplier.supplierId]
      );

      res.json({ success: true, order: result.rows[0] });
    } catch(e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });


};
