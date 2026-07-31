const err = require('./_err');
// ============================================================
// BAR MODULE — Tables, Orders, Kitchen (Phase 4)
// Gated behind subscriptions.modules->>'bar' via requireModule
// (see middleware/moduleAccess.js) — orgs without this module
// get a clean 403 rather than silent access. Entirely additive:
// new tables (bar_tables, bar_orders, bar_order_items), no
// existing pharmacy workflow is touched.
//
// Multi-tenant note: every read/write below filters by
// pharmacy_id (not just a bare id lookup) so a request scoped to
// one pharmacy can never touch another pharmacy's tables, orders,
// items, or payments — even if it guesses a valid numeric id.
// org_id is stamped on insert but pharmacy_id is what every
// subsequent query is scoped by, matching the rest of the app.
// ============================================================
module.exports = function registerBarRoutes(app, { query, pool, auth, can, audit, requireModule }) {
  const gate = requireModule('bar');

  // ── TABLES ────────────────────────────────────────────────
  app.get('/api/bar/tables', auth, can('bar:read'), gate, async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    try {
      const r = await query(
        `SELECT * FROM bar_tables WHERE pharmacy_id=$1 ORDER BY table_number ASC`,
        [pharmacyId]
      );
      res.json({ tables: r.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/bar/tables', auth, can('bar:write'), gate, async (req, res) => {
    const { pharmacyId, orgId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    const b = req.body || {};
    if (!b.table_number) return err(res, 400, 'VALIDATION_INVALID', 'table_number is required.');
    try {
      const r = await query(
        `INSERT INTO bar_tables (org_id, pharmacy_id, table_number, capacity) VALUES ($1,$2,$3,$4) RETURNING *`,
        [orgId, pharmacyId, b.table_number, b.capacity || 4]
      );
      res.json({ success: true, table: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.patch('/api/bar/tables/:id', auth, can('bar:write'), gate, async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    const b = req.body || {};
    try {
      const r = await query(
        `UPDATE bar_tables SET status=COALESCE($1,status), capacity=COALESCE($2,capacity), updated_at=NOW()
         WHERE id=$3 AND pharmacy_id=$4 RETURNING *`,
        [b.status || null, b.capacity || null, req.params.id, pharmacyId]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Table not found.');
      res.json({ success: true, table: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ── ORDERS ────────────────────────────────────────────────
  app.get('/api/bar/orders', auth, can('bar:read'), gate, async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    const status = req.query.status; // optional filter, e.g. ?status=open
    try {
      const r = await query(
        `SELECT bo.*, bt.table_number,
                COALESCE(json_agg(boi.* ORDER BY boi.created_at) FILTER (WHERE boi.id IS NOT NULL), '[]') AS items
         FROM bar_orders bo
         LEFT JOIN bar_tables bt ON bt.id = bo.table_id
         LEFT JOIN bar_order_items boi ON boi.order_id = bo.id
         WHERE bo.pharmacy_id=$1 ${status ? 'AND bo.status=$2' : ''}
         GROUP BY bo.id, bt.table_number
         ORDER BY bo.opened_at DESC LIMIT 100`,
        status ? [pharmacyId, status] : [pharmacyId]
      );
      res.json({ orders: r.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/bar/orders', auth, can('bar:write'), gate, async (req, res) => {
    const { pharmacyId, orgId, userId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    const b = req.body || {};
    try {
      // If a table_id was given, confirm it belongs to this pharmacy
      // before opening an order against it — otherwise a cross-tenant
      // table_id would silently attach and later get freed on close.
      if (b.table_id) {
        const t = await query(`SELECT id FROM bar_tables WHERE id=$1 AND pharmacy_id=$2`, [b.table_id, pharmacyId]);
        if (!t.rows.length) return err(res, 404, 'NOT_FOUND', 'Table not found.', 'table_id');
      }
      const r = await query(
        `INSERT INTO bar_orders (org_id, pharmacy_id, table_id, opened_by) VALUES ($1,$2,$3,$4) RETURNING *`,
        [orgId, pharmacyId, b.table_id || null, userId || null]
      );
      if (b.table_id) {
        await query(`UPDATE bar_tables SET status='occupied', updated_at=NOW() WHERE id=$1 AND pharmacy_id=$2`, [b.table_id, pharmacyId]);
      }
      if (audit) await audit(query, { req, action: 'bar.order.open', entity: 'bar_order', entityId: r.rows[0].id, payload: {} });
      res.json({ success: true, order: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // Add an item to an order — this is what feeds the Kitchen view below.
  // Scoped by pharmacy_id via the bar_orders join so an order id from
  // another tenant can't be added to, and the total recompute below
  // is likewise scoped so it can't touch another pharmacy's order.
  app.post('/api/bar/orders/:id/items', auth, can('bar:write'), gate, async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    const b = req.body || {};
    if (!b.item_name) return err(res, 400, 'VALIDATION_INVALID', 'item_name is required.');
    try {
      const ord = await query(`SELECT id, status FROM bar_orders WHERE id=$1 AND pharmacy_id=$2`, [req.params.id, pharmacyId]);
      if (!ord.rows.length) return err(res, 404, 'NOT_FOUND', 'Order not found.');
      if (ord.rows[0].status !== 'open') return err(res, 409, 'CONFLICT_STATE', 'Order is already closed.');
      const r = await query(
        `INSERT INTO bar_order_items (order_id, item_name, quantity, unit_price) VALUES ($1,$2,$3,$4) RETURNING *`,
        [req.params.id, b.item_name, b.quantity || 1, b.unit_price || 0]
      );
      await query(
        `UPDATE bar_orders SET total_amount = (
           SELECT COALESCE(SUM(quantity * unit_price),0) FROM bar_order_items WHERE order_id=$1
         ) WHERE id=$1 AND pharmacy_id=$2`,
        [req.params.id, pharmacyId]
      );
      res.json({ success: true, item: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // Void an order — only for tabs with nothing owed (e.g. a table was
  // opened by mistake, or every item was removed). Anything with a
  // balance must be settled through /payments below; you can't "close"
  // your way out of an unpaid bill.
  app.post('/api/bar/orders/:id/close', auth, can('bar:write'), gate, async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    try {
      const ord = await query(`SELECT * FROM bar_orders WHERE id=$1 AND pharmacy_id=$2`, [req.params.id, pharmacyId]);
      if (!ord.rows.length) return err(res, 404, 'NOT_FOUND', 'Order not found.');
      if (ord.rows[0].status !== 'open') return err(res, 409, 'CONFLICT_STATE', 'Order is already closed.');
      const paidRes = await query(`SELECT COALESCE(SUM(amount),0) AS paid FROM bar_payments WHERE order_id=$1`, [ord.rows[0].id]);
      const balanceDue = Number(ord.rows[0].total_amount) - Number(paidRes.rows[0].paid);
      // Small epsilon for float rounding on currency math, matching the
      // payments route's tolerance.
      if (balanceDue > 0.01) {
        return err(res, 409, 'CONFLICT_BALANCE_DUE', `This order has a balance due (UGX ${balanceDue.toFixed(2)} remaining) — settle it via payments instead of closing it.`);
      }
      const r = await query(
        `UPDATE bar_orders SET status='void', closed_at=NOW() WHERE id=$1 AND pharmacy_id=$2 RETURNING *`,
        [req.params.id, pharmacyId]
      );
      if (r.rows[0].table_id) {
        await query(`UPDATE bar_tables SET status='available', updated_at=NOW() WHERE id=$1 AND pharmacy_id=$2`, [r.rows[0].table_id, pharmacyId]);
      }
      if (audit) await audit(query, { req, action: 'bar.order.void', entity: 'bar_order', entityId: r.rows[0].id, payload: {} });
      res.json({ success: true, order: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  const PAYMENT_METHODS = ['cash', 'mobile_money', 'card', 'other'];

  // List payments recorded against an order — used for a receipt view
  // and by reporting. Scoped through the bar_orders join so payments
  // on another tenant's order id can never be listed.
  app.get('/api/bar/orders/:id/payments', auth, can('bar:read'), gate, async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    try {
      const r = await query(
        `SELECT bp.* FROM bar_payments bp
         JOIN bar_orders bo ON bo.id = bp.order_id
         WHERE bp.order_id=$1 AND bo.pharmacy_id=$2
         ORDER BY bp.created_at ASC`,
        [req.params.id, pharmacyId]
      );
      res.json({ payments: r.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // Record a payment against an order. Supports split/partial payments —
  // e.g. part cash, part mobile money on the same bill. Once payments
  // cover the full total_amount the order auto-closes (status='paid')
  // and the table is freed, so there's no separate "settle" step.
  // Locked (FOR UPDATE) and pharmacy-scoped so two terminals can't
  // double-spend the same balance, and a request can't be aimed at
  // another tenant's order.
  app.post('/api/bar/orders/:id/payments', auth, can('bar-payments:write'), gate, async (req, res) => {
    const { pharmacyId, userId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    const b = req.body || {};
    const method = b.method;
    const amount = Number(b.amount);
    const clientTxnId = b.client_txn_id || null;
    if (!PAYMENT_METHODS.includes(method)) return err(res, 400, 'VALIDATION_INVALID', `method must be one of ${PAYMENT_METHODS.join(', ')}.`, 'method');
    if (!amount || amount <= 0) return err(res, 400, 'VALIDATION_INVALID', 'amount must be a positive number.', 'amount');
    const tendered = b.tendered !== undefined && b.tendered !== null ? Number(b.tendered) : null;
    if (method === 'cash' && tendered !== null && tendered < amount) {
      return err(res, 400, 'VALIDATION_INVALID', 'tendered cannot be less than amount.', 'tendered');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const ordRes = await client.query(
        `SELECT * FROM bar_orders WHERE id=$1 AND pharmacy_id=$2 FOR UPDATE`,
        [req.params.id, pharmacyId]
      );
      if (!ordRes.rows.length) { await client.query('ROLLBACK'); return err(res, 404, 'NOT_FOUND', 'Order not found.'); }
      const order = ordRes.rows[0];

      // Idempotency: check for a replay BEFORE the open-status check. If
      // this exact client_txn_id already went through — including one
      // that fully paid the bill and closed it — a device retrying after
      // a dropped response must get the same success back, not an
      // "already closed" error for something it itself just closed.
      if (clientTxnId) {
        const existingPay = await client.query(
          `SELECT * FROM bar_payments WHERE order_id=$1 AND client_txn_id=$2`,
          [order.id, clientTxnId]
        );
        if (existingPay.rows.length) {
          await client.query('ROLLBACK');
          const freshOrder = await query(`SELECT * FROM bar_orders WHERE id=$1 AND pharmacy_id=$2`, [order.id, pharmacyId]);
          const paidSoFar = await query(`SELECT COALESCE(SUM(amount),0) AS paid FROM bar_payments WHERE order_id=$1`, [order.id]);
          const finalOrder = freshOrder.rows[0];
          return res.json({
            success: true,
            replay: true,
            payment: existingPay.rows[0],
            order: { ...finalOrder, balance_due: Number(finalOrder.total_amount) - Number(paidSoFar.rows[0].paid) }
          });
        }
      }

      if (order.status !== 'open') { await client.query('ROLLBACK'); return err(res, 409, 'CONFLICT_STATE', 'Order is already closed.'); }

      const paidRes = await client.query(`SELECT COALESCE(SUM(amount),0) AS paid FROM bar_payments WHERE order_id=$1`, [order.id]);
      const alreadyPaid = Number(paidRes.rows[0].paid);
      const balanceDue = Number(order.total_amount) - alreadyPaid;
      // Small epsilon for float rounding on currency math.
      if (amount > balanceDue + 0.01) {
        await client.query('ROLLBACK');
        return err(res, 409, 'CONFLICT_OVERPAYMENT', `Amount exceeds balance due (UGX ${balanceDue.toFixed(2)} remaining).`, 'amount');
      }

      const changeDue = method === 'cash' && tendered !== null ? +(tendered - amount).toFixed(2) : null;

      const payRes = await client.query(
        `INSERT INTO bar_payments (order_id, pharmacy_id, method, amount, reference, tendered, change_due, received_by, client_txn_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [order.id, pharmacyId, method, amount, b.reference || null, tendered, changeDue, userId || null, clientTxnId]
      );

      const newPaid = alreadyPaid + amount;
      let updatedOrder = order;
      if (newPaid + 0.01 >= Number(order.total_amount)) {
        const methodsRes = await client.query(`SELECT DISTINCT method FROM bar_payments WHERE order_id=$1`, [order.id]);
        const summaryMethod = methodsRes.rows.length > 1 ? 'split' : (methodsRes.rows[0]?.method || method);
        const closeRes = await client.query(
          `UPDATE bar_orders SET status='paid', closed_at=NOW(), payment_method=$3,
                  customer_name=COALESCE($4, customer_name), customer_phone=COALESCE($5, customer_phone)
           WHERE id=$1 AND pharmacy_id=$2 RETURNING *`,
          [order.id, pharmacyId, summaryMethod, b.customer_name || null, b.customer_phone || null]
        );
        updatedOrder = closeRes.rows[0];
        if (updatedOrder.table_id) {
          await client.query(`UPDATE bar_tables SET status='available', updated_at=NOW() WHERE id=$1 AND pharmacy_id=$2`, [updatedOrder.table_id, pharmacyId]);
        }
      }

      await client.query('COMMIT');
      if (audit) await audit(query, { req, action: 'bar.payment.record', entity: 'bar_payment', entityId: payRes.rows[0].id, payload: { method, amount } });
      res.json({
        success: true,
        payment: payRes.rows[0],
        order: { ...updatedOrder, balance_due: Number(updatedOrder.total_amount) - (newPaid > Number(updatedOrder.total_amount) ? Number(updatedOrder.total_amount) : newPaid) }
      });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      return err(res, 500, 'SERVER_ERROR', e.message);
    } finally {
      client.release();
    }
  });

  // ── KITCHEN ───────────────────────────────────────────────
  // Items still pending/preparing across all open orders — this
  // IS the kitchen screen, no separate table needed.
  app.get('/api/bar/kitchen', auth, can('bar:read'), gate, async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    try {
      const r = await query(
        `SELECT boi.*, bo.table_id, bt.table_number
         FROM bar_order_items boi
         JOIN bar_orders bo ON bo.id = boi.order_id
         LEFT JOIN bar_tables bt ON bt.id = bo.table_id
         WHERE bo.pharmacy_id=$1 AND bo.status='open' AND boi.status IN ('pending','preparing')
         ORDER BY boi.created_at ASC`,
        [pharmacyId]
      );
      res.json({ items: r.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // Scoped through the bar_orders join so an item id belonging to
  // another tenant's order can't have its status changed.
  app.patch('/api/bar/order-items/:id', auth, can('bar:write'), gate, async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    const b = req.body || {};
    if (!['pending', 'preparing', 'ready', 'served'].includes(b.status)) {
      return err(res, 400, 'VALIDATION_INVALID', 'status must be one of pending, preparing, ready, served.');
    }
    try {
      const r = await query(
        `UPDATE bar_order_items boi SET status=$1
         FROM bar_orders bo
         WHERE boi.id=$2 AND boi.order_id=bo.id AND bo.pharmacy_id=$3
         RETURNING boi.*`,
        [b.status, req.params.id, pharmacyId]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Order item not found.');
      res.json({ success: true, item: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });
};
