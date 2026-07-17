'use strict';
const err = require('./_err');

// ============================================================
// MedVault — Loyalty Programme Routes (Phase 2)
//
// Earn rate:  1 point per 1,000 UGX spent
// Redeem rate: 1 point = 10 UGX off
// Earn/redeem are embedded in POST /api/sales (sales.js)
// These routes expose the loyalty account to the frontend.
// ============================================================

const EARN_RATE   = 1;        // points per 1,000 UGX
const REDEEM_RATE = 10;       // UGX per point

module.exports = function registerLoyaltyRoutes(app, { query, pool, auth, can, audit }) {

  // GET /api/loyalty/:customerId  — account summary + recent history
  app.get('/api/loyalty/:customerId', auth, async (req, res) => {
    const { orgId } = req.user;
    try {
      const [account, history] = await Promise.all([
        query(
          `SELECT la.*, c.name as customer_name, c.phone as customer_phone
           FROM loyalty_accounts la
           JOIN customers c ON c.id = la.customer_id
           WHERE la.customer_id = $1 AND la.org_id = $2`,
          [req.params.customerId, orgId]
        ),
        query(
          `SELECT lt.*, s.receipt_number
           FROM loyalty_transactions lt
           LEFT JOIN sales s ON s.id = lt.sale_id
           WHERE lt.account_id = (
             SELECT id FROM loyalty_accounts WHERE customer_id=$1 AND org_id=$2
           )
           ORDER BY lt.created_at DESC LIMIT 20`,
          [req.params.customerId, orgId]
        ),
      ]);

      if (!account.rows.length) {
        // No account yet — return a zero-balance placeholder
        return res.json({
          account: null,
          history: [],
          earn_rate: EARN_RATE,
          redeem_rate: REDEEM_RATE,
          redeem_value: 0,
        });
      }

      const acc = account.rows[0];
      res.json({
        account: acc,
        history: history.rows,
        earn_rate: EARN_RATE,
        redeem_rate: REDEEM_RATE,
        redeem_value: acc.points_balance * REDEEM_RATE,
      });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // POST /api/loyalty/enroll  — create a loyalty account for a customer
  app.post('/api/loyalty/enroll', auth, async (req, res) => {
    const { orgId, pharmacyId, userId } = req.user;
    const { customer_id } = req.body;
    if (!customer_id) return err(res, 400, 'VALIDATION_REQUIRED', 'customer_id is required', 'customer_id');

    try {
      // Verify customer belongs to this org
      const cust = await query(
        `SELECT id, name FROM customers WHERE id=$1 AND pharmacy_id=$2`,
        [customer_id, pharmacyId]
      );
      if (!cust.rows.length) return err(res, 404, 'NOT_FOUND', 'Customer not found', 'customer_id');

      const r = await query(
        `INSERT INTO loyalty_accounts (org_id, pharmacy_id, customer_id)
         VALUES ($1,$2,$3)
         ON CONFLICT (customer_id) DO NOTHING
         RETURNING *`,
        [orgId, pharmacyId, customer_id]
      );

      await audit(query, {
        req, action: 'loyalty.enroll', entity: 'loyalty_account',
        entityId: r.rows[0]?.id || null,
        payload: { customer_id, customer_name: cust.rows[0].name },
      });

      res.status(201).json({
        message: `✅ ${cust.rows[0].name} enrolled in loyalty programme!`,
        account: r.rows[0] || null,
      });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // POST /api/loyalty/:customerId/adjust  — manual point adjustment (owner only)
  app.post('/api/loyalty/:customerId/adjust', auth, can('reports:financial'), async (req, res) => {
    const { orgId, pharmacyId, userId } = req.user;
    const { points, notes } = req.body;
    if (points === undefined || points === null) return err(res, 400, 'VALIDATION_REQUIRED', 'points is required', 'points');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const acc = await client.query(
        `SELECT id, points_balance FROM loyalty_accounts WHERE customer_id=$1 AND org_id=$2 FOR UPDATE`,
        [req.params.customerId, orgId]
      );
      if (!acc.rows.length) return err(res, 404, 'NOT_FOUND', 'Loyalty account not found — enroll customer first', 'customer_id');

      const account = acc.rows[0];
      const newBalance = Math.max(0, account.points_balance + parseInt(points));

      await client.query(
        `UPDATE loyalty_accounts
         SET points_balance=$1,
             total_earned   = CASE WHEN $2 > 0 THEN total_earned   + $2 ELSE total_earned   END,
             total_redeemed = CASE WHEN $2 < 0 THEN total_redeemed - $2 ELSE total_redeemed END,
             updated_at=NOW()
         WHERE id=$3`,
        [newBalance, parseInt(points), account.id]
      );

      await client.query(
        `INSERT INTO loyalty_transactions (account_id, pharmacy_id, type, points, balance_after, notes, created_by)
         VALUES ($1,$2,'adjust',$3,$4,$5,$6)`,
        [account.id, pharmacyId, parseInt(points), newBalance, notes || 'Manual adjustment', userId]
      );

      await client.query('COMMIT');
      await audit(query, {
        req, action: 'loyalty.adjust', entity: 'loyalty_account', entityId: account.id,
        payload: { customer_id: req.params.customerId, points, newBalance, notes },
      });

      res.json({ message: '✅ Points adjusted!', new_balance: newBalance });
    } catch (e) {
      await client.query('ROLLBACK');
      return err(res, 500, 'SERVER_ERROR', e.message);
    } finally { client.release(); }
  });

  // GET /api/loyalty  — list all loyalty accounts for this org (paginated)
  app.get('/api/loyalty', auth, async (req, res) => {
    const { orgId } = req.user;
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const offset = (page - 1) * limit;
    try {
      const [rows, countRes] = await Promise.all([
        query(
          `SELECT la.*, c.name as customer_name, c.phone as customer_phone
           FROM loyalty_accounts la JOIN customers c ON c.id=la.customer_id
           WHERE la.org_id=$1
           ORDER BY la.points_balance DESC
           LIMIT $2 OFFSET $3`,
          [orgId, limit, offset]
        ),
        query(`SELECT COUNT(*) as total FROM loyalty_accounts WHERE org_id=$1`, [orgId]),
      ]);
      const total = parseInt(countRes.rows[0].total);
      res.json({
        accounts: rows.rows,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        earn_rate: EARN_RATE,
        redeem_rate: REDEEM_RATE,
      });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

};
