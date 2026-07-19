'use strict';
const err = require('./_err');

module.exports = function registerCustomersRoutes(app, { query, auth, validate, schemas }) {

  // GET /api/customers
  app.get('/api/customers', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const { search } = req.query;
    try {
      let sql = `SELECT id,pharmacy_id,name,phone,email,notes,total_spent,credit_limit,
                 visit_count AS order_count,created_at,updated_at
                 FROM customers WHERE pharmacy_id=$1`;
      const params = [pharmacyId];
      if (search) { sql += ` AND (name ILIKE $2 OR phone ILIKE $2)`; params.push('%' + search + '%'); }
      sql += ' ORDER BY total_spent DESC';
      const result = await query(sql, params);
      res.json({ customers: result.rows });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // GET /api/customers/:id/credit-summary — for the checkout screen:
  // "Credit: UGX X used of Y limit", mirroring the Prepayment/Credit
  // Limit/Receivables strip on Vitaria-style POS systems. Uses the
  // existing ar_ledger running balance rather than a separate tally.
  app.get('/api/customers/:id/credit-summary', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const cust = await query(
        `SELECT id, name, credit_limit FROM customers WHERE id=$1 AND pharmacy_id=$2`,
        [req.params.id, pharmacyId]
      );
      if (!cust.rows.length) return err(res, 404, 'NOT_FOUND_CUSTOMER', 'Customer not found', 'id');

      const bal = await query(
        `SELECT COALESCE(SUM(CASE WHEN type='invoice' THEN amount ELSE -amount END),0) AS outstanding
         FROM ar_ledger WHERE customer_id=$1 AND pharmacy_id=$2`,
        [req.params.id, pharmacyId]
      );
      const creditLimit  = parseFloat(cust.rows[0].credit_limit || 0);
      const outstanding  = parseFloat(bal.rows[0].outstanding || 0);
      res.json({
        customer_id: cust.rows[0].id,
        credit_limit: creditLimit,
        outstanding_balance: outstanding,
        available_credit: Math.max(0, creditLimit - outstanding),
        over_limit: creditLimit > 0 && outstanding > creditLimit,
      });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // GET /api/customers/stats
  app.get('/api/customers/stats', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const [totals, newThisMonth, topSpenders] = await Promise.all([
        query(`SELECT COUNT(*) as total_customers,COALESCE(SUM(total_spent),0) as total_revenue,COALESCE(SUM(visit_count),0) as total_visits FROM customers WHERE pharmacy_id=$1`, [pharmacyId]),
        query(`SELECT COUNT(*) as new_this_month FROM customers WHERE pharmacy_id=$1 AND DATE_TRUNC('month',created_at)=DATE_TRUNC('month',NOW())`, [pharmacyId]),
        query(`SELECT name,phone,total_spent,visit_count FROM customers WHERE pharmacy_id=$1 ORDER BY total_spent DESC LIMIT 5`, [pharmacyId]),
      ]);
      res.json({
        total_customers: parseInt(totals.rows[0].total_customers),
        total_revenue:   parseFloat(totals.rows[0].total_revenue),
        total_visits:    parseInt(totals.rows[0].total_visits),
        new_this_month:  parseInt(newThisMonth.rows[0].new_this_month),
        top_spenders:    topSpenders.rows,
      });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // POST /api/customers/manual
  app.post('/api/customers/manual', auth, validate(schemas.customer), async (req, res) => {
    const { pharmacyId } = req.user;
    const { name, phone, email, notes, credit_limit } = req.body;
    if (!name) return err(res, 400, 'VALIDATION_REQUIRED', 'Customer name is required', 'name');
    try {
      const existing = phone
        ? await query(`SELECT id FROM customers WHERE pharmacy_id=$1 AND phone=$2 LIMIT 1`, [pharmacyId, phone])
        : await query(`SELECT id FROM customers WHERE pharmacy_id=$1 AND name ILIKE $2 LIMIT 1`, [pharmacyId, name]);
      if (existing.rows.length) return err(res, 409, 'CONFLICT_CUSTOMER_EXISTS', 'Customer with this phone/name already exists', phone ? 'phone' : 'name');
      const r = await query(
        `INSERT INTO customers (pharmacy_id,name,phone,email,notes,credit_limit,visit_count,total_spent) VALUES ($1,$2,$3,$4,$5,$6,0,0) RETURNING *`,
        [pharmacyId, name.trim(), phone || null, email || null, notes || null, parseFloat(credit_limit || 0)]
      );
      res.json({ customer: r.rows[0], created: true });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // POST /api/customers  (upsert — used during sales)
  app.post('/api/customers', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const { name, phone, email, total_spent } = req.body;
    if (!name && !phone) return err(res, 400, 'VALIDATION_REQUIRED', 'Name or phone is required', 'name');
    try {
      const existing = phone
        ? await query(`SELECT id,name FROM customers WHERE pharmacy_id=$1 AND phone=$2 LIMIT 1`, [pharmacyId, phone])
        : await query(`SELECT id,name FROM customers WHERE pharmacy_id=$1 AND name=$2 AND (phone IS NULL OR phone='') LIMIT 1`, [pharmacyId, name]);
      if (existing.rows.length) {
        const cid = existing.rows[0].id;
        await query(
          `UPDATE customers SET name=$1,visit_count=visit_count+1,total_spent=total_spent+$2,updated_at=NOW() WHERE id=$3`,
          [name || existing.rows[0].name, parseFloat(total_spent || 0), cid]
        );
        res.json({ customer: { id: cid }, updated: true });
      } else {
        const r = await query(
          `INSERT INTO customers (pharmacy_id,name,phone,email,visit_count,total_spent) VALUES ($1,$2,$3,$4,1,$5) RETURNING id`,
          [pharmacyId, name || 'Walk-in', phone || null, email || null, parseFloat(total_spent || 0)]
        );
        res.json({ customer: r.rows[0], created: true });
      }
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // PUT /api/customers/:id
  app.put('/api/customers/:id', auth, validate(schemas.customer), async (req, res) => {
    const { pharmacyId } = req.user;
    const { name, phone, email, notes, credit_limit } = req.body;
    if (!name) return err(res, 400, 'VALIDATION_REQUIRED', 'Customer name is required', 'name');
    try {
      const r = await query(
        `UPDATE customers SET name=$1,phone=$2,email=$3,notes=$4,credit_limit=COALESCE($5,credit_limit),updated_at=NOW() WHERE id=$6 AND pharmacy_id=$7 RETURNING *`,
        [name.trim(), phone || null, email || null, notes || null, credit_limit != null ? parseFloat(credit_limit) : null, req.params.id, pharmacyId]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND_CUSTOMER', 'Customer not found', 'id');
      res.json({ customer: r.rows[0], updated: true });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // DELETE /api/customers/:id
  app.delete('/api/customers/:id', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const r = await query(`DELETE FROM customers WHERE id=$1 AND pharmacy_id=$2 RETURNING id`, [req.params.id, pharmacyId]);
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND_CUSTOMER', 'Customer not found', 'id');
      res.json({ message: '✅ Customer deleted' });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });
};
