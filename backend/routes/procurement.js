'use strict';
const err = require('./_err');

// ============================================================
// MedVault — Procurement Module (Phase 2)
// Routes:
//   Purchase Orders  — create, list, get, submit, cancel
//   GRN              — receive stock against PO (or ad-hoc)
//   AP Ledger        — record invoice payments, view balance
//   Price Levels     — CRUD for pricing tiers
//   Drug Returns     — return-to-supplier workflow
// ============================================================

module.exports = function registerProcurementRoutes(app, {
  query, pool, getNextPoNumber, getNextGrnNumber, getNextReturnNumber,
  auth, can, validate, audit,
}) {

  // ===========================================================
  // PRICE LEVELS
  // ===========================================================

  // GET /api/price-levels
  app.get('/api/price-levels', auth, async (req, res) => {
    const { orgId } = req.user;
    try {
      const r = await query(
        `SELECT * FROM price_levels WHERE org_id=$1 AND is_active=true ORDER BY is_default DESC, name`,
        [orgId]
      );
      res.json({ price_levels: r.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // POST /api/price-levels
  app.post('/api/price-levels', auth, can('inventory:write'), validate({
    name:         { required: true, type: 'string', minLen: 1, maxLen: 100 },
    discount_pct: { type: 'number', min: 0, max: 100 },
  }), async (req, res) => {
    const { orgId } = req.user;
    const { name, description, discount_pct, is_default } = req.body;
    try {
      // Only one default allowed per org
      if (is_default) {
        await query(
          `UPDATE price_levels SET is_default=false WHERE org_id=$1`,
          [orgId]
        );
      }
      const r = await query(
        `INSERT INTO price_levels (org_id, name, description, discount_pct, is_default)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [orgId, name.trim(), description || null, parseFloat(discount_pct || 0), !!is_default]
      );
      await audit(query, { req, action: 'price_level.create', entity: 'price_level', entityId: r.rows[0].id, payload: { name: name.trim() } });
      res.status(201).json({ message: '✅ Price level created!', price_level: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // PUT /api/price-levels/:id
  app.put('/api/price-levels/:id', auth, can('inventory:write'), async (req, res) => {
    const { orgId } = req.user;
    const { name, description, discount_pct, is_default } = req.body;
    try {
      if (is_default) {
        await query(`UPDATE price_levels SET is_default=false WHERE org_id=$1`, [orgId]);
      }
      const r = await query(
        `UPDATE price_levels SET name=COALESCE($1,name), description=COALESCE($2,description),
         discount_pct=COALESCE($3,discount_pct), is_default=COALESCE($4,is_default)
         WHERE id=$5 AND org_id=$6 RETURNING *`,
        [name || null, description || null, discount_pct != null ? parseFloat(discount_pct) : null,
         is_default != null ? !!is_default : null, req.params.id, orgId]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Price level not found', 'id');
      res.json({ message: '✅ Price level updated!', price_level: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // PUT /api/drug-prices  — set override price for drug+level
  app.put('/api/drug-prices', auth, can('inventory:write'), validate({
    drug_id:        { required: true, type: 'number', min: 1 },
    price_level_id: { required: true, type: 'number', min: 1 },
    price:          { required: true, type: 'number', min: 0 },
  }), async (req, res) => {
    const { drug_id, price_level_id, price } = req.body;
    try {
      const r = await query(
        `INSERT INTO drug_prices (drug_id, price_level_id, price)
         VALUES ($1,$2,$3)
         ON CONFLICT (drug_id, price_level_id) DO UPDATE SET price=$3
         RETURNING *`,
        [drug_id, price_level_id, parseFloat(price)]
      );
      res.json({ message: '✅ Drug price set!', drug_price: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // GET /api/drug-prices/:drugId  — all price levels for one drug
  app.get('/api/drug-prices/:drugId', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const r = await query(
        `SELECT dp.*, pl.name as level_name, pl.is_default
         FROM drug_prices dp
         JOIN price_levels pl ON pl.id = dp.price_level_id
         WHERE dp.drug_id=$1
         ORDER BY pl.name`,
        [req.params.drugId]
      );
      res.json({ drug_prices: r.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });


  // ===========================================================
  // SUPPLIERS — owned by suppliers.js (registered before this module)
  // Do NOT re-register GET/POST/PUT/DELETE /api/suppliers here.
  // ===========================================================

  // ===========================================================
  // PURCHASE ORDERS
  // ===========================================================

  // GET /api/procurement/purchase-orders
  app.get('/api/procurement/purchase-orders', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 50);
    const offset = (page - 1) * limit;
    const status = req.query.status || null;

    try {
      const params = [pharmacyId];
      let statusFilter = '';
      if (status) { params.push(status); statusFilter = ` AND po.status=$${params.length}`; }

      const [rows, countRes] = await Promise.all([
        query(
          `SELECT po.*,
                  s.name as supplier_name, s.phone as supplier_phone,
                  u.name as created_by_name,
                  COUNT(poi.id) as line_count
           FROM purchase_orders po
           JOIN suppliers s ON s.id = po.supplier_id
           LEFT JOIN users u ON u.id = po.created_by
           LEFT JOIN purchase_order_items poi ON poi.po_id = po.id
           WHERE po.pharmacy_id=$1${statusFilter}
           GROUP BY po.id, s.name, s.phone, u.name
           ORDER BY po.created_at DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]
        ),
        query(
          `SELECT COUNT(*) as total FROM purchase_orders po WHERE po.pharmacy_id=$1${statusFilter}`,
          params
        ),
      ]);
      const total = parseInt(countRes.rows[0].total);
      res.json({
        purchase_orders: rows.rows,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // GET /api/procurement/purchase-orders/:id
  app.get('/api/procurement/purchase-orders/:id', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const [po, items] = await Promise.all([
        query(
          `SELECT po.*, s.name as supplier_name, s.phone as supplier_phone,
                  s.email as supplier_email, u.name as created_by_name
           FROM purchase_orders po
           JOIN suppliers s ON s.id = po.supplier_id
           LEFT JOIN users u ON u.id = po.created_by
           WHERE po.id=$1 AND po.pharmacy_id=$2`,
          [req.params.id, pharmacyId]
        ),
        query(
          `SELECT poi.*, d.unit_price as current_unit_price
           FROM purchase_order_items poi
           LEFT JOIN drugs d ON d.id = poi.drug_id
           WHERE poi.po_id=$1
           ORDER BY poi.drug_name`,
          [req.params.id]
        ),
      ]);
      if (!po.rows.length) return err(res, 404, 'NOT_FOUND_PO', 'Purchase order not found', 'id');
      res.json({ purchase_order: po.rows[0], items: items.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // POST /api/procurement/purchase-orders  — create draft PO
  app.post('/api/procurement/purchase-orders', auth, can('inventory:write'), validate({
    supplier_id: { required: true, type: 'number', min: 1 },
    items:       { required: true, type: 'array' },
  }), async (req, res) => {
    const { pharmacyId, orgId, userId } = req.user;
    const { supplier_id, items, expected_at, notes } = req.body;

    if (!Array.isArray(items) || !items.length)
      return err(res, 400, 'VALIDATION_REQUIRED', 'items array is required', 'items');
    for (const [i, item] of items.entries()) {
      if (!item.drug_name || String(item.drug_name).trim() === '')
        return err(res, 400, 'VALIDATION_REQUIRED', `items[${i}].drug_name is required`, 'drug_name');
      if (!item.quantity_ordered || Number(item.quantity_ordered) < 1)
        return err(res, 400, 'VALIDATION_REQUIRED', `items[${i}].quantity_ordered must be >= 1`, 'quantity_ordered');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const poNumber = await getNextPoNumber(pharmacyId);

      // Compute total
      const totalCost = items.reduce((sum, it) =>
        sum + (parseFloat(it.unit_cost || 0) * parseInt(it.quantity_ordered || 0)), 0
      );

      const poRes = await client.query(
        `INSERT INTO purchase_orders
           (org_id, pharmacy_id, supplier_id, po_number, status, expected_at, notes, total_cost, created_by)
         VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8)
         RETURNING *`,
        [orgId, pharmacyId, supplier_id, poNumber,
         expected_at || null, notes || null, totalCost, userId]
      );
      const po = poRes.rows[0];

      for (const item of items) {
        const qty = parseInt(item.quantity_ordered);
        const cost = parseFloat(item.unit_cost || 0);
        await client.query(
          `INSERT INTO purchase_order_items
             (po_id, drug_id, drug_name, quantity_ordered, unit_cost, total_cost)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [po.id, item.drug_id || null, String(item.drug_name).trim(), qty, cost, cost * qty]
        );
      }

      await client.query('COMMIT');
      await audit(query, {
        req, action: 'po.create', entity: 'purchase_order', entityId: po.id,
        payload: { po_number: poNumber, supplier_id, item_count: items.length, total_cost: totalCost },
      });
      res.status(201).json({ message: '✅ Purchase order created!', purchase_order: po, po_number: poNumber });
    } catch (e) {
      await client.query('ROLLBACK');
      return err(res, 500, 'SERVER_ERROR', 'PO creation failed: ' + e.message);
    } finally {
      client.release();
    }
  });

  // PATCH /api/procurement/purchase-orders/:id/submit
  app.patch('/api/procurement/purchase-orders/:id/submit', auth, can('inventory:write'), async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const r = await query(
        `UPDATE purchase_orders SET status='submitted', ordered_at=NOW(), updated_at=NOW()
         WHERE id=$1 AND pharmacy_id=$2 AND status='draft'
         RETURNING *`,
        [req.params.id, pharmacyId]
      );
      if (!r.rows.length) return err(res, 400, 'INVALID_STATE', 'PO not found or not in draft status', 'id');
      await audit(query, { req, action: 'po.submit', entity: 'purchase_order', entityId: req.params.id, payload: {} });
      res.json({ message: '✅ Purchase order submitted to supplier!', purchase_order: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // PATCH /api/procurement/purchase-orders/:id/cancel
  app.patch('/api/procurement/purchase-orders/:id/cancel', auth, can('inventory:write'), async (req, res) => {
    const { pharmacyId } = req.user;
    const { reason } = req.body;
    try {
      const r = await query(
        `UPDATE purchase_orders SET status='cancelled', notes=CONCAT(COALESCE(notes,''), $1), updated_at=NOW()
         WHERE id=$2 AND pharmacy_id=$3 AND status IN ('draft','submitted')
         RETURNING *`,
        [reason ? `\n[Cancelled: ${reason}]` : '\n[Cancelled]', req.params.id, pharmacyId]
      );
      if (!r.rows.length) return err(res, 400, 'INVALID_STATE', 'PO not found or cannot be cancelled at this stage', 'id');
      await audit(query, { req, action: 'po.cancel', entity: 'purchase_order', entityId: req.params.id, payload: { reason: reason || null } });
      res.json({ message: '✅ Purchase order cancelled.', purchase_order: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // PATCH /api/procurement/purchase-orders/:id/items  — edit line items while still in draft
  app.patch('/api/procurement/purchase-orders/:id/items', auth, can('inventory:write'), async (req, res) => {
    const { pharmacyId } = req.user;
    const { items } = req.body;
    if (!Array.isArray(items) || !items.length)
      return err(res, 400, 'VALIDATION_REQUIRED', 'items array is required', 'items');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Confirm PO is still draft
      const check = await client.query(
        `SELECT id FROM purchase_orders WHERE id=$1 AND pharmacy_id=$2 AND status='draft'`,
        [req.params.id, pharmacyId]
      );
      if (!check.rows.length) return err(res, 400, 'INVALID_STATE', 'PO not found or not in draft', 'id');

      // Replace all line items
      await client.query(`DELETE FROM purchase_order_items WHERE po_id=$1`, [req.params.id]);
      let totalCost = 0;
      for (const item of items) {
        const qty = parseInt(item.quantity_ordered);
        const cost = parseFloat(item.unit_cost || 0);
        totalCost += cost * qty;
        await client.query(
          `INSERT INTO purchase_order_items (po_id, drug_id, drug_name, quantity_ordered, unit_cost, total_cost)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [req.params.id, item.drug_id || null, String(item.drug_name).trim(), qty, cost, cost * qty]
        );
      }
      await client.query(
        `UPDATE purchase_orders SET total_cost=$1, updated_at=NOW() WHERE id=$2`,
        [totalCost, req.params.id]
      );

      await client.query('COMMIT');
      res.json({ message: '✅ PO items updated!' });
    } catch (e) {
      await client.query('ROLLBACK');
      return err(res, 500, 'SERVER_ERROR', e.message);
    } finally {
      client.release();
    }
  });


  // ===========================================================
  // GOODS RECEIVED NOTES (GRN)
  // ===========================================================

  // GET /api/procurement/grn
  app.get('/api/procurement/grn', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 50);
    const offset = (page - 1) * limit;

    try {
      const [rows, countRes] = await Promise.all([
        query(
          `SELECT g.*, s.name as supplier_name, u.name as received_by_name,
                  po.po_number, COUNT(gi.id) as line_count
           FROM grn g
           LEFT JOIN suppliers s ON s.id = g.supplier_id
           LEFT JOIN users u ON u.id = g.received_by
           LEFT JOIN purchase_orders po ON po.id = g.po_id
           LEFT JOIN grn_items gi ON gi.grn_id = g.id
           WHERE g.pharmacy_id=$1
           GROUP BY g.id, s.name, u.name, po.po_number
           ORDER BY g.received_at DESC
           LIMIT $2 OFFSET $3`,
          [pharmacyId, limit, offset]
        ),
        query(`SELECT COUNT(*) as total FROM grn WHERE pharmacy_id=$1`, [pharmacyId]),
      ]);
      const total = parseInt(countRes.rows[0].total);
      res.json({
        grn_list: rows.rows,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // GET /api/procurement/grn/:id
  app.get('/api/procurement/grn/:id', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const [grn, items] = await Promise.all([
        query(
          `SELECT g.*, s.name as supplier_name, u.name as received_by_name, po.po_number
           FROM grn g
           LEFT JOIN suppliers s ON s.id = g.supplier_id
           LEFT JOIN users u ON u.id = g.received_by
           LEFT JOIN purchase_orders po ON po.id = g.po_id
           WHERE g.id=$1 AND g.pharmacy_id=$2`,
          [req.params.id, pharmacyId]
        ),
        query(
          `SELECT gi.*, d.name as current_drug_name
           FROM grn_items gi LEFT JOIN drugs d ON d.id = gi.drug_id
           WHERE gi.grn_id=$1 ORDER BY gi.drug_name`,
          [req.params.id]
        ),
      ]);
      if (!grn.rows.length) return err(res, 404, 'NOT_FOUND_GRN', 'GRN not found', 'id');
      res.json({ grn: grn.rows[0], items: items.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // POST /api/procurement/grn  — receive stock (with or without a PO)
  // This is the most critical Phase 2 endpoint:
  // - Creates GRN record
  // - Updates drug quantities atomically
  // - Updates PO quantities_received + status
  // - Records AP ledger invoice entry
  // All in one DB transaction.
  app.post('/api/procurement/grn', auth, can('inventory:write'), validate({
    items: { required: true, type: 'array' },
  }), async (req, res) => {
    const { pharmacyId, orgId, userId } = req.user;
    const { po_id, supplier_id, invoice_ref, notes, items } = req.body;

    if (!Array.isArray(items) || !items.length)
      return err(res, 400, 'VALIDATION_REQUIRED', 'items array is required', 'items');

    // Must have a supplier — either from PO or passed directly
    if (!po_id && !supplier_id)
      return err(res, 400, 'VALIDATION_REQUIRED', 'supplier_id is required when no po_id is provided', 'supplier_id');

    for (const [i, item] of items.entries()) {
      if (!item.drug_name || String(item.drug_name).trim() === '')
        return err(res, 400, 'VALIDATION_REQUIRED', `items[${i}].drug_name is required`, 'drug_name');
      if (!item.quantity || Number(item.quantity) < 1)
        return err(res, 400, 'VALIDATION_REQUIRED', `items[${i}].quantity must be >= 1`, 'quantity');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Resolve supplier_id from PO if not provided
      let resolvedSupplierId = supplier_id || null;
      if (po_id && !resolvedSupplierId) {
        const poCheck = await client.query(
          `SELECT id, supplier_id, status FROM purchase_orders WHERE id=$1 AND pharmacy_id=$2`,
          [po_id, pharmacyId]
        );
        if (!poCheck.rows.length)
          return err(res, 404, 'NOT_FOUND_PO', 'Purchase order not found', 'po_id');
        if (poCheck.rows[0].status === 'cancelled')
          return err(res, 400, 'INVALID_STATE', 'Cannot receive against a cancelled PO', 'po_id');
        resolvedSupplierId = poCheck.rows[0].supplier_id;
      }

      const grnNumber = await getNextGrnNumber(pharmacyId);
      const totalCost = items.reduce((sum, it) =>
        sum + (parseFloat(it.unit_cost || 0) * parseInt(it.quantity || 0)), 0
      );

      // Insert GRN header
      const warehouseId = req.body.warehouse_id ? parseInt(req.body.warehouse_id) : null;

      const grnRes = await client.query(
        `INSERT INTO grn (org_id, pharmacy_id, po_id, supplier_id, grn_number, received_by, invoice_ref, total_cost, notes, warehouse_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [orgId, pharmacyId, po_id || null, resolvedSupplierId,
         grnNumber, userId, invoice_ref || null, totalCost, notes || null, warehouseId]
      );
      const grn = grnRes.rows[0];

      // Insert GRN items + update drug stock
      for (const item of items) {
        const qty  = parseInt(item.quantity);
        const cost = parseFloat(item.unit_cost || 0);

        await client.query(
          `INSERT INTO grn_items (grn_id, drug_id, drug_name, batch_number, expiry_date, quantity, unit_cost, total_cost)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [grn.id, item.drug_id || null, String(item.drug_name).trim(),
           item.batch_number || null, item.expiry_date || null,
           qty, cost, cost * qty]
        );

        // Resolve drug_id by name if not supplied by client (ensures cost_price always writes back)
        let drugId = item.drug_id || null;
        if (!drugId && item.drug_name) {
          const lookup = await client.query(
            `SELECT id FROM drugs WHERE pharmacy_id=$1 AND LOWER(name)=LOWER($2) LIMIT 1`,
            [pharmacyId, String(item.drug_name).trim()]
          );
          if (lookup.rows.length) drugId = lookup.rows[0].id;
        }

        if (warehouseId) {
          // ── Stock lands in warehouse_stock (not branch inventory) ─────
          const existing = await client.query(
            `SELECT id FROM warehouse_stock
             WHERE warehouse_id=$1 AND LOWER(drug_name)=LOWER($2)`,
            [warehouseId, String(item.drug_name).trim()]
          );
          if (existing.rows.length) {
            await client.query(
              `UPDATE warehouse_stock
               SET quantity=quantity+$1, cost_price=$2, updated_at=NOW()
               WHERE id=$3`,
              [qty, cost > 0 ? cost : existing.rows[0].cost_price, existing.rows[0].id]
            );
          } else {
            await client.query(
              `INSERT INTO warehouse_stock
                 (warehouse_id, org_id, drug_name, category, quantity, cost_price, unit_price, batch_number, expiry_date)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [warehouseId, orgId, String(item.drug_name).trim(),
               item.category || 'General', qty, cost, item.unit_price || 0,
               item.batch_number || null, item.expiry_date || null]
            );
          }
        } else {
          // ── Stock lands directly in branch drugs table ────────────────
          // Update stock + cost_price atomically
          if (drugId) {
            await client.query(
              `UPDATE drugs SET quantity=quantity+$1, cost_price=$2, updated_at=NOW()
               WHERE id=$3 AND pharmacy_id=$4`,
              [qty, cost > 0 ? cost : null, drugId, pharmacyId]
            );

            // Back-fill drug_id on grn_items row if we resolved it here
            if (!item.drug_id) {
              await client.query(
                `UPDATE grn_items SET drug_id=$1
                 WHERE grn_id=$2 AND LOWER(drug_name)=LOWER($3) AND drug_id IS NULL`,
                [drugId, grn.id, String(item.drug_name).trim()]
              );
            }

            // Update batch record if batch number provided
            if (item.batch_number) {
              await client.query(
                `INSERT INTO drug_batches (drug_id, pharmacy_id, batch_number, expiry_date, quantity, cost_price)
                 VALUES ($1,$2,$3,$4,$5,$6)
                 ON CONFLICT (drug_id, batch_number)
                 DO UPDATE SET
                   quantity   = drug_batches.quantity + EXCLUDED.quantity,
                   cost_price = CASE WHEN EXCLUDED.cost_price > 0 THEN EXCLUDED.cost_price ELSE drug_batches.cost_price END,
                   expiry_date = COALESCE(EXCLUDED.expiry_date, drug_batches.expiry_date)`,
                [drugId, pharmacyId, item.batch_number,
                 item.expiry_date || null, qty, cost]
              );
            }
          }
        }

        // Update PO line item quantities_received
        if (po_id && drugId) {
          await client.query(
            `UPDATE purchase_order_items
             SET quantity_received = quantity_received + $1
             WHERE po_id=$2 AND drug_id=$3`,
            [qty, po_id, item.drug_id]
          );
        }
      }

      // Update PO status: partial or received
      if (po_id) {
        await client.query(
          `UPDATE purchase_orders
           SET status = CASE
             WHEN NOT EXISTS (
               SELECT 1 FROM purchase_order_items
               WHERE po_id=$1 AND quantity_received < quantity_ordered
             ) THEN 'received'
             ELSE 'partial'
           END,
           updated_at=NOW()
           WHERE id=$1 AND status IN ('submitted','partial')`,
          [po_id]
        );
      }

      // Record AP ledger invoice entry
      if (totalCost > 0) {
        // Get current balance for this supplier
        const balRes = await client.query(
          `SELECT COALESCE(SUM(CASE WHEN type='invoice' THEN amount ELSE -amount END), 0) as balance
           FROM ap_ledger WHERE supplier_id=$1 AND pharmacy_id=$2`,
          [resolvedSupplierId, pharmacyId]
        );
        const currentBalance = parseFloat(balRes.rows[0].balance || 0);
        const newBalance = currentBalance + totalCost;

        await client.query(
          `INSERT INTO ap_ledger (org_id, pharmacy_id, supplier_id, grn_id, type, reference, amount, balance_after, recorded_by)
           VALUES ($1,$2,$3,$4,'invoice',$5,$6,$7,$8)`,
          [orgId, pharmacyId, resolvedSupplierId, grn.id,
           invoice_ref || grnNumber, totalCost, newBalance, userId]
        );
      }

      await client.query('COMMIT');

      await audit(query, {
        req, action: 'grn.create', entity: 'grn', entityId: grn.id,
        payload: { grn_number: grnNumber, po_id: po_id || null, supplier_id: resolvedSupplierId, item_count: items.length, total_cost: totalCost },
      });

      res.status(201).json({
        message: '✅ Stock received and inventory updated!',
        grn,
        grn_number: grnNumber,
        items_received: items.length,
        total_cost: totalCost,
      });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('GRN transaction failed:', e.message);
      return err(res, 500, 'SERVER_ERROR', 'GRN failed: ' + e.message);
    } finally {
      client.release();
    }
  });


  // ===========================================================
  // AP LEDGER
  // ===========================================================

  // GET /api/procurement/ap-ledger/:supplierId
  app.get('/api/procurement/ap-ledger/:supplierId', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const [ledger, summary] = await Promise.all([
        query(
          `SELECT al.*, u.name as recorded_by_name
           FROM ap_ledger al LEFT JOIN users u ON u.id = al.recorded_by
           WHERE al.supplier_id=$1 AND al.pharmacy_id=$2
           ORDER BY al.created_at DESC LIMIT 100`,
          [req.params.supplierId, pharmacyId]
        ),
        query(
          `SELECT
             COALESCE(SUM(CASE WHEN type='invoice' THEN amount ELSE 0 END), 0) as total_invoiced,
             COALESCE(SUM(CASE WHEN type='payment' THEN amount ELSE 0 END), 0) as total_paid,
             COALESCE(SUM(CASE WHEN type='credit_note' THEN amount ELSE 0 END), 0) as total_credits,
             COALESCE(SUM(CASE WHEN type='invoice' THEN amount WHEN type IN ('payment','credit_note') THEN -amount ELSE 0 END), 0) as outstanding_balance
           FROM ap_ledger
           WHERE supplier_id=$1 AND pharmacy_id=$2`,
          [req.params.supplierId, pharmacyId]
        ),
      ]);
      res.json({ ledger: ledger.rows, summary: summary.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // POST /api/procurement/ap-ledger/:supplierId/payment  — record a payment
  app.post('/api/procurement/ap-ledger/:supplierId/payment', auth, can('inventory:write'), validate({
    amount:    { required: true, type: 'number', min: 0.01 },
    reference: { required: true, type: 'string', minLen: 1 },
  }), async (req, res) => {
    const { pharmacyId, orgId, userId } = req.user;
    const { amount, reference, notes } = req.body;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get current balance
      const balRes = await client.query(
        `SELECT COALESCE(SUM(CASE WHEN type='invoice' THEN amount ELSE -amount END), 0) as balance
         FROM ap_ledger WHERE supplier_id=$1 AND pharmacy_id=$2`,
        [req.params.supplierId, pharmacyId]
      );
      const currentBalance = parseFloat(balRes.rows[0].balance || 0);
      const newBalance = currentBalance - parseFloat(amount);

      const r = await client.query(
        `INSERT INTO ap_ledger (org_id, pharmacy_id, supplier_id, type, reference, amount, balance_after, notes, recorded_by)
         VALUES ($1,$2,$3,'payment',$4,$5,$6,$7,$8) RETURNING *`,
        [orgId, pharmacyId, req.params.supplierId, reference, parseFloat(amount), newBalance, notes || null, userId]
      );

      await client.query('COMMIT');
      await audit(query, {
        req, action: 'ap.payment', entity: 'ap_ledger', entityId: r.rows[0].id,
        payload: { supplier_id: req.params.supplierId, amount, reference },
      });
      res.status(201).json({
        message: '✅ Payment recorded!',
        entry: r.rows[0],
        outstanding_balance: newBalance,
      });
    } catch (e) {
      await client.query('ROLLBACK');
      return err(res, 500, 'SERVER_ERROR', e.message);
    } finally {
      client.release();
    }
  });


  // ===========================================================
  // DRUG RETURNS TO SUPPLIER
  // ===========================================================

  // GET /api/procurement/returns
  app.get('/api/procurement/returns', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 50);
    const offset = (page - 1) * limit;
    try {
      const [rows, countRes] = await Promise.all([
        query(
          `SELECT dr.*, s.name as supplier_name, u.name as created_by_name
           FROM drug_returns dr
           JOIN suppliers s ON s.id = dr.supplier_id
           LEFT JOIN users u ON u.id = dr.created_by
           WHERE dr.pharmacy_id=$1
           ORDER BY dr.created_at DESC LIMIT $2 OFFSET $3`,
          [pharmacyId, limit, offset]
        ),
        query(`SELECT COUNT(*) as total FROM drug_returns WHERE pharmacy_id=$1`, [pharmacyId]),
      ]);
      const total = parseInt(countRes.rows[0].total);
      res.json({ returns: rows.rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // POST /api/procurement/returns  — create return, deduct stock
  app.post('/api/procurement/returns', auth, can('inventory:write'), validate({
    supplier_id: { required: true, type: 'number', min: 1 },
    reason:      { required: true, enum: ['expired', 'damaged', 'overstock', 'wrong_item'] },
    items:       { required: true, type: 'array' },
  }), async (req, res) => {
    const { pharmacyId, orgId, userId } = req.user;
    const { supplier_id, reason, notes, items } = req.body;

    if (!Array.isArray(items) || !items.length)
      return err(res, 400, 'VALIDATION_REQUIRED', 'items array is required', 'items');
    for (const [i, item] of items.entries()) {
      if (!item.drug_name)
        return err(res, 400, 'VALIDATION_REQUIRED', `items[${i}].drug_name is required`, 'drug_name');
      if (!item.quantity || Number(item.quantity) < 1)
        return err(res, 400, 'VALIDATION_REQUIRED', `items[${i}].quantity must be >= 1`, 'quantity');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const returnNumber = await getNextReturnNumber(pharmacyId);
      const totalValue = items.reduce((sum, it) =>
        sum + (parseFloat(it.unit_cost || 0) * parseInt(it.quantity || 0)), 0
      );

      const retRes = await client.query(
        `INSERT INTO drug_returns (org_id, pharmacy_id, supplier_id, return_number, status, reason, notes, total_value, created_by)
         VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8) RETURNING *`,
        [orgId, pharmacyId, supplier_id, returnNumber, reason, notes || null, totalValue, userId]
      );
      const ret = retRes.rows[0];

      for (const item of items) {
        const qty  = parseInt(item.quantity);
        const cost = parseFloat(item.unit_cost || 0);
        await client.query(
          `INSERT INTO drug_return_items (return_id, drug_id, drug_name, batch_number, quantity, unit_cost, total_cost)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [ret.id, item.drug_id || null, String(item.drug_name).trim(),
           item.batch_number || null, qty, cost, cost * qty]
        );
        // Deduct stock for physical return
        if (item.drug_id) {
          await client.query(
            `UPDATE drugs SET quantity=GREATEST(0,quantity-$1), updated_at=NOW()
             WHERE id=$2 AND pharmacy_id=$3`,
            [qty, item.drug_id, pharmacyId]
          );
        }
      }

      await client.query('COMMIT');
      await audit(query, {
        req, action: 'drug_return.create', entity: 'drug_return', entityId: ret.id,
        payload: { return_number: returnNumber, supplier_id, reason, item_count: items.length },
      });
      res.status(201).json({
        message: '✅ Return created and stock adjusted!',
        return: ret,
        return_number: returnNumber,
      });
    } catch (e) {
      await client.query('ROLLBACK');
      return err(res, 500, 'SERVER_ERROR', 'Return creation failed: ' + e.message);
    } finally {
      client.release();
    }
  });

  // PATCH /api/procurement/returns/:id/status  — mark as sent / credited / closed
  app.patch('/api/procurement/returns/:id/status', auth, can('inventory:write'), validate({
    status: { required: true, enum: ['sent', 'credited', 'closed'] },
  }), async (req, res) => {
    const { pharmacyId } = req.user;
    const { status, notes } = req.body;
    try {
      const r = await query(
        `UPDATE drug_returns SET status=$1, notes=CONCAT(COALESCE(notes,''), $2)
         WHERE id=$3 AND pharmacy_id=$4 RETURNING *`,
        [status, notes ? `\n[${status}: ${notes}]` : '', req.params.id, pharmacyId]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND_RETURN', 'Return not found', 'id');
      await audit(query, { req, action: `drug_return.${status}`, entity: 'drug_return', entityId: req.params.id, payload: { status } });
      res.json({ message: `✅ Return marked as ${status}!`, return: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });


  // ===========================================================
  // RECEIVE STOCK FROM MARKETPLACE ORDER
  // POST /api/procurement/receive-from-order/:orderId
  //
  // Bridges the marketplace order (MKT-xxxx) → GRN flow.
  // The pharmacy marks an order as delivered AND receives stock
  // in one atomic transaction so inventory is always up to date.
  // ===========================================================

  app.post('/api/procurement/receive-from-order/:orderId', auth, can('inventory:write'), async (req, res) => {
    const { pharmacyId, orgId, userId } = req.user;
    const { items, invoice_ref, notes, warehouse_id } = req.body;

    // items is optional — if omitted we auto-derive from the marketplace order
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // ── 1. Fetch the marketplace order ──────────────────────
      const ordRes = await client.query(
        `SELECT mo.*, ms.business_name as supplier_name_from_mkt
         FROM marketplace_orders mo
         LEFT JOIN marketplace_suppliers ms ON ms.id = mo.supplier_id
         WHERE mo.id = $1 AND mo.pharmacy_id = $2`,
        [req.params.orderId, pharmacyId]
      );
      if (!ordRes.rows.length)
        return err(res, 404, 'NOT_FOUND_ORDER', 'Marketplace order not found', 'orderId');

      const mktOrder = ordRes.rows[0];

      // ── 2. Fetch line items if not supplied by client ────────
      let receiveItems = items;
      if (!Array.isArray(receiveItems) || !receiveItems.length) {
        const itemsRes = await client.query(
          `SELECT oi.product_name as drug_name, oi.quantity, oi.unit_price as unit_cost,
                  NULL::varchar as batch_number, NULL::date as expiry_date, NULL as drug_id
           FROM marketplace_order_items oi
           WHERE oi.order_id = $1`,
          [req.params.orderId]
        );
        receiveItems = itemsRes.rows;
      }

      if (!receiveItems.length)
        return err(res, 400, 'VALIDATION_REQUIRED', 'No items found for this order', 'items');

      // ── 3. Resolve supplier_id ────────────────────────────────
      // marketplace_orders.supplier_id is a marketplace supplier; we need
      // a suppliers table reference.  Look it up by name match or fall back.
      let supplierId = null;
      const supplierLookupName = mktOrder.supplier_name_from_mkt || mktOrder.supplier_name;
      if (supplierLookupName) {
        const supRes = await client.query(
          `SELECT id FROM suppliers WHERE LOWER(name)=LOWER($1) AND is_active=true LIMIT 1`,
          [supplierLookupName]
        );
        if (supRes.rows.length) supplierId = supRes.rows[0].id;
      }

      // ── 4. Mark marketplace order as delivered + stock_received ─
      await client.query(
        `UPDATE marketplace_orders
         SET status='delivered',
             delivered_at=NOW(),
             stock_received=true,
             stock_received_at=NOW(),
             updated_at=NOW()
         WHERE id=$1 AND pharmacy_id=$2 AND status NOT IN ('delivered','cancelled')`,
        [req.params.orderId, pharmacyId]
      );

      // ── 5. Build GRN (reuse existing GRN logic inline) ───────
      const grnNumber = await getNextGrnNumber(pharmacyId);
      const totalCost = receiveItems.reduce(
        (sum, it) => sum + (parseFloat(it.unit_cost || 0) * parseInt(it.quantity || 0)), 0
      );
      const warehouseId = warehouse_id ? parseInt(warehouse_id) : null;

      const grnRes = await client.query(
        `INSERT INTO grn (org_id, pharmacy_id, po_id, supplier_id, grn_number, received_by,
                          invoice_ref, total_cost, notes, warehouse_id)
         VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [orgId, pharmacyId, supplierId,
         grnNumber, userId, invoice_ref || mktOrder.order_number,
         totalCost, notes || `Received from marketplace order ${mktOrder.order_number}`,
         warehouseId]
      );
      const grn = grnRes.rows[0];

      // ── 6. Process each line: grn_items + inventory ──────────
      for (const item of receiveItems) {
        const qty  = parseInt(item.quantity || 0);
        const cost = parseFloat(item.unit_cost || 0);
        if (qty < 1) continue;

        // Insert GRN line
        await client.query(
          `INSERT INTO grn_items (grn_id, drug_id, drug_name, batch_number, expiry_date, quantity, unit_cost, total_cost)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [grn.id, item.drug_id || null, String(item.drug_name).trim(),
           item.batch_number || null, item.expiry_date || null,
           qty, cost, cost * qty]
        );

        // Resolve drug_id by name if needed
        let drugId = item.drug_id || null;
        if (!drugId) {
          const lookup = await client.query(
            `SELECT id FROM drugs WHERE pharmacy_id=$1 AND LOWER(name)=LOWER($2) LIMIT 1`,
            [pharmacyId, String(item.drug_name).trim()]
          );
          if (lookup.rows.length) drugId = lookup.rows[0].id;
        }

        if (warehouseId) {
          // Stock lands in warehouse_stock
          const existing = await client.query(
            `SELECT id, cost_price FROM warehouse_stock
             WHERE warehouse_id=$1 AND LOWER(drug_name)=LOWER($2)`,
            [warehouseId, String(item.drug_name).trim()]
          );
          if (existing.rows.length) {
            await client.query(
              `UPDATE warehouse_stock SET quantity=quantity+$1, cost_price=$2, updated_at=NOW() WHERE id=$3`,
              [qty, cost > 0 ? cost : existing.rows[0].cost_price, existing.rows[0].id]
            );
          } else {
            await client.query(
              `INSERT INTO warehouse_stock (warehouse_id, org_id, drug_name, category, quantity, cost_price, unit_price)
               VALUES ($1,$2,$3,'General',$4,$5,$6)`,
              [warehouseId, orgId, String(item.drug_name).trim(), qty, cost, item.unit_price || 0]
            );
          }
        } else if (drugId) {
          // Stock lands in branch drugs table
          // Fetch existing cost_price so we never write NULL (NOT NULL constraint)
          const existingDrug = await client.query(
            `SELECT cost_price FROM drugs WHERE id=$1 AND pharmacy_id=$2`,
            [drugId, pharmacyId]
          );
          const fallbackCost = existingDrug.rows[0]?.cost_price ?? 0;
          await client.query(
            `UPDATE drugs SET quantity=quantity+$1, cost_price=$2, updated_at=NOW()
             WHERE id=$3 AND pharmacy_id=$4`,
            [qty, cost > 0 ? cost : fallbackCost, drugId, pharmacyId]
          );

          // Back-fill drug_id on grn_items row
          if (!item.drug_id) {
            await client.query(
              `UPDATE grn_items SET drug_id=$1
               WHERE grn_id=$2 AND LOWER(drug_name)=LOWER($3) AND drug_id IS NULL`,
              [drugId, grn.id, String(item.drug_name).trim()]
            );
          }

          // Upsert batch record
          if (item.batch_number) {
            await client.query(
              `INSERT INTO drug_batches (drug_id, pharmacy_id, batch_number, expiry_date, quantity, cost_price)
               VALUES ($1,$2,$3,$4,$5,$6)
               ON CONFLICT (drug_id, batch_number)
               DO UPDATE SET
                 quantity    = drug_batches.quantity + EXCLUDED.quantity,
                 cost_price  = CASE WHEN EXCLUDED.cost_price > 0 THEN EXCLUDED.cost_price ELSE drug_batches.cost_price END,
                 expiry_date = COALESCE(EXCLUDED.expiry_date, drug_batches.expiry_date)`,
              [drugId, pharmacyId, item.batch_number, item.expiry_date || null, qty, cost]
            );
          }
        }
      }

      // ── 7. AP ledger invoice entry ───────────────────────────
      if (totalCost > 0 && supplierId) {
        const balRes = await client.query(
          `SELECT COALESCE(SUM(CASE WHEN type='invoice' THEN amount ELSE -amount END),0) as balance
           FROM ap_ledger WHERE supplier_id=$1 AND pharmacy_id=$2`,
          [supplierId, pharmacyId]
        );
        const newBalance = parseFloat(balRes.rows[0].balance || 0) + totalCost;
        await client.query(
          `INSERT INTO ap_ledger (org_id, pharmacy_id, supplier_id, grn_id, type, reference, amount, balance_after, recorded_by)
           VALUES ($1,$2,$3,$4,'invoice',$5,$6,$7,$8)`,
          [orgId, pharmacyId, supplierId, grn.id, grnNumber, totalCost, newBalance, userId]
        );
      }

      await client.query('COMMIT');

      await audit(query, {
        req, action: 'grn.receive_from_order', entity: 'grn', entityId: grn.id,
        payload: {
          grn_number: grnNumber,
          marketplace_order_id: req.params.orderId,
          order_number: mktOrder.order_number,
          supplier_id: supplierId,
          item_count: receiveItems.length,
          total_cost: totalCost,
        },
      });

      res.status(201).json({
        message: '✅ Stock received! Inventory and AP ledger updated.',
        grn,
        grn_number: grnNumber,
        items_received: receiveItems.length,
        total_cost: totalCost,
      });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('receive-from-order failed:', e.message);
      return err(res, 500, 'SERVER_ERROR', 'Receive from order failed: ' + e.message);
    } finally {
      client.release();
    }
  });


  // ===========================================================
  // GET /api/procurement/grn/for-order/:orderId
  // Returns any GRNs already created for a marketplace order
  // (used by frontend to show receiving history)
  // ===========================================================

  app.get('/api/procurement/grn/for-order/:orderId', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      // Match by notes containing the order_number — cheap and reliable
      const mktRes = await query(
        `SELECT order_number FROM marketplace_orders WHERE id=$1 AND pharmacy_id=$2`,
        [req.params.orderId, pharmacyId]
      );
      if (!mktRes.rows.length)
        return res.json({ grns: [] });

      const orderNum = mktRes.rows[0].order_number;
      const r = await query(
        `SELECT g.*, s.name as supplier_name, COUNT(gi.id) as line_count
         FROM grn g
         LEFT JOIN suppliers s ON s.id = g.supplier_id
         LEFT JOIN grn_items gi ON gi.grn_id = g.id
         WHERE g.pharmacy_id=$1 AND (g.invoice_ref=$2 OR g.notes ILIKE $3)
         GROUP BY g.id, s.name
         ORDER BY g.received_at DESC`,
        [pharmacyId, orderNum, `%${orderNum}%`]
      );
      res.json({ grns: r.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

};