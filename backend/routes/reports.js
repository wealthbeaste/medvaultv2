'use strict';
const err = require('./_err');

module.exports = function registerReportsRoutes(app, { query, auth, can }) {

  // GET /api/dashboard
  app.get('/api/dashboard', auth, can('dashboard:view'), async (req, res) => {
    const { pharmacyId } = req.user;
    if (!pharmacyId) return err(res, 400, 'AUTH_NO_PHARMACY', 'No pharmacy assigned. Ask your owner to reassign you.', 'pharmacyId');
    try {
      const [rev, tx, low, exp, week, recent] = await Promise.all([
        query(`SELECT COALESCE(SUM(total_amount),0) as rev FROM sales WHERE pharmacy_id=$1 AND DATE(created_at)=CURRENT_DATE`, [pharmacyId]),
        query(`SELECT COUNT(*) as cnt FROM sales WHERE pharmacy_id=$1 AND DATE(created_at)=CURRENT_DATE`, [pharmacyId]),
        query(`SELECT COUNT(*) as cnt FROM drugs WHERE pharmacy_id=$1 AND quantity<=threshold`, [pharmacyId]),
        query(`SELECT COUNT(*) as cnt FROM drugs WHERE pharmacy_id=$1 AND expiry_date IS NOT NULL AND expiry_date<=CURRENT_DATE+INTERVAL '30 days' AND expiry_date>=CURRENT_DATE`, [pharmacyId]),
        query(`SELECT DATE(created_at) as day,COALESCE(SUM(total_amount),0) as revenue FROM sales WHERE pharmacy_id=$1 AND created_at>=CURRENT_DATE-INTERVAL '6 days' GROUP BY DATE(created_at) ORDER BY day`, [pharmacyId]),
        query(`SELECT id,customer_name,total_amount,payment_method,created_at FROM sales WHERE pharmacy_id=$1 ORDER BY created_at DESC LIMIT 5`, [pharmacyId]),
      ]);
      res.json({
        revenueToday:       parseFloat(rev.rows[0].rev),
        transactionsToday:  parseInt(tx.rows[0].cnt),
        lowStockCount:      parseInt(low.rows[0].cnt),
        expiringCount:      parseInt(exp.rows[0].cnt),
        weeklyRevenue:      week.rows,
        recentSales:        recent.rows,
      });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // GET /api/variance/daily
  app.get('/api/variance/daily', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const date = req.query.date || new Date().toISOString().split('T')[0];
    try {
      const sold = await query(
        `SELECT si.drug_id,si.drug_name,SUM(si.quantity) as units_sold FROM sale_items si
         JOIN sales s ON s.id=si.sale_id
         WHERE s.pharmacy_id=$1 AND DATE(s.created_at)=$2 AND si.drug_id IS NOT NULL
         GROUP BY si.drug_id,si.drug_name`,
        [pharmacyId, date]
      );
      const variances = [];
      for (const row of sold.rows) {
        const drug = await query(`SELECT name,quantity FROM drugs WHERE id=$1`, [row.drug_id]);
        if (drug.rows.length) variances.push({ drug_id: row.drug_id, drug_name: row.drug_name, units_sold: parseInt(row.units_sold), current_qty: drug.rows[0].quantity, status: parseInt(row.units_sold) > 50 ? 'review' : 'ok' });
      }
      res.json({ date, variances, total: variances.length });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // POST /api/variance/stockcount
  app.post('/api/variance/stockcount', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const { counts } = req.body;
    if (!counts?.length) return err(res, 400, 'VALIDATION_REQUIRED', 'counts array is required', 'counts');
    try {
      const variances = [];
      for (const c of counts) {
        const drug = await query(`SELECT id,name,quantity FROM drugs WHERE id=$1 AND pharmacy_id=$2`, [c.drug_id, pharmacyId]);
        if (!drug.rows.length) continue;
        const d    = drug.rows[0];
        const diff = d.quantity - parseInt(c.counted_qty);
        if (Math.abs(diff) > 0) {
          variances.push({ drug_id: d.id, drug_name: d.name, system_qty: d.quantity, counted_qty: parseInt(c.counted_qty), variance: diff, flag: diff > 0 ? 'shortage' : 'surplus' });
          await query(`UPDATE drugs SET quantity=$1,updated_at=NOW() WHERE id=$2`, [parseInt(c.counted_qty), d.id]);
        }
      }
      res.json({ message: `Count complete. ${variances.length} variances found.`, variances });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // GET /api/nda/report
  app.get('/api/nda/report', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const from = req.query.from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const to   = req.query.to   || new Date().toISOString().split('T')[0];
    try {
      const [pharma, rxSales, stock, expiring] = await Promise.all([
        query(`SELECT p.*,o.name as org_name FROM pharmacies p JOIN organisations o ON o.id=p.organisation_id WHERE p.id=$1`, [pharmacyId]),
        query(`SELECT s.created_at,s.receipt_number,s.customer_name,si.drug_name,si.quantity,si.unit_price,d.requires_rx,d.category FROM sales s JOIN sale_items si ON si.sale_id=s.id LEFT JOIN drugs d ON d.id=si.drug_id WHERE s.pharmacy_id=$1 AND DATE(s.created_at) BETWEEN $2 AND $3 AND (d.requires_rx=true OR d.category IN ('Antibiotics','Antimalarials')) ORDER BY s.created_at DESC`, [pharmacyId, from, to]),
        query(`SELECT name,generic_name,category,quantity,expiry_date,supplier,requires_rx,unit_price,threshold FROM drugs WHERE pharmacy_id=$1 ORDER BY category,name`, [pharmacyId]),
        query(`SELECT name,quantity,expiry_date,(expiry_date-CURRENT_DATE)::int as days_left FROM drugs WHERE pharmacy_id=$1 AND expiry_date IS NOT NULL AND expiry_date<=CURRENT_DATE+INTERVAL '60 days' ORDER BY expiry_date`, [pharmacyId]),
      ]);
      res.json({ pharmacy: pharma.rows[0], period: { from, to }, classified_sales: rxSales.rows, current_stock: stock.rows, expiring_stock: expiring.rows });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // GET /api/expiry/intelligence
  app.get('/api/expiry/intelligence', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const velocity = await query(
        `SELECT si.drug_id,ROUND(SUM(si.quantity)::numeric/GREATEST(COUNT(DISTINCT DATE(s.created_at)),1)*7,1) as weekly_velocity
         FROM sale_items si JOIN sales s ON s.id=si.sale_id
         WHERE s.pharmacy_id=$1 AND s.created_at>=NOW()-INTERVAL '60 days' AND si.drug_id IS NOT NULL
         GROUP BY si.drug_id`,
        [pharmacyId]
      );
      const expiring = await query(
        `SELECT id,name,quantity,expiry_date,unit_price,supplier,(expiry_date-CURRENT_DATE)::int as days_left
         FROM drugs WHERE pharmacy_id=$1 AND expiry_date IS NOT NULL AND expiry_date>CURRENT_DATE AND expiry_date<=CURRENT_DATE+INTERVAL '90 days' ORDER BY expiry_date`,
        [pharmacyId]
      );
      const velMap = {};
      for (const v of velocity.rows) velMap[v.drug_id] = parseFloat(v.weekly_velocity);
      const recommendations = expiring.rows.map(d => {
        const weeksLeft = Math.floor(d.days_left / 7);
        const vel       = velMap[d.id] || 0;
        const canSell   = Math.round(weeksLeft * vel);
        const surplus   = Math.max(0, d.quantity - canSell);
        let action = 'monitor', suggested_price = d.unit_price;
        if (surplus > 0 && d.days_left <= 30)       { action = 'discount_now';      suggested_price = Math.round(d.unit_price * 0.65); }
        else if (surplus > 0 && d.days_left <= 60)  { action = 'consider_discount'; suggested_price = Math.round(d.unit_price * 0.80); }
        else if (surplus > 10 && d.days_left <= 90)   action = 'return_to_supplier';
        return { ...d, weekly_velocity: vel, units_sellable: canSell, surplus_units: surplus, action, suggested_price };
      });
      res.json({ recommendations, total: recommendations.length });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // GET /api/forecast
  app.get('/api/forecast', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const month = new Date().getMonth() + 1;
      const upcomingSeason =
        month >= 1 && month <= 2  ? { name: 'Long Rains',  start: 'March',   weeks: Math.round((new Date(new Date().getFullYear(), 2, 1) - new Date()) / 604800000) } :
        month >= 3 && month <= 5  ? { name: 'Long Rains',  start: 'ongoing', weeks: 0 } :
        month >= 7 && month <= 9  ? { name: 'Short Rains', start: 'October', weeks: Math.round((new Date(new Date().getFullYear(), 9, 1) - new Date()) / 604800000) } :
        month >= 10               ? { name: 'Short Rains', start: 'ongoing', weeks: 0 } : null;
      const [history, stock] = await Promise.all([
        query(`SELECT si.drug_name,EXTRACT(MONTH FROM s.created_at) as month,SUM(si.quantity) as units_sold FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.pharmacy_id=$1 AND s.created_at>=NOW()-INTERVAL '12 months' GROUP BY si.drug_name,EXTRACT(MONTH FROM s.created_at)`, [pharmacyId]),
        query(`SELECT id,name,quantity,threshold FROM drugs WHERE pharmacy_id=$1 ORDER BY name`, [pharmacyId]),
      ]);
      const drugMap = {};
      for (const row of history.rows) { if (!drugMap[row.drug_name]) drugMap[row.drug_name] = {}; drugMap[row.drug_name][row.month] = parseInt(row.units_sold); }
      const forecasts = stock.rows.map(d => {
        const hist       = drugMap[d.name] || {};
        const vals       = Object.values(hist);
        const avgMonthly = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
        const isSeasonal = ['coartem', 'lumartem', 'artemether', 'malaria', 'act'].some(s => d.name.toLowerCase().includes(s));
        const multiplier = isSeasonal && upcomingSeason ? 1.8 : 1.0;
        const forecastNext = Math.round(avgMonthly * multiplier);
        const reorderQty   = Math.max(0, forecastNext - d.quantity);
        return { drug_id: d.id, drug_name: d.name, current_stock: d.quantity, avg_monthly_sales: Math.round(avgMonthly), forecast_next_month: forecastNext, reorder_qty: reorderQty, is_seasonal: isSeasonal, urgency: reorderQty > 0 ? (d.quantity < d.threshold ? 'urgent' : 'recommended') : 'ok' };
      });
      res.json({ season: upcomingSeason, forecasts: forecasts.filter(f => f.avg_monthly_sales > 0 || f.current_stock > 0) });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // GET /api/tax/summary
  app.get('/api/tax/summary', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const m = parseInt(req.query.month) || new Date().getMonth() + 1;
    const y = parseInt(req.query.year)  || new Date().getFullYear();
    try {
      const [pharma, sales, daily, drugs] = await Promise.all([
        query(`SELECT p.*,o.name as org_name FROM pharmacies p JOIN organisations o ON o.id=p.organisation_id WHERE p.id=$1`, [pharmacyId]),
        query(`SELECT COUNT(*) as transaction_count,COALESCE(SUM(total_amount),0) as gross_revenue,COALESCE(SUM(discount_amount),0) as total_discounts,COALESCE(SUM(total_amount-discount_amount),0) as net_revenue,SUM(CASE WHEN payment_method='momo' THEN total_amount ELSE 0 END) as momo_revenue,SUM(CASE WHEN payment_method='cash' THEN total_amount ELSE 0 END) as cash_revenue FROM sales WHERE pharmacy_id=$1 AND EXTRACT(MONTH FROM created_at)=$2 AND EXTRACT(YEAR FROM created_at)=$3`, [pharmacyId, m, y]),
        query(`SELECT DATE(created_at) as day,SUM(total_amount) as revenue,COUNT(*) as txns FROM sales WHERE pharmacy_id=$1 AND EXTRACT(MONTH FROM created_at)=$2 AND EXTRACT(YEAR FROM created_at)=$3 GROUP BY DATE(created_at) ORDER BY day`, [pharmacyId, m, y]),
        query(`SELECT si.drug_name,SUM(si.quantity) as units,SUM(si.total_price) as revenue FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.pharmacy_id=$1 AND EXTRACT(MONTH FROM s.created_at)=$2 AND EXTRACT(YEAR FROM s.created_at)=$3 GROUP BY si.drug_name ORDER BY revenue DESC LIMIT 10`, [pharmacyId, m, y]),
      ]);
      const gross     = parseFloat(sales.rows[0].gross_revenue);
      const annualEst = gross * 12;
      const tax       = annualEst >= 10000000 ? Math.round(gross * 0.01) : 0;
      res.json({ pharmacy: pharma.rows[0], period: { month: m, year: y }, summary: sales.rows[0], daily_breakdown: daily.rows, top_drugs: drugs.rows, tax_estimate: { gross_revenue: gross, annual_estimate: annualEst, presumptive_rate: '1%', estimated_tax_ugx: tax, note: 'Consult your accountant. Based on URA presumptive tax regime.' } });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // GET /api/reports/daily-summary
  app.get('/api/reports/daily-summary', auth, can('reports:nda'), async (req, res) => {
    const { pharmacyId } = req.user;
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    try {
      const [salesRes, topDrugsRes, paymentRes, staffRes, lowStockRes, expRes] = await Promise.all([
        query(`SELECT COUNT(*) AS sale_count,COALESCE(SUM(total_amount),0) AS revenue,COALESCE(SUM(discount_amount),0) AS total_discounts,COALESCE(AVG(total_amount),0) AS avg_basket FROM sales WHERE pharmacy_id=$1 AND DATE(created_at)=$2`, [pharmacyId, date]),
        query(`SELECT si.drug_name,SUM(si.quantity) AS units_sold,SUM(si.total_price) AS revenue FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.pharmacy_id=$1 AND DATE(s.created_at)=$2 GROUP BY si.drug_name ORDER BY revenue DESC LIMIT 5`, [pharmacyId, date]),
        query(`SELECT payment_method,COUNT(*) AS count,COALESCE(SUM(total_amount),0) AS total FROM sales WHERE pharmacy_id=$1 AND DATE(created_at)=$2 GROUP BY payment_method`, [pharmacyId, date]),
        query(`SELECT u.name AS staff_name,COUNT(s.id) AS sales,COALESCE(SUM(s.total_amount),0) AS revenue FROM sales s LEFT JOIN users u ON u.id=s.user_id WHERE s.pharmacy_id=$1 AND DATE(s.created_at)=$2 GROUP BY u.name ORDER BY revenue DESC`, [pharmacyId, date]),
        query(`SELECT COUNT(*) AS cnt FROM drugs WHERE pharmacy_id=$1 AND quantity<=threshold`, [pharmacyId]),
        query(`SELECT COUNT(*) AS cnt FROM drugs WHERE pharmacy_id=$1 AND expiry_date IS NOT NULL AND expiry_date<=CURRENT_DATE+INTERVAL '30 days' AND quantity>0`, [pharmacyId]),
      ]);

      // Fire-and-forget snapshot for today only
      if (date === new Date().toISOString().slice(0, 10)) {
        const s = salesRes.rows[0];
        query(
          `INSERT INTO daily_revenue_snapshots (pharmacy_id,snapshot_date,total_sales,sale_count)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (pharmacy_id,snapshot_date)
           DO UPDATE SET total_sales=EXCLUDED.total_sales,sale_count=EXCLUDED.sale_count`,
          [pharmacyId, date, s.revenue, s.sale_count]
        ).catch(() => {});
      }

      res.json({
        date,
        summary:         salesRes.rows[0],
        top_drugs:       topDrugsRes.rows,
        payment_methods: paymentRes.rows,
        staff_breakdown: staffRes.rows,
        alerts: {
          low_stock_count: parseInt(lowStockRes.rows[0].cnt),
          expiring_count:  parseInt(expRes.rows[0].cnt),
        },
      });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });
  // ── GROSS MARGIN REPORT ─────────────────────────────────────
  // GET /api/reports/margins?from=&to=&category=
  app.get('/api/reports/margins', auth, can('reports:financial'), async (req, res) => {
    const { pharmacyId } = req.user;
    const from     = req.query.from || new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
    const to       = req.query.to   || new Date().toISOString().slice(0,10);
    const category = req.query.category || null;

    try {
      const params = [pharmacyId, from, to];
      const catFilter = category ? ` AND d.category = $${params.push(category)}` : '';

      const [byDrug, byCat, summary] = await Promise.all([

        // Per-drug margin
        query(
          `SELECT
             si.drug_name,
             d.category,
             COALESCE(d.cost_price, 0)              AS cost_price,
             ROUND(AVG(si.unit_price)::numeric, 2)  AS avg_sell_price,
             SUM(si.quantity)                        AS units_sold,
             SUM(si.total_price)                     AS revenue,
             COALESCE(SUM(si.quantity * d.cost_price), 0) AS cogs,
             ROUND(
               CASE WHEN SUM(si.total_price) > 0
               THEN (SUM(si.total_price) - COALESCE(SUM(si.quantity * d.cost_price),0))
                    / SUM(si.total_price) * 100
               ELSE 0 END::numeric, 2
             ) AS margin_pct
           FROM sale_items si
           JOIN sales s ON s.id = si.sale_id
           LEFT JOIN drugs d ON d.id = si.drug_id
           WHERE s.pharmacy_id=$1
             AND DATE(s.created_at) BETWEEN $2 AND $3
             ${catFilter}
           GROUP BY si.drug_name, d.category, d.cost_price
           ORDER BY revenue DESC
           LIMIT 50`,
          params
        ),

        // Per-category margin
        query(
          `SELECT
             COALESCE(d.category,'Uncategorised') AS category,
             SUM(si.total_price)                   AS revenue,
             COALESCE(SUM(si.quantity * d.cost_price), 0) AS cogs,
             ROUND(
               CASE WHEN SUM(si.total_price) > 0
               THEN (SUM(si.total_price) - COALESCE(SUM(si.quantity*d.cost_price),0))
                    / SUM(si.total_price) * 100
               ELSE 0 END::numeric, 2
             ) AS margin_pct
           FROM sale_items si
           JOIN sales s ON s.id = si.sale_id
           LEFT JOIN drugs d ON d.id = si.drug_id
           WHERE s.pharmacy_id=$1 AND DATE(s.created_at) BETWEEN $2 AND $3
           GROUP BY d.category
           ORDER BY revenue DESC`,
          [pharmacyId, from, to]
        ),

        // Overall summary
        query(
          `SELECT
             SUM(si.total_price)                         AS total_revenue,
             COALESCE(SUM(si.quantity * d.cost_price),0) AS total_cogs,
             SUM(si.total_price)
               - COALESCE(SUM(si.quantity * d.cost_price),0) AS gross_profit,
             ROUND(
               CASE WHEN SUM(si.total_price)>0
               THEN (SUM(si.total_price) - COALESCE(SUM(si.quantity*d.cost_price),0))
                    / SUM(si.total_price) * 100
               ELSE 0 END::numeric, 2
             ) AS overall_margin_pct
           FROM sale_items si
           JOIN sales s ON s.id = si.sale_id
           LEFT JOIN drugs d ON d.id = si.drug_id
           WHERE s.pharmacy_id=$1 AND DATE(s.created_at) BETWEEN $2 AND $3`,
          [pharmacyId, from, to]
        ),
      ]);

      res.json({
        period: { from, to },
        summary:     summary.rows[0],
        by_drug:     byDrug.rows,
        by_category: byCat.rows,
      });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ── PURCHASING / SUPPLIER SPEND REPORT ──────────────────────
  // GET /api/reports/purchasing?from=&to=
  app.get('/api/reports/purchasing', auth, can('reports:nda'), async (req, res) => {
    const { pharmacyId } = req.user;
    const from = req.query.from || new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
    const to   = req.query.to   || new Date().toISOString().slice(0,10);

    try {
      const [spendBySup, poTurnaround, topItems, poStatusSummary] = await Promise.all([

        // Spend per supplier (from GRNs)
        query(
          `SELECT
             s.name           AS supplier_name,
             COUNT(g.id)      AS grn_count,
             SUM(g.total_cost) AS total_spend,
             MAX(g.received_at) AS last_delivery
           FROM grn g
           JOIN suppliers s ON s.id = g.supplier_id
           WHERE g.pharmacy_id=$1 AND DATE(g.received_at) BETWEEN $2 AND $3
           GROUP BY s.name ORDER BY total_spend DESC`,
          [pharmacyId, from, to]
        ),

        // Average PO turnaround days (submitted → received)
        query(
          `SELECT
             s.name                                        AS supplier_name,
             COUNT(po.id)                                  AS po_count,
             ROUND(AVG(
               EXTRACT(EPOCH FROM (
                 (SELECT MIN(g2.received_at) FROM grn g2 WHERE g2.po_id=po.id)
                 - po.ordered_at
               ))/86400
             )::numeric, 1)                                AS avg_turnaround_days
           FROM purchase_orders po
           JOIN suppliers s ON s.id = po.supplier_id
           WHERE po.pharmacy_id=$1
             AND po.status IN ('received','partial')
             AND po.ordered_at IS NOT NULL
             AND DATE(po.created_at) BETWEEN $2 AND $3
           GROUP BY s.name ORDER BY po_count DESC`,
          [pharmacyId, from, to]
        ),

        // Top purchased items by quantity
        query(
          `SELECT
             gi.drug_name,
             SUM(gi.quantity)     AS total_qty_received,
             SUM(gi.total_cost)   AS total_spend,
             COUNT(DISTINCT g.id) AS grn_appearances
           FROM grn_items gi
           JOIN grn g ON g.id = gi.grn_id
           WHERE g.pharmacy_id=$1 AND DATE(g.received_at) BETWEEN $2 AND $3
           GROUP BY gi.drug_name
           ORDER BY total_spend DESC
           LIMIT 20`,
          [pharmacyId, from, to]
        ),

        // PO status breakdown
        query(
          `SELECT status, COUNT(*) AS count, COALESCE(SUM(total_cost),0) AS total_value
           FROM purchase_orders
           WHERE pharmacy_id=$1 AND DATE(created_at) BETWEEN $2 AND $3
           GROUP BY status`,
          [pharmacyId, from, to]
        ),
      ]);

      res.json({
        period: { from, to },
        spend_by_supplier: spendBySup.rows,
        po_turnaround:     poTurnaround.rows,
        top_items:         topItems.rows,
        po_status_summary: poStatusSummary.rows,
      });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

};