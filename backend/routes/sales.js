'use strict';
const err = require('./_err');

module.exports = function registerSalesRoutes(app, { query, pool, getNextReceiptNumber, auth, validate, schemas, audit }) {

  // GET /api/sales
  // By default only "live" (non-voided) sales are returned — pass
  // ?include_voided=1 for an audit view that also shows voided ones.
  app.get('/api/sales', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const page   = Math.max(1, parseInt(req.query.page)  || 1);
      const limit  = Math.min(500, parseInt(req.query.limit) || 50);
      const offset = (page - 1) * limit;
      const includeVoided = req.query.include_voided === '1';
      const voidClause = includeVoided ? '' : 'AND s.voided_at IS NULL';
      const [rows, countRes] = await Promise.all([
        query(
          `SELECT s.*,json_agg(json_build_object('drug_name',si.drug_name,'quantity',si.quantity,'unit_price',si.unit_price,'total_price',si.total_price)) as items
           FROM sales s LEFT JOIN sale_items si ON si.sale_id=s.id
           WHERE s.pharmacy_id=$1 ${voidClause} GROUP BY s.id ORDER BY s.created_at DESC LIMIT $2 OFFSET $3`,
          [pharmacyId, limit, offset]
        ),
        query(`SELECT COUNT(*) as total FROM sales s WHERE s.pharmacy_id=$1 ${voidClause}`, [pharmacyId]),
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
      client_txn_id,           // Phase 4: idempotency key from the device (UUID)
    } = req.body;

    if (!Array.isArray(items) || !items.length)
      return err(res, 400, 'VALIDATION_REQUIRED', 'items array is required', 'items');

    // ── IDEMPOTENCY GUARD ────────────────────────────────────
    // The offline sync queue retries any request whose response was lost,
    // even if the server already committed the sale. If this device has
    // already sent this exact client_txn_id for this pharmacy, return the
    // existing sale instead of creating (and double-deducting stock for)
    // a duplicate.
    if (client_txn_id) {
      const existing = await query(
        `SELECT * FROM sales WHERE pharmacy_id=$1 AND client_txn_id=$2`,
        [pharmacyId, client_txn_id]
      );
      if (existing.rows.length) {
        return res.json({
          message: '✅ Sale recorded!',
          sale: existing.rows[0],
          receipt_number: existing.rows[0].receipt_number,
          duplicate: true,
        });
      }
    }

    // Loyalty earn rate: 1 point per 1,000 UGX spent
    const EARN_RATE   = 1;
    const REDEEM_RATE = 10; // 1 point = 10 UGX

    const redeemPoints = parseInt(loyalty_redeem_points || 0);
    const redeemDiscount = redeemPoints * REDEEM_RATE; // UGX to discount
    const finalTotal = Math.max(0, parseFloat(total_amount || 0) - redeemDiscount);
    const pointsEarned = Math.floor(finalTotal / 1000) * EARN_RATE;

    const client = await pool.connect();
    try {
      // Receipt counter is incremented on its own connection, OUTSIDE the
      // sale transaction below, and commits immediately (autocommit).
      // Previously this ran *inside* the sale's BEGIN…COMMIT block, so if
      // anything later in that transaction failed (bad stock data, a
      // loyalty check, a stale retry) the ROLLBACK undid the increment
      // too — "un-burning" that number. A concurrent or later sale could
      // then claim the same number, and when the original request was
      // retried it would collide with it: "duplicate key value violates
      // unique constraint sales_receipt_number_key", forever, on every
      // retry, since nothing about the retry ever changed. Numbering it
      // outside the transaction means a failed/retried sale can leave a
      // gap in the sequence (normal for receipt/invoice numbering — most
      // accounting systems have gaps from voided/failed transactions) but
      // can never collide with one that already committed.
      const rcptRes = await query(
        `UPDATE pharmacies SET receipt_counter = receipt_counter + 1 WHERE id = $1 RETURNING receipt_counter`,
        [pharmacyId]
      );
      let receiptNum = rcptRes.rows.length
        ? `RCP-${new Date().getFullYear()}-${String(rcptRes.rows[0].receipt_counter).padStart(4, '0')}`
        : `RCP-${new Date().getFullYear()}-${Date.now().toString(36).toUpperCase()}`;

      await client.query('BEGIN');

      let saleRes;
      let attempts = 0;
      while (true) {
        attempts++;
        try {
          saleRes = await client.query(
            `INSERT INTO sales (pharmacy_id,user_id,receipt_number,customer_name,customer_phone,
                subtotal,discount_pct,discount_amount,total_amount,payment_method,price_level_id,client_txn_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
            [pharmacyId, userId || null, receiptNum,
             customer_name || 'Walk-in', customer_phone || null,
             parseFloat(subtotal || 0), parseFloat(discount_pct || 0),
             parseFloat(discount_amount || 0) + redeemDiscount,
             finalTotal, payment_method || 'cash',
             price_level_id || null, client_txn_id || null]
          );
          break;
        } catch (insertErr) {
          // Two different unique constraints can fire here, and they need
          // different handling:
          if (insertErr.code === '23505' && client_txn_id && String(insertErr.constraint || '').includes('client_txn')) {
            // A near-simultaneous retry of the same client_txn_id already
            // committed. Return the sale that first request created
            // instead of erroring out.
            await client.query('ROLLBACK');
            const dupe = await query(
              `SELECT * FROM sales WHERE pharmacy_id=$1 AND client_txn_id=$2`,
              [pharmacyId, client_txn_id]
            );
            if (dupe.rows.length) {
              return res.json({
                message: '✅ Sale recorded!',
                sale: dupe.rows[0],
                receipt_number: dupe.rows[0].receipt_number,
                duplicate: true,
              });
            }
            throw insertErr;
          }
          if (insertErr.code === '23505' && String(insertErr.constraint || '').includes('receipt_number') && attempts < 5) {
            // Belt-and-suspenders: even though the counter now increments
            // outside this transaction, grab a fresh number and retry
            // rather than failing the whole sale.
            //
            // IMPORTANT: once any statement inside a Postgres transaction
            // fails, that transaction is "aborted" and every subsequent
            // command on it errors with "current transaction is aborted,
            // commands ignored until end of transaction block" until it's
            // explicitly rolled back — you cannot just retry another
            // statement on the same BEGIN block. Must ROLLBACK and BEGIN
            // fresh before the retried INSERT.
            await client.query('ROLLBACK');
            await client.query('BEGIN');
            const retryRcpt = await query(
              `UPDATE pharmacies SET receipt_counter = receipt_counter + 1 WHERE id = $1 RETURNING receipt_counter`,
              [pharmacyId]
            );
            receiptNum = retryRcpt.rows.length
              ? `RCP-${new Date().getFullYear()}-${String(retryRcpt.rows[0].receipt_counter).padStart(4, '0')}`
              : `RCP-${new Date().getFullYear()}-${Date.now().toString(36).toUpperCase()}-${attempts}`;
            continue;
          }
          throw insertErr;
        }
      }
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

      // Append-only trail, kept separate from the generic audit_log so
      // sales history/lifecycle can always be reconstructed on its own.
      try {
        await query(
          `INSERT INTO sale_audit_trail (sale_id, pharmacy_id, action, user_id, after_data)
           VALUES ($1,$2,'create',$3,$4)`,
          [sale.id, pharmacyId, userId || null, JSON.stringify({ ...sale, items })]
        );
      } catch (e) { console.error('sale_audit_trail write failed:', e.message); }

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

  // POST /api/sales/:id/void
  // Sales are NEVER hard-deleted. Voiding flags the record and reverses
  // stock so history, reports, and audit trails stay intact and traceable.
  app.post('/api/sales/:id/void', auth, async (req, res) => {
    const { pharmacyId, userId, role } = req.user;
    const { reason } = req.body || {};
    if (!['admin', 'manager'].includes(role))
      return err(res, 403, 'PERMISSION_DENIED', 'Only an admin or manager can void a sale.');
    if (!reason || !reason.trim())
      return err(res, 400, 'VALIDATION_REQUIRED', 'A void reason is required', 'reason');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const saleRes = await client.query(
        `SELECT * FROM sales WHERE id=$1 AND pharmacy_id=$2 FOR UPDATE`,
        [req.params.id, pharmacyId]
      );
      if (!saleRes.rows.length) { await client.query('ROLLBACK'); return err(res, 404, 'NOT_FOUND', 'Sale not found'); }
      const before = saleRes.rows[0];
      if (before.voided_at) { await client.query('ROLLBACK'); return err(res, 400, 'ALREADY_VOIDED', 'Sale already voided'); }

      const updRes = await client.query(
        `UPDATE sales SET voided_at=NOW(), voided_by=$1, void_reason=$2 WHERE id=$3 RETURNING *`,
        [userId, reason.trim(), before.id]
      );

      // Restore stock for every item on the voided sale
      const itemsRes = await client.query(`SELECT * FROM sale_items WHERE sale_id=$1`, [before.id]);
      for (const item of itemsRes.rows) {
        if (item.drug_id) {
          await client.query(
            `UPDATE drugs SET quantity=quantity+$1, updated_at=NOW() WHERE id=$2 AND pharmacy_id=$3`,
            [item.quantity, item.drug_id, pharmacyId]
          );
        }
      }

      await client.query('COMMIT');

      await query(
        `INSERT INTO sale_audit_trail (sale_id, pharmacy_id, action, user_id, before_data, after_data)
         VALUES ($1,$2,'void',$3,$4,$5)`,
        [before.id, pharmacyId, userId, JSON.stringify(before), JSON.stringify({ ...updRes.rows[0], reason })]
      );
      await audit(query, { req, action: 'sale.void', entity: 'sale', entityId: before.id, payload: { reason } });

      res.json({ message: 'Sale voided and stock restored', sale: updRes.rows[0] });
    } catch (e) {
      await client.query('ROLLBACK');
      return err(res, 500, 'SERVER_ERROR', e.message);
    } finally {
      client.release();
    }
  });

  // GET /api/sales/export — full, unpaginated backup of every sale for this
  // pharmacy, straight from Postgres. Used by the frontend's "Backup now"
  // button and by the nightly scheduler snapshot.
  app.get('/api/sales/export', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const result = await query(
        `SELECT s.*, json_agg(json_build_object('drug_id',si.drug_id,'drug_name',si.drug_name,'quantity',si.quantity,'unit_price',si.unit_price,'total_price',si.total_price)) as items
         FROM sales s LEFT JOIN sale_items si ON si.sale_id=s.id
         WHERE s.pharmacy_id=$1 GROUP BY s.id ORDER BY s.created_at ASC`,
        [pharmacyId]
      );
      res.json({ sales: result.rows, count: result.rows.length, exported_at: new Date().toISOString() });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // GET /api/activity
  app.get('/api/activity', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const { from, to, limit = 500 } = req.query;
    try {
      let whereExtra = ' AND s.voided_at IS NULL';
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