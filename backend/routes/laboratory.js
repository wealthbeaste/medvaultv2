'use strict';
const err = require('./_err');

// ============================================================
// PHASE 4 — Laboratory Module
// Test catalogue, requests from consultations, results entry
// ============================================================

module.exports = function registerLabRoutes(app, { query, pool, auth, can, validate, schemas, audit }) {

  // ═══════════════════════════════════════════════════════════
  // LAB TEST CATALOGUE
  // ═══════════════════════════════════════════════════════════

  app.get('/api/lab/tests', auth, can('lab:read'), async (req, res) => {
    const { orgId } = req.user;
    try {
      const r = await query(`SELECT * FROM lab_tests WHERE org_id=$1 ORDER BY category, name`, [orgId]);
      res.json({ tests: r.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/lab/tests', auth, can('lab:manage'), async (req, res) => {
    const { orgId } = req.user;
    const { name, category, description, normal_range, unit, price, turn_around } = req.body;
    if (!name) return err(res, 400, 'VALIDATION_REQUIRED', 'Test name is required');
    try {
      const r = await query(
        `INSERT INTO lab_tests (org_id,name,category,description,normal_range,unit,price,turn_around)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [orgId, name.trim(), category||'General', description||null, normal_range||null, unit||null, parseFloat(price||0), turn_around||'1 day']
      );
      res.status(201).json({ success:true, message:'✅ Lab test added', test:r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.put('/api/lab/tests/:id', auth, can('lab:manage'), async (req, res) => {
    const { orgId } = req.user;
    const { name, category, description, normal_range, unit, price, turn_around, is_active } = req.body;
    try {
      const r = await query(
        `UPDATE lab_tests SET name=$1,category=$2,description=$3,normal_range=$4,unit=$5,price=$6,turn_around=$7,is_active=$8
         WHERE id=$9 AND org_id=$10 RETURNING *`,
        [name, category, description, normal_range, unit, parseFloat(price||0), turn_around, is_active!==false, req.params.id, orgId]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Test not found');
      res.json({ success:true, test:r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ═══════════════════════════════════════════════════════════
  // LAB REQUESTS
  // ═══════════════════════════════════════════════════════════

  app.get('/api/lab/requests', auth, can('lab:read'), async (req, res) => {
    const { pharmacyId } = req.user;
    const { status } = req.query;
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const offset = (page - 1) * limit;
    try {
      let where = 'WHERE lr.pharmacy_id=$1';
      const params = [pharmacyId];
      if (status) { params.push(status); where += ` AND lr.status=$${params.length}`; }

      const [rows, countRes] = await Promise.all([
        query(`SELECT lr.*, p.name as patient_name, p.patient_number, d.name as doctor_name,
                      json_agg(json_build_object('id',lri.id,'test_name',lri.test_name,'price',lri.price,'status',lri.status)) as items
               FROM lab_requests lr
               LEFT JOIN patients p ON p.id=lr.patient_id LEFT JOIN doctors d ON d.id=lr.doctor_id
               LEFT JOIN lab_request_items lri ON lri.request_id=lr.id
               ${where} GROUP BY lr.id,p.name,p.patient_number,d.name
               ORDER BY lr.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
          [...params, limit, offset]),
        query(`SELECT COUNT(*) as total FROM lab_requests lr ${where}`, params),
      ]);
      const total = parseInt(countRes.rows[0].total);
      res.json({ requests: rows.rows, pagination:{ page, limit, total, pages:Math.ceil(total/limit) } });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/lab/requests', auth, can('lab:request'), async (req, res) => {
    const { orgId, pharmacyId, userId } = req.user;
    const { patient_id, doctor_id, consultation_id, priority, clinical_notes, items } = req.body;
    if (!patient_id) return err(res, 400, 'VALIDATION_REQUIRED', 'patient_id is required');
    if (!Array.isArray(items) || !items.length) return err(res, 400, 'VALIDATION_REQUIRED', 'items array required');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Atomic request number
      const ctr = await client.query(`UPDATE pharmacies SET lab_counter=lab_counter+1 WHERE id=$1 RETURNING lab_counter`, [pharmacyId]);
      const num = ctr.rows.length ? `LAB-${new Date().getFullYear()}-${String(ctr.rows[0].lab_counter).padStart(4,'0')}` : `LAB-${Date.now().toString(36)}`;

      let totalCost = 0;
      for (const it of items) totalCost += parseFloat(it.price || 0);

      const reqRes = await client.query(
        `INSERT INTO lab_requests (org_id,pharmacy_id,patient_id,doctor_id,consultation_id,request_number,priority,clinical_notes,total_cost,requested_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [orgId, pharmacyId, patient_id, doctor_id||null, consultation_id||null, num, priority||'routine', clinical_notes||null, totalCost, userId]
      );
      const labReq = reqRes.rows[0];

      for (const it of items) {
        await client.query(
          `INSERT INTO lab_request_items (request_id,test_id,test_name,price) VALUES ($1,$2,$3,$4)`,
          [labReq.id, it.test_id, it.test_name, parseFloat(it.price||0)]
        );
      }

      await client.query('COMMIT');
      await audit(query, { req, action:'lab.request', entity:'lab_request', entityId:labReq.id, payload:{patient_id, item_count:items.length, total:totalCost} });
      res.status(201).json({ success:true, message:'✅ Lab request created', request:labReq });
    } catch (e) {
      await client.query('ROLLBACK');
      return err(res, 500, 'SERVER_ERROR', e.message);
    } finally { client.release(); }
  });

  // Mark sample collected
  app.patch('/api/lab/requests/:id/collect', auth, can('lab:collect'), async (req, res) => {
    const { pharmacyId, userId } = req.user;
    try {
      const r = await query(
        `UPDATE lab_requests SET status='collected', collected_at=NOW(), collected_by=$1
         WHERE id=$2 AND pharmacy_id=$3 AND status='pending' RETURNING *`,
        [userId, req.params.id, pharmacyId]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Request not found or already collected');
      res.json({ success:true, message:'✅ Sample collected', request:r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ═══════════════════════════════════════════════════════════
  // LAB RESULTS
  // ═══════════════════════════════════════════════════════════

  app.post('/api/lab/results', auth, can('lab:results'), async (req, res) => {
    const { pharmacyId, userId } = req.user;
    const { request_id, results } = req.body; // results: [{request_item_id, test_id, result_value, unit, normal_range, is_abnormal, notes}]
    if (!request_id) return err(res, 400, 'VALIDATION_REQUIRED', 'request_id is required');
    if (!Array.isArray(results) || !results.length) return err(res, 400, 'VALIDATION_REQUIRED', 'results array required');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get request + patient
      const reqCheck = await client.query(`SELECT * FROM lab_requests WHERE id=$1 AND pharmacy_id=$2`, [request_id, pharmacyId]);
      if (!reqCheck.rows.length) { await client.query('ROLLBACK'); return err(res, 404, 'NOT_FOUND', 'Request not found'); }
      const labReq = reqCheck.rows[0];

      for (const r of results) {
        await client.query(
          `INSERT INTO lab_results (request_id,request_item_id,test_id,patient_id,pharmacy_id,result_value,unit,normal_range,is_abnormal,notes,entered_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT DO NOTHING`,
          [request_id, r.request_item_id, r.test_id, labReq.patient_id, pharmacyId,
           r.result_value, r.unit||null, r.normal_range||null, r.is_abnormal||false, r.notes||null, userId]
        );
        // Mark the individual item as completed
        await client.query(`UPDATE lab_request_items SET status='completed' WHERE id=$1`, [r.request_item_id]);
      }

      // Check if all items have results
      const pending = await client.query(`SELECT COUNT(*) as cnt FROM lab_request_items WHERE request_id=$1 AND status!='completed'`, [request_id]);
      const allDone = parseInt(pending.rows[0].cnt) === 0;
      if (allDone) {
        await client.query(`UPDATE lab_requests SET status='completed' WHERE id=$1`, [request_id]);
      } else {
        await client.query(`UPDATE lab_requests SET status='partial' WHERE id=$1`, [request_id]);
      }

      await client.query('COMMIT');
      await audit(query, { req, action:'lab.results', entity:'lab_request', entityId:request_id, payload:{result_count:results.length} });
      res.json({ success:true, message:'✅ Results saved' });
    } catch (e) {
      await client.query('ROLLBACK');
      return err(res, 500, 'SERVER_ERROR', e.message);
    } finally { client.release(); }
  });

  // Get results for a specific request (for printable report)
  app.get('/api/lab/results/:requestId', auth, can('lab:read'), async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const [reqRes, results] = await Promise.all([
        query(`SELECT lr.*, p.name as patient_name, p.patient_number, p.dob, p.gender, d.name as doctor_name
               FROM lab_requests lr LEFT JOIN patients p ON p.id=lr.patient_id LEFT JOIN doctors d ON d.id=lr.doctor_id
               WHERE lr.id=$1 AND lr.pharmacy_id=$2`, [req.params.requestId, pharmacyId]),
        query(`SELECT lr.*, lt.name as test_name, lt.category as test_category
               FROM lab_results lr LEFT JOIN lab_tests lt ON lt.id=lr.test_id
               WHERE lr.request_id=$1 ORDER BY lt.category, lt.name`, [req.params.requestId]),
      ]);
      if (!reqRes.rows.length) return err(res, 404, 'NOT_FOUND', 'Request not found');
      res.json({ request: reqRes.rows[0], results: results.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // Patient lab history
  app.get('/api/lab/patient/:patientId/history', auth, can('lab:read'), async (req, res) => {
    const { orgId } = req.user;
    try {
      const r = await query(
        `SELECT lr.*, json_agg(json_build_object('test_name',lri.test_name,'status',lri.status)) as items
         FROM lab_requests lr LEFT JOIN lab_request_items lri ON lri.request_id=lr.id
         LEFT JOIN patients p ON p.id=lr.patient_id
         WHERE lr.patient_id=$1 AND p.org_id=$2
         GROUP BY lr.id ORDER BY lr.created_at DESC LIMIT 50`,
        [req.params.patientId, orgId]
      );
      res.json({ history: r.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // Lab stats
  app.get('/api/lab/stats', auth, can('lab:read'), async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const [total, pending, today, revenue] = await Promise.all([
        query(`SELECT COUNT(*) as cnt FROM lab_requests WHERE pharmacy_id=$1`, [pharmacyId]),
        query(`SELECT COUNT(*) as cnt FROM lab_requests WHERE pharmacy_id=$1 AND status IN ('pending','collected')`, [pharmacyId]),
        query(`SELECT COUNT(*) as cnt FROM lab_requests WHERE pharmacy_id=$1 AND DATE(created_at)=CURRENT_DATE`, [pharmacyId]),
        query(`SELECT COALESCE(SUM(total_cost),0) as total FROM lab_requests WHERE pharmacy_id=$1 AND DATE(created_at)=CURRENT_DATE`, [pharmacyId]),
      ]);
      res.json({
        total_requests: parseInt(total.rows[0].cnt),
        pending_requests: parseInt(pending.rows[0].cnt),
        today_requests: parseInt(today.rows[0].cnt),
        today_revenue: parseFloat(revenue.rows[0].total),
      });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // Verify results (second-user verification)
  app.patch('/api/lab/results/:id/verify', auth, can('lab:results'), async (req, res) => {
    const { userId } = req.user;
    try {
      const r = await query(
        `UPDATE lab_results SET verified_by=$1, verified_at=NOW() WHERE id=$2 AND verified_by IS NULL RETURNING *`,
        [userId, req.params.id]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Result not found or already verified');
      await audit(query, { req, action:'lab.verify', entity:'lab_result', entityId:req.params.id, payload:null });
      res.json({ success:true, message:'✅ Result verified', result:r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });
};
