'use strict';
const err = require('./_err');

// ============================================================
// MedVault — Warehouse Routes (Phase 2 — complete)
//
// Stock flow:
//   Supplier → GRN → warehouse_stock (mother store)
//       → warehouse_transfers (request→approve→dispatch)
//           → branch drugs.quantity  → Sale to customer
//
// Endpoints:
//   Warehouse CRUD          GET/POST/PUT/PATCH/DELETE /api/warehouses
//   Warehouse stock         GET /api/warehouses/:id/stock
//   Org-wide stock view     GET /api/warehouse-stock
//   Transfers list          GET /api/warehouse-transfers
//   Request transfer        POST /api/warehouse-transfers
//   Approve transfer        PATCH /api/warehouse-transfers/:id/approve
//   Dispatch transfer       PATCH /api/warehouse-transfers/:id/dispatch
//   Reject transfer         PATCH /api/warehouse-transfers/:id/reject
//   AR Ledger               GET/POST /api/ar-ledger
// ============================================================

module.exports = function registerWarehouseRoutes(app, {
  query, pool, getNextWarehouseTransferNumber, auth, can, validate, audit,
}) {

  // ══════════════════════════════════════════════════════════
  // WAREHOUSE CRUD
  // ══════════════════════════════════════════════════════════

  // GET /api/warehouses — list all warehouses with stock summary
  app.get('/api/warehouses', auth, can('branches:read'), async (req, res) => {
    const { orgId } = req.user;
    try {
      const result = await query(
        `SELECT w.id, w.name, w.address, w.is_active, w.created_at,
                u.name AS manager_name,
                COUNT(DISTINCT ws.id)       AS drug_count,
                COALESCE(SUM(ws.quantity),0) AS total_units,
                COALESCE(SUM(ws.quantity * ws.cost_price),0) AS stock_value
         FROM warehouses w
         LEFT JOIN users u ON u.id = w.manager_id
         LEFT JOIN warehouse_stock ws ON ws.warehouse_id = w.id
         WHERE w.org_id = $1
         GROUP BY w.id, u.name
         ORDER BY w.name`,
        [orgId]
      );
      res.json({ warehouses: result.rows, total: result.rowCount });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // GET /api/warehouses/:id
  app.get('/api/warehouses/:id', auth, can('branches:read'), async (req, res) => {
    const { orgId } = req.user;
    try {
      const result = await query(
        `SELECT w.id, w.name, w.address, w.is_active, w.created_at,
                u.name AS manager_name, u.id AS manager_id
         FROM warehouses w
         LEFT JOIN users u ON u.id = w.manager_id
         WHERE w.id = $1 AND w.org_id = $2`,
        [req.params.id, orgId]
      );
      if (!result.rows.length) return err(res, 404, 'NOT_FOUND', 'Warehouse not found');
      res.json(result.rows[0]);
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // POST /api/warehouses
  app.post('/api/warehouses', auth, can('branches:write'), validate({
    name: { required: true, type: 'string', minLen: 1, maxLen: 255 },
  }), async (req, res) => {
    const { orgId } = req.user;
    const { name, address, manager_id } = req.body;
    try {
      const dup = await query(
        `SELECT id FROM warehouses WHERE org_id=$1 AND LOWER(name)=LOWER($2)`, [orgId, name.trim()]
      );
      if (dup.rows.length)
        return err(res, 409, 'DUPLICATE', `Warehouse "${name}" already exists`, 'name');

      const r = await query(
        `INSERT INTO warehouses (org_id, name, address, manager_id)
         VALUES ($1,$2,$3,$4) RETURNING id, name, address, is_active, created_at`,
        [orgId, name.trim(), address || null, manager_id || null]
      );
      await audit(query, { req, action: 'warehouse.create', entity: 'warehouse', entityId: r.rows[0].id, payload: { name } });
      res.status(201).json({ message: `✅ Warehouse "${name}" created`, warehouse: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // PUT /api/warehouses/:id
  app.put('/api/warehouses/:id', auth, can('branches:write'), async (req, res) => {
    const { orgId } = req.user;
    const { name, address, manager_id } = req.body;
    try {
      if (!await warehouseBelongsToOrg(req.params.id, orgId))
        return err(res, 404, 'NOT_FOUND', 'Warehouse not found');

      if (name) {
        const dup = await query(
          `SELECT id FROM warehouses WHERE org_id=$1 AND LOWER(name)=LOWER($2) AND id!=$3`,
          [orgId, name.trim(), req.params.id]
        );
        if (dup.rows.length)
          return err(res, 409, 'DUPLICATE', `Warehouse "${name}" already exists`, 'name');
      }
      const r = await query(
        `UPDATE warehouses
         SET name=COALESCE($1,name), address=COALESCE($2,address), manager_id=COALESCE($3,manager_id)
         WHERE id=$4 AND org_id=$5
         RETURNING id, name, address, is_active`,
        [name?.trim()||null, address||null, manager_id||null, req.params.id, orgId]
      );
      res.json({ message: '✅ Warehouse updated', warehouse: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // PATCH /api/warehouses/:id/toggle
  app.patch('/api/warehouses/:id/toggle', auth, can('branches:write'), async (req, res) => {
    const { orgId } = req.user;
    try {
      const r = await query(
        `UPDATE warehouses SET is_active=NOT is_active WHERE id=$1 AND org_id=$2
         RETURNING id, name, is_active`,
        [req.params.id, orgId]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Warehouse not found');
      const w = r.rows[0];
      res.json({ message: `Warehouse "${w.name}" ${w.is_active ? 'activated' : 'deactivated'}`, warehouse: w });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // DELETE /api/warehouses/:id — only if no stock
  app.delete('/api/warehouses/:id', auth, can('branches:write'), async (req, res) => {
    const { orgId } = req.user;
    try {
      const wh = await query(
        `SELECT id, name FROM warehouses WHERE id=$1 AND org_id=$2`, [req.params.id, orgId]
      );
      if (!wh.rows.length) return err(res, 404, 'NOT_FOUND', 'Warehouse not found');

      const stock = await query(
        `SELECT COUNT(*) AS cnt FROM warehouse_stock WHERE warehouse_id=$1 AND quantity > 0`, [req.params.id]
      );
      if (parseInt(stock.rows[0].cnt) > 0)
        return err(res, 409, 'HAS_STOCK', 'Cannot delete a warehouse that still has stock. Transfer or adjust stock to zero first.');

      await query(`DELETE FROM warehouses WHERE id=$1`, [req.params.id]);
      await audit(query, { req, action: 'warehouse.delete', entity: 'warehouse', entityId: req.params.id, payload: { name: wh.rows[0].name } });
      res.json({ message: `Warehouse "${wh.rows[0].name}" deleted` });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ══════════════════════════════════════════════════════════
  // WAREHOUSE STOCK — read views
  // ══════════════════════════════════════════════════════════

  // GET /api/warehouses/:id/stock — one warehouse, paginated, searchable
  app.get('/api/warehouses/:id/stock', auth, can('branches:read'), async (req, res) => {
    const { orgId } = req.user;
    const q      = (req.query.q || '').trim();
    const limit  = Math.min(200, parseInt(req.query.limit) || 50);
    const offset = Math.max(0, (parseInt(req.query.page)||1) - 1) * limit;
    try {
      const wh = await query(
        `SELECT id, name FROM warehouses WHERE id=$1 AND org_id=$2`, [req.params.id, orgId]
      );
      if (!wh.rows.length) return err(res, 404, 'NOT_FOUND', 'Warehouse not found');

      const params = [req.params.id];
      let filter = '';
      if (q) { params.push(`%${q.toLowerCase()}%`); filter = ` AND LOWER(ws.drug_name) LIKE $${params.length}`; }

      const [rows, totals] = await Promise.all([
        query(
          `SELECT ws.*, d.threshold, d.unit_price AS selling_price,
                  CASE WHEN d.threshold IS NOT NULL AND ws.quantity <= d.threshold THEN true ELSE false END AS is_low_stock
           FROM warehouse_stock ws
           LEFT JOIN drugs d ON d.id = ws.drug_id
           WHERE ws.warehouse_id=$1${filter}
           ORDER BY ws.drug_name
           LIMIT $${params.length+1} OFFSET $${params.length+2}`,
          [...params, limit, offset]
        ),
        query(
          `SELECT COUNT(*) AS total, COALESCE(SUM(quantity),0) AS total_units,
                  COALESCE(SUM(quantity*cost_price),0) AS stock_value
           FROM warehouse_stock WHERE warehouse_id=$1${filter}`,
          params
        ),
      ]);

      res.json({
        warehouse: wh.rows[0],
        stock: rows.rows,
        total:       parseInt(totals.rows[0].total),
        total_units: parseInt(totals.rows[0].total_units),
        stock_value: parseFloat(totals.rows[0].stock_value),
      });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // GET /api/warehouse-stock — org-wide consolidated stock view
  app.get('/api/warehouse-stock', auth, can('branches:read'), async (req, res) => {
    const { orgId } = req.user;
    const warehouseId = req.query.warehouse_id || null;
    const q = (req.query.q || '').trim();
    try {
      const params = [orgId];
      const filters = [];
      if (warehouseId) { params.push(warehouseId); filters.push(`ws.warehouse_id=$${params.length}`); }
      if (q)           { params.push(`%${q.toLowerCase()}%`); filters.push(`LOWER(ws.drug_name) LIKE $${params.length}`); }
      const where = filters.length ? ' AND ' + filters.join(' AND ') : '';

      const rows = await query(
        `SELECT ws.id, ws.warehouse_id, ws.drug_id, ws.drug_name, ws.generic_name,
                ws.category, ws.quantity, ws.cost_price, ws.unit_price,
                ws.batch_number, ws.expiry_date, ws.updated_at,
                w.name AS warehouse_name
         FROM warehouse_stock ws
         JOIN warehouses w ON w.id = ws.warehouse_id
         WHERE ws.org_id=$1${where}
         ORDER BY ws.drug_name, w.name`,
        params
      );
      res.json({ stock: rows.rows, total: rows.rowCount });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ══════════════════════════════════════════════════════════
  // WAREHOUSE → BRANCH TRANSFERS
  // ══════════════════════════════════════════════════════════

  // GET /api/warehouse-transfers — list with role filtering
  app.get('/api/warehouse-transfers', auth, can('branches:read'), async (req, res) => {
    const { orgId, pharmacyId, role } = req.user;
    const status      = req.query.status || null;
    const warehouseId = req.query.warehouse_id || null;
    const limit  = Math.min(100, parseInt(req.query.limit) || 50);
    const offset = Math.max(0, (parseInt(req.query.page)||1) - 1) * limit;
    try {
      const params  = [orgId];
      const filters = [];
      if (status)      { params.push(status);      filters.push(`wt.status=$${params.length}`); }
      if (warehouseId) { params.push(warehouseId); filters.push(`wt.warehouse_id=$${params.length}`); }
      if (!['owner','manager'].includes(role)) {
        params.push(pharmacyId); filters.push(`wt.to_pharmacy_id=$${params.length}`);
      }
      const where = filters.length ? ' AND ' + filters.join(' AND ') : '';

      const [rows, count] = await Promise.all([
        query(
          `SELECT wt.*,
                  w.name  AS warehouse_name,
                  p.name  AS branch_name,
                  ru.name AS requested_by_name,
                  au.name AS approved_by_name,
                  du.name AS dispatched_by_name
           FROM warehouse_transfers wt
           JOIN warehouses w ON w.id = wt.warehouse_id
           JOIN pharmacies p ON p.id = wt.to_pharmacy_id
           LEFT JOIN users ru ON ru.id = wt.requested_by
           LEFT JOIN users au ON au.id = wt.approved_by
           LEFT JOIN users du ON du.id = wt.dispatched_by
           WHERE wt.org_id=$1${where}
           ORDER BY wt.requested_at DESC
           LIMIT $${params.length+1} OFFSET $${params.length+2}`,
          [...params, limit, offset]
        ),
        query(
          `SELECT COUNT(*) AS total FROM warehouse_transfers wt WHERE wt.org_id=$1${where}`,
          params
        ),
      ]);
      res.json({ transfers: rows.rows, total: parseInt(count.rows[0].total) });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // POST /api/warehouse-transfers — branch requests stock from warehouse
  app.post('/api/warehouse-transfers', auth, validate({
    warehouse_id: { required: true, type: 'number', min: 1 },
    drug_name:    { required: true, type: 'string',  minLen: 1 },
    quantity:     { required: true, type: 'number',  min: 1 },
  }), async (req, res) => {
    const { orgId, pharmacyId, userId } = req.user;
    const { warehouse_id, drug_name, drug_id, quantity, notes } = req.body;
    try {
      // Confirm warehouse belongs to org
      const wh = await query(
        `SELECT id, name FROM warehouses WHERE id=$1 AND org_id=$2 AND is_active=true`,
        [warehouse_id, orgId]
      );
      if (!wh.rows.length) return err(res, 404, 'NOT_FOUND', 'Warehouse not found or inactive', 'warehouse_id');

      // Check drug exists in warehouse stock
      const stock = await query(
        `SELECT id, quantity, cost_price, drug_id FROM warehouse_stock
         WHERE warehouse_id=$1 AND LOWER(drug_name)=LOWER($2)`,
        [warehouse_id, drug_name.trim()]
      );
      if (!stock.rows.length)
        return err(res, 404, 'NOT_FOUND_STOCK', `"${drug_name}" is not in this warehouse`, 'drug_name');
      if (stock.rows[0].quantity < parseInt(quantity))
        return err(res, 400, 'STOCK_INSUFFICIENT',
          `Only ${stock.rows[0].quantity} units of "${drug_name}" available in warehouse`, 'quantity');

      const transferNum = await getNextWarehouseTransferNumber(pharmacyId);
      const r = await query(
        `INSERT INTO warehouse_transfers
           (org_id, warehouse_id, to_pharmacy_id, transfer_number, status,
            drug_name, drug_id, quantity, unit_cost, notes, requested_by)
         VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9,$10) RETURNING *`,
        [orgId, warehouse_id, pharmacyId, transferNum,
         drug_name.trim(), drug_id || stock.rows[0].drug_id || null,
         parseInt(quantity), stock.rows[0].cost_price, notes||null, userId]
      );
      await audit(query, {
        req, action: 'warehouse_transfer.request', entity: 'warehouse_transfer',
        entityId: r.rows[0].id,
        payload: { transfer_number: transferNum, warehouse_id, drug_name, quantity },
      });
      res.status(201).json({
        message: `✅ Transfer request ${transferNum} submitted — awaiting warehouse approval`,
        transfer: r.rows[0],
      });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // PATCH /api/warehouse-transfers/:id/approve — manager approves (no stock movement yet)
  app.patch('/api/warehouse-transfers/:id/approve', auth, can('transfers:approve'), async (req, res) => {
    const { orgId, userId } = req.user;
    try {
      const tx = await query(
        `SELECT * FROM warehouse_transfers WHERE id=$1 AND org_id=$2 AND status='pending'`,
        [req.params.id, orgId]
      );
      if (!tx.rows.length) return err(res, 404, 'NOT_FOUND', 'Transfer not found or not pending');
      const t = tx.rows[0];

      // Re-verify stock
      const stock = await query(
        `SELECT quantity FROM warehouse_stock WHERE warehouse_id=$1 AND LOWER(drug_name)=LOWER($2)`,
        [t.warehouse_id, t.drug_name]
      );
      if (!stock.rows.length || stock.rows[0].quantity < t.quantity)
        return err(res, 400, 'STOCK_INSUFFICIENT', 'Insufficient warehouse stock to approve this transfer');

      await query(
        `UPDATE warehouse_transfers SET status='approved', approved_by=$1, approved_at=NOW() WHERE id=$2`,
        [userId, req.params.id]
      );
      await audit(query, { req, action: 'warehouse_transfer.approve', entity: 'warehouse_transfer', entityId: req.params.id, payload: { drug_name: t.drug_name, quantity: t.quantity } });
      res.json({ message: `✅ Transfer ${t.transfer_number} approved — ready to dispatch` });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // PATCH /api/warehouse-transfers/:id/dispatch
  // Physically sends stock: deducts warehouse_stock, credits branch drugs — full DB transaction
  app.patch('/api/warehouse-transfers/:id/dispatch', auth, can('transfers:approve'), async (req, res) => {
    const { orgId, userId } = req.user;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const tx = await client.query(
        `SELECT wt.*, w.name AS warehouse_name, p.name AS branch_name
         FROM warehouse_transfers wt
         JOIN warehouses w ON w.id = wt.warehouse_id
         JOIN pharmacies p ON p.id = wt.to_pharmacy_id
         WHERE wt.id=$1 AND wt.org_id=$2 AND wt.status='approved'
         FOR UPDATE OF wt`,
        [req.params.id, orgId]
      );
      if (!tx.rows.length) {
        await client.query('ROLLBACK');
        return err(res, 404, 'NOT_FOUND', 'Transfer not found or not yet approved');
      }
      const t = tx.rows[0];

      // 1. Deduct from warehouse_stock (with lock + stock check)
      const stockRes = await client.query(
        `UPDATE warehouse_stock
         SET quantity=quantity-$1, updated_at=NOW()
         WHERE warehouse_id=$2 AND LOWER(drug_name)=LOWER($3) AND quantity>=$1
         RETURNING id, cost_price, unit_price, generic_name, category`,
        [t.quantity, t.warehouse_id, t.drug_name]
      );
      if (!stockRes.rows.length) {
        await client.query('ROLLBACK');
        return err(res, 400, 'STOCK_INSUFFICIENT', `Insufficient stock in warehouse at dispatch time`);
      }
      const ws = stockRes.rows[0];

      // 2. Credit branch drugs table
      const existing = await client.query(
        `SELECT id FROM drugs WHERE pharmacy_id=$1 AND LOWER(name)=LOWER($2) LIMIT 1`,
        [t.to_pharmacy_id, t.drug_name]
      );
      if (existing.rows.length) {
        await client.query(
          `UPDATE drugs SET quantity=quantity+$1, cost_price=COALESCE($2,cost_price), updated_at=NOW() WHERE id=$3`,
          [t.quantity, ws.cost_price > 0 ? ws.cost_price : null, existing.rows[0].id]
        );
      } else {
        // Create new drug row in branch from warehouse metadata
        await client.query(
          `INSERT INTO drugs (pharmacy_id, name, generic_name, category, quantity, unit_price, cost_price, threshold)
           VALUES ($1,$2,$3,$4,$5,$6,$7,20)`,
          [t.to_pharmacy_id, t.drug_name, ws.generic_name||null, ws.category||'General',
           t.quantity, ws.unit_price > 0 ? ws.unit_price : 0, ws.cost_price > 0 ? ws.cost_price : 0]
        );
      }

      // 3. Mark transfer dispatched
      await client.query(
        `UPDATE warehouse_transfers SET status='dispatched', dispatched_by=$1, dispatched_at=NOW() WHERE id=$2`,
        [userId, req.params.id]
      );

      await client.query('COMMIT');
      await audit(query, {
        req, action: 'warehouse_transfer.dispatch', entity: 'warehouse_transfer',
        entityId: req.params.id,
        payload: { drug_name: t.drug_name, quantity: t.quantity, to_pharmacy_id: t.to_pharmacy_id },
      });
      res.json({ message: `✅ ${t.quantity} × ${t.drug_name} dispatched from ${t.warehouse_name} to ${t.branch_name}` });
    } catch (e) {
      await client.query('ROLLBACK');
      return err(res, 500, 'SERVER_ERROR', e.message);
    } finally {
      client.release();
    }
  });

  // PATCH /api/warehouse-transfers/:id/reject
  app.patch('/api/warehouse-transfers/:id/reject', auth, can('transfers:approve'), async (req, res) => {
    const { orgId } = req.user;
    try {
      const r = await query(
        `UPDATE warehouse_transfers SET status='rejected'
         WHERE id=$1 AND org_id=$2 AND status='pending'
         RETURNING transfer_number`,
        [req.params.id, orgId]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Transfer not found or not pending');
      res.json({ message: `Transfer ${r.rows[0].transfer_number} rejected` });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // PATCH /api/warehouse-transfers/:id/cancel — by requester before approval
  app.patch('/api/warehouse-transfers/:id/cancel', auth, async (req, res) => {
    const { orgId, userId } = req.user;
    try {
      const r = await query(
        `UPDATE warehouse_transfers SET status='cancelled'
         WHERE id=$1 AND org_id=$2 AND status='pending' AND requested_by=$3
         RETURNING transfer_number`,
        [req.params.id, orgId, userId]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Transfer not found or cannot be cancelled');
      res.json({ message: `Transfer ${r.rows[0].transfer_number} cancelled` });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ══════════════════════════════════════════════════════════
  // AR LEDGER (Accounts Receivable)
  // ══════════════════════════════════════════════════════════

  // GET /api/ar-ledger/:customerId — ledger for one customer
  app.get('/api/ar-ledger/:customerId', auth, can('reports:financial'), async (req, res) => {
    const { orgId, pharmacyId } = req.user;
    try {
      const [ledger, summary] = await Promise.all([
        query(
          `SELECT al.*, u.name AS recorded_by_name
           FROM ar_ledger al
           LEFT JOIN users u ON u.id = al.recorded_by
           WHERE al.customer_id=$1 AND al.pharmacy_id=$2
           ORDER BY al.created_at DESC`,
          [req.params.customerId, pharmacyId]
        ),
        query(
          `SELECT
             COALESCE(SUM(CASE WHEN type='invoice' THEN amount ELSE 0 END),0) AS total_invoiced,
             COALESCE(SUM(CASE WHEN type='payment' THEN amount ELSE 0 END),0) AS total_paid,
             COALESCE(SUM(CASE WHEN type='credit_note' THEN amount ELSE 0 END),0) AS total_credits
           FROM ar_ledger WHERE customer_id=$1 AND pharmacy_id=$2`,
          [req.params.customerId, pharmacyId]
        ),
      ]);
      const s = summary.rows[0];
      const outstanding = parseFloat(s.total_invoiced) - parseFloat(s.total_paid) - parseFloat(s.total_credits);
      res.json({
        ledger: ledger.rows,
        summary: { ...s, outstanding_balance: outstanding },
      });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // POST /api/ar-ledger/:customerId/payment — record a payment against AR balance
  app.post('/api/ar-ledger/:customerId/payment', auth, can('reports:financial'), validate({
    amount:    { required: true, type: 'number', min: 0.01 },
    reference: { required: true, type: 'string', minLen: 1 },
  }), async (req, res) => {
    const { orgId, pharmacyId, userId } = req.user;
    const { amount, reference, notes } = req.body;
    try {
      // Get current balance for balance_after calc
      const bal = await query(
        `SELECT COALESCE(SUM(CASE WHEN type='invoice' THEN amount ELSE -amount END),0) AS balance
         FROM ar_ledger WHERE customer_id=$1 AND pharmacy_id=$2`,
        [req.params.customerId, pharmacyId]
      );
      const balanceBefore = parseFloat(bal.rows[0].balance);
      const balanceAfter  = balanceBefore - parseFloat(amount);

      const cust = await query(`SELECT name FROM customers WHERE id=$1`, [req.params.customerId]);
      const custName = cust.rows[0]?.name || 'Unknown';

      await query(
        `INSERT INTO ar_ledger (org_id, pharmacy_id, customer_id, customer_name, type, reference, amount, balance_after, notes, recorded_by)
         VALUES ($1,$2,$3,$4,'payment',$5,$6,$7,$8,$9)`,
        [orgId, pharmacyId, req.params.customerId, custName, reference, parseFloat(amount), balanceAfter, notes||null, userId]
      );
      await audit(query, { req, action: 'ar_ledger.payment', entity: 'ar_ledger', entityId: req.params.customerId, payload: { amount, reference } });
      res.status(201).json({ message: `✅ Payment of UGX ${amount.toLocaleString()} recorded`, balance_after: balanceAfter });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ── Helper ──────────────────────────────────────────────
  async function warehouseBelongsToOrg(warehouseId, orgId) {
    const r = await query(`SELECT id FROM warehouses WHERE id=$1 AND org_id=$2`, [warehouseId, orgId]);
    return r.rows.length > 0;
  }
};
