'use strict';
const err = require('./_err');

// ============================================================
// PHASE 3 — Clinic & Medical Center Module
// Patients, Doctors, Appointments, Consultations, Prescriptions
// Gated by org_type: only 'clinic','medical_center','hospital','dental' orgs
// ============================================================

module.exports = function registerClinicRoutes(app, { query, pool, auth, can, validate, schemas, audit }) {

  // ── Helper: check org_type is clinical ────────────────────
  function clinicOnly(req, res, next) {
    // For now, allow all org types to access clinic features
    // (pharmacies can also offer basic consultations)
    // In strict mode, uncomment below:
    // const allowed = ['clinic','medical_center','hospital','dental','pharmacy'];
    // if (!allowed.includes(req.user.orgType)) return err(res, 403, 'MODULE_DISABLED', 'Clinic module not enabled for your organisation');
    next();
  }

  // ═══════════════════════════════════════════════════════════
  // PATIENTS
  // ═══════════════════════════════════════════════════════════

  app.get('/api/clinic/patients', auth, can('patients:read'), clinicOnly, async (req, res) => {
    const { orgId } = req.user;
    const { search } = req.query;
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const offset = (page - 1) * limit;
    try {
      let where = 'WHERE p.org_id = $1';
      const params = [orgId];
      if (search) {
        params.push('%' + search + '%');
        where += ` AND (p.name ILIKE $${params.length} OR p.phone ILIKE $${params.length} OR p.patient_number ILIKE $${params.length})`;
      }
      const [rows, countRes] = await Promise.all([
        query(`SELECT p.* FROM patients p ${where} ORDER BY p.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
          [...params, limit, offset]),
        query(`SELECT COUNT(*) as total FROM patients p ${where}`, params),
      ]);
      const total = parseInt(countRes.rows[0].total);
      res.json({ patients: rows.rows, pagination: { page, limit, total, pages: Math.ceil(total/limit) } });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.get('/api/clinic/patients/:id', auth, can('patients:read'), clinicOnly, async (req, res) => {
    const { orgId } = req.user;
    try {
      const r = await query(`SELECT * FROM patients WHERE id=$1 AND org_id=$2`, [req.params.id, orgId]);
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Patient not found');
      // Get recent consultations and appointments
      const [consults, appts] = await Promise.all([
        query(`SELECT c.*, d.name as doctor_name FROM consultations c LEFT JOIN doctors d ON d.id=c.doctor_id WHERE c.patient_id=$1 ORDER BY c.created_at DESC LIMIT 10`, [req.params.id]),
        query(`SELECT a.*, d.name as doctor_name FROM appointments a LEFT JOIN doctors d ON d.id=a.doctor_id WHERE a.patient_id=$1 ORDER BY a.scheduled_at DESC LIMIT 10`, [req.params.id]),
      ]);
      res.json({ patient: r.rows[0], consultations: consults.rows, appointments: appts.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/clinic/patients', auth, can('patients:write'), clinicOnly, validate(schemas.patient_reg), async (req, res) => {
    const { orgId, pharmacyId, userId } = req.user;
    const { name, dob, gender, phone, email, address, blood_group, allergies, emergency_contact_name, emergency_contact_phone, notes } = req.body;
    try {
      // Atomic patient number
      const ctr = await query(`UPDATE pharmacies SET patient_counter=patient_counter+1 WHERE id=$1 RETURNING patient_counter`, [pharmacyId]);
      const num = ctr.rows.length ? `PT-${String(ctr.rows[0].patient_counter).padStart(5,'0')}` : `PT-${Date.now().toString(36).toUpperCase()}`;

      const r = await query(
        `INSERT INTO patients (org_id,pharmacy_id,patient_number,name,dob,gender,phone,email,address,blood_group,allergies,emergency_contact_name,emergency_contact_phone,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [orgId, pharmacyId, num, name.trim(), dob||null, gender||null, phone||null, email||null, address||null, blood_group||null, allergies||null, emergency_contact_name||null, emergency_contact_phone||null, notes||null]
      );
      await audit(query, { req, action:'patient.create', entity:'patient', entityId:r.rows[0].id, payload:{name,patient_number:num} });
      res.status(201).json({ success:true, message:'✅ Patient registered', patient:r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.put('/api/clinic/patients/:id', auth, can('patients:write'), clinicOnly, async (req, res) => {
    const { orgId } = req.user;
    const { name, dob, gender, phone, email, address, blood_group, allergies, emergency_contact_name, emergency_contact_phone, notes } = req.body;
    try {
      const r = await query(
        `UPDATE patients SET name=$1,dob=$2,gender=$3,phone=$4,email=$5,address=$6,blood_group=$7,allergies=$8,
         emergency_contact_name=$9,emergency_contact_phone=$10,notes=$11,updated_at=NOW()
         WHERE id=$12 AND org_id=$13 RETURNING *`,
        [name, dob||null, gender||null, phone||null, email||null, address||null, blood_group||null, allergies||null,
         emergency_contact_name||null, emergency_contact_phone||null, notes||null, req.params.id, orgId]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Patient not found');
      await audit(query, { req, action:'patient.update', entity:'patient', entityId:req.params.id, payload:{name} });
      res.json({ success:true, patient:r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ═══════════════════════════════════════════════════════════
  // DOCTORS
  // ═══════════════════════════════════════════════════════════

  app.get('/api/clinic/doctors', auth, can('doctors:read'), clinicOnly, async (req, res) => {
    const { orgId } = req.user;
    try {
      const r = await query(`SELECT * FROM doctors WHERE org_id=$1 ORDER BY name`, [orgId]);
      res.json({ doctors: r.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/clinic/doctors', auth, can('doctors:write'), clinicOnly, async (req, res) => {
    const { orgId, pharmacyId } = req.user;
    const { name, speciality, license_number, phone, email, consultation_fee } = req.body;
    if (!name) return err(res, 400, 'VALIDATION_REQUIRED', 'Doctor name is required');
    try {
      const r = await query(
        `INSERT INTO doctors (org_id,pharmacy_id,name,speciality,license_number,phone,email,consultation_fee)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [orgId, pharmacyId, name.trim(), speciality||null, license_number||null, phone||null, email||null, parseFloat(consultation_fee||0)]
      );
      await audit(query, { req, action:'doctor.create', entity:'doctor', entityId:r.rows[0].id, payload:{name} });
      res.status(201).json({ success:true, message:'✅ Doctor added', doctor:r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.put('/api/clinic/doctors/:id', auth, can('doctors:write'), clinicOnly, async (req, res) => {
    const { orgId } = req.user;
    const { name, speciality, license_number, phone, email, consultation_fee, is_active } = req.body;
    try {
      const r = await query(
        `UPDATE doctors SET name=$1,speciality=$2,license_number=$3,phone=$4,email=$5,consultation_fee=$6,is_active=$7
         WHERE id=$8 AND org_id=$9 RETURNING *`,
        [name, speciality||null, license_number||null, phone||null, email||null, parseFloat(consultation_fee||0), is_active !== false, req.params.id, orgId]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Doctor not found');
      res.json({ success:true, doctor:r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ═══════════════════════════════════════════════════════════
  // APPOINTMENTS
  // ═══════════════════════════════════════════════════════════

  app.get('/api/clinic/appointments', auth, can('appointments:read'), clinicOnly, async (req, res) => {
    const { pharmacyId } = req.user;
    const { date, status, doctor_id } = req.query;
    try {
      let sql = `SELECT a.*, p.name as patient_name, p.phone as patient_phone, d.name as doctor_name
                 FROM appointments a
                 LEFT JOIN patients p ON p.id=a.patient_id
                 LEFT JOIN doctors d ON d.id=a.doctor_id
                 WHERE a.pharmacy_id=$1`;
      const params = [pharmacyId]; let i=2;
      if (date)      { sql += ` AND DATE(a.scheduled_at)=$${i++}`; params.push(date); }
      if (status)    { sql += ` AND a.status=$${i++}`; params.push(status); }
      if (doctor_id) { sql += ` AND a.doctor_id=$${i++}`; params.push(doctor_id); }
      sql += ' ORDER BY a.scheduled_at ASC';
      const r = await query(sql, params);
      res.json({ appointments: r.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/clinic/appointments', auth, can('appointments:write'), clinicOnly, async (req, res) => {
    const { orgId, pharmacyId, userId } = req.user;
    const { patient_id, doctor_id, scheduled_at, duration_min, type, notes } = req.body;
    if (!patient_id || !scheduled_at) return err(res, 400, 'VALIDATION_REQUIRED', 'patient_id and scheduled_at are required');
    try {
      const r = await query(
        `INSERT INTO appointments (org_id,pharmacy_id,patient_id,doctor_id,scheduled_at,duration_min,type,notes,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [orgId, pharmacyId, patient_id, doctor_id||null, scheduled_at, parseInt(duration_min||30), type||'consultation', notes||null, userId]
      );
      res.status(201).json({ success:true, message:'✅ Appointment scheduled', appointment:r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.patch('/api/clinic/appointments/:id/status', auth, can('appointments:write'), clinicOnly, async (req, res) => {
    const { pharmacyId } = req.user;
    const { status } = req.body;
    const allowed = ['scheduled','checked_in','in_progress','completed','cancelled','no_show'];
    if (!allowed.includes(status)) return err(res, 400, 'VALIDATION_INVALID', 'Invalid status');
    try {
      const r = await query(`UPDATE appointments SET status=$1 WHERE id=$2 AND pharmacy_id=$3 RETURNING *`, [status, req.params.id, pharmacyId]);
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Appointment not found');
      res.json({ success:true, appointment:r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // Patient queue — today's appointments sorted by check-in time
  app.get('/api/clinic/queue', auth, can('appointments:read'), clinicOnly, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const r = await query(
        `SELECT a.*, p.name as patient_name, p.phone as patient_phone, d.name as doctor_name
         FROM appointments a
         LEFT JOIN patients p ON p.id=a.patient_id
         LEFT JOIN doctors d ON d.id=a.doctor_id
         WHERE a.pharmacy_id=$1 AND DATE(a.scheduled_at)=CURRENT_DATE AND a.status IN ('scheduled','checked_in','in_progress')
         ORDER BY CASE a.status WHEN 'in_progress' THEN 0 WHEN 'checked_in' THEN 1 ELSE 2 END, a.scheduled_at`,
        [pharmacyId]
      );
      res.json({ queue: r.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ═══════════════════════════════════════════════════════════
  // CONSULTATIONS
  // ═══════════════════════════════════════════════════════════

  app.get('/api/clinic/consultations', auth, can('consultations:read'), clinicOnly, async (req, res) => {
    const { pharmacyId } = req.user;
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 30);
    const offset = (page - 1) * limit;
    try {
      const [rows, countRes] = await Promise.all([
        query(
          `SELECT c.*, p.name as patient_name, p.patient_number, d.name as doctor_name
           FROM consultations c LEFT JOIN patients p ON p.id=c.patient_id LEFT JOIN doctors d ON d.id=c.doctor_id
           WHERE c.pharmacy_id=$1 ORDER BY c.created_at DESC LIMIT $2 OFFSET $3`,
          [pharmacyId, limit, offset]),
        query(`SELECT COUNT(*) as total FROM consultations WHERE pharmacy_id=$1`, [pharmacyId]),
      ]);
      const total = parseInt(countRes.rows[0].total);
      res.json({ consultations: rows.rows, pagination:{ page, limit, total, pages: Math.ceil(total/limit) } });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/clinic/consultations', auth, can('consultations:write'), clinicOnly, async (req, res) => {
    const { orgId, pharmacyId, userId } = req.user;
    const { patient_id, doctor_id, appointment_id, weight_kg, height_cm, bp_systolic, bp_diastolic, temperature, pulse, spo2,
            chief_complaint, history, examination, diagnosis, treatment_plan, notes, fee } = req.body;
    if (!patient_id) return err(res, 400, 'VALIDATION_REQUIRED', 'patient_id is required');
    try {
      const r = await query(
        `INSERT INTO consultations (org_id,pharmacy_id,patient_id,doctor_id,appointment_id,weight_kg,height_cm,
         bp_systolic,bp_diastolic,temperature,pulse,spo2,chief_complaint,history,examination,diagnosis,
         treatment_plan,notes,fee,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
        [orgId, pharmacyId, patient_id, doctor_id||null, appointment_id||null,
         weight_kg||null, height_cm||null, bp_systolic||null, bp_diastolic||null, temperature||null, pulse||null, spo2||null,
         chief_complaint||null, history||null, examination||null, diagnosis||null, treatment_plan||null, notes||null,
         parseFloat(fee||0), userId]
      );
      // Update appointment status if linked
      if (appointment_id) {
        await query(`UPDATE appointments SET status='completed' WHERE id=$1`, [appointment_id]);
      }
      await audit(query, { req, action:'consultation.create', entity:'consultation', entityId:r.rows[0].id, payload:{patient_id, diagnosis} });
      res.status(201).json({ success:true, message:'✅ Consultation recorded', consultation:r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ═══════════════════════════════════════════════════════════
  // PRESCRIPTIONS
  // ═══════════════════════════════════════════════════════════

  app.get('/api/clinic/prescriptions', auth, can('prescriptions:read'), clinicOnly, async (req, res) => {
    const { pharmacyId } = req.user;
    const { status } = req.query;
    try {
      let sql = `SELECT rx.*, p.name as patient_name, p.patient_number, d.name as doctor_name,
                        json_agg(json_build_object('id',ri.id,'drug_name',ri.drug_name,'dosage',ri.dosage,'frequency',ri.frequency,'duration',ri.duration,'quantity',ri.quantity,'dispensed_qty',ri.dispensed_qty)) as items
                 FROM prescriptions rx
                 LEFT JOIN patients p ON p.id=rx.patient_id LEFT JOIN doctors d ON d.id=rx.doctor_id
                 LEFT JOIN prescription_items ri ON ri.prescription_id=rx.id
                 WHERE rx.pharmacy_id=$1`;
      const params = [pharmacyId];
      if (status) { sql += ` AND rx.status=$2`; params.push(status); }
      sql += ' GROUP BY rx.id,p.name,p.patient_number,d.name ORDER BY rx.created_at DESC LIMIT 100';
      const r = await query(sql, params);
      res.json({ prescriptions: r.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // GET single prescription by ID
  app.get('/api/clinic/prescriptions/:id', auth, can('prescriptions:read'), clinicOnly, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const r = await query(
        `SELECT rx.*, p.name as patient_name, p.patient_number, p.phone as patient_phone,
                d.name as doctor_name,
                json_agg(json_build_object(
                  'id',ri.id,'drug_id',ri.drug_id,'drug_name',ri.drug_name,
                  'dosage',ri.dosage,'frequency',ri.frequency,'duration',ri.duration,
                  'quantity',ri.quantity,'dispensed_qty',ri.dispensed_qty,'notes',ri.notes
                )) as items
         FROM prescriptions rx
         LEFT JOIN patients p ON p.id=rx.patient_id
         LEFT JOIN doctors d ON d.id=rx.doctor_id
         LEFT JOIN prescription_items ri ON ri.prescription_id=rx.id
         WHERE rx.id=$1 AND rx.pharmacy_id=$2
         GROUP BY rx.id,p.name,p.patient_number,p.phone,d.name`,
        [req.params.id, pharmacyId]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Prescription not found');
      res.json({ success: true, prescription: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // PATCH cancel a prescription
  app.patch('/api/clinic/prescriptions/:id/cancel', auth, can('prescriptions:write'), clinicOnly, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const r = await query(
        `UPDATE prescriptions SET status='cancelled' WHERE id=$1 AND pharmacy_id=$2 AND status='pending' RETURNING id`,
        [req.params.id, pharmacyId]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Prescription not found or already processed');
      res.json({ success: true, message: 'Prescription cancelled' });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/clinic/prescriptions', auth, can('prescriptions:write'), clinicOnly, async (req, res) => {
    const { orgId, pharmacyId, userId } = req.user;
    const { patient_id, doctor_id, consultation_id, items, notes } = req.body;
    if (!patient_id) return err(res, 400, 'VALIDATION_REQUIRED', 'patient_id is required');
    if (!Array.isArray(items) || !items.length) return err(res, 400, 'VALIDATION_REQUIRED', 'items array is required');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const rxRes = await client.query(
        `INSERT INTO prescriptions (org_id,pharmacy_id,consultation_id,patient_id,doctor_id,notes)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [orgId, pharmacyId, consultation_id||null, patient_id, doctor_id||null, notes||null]
      );
      const rx = rxRes.rows[0];
      for (const item of items) {
        await client.query(
          `INSERT INTO prescription_items (prescription_id,drug_id,drug_name,dosage,frequency,duration,quantity,notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [rx.id, item.drug_id||null, item.drug_name, item.dosage||null, item.frequency||null, item.duration||null, parseInt(item.quantity||0), item.notes||null]
        );
      }
      await client.query('COMMIT');
      await audit(query, { req, action:'prescription.create', entity:'prescription', entityId:rx.id, payload:{patient_id, item_count:items.length} });
      res.status(201).json({ success:true, message:'✅ Prescription created', prescription:rx });
    } catch (e) {
      await client.query('ROLLBACK');
      return err(res, 500, 'SERVER_ERROR', e.message);
    } finally { client.release(); }
  });

  // Dispense a prescription (pharmacy side — pre-fills POS or marks as dispensed)
  app.patch('/api/clinic/prescriptions/:id/dispense', auth, can('prescriptions:dispense'), clinicOnly, async (req, res) => {
    const { pharmacyId, userId } = req.user;
    const { items } = req.body; // [{id, dispensed_qty}]

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const rxCheck = await client.query(`SELECT * FROM prescriptions WHERE id=$1 AND pharmacy_id=$2 FOR UPDATE`, [req.params.id, pharmacyId]);
      if (!rxCheck.rows.length) { await client.query('ROLLBACK'); return err(res, 404, 'NOT_FOUND', 'Prescription not found'); }

      if (Array.isArray(items)) {
        for (const it of items) {
          await client.query(`UPDATE prescription_items SET dispensed_qty=$1 WHERE id=$2 AND prescription_id=$3`, [it.dispensed_qty||0, it.id, req.params.id]);
          // Deduct stock
          if (it.drug_id && it.dispensed_qty > 0) {
            await client.query(`UPDATE drugs SET quantity=GREATEST(0,quantity-$1),updated_at=NOW() WHERE id=$2 AND pharmacy_id=$3`, [it.dispensed_qty, it.drug_id, pharmacyId]);
          }
        }
      }

      // Check if all items dispensed
      const pending = await client.query(`SELECT COUNT(*) as cnt FROM prescription_items WHERE prescription_id=$1 AND dispensed_qty < quantity`, [req.params.id]);
      const newStatus = parseInt(pending.rows[0].cnt) === 0 ? 'dispensed' : 'partial';
      await client.query(`UPDATE prescriptions SET status=$1 WHERE id=$2`, [newStatus, req.params.id]);

      await client.query('COMMIT');
      await audit(query, { req, action:'prescription.dispense', entity:'prescription', entityId:req.params.id, payload:{status:newStatus} });
      res.json({ success:true, message:`✅ Prescription ${newStatus}` });
    } catch (e) {
      await client.query('ROLLBACK');
      return err(res, 500, 'SERVER_ERROR', e.message);
    } finally { client.release(); }
  });

  // Clinic daily stats
  app.get('/api/clinic/stats', auth, can('consultations:read'), clinicOnly, async (req, res) => {
    const { pharmacyId } = req.user;
    try {
      const [patients, consults, appts, revenue] = await Promise.all([
        query(`SELECT COUNT(*) as total FROM patients WHERE pharmacy_id=$1`, [pharmacyId]),
        query(`SELECT COUNT(*) as today FROM consultations WHERE pharmacy_id=$1 AND DATE(created_at)=CURRENT_DATE`, [pharmacyId]),
        query(`SELECT COUNT(*) as today FROM appointments WHERE pharmacy_id=$1 AND DATE(scheduled_at)=CURRENT_DATE`, [pharmacyId]),
        query(`SELECT COALESCE(SUM(fee),0) as today FROM consultations WHERE pharmacy_id=$1 AND DATE(created_at)=CURRENT_DATE`, [pharmacyId]),
      ]);
      res.json({
        total_patients: parseInt(patients.rows[0].total),
        consultations_today: parseInt(consults.rows[0].today),
        appointments_today: parseInt(appts.rows[0].today),
        revenue_today: parseFloat(revenue.rows[0].today),
      });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // Patient deduplication — find potential duplicates
  app.get('/api/clinic/patients/duplicates', auth, can('patients:read'), clinicOnly, async (req, res) => {
    const { orgId } = req.user;
    try {
      // Find patients with matching phone or very similar names
      const r = await query(
        `SELECT p1.id as id1, p1.name as name1, p1.phone as phone1, p1.patient_number as pn1, p1.created_at as created1,
                p2.id as id2, p2.name as name2, p2.phone as phone2, p2.patient_number as pn2, p2.created_at as created2,
                CASE
                  WHEN p1.phone IS NOT NULL AND p1.phone = p2.phone THEN 'phone_match'
                  WHEN LOWER(p1.name) = LOWER(p2.name) THEN 'exact_name'
                  ELSE 'similar'
                END as match_type
         FROM patients p1
         JOIN patients p2 ON p2.org_id = p1.org_id AND p2.id > p1.id
           AND (
             (p1.phone IS NOT NULL AND p1.phone != '' AND p1.phone = p2.phone)
             OR LOWER(TRIM(p1.name)) = LOWER(TRIM(p2.name))
           )
         WHERE p1.org_id = $1
         ORDER BY match_type, p1.name
         LIMIT 50`,
        [orgId]
      );
      res.json({ duplicates: r.rows, count: r.rows.length });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // Merge duplicate patients (keep first, move records from second)
  app.post('/api/clinic/patients/merge', auth, can('patients:write'), clinicOnly, async (req, res) => {
    const { orgId } = req.user;
    const { keep_id, remove_id } = req.body;
    if (!keep_id || !remove_id) return err(res, 400, 'VALIDATION_REQUIRED', 'keep_id and remove_id required');
    if (keep_id === remove_id) return err(res, 400, 'VALIDATION_INVALID', 'Cannot merge a patient with itself');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Verify both belong to this org
      const check = await client.query(`SELECT id FROM patients WHERE id IN ($1,$2) AND org_id=$3`, [keep_id, remove_id, orgId]);
      if (check.rows.length < 2) { await client.query('ROLLBACK'); return err(res, 404, 'NOT_FOUND', 'One or both patients not found'); }

      // Move all records from remove_id to keep_id
      await client.query(`UPDATE consultations SET patient_id=$1 WHERE patient_id=$2`, [keep_id, remove_id]);
      await client.query(`UPDATE appointments SET patient_id=$1 WHERE patient_id=$2`, [keep_id, remove_id]);
      await client.query(`UPDATE prescriptions SET patient_id=$1 WHERE patient_id=$2`, [keep_id, remove_id]);
      await client.query(`UPDATE lab_requests SET patient_id=$1 WHERE patient_id=$2`, [keep_id, remove_id]);
      await client.query(`UPDATE lab_results SET patient_id=$1 WHERE patient_id=$2`, [keep_id, remove_id]);
      await client.query(`UPDATE admissions SET patient_id=$1 WHERE patient_id=$2`, [keep_id, remove_id]);
      await client.query(`UPDATE insurance_claims SET patient_id=$1 WHERE patient_id=$2`, [keep_id, remove_id]);
      // Deactivate duplicate
      await client.query(`UPDATE patients SET is_active=false, notes=COALESCE(notes,'')||' [MERGED into '||(SELECT patient_number FROM patients WHERE id=$1)||']' WHERE id=$2`, [keep_id, remove_id]);

      await client.query('COMMIT');
      await audit(query, { req, action:'patient.merge', entity:'patient', entityId:keep_id, payload:{removed_id:remove_id} });
      res.json({ success:true, message:'✅ Patients merged successfully' });
    } catch (e) {
      await client.query('ROLLBACK');
      return err(res, 500, 'SERVER_ERROR', e.message);
    } finally { client.release(); }
  });

  // Consultation printable receipt
  app.get('/api/clinic/consultations/:id', auth, can('consultations:read'), clinicOnly, async (req, res) => {
    const { orgId } = req.user;
    try {
      const r = await query(
        `SELECT c.*, p.name as patient_name, p.patient_number, p.phone as patient_phone,
                d.name as doctor_name, d.speciality,
                ph.name as pharmacy_name, ph.address as pharmacy_address
         FROM consultations c
         LEFT JOIN patients p ON p.id=c.patient_id
         LEFT JOIN doctors d ON d.id=c.doctor_id
         LEFT JOIN pharmacies ph ON ph.id=c.pharmacy_id
         WHERE c.id=$1 AND c.org_id=$2`, [req.params.id, orgId]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Consultation not found');
      res.json({ success:true, consultation: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.get('/api/clinic/consultations/:id/receipt', auth, can('consultations:read'), clinicOnly, async (req, res) => {
    const { orgId } = req.user;
    try {
      const r = await query(
        `SELECT c.*, p.name as patient_name, p.patient_number, p.phone as patient_phone,
                d.name as doctor_name, d.speciality, ph.name as pharmacy_name, ph.address as pharmacy_address, ph.phone as pharmacy_phone
         FROM consultations c
         LEFT JOIN patients p ON p.id=c.patient_id LEFT JOIN doctors d ON d.id=c.doctor_id
         LEFT JOIN pharmacies ph ON ph.id=c.pharmacy_id
         WHERE c.id=$1 AND c.org_id=$2`, [req.params.id, orgId]
      );
      if (!r.rows.length) return err(res, 404, 'NOT_FOUND', 'Consultation not found');
      res.json({ receipt: r.rows[0] });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });
};