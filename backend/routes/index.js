// MedVault V2 — All API Routes
'use strict';
const https = require('https');

module.exports = function registerRoutes(app) {

  const { query, getPool, getNextReceiptNumber } = require('../database/db');
  const { hash, compare } = require('../core/password');
  const { sign }          = require('../core/jwt');
  const auth              = require('../middleware/auth');

  function callAnthropicAPI(payload) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const req = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01',
        },
      }, (apiRes) => {
        let raw = '';
        apiRes.on('data', chunk => { raw += chunk; });
        apiRes.on('end', () => {
          try {
            resolve({ status: apiRes.statusCode || 500, data: JSON.parse(raw || '{}') });
          } catch (err) {
            resolve({
              status: apiRes.statusCode || 500,
              data: { error: 'Invalid AI response', details: raw.slice(0, 500) },
            });
          }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // ── HEALTH & SETUP ─────────────────────────────────────
  app.get('/health', async (req, res) => {
    try {
      await query('SELECT 1');
      res.json({ status:'ok', service:'MedVault API v2', db:'connected' });
    } catch(e) {
      res.json({ status:'ok', service:'MedVault API v2', db:'error: '+e.message });
    }
  });

  app.get('/api/setup', async (req, res) => {
    try {
      const { runMigrations, seedSuperAdmin } = require('../database/db');
      await runMigrations();
      await seedSuperAdmin();
      const exists = await query(`SELECT id,email FROM users WHERE email = $1`,['admin@medvault.ug']);
      if (exists.rows.length) {
        res.json({ message:'✅ Setup complete!', email:'admin@medvault.ug', password:'MedVault2026!', id: exists.rows[0].id });
      } else {
        res.json({ message:'⚠️ Seed may have failed', hint:'Check DATABASE_URL in Railway Variables' });
      }
    } catch(e) {
      res.json({ error: e.message });
    }
  });

  app.get('/api/dbtest', async (req, res) => {
    try {
      const r = await query('SELECT NOW() as time');
      const u = await query('SELECT COUNT(*) as cnt FROM users').catch(()=>({rows:[{cnt:'table missing'}]}));
      res.json({ status:'connected', time: r.rows[0].time, userCount: u.rows[0].cnt });
    } catch(e) {
      res.json({ status:'error', message: e.message });
    }
  });

  // ── AUTH ────────────────────────────────────────────────
  app.post('/api/auth/register', async (req, res) => {
    const { orgName, ownerName, email, phone, password, plan } = req.body;
    if (!orgName||!ownerName||!email||!phone||!password)
      return res.json({ error:'All fields required: orgName, ownerName, email, phone, password' }, 400);
    try {
      const exists = await query('SELECT id FROM users WHERE email = $1',[email.toLowerCase()]);
      if (exists.rows.length) return res.json({ error:'Email already registered. Please log in.' }, 409);
      const pwHash = await hash(password);
      const selectedPlan = plan || 'single';
      const org = await query(
        `INSERT INTO organisations (name,owner_name,email,phone,plan) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [orgName, ownerName, email.toLowerCase(), phone, selectedPlan]
      );
      const orgId = org.rows[0].id;
      const pharma = await query(
        `INSERT INTO pharmacies (organisation_id,name,address,phone,is_head_office) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [orgId, orgName, req.body.address||'', phone, true]
      );
      const pharmacyId = pharma.rows[0].id;
      const userRes = await query(
        `INSERT INTO users (organisation_id,pharmacy_id,name,email,password_hash,role) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,name,email,role`,
        [orgId, pharmacyId, ownerName, email.toLowerCase(), pwHash, 'owner']
      );
      const user = userRes.rows[0];
      const prices = { drug_shop:20000, single:50000, branch:40000, chain:30000, enterprise:20000 };
      await query(
        `INSERT INTO subscriptions (organisation_id,plan,branch_count,amount_ugx,status) VALUES ($1,$2,$3,$4,$5)`,
        [orgId, selectedPlan, 1, prices[selectedPlan]||50000, 'trial']
      );
      const token = sign({ userId:user.id, orgId, pharmacyId, role:user.role });
      res.json({ message:'✅ Account created! 14-day free trial started.', token,
        user:{ id:user.id, name:user.name, email:user.email, role:user.role, orgId, orgName, pharmacyId, plan:selectedPlan }
      });
    } catch(e) { res.json({ error:'Registration failed: '+e.message }, 500); }
  });

  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email||!password) return res.json({ error:'Email and password required' }, 400);
    try {
      const result = await query(
        `SELECT u.id,u.name,u.email,u.password_hash,u.role,u.organisation_id,u.pharmacy_id,u.is_active,
                o.name as org_name,o.plan,p.name as pharmacy_name
         FROM users u
         JOIN organisations o ON o.id=u.organisation_id
         LEFT JOIN pharmacies p ON p.id=u.pharmacy_id
         WHERE u.email=$1`,
        [email.toLowerCase()]
      );
      if (!result.rows.length) return res.json({ error:'No account found with this email' }, 401);
      const user = result.rows[0];
      if (!user.is_active) return res.json({ error:'Account suspended. Contact support.' }, 403);
      const valid = await compare(password, user.password_hash);
      if (!valid) return res.status(401).json({ error:'Incorrect password' });
      let resolvedPharmacyId   = user.pharmacy_id;
      let resolvedPharmacyName = user.pharmacy_name;
      if (!resolvedPharmacyId) {
        const fb = await query(
          `SELECT id,name FROM pharmacies WHERE organisation_id=$1 AND is_active=true ORDER BY is_head_office DESC,id ASC LIMIT 1`,
          [user.organisation_id]);
        if (fb.rows.length) {
          resolvedPharmacyId   = fb.rows[0].id;
          resolvedPharmacyName = fb.rows[0].name;
          await query(`UPDATE users SET pharmacy_id=$1 WHERE id=$2 AND pharmacy_id IS NULL`,[resolvedPharmacyId,user.id]);
        }
      }
      const token = sign({ userId:user.id, orgId:user.organisation_id, pharmacyId:resolvedPharmacyId, role:user.role });
      res.json({ token, user:{
        id:user.id, name:user.name, email:user.email, role:user.role,
        orgId:user.organisation_id, orgName:user.org_name,
        pharmacyId:resolvedPharmacyId, pharmacyName:resolvedPharmacyName, plan:user.plan
      }});
    } catch(e) { res.status(500).json({ error:'Login failed: '+e.message }); }
  });

  app.get('/api/auth/me', auth, async (req, res) => {
    try {
      const result = await query(
        `SELECT u.id,u.name,u.email,u.role,u.organisation_id,u.pharmacy_id,
                o.name as org_name,o.plan,p.name as pharmacy_name,p.address,p.is_head_office,
                s.status as sub_status,s.trial_ends_at
         FROM users u
         JOIN organisations o ON o.id=u.organisation_id
         LEFT JOIN pharmacies p ON p.id=u.pharmacy_id
         LEFT JOIN subscriptions s ON s.organisation_id=u.organisation_id
         WHERE u.id=$1 ORDER BY s.created_at DESC LIMIT 1`,
        [req.user.userId]
      );
      if (!result.rows.length) return res.json({ error:'User not found' }, 404);
      res.json({ user: result.rows[0] });
    } catch(e) { res.json({ error:e.message }, 500); }
  });

  // ── DASHBOARD ───────────────────────────────────────────
  app.get('/api/dashboard', auth, async (req, res) => {
    const { role } = req.user;
    if (!['owner','manager','cashier'].includes(role)) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    const { pharmacyId } = req.user;
    if (!pharmacyId) return res.status(400).json({ success:false, error:'No pharmacy assigned. Ask your owner to reassign you.', revenueToday:0, transactionsToday:0, lowStockCount:0, expiringCount:0, weeklyRevenue:[], recentSales:[] });
    try {
      const [rev,tx,low,exp,week,recent] = await Promise.all([
        query(`SELECT COALESCE(SUM(total_amount),0) as rev FROM sales WHERE pharmacy_id=$1 AND DATE(created_at)=CURRENT_DATE`,[pharmacyId]),
        query(`SELECT COUNT(*) as cnt FROM sales WHERE pharmacy_id=$1 AND DATE(created_at)=CURRENT_DATE`,[pharmacyId]),
        query(`SELECT COUNT(*) as cnt FROM drugs WHERE pharmacy_id=$1 AND quantity<=threshold`,[pharmacyId]),
        query(`SELECT COUNT(*) as cnt FROM drugs WHERE pharmacy_id=$1 AND expiry_date IS NOT NULL AND expiry_date<=CURRENT_DATE+INTERVAL '30 days' AND expiry_date>=CURRENT_DATE`,[pharmacyId]),
        query(`SELECT DATE(created_at) as day,COALESCE(SUM(total_amount),0) as revenue FROM sales WHERE pharmacy_id=$1 AND created_at>=CURRENT_DATE-INTERVAL '6 days' GROUP BY DATE(created_at) ORDER BY day`,[pharmacyId]),
        query(`SELECT id,customer_name,total_amount,payment_method,created_at FROM sales WHERE pharmacy_id=$1 ORDER BY created_at DESC LIMIT 5`,[pharmacyId]),
      ]);
      res.json({
        revenueToday:parseFloat(rev.rows[0].rev), transactionsToday:parseInt(tx.rows[0].cnt),
        lowStockCount:parseInt(low.rows[0].cnt), expiringCount:parseInt(exp.rows[0].cnt),
        weeklyRevenue:week.rows, recentSales:recent.rows
      });
    } catch(e) { res.json({ error:e.message }, 500); }
  });

  // ── INVENTORY ───────────────────────────────────────────
  app.get('/api/inventory', auth, async (req, res) => {
    const { pharmacyId, role } = req.user;
    if (!['owner','manager','cashier','dispensor'].includes(role)) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    const { search, category } = req.query;
    // ✅ Pagination added — ?page=1&limit=50
    const page  = Math.max(1, parseInt(req.query.page  || '1'));
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50')));
    const offset = (page - 1) * limit;
    try {
      let countSql = `SELECT COUNT(*) as total FROM drugs WHERE pharmacy_id=$1`;
      let sql = `SELECT *,
        CASE WHEN quantity=0 THEN 'out' WHEN quantity<=threshold THEN 'critical' WHEN quantity<=threshold*1.5 THEN 'low' ELSE 'ok' END as stock_status,
        CASE WHEN expiry_date IS NOT NULL THEN (expiry_date-CURRENT_DATE)::int ELSE 999 END as days_to_expiry
        FROM drugs WHERE pharmacy_id=$1`;
      const params = [pharmacyId]; let i = 2;
      if (search) { sql+=` AND name ILIKE $${i}`; countSql+=` AND name ILIKE $${i}`; params.push('%'+search+'%'); i++; }
      if (category) { sql+=` AND category=$${i}`; countSql+=` AND category=$${i}`; params.push(category); i++; }
      sql += ` ORDER BY name LIMIT $${i} OFFSET $${i+1}`;
      const paginatedParams = [...params, limit, offset];
      const [countRes, result] = await Promise.all([
        query(countSql, params),
        query(sql, paginatedParams),
      ]);
      const total = parseInt(countRes.rows[0].total);
      res.json({ drugs:result.rows, total, page, limit, pages: Math.ceil(total/limit) });
    } catch(e) { res.json({ error:e.message }, 500); }
  });

  app.get('/api/inventory/alerts', auth, async (req, res) => {
    const { pharmacyId, role } = req.user;
    if (!['owner','manager','cashier'].includes(role)) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    try {
      const [low,exp] = await Promise.all([
        query(`SELECT * FROM drugs WHERE pharmacy_id=$1 AND quantity<=threshold ORDER BY quantity`,[pharmacyId]),
        query(`SELECT *,(expiry_date-CURRENT_DATE)::int as days_left FROM drugs WHERE pharmacy_id=$1 AND expiry_date<=CURRENT_DATE+INTERVAL '30 days' AND expiry_date>=CURRENT_DATE ORDER BY expiry_date`,[pharmacyId]),
      ]);
      res.json({ lowStock:low.rows, expiring:exp.rows });
    } catch(e) { res.json({ error:e.message }, 500); }
  });

 

