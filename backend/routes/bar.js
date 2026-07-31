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
      const r = await query(
        `INSERT INTO bar_orders (org_id, pharmacy_id, table_id, opened_by) VALUES ($1,$2,$3,$4) RETURNING *`,
        [orgId, pharmacyId, b.table_id || null, userId || null]
      );
      if (b.table_id) {
        await query(`UPDATE bar_tables SET status='occupied', updated_at=NOW() WHERE id=$1`, [b.table_id]);
      }
      if (audit) await audit(query, { req, action: 'bar.order.open', entity: 'bar_order', entityId: r.rows[0].id, payload: {} });
      res.json({ success: true, order: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // Add an item to an order — this is what feeds the Kitchen view below.
  // Supports either a catalog menu_item_id (preferred — auto-fills name/price
  // and decrements stock) or legacy free-typed item_name/unit_price.
  app.post('/api/bar/orders/:id/items', auth, can('bar:write'), gate, async (req, res) => {
    const b = req.body || {};
    const quantity = b.quantity || 1;
    let item_name = b.item_name;
    let unit_price = b.unit_price || 0;
    try {
      if (b.menu_item_id) {
        const mi = await query(`SELECT * FROM bar_menu_items WHERE id=$1 AND active=true`, [b.menu_item_id]);
        if (!mi.rows.length) return err(res, 404, 'NOT_FOUND', 'Menu item not found or inactive.');
        item_name = mi.rows[0].name;
        unit_price = mi.rows[0].price;
      }
      if (!item_name) return err(res, 400, 'VALIDATION_INVALID', 'item_name or menu_item_id is required.');

      const r = await query(
        `INSERT INTO bar_order_items (order_id, item_name, quantity, unit_price, menu_item_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [req.params.id, item_name, quantity, unit_price, b.menu_item_id || null]
      );

      if (b.menu_item_id) {
        await query(
          `UPDATE bar_stock SET quantity_on_hand = GREATEST(quantity_on_hand - $1, 0), updated_at=NOW() WHERE menu_item_id=$2`,
          [quantity, b.menu_item_id]
        );
      }

      await query(
        `UPDATE bar_orders SET total_amount = (
           SELECT COALESCE(SUM(quantity * unit_price),0) FROM bar_order_items WHERE order_id=$1
         ) WHERE id=$1`,
        [req.params.id]
      );
      res.json({ success: true, item: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // Close/settle an order (mark paid) — table goes back to available
  app.post('/api/bar/orders/:id/close', auth, can('bar:write'), gate, async (req, res) => {
    const b = req.body || {};
    try {
      const r = await query(
        `UPDATE bar_orders SET status='paid', closed_at=NOW(),
                customer_name=$2, customer_phone=$3, payment_method=$4
         WHERE id=$1 RETURNING *`,
        [req.params.id, b.customer_name || null, b.customer_phone || null, b.payment_method || null]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Order not found.');
      if (r.rows[0].table_id) {
        await query(`UPDATE bar_tables SET status='available', updated_at=NOW() WHERE id=$1`, [r.rows[0].table_id]);
      }
      if (audit) await audit(query, { req, action: 'bar.order.close', entity: 'bar_order', entityId: r.rows[0].id, payload: {} });
      res.json({ success: true, order: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
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

  app.patch('/api/bar/order-items/:id', auth, can('bar:write'), gate, async (req, res) => {
    const b = req.body || {};
    if (!['pending', 'preparing', 'ready', 'served'].includes(b.status)) {
      return err(res, 400, 'VALIDATION_INVALID', 'status must be one of pending, preparing, ready, served.');
    }
    try {
      const r = await query(
        `UPDATE bar_order_items SET status=$1 WHERE id=$2 RETURNING *`,
        [b.status, req.params.id]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Order item not found.');
      res.json({ success: true, item: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
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
        `INSERT INTO bar_menu_items (org_id, pharmacy_id, name, category, price, active)
         VALUES ($1,$2,$3,$4,$5,true) RETURNING *`,
        [orgId, pharmacyId, b.name, b.category || null, b.price]
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
    const b = req.body || {};
    const fields = [];
    const values = [];
    let i = 1;
    if (b.name !== undefined) { fields.push(`name=${i++}`); values.push(b.name); }
    if (b.category !== undefined) { fields.push(`category=${i++}`); values.push(b.category); }
    if (b.price !== undefined) { fields.push(`price=${i++}`); values.push(b.price); }
    if (b.active !== undefined) { fields.push(`active=${i++}`); values.push(b.active); }
    if (!fields.length) return err(res, 400, 'VALIDATION_INVALID', 'No fields to update.');
    fields.push(`updated_at=NOW()`);
    values.push(req.params.id);
    try {
      const r = await query(
        `UPDATE bar_menu_items SET ${fields.join(', ')} WHERE id=${i} RETURNING *`,
        values
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Menu item not found.');
      if (audit) await audit(query, { req, action: 'bar.menu_item.update', entity: 'bar_menu_item', entityId: r.rows[0].id, payload: b });
      res.json({ success: true, item: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ── STOCK ADJUSTMENT ──────────────────────────────────────
  app.patch('/api/bar/stock/:menuItemId', auth, can('bar-menu:write'), gate, async (req, res) => {
    const b = req.body || {};
    if (b.quantity_on_hand === undefined && b.adjustment === undefined) {
      return err(res, 400, 'VALIDATION_INVALID', 'Provide quantity_on_hand (absolute) or adjustment (relative).');
    }
    try {
      let r;
      if (b.quantity_on_hand !== undefined) {
        if (b.quantity_on_hand < 0) return err(res, 400, 'STOCK_INVALID_QUANTITY', 'quantity_on_hand cannot be negative.');
        r = await query(
          `UPDATE bar_stock SET quantity_on_hand=$1, low_stock_threshold=COALESCE($2, low_stock_threshold), updated_at=NOW()
           WHERE menu_item_id=$3 RETURNING *`,
          [b.quantity_on_hand, b.low_stock_threshold ?? null, req.params.menuItemId]
        );
      } else {
        r = await query(
          `UPDATE bar_stock SET quantity_on_hand = GREATEST(quantity_on_hand + $1, 0), updated_at=NOW()
           WHERE menu_item_id=$2 RETURNING *`,
          [b.adjustment, req.params.menuItemId]
        );
      }
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Stock record not found for this menu item.');
      if (audit) await audit(query, { req, action: 'bar.stock.adjust', entity: 'bar_stock', entityId: r.rows[0].id, payload: b });
      res.json({ success: true, stock: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });
};
