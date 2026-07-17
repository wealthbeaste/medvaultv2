'use strict';
const err = require('./_err');

module.exports = function registerOperationsRoutes(app, { query, pool, getNextReceiptNumber, auth, can, validate, audit }) {

  // ── CREDIT ──────────────────────────────────────────────

  app.get('/api/credit', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const [credits, summary] = await Promise.all([
        query(`SELECT * FROM credit_sales WHERE pharmacy_id=$1 ORDER BY due_date`, [pharmacyId]),
        query(`SELECT COALESCE(SUM(amount_owed),0) as total,COUNT(*) as count,COUNT(CASE WHEN status='overdue' THEN 1 END) as overdue_count FROM credit_sales WHERE pharmacy_id=$1 AND status!='paid'`, [pharmacyId]),
      ]);
      res.json({ credits: credits.rows, summary: summary.rows[0] });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  app.post('/api/credit', auth, validate({
    customer_name: { required: true, type: 'string', minLen: 1, maxLen: 255 },
    amount_owed:   { required: true, type: 'number', min: 0 },
  }), async (req, res) => {
    const { pharmacyId, userId } = req.user;
    const { customer_name, customer_phone, items_description, amount_owed, due_date, notes } = req.body;
    if (!customer_name)    return err(res, 400, 'VALIDATION_REQUIRED', 'Customer name is required', 'customer_name');
    if (amount_owed == null) return err(res, 400, 'VALIDATION_REQUIRED', 'Amount owed is required', 'amount_owed');
    try {
      const result = await query(
        `INSERT INTO credit_sales (pharmacy_id,user_id,customer_name,customer_phone,items_description,amount_owed,due_date,notes,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING *`,
        [pharmacyId, userId, customer_name, customer_phone || null, items_description || null, parseFloat(amount_owed), due_date || null, notes || null]
      );
      await audit(query, { req, action: 'credit.create', entity: 'credit_sale', entityId: result.rows[0].id, payload: { customer_name, amount_owed, due_date: due_date || null } });
      res.json({ message: '✅ Credit recorded!', credit: result.rows[0] });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  app.patch('/api/credit/:id/paid', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const { amount_paid } = req.body;
    if (amount_paid == null) return err(res, 400, 'VALIDATION_REQUIRED', 'amount_paid is required', 'amount_paid');
    try {
      const result = await query(
        `UPDATE credit_sales SET status=CASE WHEN $1::numeric>=amount_owed THEN 'paid' ELSE 'partial' END,
         amount_paid=COALESCE(amount_paid,0)+$1::numeric,paid_at=NOW()
         WHERE id=$2 AND pharmacy_id=$3 RETURNING *`,
        [parseFloat(amount_paid || 0), req.params.id, pharmacyId]
      );
      if (!result.rows.length) return err(res, 404, 'NOT_FOUND_CREDIT', 'Credit record not found', 'id');
      await audit(query, { req, action: 'credit.payment', entity: 'credit_sale', entityId: req.params.id, payload: { amount_paid } });
      res.json({ message: '✅ Payment recorded!', credit: result.rows[0] });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  app.post('/api/credit/:id/remind', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const c = await query(`SELECT * FROM credit_sales WHERE id=$1 AND pharmacy_id=$2`, [req.params.id, pharmacyId]);
      if (!c.rows.length) return err(res, 404, 'NOT_FOUND_CREDIT', 'Credit record not found', 'id');
      await query(`UPDATE credit_sales SET last_reminded=NOW() WHERE id=$1`, [req.params.id]);
      res.json({ message: `✅ Reminder logged for ${c.rows[0].customer_name}`, whatsapp: false });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ── CASHIER SHIFTS ───────────────────────────────────────

  app.post('/api/shifts/open', auth, can('shifts:manage'), async (req, res) => {
    const { pharmacyId, userId } = req.user;
    const { opening_cash } = req.body;
    try {
      await query(`UPDATE cashier_shifts SET status='closed',closed_at=NOW() WHERE pharmacy_id=$1 AND user_id=$2 AND status='open'`, [pharmacyId, userId]);
      const r = await query(
        `INSERT INTO cashier_shifts (pharmacy_id,user_id,opening_cash,status) VALUES ($1,$2,$3,'open') RETURNING *`,
        [pharmacyId, userId, parseFloat(opening_cash || 0)]
      );
      res.json({ success: true, shift: r.rows[0] });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  app.get('/api/shifts/current', auth, async (req, res) => {
    const { pharmacyId, userId } = req.user;
    try {
      const r = await query(
        `SELECT cs.*,u.name as cashier_name,COALESCE(SUM(s.total_amount::float),0) as sales_total,COUNT(s.id) as sale_count
         FROM cashier_shifts cs
         LEFT JOIN users u ON u.id=cs.user_id
         LEFT JOIN sales s ON s.shift_id=cs.id
         WHERE cs.pharmacy_id=$1 AND cs.user_id=$2 AND cs.status='open'
         GROUP BY cs.id,u.name ORDER BY cs.opened_at DESC LIMIT 1`,
        [pharmacyId, userId]
      );
      res.json({ shift: r.rows[0] || null });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  app.post('/api/shifts/close', auth, can('shifts:manage'), async (req, res) => {
    const { pharmacyId, userId } = req.user;
    const { closing_cash, notes } = req.body;
    try {
      const sr = await query(
        `SELECT cs.id,COALESCE(SUM(s.total_amount::float),0) as total_sales,COUNT(s.id) as transaction_count
         FROM cashier_shifts cs LEFT JOIN sales s ON s.shift_id=cs.id
         WHERE cs.pharmacy_id=$1 AND cs.user_id=$2 AND cs.status='open'
         GROUP BY cs.id ORDER BY cs.id DESC LIMIT 1`,
        [pharmacyId, userId]
      );
      if (!sr.rows.length) return err(res, 404, 'NOT_FOUND_SHIFT', 'No open shift found');
      const { id, total_sales, transaction_count } = sr.rows[0];
      const r = await query(
        `UPDATE cashier_shifts SET status='closed',closed_at=NOW(),closing_cash=$1,total_sales=$2,transaction_count=$3,notes=$4
         WHERE id=$5 RETURNING *`,
        [parseFloat(closing_cash || 0), parseFloat(total_sales), parseInt(transaction_count), notes || null, id]
      );
      res.json({ success: true, shift: r.rows[0] });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  app.get('/api/shifts', auth, can('shifts:manage'), async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const r = await query(
        `SELECT cs.*,u.name as cashier_name,cs.total_sales::float as total_sales
         FROM cashier_shifts cs JOIN users u ON u.id=cs.user_id
         WHERE cs.pharmacy_id=$1 ORDER BY cs.opened_at DESC LIMIT 30`,
        [pharmacyId]
      );
      res.json({ shifts: r.rows });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ── DISPATCH ─────────────────────────────────────────────

  app.post('/api/dispatch', auth, validate({
    items:        { required: true, type: 'array' },
    total_amount: { required: true, type: 'number', min: 0 },
  }), async (req, res) => {
    const { pharmacyId, userId, role } = req.user;
    if (role === 'cashier') return err(res, 403, 'PERMISSION_CASHIER', 'Cashiers do not dispense. They collect payment.');
    const { customer_name, customer_phone, items, discount_pct, subtotal, discount_amount, total_amount, notes } = req.body;
    if (!items || !items.length) return err(res, 400, 'VALIDATION_REQUIRED', 'No items in cart', 'items');
    try {
      const r = await query(
        `INSERT INTO pending_sales (pharmacy_id,dispensor_id,customer_name,customer_phone,items,discount_pct,subtotal,discount_amount,total_amount,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [pharmacyId, userId, customer_name || 'Walk-in', customer_phone || null,
         JSON.stringify(items), parseFloat(discount_pct || 0), parseFloat(subtotal || 0),
         parseFloat(discount_amount || 0), parseFloat(total_amount || 0), notes || null]
      );
      res.json({ success: true, dispatch: r.rows[0] });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  app.get('/api/dispatch/pending', auth, can('dispatch:view_pending'), async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const r = await query(
        `SELECT ps.*,u.name as dispensor_name FROM pending_sales ps JOIN users u ON u.id=ps.dispensor_id
         WHERE ps.pharmacy_id=$1 AND ps.status='pending' ORDER BY ps.created_at ASC`,
        [pharmacyId]
      );
      res.json({ pending: r.rows });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  app.get('/api/dispatch/mine', auth, async (req, res) => {
    const { pharmacyId, userId } = req.user;
    try {
      const r = await query(
        `SELECT ps.id,ps.customer_name,ps.total_amount::float as total_amount,ps.status,ps.payment_method,ps.collected_at,ps.created_at,s.receipt_number
         FROM pending_sales ps LEFT JOIN sales s ON s.id=ps.sale_id
         WHERE ps.pharmacy_id=$1 AND ps.dispensor_id=$2 AND ps.created_at > NOW()-INTERVAL '12 hours'
         ORDER BY ps.created_at DESC LIMIT 20`,
        [pharmacyId, userId]
      );
      res.json({ dispatched: r.rows });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  app.post('/api/dispatch/:id/collect', auth, can('dispatch:collect'), async (req, res) => {
    const { pharmacyId, userId } = req.user;
    const { payment_method } = req.body;
    if (!payment_method) return err(res, 400, 'VALIDATION_REQUIRED', 'Payment method is required', 'payment_method');
    try {
      const pr = await query(
        `SELECT * FROM pending_sales WHERE id=$1 AND pharmacy_id=$2 AND status='pending'`,
        [req.params.id, pharmacyId]
      );
      if (!pr.rows.length) return err(res, 404, 'CONFLICT_DISPATCH_DONE', 'Dispatch not found or already collected', 'id');
      const ps    = pr.rows[0];
      const items = typeof ps.items === 'string' ? JSON.parse(ps.items) : ps.items;
      const receipt_number = await getNextReceiptNumber(pharmacyId);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const sr = await client.query(
          `INSERT INTO sales (pharmacy_id,user_id,receipt_number,customer_name,customer_phone,subtotal,discount_pct,discount_amount,total_amount,payment_method)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [pharmacyId, userId, receipt_number, ps.customer_name, ps.customer_phone,
           parseFloat(ps.subtotal), parseFloat(ps.discount_pct),
           parseFloat(ps.discount_amount), parseFloat(ps.total_amount), payment_method]
        );
        const saleId = sr.rows[0].id;
        for (const item of items) {
          await client.query(
            `INSERT INTO sale_items (sale_id,drug_id,drug_name,quantity,unit_price,total_price) VALUES ($1,$2,$3,$4,$5,$6)`,
            [saleId, item.drug_id || null, item.drug_name, item.quantity, item.unit_price, item.unit_price * item.quantity]
          );
          if (item.drug_id) {
            await client.query(
              `UPDATE drugs SET quantity=GREATEST(0,quantity-$1),updated_at=NOW() WHERE id=$2 AND pharmacy_id=$3`,
              [item.quantity, item.drug_id, pharmacyId]
            );
          }
        }
        await client.query(
          `UPDATE pending_sales SET status='collected',payment_method=$1,collected_at=NOW(),collected_by=$2,sale_id=$3 WHERE id=$4`,
          [payment_method, userId, saleId, ps.id]
        );
        await client.query('COMMIT');
        res.json({ success: true, sale: { id: saleId }, receipt_number });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  app.post('/api/dispatch/:id/cancel', auth, async (req, res) => {
    const { pharmacyId, userId, role } = req.user;
    try {
      const r = await query(
        `UPDATE pending_sales SET status='cancelled',collected_at=NOW()
         WHERE id=$1 AND pharmacy_id=$2 AND status='pending' AND (dispensor_id=$3 OR $4 IN ('owner','manager'))
         RETURNING id`,
        [req.params.id, pharmacyId, userId, role]
      );
      if (!r.rows.length) return err(res, 404, 'CONFLICT_DISPATCH_DONE', 'Dispatch not found or already processed', 'id');
      res.json({ success: true });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });
};