// UPDATE INVENTORY ITEM
  app.put('/api/inventory/:id', auth, async (req, res) => {
    const { pharmacyId, role } = req.user;
    if (!['owner','manager'].includes(role)) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const {
    name,
    generic_name,
    category,
    quantity,
    unit_price,
    cost_price,
    expiry_date,
    supplier,
    threshold,
    requires_rx
  } = req.body;

  try {
    const result = await query(
      `UPDATE drugs
       SET
         name=$1,
         generic_name=$2,
         category=$3,
         quantity=$4,
         unit_price=$5,
         cost_price=$6,
         expiry_date=$7,
         supplier=$8,
         threshold=$9,
         requires_rx=$10,
         updated_at=NOW()
       WHERE id=$11 AND pharmacy_id=$12
       RETURNING *`,
      [
        name,
        generic_name,
        category,
        parseInt(quantity),
        parseFloat(unit_price),
        parseFloat(cost_price || 0),
        expiry_date || null,
        supplier,
        parseInt(threshold || 20),
        Boolean(requires_rx),
        req.params.id,
        pharmacyId
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Drug not found' });
    }

    res.json({
      message: '✅ Updated!',
      drug: result.rows[0]
    });

  } catch (e) {
    console.error('Update drug error:', e.message);

    res.status(500).json({
      error: e.message
    });
  }
});


// ADD NEW DRUG + INITIAL BATCH
app.post('/api/inventory', auth, async (req, res) => {
  const { role } = req.user;
  if (!['owner','manager'].includes(role)) {
    return res.status(403).json({ error: 'Not allowed' });
  }

  const {
    name,
    generic_name,
    category,
    quantity,
    unit_price,
    cost_price,
    threshold,
    expiry_date,
    supplier,
    barcode,
    sku,
    batch_number,
  } = req.body;

  // Validate / auto-generate batch_number
  const finalBatchNumber = (batch_number && typeof batch_number === 'string' && batch_number.trim())
    ? batch_number.trim()
    : `BN-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;

  try {

    // ── Idempotency guard ────────────────────────────────────────────────────
    // If a drug with the same name already exists for this pharmacy, return
    // that record instead of inserting a duplicate. This is the safety net for
    // any offline-sync retry that somehow fires twice.
    const existing = await query(
      `SELECT id, name FROM drugs WHERE pharmacy_id=$1 AND LOWER(name)=LOWER($2) LIMIT 1`,
      [req.user.pharmacyId, name]
    );
    if (existing.rows.length) {
      return res.json({
        success: true,
        message: '✅ Drug already exists (idempotent)',
        drug: { id: existing.rows[0].id, batch_number: finalBatchNumber },
        id: existing.rows[0].id,
        _idempotent: true,
      });
    }
    // ────────────────────────────────────────────────────────────────────────

    // 1. Create drug (batch_number lives in drug_batches, not drugs table)
    const drugResult = await query(
      `INSERT INTO drugs (
        pharmacy_id,
        name,
        generic_name,
        category,
        quantity,
        unit_price,
        cost_price,
        threshold,
        barcode,
        sku,
        supplier,
        expiry_date
      )
      VALUES (
        $1,$2,$3,$4,$5,
        $6,$7,$8,$9,$10,
        $11,$12
      )
      RETURNING id`,
      [
        req.user.pharmacyId,
        name,
        generic_name || null,
        category || 'General',
        parseInt(quantity) || 0,
        parseFloat(unit_price) || 0,
        parseFloat(cost_price || 0),
        parseInt(threshold || 20),
        barcode || null,
        sku || null,
        supplier || null,
        expiry_date || null
      ]
    );

    const drugId = drugResult.rows[0].id;

    // 2. Create first batch in drug_batches
    // expiry_date NOT NULL in schema — use far-future date if not provided
    const safeExpiry = expiry_date || '2099-12-31';
    await query(
      `INSERT INTO drug_batches (
        drug_id,
        pharmacy_id,
        batch_number,
        expiry_date,
        quantity,
        cost_price
      )
      VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        drugId,
        req.user.pharmacyId,
        finalBatchNumber,
        safeExpiry,
        parseInt(quantity) || 0,
        parseFloat(cost_price || 0)
      ]
    );
  
    // Note: batch/:id update endpoint is defined later in this file.

    // Audit log
    const { audit, getIp } = require('../utils/audit');
    audit({ orgId:req.user.orgId, pharmacyId:req.user.pharmacyId, userId:req.user.userId,
            action:'drug.create', entity:'drug', entityId:drugId,
            payload:{ name, quantity, unit_price }, ip:getIp(req) });

    res.json({
      success: true,
      message: '✅ Drug added successfully',
      drug: { id: drugId, batch_number: finalBatchNumber },
      id: drugId
    });

  } catch (e) {

    console.error('Error adding drug:', e.message);

    res.status(500).json({
      error: e.message
    });
  }
});


  app.delete('/api/inventory/:id', auth, async (req, res) => {
    const { pharmacyId, orgId, userId } = req.user;
    try {
      const existing = await query(`SELECT name FROM drugs WHERE id=$1 AND pharmacy_id=$2`,[req.params.id,pharmacyId]);
      const result = await query(`DELETE FROM drugs WHERE id=$1 AND pharmacy_id=$2 RETURNING id`,[req.params.id,pharmacyId]);
      if (!result.rows.length) return res.json({ error:'Not found' }, 404);
      const { audit, getIp } = require('../utils/audit');
      audit({ orgId, pharmacyId, userId, action:'drug.delete', entity:'drug', entityId:req.params.id,
              payload:{ name: existing.rows[0]?.name }, ip:getIp(req) });
      res.json({ success:true, message:'✅ Deleted' });
    } catch(e) { res.json({ error:e.message }, 500); }
  });

  // ── SALES ───────────────────────────────────────────────
  app.get('/api/sales', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    // ✅ Pagination added — ?page=1&limit=50
    const page  = Math.max(1, parseInt(req.query.page  || '1'));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50')));
    const offset = (page - 1) * limit;
    try {
      const [countRes, result] = await Promise.all([
        query(`SELECT COUNT(*) as total FROM sales WHERE pharmacy_id=$1 AND voided=false`, [pharmacyId]),
        query(
          `SELECT s.*,json_agg(json_build_object('drug_name',si.drug_name,'quantity',si.quantity,'unit_price',si.unit_price,'total_price',si.total_price)) as items
           FROM sales s LEFT JOIN sale_items si ON si.sale_id=s.id
           WHERE s.pharmacy_id=$1 AND s.voided=false
           GROUP BY s.id ORDER BY s.created_at DESC LIMIT $2 OFFSET $3`,
          [pharmacyId, limit, offset]
        ),
      ]);
      const total = parseInt(countRes.rows[0].total);
      res.json({ sales:result.rows, total, page, limit, pages: Math.ceil(total/limit) });
    } catch(e) { res.json({ error:e.message }, 500); }
  });

  app.post('/api/sales', auth, async (req, res) => {
    const { pharmacyId, userId, orgId, role } = req.user;
    if (role === 'cashier')
      return res.status(403).json({ success:false, error:'Cashiers cannot record sales directly. Use the dispatch queue.' });
    const { customer_name,customer_phone,items,discount_pct,payment_method,subtotal,discount_amount,total_amount } = req.body;
    if (!items||!items.length) return res.status(400).json({ success:false, error:'No items provided' });

    // ✅ FIXED: Full DB transaction — if anything fails, stock is NOT decremented
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // ✅ FIXED: Atomic receipt number — no race condition
      const receiptNum = await getNextReceiptNumber(pharmacyId, client);

      const sale = await client.query(
        `INSERT INTO sales (pharmacy_id,user_id,receipt_number,customer_name,customer_phone,subtotal,discount_pct,discount_amount,total_amount,payment_method)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [pharmacyId,userId||null,receiptNum,customer_name||'Walk-in',customer_phone||null,
         parseFloat(subtotal||0),parseFloat(discount_pct||0),parseFloat(discount_amount||0),parseFloat(total_amount||0),payment_method||'cash']
      );
      const saleId = sale.rows[0].id;

      for (const item of items) {
        await client.query(
          `INSERT INTO sale_items (sale_id,drug_id,drug_name,quantity,unit_price,total_price) VALUES ($1,$2,$3,$4,$5,$6)`,
          [saleId, item.drug_id||null, item.drug_name, item.quantity, item.unit_price, item.unit_price*item.quantity]
        );
        if (item.drug_id) {
          await client.query(
            `UPDATE drugs SET quantity=GREATEST(0,quantity-$1),updated_at=NOW(),updated_by=$4 WHERE id=$2 AND pharmacy_id=$3`,
            [item.quantity, item.drug_id, pharmacyId, userId||null]
          );
        }
      }

      await client.query('COMMIT');

      // Audit log (fire-and-forget, outside transaction)
      const { audit, getIp } = require('../utils/audit');
      audit({ orgId, pharmacyId, userId, action:'sale.create', entity:'sale', entityId:saleId,
              payload:{ receipt:receiptNum, total:total_amount, items:items.length }, ip:getIp(req) });

      res.json({ success:true, message:'✅ Sale recorded!', sale:sale.rows[0], receipt_number:receiptNum });
    } catch(e) {
      await client.query('ROLLBACK');
      console.error('Sale failed:', e.message);
      res.status(500).json({ success:false, error:'Sale failed: '+e.message, code:'SALE_ERROR' });
    } finally {
      client.release();
    }
  });

  // ── ORDERS ──────────────────────────────────────────────
  app.get('/api/orders', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const result = await query(
        `SELECT o.*,json_agg(json_build_object('drug_name',oi.drug_name,'quantity',oi.quantity,'unit_price',oi.unit_price)) as items
         FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id
         WHERE o.pharmacy_id=$1 GROUP BY o.id ORDER BY o.created_at DESC`,
        [pharmacyId]
      );
      res.json({ orders:result.rows });
    } catch(e) { res.json({ error:e.message }, 500); }
  });

  app.post('/api/orders/public/:pharmacyId', async (req, res) => {
    const pharmacyId = parseInt(req.params.pharmacyId);
    const { customer_name,customer_phone,delivery_address,delivery_type,payment_method,items,total_amount,notes } = req.body;
    if (!customer_name||!customer_phone||!items?.length) return res.json({ error:'Name, phone and items required' }, 400);
    try {
      const order = await query(
        `INSERT INTO orders (pharmacy_id,customer_name,customer_phone,delivery_address,delivery_type,payment_method,total_amount,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [pharmacyId,customer_name,customer_phone,delivery_address||'',delivery_type||'delivery',payment_method||'cash',parseFloat(total_amount||0),notes||null]
      );
      for (const item of items) await query(`INSERT INTO order_items (order_id,drug_id,drug_name,quantity,unit_price) VALUES ($1,$2,$3,$4,$5)`,
        [order.rows[0].id,item.drug_id||null,item.drug_name,item.quantity,item.unit_price]);
      res.json({ message:'✅ Order placed!', order:order.rows[0] });
    } catch(e) { res.json({ error:e.message }, 500); }
  });

  app.patch('/api/orders/:id/status', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const { status } = req.body;
    try {
      const result = await query(`UPDATE orders SET order_status=$1 WHERE id=$2 AND pharmacy_id=$3 RETURNING *`,[status,req.params.id,pharmacyId]);
      if (!result.rows.length) return res.json({ error:'Not found' }, 404);
      res.json({ message:'✅ Updated!', order:result.rows[0] });
    } catch(e) { res.json({ error:e.message }, 500); }
  });

  // ── CUSTOMERS ───────────────────────────────────────────
  // ── CUSTOMERS ───────────────────────────────────────────
  app.get('/api/customers', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const { search } = req.query;
    try {
      let sql = `SELECT id, pharmacy_id, name, phone, email, notes, total_spent,
                 visit_count AS order_count, created_at, updated_at
                 FROM customers WHERE pharmacy_id=$1`;
      const params = [pharmacyId];
      if (search) { sql += ` AND (name ILIKE $2 OR phone ILIKE $2)`; params.push('%' + search + '%'); }
      sql += ' ORDER BY total_spent DESC';
      const result = await query(sql, params);
      res.json({ customers: result.rows });
    } catch(e) { res.json({ error: e.message }, 500); }
  });

  // Customer stats summary
  app.get('/api/customers/stats', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const [totals, newThisMonth, topSpenders] = await Promise.all([
        query(`SELECT COUNT(*) as total_customers,
                      COALESCE(SUM(total_spent),0) as total_revenue,
                      COALESCE(SUM(visit_count),0) as total_visits
               FROM customers WHERE pharmacy_id=$1`, [pharmacyId]),
        query(`SELECT COUNT(*) as new_this_month FROM customers
               WHERE pharmacy_id=$1 AND DATE_TRUNC('month',created_at)=DATE_TRUNC('month',NOW())`, [pharmacyId]),
        query(`SELECT name, phone, total_spent, visit_count FROM customers
               WHERE pharmacy_id=$1 ORDER BY total_spent DESC LIMIT 5`, [pharmacyId]),
      ]);
      res.json({
        total_customers: parseInt(totals.rows[0].total_customers),
        total_revenue: parseFloat(totals.rows[0].total_revenue),
        total_visits: parseInt(totals.rows[0].total_visits),
        new_this_month: parseInt(newThisMonth.rows[0].new_this_month),
        top_spenders: topSpenders.rows,
      });
    } catch(e) { res.json({ error: e.message }, 500); }
  });

  // Manually add/edit a customer (from the customer management UI)
  app.post('/api/customers/manual', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const { name, phone, email, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    try {
      // Check for duplicate by phone (if provided) or name
      const existing = phone
        ? await query(`SELECT id FROM customers WHERE pharmacy_id=$1 AND phone=$2 LIMIT 1`, [pharmacyId, phone])
        : await query(`SELECT id FROM customers WHERE pharmacy_id=$1 AND name ILIKE $2 LIMIT 1`, [pharmacyId, name]);
      if (existing.rows.length) {
        return res.status(409).json({ error: 'Customer with this phone/name already exists' });
      }
      const r = await query(
        `INSERT INTO customers (pharmacy_id, name, phone, email, notes, visit_count, total_spent)
         VALUES ($1,$2,$3,$4,$5,0,0) RETURNING *`,
        [pharmacyId, name.trim(), phone || null, email || null, notes || null]
      );
      res.json({ customer: r.rows[0], created: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Update customer details
  app.put('/api/customers/:id', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const { name, phone, email, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    try {
      const r = await query(
        `UPDATE customers SET name=$1, phone=$2, email=$3, notes=$4, updated_at=NOW()
         WHERE id=$5 AND pharmacy_id=$6 RETURNING *`,
        [name.trim(), phone || null, email || null, notes || null, req.params.id, pharmacyId]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Customer not found' });
      res.json({ customer: r.rows[0], updated: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Delete customer
  app.delete('/api/customers/:id', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const r = await query(`DELETE FROM customers WHERE id=$1 AND pharmacy_id=$2 RETURNING id`, [req.params.id, pharmacyId]);
      if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
      res.json({ message: '✅ Customer deleted' });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Upsert a customer from a sale (called internally when completing sales with named customers)
  app.post('/api/customers', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const { name, phone, email, total_spent } = req.body;
    if (!name && !phone) return res.status(400).json({ error: 'Name or phone required' });
    try {
      const existing = phone
        ? await query(`SELECT id, name FROM customers WHERE pharmacy_id=$1 AND phone=$2 LIMIT 1`, [pharmacyId, phone])
        : await query(`SELECT id, name FROM customers WHERE pharmacy_id=$1 AND name=$2 AND (phone IS NULL OR phone='') LIMIT 1`, [pharmacyId, name]);
      if (existing.rows.length) {
        const cid = existing.rows[0].id;
        await query(
          `UPDATE customers SET name=$1, visit_count=visit_count+1, total_spent=total_spent+$2, updated_at=NOW() WHERE id=$3`,
          [name || existing.rows[0].name, parseFloat(total_spent || 0), cid]
        );
        res.json({ customer: { id: cid }, updated: true });
      } else {
        const r = await query(
          `INSERT INTO customers (pharmacy_id, name, phone, email, visit_count, total_spent)
           VALUES ($1,$2,$3,$4,1,$5) RETURNING id`,
          [pharmacyId, name || 'Walk-in', phone || null, email || null, parseFloat(total_spent || 0)]
        );
        res.json({ customer: r.rows[0], created: true });
      }
    } catch(e) { res.json({ error: e.message }); }
  });

  // ── BRANCHES ────────────────────────────────────────────
  app.get('/api/branches', auth, async (req, res) => {
    const { orgId } = req.user;
    try {
      const result = await query(
        `SELECT p.*,
          (SELECT COUNT(*) FROM drugs d WHERE d.pharmacy_id=p.id) as drug_count,
          (SELECT COALESCE(SUM(s.total_amount),0) FROM sales s WHERE s.pharmacy_id=p.id AND DATE(s.created_at)=CURRENT_DATE) as revenue_today
         FROM pharmacies p WHERE p.organisation_id=$1 ORDER BY p.is_head_office DESC,p.name`,
        [orgId]
      );
      res.json({ branches:result.rows });
    } catch(e) { res.json({ error:e.message }, 500); }
  });

  app.post('/api/branches', auth, async (req, res) => {
    const { orgId, role } = req.user;
    if (!['owner','super_admin'].includes(role)) return res.json({ error:'Owner only' }, 403);
    const { name,address,phone } = req.body;
    if (!name) return res.json({ error:'Branch name required' }, 400);
    try {
      const result = await query(
        `INSERT INTO pharmacies (organisation_id,name,address,phone) VALUES ($1,$2,$3,$4) RETURNING *`,
        [orgId,name,address||'',phone||'']
      );
      res.json({ message:'✅ Branch added!', branch:result.rows[0] });
    } catch(e) { res.json({ error:e.message }, 500); }
  });

  app.get('/api/org/summary', auth, async (req, res) => {
    const { orgId } = req.user;
    try {
      const [branches,totalRev,totalDrugs,lowStock] = await Promise.all([
        query(`SELECT COUNT(*) as cnt FROM pharmacies WHERE organisation_id=$1`,[orgId]),
        query(`SELECT COALESCE(SUM(s.total_amount),0) as total FROM sales s JOIN pharmacies p ON p.id=s.pharmacy_id WHERE p.organisation_id=$1 AND DATE(s.created_at)=CURRENT_DATE`,[orgId]),
        query(`SELECT COUNT(*) as cnt FROM drugs d JOIN pharmacies p ON p.id=d.pharmacy_id WHERE p.organisation_id=$1`,[orgId]),
        query(`SELECT COUNT(*) as cnt FROM drugs d JOIN pharmacies p ON p.id=d.pharmacy_id WHERE p.organisation_id=$1 AND d.quantity<=d.threshold`,[orgId]),
      ]);
      res.json({ branchCount:parseInt(branches.rows[0].cnt), totalRevenueToday:parseFloat(totalRev.rows[0].total), totalDrugs:parseInt(totalDrugs.rows[0].cnt), lowStockCount:parseInt(lowStock.rows[0].cnt) });
    } catch(e) { res.json({ error:e.message }, 500); }
  });

  // ── STOCK TRANSFERS ─────────────────────────────────────
  app.get('/api/transfers', auth, async (req, res) => {
    const { orgId } = req.user;
    try {
      const result = await query(
        `SELECT st.*,fp.name as from_branch,tp.name as to_branch FROM stock_transfers st
         JOIN pharmacies fp ON fp.id=st.from_pharmacy_id JOIN pharmacies tp ON tp.id=st.to_pharmacy_id
         WHERE st.organisation_id=$1 ORDER BY st.created_at DESC LIMIT 50`,
        [orgId]
      );
      res.json({ transfers:result.rows });
    } catch(e) { res.json({ error:e.message }, 500); }
  });

  app.post('/api/transfers', auth, async (req, res) => {
    const { orgId, userId } = req.user;
    const { from_pharmacy_id,to_pharmacy_id,drug_id,quantity,notes } = req.body;
    if (!from_pharmacy_id||!to_pharmacy_id||!drug_id||!quantity) return res.json({ error:'All fields required' }, 400);
    try {
      const drug = await query(`SELECT * FROM drugs WHERE id=$1 AND pharmacy_id=$2`,[drug_id,from_pharmacy_id]);
      if (!drug.rows.length) return res.json({ error:'Drug not found in source branch' }, 404);
      if (drug.rows[0].quantity < quantity) return res.json({ error:`Only ${drug.rows[0].quantity} units available` }, 400);
      const result = await query(
        `INSERT INTO stock_transfers (organisation_id,from_pharmacy_id,to_pharmacy_id,drug_id,drug_name,quantity,requested_by,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [orgId,from_pharmacy_id,to_pharmacy_id,drug_id,drug.rows[0].name,quantity,userId,notes||null]
      );
      res.json({ message:'✅ Transfer requested!', transfer:result.rows[0] });
    } catch(e) { res.json({ error:e.message }, 500); }
  });

  app.patch('/api/transfers/:id/approve', auth, async (req, res) => {
    const { orgId, userId } = req.user;
    try {
      const tx = await query(`SELECT * FROM stock_transfers WHERE id=$1 AND organisation_id=$2 AND status='pending'`,[req.params.id,orgId]);
      if (!tx.rows.length) return res.json({ error:'Not found or already processed' }, 404);
      const t = tx.rows[0];
      await query(`UPDATE drugs SET quantity=GREATEST(0,quantity-$1),updated_at=NOW() WHERE id=$2 AND pharmacy_id=$3`,[t.quantity,t.drug_id,t.from_pharmacy_id]);
      const dest = await query(`SELECT id FROM drugs WHERE pharmacy_id=$1 AND name=$2`,[t.to_pharmacy_id,t.drug_name]);
      if (dest.rows.length) await query(`UPDATE drugs SET quantity=quantity+$1,updated_at=NOW() WHERE id=$2`,[t.quantity,dest.rows[0].id]);
      await query(`UPDATE stock_transfers SET status='approved',approved_by=$1 WHERE id=$2`,[userId,t.id]);
      res.json({ message:'✅ Transfer approved!' });
    } catch(e) { res.json({ error:e.message }, 500); }
  });

  // ── STAFF ───────────────────────────────────────────────
  app.get('/api/staff', auth, async (req, res) => {
    const { orgId } = req.user;
    try {
      const result = await query(
        `SELECT u.id,u.name,u.email,u.role,u.is_active,u.created_at,p.name as pharmacy_name
         FROM users u LEFT JOIN pharmacies p ON p.id=u.pharmacy_id
         WHERE u.organisation_id=$1 ORDER BY u.created_at DESC`,
        [orgId]
      );
      res.json({ staff:result.rows });
    } catch(e) { res.json({ error:e.message }, 500); }
  });

  app.post('/api/staff/invite', auth, async (req, res) => {
    const { orgId, pharmacyId: ownerPharmacyId, role } = req.user;
    if (!['owner','super_admin'].includes(role)) return res.json({ error:'Owner only' }, 403);
    const { name,email,password,staffRole,pharmacyId } = req.body;
    if (!name||!email||!password) return res.status(400).json({ error:'Name, email and password required' });
    try {
      const exists = await query(`SELECT id FROM users WHERE email=$1`,[email.toLowerCase()]);
      if (exists.rows.length) return res.status(409).json({ error:'Email already registered' });
      const pw = await hash(password);
      const assignedPharmacyId = pharmacyId || ownerPharmacyId;
      const result = await query(
        `INSERT INTO users (organisation_id,pharmacy_id,name,email,password_hash,role) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,name,email,role`,
        [orgId, assignedPharmacyId, name, email.toLowerCase(), pw, staffRole||'staff']
      );
      res.json({ success:true, message:'✅ Staff member added!', user:result.rows[0] });
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  app.patch('/api/staff/:id/deactivate', auth, async (req, res) => {
    const { orgId } = req.user;
    try {
      await query(`UPDATE users SET is_active=false WHERE id=$1 AND organisation_id=$2`,[req.params.id,orgId]);
      res.json({ message:'✅ Deactivated' });
    } catch(e) { res.json({ error:e.message }, 500); }
  });

  app.patch('/api/staff/:id/activate', auth, async (req, res) => {
    const { orgId } = req.user;
    try {
      await query(`UPDATE users SET is_active=true WHERE id=$1 AND organisation_id=$2`,[req.params.id,orgId]);
      res.json({ message:'✅ Reactivated' });
    } catch(e) { res.json({ error:e.message }, 500); }
  });

  // ── CREDIT ──────────────────────────────────────────────
  app.get('/api/credit', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const [credits,summary] = await Promise.all([
        query(`SELECT * FROM credit_sales WHERE pharmacy_id=$1 ORDER BY due_date`,[pharmacyId]),
        query(`SELECT COALESCE(SUM(amount_owed),0) as total,COUNT(*) as count,COUNT(CASE WHEN status='overdue' THEN 1 END) as overdue_count FROM credit_sales WHERE pharmacy_id=$1 AND status!='paid'`,[pharmacyId]),
      ]);
      res.json({ credits:credits.rows, summary:summary.rows[0] });
    } catch(e) { res.json({ error:e.message }, 500); }
  });

  app.post('/api/credit', auth, async (req, res) => {
    const { pharmacyId, userId } = req.user;
    const { customer_name,customer_phone,items_description,amount_owed,due_date,notes } = req.body;
    if (!customer_name||!amount_owed) return res.json({ error:'Customer name and amount required' }, 400);
    try {
      const result = await query(
        `INSERT INTO credit_sales (pharmacy_id,user_id,customer_name,customer_phone,items_description,amount_owed,due_date,notes,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING *`,
        [pharmacyId,userId,customer_name,customer_phone||null,items_description||null,parseFloat(amount_owed),due_date||null,notes||null]
      );
      res.json({ message:'✅ Credit recorded!', credit:result.rows[0] });
    } catch(e) { res.json({ error:e.message }, 500); }
  });

  app.patch('/api/credit/:id/paid', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const { amount_paid } = req.body;
    try {
      const result = await query(
        `UPDATE credit_sales SET status=CASE WHEN $1::numeric>=amount_owed THEN 'paid' ELSE 'partial' END,amount_paid=COALESCE(amount_paid,0)+$1::numeric,paid_at=NOW()
         WHERE id=$2 AND pharmacy_id=$3 RETURNING *`,
        [parseFloat(amount_paid||0),req.params.id,pharmacyId]
      );
      if (!result.rows.length) return res.json({ error:'Not found' }, 404);
      res.json({ message:'✅ Payment recorded!', credit:result.rows[0] });
    } catch(e) { res.json({ error:e.message }, 500); }
  });

  app.post('/api/credit/:id/remind', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const c = await query(`SELECT * FROM credit_sales WHERE id=$1 AND pharmacy_id=$2`,[req.params.id,pharmacyId]);
      if (!c.rows.length) return res.json({ error:'Not found' }, 404);
      await query(`UPDATE credit_sales SET last_reminded=NOW() WHERE id=$1`,[req.params.id]);
      res.json({ message:`✅ Reminder logged for ${c.rows[0].customer_name}`, whatsapp: false });
    } catch(e) { res.json({ error:e.message }, 500); }
  });

  // ── VARIANCE ────────────────────────────────────────────
  // ════════════════════════════════════════════════════════════
  // CASHIER SHIFTS
  // ════════════════════════════════════════════════════════════

  app.post('/api/shifts/open', auth, async (req, res) => {
    const { pharmacyId, userId, role } = req.user;
    if (!['owner','manager','cashier'].includes(role))
      return res.status(403).json({ error:'Cashier, manager or owner only' });
    const { opening_cash } = req.body;
    try {
      await query(`UPDATE cashier_shifts SET status='closed',closed_at=NOW()
                   WHERE pharmacy_id=$1 AND user_id=$2 AND status='open'`,
        [pharmacyId, userId]);
      const r = await query(
        `INSERT INTO cashier_shifts (pharmacy_id,user_id,opening_cash,status)
         VALUES ($1,$2,$3,'open') RETURNING *`,
        [pharmacyId, userId, parseFloat(opening_cash||0)]);
      res.json({ success:true, shift:r.rows[0] });
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  app.get('/api/shifts/current', auth, async (req, res) => {
    const { pharmacyId, userId } = req.user;
    try {
      const r = await query(
        `SELECT cs.*, u.name as cashier_name,
                COALESCE(SUM(s.total_amount::float),0) as sales_total,
                COUNT(s.id) as sale_count
         FROM cashier_shifts cs
         LEFT JOIN users u ON u.id=cs.user_id
         LEFT JOIN sales s ON s.shift_id=cs.id
         WHERE cs.pharmacy_id=$1 AND cs.user_id=$2 AND cs.status='open'
         GROUP BY cs.id,u.name ORDER BY cs.opened_at DESC LIMIT 1`,
        [pharmacyId, userId]);
      res.json({ shift: r.rows[0]||null });
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  app.post('/api/shifts/close', auth, async (req, res) => {
    const { pharmacyId, userId, role } = req.user;
    if (!['owner','manager','cashier'].includes(role))
      return res.status(403).json({ error:'Not allowed' });
    const { closing_cash, notes } = req.body;
    try {
      const sr = await query(
        `SELECT cs.id, COALESCE(SUM(s.total_amount::float),0) as total_sales,
                COUNT(s.id) as transaction_count
         FROM cashier_shifts cs LEFT JOIN sales s ON s.shift_id=cs.id
         WHERE cs.pharmacy_id=$1 AND cs.user_id=$2 AND cs.status='open'
         GROUP BY cs.id ORDER BY cs.id DESC LIMIT 1`,
        [pharmacyId, userId]);
      if (!sr.rows.length) return res.status(404).json({ error:'No open shift' });
      const { id, total_sales, transaction_count } = sr.rows[0];
      const r = await query(
        `UPDATE cashier_shifts SET status='closed',closed_at=NOW(),
         closing_cash=$1,total_sales=$2,transaction_count=$3,notes=$4
         WHERE id=$5 RETURNING *`,
        [parseFloat(closing_cash||0), parseFloat(total_sales),
         parseInt(transaction_count), notes||null, id]);
      res.json({ success:true, shift:r.rows[0] });
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  app.get('/api/shifts', auth, async (req, res) => {
    const { pharmacyId, role } = req.user;
    if (!['owner','manager','cashier'].includes(role))
      return res.status(403).json({ error:'Not allowed' });
    try {
      const r = await query(
        `SELECT cs.*, u.name as cashier_name, cs.total_sales::float as total_sales
         FROM cashier_shifts cs JOIN users u ON u.id=cs.user_id
         WHERE cs.pharmacy_id=$1 ORDER BY cs.opened_at DESC LIMIT 30`,
        [pharmacyId]);
      res.json({ shifts:r.rows });
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  // ════════════════════════════════════════════════════════════
  // DISPATCH SYSTEM — dispensor sends cart → cashier collects
  // ════════════════════════════════════════════════════════════

  app.post('/api/dispatch', auth, async (req, res) => {
    const { pharmacyId, userId, role } = req.user;
    if (role === 'cashier')
      return res.status(403).json({ error:'Cashiers do not dispense. They collect payment.' });
    const { customer_name, customer_phone, items, discount_pct,
            subtotal, discount_amount, total_amount, notes } = req.body;
    if (!items||!items.length) return res.status(400).json({ error:'No items in cart' });
    try {
      const r = await query(
        `INSERT INTO pending_sales
          (pharmacy_id,dispensor_id,customer_name,customer_phone,
           items,discount_pct,subtotal,discount_amount,total_amount,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [pharmacyId, userId, customer_name||'Walk-in', customer_phone||null,
         JSON.stringify(items), parseFloat(discount_pct||0),
         parseFloat(subtotal||0), parseFloat(discount_amount||0),
         parseFloat(total_amount||0), notes||null]);
      res.json({ success:true, dispatch:r.rows[0] });
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  app.get('/api/dispatch/pending', auth, async (req, res) => {
    const { pharmacyId, role } = req.user;
    if (!['owner','manager','cashier'].includes(role))
      return res.status(403).json({ error:'Not allowed' });
    try {
      const r = await query(
        `SELECT ps.*, u.name as dispensor_name
         FROM pending_sales ps JOIN users u ON u.id=ps.dispensor_id
         WHERE ps.pharmacy_id=$1 AND ps.status='pending'
         ORDER BY ps.created_at ASC`,
        [pharmacyId]);
      res.json({ pending:r.rows });
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  app.get('/api/dispatch/mine', auth, async (req, res) => {
    const { pharmacyId, userId } = req.user;
    try {
      const r = await query(
        `SELECT ps.id, ps.customer_name, ps.total_amount::float as total_amount,
                ps.status, ps.payment_method, ps.collected_at, ps.created_at,
                s.receipt_number
         FROM pending_sales ps LEFT JOIN sales s ON s.id=ps.sale_id
         WHERE ps.pharmacy_id=$1 AND ps.dispensor_id=$2
           AND ps.created_at > NOW()-INTERVAL '12 hours'
         ORDER BY ps.created_at DESC LIMIT 20`,
        [pharmacyId, userId]);
      res.json({ dispatched:r.rows });
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  app.post('/api/dispatch/:id/collect', auth, async (req, res) => {
    const { pharmacyId, userId, role } = req.user;
    if (!['owner','manager','cashier'].includes(role))
      return res.status(403).json({ error:'Not allowed' });
    const { payment_method } = req.body;
    if (!payment_method) return res.status(400).json({ error:'Payment method required' });
    try {
      const pr = await query(
        `SELECT * FROM pending_sales WHERE id=$1 AND pharmacy_id=$2 AND status='pending'`,
        [req.params.id, pharmacyId]);
      if (!pr.rows.length)
        return res.status(404).json({ error:'Not found or already collected' });
      const ps    = pr.rows[0];
      const items = typeof ps.items==='string' ? JSON.parse(ps.items) : ps.items;
      const { getNextReceiptNumber } = require('../database/db');
      const receipt_number = await getNextReceiptNumber(pharmacyId);

      // Transaction: insert sale + items + deduct stock + mark dispatch done
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        const sr = await client.query(
          `INSERT INTO sales (pharmacy_id,user_id,receipt_number,customer_name,
            customer_phone,subtotal,discount_pct,discount_amount,total_amount,payment_method)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [pharmacyId, userId, receipt_number, ps.customer_name, ps.customer_phone,
           parseFloat(ps.subtotal), parseFloat(ps.discount_pct),
           parseFloat(ps.discount_amount), parseFloat(ps.total_amount), payment_method]);
        const saleId = sr.rows[0].id;
        for (const item of items) {
          await client.query(
            `INSERT INTO sale_items (sale_id,drug_id,drug_name,quantity,unit_price,total_price)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [saleId, item.drug_id||null, item.drug_name, item.quantity,
             parseFloat(item.unit_price), parseFloat(item.unit_price)*item.quantity]);
          if (item.drug_id) {
            await client.query(
              `UPDATE drugs SET quantity=GREATEST(quantity-$1,0),updated_at=NOW()
               WHERE id=$2 AND pharmacy_id=$3`,
              [item.quantity, item.drug_id, pharmacyId]);
          }
        }
        await client.query(
          `UPDATE pending_sales SET status='collected',payment_method=$1,
           collected_at=NOW(),collected_by=$2,sale_id=$3 WHERE id=$4`,
          [payment_method, userId, saleId, ps.id]);
        await client.query('COMMIT');
        res.json({ success:true, sale:{ id:saleId }, receipt_number });
      } catch(e) {
        await client.query('ROLLBACK');
        throw e;
      } finally { client.release(); }
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  app.post('/api/dispatch/:id/cancel', auth, async (req, res) => {
    const { pharmacyId, userId, role } = req.user;
    try {
      const r = await query(
        `UPDATE pending_sales SET status='cancelled',collected_at=NOW()
         WHERE id=$1 AND pharmacy_id=$2 AND status='pending'
           AND (dispensor_id=$3 OR $4 IN ('owner','manager'))
         RETURNING id`,
        [req.params.id, pharmacyId, userId, role]);
      if (!r.rows.length) return res.status(404).json({ error:'Not found or already processed' });
      res.json({ success:true });
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  app.get('/api/variance/daily', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const date = req.query.date || new Date().toISOString().split('T')[0];
    try {
      const sold = await query(
        `SELECT si.drug_id,si.drug_name,SUM(si.quantity) as units_sold FROM sale_items si
         JOIN sales s ON s.id=si.sale_id
         WHERE s.pharmacy_id=$1 AND DATE(s.created_at)=$2 AND si.drug_id IS NOT NULL
         GROUP BY si.drug_id,si.drug_name`,
        [pharmacyId,date]
      );
      const variances = [];
      for (const row of sold.rows) {
        const drug = await query(`SELECT name,quantity FROM drugs WHERE id=$1`,[row.drug_id]);
        if (drug.rows.length) variances.push({ drug_id:row.drug_id, drug_name:row.drug_name, units_sold:parseInt(row.units_sold), current_qty:drug.rows[0].quantity, status:parseInt(row.units_sold)>50?'review':'ok' });
      }
      res.json({ date, variances, total:variances.length });
    } catch(e) { res.json({ error:e.message }, 500); }
  });

  app.post('/api/variance/stockcount', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const { counts } = req.body;
    if (!counts?.length) return res.json({ error:'counts array required' }, 400);
    try {
      const variances = [];
      for (const c of counts) {
        const drug = await query(`SELECT id,name,quantity FROM drugs WHERE id=$1 AND pharmacy_id=$2`,[c.drug_id,pharmacyId]);
        if (!drug.rows.length) continue;
        const d = drug.rows[0];
        const diff = d.quantity - parseInt(c.counted_qty);
        if (Math.abs(diff)>0) {
          variances.push({ drug_id:d.id, drug_name:d.name, system_qty:d.quantity, counted_qty:parseInt(c.counted_qty), variance:diff, flag:diff>0?'shortage':'surplus' });
          await query(`UPDATE drugs SET quantity=$1,updated_at=NOW() WHERE id=$2`,[parseInt(c.counted_qty),d.id]);
        }
      }
      res.json({ message:`Count complete. ${variances.length} variances found.`, variances });
    } catch(e) { res.json({ error:e.message }, 500); }
  });

  app.get('/api/activity', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const result = await query(
        `SELECT s.id,s.receipt_number,s.total_amount,s.customer_name,s.created_at,s.payment_method,u.name as staff_name,COUNT(si.id) as item_count
         FROM sales s LEFT JOIN users u ON u.id=s.user_id LEFT JOIN sale_items si ON si.sale_id=s.id
         WHERE s.pharmacy_id=$1 GROUP BY s.id,u.name ORDER BY s.created_at DESC LIMIT 50`,
        [pharmacyId]
      );
      res.json({ activity:result.rows });
    } catch(e) { res.json({ error:e.message }, 500); }
  });

  // ── NDA REPORT ──────────────────────────────────────────
  app.get('/api/nda/report', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const from = req.query.from || new Date(Date.now()-30*24*60*60*1000).toISOString().split('T')[0];
    const to   = req.query.to   || new Date().toISOString().split('T')[0];
    try {
      const [pharma,rxSales,stock,expiring] = await Promise.all([
        query(`SELECT p.*,o.name as org_name FROM pharmacies p JOIN organisations o ON o.id=p.organisation_id WHERE p.id=$1`,[pharmacyId]),
        query(`SELECT s.created_at,s.receipt_number,s.customer_name,si.drug_name,si.quantity,si.unit_price,d.requires_rx,d.category FROM sales s JOIN sale_items si ON si.sale_id=s.id LEFT JOIN drugs d ON d.id=si.drug_id WHERE s.pharmacy_id=$1 AND DATE(s.created_at) BETWEEN $2 AND $3 AND (d.requires_rx=true OR d.category IN ('Antibiotics','Antimalarials')) ORDER BY s.created_at DESC`,[pharmacyId,from,to]),
        query(`SELECT name,generic_name,category,quantity,expiry_date,supplier,requires_rx,unit_price,threshold FROM drugs WHERE pharmacy_id=$1 ORDER BY category,name`,[pharmacyId]),
        query(`SELECT name,quantity,expiry_date,(expiry_date-CURRENT_DATE)::int as days_left FROM drugs WHERE pharmacy_id=$1 AND expiry_date IS NOT NULL AND expiry_date<=CURRENT_DATE+INTERVAL '60 days' ORDER BY expiry_date`,[pharmacyId]),
      ]);
      res.json({ pharmacy:pharma.rows[0], period:{from,to}, classified_sales:rxSales.rows, current_stock:stock.rows, expiring_stock:expiring.rows });
    } catch(e) { res.json({ error:e.message }, 500); }
  });

  // ── EXPIRY INTELLIGENCE ─────────────────────────────────
  app.get('/api/expiry/intelligence', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const velocity = await query(
        `SELECT si.drug_id,ROUND(SUM(si.quantity)::numeric/GREATEST(COUNT(DISTINCT DATE(s.created_at)),1)*7,1) as weekly_velocity
         FROM sale_items si JOIN sales s ON s.id=si.sale_id
         WHERE s.pharmacy_id=$1 AND s.created_at>=NOW()-INTERVAL '60 days' AND si.drug_id IS NOT NULL
         GROUP BY si.drug_id`,
        [pharmacyId]
      );
      const expiring = await query(
        `SELECT id,name,quantity,expiry_date,unit_price,supplier,(expiry_date-CURRENT_DATE)::int as days_left
         FROM drugs WHERE pharmacy_id=$1 AND expiry_date IS NOT NULL AND expiry_date>CURRENT_DATE AND expiry_date<=CURRENT_DATE+INTERVAL '90 days' ORDER BY expiry_date`,
        [pharmacyId]
      );
      const velMap = {};
      for (const v of velocity.rows) velMap[v.drug_id] = parseFloat(v.weekly_velocity);
      const recommendations = expiring.rows.map(d => {
        const weeksLeft = Math.floor(d.days_left/7);
        const vel = velMap[d.id]||0;
        const canSell = Math.round(weeksLeft*vel);
        const surplus = Math.max(0,d.quantity-canSell);
        let action='monitor', suggested_price=d.unit_price;
        if (surplus>0&&d.days_left<=30) { action='discount_now'; suggested_price=Math.round(d.unit_price*0.65); }
        else if (surplus>0&&d.days_left<=60) { action='consider_discount'; suggested_price=Math.round(d.unit_price*0.80); }
        else if (surplus>10&&d.days_left<=90) action='return_to_supplier';
        return { ...d, weekly_velocity:vel, units_sellable:canSell, surplus_units:surplus, action, suggested_price };
      });
      res.json({ recommendations, total:recommendations.length });
    } catch(e) { res.json({ error:e.message }, 500); }
  });

  // ── FORECAST ────────────────────────────────────────────
  app.get('/api/forecast', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const month = new Date().getMonth()+1;
      const upcomingSeason =
        month>=1&&month<=2  ? { name:'Long Rains',  start:'March',   weeks:Math.round((new Date(new Date().getFullYear(),2,1)-new Date())/604800000) } :
        month>=3&&month<=5  ? { name:'Long Rains',  start:'ongoing', weeks:0 } :
        month>=7&&month<=9  ? { name:'Short Rains', start:'October', weeks:Math.round((new Date(new Date().getFullYear(),9,1)-new Date())/604800000) } :
        month>=10           ? { name:'Short Rains', start:'ongoing', weeks:0 } : null;
      const [history,stock] = await Promise.all([
        query(`SELECT si.drug_name,EXTRACT(MONTH FROM s.created_at) as month,SUM(si.quantity) as units_sold FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.pharmacy_id=$1 AND s.created_at>=NOW()-INTERVAL '12 months' GROUP BY si.drug_name,EXTRACT(MONTH FROM s.created_at)`,[pharmacyId]),
        query(`SELECT id,name,quantity,threshold FROM drugs WHERE pharmacy_id=$1 ORDER BY name`,[pharmacyId]),
      ]);
      const drugMap = {};
      for (const row of history.rows) { if (!drugMap[row.drug_name]) drugMap[row.drug_name]={}; drugMap[row.drug_name][row.month]=parseInt(row.units_sold); }
      const forecasts = stock.rows.map(d => {
        const hist = drugMap[d.name]||{};
        const avgMonthly = Object.values(hist).length ? Object.values(hist).reduce((a,b)=>a+b,0)/Object.values(hist).length : 0;
        const isSeasonal = ['coartem','lumartem','artemether','malaria','act'].some(s=>d.name.toLowerCase().includes(s));
        const multiplier = isSeasonal&&upcomingSeason ? 1.8 : 1.0;
        const forecastNext = Math.round(avgMonthly*multiplier);
        const reorderQty = Math.max(0,forecastNext-d.quantity);
        return { drug_id:d.id, drug_name:d.name, current_stock:d.quantity, avg_monthly_sales:Math.round(avgMonthly), forecast_next_month:forecastNext, reorder_qty:reorderQty, is_seasonal:isSeasonal, urgency:reorderQty>0?(d.quantity<d.threshold?'urgent':'recommended'):'ok' };
      });
      res.json({ season:upcomingSeason, forecasts:forecasts.filter(f=>f.avg_monthly_sales>0||f.current_stock>0) });
    } catch(e) { res.json({ error:e.message }, 500); }
  });

  // ── TAX REPORT ──────────────────────────────────────────
  app.get('/api/tax/summary', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const m = parseInt(req.query.month)||new Date().getMonth()+1;
    const y = parseInt(req.query.year)||new Date().getFullYear();
    try {
      const [pharma,sales,daily,drugs] = await Promise.all([
        query(`SELECT p.*,o.name as org_name FROM pharmacies p JOIN organisations o ON o.id=p.organisation_id WHERE p.id=$1`,[pharmacyId]),
        query(`SELECT COUNT(*) as transaction_count,COALESCE(SUM(total_amount),0) as gross_revenue,COALESCE(SUM(discount_amount),0) as total_discounts,COALESCE(SUM(total_amount-discount_amount),0) as net_revenue,SUM(CASE WHEN payment_method='momo' THEN total_amount ELSE 0 END) as momo_revenue,SUM(CASE WHEN payment_method='cash' THEN total_amount ELSE 0 END) as cash_revenue FROM sales WHERE pharmacy_id=$1 AND EXTRACT(MONTH FROM created_at)=$2 AND EXTRACT(YEAR FROM created_at)=$3`,[pharmacyId,m,y]),
        query(`SELECT DATE(created_at) as day,SUM(total_amount) as revenue,COUNT(*) as txns FROM sales WHERE pharmacy_id=$1 AND EXTRACT(MONTH FROM created_at)=$2 AND EXTRACT(YEAR FROM created_at)=$3 GROUP BY DATE(created_at) ORDER BY day`,[pharmacyId,m,y]),
        query(`SELECT si.drug_name,SUM(si.quantity) as units,SUM(si.total_price) as revenue FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.pharmacy_id=$1 AND EXTRACT(MONTH FROM s.created_at)=$2 AND EXTRACT(YEAR FROM s.created_at)=$3 GROUP BY si.drug_name ORDER BY revenue DESC LIMIT 10`,[pharmacyId,m,y]),
      ]);
      const gross = parseFloat(sales.rows[0].gross_revenue);
      const annualEst = gross*12;
      const tax = annualEst>=10000000 ? Math.round(gross*0.01) : 0;
      res.json({ pharmacy:pharma.rows[0], period:{month:m,year:y}, summary:sales.rows[0], daily_breakdown:daily.rows, top_drugs:drugs.rows, tax_estimate:{ gross_revenue:gross, annual_estimate:annualEst, presumptive_rate:'1%', estimated_tax_ugx:tax, note:'Consult your accountant. Based on URA presumptive tax regime.' } });
    } catch(e) { res.json({ error:e.message }, 500); }
  });

  // ── SUBSCRIPTION ────────────────────────────────────────
  app.get('/api/subscription', auth, async (req, res) => {
    const { orgId } = req.user;
    try {
      const result = await query(
        `SELECT s.*,o.name as org_name,o.plan,(SELECT COUNT(*) FROM pharmacies WHERE organisation_id=$1) as branch_count
         FROM subscriptions s JOIN organisations o ON o.id=s.organisation_id WHERE s.organisation_id=$1 ORDER BY s.created_at DESC LIMIT 1`,
        [orgId]
      );
      res.json({ subscription:result.rows[0]||null });
    } catch(e) { res.json({ error:e.message }, 500); }
  });

  // ── SUPER ADMIN ─────────────────────────────────────────
  function adminOnly(req, res, next) {
    if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Super admin only' });
    next();
  }

  // GET /api/admin/stats — platform overview numbers
  app.get('/api/admin/stats', auth, adminOnly, async (req, res) => {
    try {
      const [orgs, active, trial, overdue, suspended, mrr, totalSales, totalUsers] = await Promise.all([
        query(`SELECT COUNT(*) as cnt FROM organisations WHERE email != 'admin@medvault.ug'`),
        query(`SELECT COUNT(*) as cnt FROM subscriptions s JOIN organisations o ON o.id=s.organisation_id WHERE s.status='active' AND o.email!='admin@medvault.ug'`),
        query(`SELECT COUNT(*) as cnt FROM subscriptions s JOIN organisations o ON o.id=s.organisation_id WHERE s.status='trial' AND o.email!='admin@medvault.ug'`),
        query(`SELECT COUNT(*) as cnt FROM subscriptions s JOIN organisations o ON o.id=s.organisation_id WHERE s.status='overdue' AND o.email!='admin@medvault.ug'`),
        query(`SELECT COUNT(*) as cnt FROM subscriptions s JOIN organisations o ON o.id=s.organisation_id WHERE s.status='suspended' AND o.email!='admin@medvault.ug'`),
        query(`SELECT COALESCE(SUM(s.amount_ugx),0) as mrr FROM subscriptions s JOIN organisations o ON o.id=s.organisation_id WHERE s.status='active' AND o.email!='admin@medvault.ug'`),
        query(`SELECT COALESCE(SUM(total_amount),0) as total FROM sales`),
        query(`SELECT COUNT(*) as cnt FROM users WHERE email!='admin@medvault.ug'`),
      ]);
      res.json({
        totalOrgs:       parseInt(orgs.rows[0].cnt),
        activeCount:     parseInt(active.rows[0].cnt),
        trialCount:      parseInt(trial.rows[0].cnt),
        overdueCount:    parseInt(overdue.rows[0].cnt),
        suspendedCount:  parseInt(suspended.rows[0].cnt),
        mrr:             parseFloat(mrr.rows[0].mrr),
        totalSalesRevenue: parseFloat(totalSales.rows[0].total),
        totalUsers:      parseInt(totalUsers.rows[0].cnt),
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/admin/orgs — full org list with all details
  app.get('/api/admin/orgs', auth, adminOnly, async (req, res) => {
    try {
      const result = await query(`
        SELECT
          o.id, o.name, o.owner_name, o.email, o.phone, o.plan, o.is_active, o.created_at,
          ph.id         AS pharmacy_id,
          ph.address    AS location,
          ph.nda_number AS nda,
          ph.is_active  AS pharmacy_active,
          s.id          AS sub_id,
          s.status      AS sub_status,
          s.amount_ugx,
          s.trial_ends_at,
          s.next_billing,
          (SELECT COUNT(*) FROM pharmacies pp WHERE pp.organisation_id = o.id) AS branch_count,
          (SELECT COUNT(*) FROM users u WHERE u.organisation_id = o.id AND u.email != 'admin@medvault.ug') AS user_count,
          (SELECT COUNT(*) FROM drugs d JOIN pharmacies pp ON pp.id = d.pharmacy_id WHERE pp.organisation_id = o.id) AS drug_count,
          (SELECT COALESCE(SUM(sa.total_amount),0) FROM sales sa JOIN pharmacies pp ON pp.id = sa.pharmacy_id WHERE pp.organisation_id = o.id) AS total_sales,
          (SELECT COUNT(*) FROM sales sa JOIN pharmacies pp ON pp.id = sa.pharmacy_id WHERE pp.organisation_id = o.id) AS sale_count,
          (SELECT MAX(sa.created_at) FROM sales sa JOIN pharmacies pp ON pp.id = sa.pharmacy_id WHERE pp.organisation_id = o.id) AS last_sale_at
        FROM organisations o
        LEFT JOIN pharmacies ph ON ph.organisation_id = o.id AND ph.is_head_office = true
        LEFT JOIN subscriptions s ON s.organisation_id = o.id
        WHERE o.email != 'admin@medvault.ug'
        ORDER BY o.created_at DESC
      `);
      res.json({ orgs: result.rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/admin/users — all users across platform
  app.get('/api/admin/users', auth, adminOnly, async (req, res) => {
    try {
      const result = await query(`
        SELECT u.id, u.name, u.email, u.role, u.is_active, u.created_at,
               o.name AS org_name, p.name AS pharmacy_name
        FROM users u
        JOIN organisations o ON o.id = u.organisation_id
        LEFT JOIN pharmacies p ON p.id = u.pharmacy_id
        WHERE u.email != 'admin@medvault.ug'
        ORDER BY u.created_at DESC
      `);
      res.json({ users: result.rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/admin/orgs — create new organisation + pharmacy + owner user
  app.post('/api/admin/orgs', auth, adminOnly, async (req, res) => {
    const { name, owner_name, email, phone, location, plan, nda } = req.body;
    if (!name || !email || !phone) return res.status(400).json({ error: 'name, email and phone required' });
    const planAmounts = { drug_shop:20000, basic:20000, single:50000, pro:50000, multi:80000, branch:40000, chain:30000, enterprise:150000 };
    const amount = planAmounts[plan] || 50000;
    try {
      const tempPw = name.replace(/\s+/g,'').slice(0,4) + phone.slice(-4) + '!';
      const pwHash = await hash(tempPw);
      const org = await query(
        `INSERT INTO organisations (name,owner_name,email,phone,plan) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [name, owner_name||name, email.toLowerCase(), phone, plan||'pro']
      );
      const orgId = org.rows[0].id;
      const ph = await query(
        `INSERT INTO pharmacies (organisation_id,name,address,phone,nda_number,is_head_office) VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
        [orgId, name, location||'Uganda', phone, nda||null]
      );
      const pharmacyId = ph.rows[0].id;
      await query(
        `INSERT INTO users (organisation_id,pharmacy_id,name,email,password_hash,role) VALUES ($1,$2,$3,$4,$5,'owner')`,
        [orgId, pharmacyId, owner_name||name, email.toLowerCase(), pwHash]
      );
      await query(
        `INSERT INTO subscriptions (organisation_id,plan,amount_ugx,status,trial_ends_at) VALUES ($1,$2,$3,'trial',NOW()+INTERVAL '14 days')`,
        [orgId, plan||'pro', amount]
      );
      res.json({ success: true, org_id: orgId, pharmacy_id: pharmacyId, temp_password: tempPw });
    } catch(e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Email already registered' });
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/admin/orgs/:id/suspend — deactivate org + all users
  app.post('/api/admin/orgs/:id/suspend', auth, adminOnly, async (req, res) => {
    try {
      await query(`UPDATE organisations SET is_active=false WHERE id=$1`, [req.params.id]);
      await query(`UPDATE users SET is_active=false WHERE organisation_id=$1`, [req.params.id]);
      await query(`UPDATE subscriptions SET status='suspended' WHERE organisation_id=$1`, [req.params.id]);
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/admin/orgs/:id/activate — reactivate org + all users
  app.post('/api/admin/orgs/:id/activate', auth, adminOnly, async (req, res) => {
    try {
      await query(`UPDATE organisations SET is_active=true WHERE id=$1`, [req.params.id]);
      await query(`UPDATE users SET is_active=true WHERE organisation_id=$1`, [req.params.id]);
      await query(`UPDATE subscriptions SET status='active' WHERE organisation_id=$1`, [req.params.id]);
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/admin/orgs/:id/mark-overdue
  app.post('/api/admin/orgs/:id/mark-overdue', auth, adminOnly, async (req, res) => {
    try {
      await query(`UPDATE subscriptions SET status='overdue' WHERE organisation_id=$1`, [req.params.id]);
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/admin/orgs/:id/convert-trial — convert trial to paid
  app.post('/api/admin/orgs/:id/convert-trial', auth, adminOnly, async (req, res) => {
    const { plan } = req.body;
    const planAmounts = { drug_shop:20000, basic:20000, single:50000, pro:50000, multi:80000, enterprise:150000 };
    const amount = planAmounts[plan] || 50000;
    try {
      await query(`UPDATE subscriptions SET status='active', plan=$1, amount_ugx=$2, next_billing=NOW()+INTERVAL '30 days' WHERE organisation_id=$3`, [plan||'pro', amount, req.params.id]);
      await query(`UPDATE organisations SET is_active=true, plan=$1 WHERE id=$2`, [plan||'pro', req.params.id]);
      await query(`UPDATE users SET is_active=true WHERE organisation_id=$1`, [req.params.id]);
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/admin/orgs/:id/extend-trial
  app.post('/api/admin/orgs/:id/extend-trial', auth, adminOnly, async (req, res) => {
    const days = parseInt(req.body.days) || 7;
    try {
      await query(`UPDATE subscriptions SET trial_ends_at = GREATEST(trial_ends_at, NOW()) + INTERVAL '${days} days' WHERE organisation_id=$1`, [req.params.id]);
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // PATCH /api/admin/orgs/:id/plan — change plan
  app.patch('/api/admin/orgs/:id/plan', auth, adminOnly, async (req, res) => {
    const { plan } = req.body;
    const planAmounts = { drug_shop:20000, basic:20000, single:50000, pro:50000, multi:80000, enterprise:150000 };
    const amount = planAmounts[plan];
    if (!amount) return res.status(400).json({ error: 'Invalid plan name' });
    try {
      await query(`UPDATE subscriptions SET plan=$1, amount_ugx=$2 WHERE organisation_id=$3`, [plan, amount, req.params.id]);
      await query(`UPDATE organisations SET plan=$1 WHERE id=$2`, [plan, req.params.id]);
      res.json({ success: true, amount });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/admin/users/:id/suspend — suspend one user
  app.post('/api/admin/users/:id/suspend', auth, adminOnly, async (req, res) => {
    try {
      await query(`UPDATE users SET is_active=false WHERE id=$1`, [req.params.id]);
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/admin/users/:id/activate — activate one user
  app.post('/api/admin/users/:id/activate', auth, adminOnly, async (req, res) => {
    try {
      await query(`UPDATE users SET is_active=true WHERE id=$1`, [req.params.id]);
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/admin/users/:id/reset-password
  app.post('/api/admin/users/:id/reset-password', auth, adminOnly, async (req, res) => {
    try {
      const u = await query(`SELECT email, phone FROM users u LEFT JOIN organisations o ON o.id=u.organisation_id WHERE u.id=$1`, [req.params.id]);
      if (!u.rows.length) return res.status(404).json({ error: 'User not found' });
      const newPw = 'MedVault' + Math.floor(1000 + Math.random()*9000) + '!';
      const pwHash = await hash(newPw);
      await query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [pwHash, req.params.id]);
      res.json({ success: true, new_password: newPw });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── AI ──────────────────────────────────────────────────
  app.post('/api/ai/chat', async (req, res) => {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.json({ error: 'AI is not configured. Missing ANTHROPIC_API_KEY.' }, 503);
    }

    const { messages, system, max_tokens, model } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) {
      return res.json({ error: 'messages array is required' }, 400);
    }

    try {
      const payload = {
        model: model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
        max_tokens: Number(max_tokens) > 0 ? Number(max_tokens) : 800,
        messages,
      };
      if (typeof system === 'string' && system.trim()) payload.system = system;

      const result = await callAnthropicAPI(payload);
      if (result.status >= 400) {
        return res.json(
          { error: 'AI request failed', providerStatus: result.status, details: result.data },
          result.status
        );
      }
      return res.json(result.data);
    } catch (e) {
      return res.json({ error: 'AI gateway error: ' + e.message }, 500);
    }
  });

  // ── BATCH UPDATE ───────────────────────────────────────
  // Update batch details, including batch_number
  app.put('/api/batch/:id', auth, async (req, res) => {
    const { id } = req.params;
    const { batch_number, expiry_date, quantity, cost_price } = req.body;
    if (!batch_number) return res.status(400).json({ error: 'batch_number required' });
    try {
      const result = await query(
        `UPDATE drug_batches SET batch_number=$1, expiry_date=$2, quantity=$3, cost_price=$4 WHERE id=$5 RETURNING *`,
        [batch_number, expiry_date || null, parseInt(quantity), parseFloat(cost_price || 0), id]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Batch not found' });
      res.json({ success: true, batch: result.rows[0] });
    } catch (e) {
      if (e.code === '23505') { // unique violation
        return res.status(409).json({ error: 'Duplicate batch_number for this drug' });
      }
      res.status(500).json({ error: e.message });
    }
  });

  // ══════════════════════════════════════════════════════════
  // PHASE 1 — NEW ROUTES
  // ══════════════════════════════════════════════════════════

  // ── NOTIFICATIONS ─────────────────────────────────────────
  app.get('/api/notifications', auth, async (req, res) => {
    const { pharmacyId, userId } = req.user;
    const limit = Math.min(50, parseInt(req.query.limit || '20'));
    try {
      const [notifs, unread] = await Promise.all([
        query(
          `SELECT * FROM notifications
           WHERE pharmacy_id=$1 AND (user_id IS NULL OR user_id=$2)
           ORDER BY created_at DESC LIMIT $3`,
          [pharmacyId, userId, limit]
        ),
        query(
          `SELECT COUNT(*) as cnt FROM notifications
           WHERE pharmacy_id=$1 AND (user_id IS NULL OR user_id=$2) AND is_read=false`,
          [pharmacyId, userId]
        ),
      ]);
      res.json({ notifications: notifs.rows, unread_count: parseInt(unread.rows[0].cnt) });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/notifications/:id/read', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      await query(
        `UPDATE notifications SET is_read=true WHERE id=$1 AND pharmacy_id=$2`,
        [req.params.id, pharmacyId]
      );
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/notifications/read-all', auth, async (req, res) => {
    const { pharmacyId, userId } = req.user;
    try {
      await query(
        `UPDATE notifications SET is_read=true
         WHERE pharmacy_id=$1 AND (user_id IS NULL OR user_id=$2) AND is_read=false`,
        [pharmacyId, userId]
      );
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── SUPPLIERS ─────────────────────────────────────────────
  app.get('/api/suppliers', auth, async (req, res) => {
    const { orgId } = req.user;
    try {
      const result = await query(
        `SELECT * FROM suppliers WHERE org_id=$1 AND is_active=true ORDER BY name`,
        [orgId]
      );
      res.json({ suppliers: result.rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/suppliers', auth, async (req, res) => {
    const { orgId, userId } = req.user;
    if (!['owner','manager','super_admin'].includes(req.user.role))
      return res.status(403).json({ error: 'Not allowed' });
    const { name, contact_name, phone, email, address, payment_terms, notes } = req.body;
    if (!name) return res.status(400).json({ error: "'name' is required" });
    try {
      const result = await query(
        `INSERT INTO suppliers (org_id,name,contact_name,phone,email,address,payment_terms,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [orgId, name, contact_name||null, phone||null, email||null, address||null, payment_terms||null, notes||null]
      );
      const { audit, getIp } = require('../utils/audit');
      audit({ orgId, userId, action:'supplier.create', entity:'supplier', entityId:result.rows[0].id,
              payload:{ name }, ip:getIp(req) });
      res.json({ success: true, supplier: result.rows[0] });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/suppliers/:id', auth, async (req, res) => {
    const { orgId, userId } = req.user;
    if (!['owner','manager','super_admin'].includes(req.user.role))
      return res.status(403).json({ error: 'Not allowed' });
    const { name, contact_name, phone, email, address, payment_terms, notes, is_active } = req.body;
    try {
      const result = await query(
        `UPDATE suppliers SET
           name=COALESCE($1,name), contact_name=COALESCE($2,contact_name),
           phone=COALESCE($3,phone), email=COALESCE($4,email),
           address=COALESCE($5,address), payment_terms=COALESCE($6,payment_terms),
           notes=COALESCE($7,notes),
           is_active=COALESCE($8,is_active)
         WHERE id=$9 AND org_id=$10 RETURNING *`,
        [name||null, contact_name||null, phone||null, email||null,
         address||null, payment_terms||null, notes||null,
         is_active !== undefined ? is_active : null,
         req.params.id, orgId]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
      const { audit, getIp } = require('../utils/audit');
      audit({ orgId, userId, action:'supplier.update', entity:'supplier', entityId:req.params.id,
              payload:req.body, ip:getIp(req) });
      res.json({ success: true, supplier: result.rows[0] });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/suppliers/:id', auth, async (req, res) => {
    const { orgId, userId } = req.user;
    if (!['owner','super_admin'].includes(req.user.role))
      return res.status(403).json({ error: 'Not allowed' });
    try {
      // Soft delete — preserve historical references
      await query(`UPDATE suppliers SET is_active=false WHERE id=$1 AND org_id=$2`, [req.params.id, orgId]);
      const { audit, getIp } = require('../utils/audit');
      audit({ orgId, userId, action:'supplier.delete', entity:'supplier', entityId:req.params.id, ip:getIp(req) });
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── STOCK ADJUSTMENTS ────────────────────────────────────
  app.get('/api/inventory/adjustments', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    if (!['owner','manager','super_admin'].includes(req.user.role))
      return res.status(403).json({ error: 'Not allowed' });
    const limit  = Math.min(100, parseInt(req.query.limit || '50'));
    const offset = (Math.max(1, parseInt(req.query.page || '1')) - 1) * limit;
    try {
      const result = await query(
        `SELECT sa.*, d.name as drug_name, u.name as user_name
         FROM stock_adjustments sa
         JOIN drugs d ON d.id=sa.drug_id
         LEFT JOIN users u ON u.id=sa.user_id
         WHERE sa.pharmacy_id=$1
         ORDER BY sa.created_at DESC LIMIT $2 OFFSET $3`,
        [pharmacyId, limit, offset]
      );
      res.json({ adjustments: result.rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/inventory/adjustments', auth, async (req, res) => {
    const { pharmacyId, orgId, userId } = req.user;
    if (!['owner','manager','super_admin'].includes(req.user.role))
      return res.status(403).json({ error: 'Not allowed' });
    const { drug_id, quantity_after, type, reason } = req.body;
    if (!drug_id || quantity_after === undefined || !type || !reason)
      return res.status(400).json({ error: 'drug_id, quantity_after, type, and reason are required' });
    const validTypes = ['count','damage','return','expired','correction'];
    if (!validTypes.includes(type))
      return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });

    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get current quantity (locked for update)
      const drug = await client.query(
        `SELECT quantity FROM drugs WHERE id=$1 AND pharmacy_id=$2 FOR UPDATE`,
        [drug_id, pharmacyId]
      );
      if (!drug.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Drug not found' }); }

      const qtyBefore = drug.rows[0].quantity;
      const qtyAfter  = parseInt(quantity_after);
      const variance  = qtyAfter - qtyBefore;

      // Update drug quantity
      await client.query(
        `UPDATE drugs SET quantity=$1, updated_at=NOW(), updated_by=$2 WHERE id=$3 AND pharmacy_id=$4`,
        [qtyAfter, userId, drug_id, pharmacyId]
      );

      // Insert adjustment record
      const adj = await client.query(
        `INSERT INTO stock_adjustments
           (pharmacy_id,drug_id,user_id,type,quantity_before,quantity_after,variance,reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [pharmacyId, drug_id, userId||null, type, qtyBefore, qtyAfter, variance, reason]
      );

      await client.query('COMMIT');

      const { audit, getIp } = require('../utils/audit');
      audit({ orgId, pharmacyId, userId, action:'stock.adjust', entity:'drug', entityId:drug_id,
              payload:{ type, qtyBefore, qtyAfter, variance, reason }, ip:getIp(req) });

      res.json({ success: true, adjustment: adj.rows[0] });
    } catch(e) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ── AUDIT LOG (read-only for owners) ─────────────────────
  app.get('/api/audit', auth, async (req, res) => {
    const { pharmacyId, orgId, role } = req.user;
    if (!['owner','super_admin'].includes(role))
      return res.status(403).json({ error: 'Access denied: requires owner role' });
    const limit  = Math.min(100, parseInt(req.query.limit || '50'));
    const offset = (Math.max(1, parseInt(req.query.page || '1')) - 1) * limit;
    const { entity, action: actionFilter } = req.query;
    try {
      let sql = `SELECT al.*, u.name as user_name
                 FROM audit_logs al
                 LEFT JOIN users u ON u.id=al.user_id
                 WHERE al.pharmacy_id=$1`;
      const params = [pharmacyId]; let i = 2;
      if (entity)       { sql+=` AND al.entity=$${i++}`;        params.push(entity); }
      if (actionFilter) { sql+=` AND al.action ILIKE $${i++}`;  params.push('%'+actionFilter+'%'); }
      sql += ` ORDER BY al.created_at DESC LIMIT $${i} OFFSET $${i+1}`;
      params.push(limit, offset);
      const result = await query(sql, params);
      res.json({ logs: result.rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── DAILY SUMMARY REPORT ──────────────────────────────────
  app.get('/api/reports/daily-summary', auth, async (req, res) => {
    const { pharmacyId, role } = req.user;
    if (!['owner','manager','super_admin'].includes(role))
      return res.status(403).json({ error: 'Not allowed' });
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    try {
      const [sales, topDrugs, paymentBreakdown, staffActivity] = await Promise.all([
        query(
          `SELECT COUNT(*) as transaction_count,
                  COALESCE(SUM(total_amount),0) as gross_revenue,
                  COALESCE(SUM(discount_amount),0) as total_discounts
           FROM sales WHERE pharmacy_id=$1 AND DATE(created_at)=$2 AND voided=false`,
          [pharmacyId, date]
        ),
        query(
          `SELECT si.drug_name, SUM(si.quantity) as total_qty, SUM(si.total_price) as total_revenue
           FROM sale_items si JOIN sales s ON s.id=si.sale_id
           WHERE s.pharmacy_id=$1 AND DATE(s.created_at)=$2 AND s.voided=false
           GROUP BY si.drug_name ORDER BY total_revenue DESC LIMIT 10`,
          [pharmacyId, date]
        ),
        query(
          `SELECT payment_method, COUNT(*) as count, COALESCE(SUM(total_amount),0) as total
           FROM sales WHERE pharmacy_id=$1 AND DATE(created_at)=$2 AND voided=false
           GROUP BY payment_method`,
          [pharmacyId, date]
        ),
        query(
          `SELECT u.name as staff_name, COUNT(s.id) as sale_count, COALESCE(SUM(s.total_amount),0) as revenue
           FROM sales s JOIN users u ON u.id=s.user_id
           WHERE s.pharmacy_id=$1 AND DATE(s.created_at)=$2 AND s.voided=false
           GROUP BY u.name ORDER BY revenue DESC`,
          [pharmacyId, date]
        ),
      ]);
      res.json({
        date,
        summary: sales.rows[0],
        top_drugs: topDrugs.rows,
        payment_breakdown: paymentBreakdown.rows,
        staff_activity: staffActivity.rows,
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });


};
