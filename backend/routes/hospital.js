'use strict';
const err = require('./_err');

// ============================================================
// PHASE 5 — Hospital ERP Module
// Departments, Wards, Beds, Admissions, Inpatient Charges, Insurance
// ============================================================

module.exports = function registerHospitalRoutes(app, { query, pool, auth, can, validate, audit }) {

  // ═══════════════════════════════════════════════════════════
  // DEPARTMENTS
  // ═══════════════════════════════════════════════════════════

  app.get('/api/hospital/departments', auth, can('hospital:read'), async (req, res) => {
    const { orgId } = req.user;
    try {
      const r = await query(`SELECT d.*, u.name as head_name FROM departments d LEFT JOIN users u ON u.id=d.head_id WHERE d.org_id=$1 ORDER BY d.name`, [orgId]);
      res.json({ departments: r.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/hospital/departments', auth, can('hospital:manage'), async (req, res) => {
    const { orgId } = req.user;
    const { name, code, head_id } = req.body;
    if (!name) return err(res, 400, 'VALIDATION_REQUIRED', 'Department name required');
    try {
      const r = await query(`INSERT INTO departments (org_id,name,code,head_id) VALUES ($1,$2,$3,$4) RETURNING *`, [orgId, name.trim(), code||null, head_id||null]);
      res.status(201).json({ success:true, message:'✅ Department created', department:r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ═══════════════════════════════════════════════════════════
  // WARDS & BEDS
  // ═══════════════════════════════════════════════════════════

  app.get('/api/hospital/wards', auth, can('hospital:read'), async (req, res) => {
    const { orgId } = req.user;
    try {
      const r = await query(
        `SELECT w.*, dep.name as department_name,
                COUNT(b.id) FILTER (WHERE b.status='available') as available_beds,
                COUNT(b.id) FILTER (WHERE b.status='occupied') as occupied_beds,
                COUNT(b.id) as total_beds_actual
         FROM wards w
         LEFT JOIN departments dep ON dep.id=w.department_id
         LEFT JOIN beds b ON b.ward_id=w.id
         WHERE w.org_id=$1 GROUP BY w.id, dep.name ORDER BY w.name`,
        [orgId]
      );
      res.json({ wards: r.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/hospital/wards', auth, can('hospital:manage'), async (req, res) => {
    const { orgId, pharmacyId } = req.user;
    const { name, ward_type, department_id, total_beds } = req.body;
    if (!name) return err(res, 400, 'VALIDATION_REQUIRED', 'Ward name required');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const w = await client.query(
        `INSERT INTO wards (org_id,pharmacy_id,department_id,name,ward_type,total_beds) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [orgId, pharmacyId, department_id||null, name.trim(), ward_type||'general', parseInt(total_beds||0)]
      );
      const ward = w.rows[0];
      // Auto-create beds
      const bedCount = parseInt(total_beds || 0);
      for (let n = 1; n <= bedCount; n++) {
        await client.query(
          `INSERT INTO beds (ward_id,bed_number,bed_type,status) VALUES ($1,$2,'standard','available')`,
          [ward.id, `${name.trim().substring(0,3).toUpperCase()}-${String(n).padStart(2,'0')}`]
        );
      }
      await client.query('COMMIT');
      res.status(201).json({ success:true, message:`✅ Ward "${name}" created with ${bedCount} beds`, ward });
    } catch (e) {
      await client.query('ROLLBACK');
      return err(res, 500, 'SERVER_ERROR', e.message);
    } finally { client.release(); }
  });

  app.get('/api/hospital/beds', auth, can('hospital:read'), async (req, res) => {
    const { orgId } = req.user;
    const { ward_id, status } = req.query;
    try {
      let sql = `SELECT b.*, w.name as ward_name FROM beds b JOIN wards w ON w.id=b.ward_id WHERE w.org_id=$1`;
      const params = [orgId]; let i=2;
      if (ward_id) { sql += ` AND b.ward_id=$${i++}`; params.push(ward_id); }
      if (status)  { sql += ` AND b.status=$${i++}`; params.push(status); }
      sql += ' ORDER BY w.name, b.bed_number';
      const r = await query(sql, params);
      res.json({ beds: r.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ═══════════════════════════════════════════════════════════
  // ADMISSIONS
  // ═══════════════════════════════════════════════════════════

  app.get('/api/hospital/admissions', auth, can('hospital:read'), async (req, res) => {
    const { pharmacyId } = req.user;
    const { status } = req.query;
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const offset = (page - 1) * limit;
    try {
      let where = 'WHERE a.pharmacy_id=$1';
      const params = [pharmacyId];
      if (status) { params.push(status); where += ` AND a.status=$${params.length}`; }
      const [rows, countRes] = await Promise.all([
        query(`SELECT a.*, p.name as patient_name, p.patient_number, d.name as doctor_name,
                      w.name as ward_name, b.bed_number
               FROM admissions a
               LEFT JOIN patients p ON p.id=a.patient_id LEFT JOIN doctors d ON d.id=a.doctor_id
               LEFT JOIN wards w ON w.id=a.ward_id LEFT JOIN beds b ON b.id=a.bed_id
               ${where} ORDER BY a.admitted_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
          [...params, limit, offset]),
        query(`SELECT COUNT(*) as total FROM admissions a ${where}`, params),
      ]);
      const total = parseInt(countRes.rows[0].total);
      res.json({ admissions: rows.rows, pagination:{ page, limit, total, pages:Math.ceil(total/limit) } });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/hospital/admissions', auth, can('hospital:admit'), async (req, res) => {
    const { orgId, pharmacyId, userId } = req.user;
    const { patient_id, doctor_id, bed_id, ward_id, diagnosis } = req.body;
    if (!patient_id) return err(res, 400, 'VALIDATION_REQUIRED', 'patient_id required');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Atomic admission number
      const ctr = await client.query(`UPDATE pharmacies SET admission_counter=admission_counter+1 WHERE id=$1 RETURNING admission_counter`, [pharmacyId]);
      const num = ctr.rows.length ? `ADM-${new Date().getFullYear()}-${String(ctr.rows[0].admission_counter).padStart(4,'0')}` : `ADM-${Date.now().toString(36)}`;

      // Mark bed as occupied
      if (bed_id) {
        await client.query(`UPDATE beds SET status='occupied' WHERE id=$1 AND status='available'`, [bed_id]);
      }

      const r = await client.query(
        `INSERT INTO admissions (org_id,pharmacy_id,patient_id,doctor_id,bed_id,ward_id,admission_number,diagnosis,admitted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [orgId, pharmacyId, patient_id, doctor_id||null, bed_id||null, ward_id||null, num, diagnosis||null, userId]
      );

      await client.query('COMMIT');
      await audit(query, { req, action:'admission.create', entity:'admission', entityId:r.rows[0].id, payload:{patient_id, admission_number:num} });
      res.status(201).json({ success:true, message:'✅ Patient admitted', admission:r.rows[0] });
    } catch (e) {
      await client.query('ROLLBACK');
      return err(res, 500, 'SERVER_ERROR', e.message);
    } finally { client.release(); }
  });

  // Discharge
  app.patch('/api/hospital/admissions/:id/discharge', auth, can('hospital:discharge'), async (req, res) => {
    const { pharmacyId, userId } = req.user;
    const { discharge_notes, discharge_type } = req.body;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const adm = await client.query(`SELECT * FROM admissions WHERE id=$1 AND pharmacy_id=$2 AND status='admitted' FOR UPDATE`, [req.params.id, pharmacyId]);
      if (!adm.rows.length) { await client.query('ROLLBACK'); return err(res, 404, 'NOT_FOUND', 'Active admission not found'); }

      // Free the bed
      if (adm.rows[0].bed_id) {
        await client.query(`UPDATE beds SET status='available' WHERE id=$1`, [adm.rows[0].bed_id]);
      }

      await client.query(
        `UPDATE admissions SET status='discharged', discharged_at=NOW(), discharge_notes=$1, discharge_type=$2, discharged_by=$3 WHERE id=$4`,
        [discharge_notes||null, discharge_type||'regular', userId, req.params.id]
      );

      await client.query('COMMIT');
      await audit(query, { req, action:'admission.discharge', entity:'admission', entityId:req.params.id, payload:{discharge_type} });
      res.json({ success:true, message:'✅ Patient discharged' });
    } catch (e) {
      await client.query('ROLLBACK');
      return err(res, 500, 'SERVER_ERROR', e.message);
    } finally { client.release(); }
  });

  // ═══════════════════════════════════════════════════════════
  // INPATIENT CHARGES
  // ═══════════════════════════════════════════════════════════

  app.get('/api/hospital/admissions/:id/charges', auth, can('hospital:read'), async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const r = await query(
        `SELECT ic.*, u.name as charged_by_name FROM inpatient_charges ic LEFT JOIN users u ON u.id=ic.charged_by
         WHERE ic.admission_id=$1 AND ic.pharmacy_id=$2 ORDER BY ic.created_at DESC`,
        [req.params.id, pharmacyId]
      );
      const total = r.rows.reduce((s, c) => s + parseFloat(c.total_price || 0), 0);
      res.json({ charges: r.rows, total });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/hospital/charges', auth, can('hospital:charge'), async (req, res) => {
    const { pharmacyId, userId } = req.user;
    const { admission_id, charge_type, description, quantity, unit_price, drug_id } = req.body;
    if (!admission_id || !charge_type || !description) return err(res, 400, 'VALIDATION_REQUIRED', 'admission_id, charge_type, description required');
    const qty = parseInt(quantity || 1);
    const price = parseFloat(unit_price || 0);
    try {
      const r = await query(
        `INSERT INTO inpatient_charges (admission_id,pharmacy_id,charge_type,description,quantity,unit_price,total_price,drug_id,charged_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [admission_id, pharmacyId, charge_type, description, qty, price, qty * price, drug_id||null, userId]
      );
      // If drug charge, deduct stock
      if (drug_id) {
        await query(`UPDATE drugs SET quantity=GREATEST(0,quantity-$1),updated_at=NOW() WHERE id=$2 AND pharmacy_id=$3`, [qty, drug_id, pharmacyId]);
      }
      res.status(201).json({ success:true, message:'✅ Charge posted', charge:r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ═══════════════════════════════════════════════════════════
  // INSURANCE
  // ═══════════════════════════════════════════════════════════

  app.get('/api/hospital/insurance-schemes', auth, can('insurance:read'), async (req, res) => {
    const { orgId } = req.user;
    try {
      const r = await query(`SELECT * FROM insurance_schemes WHERE org_id=$1 ORDER BY name`, [orgId]);
      res.json({ schemes: r.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/hospital/insurance-schemes', auth, can('insurance:manage'), async (req, res) => {
    const { orgId } = req.user;
    const { name, scheme_type, contact_name, phone, email, coverage_pct, payment_terms } = req.body;
    if (!name) return err(res, 400, 'VALIDATION_REQUIRED', 'Scheme name required');
    try {
      const r = await query(
        `INSERT INTO insurance_schemes (org_id,name,scheme_type,contact_name,phone,email,coverage_pct,payment_terms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [orgId, name.trim(), scheme_type||'private', contact_name||null, phone||null, email||null, parseFloat(coverage_pct||80), payment_terms||'net30']
      );
      res.status(201).json({ success:true, message:'✅ Insurance scheme added', scheme:r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // Insurance Claims
  app.get('/api/hospital/claims', auth, can('insurance:read'), async (req, res) => {
    const { pharmacyId } = req.user;
    const { status } = req.query;
    try {
      let sql = `SELECT ic.*, p.name as patient_name, s.name as scheme_name
                 FROM insurance_claims ic LEFT JOIN patients p ON p.id=ic.patient_id LEFT JOIN insurance_schemes s ON s.id=ic.scheme_id
                 WHERE ic.pharmacy_id=$1`;
      const params = [pharmacyId];
      if (status) { params.push(status); sql += ` AND ic.status=$${params.length}`; }
      sql += ' ORDER BY ic.created_at DESC LIMIT 100';
      const r = await query(sql, params);
      res.json({ claims: r.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/hospital/claims', auth, can('insurance:manage'), async (req, res) => {
    const { orgId, pharmacyId, userId } = req.user;
    const { scheme_id, patient_id, admission_id, consultation_id, total_amount, notes } = req.body;
    if (!scheme_id || !patient_id || !total_amount) return err(res, 400, 'VALIDATION_REQUIRED', 'scheme_id, patient_id, total_amount required');
    try {
      // Get scheme coverage
      const scheme = await query(`SELECT coverage_pct FROM insurance_schemes WHERE id=$1 AND org_id=$2`, [scheme_id, orgId]);
      if (!scheme.rows.length) return err(res, 404, 'NOT_FOUND', 'Scheme not found');
      const covPct = parseFloat(scheme.rows[0].coverage_pct) / 100;
      const covered = parseFloat(total_amount) * covPct;
      const patientPays = parseFloat(total_amount) - covered;

      // Atomic claim number
      const ctr = await query(`UPDATE pharmacies SET claim_counter=claim_counter+1 WHERE id=$1 RETURNING claim_counter`, [pharmacyId]);
      const num = ctr.rows.length ? `CLM-${new Date().getFullYear()}-${String(ctr.rows[0].claim_counter).padStart(4,'0')}` : `CLM-${Date.now().toString(36)}`;

      const r = await query(
        `INSERT INTO insurance_claims (org_id,pharmacy_id,scheme_id,patient_id,admission_id,consultation_id,claim_number,total_amount,covered_amount,patient_amount,notes,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [orgId, pharmacyId, scheme_id, patient_id, admission_id||null, consultation_id||null, num, parseFloat(total_amount), covered, patientPays, notes||null, userId]
      );
      await audit(query, { req, action:'claim.create', entity:'insurance_claim', entityId:r.rows[0].id, payload:{claim_number:num, total:total_amount, covered} });
      res.status(201).json({ success:true, message:'✅ Claim created', claim:r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.patch('/api/hospital/claims/:id/status', auth, can('insurance:manage'), async (req, res) => {
    const { pharmacyId } = req.user;
    const { status, rejection_reason } = req.body;
    const allowed = ['pending','submitted','approved','rejected','paid'];
    if (!allowed.includes(status)) return err(res, 400, 'VALIDATION_INVALID', 'Invalid claim status');
    try {
      const extra = status === 'submitted' ? ', submitted_at=NOW()' : status === 'approved' ? ', approved_at=NOW()' : status === 'paid' ? ', paid_at=NOW()' : '';
      const r = await query(
        `UPDATE insurance_claims SET status=$1, rejection_reason=$2 ${extra} WHERE id=$3 AND pharmacy_id=$4 RETURNING *`,
        [status, rejection_reason||null, req.params.id, pharmacyId]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Claim not found');
      res.json({ success:true, message:`✅ Claim ${status}`, claim:r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // Hospital stats
  app.get('/api/hospital/stats', auth, can('hospital:read'), async (req, res) => {
    const { pharmacyId, orgId } = req.user;
    try {
      const [beds, admissions, discharges, claims] = await Promise.all([
        query(`SELECT COUNT(*) FILTER (WHERE b.status='available') as available, COUNT(*) FILTER (WHERE b.status='occupied') as occupied, COUNT(*) as total
               FROM beds b JOIN wards w ON w.id=b.ward_id WHERE w.org_id=$1`, [orgId]),
        query(`SELECT COUNT(*) as active FROM admissions WHERE pharmacy_id=$1 AND status='admitted'`, [pharmacyId]),
        query(`SELECT COUNT(*) as today FROM admissions WHERE pharmacy_id=$1 AND DATE(discharged_at)=CURRENT_DATE`, [pharmacyId]),
        query(`SELECT COUNT(*) as pending FROM insurance_claims WHERE pharmacy_id=$1 AND status IN ('pending','submitted')`, [pharmacyId]),
      ]);
      res.json({
        beds_available: parseInt(beds.rows[0]?.available||0),
        beds_occupied: parseInt(beds.rows[0]?.occupied||0),
        beds_total: parseInt(beds.rows[0]?.total||0),
        active_admissions: parseInt(admissions.rows[0].active),
        discharges_today: parseInt(discharges.rows[0].today),
        pending_claims: parseInt(claims.rows[0].pending),
      });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // Department dashboard — revenue/cost per department
  app.get('/api/hospital/departments/dashboard', auth, can('hospital:read'), async (req, res) => {
    const { orgId } = req.user;
    try {
      const depts = await query(`SELECT * FROM departments WHERE org_id=$1 AND is_active=true ORDER BY name`, [orgId]);
      const stats = [];
      for (const d of depts.rows) {
        const [staff, wards, admissions] = await Promise.all([
          query(`SELECT COUNT(*) as cnt FROM users WHERE department_id=$1 AND is_active=true`, [d.id]),
          query(`SELECT COUNT(*) as cnt FROM wards WHERE department_id=$1 AND is_active=true`, [d.id]),
          query(`SELECT COUNT(*) as active FROM admissions a JOIN wards w ON w.id=a.ward_id WHERE w.department_id=$1 AND a.status='admitted'`, [d.id]),
        ]);
        stats.push({
          department: d,
          staff_count: parseInt(staff.rows[0].cnt),
          ward_count: parseInt(wards.rows[0].cnt),
          active_admissions: parseInt(admissions.rows[0].active),
        });
      }
      res.json({ departments: stats });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // Update department
  app.put('/api/hospital/departments/:id', auth, can('hospital:manage'), async (req, res) => {
    const { orgId } = req.user;
    const { name, code, head_id, is_active } = req.body;
    try {
      const r = await query(
        `UPDATE departments SET name=$1, code=$2, head_id=$3, is_active=$4 WHERE id=$5 AND org_id=$6 RETURNING *`,
        [name, code||null, head_id||null, is_active!==false, req.params.id, orgId]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Department not found');
      res.json({ success:true, department:r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });
};
