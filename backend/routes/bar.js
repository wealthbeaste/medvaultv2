const err = require('./_err');
// ============================================================
// BAR MODULE — Tables, Orders, Kitchen (Phase 4)
// Gated behind subscriptions.modules->>'bar' via requireModule
// (see middleware/moduleAccess.js) — orgs without this module
// get a clean 403 rather than silent access. Entirely additive:
// new tables (bar_tables, bar_orders, bar_order_items), no
// existing pharmacy workflow is touched.
// ============================================================
module.exports = function registerBarRoutes(app, { query, auth, can, audit, requireModule }) {
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

  // Add an item to an order — this is what feeds the Kitchen view below
  app.post('/api/bar/orders/:id/items', auth, can('bar:write'), gate, async (req, res) => {
    const b = req.body || {};
    if (!b.item_name) return err(res, 400, 'VALIDATION_INVALID', 'item_name is required.');
    try {
      const r = await query(
        `INSERT INTO bar_order_items (order_id, item_name, quantity, unit_price) VALUES ($1,$2,$3,$4) RETURNING *`,
        [req.params.id, b.item_name, b.quantity || 1, b.unit_price || 0]
      );
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
    try {
      const r = await query(
        `UPDATE bar_orders SET status='paid', closed_at=NOW() WHERE id=$1 RETURNING *`,
        [req.params.id]
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
};
