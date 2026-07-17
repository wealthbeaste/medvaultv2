'use strict';
const err = require('./_err');
const crypto = require('crypto');

// ============================================================
// PHASE 6 — Enterprise Ecosystem
// API keys, Regional dashboard, AI forecasting, Webhooks
// ============================================================

module.exports = function registerEnterpriseRoutes(app, { query, pool, auth, can, audit }) {

  // ═══════════════════════════════════════════════════════════
  // API KEYS — for external integrations
  // ═══════════════════════════════════════════════════════════

  app.get('/api/enterprise/api-keys', auth, can('enterprise:manage'), async (req, res) => {
    const { orgId } = req.user;
    try {
      const r = await query(
        `SELECT id, name, key_prefix, permissions, is_active, last_used, expires_at, created_at
         FROM api_keys WHERE org_id=$1 ORDER BY created_at DESC`, [orgId]
      );
      res.json({ api_keys: r.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/enterprise/api-keys', auth, can('enterprise:manage'), async (req, res) => {
    const { orgId, userId } = req.user;
    const { name, permissions, expires_in_days } = req.body;
    if (!name) return err(res, 400, 'VALIDATION_REQUIRED', 'Key name required');
    try {
      // Generate a secure API key
      const rawKey = `mv_${crypto.randomBytes(32).toString('hex')}`;
      const prefix = rawKey.substring(0, 10);
      const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
      const expiresAt = expires_in_days ? new Date(Date.now() + expires_in_days * 86400000).toISOString() : null;

      const r = await query(
        `INSERT INTO api_keys (org_id, name, key_hash, key_prefix, permissions, expires_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, key_prefix, permissions, is_active, expires_at, created_at`,
        [orgId, name, keyHash, prefix, JSON.stringify(permissions || ['read']), expiresAt, userId]
      );
      await audit(query, { req, action:'api_key.create', entity:'api_key', entityId:r.rows[0].id, payload:{name} });
      // Return the raw key ONCE — it cannot be retrieved again
      res.status(201).json({ success:true, message:'✅ API key created. Copy it now — it will not be shown again.', api_key:r.rows[0], raw_key: rawKey });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.patch('/api/enterprise/api-keys/:id/revoke', auth, can('enterprise:manage'), async (req, res) => {
    const { orgId } = req.user;
    try {
      const r = await query(`UPDATE api_keys SET is_active=false WHERE id=$1 AND org_id=$2 RETURNING id,name`, [req.params.id, orgId]);
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Key not found');
      await audit(query, { req, action:'api_key.revoke', entity:'api_key', entityId:req.params.id, payload:null });
      res.json({ success:true, message:'✅ API key revoked' });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ═══════════════════════════════════════════════════════════
  // REGIONAL DASHBOARD — cross-org analytics for chain owners
  // ═══════════════════════════════════════════════════════════

  app.get('/api/enterprise/regional', auth, can('enterprise:regional'), async (req, res) => {
    const { orgId } = req.user;
    try {
      // Get all pharmacies in this org
      const pharmacies = await query(
        `SELECT p.id, p.name, p.address, p.is_head_office FROM pharmacies p WHERE p.organisation_id=$1 AND p.is_active=true ORDER BY p.is_head_office DESC, p.name`, [orgId]
      );

      // Stats per pharmacy
      const stats = [];
      for (const ph of pharmacies.rows) {
        const [rev, stock, staff] = await Promise.all([
          query(`SELECT COALESCE(SUM(total_amount),0) as today,
                        (SELECT COALESCE(SUM(total_amount),0) FROM sales WHERE pharmacy_id=$1 AND created_at >= NOW()-INTERVAL '30 days') as month
                 FROM sales WHERE pharmacy_id=$1 AND DATE(created_at)=CURRENT_DATE`, [ph.id]),
          query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE quantity<=threshold) as low_stock FROM drugs WHERE pharmacy_id=$1`, [ph.id]),
          query(`SELECT COUNT(*) as cnt FROM users WHERE pharmacy_id=$1 AND is_active=true`, [ph.id]),
        ]);
        stats.push({
          pharmacy: ph,
          revenue_today: parseFloat(rev.rows[0].today),
          revenue_month: parseFloat(rev.rows[0].month),
          drug_count: parseInt(stock.rows[0].total),
          low_stock_count: parseInt(stock.rows[0].low_stock),
          staff_count: parseInt(staff.rows[0].cnt),
        });
      }

      // Org-level totals
      const [orgRev, orgDrugs] = await Promise.all([
        query(`SELECT COALESCE(SUM(s.total_amount),0) as today
               FROM sales s JOIN pharmacies p ON p.id=s.pharmacy_id
               WHERE p.organisation_id=$1 AND DATE(s.created_at)=CURRENT_DATE`, [orgId]),
        query(`SELECT COUNT(*) as total FROM drugs d JOIN pharmacies p ON p.id=d.pharmacy_id WHERE p.organisation_id=$1`, [orgId]),
      ]);

      res.json({
        org_revenue_today: parseFloat(orgRev.rows[0].today),
        org_total_drugs: parseInt(orgDrugs.rows[0].total),
        branch_count: pharmacies.rows.length,
        branches: stats,
      });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ═══════════════════════════════════════════════════════════
  // AI DEMAND FORECASTING
  // ═══════════════════════════════════════════════════════════

  app.post('/api/enterprise/forecast', auth, can('reports:forecast'), async (req, res) => {
    const { pharmacyId, orgId } = req.user;
    const { drug_id, period_days } = req.body;
    const days = parseInt(period_days || 30);
    try {
      // Get historical sales data for the drug
      let salesData;
      if (drug_id) {
        salesData = await query(
          `SELECT DATE(s.created_at) as sale_date, SUM(si.quantity) as qty_sold
           FROM sale_items si JOIN sales s ON s.id=si.sale_id
           WHERE si.drug_id=$1 AND s.pharmacy_id=$2 AND s.created_at >= NOW()-INTERVAL '90 days'
           GROUP BY DATE(s.created_at) ORDER BY sale_date`, [drug_id, pharmacyId]
        );
      } else {
        salesData = await query(
          `SELECT DATE(s.created_at) as sale_date, COALESCE(SUM(s.total_amount),0) as revenue, COUNT(*) as tx_count
           FROM sales s WHERE s.pharmacy_id=$1 AND s.created_at >= NOW()-INTERVAL '90 days'
           GROUP BY DATE(s.created_at) ORDER BY sale_date`, [pharmacyId]
        );
      }

      // Simple moving average forecast (no external AI dependency)
      const data = salesData.rows;
      const values = data.map(d => parseFloat(drug_id ? d.qty_sold : d.revenue));
      const avg = values.length ? values.reduce((a,b)=>a+b,0) / values.length : 0;
      const trend = values.length >= 7 ?
        (values.slice(-7).reduce((a,b)=>a+b,0)/7) - (values.slice(0,7).reduce((a,b)=>a+b,0)/7) : 0;

      const forecast = [];
      for (let d = 1; d <= days; d++) {
        const predicted = Math.max(0, avg + (trend * d / values.length));
        const date = new Date(Date.now() + d * 86400000).toISOString().slice(0,10);
        forecast.push({ date, predicted: Math.round(predicted * 100) / 100 });
      }

      // Log prediction
      await query(
        `INSERT INTO ai_predictions (org_id,pharmacy_id,prediction_type,input_data,output_data)
         VALUES ($1,$2,$3,$4,$5)`,
        [orgId, pharmacyId, drug_id ? 'drug_demand' : 'revenue', JSON.stringify({drug_id,period_days:days,data_points:data.length}), JSON.stringify({avg,trend,forecast_days:days})]
      );

      res.json({
        success: true,
        historical: data,
        forecast,
        summary: {
          avg_daily: Math.round(avg * 100) / 100,
          trend: trend > 0 ? 'increasing' : trend < 0 ? 'decreasing' : 'stable',
          confidence: data.length >= 30 ? 'high' : data.length >= 14 ? 'medium' : 'low',
          data_points: data.length,
        },
      });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ═══════════════════════════════════════════════════════════
  // WEBHOOKS
  // ═══════════════════════════════════════════════════════════

  app.get('/api/enterprise/webhooks', auth, can('enterprise:manage'), async (req, res) => {
    const { orgId } = req.user;
    try {
      const r = await query(`SELECT * FROM webhook_configs WHERE org_id=$1 ORDER BY created_at DESC`, [orgId]);
      res.json({ webhooks: r.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/enterprise/webhooks', auth, can('enterprise:manage'), async (req, res) => {
    const { orgId } = req.user;
    const { url, events } = req.body;
    if (!url) return err(res, 400, 'VALIDATION_REQUIRED', 'Webhook URL required');
    try {
      const secret = crypto.randomBytes(32).toString('hex');
      const r = await query(
        `INSERT INTO webhook_configs (org_id,url,events,secret) VALUES ($1,$2,$3,$4) RETURNING *`,
        [orgId, url, JSON.stringify(events||['sale.create','drug.low_stock']), secret]
      );
      res.status(201).json({ success:true, message:'✅ Webhook registered', webhook:r.rows[0], signing_secret:secret });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.delete('/api/enterprise/webhooks/:id', auth, can('enterprise:manage'), async (req, res) => {
    const { orgId } = req.user;
    try {
      const r = await query(`DELETE FROM webhook_configs WHERE id=$1 AND org_id=$2 RETURNING id`, [req.params.id, orgId]);
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Webhook not found');
      res.json({ success:true, message:'✅ Webhook deleted' });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });
};
