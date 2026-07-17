'use strict';
const err = require('./_err');

module.exports = function registerSalesRoutes(app, { query, pool, getNextReceiptNumber, auth, validate, schemas, audit }) {

  // GET /api/sales
  app.get('/api/sales', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const page   = Math.max(1, parseInt(req.query.page)  || 1);
      const limit  = Math.min(100, parseInt(req.query.limit) || 50);
      const offset = (page - 1) * limit;
      const [rows, countRes] = await Promise.all([
        query(
          `SELECT s.*,json_agg(json_build_object('drug_name',si.drug_name,'quantity',si.quantity,'unit_price',si.unit_price,'total_price',si.total_price)) as items
           FROM sales s LEFT JOIN sale_items si ON si.sale_id=s.id
           WHERE s.pharmacy_id=$1 GROUP BY s.id ORDER BY s.created_at DESC LIMIT $2 OFFSET $3`,
          [pharmacyId, limit, offset]
        ),
        query(`SELECT COUNT(*) as total FROM sales WHERE pharmacy_id=$1`, [pharmacyId]),
      ]);
      const total = parseInt(countRes.rows[0].total);
      res.json({ sales: rows.rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // POST /api/sales
  // Supports: price_level_id (wholesale/tier pricing), loyalty (earn points, redeem points)
  app.post('/api/sales', auth, validate(schemas.sale), async (req, res) => {
    const { pharmacyId, orgId, userId, role } = req.user;
    if (role === 'cashier')
      return err(res, 403, 'PERMISSION_CASHIER', 'Cashiers cannot record sales directly. Use the dispatch queue.');

    const {
      customer_name, customer_phone, customer_id,
      items, discount_pct, payment_method,
      subtotal, discount_amount, total_amount,
      price_level_id,          // Phase 2: wholesale / tiered pricing
      loyalty_redeem_points,   // Phase 2: points to redeem (reduces total)
    } = req.body;

    if (!Array.isArray(items) || !items.length)
      return err(res, 400, 'VALIDATION_REQUIRED', 'items array is required', 'items');

    // Loyalty earn rate: 1 point per 1,000 UGX spent
    const EARN_RATE   = 1;
    const REDEEM_RATE = 10; // 1 point = 10 UGX

    const redeemPoints = parseInt(loyalty_redeem_points || 0);
    const redeemDiscount = redeemPoints * REDEEM_RATE; // UGX to discount
    const finalTotal = Math.max(0, parseFloat(total_amount || 0) - redeemDiscount);
    const pointsEarned = Math.floor(finalTotal / 1000) * EARN_RATE;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Receipt counter inside transaction — if sale rolls back, counter is not burned
      const rcptRes = await client.query(
        `UPDATE pharmacies SET receipt_counter = receipt_counter + 1 WHERE id = $1 RETURNING receipt_counter`,
        [pharmacyId]
      );
      const receiptNum = rcptRes.rows.length
        ? `RCP-${new Date().getFullYear()}-${String(rcptRes.rows[0].receipt_counter).padStart(4, '0')}`
        : `RCP-${new Date().getFullYear()}-${Date.now().toString(36).toUpperCase()}`;

      const saleRes = await client.query(
        `INSERT INTO sales (pharmacy_id,user_id,receipt_number,customer_name,customer_phone,
            subtotal,discount_pct,discount_amount,total_amount,payment_method,price_level_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [pharmacyId, userId || null, receiptNum,
         customer_name || 'Walk-in', customer_phone || null,
         parseFloat(subtotal || 0), parseFloat(discount_pct || 0),
         parseFloat(discount_amount || 0) + redeemDiscount,
         finalTotal, payment_method || 'cash',
         price_level_id || null]
      );
      const sale = saleRes.rows[0];

      for (const item of items) {
        await client.query(
          `INSERT INTO sale_items (sale_id,drug_id,drug_name,quantity,unit_price,total_price)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [sale.id, item.drug_id || null, item.drug_name,
           item.quantity, item.unit_price, item.unit_price * item.quantity]
        );
        if (item.drug_id) {
          await client.query(
            `UPDATE drugs SET quantity=GREATEST(0,quantity-$1),updated_at=NOW()
             WHERE id=$2 AND pharmacy_id=$3`,
            [item.quantity, item.drug_id, pharmacyId]
          );
        }
      }

      // ── LOYALTY: redeem then earn ─────────────────────────────
      let loyaltyAccount = null;
      if (customer_id && (redeemPoints > 0 || pointsEarned > 0)) {
        // Get or create loyalty account
        let accRes = await client.query(
          `SELECT id, points_balance FROM loyalty_accounts
           WHERE customer_id=$1 AND org_id=$2 FOR UPDATE`,
          [customer_id, orgId]
        );

        if (!accRes.rows.length) {
          accRes = await client.query(
            `INSERT INTO loyalty_accounts (org_id, pharmacy_id, customer_id)
             VALUES ($1,$2,$3) RETURNING id, points_balance`,
            [orgId, pharmacyId, customer_id]
          );
        }

        loyaltyAccount = accRes.rows[0];
        let runningBalance = loyaltyAccount.points_balance;

        // Redeem first (validate they have enough)
        if (redeemPoints > 0) {
          if (redeemPoints > runningBalance)
            throw new Error(`Insufficient loyalty points. Balance: ${runningBalance}, requested: ${redeemPoints}`);

          runningBalance -= redeemPoints;
          await client.query(
            `UPDATE loyalty_accounts
             SET points_balance=$1, total_redeemed=total_redeemed+$2, updated_at=NOW()
             WHERE id=$3`,
            [runningBalance, redeemPoints, loyaltyAccount.id]
          );
          await client.query(
            `INSERT INTO loyalty_transactions
               (account_id, pharmacy_id, type, points, balance_after, sale_id, notes, created_by)
             VALUES ($1,$2,'redeem',$3,$4,$5,'Redeemed at POS',$6)`,
            [loyaltyAccount.id, pharmacyId, -redeemPoints, runningBalance, sale.id, userId]
          );
        }

        // Earn points
        if (pointsEarned > 0) {
          runningBalance += pointsEarned;
          await client.query(
            `UPDATE loyalty_accounts
             SET points_balance=$1, total_earned=total_earned+$2, updated_at=NOW()
             WHERE id=$3`,
            [runningBalance, pointsEarned, loyaltyAccount.id]
          );
          await client.query(
            `INSERT INTO loyalty_transactions
               (account_id, pharmacy_id, type, points, balance_after, sale_id, notes, created_by)
             VALUES ($1,$2,'earn',$3,$4,$5,$6,$7)`,
            [loyaltyAccount.id, pharmacyId, pointsEarned, runningBalance,
             sale.id, `Earned on receipt ${receiptNum}`, userId]
          );
          loyaltyAccount.points_balance = runningBalance;
        }
      }
      // ─────────────────────────────────────────────────────────

      await client.query('COMMIT');

      await audit(query, {
        req, action: 'sale.create', entity: 'sale', entityId: sale.id,
        payload: {
          receipt_number: receiptNum, total_amount: finalTotal,
          payment_method, item_count: items.length,
          price_level_id: price_level_id || null,
          loyalty_earned: pointsEarned, loyalty_redeemed: redeemPoints,
        },
      });

      res.json({
        message: '✅ Sale recorded!',
        sale,
        receipt_number: receiptNum,
        loyalty: customer_id ? {
          points_earned:  pointsEarned,
          points_redeemed: redeemPoints,
          redeem_discount: redeemDiscount,
          new_balance: loyaltyAccount?.points_balance ?? null,
        } : null,
      });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('Sale transaction failed:', e.message);
      return err(res, 500, 'SERVER_ERROR', 'Sale failed: ' + e.message);
    } finally {
      client.release();
    }
  });

  // GET /api/activity
  app.get('/api/activity', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const { from, to, limit = 500 } = req.query;
    try {
      let whereExtra = '';
      const params = [pharmacyId];
      if (from) { params.push(from); whereExtra += ` AND DATE(s.created_at) >= $${params.length}`; }
      if (to)   { params.push(to);   whereExtra += ` AND DATE(s.created_at) <= $${params.length}`; }
      const page_num    = Math.max(1, parseInt(req.query.page) || 1);
      const page_limit  = Math.min(100, parseInt(limit) || 50);
      const page_offset = (page_num - 1) * page_limit;

      const countSql = `SELECT COUNT(*) as total FROM sales s WHERE s.pharmacy_id=$1${whereExtra}`;
      const [result, countRes] = await Promise.all([
        query(
          `SELECT s.id,s.receipt_number,s.total_amount,s.customer_name,s.created_at,s.payment_method,u.name as staff_name,COUNT(si.id) as item_count
           FROM sales s LEFT JOIN users u ON u.id=s.user_id LEFT JOIN sale_items si ON si.sale_id=s.id
           WHERE s.pharmacy_id=$1${whereExtra} GROUP BY s.id,u.name ORDER BY s.created_at DESC LIMIT ${page_limit} OFFSET ${page_offset}`,
          params
        ),
        query(countSql, params),
      ]);
      const total = parseInt(countRes.rows[0].total);
      res.json({
        activity: result.rows,
        pagination: { page: page_num, limit: page_limit, total, pages: Math.ceil(total / page_limit) },
      });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });
};