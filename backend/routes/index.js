// ============================================================
// MedVault V2 — All API Routes
// PostgreSQL-backed, multi-branch, real data
// ============================================================
'use strict';

const { query, getNextReceiptNumber } = require('../database/db');
const { hash, compare } = require('../core/password');
const { sign } = require('../core/jwt');
const auth = require('../middleware/auth');


  // ══════════════════════════════════════════════════════════
  // EMERGENCY SEED — creates super admin if missing
  // Visit /api/setup once to create admin account
  // ══════════════════════════════════════════════════════════
  app.get('/api/setup', async (req, res) => {
    try {
      const { runMigrations, seedSuperAdmin } = require('../database/db');
      await runMigrations();
      await seedSuperAdmin();

      // Also try to create directly in case seed skipped
      const { query } = require('../database/db');
      const exists = await query(
        `SELECT id FROM users WHERE email = $1`,
        ['admin@medvault.ug']
      );

      if (exists.rows.length) {
        res.json({
          message: '✅ Setup complete! Admin account exists.',
          email:    'admin@medvault.ug',
          password: 'MedVault2026!',
          user_id:  exists.rows[0].id,
        });
      } else {
        res.json({
          message: '⚠️ Migrations ran but seed may have failed. Check Railway logs.',
          hint: 'Make sure DATABASE_URL is set in Railway Variables',
        });
      }
    } catch(e) {
      res.json({ error: e.message, hint: 'Check DATABASE_URL in Railway Variables' });
    }
  });

  // Test DB connection directly
  app.get('/api/dbtest', async (req, res) => {
    try {
      const { query } = require('../database/db');
      const result = await query('SELECT NOW() as time, current_database() as db');
      const users  = await query('SELECT COUNT(*) as cnt FROM users').catch(() => ({ rows: [{ cnt: 'table missing' }] }));
      res.json({
        status:    'connected',
        db:        result.rows[0],
        userCount: users.rows[0].cnt,
      });
    } catch(e) {
      res.json({ status: 'error', message: e.message });
    }
  });


