const err = require('./_err');
// ============================================================
// BAR MODULE — Tables, Orders, Kitchen (Phase 4)
// Gated behind subscriptions.modules->>'bar' via requireModule
// (see middleware/moduleAccess.js) — orgs without this module
// get a clean 403 rather than silent access. Entirely additive:
// new tables (bar_tables, bar_orders, bar_order_items), no
// existing pharmacy workflow is touched.
// ============================================================
module.exports = function registerBarRoutes(app, { query, pool, auth, can, audit, requireModule, hash, compare }) {
  const gate = requireModule('bar');

  // Any owner/manager at this pharmacy can approve — not just the one
  // who happens to be logged in — since on a physical terminal it's
  // whichever manager is on shift who punches their PIN in. Returns the
  // approving manager's user id, or null if no PIN matched.
  async function verifyManagerPin(pharmacyId, pin) {
    if (!pin) return null;
    const r = await query(
      `SELECT id, pin_hash FROM users WHERE pharmacy_id=$1 AND role IN ('owner','manager') AND pin_hash IS NOT NULL AND is_active=true`,
      [pharmacyId]
    );
    for (const u of r.rows) {
      if (compare(String(pin), u.pin_hash)) return u.id;
    }
    return null;
  }

  // Single source of truth for total_amount: subtotal of non-voided
  // items, minus the order's discount, floored at 0. Called inside
  // every transaction that can change what's owed (add item, void
  // item, apply discount) so the figure customers are charged and the
  // figure reports aggregate can never drift apart.
  async function recomputeOrderTotal(client, orderId) {
    await client.query(
      `UPDATE bar_orders SET total_amount = GREATEST(
         (SELECT COALESCE(SUM(quantity * unit_price),0) FROM bar_order_items WHERE order_id=$1 AND voided_at IS NULL)
         - discount_amount, 0)
       WHERE id=$1`,
      [orderId]
    );
  }

  // ── MANAGER APPROVAL PIN ──────────────────────────────────
  // Owner/manager sets a short PIN once; it's what gets typed on the
  // terminal to approve a discount or void (see verifyManagerPin above).
  app.post('/api/bar/manager-pin', auth, can('bar-pin:write'), gate, async (req, res) => {
    const { userId } = req.user;
    const pin = String(req.body?.pin || '');
    if (!/^\d{4,6}$/.test(pin)) return err(res, 400, 'VALIDATION_INVALID', 'PIN must be 4-6 digits.', 'pin');
    try {
      await query(`UPDATE users SET pin_hash=$1 WHERE id=$2`, [hash(pin), userId]);
      res.json({ success: true, message: 'Manager PIN set.' });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

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
                COALESCE(json_agg(boi.* ORDER BY boi.created_at) FILTER (WHERE boi.id IS NOT NULL), '[]') AS items,
                COALESCE((SELECT SUM(bp.amount) FROM bar_payments bp WHERE bp.order_id = bo.id), 0) AS paid_amount,
                bo.total_amount - COALESCE((SELECT SUM(bp.amount) FROM bar_payments bp WHERE bp.order_id = bo.id), 0) AS balance_due
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
      if (b.table_id) {
        const tableCheck = await query(`SELECT id FROM bar_tables WHERE id=$1 AND pharmacy_id=$2`, [b.table_id, pharmacyId]);
        if (!tableCheck.rows.length) return err(res, 404, 'NOT_FOUND', 'Table not found.');
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
  // Supports either a catalog menu_item_id (preferred — auto-fills name/price
  // and decrements stock) or legacy free-typed item_name/unit_price.
  app.post('/api/bar/orders/:id/items', auth, can('bar:write'), gate, async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    const b = req.body || {};
    const quantity = b.quantity || 1;
    const clientTxnId = b.client_txn_id || null;
    let item_name = b.item_name;
    let unit_price = b.unit_price || 0;

    // Everything below runs on one client inside a single transaction:
    // verify the order is this pharmacy's, read stock, insert the line
    // item, decrement stock, recompute the order total. The order row
    // is locked first (so it can't be closed out from under us) and the
    // stock row is locked with SELECT ... FOR UPDATE, so two waiters
    // adding the same drink at the same moment can't both read the same
    // quantity_on_hand and oversell it — the second request queues
    // behind the first until it commits.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const orderCheck = await client.query(
        `SELECT id FROM bar_orders WHERE id=$1 AND pharmacy_id=$2 FOR UPDATE`,
        [req.params.id, pharmacyId]
      );
      if (!orderCheck.rows.length) { await client.query('ROLLBACK'); return err(res, 404, 'NOT_FOUND', 'Order not found.'); }

      // Idempotency: a device that went offline mid-add will retry the
      // exact same client_txn_id once it reconnects, possibly after the
      // original request actually succeeded server-side but the response
      // never made it back. If we've already recorded this txn, hand back
      // the existing row untouched rather than adding the item (and
      // decrementing stock) a second time.
      if (clientTxnId) {
        const existing = await client.query(
          `SELECT * FROM bar_order_items WHERE order_id=$1 AND client_txn_id=$2`,
          [req.params.id, clientTxnId]
        );
        if (existing.rows.length) {
          await client.query('ROLLBACK');
          return res.json({ success: true, item: existing.rows[0], replay: true });
        }
      }

      let stockRow = null;
      if (b.menu_item_id) {
        const mi = await client.query(
          `SELECT * FROM bar_menu_items WHERE id=$1 AND pharmacy_id=$2 AND active=true`,
          [b.menu_item_id, pharmacyId]
        );
        if (!mi.rows.length) { await client.query('ROLLBACK'); return err(res, 404, 'NOT_FOUND', 'Menu item not found or inactive.'); }
        item_name = mi.rows[0].name;
        unit_price = mi.rows[0].price;

        const stockRes = await client.query(
          `SELECT * FROM bar_stock WHERE menu_item_id=$1 FOR UPDATE`,
          [b.menu_item_id]
        );
        stockRow = stockRes.rows[0] || null;
        if (stockRow && stockRow.quantity_on_hand < quantity) {
          await client.query('ROLLBACK');
          return err(res, 409, 'STOCK_INSUFFICIENT', `Only ${stockRow.quantity_on_hand} left in stock.`);
        }
      }
      if (!item_name) { await client.query('ROLLBACK'); return err(res, 400, 'VALIDATION_INVALID', 'item_name or menu_item_id is required.'); }

      const r = await client.query(
        `INSERT INTO bar_order_items (order_id, item_name, quantity, unit_price, menu_item_id, client_txn_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.params.id, item_name, quantity, unit_price, b.menu_item_id || null, clientTxnId]
      );

      if (stockRow) {
        await client.query(
          `UPDATE bar_stock SET quantity_on_hand = GREATEST(quantity_on_hand - $1, 0), updated_at=NOW() WHERE menu_item_id=$2`,
          [quantity, b.menu_item_id]
        );
      }

      await recomputeOrderTotal(client, req.params.id);

      await client.query('COMMIT');
      res.json({ success: true, item: r.rows[0] });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      return err(res, 500, 'SERVER_ERROR', e.message);
    } finally {
      client.release();
    }
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
  // and by the reports below.
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
      // a dropped response must get the same success back, not a
      // "already closed" error for something it itself just closed.
      if (clientTxnId) {
        const existingPay = await client.query(
          `SELECT * FROM bar_payments WHERE order_id=$1 AND client_txn_id=$2`,
          [order.id, clientTxnId]
        );
        if (existingPay.rows.length) {
          await client.query('ROLLBACK');
          const freshOrder = await query(`SELECT * FROM bar_orders WHERE id=$1`, [order.id]);
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
          `UPDATE bar_orders SET status='paid', closed_at=NOW(), payment_method=$2,
                  customer_name=COALESCE($3, customer_name), customer_phone=COALESCE($4, customer_phone)
           WHERE id=$1 RETURNING *`,
          [order.id, summaryMethod, b.customer_name || null, b.customer_phone || null]
        );
        updatedOrder = closeRes.rows[0];
        if (updatedOrder.table_id) {
          await client.query(`UPDATE bar_tables SET status='available', updated_at=NOW() WHERE id=$1`, [updatedOrder.table_id]);
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

  // Apply (or replace) a discount on the whole bill. Requires a
  // manager PIN — staff can key in the request, but a manager has to
  // approve it, and we record exactly who.
  app.post('/api/bar/orders/:id/discount', auth, can('bar:write'), gate, async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    const b = req.body || {};
    const type = b.type; // 'percent' | 'fixed'
    const value = Number(b.value);
    if (!['percent', 'fixed'].includes(type)) return err(res, 400, 'VALIDATION_INVALID', "type must be 'percent' or 'fixed'.", 'type');
    if (!value || value <= 0) return err(res, 400, 'VALIDATION_INVALID', 'value must be a positive number.', 'value');
    if (type === 'percent' && value > 100) return err(res, 400, 'VALIDATION_INVALID', 'percent discount cannot exceed 100.', 'value');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const managerId = await verifyManagerPin(pharmacyId, b.manager_pin);
      if (!managerId) { await client.query('ROLLBACK'); return err(res, 403, 'AUTH_INVALID_PIN', 'Invalid or missing manager PIN.', 'manager_pin'); }

      const ordRes = await client.query(`SELECT * FROM bar_orders WHERE id=$1 AND pharmacy_id=$2 FOR UPDATE`, [req.params.id, pharmacyId]);
      if (!ordRes.rows.length) { await client.query('ROLLBACK'); return err(res, 404, 'NOT_FOUND', 'Order not found.'); }
      const order = ordRes.rows[0];
      if (order.status !== 'open') { await client.query('ROLLBACK'); return err(res, 409, 'CONFLICT_STATE', 'Order is already closed.'); }

      const subtotalRes = await client.query(
        `SELECT COALESCE(SUM(quantity*unit_price),0) AS subtotal FROM bar_order_items WHERE order_id=$1 AND voided_at IS NULL`,
        [order.id]
      );
      const subtotal = Number(subtotalRes.rows[0].subtotal);
      const discountAmount = Math.min(type === 'percent' ? subtotal * value / 100 : value, subtotal);

      const paidRes = await client.query(`SELECT COALESCE(SUM(amount),0) AS paid FROM bar_payments WHERE order_id=$1`, [order.id]);
      const alreadyPaid = Number(paidRes.rows[0].paid);
      if (subtotal - discountAmount < alreadyPaid - 0.01) {
        await client.query('ROLLBACK');
        return err(res, 409, 'CONFLICT_BELOW_PAID', `Discount would bring the total below what's already been paid (UGX ${alreadyPaid.toFixed(2)}).`);
      }

      await client.query(
        `UPDATE bar_orders SET discount_amount=$1, discount_reason=$2, discount_approved_by=$3 WHERE id=$4`,
        [discountAmount, b.reason || null, managerId, order.id]
      );
      await recomputeOrderTotal(client, order.id);
      const updated = await client.query(`SELECT * FROM bar_orders WHERE id=$1`, [order.id]);

      await client.query('COMMIT');
      if (audit) await audit(query, { req, action: 'bar.order.discount', entity: 'bar_order', entityId: order.id, payload: { type, value, discountAmount, approved_by: managerId } });
      res.json({ success: true, order: updated.rows[0] });
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
         WHERE bo.pharmacy_id=$1 AND bo.status='open' AND boi.status IN ('pending','preparing') AND boi.voided_at IS NULL
         ORDER BY boi.created_at ASC`,
        [pharmacyId]
      );
      res.json({ items: r.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.patch('/api/bar/order-items/:id', auth, can('bar:write'), gate, async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    const b = req.body || {};
    if (!['pending', 'preparing', 'ready', 'served'].includes(b.status)) {
      return err(res, 400, 'VALIDATION_INVALID', 'status must be one of pending, preparing, ready, served.');
    }
    try {
      // bar_order_items has no pharmacy_id of its own — it belongs to a
      // pharmacy only via its parent order, so the tenant check has to
      // join through bar_orders rather than filter directly.
      const r = await query(
        `UPDATE bar_order_items boi SET status=$1
         FROM bar_orders bo
         WHERE boi.id=$2 AND boi.order_id=bo.id AND bo.pharmacy_id=$3 AND boi.voided_at IS NULL
         RETURNING boi.*`,
        [b.status, req.params.id, pharmacyId]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Order item not found.');
      res.json({ success: true, item: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // Void a line item — requires a manager PIN. If the item hadn't been
  // served yet (still pending/preparing/ready) we restock it, since
  // nothing was actually poured/served; if it was already served we
  // don't restock, on the assumption the drink was consumed and this
  // void is a comp/write-off rather than an unmade item.
  app.post('/api/bar/order-items/:id/void', auth, can('bar:write'), gate, async (req, res) => {
    const { pharmacyId, userId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    const b = req.body || {};

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const managerId = await verifyManagerPin(pharmacyId, b.manager_pin);
      if (!managerId) { await client.query('ROLLBACK'); return err(res, 403, 'AUTH_INVALID_PIN', 'Invalid or missing manager PIN.', 'manager_pin'); }

      const itemRes = await client.query(
        `SELECT boi.* FROM bar_order_items boi
         JOIN bar_orders bo ON bo.id = boi.order_id
         WHERE boi.id=$1 AND bo.pharmacy_id=$2 AND bo.status='open' FOR UPDATE OF boi`,
        [req.params.id, pharmacyId]
      );
      if (!itemRes.rows.length) { await client.query('ROLLBACK'); return err(res, 404, 'NOT_FOUND', 'Order item not found or its order is already closed.'); }
      const item = itemRes.rows[0];
      if (item.voided_at) { await client.query('ROLLBACK'); return err(res, 409, 'CONFLICT_STATE', 'Item is already voided.'); }

      await client.query(
        `UPDATE bar_order_items SET voided_at=NOW(), voided_reason=$1, voided_by=$2, voided_approved_by=$3 WHERE id=$4`,
        [b.reason || null, userId || null, managerId, item.id]
      );

      if (item.menu_item_id && item.status !== 'served') {
        await client.query(
          `UPDATE bar_stock SET quantity_on_hand = quantity_on_hand + $1, updated_at=NOW() WHERE menu_item_id=$2`,
          [item.quantity, item.menu_item_id]
        );
      }

      await recomputeOrderTotal(client, item.order_id);

      await client.query('COMMIT');
      if (audit) await audit(query, { req, action: 'bar.item.void', entity: 'bar_order_item', entityId: item.id, payload: { reason: b.reason, approved_by: managerId } });
      res.json({ success: true, voided_item_id: item.id });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      return err(res, 500, 'SERVER_ERROR', e.message);
    } finally {
      client.release();
    }
  });

  // ── MENU CATALOG ──────────────────────────────────────────
  // Everyone taking orders needs to see the menu.
  app.get('/api/bar/menu-items', auth, can('bar:read'), gate, async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    try {
      const r = await query(
        `SELECT bmi.*, bs.quantity_on_hand, bs.low_stock_threshold
         FROM bar_menu_items bmi
         LEFT JOIN bar_stock bs ON bs.menu_item_id = bmi.id
         WHERE bmi.pharmacy_id=$1
         ORDER BY bmi.category, bmi.name`,
        [pharmacyId]
      );
      res.json({ items: r.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // Only owner/manager/super_admin can edit the menu.
  app.post('/api/bar/menu-items', auth, can('bar-menu:write'), gate, async (req, res) => {
    const { pharmacyId, orgId } = req.user;
    const b = req.body || {};
    if (!b.name) return err(res, 400, 'VALIDATION_INVALID', 'name is required.', 'name');
    if (b.price === undefined || b.price === null) return err(res, 400, 'VALIDATION_INVALID', 'price is required.', 'price');
    try {
const r = await query(
  `INSERT INTO bar_menu_items (org_id, pharmacy_id, name, category, price, unit, cost_price, supplier, active)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true) RETURNING *`,
  [orgId, pharmacyId, b.name, b.category || null, b.price, b.unit || null, b.cost_price || null, b.supplier || null]
);
      const menuItem = r.rows[0];
      await query(
        `INSERT INTO bar_stock (menu_item_id, quantity_on_hand, low_stock_threshold)
         VALUES ($1,$2,$3)`,
        [menuItem.id, b.initial_quantity || 0, b.low_stock_threshold || 0]
      );
      if (audit) await audit(query, { req, action: 'bar.menu_item.create', entity: 'bar_menu_item', entityId: menuItem.id, payload: b });
      res.json({ success: true, item: menuItem });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.patch('/api/bar/menu-items/:id', auth, can('bar-menu:write'), gate, async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    const b = req.body || {};
    const fields = [];
    const values = [];
    let i = 1;
    if (b.name !== undefined) { fields.push(`name=$${i++}`); values.push(b.name); }
    if (b.category !== undefined) { fields.push(`category=$${i++}`); values.push(b.category); }
    if (b.price !== undefined) { fields.push(`price=$${i++}`); values.push(b.price); }
    if (b.active !== undefined) { fields.push(`active=$${i++}`); values.push(b.active); }
    if (b.unit !== undefined) { fields.push(`unit=$${i++}`); values.push(b.unit || null); }
    if (b.cost_price !== undefined) { fields.push(`cost_price=$${i++}`); values.push(b.cost_price || null); }
    if (b.supplier !== undefined) { fields.push(`supplier=$${i++}`); values.push(b.supplier || null); }
    if (!fields.length) return err(res, 400, 'VALIDATION_INVALID', 'No fields to update.');
    fields.push(`updated_at=NOW()`);
    values.push(req.params.id, pharmacyId);
    try {
      const r = await query(
        `UPDATE bar_menu_items SET ${fields.join(', ')} WHERE id=$${i++} AND pharmacy_id=$${i} RETURNING *`,
        values
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Menu item not found.');
      if (audit) await audit(query, { req, action: 'bar.menu_item.update', entity: 'bar_menu_item', entityId: r.rows[0].id, payload: b });
      res.json({ success: true, item: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ── STOCK ADJUSTMENT ──────────────────────────────────────
  app.patch('/api/bar/stock/:menuItemId', auth, can('bar-menu:write'), gate, async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    const b = req.body || {};
    if (b.quantity_on_hand === undefined && b.adjustment === undefined) {
      return err(res, 400, 'VALIDATION_INVALID', 'Provide quantity_on_hand (absolute) or adjustment (relative).');
    }
    try {
      // bar_stock has no pharmacy_id of its own — join through
      // bar_menu_items so this can't touch another pharmacy's stock.
      let r;
      if (b.quantity_on_hand !== undefined) {
        if (b.quantity_on_hand < 0) return err(res, 400, 'STOCK_INVALID_QUANTITY', 'quantity_on_hand cannot be negative.');
        r = await query(
          `UPDATE bar_stock bs SET quantity_on_hand=$1, low_stock_threshold=COALESCE($2, bs.low_stock_threshold), updated_at=NOW()
           FROM bar_menu_items bmi
           WHERE bs.menu_item_id=$3 AND bs.menu_item_id=bmi.id AND bmi.pharmacy_id=$4
           RETURNING bs.*`,
          [b.quantity_on_hand, b.low_stock_threshold ?? null, req.params.menuItemId, pharmacyId]
        );
      } else {
        r = await query(
          `UPDATE bar_stock bs SET quantity_on_hand = GREATEST(bs.quantity_on_hand + $1, 0), updated_at=NOW()
           FROM bar_menu_items bmi
           WHERE bs.menu_item_id=$2 AND bs.menu_item_id=bmi.id AND bmi.pharmacy_id=$3
           RETURNING bs.*`,
          [b.adjustment, req.params.menuItemId, pharmacyId]
        );
      }
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Stock record not found for this menu item.');
      if (audit) await audit(query, { req, action: 'bar.stock.adjust', entity: 'bar_stock', entityId: r.rows[0].id, payload: b });
      res.json({ success: true, stock: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ── REPORTS ───────────────────────────────────────────────
  // Owner/manager only (see 'bar-reports:read' in permissions.js) —
  // staff taking orders don't need visibility into revenue figures.
  app.get('/api/bar/reports/summary', auth, can('bar-reports:read'), gate, async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    // Defaults to the trailing 7 days when no range is given.
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) return err(res, 400, 'VALIDATION_INVALID', 'from/to must be valid dates.');

    try {
      const totals = await query(
        `SELECT COUNT(*) AS paid_orders,
                COALESCE(SUM(total_amount),0) AS revenue,
                COALESCE(AVG(total_amount),0) AS avg_order_value
         FROM bar_orders
         WHERE pharmacy_id=$1 AND status='paid' AND closed_at BETWEEN $2 AND $3`,
        [pharmacyId, from, to]
      );

      const byMethod = await query(
        `SELECT method, COALESCE(SUM(amount),0) AS total, COUNT(*) AS count
         FROM bar_payments
         WHERE pharmacy_id=$1 AND created_at BETWEEN $2 AND $3
         GROUP BY method ORDER BY total DESC`,
        [pharmacyId, from, to]
      );

      const topItems = await query(
        `SELECT boi.item_name,
                SUM(boi.quantity) AS quantity_sold,
                COALESCE(SUM(boi.quantity * boi.unit_price),0) AS revenue
         FROM bar_order_items boi
         JOIN bar_orders bo ON bo.id = boi.order_id
         WHERE bo.pharmacy_id=$1 AND bo.status='paid' AND bo.closed_at BETWEEN $2 AND $3 AND boi.voided_at IS NULL
         GROUP BY boi.item_name
         ORDER BY revenue DESC LIMIT 10`,
        [pharmacyId, from, to]
      );

      const openExposure = await query(
        `SELECT COUNT(*) AS open_orders, COALESCE(SUM(total_amount),0) AS open_value
         FROM bar_orders WHERE pharmacy_id=$1 AND status='open'`,
        [pharmacyId]
      );

      // Loss-prevention view: how much was discounted, how many items
      // were voided and by whom. A staff member with an outsized share
      // of voids relative to colleagues is the classic red flag this
      // is meant to surface — it's not proof of anything on its own,
      // just a starting point for a manager to ask questions.
      const discounts = await query(
        `SELECT COUNT(*) AS discounted_orders, COALESCE(SUM(discount_amount),0) AS total_discounted
         FROM bar_orders WHERE pharmacy_id=$1 AND status='paid' AND closed_at BETWEEN $2 AND $3 AND discount_amount > 0`,
        [pharmacyId, from, to]
      );

      const voids = await query(
        `SELECT COUNT(*) AS voided_items, COALESCE(SUM(boi.quantity * boi.unit_price),0) AS voided_value
         FROM bar_order_items boi
         JOIN bar_orders bo ON bo.id = boi.order_id
         WHERE bo.pharmacy_id=$1 AND boi.voided_at BETWEEN $2 AND $3`,
        [pharmacyId, from, to]
      );

      const voidsByStaff = await query(
        `SELECT u.name AS staff_name, COUNT(*) AS void_count, COALESCE(SUM(boi.quantity * boi.unit_price),0) AS void_value
         FROM bar_order_items boi
         JOIN bar_orders bo ON bo.id = boi.order_id
         LEFT JOIN users u ON u.id = boi.voided_by
         WHERE bo.pharmacy_id=$1 AND boi.voided_at BETWEEN $2 AND $3
         GROUP BY u.name ORDER BY void_count DESC LIMIT 5`,
        [pharmacyId, from, to]
      );

      res.json({
        range: { from: from.toISOString(), to: to.toISOString() },
        summary: totals.rows[0],
        payment_methods: byMethod.rows,
        top_items: topItems.rows,
        open_orders: openExposure.rows[0],
        discounts: discounts.rows[0],
        voids: voids.rows[0],
        voids_by_staff: voidsByStaff.rows,
      });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.get('/api/bar/reports/staff', auth, can('bar-reports:read'), gate, async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned.', 'pharmacyId');
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) return err(res, 400, 'VALIDATION_INVALID', 'from/to must be valid dates.');

    try {
      const ordersOpened = await query(
        `SELECT u.id AS staff_id, u.name AS staff_name, COUNT(*) AS orders_opened
         FROM bar_orders bo
         JOIN users u ON u.id = bo.opened_by
         WHERE bo.pharmacy_id=$1 AND bo.opened_at BETWEEN $2 AND $3
         GROUP BY u.id, u.name ORDER BY orders_opened DESC`,
        [pharmacyId, from, to]
      );

      const revenueCollected = await query(
        `SELECT u.id AS staff_id, u.name AS staff_name, COALESCE(SUM(bp.amount),0) AS revenue_collected, COUNT(*) AS payments_taken
         FROM bar_payments bp
         JOIN users u ON u.id = bp.received_by
         WHERE bp.pharmacy_id=$1 AND bp.created_at BETWEEN $2 AND $3
         GROUP BY u.id, u.name ORDER BY revenue_collected DESC`,
        [pharmacyId, from, to]
      );

      const voidsByStaff = await query(
        `SELECT u.id AS staff_id, u.name AS staff_name, COUNT(*) AS void_count, COALESCE(SUM(boi.quantity * boi.unit_price),0) AS void_value
         FROM bar_order_items boi
         JOIN bar_orders bo ON bo.id = boi.order_id
         JOIN users u ON u.id = boi.voided_by
         WHERE bo.pharmacy_id=$1 AND boi.voided_at BETWEEN $2 AND $3
         GROUP BY u.id, u.name ORDER BY void_count DESC`,
        [pharmacyId, from, to]
      );

      // Merge the three datasets into one row per staff member
      const byId = {};
      ordersOpened.rows.forEach(r => { byId[r.staff_id] = { staff_name: r.staff_name, orders_opened: parseInt(r.orders_opened), revenue_collected: 0, payments_taken: 0, void_count: 0, void_value: 0 }; });
      revenueCollected.rows.forEach(r => { byId[r.staff_id] = byId[r.staff_id] || { staff_name: r.staff_name, orders_opened: 0 }; byId[r.staff_id].revenue_collected = parseFloat(r.revenue_collected); byId[r.staff_id].payments_taken = parseInt(r.payments_taken); });
      voidsByStaff.rows.forEach(r => { byId[r.staff_id] = byId[r.staff_id] || { staff_name: r.staff_name, orders_opened: 0, revenue_collected: 0, payments_taken: 0 }; byId[r.staff_id].void_count = parseInt(r.void_count); byId[r.staff_id].void_value = parseFloat(r.void_value); });

      const staff = Object.entries(byId).map(([id, v]) => ({ staff_id: id, ...v })).sort((a,b) => b.revenue_collected - a.revenue_collected);

      res.json({ range: { from: from.toISOString(), to: to.toISOString() }, staff });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });
};
