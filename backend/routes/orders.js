'use strict';
const err = require('./_err');

module.exports = function registerOrdersRoutes(app, { query, auth }) {

  // GET /api/orders
  app.get('/api/orders', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const result = await query(
        `SELECT o.*,json_agg(json_build_object('drug_name',oi.drug_name,'quantity',oi.quantity,'unit_price',oi.unit_price)) as items
         FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id
         WHERE o.pharmacy_id=$1 GROUP BY o.id ORDER BY o.created_at DESC`,
        [pharmacyId]
      );
      res.json({ orders: result.rows });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // POST /api/orders/public/:pharmacyId  (no auth — public-facing)
  app.post('/api/orders/public/:pharmacyId', async (req, res) => {
    const pharmacyId = parseInt(req.params.pharmacyId);
    const { customer_name, customer_phone, delivery_address, delivery_type, payment_method, items, total_amount, notes } = req.body;
    if (!customer_name)  return err(res, 400, 'VALIDATION_REQUIRED', 'Customer name is required', 'customer_name');
    if (!customer_phone) return err(res, 400, 'VALIDATION_REQUIRED', 'Customer phone is required', 'customer_phone');
    if (!items?.length)  return err(res, 400, 'VALIDATION_REQUIRED', 'At least one item is required', 'items');
    try {
      const order = await query(
        `INSERT INTO orders (pharmacy_id,customer_name,customer_phone,delivery_address,delivery_type,payment_method,total_amount,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [pharmacyId, customer_name, customer_phone, delivery_address || '', delivery_type || 'delivery', payment_method || 'cash', parseFloat(total_amount || 0), notes || null]
      );
      for (const item of items)
        await query(`INSERT INTO order_items (order_id,drug_id,drug_name,quantity,unit_price) VALUES ($1,$2,$3,$4,$5)`,
          [order.rows[0].id, item.drug_id || null, item.drug_name, item.quantity, item.unit_price]);
      res.json({ message: '✅ Order placed!', order: order.rows[0] });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // PATCH /api/orders/:id/status
  app.patch('/api/orders/:id/status', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const { status } = req.body;
    if (!status) return err(res, 400, 'VALIDATION_REQUIRED', 'Status is required', 'status');
    try {
      const result = await query(
        `UPDATE orders SET order_status=$1 WHERE id=$2 AND pharmacy_id=$3 RETURNING *`,
        [status, req.params.id, pharmacyId]
      );
      if (!result.rows.length) return err(res, 404, 'NOT_FOUND_ORDER', 'Order not found', 'id');
      res.json({ message: '✅ Updated!', order: result.rows[0] });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });
};
