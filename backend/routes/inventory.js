'use strict';
const err = require('./_err');

module.exports = function registerInventoryRoutes(app, { query, pool, auth, can, validate, schemas, audit }) {

  // Shared handler for listing drugs — registered on both paths
  async function listDrugs(req, res) {
    const { pharmacyId } = req.user;
    const { search, category } = req.query;
    try {
      let sql = `SELECT *,
        CASE WHEN quantity=0 THEN 'out' WHEN quantity<=threshold THEN 'critical' WHEN quantity<=threshold*1.5 THEN 'low' ELSE 'ok' END as stock_status,
        CASE WHEN expiry_date IS NOT NULL THEN (expiry_date-CURRENT_DATE)::int ELSE 999 END as days_to_expiry
        FROM drugs WHERE pharmacy_id=$1`;
      const params = [pharmacyId]; let i = 2;
      if (search)   { sql += ` AND name ILIKE $${i++}`; params.push('%' + search + '%'); }
      if (category) { sql += ` AND category=$${i++}`;   params.push(category); }
      sql += ' ORDER BY name';

      const page   = Math.max(1, parseInt(req.query.page)  || 1);
      const limit  = Math.min(200, parseInt(req.query.limit) || 100);
      const offset = (page - 1) * limit;

      const countResult = await query(
        `SELECT COUNT(*) as total FROM drugs WHERE pharmacy_id=$1` +
        (search   ? ` AND name ILIKE $2`    : '') +
        (category && search ? ` AND category=$3` : category ? ` AND category=$2` : ''),
        search && category ? [pharmacyId, '%' + search + '%', category]
          : search   ? [pharmacyId, '%' + search + '%']
          : category ? [pharmacyId, category]
          : [pharmacyId]
      );
      const total = parseInt(countResult.rows[0].total);

      sql += ` LIMIT ${limit} OFFSET ${offset}`;
      const result = await query(sql, params);
      res.json({
        drugs: result.rows,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  }

  // GET /api/inventory  — primary path
  // GET /api/inventory/drugs — alias used by warehouse drug search
  app.get('/api/inventory',       auth, can('inventory:read'), listDrugs);
  app.get('/api/inventory/drugs', auth, can('inventory:read'), listDrugs);

  // GET /api/inventory/alerts
  app.get('/api/inventory/alerts', auth, can('inventory:alerts'), async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const [low, exp] = await Promise.all([
        query(`SELECT * FROM drugs WHERE pharmacy_id=$1 AND quantity<=threshold ORDER BY quantity`, [pharmacyId]),
        query(`SELECT *,(expiry_date-CURRENT_DATE)::int as days_left FROM drugs WHERE pharmacy_id=$1 AND expiry_date<=CURRENT_DATE+INTERVAL '30 days' AND expiry_date>=CURRENT_DATE ORDER BY expiry_date`, [pharmacyId]),
      ]);
      res.json({ lowStock: low.rows, expiring: exp.rows });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // GET /api/inventory/adjustments
  app.get('/api/inventory/adjustments', auth, can('inventory:read'), async (req, res) => {
    const { pharmacyId } = req.user;
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 50);
    const offset = (page - 1) * limit;
    try {
      const [rows, countRes] = await Promise.all([
        query(
          `SELECT sa.*, d.name as drug_name, u.name as adjusted_by
           FROM stock_adjustments sa
           JOIN drugs d ON d.id = sa.drug_id
           LEFT JOIN users u ON u.id = sa.user_id
           WHERE sa.pharmacy_id = $1
           ORDER BY sa.created_at DESC
           LIMIT $2 OFFSET $3`,
          [pharmacyId, limit, offset]
        ),
        query(`SELECT COUNT(*) as total FROM stock_adjustments WHERE pharmacy_id = $1`, [pharmacyId]),
      ]);
      const total = parseInt(countRes.rows[0].total);
      res.json({
        adjustments: rows.rows,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // POST /api/inventory/adjust
  app.post('/api/inventory/adjust', auth, can('inventory:write'), validate(schemas.stockAdjustment), async (req, res) => {
    const { pharmacyId, userId } = req.user;
    const { drug_id, quantity_after, type, reason } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const drugRes = await client.query(
        `SELECT id, name, quantity FROM drugs WHERE id = $1 AND pharmacy_id = $2 FOR UPDATE`,
        [drug_id, pharmacyId]
      );
      if (!drugRes.rows.length) {
        await client.query('ROLLBACK');
        return err(res, 404, 'NOT_FOUND_DRUG', 'Drug not found', 'drug_id');
      }
      const drug = drugRes.rows[0];
      const quantity_before = drug.quantity;
      const variance = quantity_after - quantity_before;
      await client.query(
        `UPDATE drugs SET quantity = $1, updated_at = NOW(), updated_by = $2 WHERE id = $3`,
        [quantity_after, userId, drug_id]
      );
      const adjRes = await client.query(
        `INSERT INTO stock_adjustments
           (pharmacy_id, drug_id, user_id, type, quantity_before, quantity_after, variance, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [pharmacyId, drug_id, userId, type, quantity_before, quantity_after, variance, reason]
      );
      await client.query('COMMIT');
      await audit(query, {
        req, action: 'stock.adjust', entity: 'drug', entityId: drug_id,
        payload: { drug_name: drug.name, type, quantity_before, quantity_after, variance, reason },
      });
      res.json({ success: true, message: '✅ Stock adjusted!', adjustment: adjRes.rows[0] });
    } catch (e) {
      await client.query('ROLLBACK');
      return err(res, 500, 'SERVER_ERROR', e.message);
    } finally {
      client.release();
    }
  });

  // POST /api/inventory  (add new drug + initial batch)
  app.post('/api/inventory', auth, can('inventory:write'), validate(schemas.drug), async (req, res) => {
    const { name, generic_name, category, quantity, unit_price, cost_price, threshold, expiry_date, supplier, barcode, sku, batch_number } = req.body;
    if (!name) return err(res, 400, 'VALIDATION_REQUIRED', 'Drug name is required', 'name');

    const finalBatchNumber = (batch_number && typeof batch_number === 'string' && batch_number.trim())
      ? batch_number.trim()
      : `BN-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    const existing = await query(
      `SELECT id, name FROM drugs WHERE pharmacy_id=$1 AND LOWER(name)=LOWER($2) LIMIT 1`,
      [req.user.pharmacyId, name.trim()]
    );
    if (existing.rows.length) {
      return res.json({
        success: true,
        message: '✅ Drug already exists (idempotent)',
        drug: { id: existing.rows[0].id, batch_number: finalBatchNumber },
        id: existing.rows[0].id,
        _idempotent: true,
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const drugResult = await client.query(
        `INSERT INTO drugs (pharmacy_id,name,generic_name,category,quantity,unit_price,cost_price,threshold,barcode,sku,supplier,expiry_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [req.user.pharmacyId, name.trim(), generic_name || null, category || 'General',
         parseInt(quantity) || 0, parseFloat(unit_price) || 0, parseFloat(cost_price || 0),
         parseInt(threshold || 20), barcode || null, sku || null, supplier || null, expiry_date || null]
      );
      const drugId = drugResult.rows[0].id;
      const safeExpiry = expiry_date || '2099-12-31';
      await client.query(
        `INSERT INTO drug_batches (drug_id,pharmacy_id,batch_number,expiry_date,quantity,cost_price) VALUES ($1,$2,$3,$4,$5,$6)`,
        [drugId, req.user.pharmacyId, finalBatchNumber, safeExpiry, parseInt(quantity) || 0, parseFloat(cost_price || 0)]
      );
      await client.query('COMMIT');
      await audit(query, { req, action: 'drug.create', entity: 'drug', entityId: drugId, payload: { name: name.trim(), quantity, unit_price, category: category || 'General' } });
      res.json({ success: true, message: '✅ Drug added successfully', drug: { id: drugId, batch_number: finalBatchNumber }, id: drugId });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('Add drug transaction failed:', e.message);
      return err(res, 500, 'SERVER_ERROR', e.message);
    } finally {
      client.release();
    }
  });

  // PUT /api/inventory/:id
  app.put('/api/inventory/:id', auth, can('inventory:write'), validate(schemas.drug), async (req, res) => {
    const { pharmacyId } = req.user;
    const { name, generic_name, category, quantity, unit_price, cost_price, expiry_date, supplier, threshold, requires_rx } = req.body;
    try {
      const result = await query(
        `UPDATE drugs
         SET name=$1, generic_name=$2, category=$3, quantity=$4, unit_price=$5,
             cost_price=$6, expiry_date=$7, supplier=$8, threshold=$9, requires_rx=$10, updated_at=NOW()
         WHERE id=$11 AND pharmacy_id=$12
         RETURNING *`,
        [name, generic_name, category, parseInt(quantity), parseFloat(unit_price),
         parseFloat(cost_price || 0), expiry_date || null, supplier,
         parseInt(threshold || 20), Boolean(requires_rx), req.params.id, pharmacyId]
      );
      if (!result.rows.length) return err(res, 404, 'NOT_FOUND_DRUG', 'Drug not found', 'id');
      await audit(query, { req, action: 'drug.update', entity: 'drug', entityId: req.params.id, payload: { name, quantity, unit_price, category } });
      res.json({ message: '✅ Updated!', drug: result.rows[0] });
    } catch (e) {
      console.error('Update drug error:', e.message);
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // DELETE /api/inventory/:id
  app.delete('/api/inventory/:id', auth, can('inventory:delete'), async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const result = await query(`DELETE FROM drugs WHERE id=$1 AND pharmacy_id=$2 RETURNING id`, [req.params.id, pharmacyId]);
      if (!result.rows.length) return err(res, 404, 'NOT_FOUND_DRUG', 'Drug not found', 'id');
      await audit(query, { req, action: 'drug.delete', entity: 'drug', entityId: req.params.id, payload: null });
      res.json({ message: '✅ Deleted' });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // PUT /api/batch/:id
  app.put('/api/batch/:id', auth, can('inventory:write'), async (req, res) => {
    const { id } = req.params;
    const { pharmacyId } = req.user;
    const { batch_number, expiry_date, quantity, cost_price } = req.body;
    if (!batch_number) return err(res, 400, 'VALIDATION_REQUIRED', 'batch_number is required', 'batch_number');
    try {
      const result = await query(
        `UPDATE drug_batches SET batch_number=$1,expiry_date=$2,quantity=$3,cost_price=$4
         WHERE id=$5 AND pharmacy_id=$6 RETURNING *`,
        [batch_number, expiry_date || null, parseInt(quantity), parseFloat(cost_price || 0), id, pharmacyId]
      );
      if (!result.rows.length) return err(res, 404, 'NOT_FOUND_BATCH', 'Batch not found', 'id');
      res.json({ success: true, batch: result.rows[0] });
    } catch (e) {
      if (e.code === '23505') return err(res, 409, 'CONFLICT_BATCH_DUPLICATE', 'Duplicate batch_number for this drug', 'batch_number');
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ── EXPIRY REDISTRIBUTION ─────────────────────────────────
  // Suggest moving near-expiry stock to the busiest branch
  app.get('/api/expiry/redistribution', auth, can('reports:expiry'), async (req, res) => {
    const { orgId } = req.user;
    try {
      // Find near-expiry drugs across all branches
      const expiring = await query(
        `SELECT d.id, d.name, d.quantity, d.expiry_date, d.pharmacy_id, p.name as pharmacy_name,
                (d.expiry_date - CURRENT_DATE)::int as days_left
         FROM drugs d JOIN pharmacies p ON p.id=d.pharmacy_id
         WHERE p.organisation_id=$1 AND d.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE+60 AND d.quantity > 0
         ORDER BY d.expiry_date`, [orgId]
      );

      // Get sales velocity per pharmacy (sales in last 30 days)
      const velocity = await query(
        `SELECT s.pharmacy_id, p.name as pharmacy_name, COUNT(*) as sale_count,
                COALESCE(SUM(s.total_amount),0) as revenue
         FROM sales s JOIN pharmacies p ON p.id=s.pharmacy_id
         WHERE p.organisation_id=$1 AND s.created_at >= NOW()-INTERVAL '30 days'
         GROUP BY s.pharmacy_id, p.name ORDER BY sale_count DESC`, [orgId]
      );

      // Build suggestions: move expiring stock to the busiest branch
      const busiest = velocity.rows[0] || null;
      const suggestions = expiring.rows
        .filter(d => busiest && d.pharmacy_id !== busiest.pharmacy_id)
        .map(d => ({
          drug: d, from_pharmacy: d.pharmacy_name,
          to_pharmacy: busiest.pharmacy_name, to_pharmacy_id: busiest.pharmacy_id,
          reason: `${d.name} expires in ${d.days_left} days — move to ${busiest.pharmacy_name} (highest traffic: ${busiest.sale_count} sales/month)`
        }));

      res.json({ suggestions, expiring_drugs: expiring.rows, branch_velocity: velocity.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // Execute redistribution (creates a stock transfer)
  app.post('/api/expiry/redistribute', auth, can('transfers:request'), async (req, res) => {
    const { orgId, userId } = req.user;
    const { drug_id, from_pharmacy_id, to_pharmacy_id, quantity } = req.body;
    if (!drug_id || !from_pharmacy_id || !to_pharmacy_id || !quantity) return err(res, 400, 'VALIDATION_REQUIRED', 'All fields required');
    try {
      const drug = await query(`SELECT name FROM drugs WHERE id=$1`, [drug_id]);
      const r = await query(
        `INSERT INTO stock_transfers (organisation_id,from_pharmacy_id,to_pharmacy_id,drug_id,drug_name,quantity,status,requested_by,notes)
         VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,'Expiry redistribution — auto-suggested')
         RETURNING *`,
        [orgId, from_pharmacy_id, to_pharmacy_id, drug_id, drug.rows[0]?.name||'Unknown', parseInt(quantity), userId]
      );
      await audit(query, { req, action:'expiry.redistribute', entity:'stock_transfer', entityId:r.rows[0].id, payload:{drug_id, quantity, from:from_pharmacy_id, to:to_pharmacy_id} });
      res.status(201).json({ success:true, message:'✅ Transfer requested for expiry redistribution', transfer:r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ── DRUG PURCHASE HISTORY ──────────────────────────────────
  app.get('/api/inventory/:id/purchase-history', auth, can('inventory:read'), async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const [grns, pos, batches] = await Promise.all([
        query(`SELECT gi.quantity, gi.unit_cost, gi.batch_number, gi.expiry_date, g.grn_number, g.received_at, s.name as supplier_name
               FROM grn_items gi JOIN grn g ON g.id=gi.grn_id LEFT JOIN suppliers s ON s.id=g.supplier_id
               WHERE gi.drug_id=$1 AND g.pharmacy_id=$2 ORDER BY g.received_at DESC LIMIT 20`, [req.params.id, pharmacyId]),
        query(`SELECT poi.quantity_ordered, poi.quantity_received, poi.unit_cost, po.po_number, po.status, po.created_at, s.name as supplier_name
               FROM purchase_order_items poi JOIN purchase_orders po ON po.id=poi.po_id LEFT JOIN suppliers s ON s.id=po.supplier_id
               WHERE poi.drug_id=$1 AND po.pharmacy_id=$2 ORDER BY po.created_at DESC LIMIT 20`, [req.params.id, pharmacyId]),
        query(`SELECT * FROM drug_batches WHERE drug_id=$1 AND pharmacy_id=$2 ORDER BY created_at DESC`, [req.params.id, pharmacyId]),
      ]);
      res.json({ grn_history: grns.rows, po_history: pos.rows, batches: batches.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });
};