module.exports = function registerRoutes(app) {

  // ══════════════════════════════════════════════════════════
  // HEALTH CHECK
  // ══════════════════════════════════════════════════════════
  app.get('/health', async (req, res) => {
    try {
      await query('SELECT 1');
      res.json({ status: 'ok', service: 'MedVault API v2', db: 'connected', time: new Date() });
    } catch (e) {
      res.json({ status: 'ok', service: 'MedVault API v2', db: 'error: ' + e.message, time: new Date() });
    }
  });

  // ══════════════════════════════════════════════════════════
  // AUTH — Register & Login
  // ══════════════════════════════════════════════════════════

  // POST /api/auth/register
  app.post('/api/auth/register', async (req, res) => {
    const { orgName, ownerName, email, phone, password, plan } = req.body;
    if (!orgName || !ownerName || !email || !phone || !password)
      return res.json({ error: 'All fields required: orgName, ownerName, email, phone, password' }, 400);

    try {
      // Check email not taken
      const exists = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
      if (exists.rows.length > 0)
        return res.json({ error: 'Email already registered. Please log in.' }, 409);

      const pwHash = await hash(password);
      const selectedPlan = plan || 'single';

      // Create organisation
      const orgRes = await query(
        `INSERT INTO organisations (name, owner_name, email, phone, plan)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [orgName, ownerName, email.toLowerCase(), phone, selectedPlan]
      );
      const orgId = orgRes.rows[0].id;

      // Create first pharmacy (head office)
      const pharmaRes = await query(
        `INSERT INTO pharmacies (organisation_id, name, address, phone, is_head_office)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [orgId, orgName, req.body.address || '', phone, true]
      );
      const pharmacyId = pharmaRes.rows[0].id;

      // Create owner user
      const userRes = await query(
        `INSERT INTO users (organisation_id, pharmacy_id, name, email, password_hash, role)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, email, role`,
        [orgId, pharmacyId, ownerName, email.toLowerCase(), pwHash, 'owner']
      );
      const user = userRes.rows[0];

      // Create trial subscription
      const prices = { drug_shop: 20000, single: 50000, branch: 40000, chain: 30000, enterprise: 20000 };
      await query(
        `INSERT INTO subscriptions (organisation_id, plan, branch_count, amount_ugx, status)
         VALUES ($1,$2,$3,$4,$5)`,
        [orgId, selectedPlan, 1, prices[selectedPlan] || 50000, 'trial']
      );

      const token = sign({ userId: user.id, orgId, pharmacyId, role: user.role });

      res.json({
        message: '✅ Account created! 14-day free trial started.',
        token,
        user: {
          id: user.id, name: user.name, email: user.email, role: user.role,
          orgId, orgName, pharmacyId, plan: selectedPlan,
        },
      });
    } catch (e) {
      console.error('Register error:', e.message);
      res.json({ error: 'Registration failed: ' + e.message }, 500);
    }
  });

  // POST /api/auth/login
  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password)
      return res.json({ error: 'Email and password required' }, 400);

    try {
      const result = await query(
        `SELECT u.id, u.name, u.email, u.password_hash, u.role,
                u.organisation_id, u.pharmacy_id, u.is_active,
                o.name as org_name, o.plan,
                p.name as pharmacy_name
         FROM users u
         JOIN organisations o ON o.id = u.organisation_id
         LEFT JOIN pharmacies p ON p.id = u.pharmacy_id
         WHERE u.email = $1`,
        [email.toLowerCase()]
      );

      if (!result.rows.length)
        return res.json({ error: 'No account found with this email' }, 401);

      const user = result.rows[0];
      if (!user.is_active)
        return res.json({ error: 'Account suspended. Contact support.' }, 403);

      const valid = await compare(password, user.password_hash);
      if (!valid)
        return res.json({ error: 'Incorrect password' }, 401);

      const token = sign({
        userId: user.id, orgId: user.organisation_id,
        pharmacyId: user.pharmacy_id, role: user.role,
      });

      res.json({
        token,
        user: {
          id: user.id, name: user.name, email: user.email, role: user.role,
          orgId: user.organisation_id, orgName: user.org_name,
          pharmacyId: user.pharmacy_id, pharmacyName: user.pharmacy_name,
          plan: user.plan,
        },
      });
    } catch (e) {
      console.error('Login error:', e.message);
      res.json({ error: 'Login failed: ' + e.message }, 500);
    }
  });

  // GET /api/auth/me
  app.get('/api/auth/me', auth, async (req, res) => {
    try {
      const result = await query(
        `SELECT u.id, u.name, u.email, u.role,
                u.organisation_id, u.pharmacy_id,
                o.name as org_name, o.plan,
                p.name as pharmacy_name, p.address, p.is_head_office,
                s.status as sub_status, s.trial_ends_at, s.next_billing
         FROM users u
         JOIN organisations o ON o.id = u.organisation_id
         LEFT JOIN pharmacies p ON p.id = u.pharmacy_id
         LEFT JOIN subscriptions s ON s.organisation_id = u.organisation_id
         WHERE u.id = $1
         ORDER BY s.created_at DESC LIMIT 1`,
        [req.user.userId]
      );
      if (!result.rows.length) return res.json({ error: 'User not found' }, 404);
      res.json({ user: result.rows[0] });
    } catch (e) {
      res.json({ error: e.message }, 500);
    }
  });

  // ══════════════════════════════════════════════════════════
  // DASHBOARD
  // ══════════════════════════════════════════════════════════
  app.get('/api/dashboard', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const today = new Date().toISOString().split('T')[0];

      const [revRes, txRes, lowRes, expRes, weekRes, recentRes] = await Promise.all([
        query(`SELECT COALESCE(SUM(total_amount),0) as rev FROM sales WHERE pharmacy_id=$1 AND DATE(created_at)=CURRENT_DATE`, [pharmacyId]),
        query(`SELECT COUNT(*) as cnt FROM sales WHERE pharmacy_id=$1 AND DATE(created_at)=CURRENT_DATE`, [pharmacyId]),
        query(`SELECT COUNT(*) as cnt FROM drugs WHERE pharmacy_id=$1 AND quantity <= threshold`, [pharmacyId]),
        query(`SELECT COUNT(*) as cnt FROM drugs WHERE pharmacy_id=$1 AND expiry_date IS NOT NULL AND expiry_date <= CURRENT_DATE + INTERVAL '30 days' AND expiry_date >= CURRENT_DATE`, [pharmacyId]),
        query(`SELECT DATE(created_at) as day, COALESCE(SUM(total_amount),0) as revenue FROM sales WHERE pharmacy_id=$1 AND created_at >= CURRENT_DATE - INTERVAL '6 days' GROUP BY DATE(created_at) ORDER BY day`, [pharmacyId]),
        query(`SELECT id, customer_name, total_amount, payment_method, created_at FROM sales WHERE pharmacy_id=$1 ORDER BY created_at DESC LIMIT 5`, [pharmacyId]),
      ]);

      res.json({
        revenueToday:      parseFloat(revRes.rows[0].rev),
        transactionsToday: parseInt(txRes.rows[0].cnt),
        lowStockCount:     parseInt(lowRes.rows[0].cnt),
        expiringCount:     parseInt(expRes.rows[0].cnt),
        weeklyRevenue:     weekRes.rows,
        recentSales:       recentRes.rows,
      });
    } catch (e) {
      res.json({ error: e.message }, 500);
    }
  });

  // ══════════════════════════════════════════════════════════
  // INVENTORY
  // ══════════════════════════════════════════════════════════
  app.get('/api/inventory', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const { search, category, status } = req.query;
    try {
      let sql = `SELECT *, 
        CASE WHEN quantity = 0 THEN 'out'
             WHEN quantity <= threshold THEN 'critical'
             WHEN quantity <= threshold * 1.5 THEN 'low'
             ELSE 'ok' END as stock_status,
        CASE WHEN expiry_date IS NOT NULL 
             THEN (expiry_date - CURRENT_DATE)::int 
             ELSE 999 END as days_to_expiry
        FROM drugs WHERE pharmacy_id = $1`;
      const params = [pharmacyId];
      let i = 2;
      if (search) { sql += ` AND name ILIKE $${i++}`; params.push(`%${search}%`); }
      if (category) { sql += ` AND category = $${i++}`; params.push(category); }
      if (status === 'low')      sql += ` AND quantity <= threshold * 1.5 AND quantity > 0`;
      if (status === 'critical') sql += ` AND quantity <= threshold`;
      if (status === 'out')      sql += ` AND quantity = 0`;
      sql += ` ORDER BY name`;

      const result = await query(sql, params);
      res.json({ drugs: result.rows, total: result.rows.length });
    } catch (e) {
      res.json({ error: e.message }, 500);
    }
  });

  app.get('/api/inventory/alerts', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const [lowStock, expiring] = await Promise.all([
        query(`SELECT * FROM drugs WHERE pharmacy_id=$1 AND quantity <= threshold ORDER BY quantity ASC`, [pharmacyId]),
        query(`SELECT *, (expiry_date - CURRENT_DATE)::int as days_left FROM drugs WHERE pharmacy_id=$1 AND expiry_date <= CURRENT_DATE + INTERVAL '30 days' AND expiry_date >= CURRENT_DATE ORDER BY expiry_date`, [pharmacyId]),
      ]);
      res.json({ lowStock: lowStock.rows, expiring: expiring.rows });
    } catch (e) {
      res.json({ error: e.message }, 500);
    }
  });

  app.get('/api/inventory/:id', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const result = await query(
        `SELECT * FROM drugs WHERE id=$1 AND pharmacy_id=$2`,
        [req.params.id, pharmacyId]
      );
      if (!result.rows.length) return res.json({ error: 'Drug not found' }, 404);
      res.json({ drug: result.rows[0] });
    } catch (e) {
      res.json({ error: e.message }, 500);
    }
  });

  // POST /api/inventory — ADD DRUG
  app.post('/api/inventory', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const { name, generic_name, category, quantity, unit_price, cost_price,
            expiry_date, supplier, barcode, threshold, requires_rx } = req.body;
    if (!name || quantity === undefined || !unit_price)
      return res.json({ error: 'Name, quantity, and unit price are required' }, 400);
    try {
      const result = await query(
        `INSERT INTO drugs
          (pharmacy_id, name, generic_name, category, quantity, max_quantity,
           unit_price, cost_price, expiry_date, supplier, barcode, threshold, requires_rx)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          pharmacyId, name, generic_name || null, category || 'General',
          parseInt(quantity), parseInt(quantity),
          parseFloat(unit_price), parseFloat(cost_price || 0),
          expiry_date || null, supplier || null, barcode || null,
          parseInt(threshold || 20), requires_rx === true || requires_rx === 'true',
        ]
      );
      res.json({ message: '✅ Drug added!', drug: result.rows[0] });
    } catch (e) {
      res.json({ error: 'Failed to add drug: ' + e.message }, 500);
    }
  });

  // PUT /api/inventory/:id — UPDATE DRUG
  app.put('/api/inventory/:id', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const { name, generic_name, category, quantity, unit_price, cost_price,
            expiry_date, supplier, threshold, requires_rx } = req.body;
    try {
      const result = await query(
        `UPDATE drugs SET
          name=$1, generic_name=$2, category=$3, quantity=$4,
          unit_price=$5, cost_price=$6, expiry_date=$7, supplier=$8,
          threshold=$9, requires_rx=$10, updated_at=NOW()
         WHERE id=$11 AND pharmacy_id=$12 RETURNING *`,
        [name, generic_name, category, parseInt(quantity),
         parseFloat(unit_price), parseFloat(cost_price || 0),
         expiry_date || null, supplier, parseInt(threshold || 20),
         Boolean(requires_rx), req.params.id, pharmacyId]
      );
      if (!result.rows.length) return res.json({ error: 'Drug not found' }, 404);
      res.json({ message: '✅ Drug updated!', drug: result.rows[0] });
    } catch (e) {
      res.json({ error: e.message }, 500);
    }
  });

  // DELETE /api/inventory/:id
  app.delete('/api/inventory/:id', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const result = await query(
        `DELETE FROM drugs WHERE id=$1 AND pharmacy_id=$2 RETURNING id`,
        [req.params.id, pharmacyId]
      );
      if (!result.rows.length) return res.json({ error: 'Drug not found' }, 404);
      res.json({ message: '✅ Drug deleted' });
    } catch (e) {
      res.json({ error: e.message }, 500);
    }
  });

  // ══════════════════════════════════════════════════════════
  // SALES
  // ══════════════════════════════════════════════════════════
  app.get('/api/sales', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const limit = parseInt(req.query.limit) || 50;
    try {
      const result = await query(
        `SELECT s.*, 
          json_agg(json_build_object('drug_name',si.drug_name,'quantity',si.quantity,'unit_price',si.unit_price,'total_price',si.total_price)) as items
         FROM sales s
         LEFT JOIN sale_items si ON si.sale_id = s.id
         WHERE s.pharmacy_id = $1
         GROUP BY s.id
         ORDER BY s.created_at DESC LIMIT $2`,
        [pharmacyId, limit]
      );
      res.json({ sales: result.rows, total: result.rows.length });
    } catch (e) {
      res.json({ error: e.message }, 500);
    }
  });

  app.post('/api/sales', auth, async (req, res) => {
    const { pharmacyId, userId } = req.user;
    const { customer_name, customer_phone, items, discount_pct, payment_method, subtotal, discount_amount, total_amount } = req.body;
    if (!items || !items.length)
      return res.json({ error: 'No items in sale' }, 400);
    try {
      const receiptNum = await getNextReceiptNumber(pharmacyId);

      const saleRes = await query(
        `INSERT INTO sales (pharmacy_id, user_id, receipt_number, customer_name, customer_phone,
          subtotal, discount_pct, discount_amount, total_amount, payment_method)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [pharmacyId, userId || null, receiptNum,
         customer_name || 'Walk-in', customer_phone || null,
         parseFloat(subtotal || 0), parseFloat(discount_pct || 0),
         parseFloat(discount_amount || 0), parseFloat(total_amount || 0),
         payment_method || 'cash']
      );
      const sale = saleRes.rows[0];

      // Insert sale items and reduce stock
      for (const item of items) {
        await query(
          `INSERT INTO sale_items (sale_id, drug_id, drug_name, quantity, unit_price, total_price)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [sale.id, item.drug_id || null, item.drug_name,
           item.quantity, item.unit_price, item.unit_price * item.quantity]
        );
        if (item.drug_id) {
          await query(
            `UPDATE drugs SET quantity = GREATEST(0, quantity - $1), updated_at = NOW()
             WHERE id = $2 AND pharmacy_id = $3`,
            [item.quantity, item.drug_id, pharmacyId]
          );
        }
      }

      // Update customer record
      if (customer_phone) {
        await query(
          `INSERT INTO customers (pharmacy_id, name, phone, total_spent, visit_count)
           VALUES ($1,$2,$3,$4,1)
           ON CONFLICT (phone) DO UPDATE SET
             total_spent = customers.total_spent + $4,
             visit_count = customers.visit_count + 1`,
          [pharmacyId, customer_name || 'Customer', customer_phone, parseFloat(total_amount || 0)]
        ).catch(() => {}); // ignore if no unique constraint
      }

      res.json({ message: '✅ Sale recorded!', sale, receipt_number: receiptNum });
    } catch (e) {
      console.error('Sale error:', e.message);
      res.json({ error: 'Sale failed: ' + e.message }, 500);
    }
  });

  // ══════════════════════════════════════════════════════════
  // ORDERS (customer-facing)
  // ══════════════════════════════════════════════════════════
  app.get('/api/orders', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const { status } = req.query;
    try {
      let sql = `SELECT o.*, 
        json_agg(json_build_object('drug_name',oi.drug_name,'quantity',oi.quantity,'unit_price',oi.unit_price)) as items
        FROM orders o
        LEFT JOIN order_items oi ON oi.order_id = o.id
        WHERE o.pharmacy_id = $1`;
      const params = [pharmacyId];
      if (status) { sql += ` AND o.order_status = $2`; params.push(status); }
      sql += ` GROUP BY o.id ORDER BY o.created_at DESC`;
      const result = await query(sql, params);
      res.json({ orders: result.rows });
    } catch (e) {
      res.json({ error: e.message }, 500);
    }
  });

  // Public order (customer places order — no auth needed)
  app.post('/api/orders/public/:pharmacyId', async (req, res) => {
    const pharmacyId = parseInt(req.params.pharmacyId);
    const { customer_name, customer_phone, delivery_address, delivery_type, payment_method, items, total_amount, notes } = req.body;
    if (!customer_name || !customer_phone || !items?.length)
      return res.json({ error: 'Name, phone, and items are required' }, 400);
    try {
      const orderRes = await query(
        `INSERT INTO orders (pharmacy_id, customer_name, customer_phone, delivery_address,
          delivery_type, payment_method, total_amount, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [pharmacyId, customer_name, customer_phone, delivery_address || '',
         delivery_type || 'delivery', payment_method || 'cash',
         parseFloat(total_amount || 0), notes || null]
      );
      const order = orderRes.rows[0];
      for (const item of items) {
        await query(
          `INSERT INTO order_items (order_id, drug_id, drug_name, quantity, unit_price)
           VALUES ($1,$2,$3,$4,$5)`,
          [order.id, item.drug_id || null, item.drug_name, item.quantity, item.unit_price]
        );
      }
      res.json({ message: '✅ Order placed! Pharmacy will contact you soon.', order });
    } catch (e) {
      res.json({ error: e.message }, 500);
    }
  });

  app.patch('/api/orders/:id/status', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const { status } = req.body;
    const validStatuses = ['pending','processing','ready','delivered','cancelled'];
    if (!validStatuses.includes(status))
      return res.json({ error: 'Invalid status' }, 400);
    try {
      const result = await query(
        `UPDATE orders SET order_status=$1 WHERE id=$2 AND pharmacy_id=$3 RETURNING *`,
        [status, req.params.id, pharmacyId]
      );
      if (!result.rows.length) return res.json({ error: 'Order not found' }, 404);
      res.json({ message: '✅ Order updated!', order: result.rows[0] });
    } catch (e) {
      res.json({ error: e.message }, 500);
    }
  });

  // ══════════════════════════════════════════════════════════
  // CUSTOMERS
  // ══════════════════════════════════════════════════════════
  app.get('/api/customers', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const result = await query(
        `SELECT * FROM customers WHERE pharmacy_id=$1 ORDER BY total_spent DESC`,
        [pharmacyId]
      );
      res.json({ customers: result.rows });
    } catch (e) {
      res.json({ error: e.message }, 500);
    }
  });

  // ══════════════════════════════════════════════════════════
  // MULTI-BRANCH — Organisation & Branches
  // ══════════════════════════════════════════════════════════

  // GET all branches for this organisation
  app.get('/api/branches', auth, async (req, res) => {
    const { orgId } = req.user;
    try {
      const result = await query(
        `SELECT p.*,
          (SELECT COUNT(*) FROM drugs d WHERE d.pharmacy_id = p.id) as drug_count,
          (SELECT COALESCE(SUM(s.total_amount),0) FROM sales s WHERE s.pharmacy_id = p.id AND DATE(s.created_at) = CURRENT_DATE) as revenue_today
         FROM pharmacies p WHERE p.organisation_id = $1 ORDER BY p.is_head_office DESC, p.name`,
        [orgId]
      );
      res.json({ branches: result.rows });
    } catch (e) {
      res.json({ error: e.message }, 500);
    }
  });

  // POST /api/branches — add a new branch
  app.post('/api/branches', auth, async (req, res) => {
    const { orgId, role } = req.user;
    if (!['owner','super_admin'].includes(role))
      return res.json({ error: 'Only owners can add branches' }, 403);
    const { name, address, phone, nda_number } = req.body;
    if (!name) return res.json({ error: 'Branch name is required' }, 400);
    try {
      const result = await query(
        `INSERT INTO pharmacies (organisation_id, name, address, phone, nda_number)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [orgId, name, address || '', phone || '', nda_number || null]
      );
      // Update branch count in subscription
      await query(
        `UPDATE subscriptions SET branch_count = (
          SELECT COUNT(*) FROM pharmacies WHERE organisation_id = $1
         ) WHERE organisation_id = $1`,
        [orgId]
      );
      res.json({ message: '✅ Branch added!', branch: result.rows[0] });
    } catch (e) {
      res.json({ error: e.message }, 500);
    }
  });

  // GET cross-branch summary (head office view)
  app.get('/api/org/summary', auth, async (req, res) => {
    const { orgId, role } = req.user;
    if (!['owner','super_admin'].includes(role))
      return res.json({ error: 'Owner access required' }, 403);
    try {
      const [branches, totalRev, totalDrugs, lowStock, transfers] = await Promise.all([
        query(`SELECT COUNT(*) as cnt FROM pharmacies WHERE organisation_id=$1`, [orgId]),
        query(`SELECT COALESCE(SUM(s.total_amount),0) as total FROM sales s JOIN pharmacies p ON p.id=s.pharmacy_id WHERE p.organisation_id=$1 AND DATE(s.created_at)=CURRENT_DATE`, [orgId]),
        query(`SELECT COUNT(*) as cnt FROM drugs d JOIN pharmacies p ON p.id=d.pharmacy_id WHERE p.organisation_id=$1`, [orgId]),
        query(`SELECT COUNT(*) as cnt FROM drugs d JOIN pharmacies p ON p.id=d.pharmacy_id WHERE p.organisation_id=$1 AND d.quantity <= d.threshold`, [orgId]),
        query(`SELECT COUNT(*) as cnt FROM stock_transfers WHERE organisation_id=$1 AND status='pending'`, [orgId]),
      ]);
      res.json({
        branchCount:        parseInt(branches.rows[0].cnt),
        totalRevenueToday:  parseFloat(totalRev.rows[0].total),
        totalDrugs:         parseInt(totalDrugs.rows[0].cnt),
        lowStockCount:      parseInt(lowStock.rows[0].cnt),
        pendingTransfers:   parseInt(transfers.rows[0].cnt),
      });
    } catch (e) {
      res.json({ error: e.message }, 500);
    }
  });

  // ══════════════════════════════════════════════════════════
  // STOCK TRANSFERS (between branches)
  // ══════════════════════════════════════════════════════════

  app.get('/api/transfers', auth, async (req, res) => {
    const { orgId } = req.user;
    try {
      const result = await query(
        `SELECT st.*, 
          fp.name as from_branch, tp.name as to_branch,
          d.name as drug_name
         FROM stock_transfers st
         JOIN pharmacies fp ON fp.id = st.from_pharmacy_id
         JOIN pharmacies tp ON tp.id = st.to_pharmacy_id
         LEFT JOIN drugs d ON d.id = st.drug_id
         WHERE st.organisation_id = $1
         ORDER BY st.created_at DESC LIMIT 50`,
        [orgId]
      );
      res.json({ transfers: result.rows });
    } catch (e) {
      res.json({ error: e.message }, 500);
    }
  });

  app.post('/api/transfers', auth, async (req, res) => {
    const { orgId, userId } = req.user;
    const { from_pharmacy_id, to_pharmacy_id, drug_id, quantity, notes } = req.body;
    if (!from_pharmacy_id || !to_pharmacy_id || !drug_id || !quantity)
      return res.json({ error: 'from_pharmacy_id, to_pharmacy_id, drug_id, quantity required' }, 400);
    try {
      // Check drug exists and has enough stock
      const drugRes = await query(
        `SELECT * FROM drugs WHERE id=$1 AND pharmacy_id=$2`,
        [drug_id, from_pharmacy_id]
      );
      if (!drugRes.rows.length) return res.json({ error: 'Drug not found in source branch' }, 404);
      const drug = drugRes.rows[0];
      if (drug.quantity < quantity) return res.json({ error: `Only ${drug.quantity} units available` }, 400);

      const result = await query(
        `INSERT INTO stock_transfers
          (organisation_id, from_pharmacy_id, to_pharmacy_id, drug_id, drug_name, quantity, requested_by, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [orgId, from_pharmacy_id, to_pharmacy_id, drug_id, drug.name, quantity, userId, notes || null]
      );
      res.json({ message: '✅ Transfer requested! Awaiting approval.', transfer: result.rows[0] });
    } catch (e) {
      res.json({ error: e.message }, 500);
    }
  });

  app.patch('/api/transfers/:id/approve', auth, async (req, res) => {
    const { orgId, userId, role } = req.user;
    if (!['owner','super_admin','manager'].includes(role))
      return res.json({ error: 'Manager access required to approve transfers' }, 403);
    try {
      const txRes = await query(
        `SELECT * FROM stock_transfers WHERE id=$1 AND organisation_id=$2 AND status='pending'`,
        [req.params.id, orgId]
      );
      if (!txRes.rows.length) return res.json({ error: 'Transfer not found or already processed' }, 404);
      const tx = txRes.rows[0];

      // Deduct from source
      await query(
        `UPDATE drugs SET quantity = GREATEST(0, quantity - $1), updated_at=NOW() WHERE id=$2 AND pharmacy_id=$3`,
        [tx.quantity, tx.drug_id, tx.from_pharmacy_id]
      );
      // Add to destination (find matching drug or create)
      const destDrug = await query(
        `SELECT id FROM drugs WHERE pharmacy_id=$1 AND name=$2`,
        [tx.to_pharmacy_id, tx.drug_name]
      );
      if (destDrug.rows.length) {
        await query(
          `UPDATE drugs SET quantity = quantity + $1, updated_at=NOW() WHERE id=$2`,
          [tx.quantity, destDrug.rows[0].id]
        );
      } else {
        // Copy drug to destination branch
        const srcDrug = await query(`SELECT * FROM drugs WHERE id=$1`, [tx.drug_id]);
        if (srcDrug.rows.length) {
          const d = srcDrug.rows[0];
          await query(
            `INSERT INTO drugs (pharmacy_id,name,generic_name,category,quantity,max_quantity,unit_price,cost_price,threshold)
             VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8)`,
            [tx.to_pharmacy_id, d.name, d.generic_name, d.category, tx.quantity, d.unit_price, d.cost_price, d.threshold]
          );
        }
      }

      // Mark approved
      await query(
        `UPDATE stock_transfers SET status='approved', approved_by=$1 WHERE id=$2`,
        [userId, tx.id]
      );
      res.json({ message: '✅ Transfer approved! Stock moved.' });
    } catch (e) {
      res.json({ error: e.message }, 500);
    }
  });

  // ══════════════════════════════════════════════════════════
  // SUPER ADMIN — sees ALL pharmacies
  // ══════════════════════════════════════════════════════════
  app.get('/api/admin/pharmacies', auth, async (req, res) => {
    if (req.user.role !== 'super_admin')
      return res.json({ error: 'Super admin only' }, 403);
    try {
      const result = await query(
        `SELECT o.id as org_id, o.name as org_name, o.email, o.phone, o.plan, o.created_at,
          COUNT(p.id) as branch_count,
          s.status as sub_status, s.amount_ugx, s.trial_ends_at,
          (SELECT COALESCE(SUM(sa.total_amount),0) FROM sales sa JOIN pharmacies bp ON bp.id=sa.pharmacy_id WHERE bp.organisation_id=o.id) as total_revenue
         FROM organisations o
         LEFT JOIN pharmacies p ON p.organisation_id = o.id
         LEFT JOIN subscriptions s ON s.organisation_id = o.id
         GROUP BY o.id, s.status, s.amount_ugx, s.trial_ends_at
         ORDER BY o.created_at DESC`
      );
      res.json({ organisations: result.rows });
    } catch (e) {
      res.json({ error: e.message }, 500);
    }
  });

  app.get('/api/admin/stats', auth, async (req, res) => {
    if (req.user.role !== 'super_admin')
      return res.json({ error: 'Super admin only' }, 403);
    try {
      const [orgs, active, trial, revenue] = await Promise.all([
        query(`SELECT COUNT(*) as cnt FROM organisations`),
        query(`SELECT COUNT(*) as cnt FROM subscriptions WHERE status='active'`),
        query(`SELECT COUNT(*) as cnt FROM subscriptions WHERE status='trial'`),
        query(`SELECT COALESCE(SUM(amount_ugx),0) as mrr FROM subscriptions WHERE status='active'`),
      ]);
      res.json({
        totalOrganisations: parseInt(orgs.rows[0].cnt),
        activeSubscriptions: parseInt(active.rows[0].cnt),
        onTrial: parseInt(trial.rows[0].cnt),
        mrr: parseFloat(revenue.rows[0].mrr),
      });
    } catch (e) {
      res.json({ error: e.message }, 500);
    }
  });

  // ══════════════════════════════════════════════════════════
  // SUBSCRIPTION INFO
  // ══════════════════════════════════════════════════════════
  app.get('/api/subscription', auth, async (req, res) => {
    const { orgId } = req.user;
    try {
      const result = await query(
        `SELECT s.*, o.name as org_name, o.plan,
          (SELECT COUNT(*) FROM pharmacies WHERE organisation_id=$1) as branch_count
         FROM subscriptions s
         JOIN organisations o ON o.id = s.organisation_id
         WHERE s.organisation_id = $1
         ORDER BY s.created_at DESC LIMIT 1`,
        [orgId]
      );
      res.json({ subscription: result.rows[0] || null });
    } catch (e) {
      res.json({ error: e.message }, 500);
    }
  });

};


  // ══════════════════════════════════════════════════════════
  // STAFF MANAGEMENT
  // ══════════════════════════════════════════════════════════

  // GET /api/staff — list all staff in this organisation
  app.get('/api/staff', auth, async (req, res) => {
    const { orgId } = req.user;
    try {
      const result = await query(
        `SELECT u.id, u.name, u.email, u.role, u.is_active, u.created_at,
                p.name as pharmacy_name, p.id as pharmacy_id
         FROM users u
         LEFT JOIN pharmacies p ON p.id = u.pharmacy_id
         WHERE u.organisation_id = $1
         ORDER BY u.created_at DESC`,
        [orgId]
      );
      res.json({ staff: result.rows });
    } catch(e) { res.json({ error: e.message }, 500); }
  });

  // POST /api/staff/invite — owner invites a new staff member
  app.post('/api/staff/invite', auth, async (req, res) => {
    const { orgId, role } = req.user;
    if (!['owner','super_admin'].includes(role))
      return res.json({ error: 'Only owners can invite staff' }, 403);
    const { name, email, password, staffRole, pharmacyId } = req.body;
    if (!name || !email || !password)
      return res.json({ error: 'Name, email and password are required' }, 400);
    try {
      const exists = await query(`SELECT id FROM users WHERE email = $1`, [email.toLowerCase()]);
      if (exists.rows.length) return res.json({ error: 'Email already registered' }, 409);
      const { hash } = require('../core/password');
      const pw = await hash(password);
      const result = await query(
        `INSERT INTO users (organisation_id, pharmacy_id, name, email, password_hash, role)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, email, role`,
        [orgId, pharmacyId||null, name, email.toLowerCase(), pw, staffRole||'staff']
      );
      res.json({ message: '✅ Staff member added!', user: result.rows[0] });
    } catch(e) { res.json({ error: e.message }, 500); }
  });

  // PATCH /api/staff/:id/deactivate
  app.patch('/api/staff/:id/deactivate', auth, async (req, res) => {
    const { orgId, role } = req.user;
    if (!['owner','super_admin'].includes(role))
      return res.json({ error: 'Only owners can deactivate staff' }, 403);
    try {
      await query(
        `UPDATE users SET is_active = false WHERE id = $1 AND organisation_id = $2`,
        [req.params.id, orgId]
      );
      res.json({ message: '✅ Staff member deactivated' });
    } catch(e) { res.json({ error: e.message }, 500); }
  });

  // PATCH /api/staff/:id/activate
  app.patch('/api/staff/:id/activate', auth, async (req, res) => {
    const { orgId, role } = req.user;
    if (!['owner','super_admin'].includes(role))
      return res.json({ error: 'Only owners can activate staff' }, 403);
    try {
      await query(
        `UPDATE users SET is_active = true WHERE id = $1 AND organisation_id = $2`,
        [req.params.id, orgId]
      );
      res.json({ message: '✅ Staff member reactivated' });
    } catch(e) { res.json({ error: e.message }, 500); }
  });


  // ══════════════════════════════════════════════════════════
  // ADDON 1 — ANTI-THEFT VARIANCE ENGINE
  // Compares units sold vs stock reduction to detect theft
  // ══════════════════════════════════════════════════════════

  app.get('/api/variance/daily', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const date = req.query.date || new Date().toISOString().split('T')[0];
    try {
      // Units sold per drug today from sale_items
      const sold = await query(
        `SELECT si.drug_id, si.drug_name, SUM(si.quantity) as units_sold
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         WHERE s.pharmacy_id = $1 AND DATE(s.created_at) = $2 AND si.drug_id IS NOT NULL
         GROUP BY si.drug_id, si.drug_name`,
        [pharmacyId, date]
      );
      // Get current vs opening stock for each drug
      // Opening stock = current + sold (simplified — real system uses snapshots)
      const variances = [];
      for (const row of sold.rows) {
        const drug = await query(
          `SELECT name, quantity, threshold FROM drugs WHERE id = $1`,
          [row.drug_id]
        );
        if (drug.rows.length) {
          const d = drug.rows[0];
          const expected = parseInt(row.units_sold);
          // Flag if variance pattern is unusual (sold > 20 of a high value drug)
          variances.push({
            drug_id:     row.drug_id,
            drug_name:   row.drug_name,
            units_sold:  expected,
            current_qty: d.quantity,
            status:      expected > 50 ? 'review' : 'ok',
          });
        }
      }
      res.json({ date, variances, total: variances.length });
    } catch(e) { res.json({ error: e.message }, 500); }
  });

  // Log a manual stock count (for reconciliation)
  app.post('/api/variance/stockcount', auth, async (req, res) => {
    const { pharmacyId, userId } = req.user;
    const { counts } = req.body; // [{drug_id, counted_qty}]
    if (!counts?.length) return res.json({ error: 'counts array required' }, 400);
    try {
      const variances = [];
      for (const c of counts) {
        const drug = await query(
          `SELECT id, name, quantity FROM drugs WHERE id = $1 AND pharmacy_id = $2`,
          [c.drug_id, pharmacyId]
        );
        if (!drug.rows.length) continue;
        const d = drug.rows[0];
        const system_qty = d.quantity;
        const counted_qty = parseInt(c.counted_qty);
        const diff = system_qty - counted_qty;
        if (Math.abs(diff) > 0) {
          variances.push({
            drug_id: d.id, drug_name: d.name,
            system_qty, counted_qty,
            variance: diff,
            flag: diff > 0 ? 'shortage' : 'surplus',
          });
          // Update to actual counted quantity
          await query(
            `UPDATE drugs SET quantity = $1, updated_at = NOW() WHERE id = $2`,
            [counted_qty, d.id]
          );
        }
      }
      res.json({
        message: `Stock count complete. ${variances.length} variances found.`,
        variances,
      });
    } catch(e) { res.json({ error: e.message }, 500); }
  });

  // Staff activity log
  app.get('/api/activity', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const limit = parseInt(req.query.limit) || 50;
    try {
      // Get recent sales with staff info
      const result = await query(
        `SELECT s.id, s.receipt_number, s.total_amount, s.customer_name,
                s.created_at, s.payment_method,
                u.name as staff_name,
                COUNT(si.id) as item_count
         FROM sales s
         LEFT JOIN users u ON u.id = s.user_id
         LEFT JOIN sale_items si ON si.sale_id = s.id
         WHERE s.pharmacy_id = $1
         GROUP BY s.id, u.name
         ORDER BY s.created_at DESC LIMIT $2`,
        [pharmacyId, limit]
      );
      res.json({ activity: result.rows });
    } catch(e) { res.json({ error: e.message }, 500); }
  });

  // ══════════════════════════════════════════════════════════
  // ADDON 2 — CREDIT CUSTOMER MANAGER
  // Track drugs given on credit, send WhatsApp reminders
  // ══════════════════════════════════════════════════════════

  app.get('/api/credit', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const result = await query(
        `SELECT * FROM credit_sales
         WHERE pharmacy_id = $1
         ORDER BY due_date ASC`,
        [pharmacyId]
      );
      const total = await query(
        `SELECT COALESCE(SUM(amount_owed),0) as total,
                COUNT(*) as count,
                COUNT(CASE WHEN status='overdue' THEN 1 END) as overdue_count
         FROM credit_sales WHERE pharmacy_id = $1 AND status != 'paid'`,
        [pharmacyId]
      );
      res.json({
        credits: result.rows,
        summary: total.rows[0],
      });
    } catch(e) { res.json({ error: e.message }, 500); }
  });

  app.post('/api/credit', auth, async (req, res) => {
    const { pharmacyId, userId } = req.user;
    const { customer_name, customer_phone, items_description,
            amount_owed, due_date, notes } = req.body;
    if (!customer_name || !amount_owed)
      return res.json({ error: 'Customer name and amount required' }, 400);
    try {
      const result = await query(
        `INSERT INTO credit_sales
          (pharmacy_id, user_id, customer_name, customer_phone,
           items_description, amount_owed, due_date, notes, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING *`,
        [pharmacyId, userId, customer_name, customer_phone || null,
         items_description || null, parseFloat(amount_owed),
         due_date || null, notes || null]
      );
      res.json({ message: '✅ Credit recorded!', credit: result.rows[0] });
    } catch(e) { res.json({ error: e.message }, 500); }
  });

  app.patch('/api/credit/:id/paid', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const { amount_paid } = req.body;
    try {
      const result = await query(
        `UPDATE credit_sales SET
          status = CASE WHEN $1::numeric >= amount_owed THEN 'paid' ELSE 'partial' END,
          amount_paid = COALESCE(amount_paid,0) + $1::numeric,
          paid_at = NOW()
         WHERE id = $2 AND pharmacy_id = $3 RETURNING *`,
        [parseFloat(amount_paid || 0), req.params.id, pharmacyId]
      );
      if (!result.rows.length) return res.json({ error: 'Credit not found' }, 404);
      res.json({ message: '✅ Payment recorded!', credit: result.rows[0] });
    } catch(e) { res.json({ error: e.message }, 500); }
  });

  // Send WhatsApp reminder for overdue credit
  app.post('/api/credit/:id/remind', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const result = await query(
        `SELECT * FROM credit_sales WHERE id = $1 AND pharmacy_id = $2`,
        [req.params.id, pharmacyId]
      );
      if (!result.rows.length) return res.json({ error: 'Credit not found' }, 404);
      const c = result.rows[0];
      if (!c.customer_phone) return res.json({ error: 'No phone number for this customer' }, 400);

      const pharma = await query(
        `SELECT name FROM pharmacies WHERE id = $1`, [pharmacyId]
      );
      const pharmacyName = pharma.rows[0]?.name || 'Your pharmacy';
      const message = `Hello ${c.customer_name}, your balance of UGX ${Number(c.amount_owed).toLocaleString()} at ${pharmacyName} is due. Please pay via MoMo or visit us. Thank you! 🙏`;

      // Send via WhatsApp if configured
      const waToken = process.env.WA_ACCESS_TOKEN;
      const waPhone = process.env.WA_PHONE_NUMBER_ID;
      if (waToken && waPhone) {
        const https = require('https');
        const body = JSON.stringify({
          messaging_product: 'whatsapp',
          to: c.customer_phone.replace(/^0/, '256'),
          type: 'text',
          text: { body: message }
        });
        const options = {
          hostname: 'graph.facebook.com',
          path: `/v18.0/${waPhone}/messages`,
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${waToken}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          }
        };
        await new Promise((resolve) => {
          const req = https.request(options, res => { res.on('data', () => {}); res.on('end', resolve); });
          req.on('error', resolve);
          req.write(body);
          req.end();
        });
      }

      // Update reminder sent date
      await query(
        `UPDATE credit_sales SET last_reminded = NOW() WHERE id = $1`,
        [req.params.id]
      );
      res.json({ message: `✅ Reminder sent to ${c.customer_name}`, whatsapp: !!waToken });
    } catch(e) { res.json({ error: e.message }, 500); }
  });

  // ══════════════════════════════════════════════════════════
  // ADDON 3 — NDA INSPECTION MODE
  // One-tap generates all required NDA documents
  // ══════════════════════════════════════════════════════════

  app.get('/api/nda/report', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const { from, to } = req.query;
    const fromDate = from || new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0];
    const toDate   = to   || new Date().toISOString().split('T')[0];
    try {
      const [pharmaRes, rxSales, allStock, expiring] = await Promise.all([
        query(`SELECT p.*, o.name as org_name FROM pharmacies p JOIN organisations o ON o.id=p.organisation_id WHERE p.id=$1`, [pharmacyId]),
        query(
          `SELECT s.created_at, s.receipt_number, s.customer_name,
                  si.drug_name, si.quantity, si.unit_price,
                  d.requires_rx, d.category
           FROM sales s
           JOIN sale_items si ON si.sale_id = s.id
           LEFT JOIN drugs d ON d.id = si.drug_id
           WHERE s.pharmacy_id = $1
             AND DATE(s.created_at) BETWEEN $2 AND $3
             AND (d.requires_rx = true OR d.category IN ('Antibiotics','Antimalarials','Antivirals'))
           ORDER BY s.created_at DESC`,
          [pharmacyId, fromDate, toDate]
        ),
        query(
          `SELECT name, generic_name, category, quantity, expiry_date,
                  supplier, requires_rx, unit_price, threshold
           FROM drugs WHERE pharmacy_id = $1 ORDER BY category, name`,
          [pharmacyId]
        ),
        query(
          `SELECT name, quantity, expiry_date,
                  (expiry_date - CURRENT_DATE)::int as days_left
           FROM drugs
           WHERE pharmacy_id = $1
             AND expiry_date IS NOT NULL
             AND expiry_date <= CURRENT_DATE + INTERVAL '60 days'
           ORDER BY expiry_date`,
          [pharmacyId]
        ),
      ]);

      res.json({
        pharmacy:        pharmaRes.rows[0],
        period:          { from: fromDate, to: toDate },
        classified_sales: rxSales.rows,
        current_stock:   allStock.rows,
        expiring_stock:  expiring.rows,
        generated_at:    new Date().toISOString(),
      });
    } catch(e) { res.json({ error: e.message }, 500); }
  });

  // ══════════════════════════════════════════════════════════
  // ADDON 4 — EXPIRY INTELLIGENCE
  // Smart near-expiry discount and return-to-supplier tracking
  // ══════════════════════════════════════════════════════════

  app.get('/api/expiry/intelligence', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      // Get sales velocity per drug (avg units sold per week)
      const velocity = await query(
        `SELECT si.drug_id, si.drug_name,
                SUM(si.quantity) as total_sold,
                COUNT(DISTINCT DATE(s.created_at)) as days_active,
                ROUND(SUM(si.quantity)::numeric /
                  GREATEST(COUNT(DISTINCT DATE(s.created_at)),1) * 7, 1) as weekly_velocity
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         WHERE s.pharmacy_id = $1
           AND s.created_at >= NOW() - INTERVAL '60 days'
           AND si.drug_id IS NOT NULL
         GROUP BY si.drug_id, si.drug_name`,
        [pharmacyId]
      );
      // Get drugs expiring within 90 days
      const expiring = await query(
        `SELECT id, name, quantity, expiry_date, unit_price, supplier,
                (expiry_date - CURRENT_DATE)::int as days_left
         FROM drugs
         WHERE pharmacy_id = $1
           AND expiry_date IS NOT NULL
           AND expiry_date > CURRENT_DATE
           AND expiry_date <= CURRENT_DATE + INTERVAL '90 days'
         ORDER BY expiry_date`,
        [pharmacyId]
      );

      // Build recommendations
      const velMap = {};
      for (const v of velocity.rows) velMap[v.drug_id] = parseFloat(v.weekly_velocity);

      const recommendations = expiring.rows.map(d => {
        const weeksLeft = Math.floor(d.days_left / 7);
        const velocity  = velMap[d.id] || 0;
        const canSell   = Math.round(weeksLeft * velocity);
        const surplus   = Math.max(0, d.quantity - canSell);
        let action = 'monitor';
        let suggested_price = d.unit_price;
        if (surplus > 0 && d.days_left <= 30) {
          action = 'discount_now';
          suggested_price = Math.round(d.unit_price * 0.65);
        } else if (surplus > 0 && d.days_left <= 60) {
          action = 'consider_discount';
          suggested_price = Math.round(d.unit_price * 0.80);
        } else if (surplus > 10 && d.days_left <= 90) {
          action = 'return_to_supplier';
        }
        return {
          ...d,
          weekly_velocity: velocity,
          units_sellable:  canSell,
          surplus_units:   surplus,
          action,
          suggested_price,
        };
      });

      res.json({ recommendations, total: recommendations.length });
    } catch(e) { res.json({ error: e.message }, 500); }
  });

  // ══════════════════════════════════════════════════════════
  // ADDON 5 — SEASONAL DEMAND PREDICTOR
  // Uganda malaria seasons + sales history = reorder forecast
  // ══════════════════════════════════════════════════════════

  app.get('/api/forecast', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      // Uganda malaria seasons: Mar-May and Oct-Dec
      const now = new Date();
      const month = now.getMonth() + 1;
      const upcomingSeason =
        month >= 1 && month <= 2  ? { name: 'Long Rains', start: 'March',   weeks: Math.round((new Date(now.getFullYear(),2,1) - now) / 604800000) } :
        month >= 3 && month <= 5  ? { name: 'Long Rains', start: 'ongoing', weeks: 0 } :
        month >= 7 && month <= 9  ? { name: 'Short Rains', start: 'October', weeks: Math.round((new Date(now.getFullYear(),9,1) - now) / 604800000) } :
        month >= 10 && month <= 12 ? { name: 'Short Rains', start: 'ongoing', weeks: 0 } :
        null;

      // Get 12-month sales history for key drugs
      const history = await query(
        `SELECT si.drug_name,
                EXTRACT(MONTH FROM s.created_at) as month,
                SUM(si.quantity) as units_sold
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         WHERE s.pharmacy_id = $1
           AND s.created_at >= NOW() - INTERVAL '12 months'
         GROUP BY si.drug_name, EXTRACT(MONTH FROM s.created_at)
         ORDER BY si.drug_name, month`,
        [pharmacyId]
      );

      // Get current stock
      const stock = await query(
        `SELECT id, name, quantity, threshold FROM drugs
         WHERE pharmacy_id = $1 ORDER BY name`,
        [pharmacyId]
      );

      // Build per-drug forecast
      const drugMap = {};
      for (const row of history.rows) {
        if (!drugMap[row.drug_name]) drugMap[row.drug_name] = {};
        drugMap[row.drug_name][row.month] = parseInt(row.units_sold);
      }

      // Season months for demand multiplier
      const seasonMonths = [3,4,5,10,11,12];
      const forecasts = stock.rows.map(d => {
        const history = drugMap[d.name] || {};
        const avgMonthly = Object.values(history).length
          ? Object.values(history).reduce((a,b)=>a+b,0) / Object.values(history).length
          : 0;
        const isSeasonalDrug = d.name.toLowerCase().includes('coartem') ||
          d.name.toLowerCase().includes('lumartem') ||
          d.name.toLowerCase().includes('artemether') ||
          d.name.toLowerCase().includes('malaria') ||
          d.name.toLowerCase().includes('act');
        const multiplier = isSeasonalDrug && upcomingSeason ? 1.8 : 1.0;
        const forecastNextMonth = Math.round(avgMonthly * multiplier);
        const reorderQty = Math.max(0, forecastNextMonth - d.quantity);
        return {
          drug_id:           d.id,
          drug_name:         d.name,
          current_stock:     d.quantity,
          avg_monthly_sales: Math.round(avgMonthly),
          forecast_next_month: forecastNextMonth,
          reorder_qty:       reorderQty,
          is_seasonal:       isSeasonalDrug,
          urgency:           reorderQty > 0 ? (d.quantity < d.threshold ? 'urgent' : 'recommended') : 'ok',
        };
      });

      res.json({
        season:     upcomingSeason,
        forecasts:  forecasts.filter(f => f.avg_monthly_sales > 0 || f.current_stock > 0),
        generated:  new Date().toISOString(),
      });
    } catch(e) { res.json({ error: e.message }, 500); }
  });

  // ══════════════════════════════════════════════════════════
  // ADDON 6 — URA TAX SUMMARY REPORT
  // Auto-generates monthly tax summary for accountant/URA
  // ══════════════════════════════════════════════════════════

  app.get('/api/tax/summary', auth, async (req, res) => {
    const { pharmacyId, orgId } = req.user;
    const { month, year } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year)  || new Date().getFullYear();
    try {
      const [pharmaRes, salesRes, dailyRes, topDrugs] = await Promise.all([
        query(
          `SELECT p.*, o.name as org_name, o.email FROM pharmacies p
           JOIN organisations o ON o.id=p.organisation_id WHERE p.id=$1`,
          [pharmacyId]
        ),
        query(
          `SELECT
            COUNT(*)                             as transaction_count,
            COALESCE(SUM(total_amount),0)        as gross_revenue,
            COALESCE(SUM(discount_amount),0)     as total_discounts,
            COALESCE(SUM(total_amount - discount_amount),0) as net_revenue,
            COUNT(DISTINCT customer_name)        as unique_customers,
            SUM(CASE WHEN payment_method='momo' THEN total_amount ELSE 0 END) as momo_revenue,
            SUM(CASE WHEN payment_method='cash' THEN total_amount ELSE 0 END) as cash_revenue
           FROM sales
           WHERE pharmacy_id=$1
             AND EXTRACT(MONTH FROM created_at)=$2
             AND EXTRACT(YEAR FROM created_at)=$3`,
          [pharmacyId, m, y]
        ),
        query(
          `SELECT DATE(created_at) as day, SUM(total_amount) as revenue, COUNT(*) as txns
           FROM sales
           WHERE pharmacy_id=$1 AND EXTRACT(MONTH FROM created_at)=$2 AND EXTRACT(YEAR FROM created_at)=$3
           GROUP BY DATE(created_at) ORDER BY day`,
          [pharmacyId, m, y]
        ),
        query(
          `SELECT si.drug_name, SUM(si.quantity) as units, SUM(si.total_price) as revenue
           FROM sale_items si JOIN sales s ON s.id=si.sale_id
           WHERE s.pharmacy_id=$1 AND EXTRACT(MONTH FROM s.created_at)=$2 AND EXTRACT(YEAR FROM s.created_at)=$3
           GROUP BY si.drug_name ORDER BY revenue DESC LIMIT 10`,
          [pharmacyId, m, y]
        ),
      ]);

      const gross = parseFloat(salesRes.rows[0].gross_revenue);
      // Presumptive tax: 1% of gross turnover for businesses UGX 10M-150M/yr
      const annualEstimate = gross * 12;
      const presumptiveTax = annualEstimate >= 10000000 ? Math.round(gross * 0.01) : 0;

      res.json({
        pharmacy:        pharmaRes.rows[0],
        period:          { month: m, year: y, name: new Date(y, m-1).toLocaleString('en', {month:'long', year:'numeric'}) },
        summary:         salesRes.rows[0],
        daily_breakdown: dailyRes.rows,
        top_drugs:       topDrugs.rows,
        tax_estimate: {
          gross_revenue:     gross,
          annual_estimate:   annualEstimate,
          presumptive_rate:  '1%',
          estimated_tax_ugx: presumptiveTax,
          note:              'Consult your accountant. Based on URA presumptive tax regime for businesses with annual turnover UGX 10M-150M.',
        },
        generated_at: new Date().toISOString(),
      });
    } catch(e) { res.json({ error: e.message }, 500); }
  });
