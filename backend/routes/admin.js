'use strict';
const err = require('./_err');

module.exports = function registerAdminRoutes(app, { query, auth, can, hash }) {
  const adminOnly = can('admin:platform');

  app.get('/api/admin/stats', auth, adminOnly, async (req, res) => {
    try {
      const [orgs, active, trial, overdue, suspended, mrr, totalSales, totalUsers] = await Promise.all([
        query(`SELECT COUNT(*) as cnt FROM organisations WHERE email!='admin@medvault.ug'`),
        query(`SELECT COUNT(*) as cnt FROM subscriptions s JOIN organisations o ON o.id=s.organisation_id WHERE s.status='active' AND o.email!='admin@medvault.ug'`),
        query(`SELECT COUNT(*) as cnt FROM subscriptions s JOIN organisations o ON o.id=s.organisation_id WHERE s.status='trial' AND o.email!='admin@medvault.ug'`),
        query(`SELECT COUNT(*) as cnt FROM subscriptions s JOIN organisations o ON o.id=s.organisation_id WHERE s.status='overdue' AND o.email!='admin@medvault.ug'`),
        query(`SELECT COUNT(*) as cnt FROM subscriptions s JOIN organisations o ON o.id=s.organisation_id WHERE s.status='suspended' AND o.email!='admin@medvault.ug'`),
        query(`SELECT COALESCE(SUM(s.amount_ugx),0) as mrr FROM subscriptions s JOIN organisations o ON o.id=s.organisation_id WHERE s.status='active' AND o.email!='admin@medvault.ug'`),
        query(`SELECT COALESCE(SUM(total_amount),0) as total FROM sales`),
        query(`SELECT COUNT(*) as cnt FROM users WHERE email!='admin@medvault.ug'`),
      ]);
      res.json({
        totalOrgs:         parseInt(orgs.rows[0].cnt),
        activeCount:       parseInt(active.rows[0].cnt),
        trialCount:        parseInt(trial.rows[0].cnt),
        overdueCount:      parseInt(overdue.rows[0].cnt),
        suspendedCount:    parseInt(suspended.rows[0].cnt),
        mrr:               parseFloat(mrr.rows[0].mrr),
        totalSalesRevenue: parseFloat(totalSales.rows[0].total),
        totalUsers:        parseInt(totalUsers.rows[0].cnt),
      });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  app.get('/api/admin/orgs', auth, adminOnly, async (req, res) => {
    try {
      const result = await query(`
        SELECT o.id,o.name,o.owner_name,o.email,o.phone,o.plan,o.is_active,o.created_at,
               ph.id AS pharmacy_id,ph.address AS location,ph.nda_number AS nda,ph.is_active AS pharmacy_active,
               s.id AS sub_id,s.status AS sub_status,s.amount_ugx,s.trial_ends_at,s.next_billing,
               (SELECT COUNT(*) FROM pharmacies pp WHERE pp.organisation_id=o.id) AS branch_count,
               (SELECT COUNT(*) FROM users u WHERE u.organisation_id=o.id AND u.email!='admin@medvault.ug') AS user_count,
               (SELECT COUNT(*) FROM drugs d JOIN pharmacies pp ON pp.id=d.pharmacy_id WHERE pp.organisation_id=o.id) AS drug_count,
               (SELECT COALESCE(SUM(sa.total_amount),0) FROM sales sa JOIN pharmacies pp ON pp.id=sa.pharmacy_id WHERE pp.organisation_id=o.id) AS total_sales,
               (SELECT COUNT(*) FROM sales sa JOIN pharmacies pp ON pp.id=sa.pharmacy_id WHERE pp.organisation_id=o.id) AS sale_count,
               (SELECT MAX(sa.created_at) FROM sales sa JOIN pharmacies pp ON pp.id=sa.pharmacy_id WHERE pp.organisation_id=o.id) AS last_sale_at
        FROM organisations o
        LEFT JOIN pharmacies ph ON ph.organisation_id=o.id AND ph.is_head_office=true
        LEFT JOIN subscriptions s ON s.organisation_id=o.id
        WHERE o.email!='admin@medvault.ug'
        ORDER BY o.created_at DESC
      `);
      res.json({ orgs: result.rows });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  app.get('/api/admin/users', auth, adminOnly, async (req, res) => {
    try {
      const result = await query(`
        SELECT u.id,u.name,u.email,u.role,u.is_active,u.created_at,o.name AS org_name,p.name AS pharmacy_name
        FROM users u
        JOIN organisations o ON o.id=u.organisation_id
        LEFT JOIN pharmacies p ON p.id=u.pharmacy_id
        WHERE u.email!='admin@medvault.ug'
        ORDER BY u.created_at DESC
      `);
      res.json({ users: result.rows });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  app.post('/api/admin/orgs', auth, adminOnly, async (req, res) => {
    const { name, owner_name, email, phone, location, plan, nda } = req.body;
    if (!name)  return err(res, 400, 'VALIDATION_REQUIRED', 'Organisation name is required', 'name');
    if (!email) return err(res, 400, 'VALIDATION_REQUIRED', 'Email is required', 'email');
    if (!phone) return err(res, 400, 'VALIDATION_REQUIRED', 'Phone is required', 'phone');
    const planAmounts = { drug_shop: 20000, basic: 20000, single: 50000, pro: 50000, multi: 80000, branch: 40000, chain: 30000, enterprise: 150000 };
    const amount = planAmounts[plan] || 50000;
    try {
      const tempPw = name.replace(/\s+/g, '').slice(0, 4) + phone.slice(-4) + '!';
      const pwHash = await hash(tempPw);
      const org = await query(
        `INSERT INTO organisations (name,owner_name,email,phone,plan) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [name, owner_name || name, email.toLowerCase(), phone, plan || 'pro']
      );
      const orgId = org.rows[0].id;
      const ph = await query(
        `INSERT INTO pharmacies (organisation_id,name,address,phone,nda_number,is_head_office) VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
        [orgId, name, location || 'Uganda', phone, nda || null]
      );
      const pharmacyId = ph.rows[0].id;
      await query(
        `INSERT INTO users (organisation_id,pharmacy_id,name,email,password_hash,role) VALUES ($1,$2,$3,$4,$5,'owner')`,
        [orgId, pharmacyId, owner_name || name, email.toLowerCase(), pwHash]
      );
      await query(
        `INSERT INTO subscriptions (organisation_id,plan,amount_ugx,status,trial_ends_at) VALUES ($1,$2,$3,'trial',NOW()+INTERVAL '14 days')`,
        [orgId, plan || 'pro', amount]
      );
      res.json({ success: true, org_id: orgId, pharmacy_id: pharmacyId, temp_password: tempPw });
    } catch (e) {
      if (e.code === '23505') return err(res, 409, 'CONFLICT_EMAIL_EXISTS', 'Email already registered', 'email');
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  app.post('/api/admin/orgs/:id/suspend', auth, adminOnly, async (req, res) => {
    try {
      await query(`UPDATE organisations SET is_active=false WHERE id=$1`, [req.params.id]);
      await query(`UPDATE users SET is_active=false WHERE organisation_id=$1`, [req.params.id]);
      await query(`UPDATE subscriptions SET status='suspended' WHERE organisation_id=$1`, [req.params.id]);
      res.json({ success: true });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/admin/orgs/:id/activate', auth, adminOnly, async (req, res) => {
    try {
      await query(`UPDATE organisations SET is_active=true WHERE id=$1`, [req.params.id]);
      await query(`UPDATE users SET is_active=true WHERE organisation_id=$1`, [req.params.id]);
      await query(`UPDATE subscriptions SET status='active' WHERE organisation_id=$1`, [req.params.id]);
      res.json({ success: true });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/admin/orgs/:id/mark-overdue', auth, adminOnly, async (req, res) => {
    try {
      await query(`UPDATE subscriptions SET status='overdue' WHERE organisation_id=$1`, [req.params.id]);
      res.json({ success: true });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/admin/orgs/:id/convert-trial', auth, adminOnly, async (req, res) => {
    const { plan } = req.body;
    if (!plan) return err(res, 400, 'VALIDATION_REQUIRED', 'Plan is required', 'plan');
    const planAmounts = { drug_shop: 20000, basic: 20000, single: 50000, pro: 50000, multi: 80000, enterprise: 150000 };
    const amount = planAmounts[plan] || 50000;
    try {
      await query(`UPDATE subscriptions SET status='active',plan=$1,amount_ugx=$2,next_billing=NOW()+INTERVAL '30 days' WHERE organisation_id=$3`, [plan || 'pro', amount, req.params.id]);
      await query(`UPDATE organisations SET is_active=true,plan=$1 WHERE id=$2`, [plan || 'pro', req.params.id]);
      await query(`UPDATE users SET is_active=true WHERE organisation_id=$1`, [req.params.id]);
      res.json({ success: true });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/admin/orgs/:id/extend-trial', auth, adminOnly, async (req, res) => {
    const days = parseInt(req.body.days) || 7;
    try {
      await query(`UPDATE subscriptions SET trial_ends_at=GREATEST(trial_ends_at,NOW())+INTERVAL '${days} days' WHERE organisation_id=$1`, [req.params.id]);
      res.json({ success: true });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.patch('/api/admin/orgs/:id/plan', auth, adminOnly, async (req, res) => {
    const { plan } = req.body;
    if (!plan) return err(res, 400, 'VALIDATION_REQUIRED', 'Plan is required', 'plan');
    const planAmounts = { drug_shop: 20000, basic: 20000, single: 50000, pro: 50000, multi: 80000, enterprise: 150000 };
    const amount = planAmounts[plan];
    if (!amount) return err(res, 400, 'VALIDATION_INVALID', 'Invalid plan name', 'plan');
    try {
      await query(`UPDATE subscriptions SET plan=$1,amount_ugx=$2 WHERE organisation_id=$3`, [plan, amount, req.params.id]);
      await query(`UPDATE organisations SET plan=$1 WHERE id=$2`, [plan, req.params.id]);
      res.json({ success: true, amount });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/admin/users/:id/suspend', auth, adminOnly, async (req, res) => {
    try {
      await query(`UPDATE users SET is_active=false WHERE id=$1`, [req.params.id]);
      res.json({ success: true });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/admin/users/:id/activate', auth, adminOnly, async (req, res) => {
    try {
      await query(`UPDATE users SET is_active=true WHERE id=$1`, [req.params.id]);
      res.json({ success: true });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/admin/users/:id/reset-password', auth, adminOnly, async (req, res) => {
    try {
      const u = await query(`SELECT email,phone FROM users u LEFT JOIN organisations o ON o.id=u.organisation_id WHERE u.id=$1`, [req.params.id]);
      if (!u.rows.length) return err(res, 404, 'NOT_FOUND_USER', 'User not found', 'id');
      const newPw   = 'MedVault' + Math.floor(1000 + Math.random() * 9000) + '!';
      const pwHash  = await hash(newPw);
      await query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [pwHash, req.params.id]);
      res.json({ success: true, new_password: newPw });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // GET /api/subscription
  app.get('/api/subscription', auth, async (req, res) => {
    const { orgId } = req.user;
    try {
      const result = await query(
        `SELECT s.*,o.name as org_name,o.plan,(SELECT COUNT(*) FROM pharmacies WHERE organisation_id=$1) as branch_count
         FROM subscriptions s JOIN organisations o ON o.id=s.organisation_id WHERE s.organisation_id=$1 ORDER BY s.created_at DESC LIMIT 1`,
        [orgId]
      );
      res.json({ subscription: result.rows[0] || null });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ── BULK MESSAGING ──────────────────────────────────────────

  // POST /api/admin/messaging/send — send message to one or all pharmacies
  app.post('/api/admin/messaging/send', auth, adminOnly, async (req, res) => {
    const { target, org_ids, message_type, custom_message } = req.body;
    // target: 'all' | 'overdue' | 'trial' | 'selected'
    // message_type: 'payment_reminder' | 'trial_expiry' | 'custom'

    try {
      // Build recipient list from DB
      let filter = `WHERE o.email != 'admin@medvault.ug' AND o.phone IS NOT NULL AND o.phone != ''`;
      if (target === 'overdue') filter += ` AND s.status = 'overdue'`;
      else if (target === 'trial') filter += ` AND s.status = 'trial'`;
      else if (target === 'selected' && org_ids?.length) {
        filter += ` AND o.id = ANY(ARRAY[${org_ids.map(Number).join(',')}])`;
      }

      const orgs = await query(`
        SELECT o.id, o.name, o.owner_name, o.phone, o.plan,
               s.status AS sub_status, s.amount_ugx, s.trial_ends_at, s.next_billing
        FROM organisations o
        LEFT JOIN subscriptions s ON s.organisation_id = o.id
        ${filter}
        ORDER BY o.name
      `);

      if (!orgs.rows.length) return res.json({ sent: 0, failed: 0, results: [], message: 'No recipients found' });

      const { sendWhatsApp } = require('../notifications/whatsapp');
      const results = [];
      const planAmounts = { basic: 20000, pro: 50000, enterprise: 150000 };

      for (const org of orgs.rows) {
        let msg = '';

        if (message_type === 'payment_reminder') {
          const amount = org.amount_ugx || planAmounts[org.plan] || 50000;
          const due = org.next_billing ? new Date(org.next_billing).toLocaleDateString('en-UG') : 'soon';
          msg = `Dear ${org.owner_name || org.name},

This is a reminder that your MedVault subscription payment of UGX ${Number(amount).toLocaleString()} is due on ${due}.

Plan: ${(org.plan||'pro').toUpperCase()}
Status: ${(org.sub_status||'').toUpperCase()}

Please pay via MTN MoMo or Airtel Money to keep your pharmacy running smoothly.

Thank you,
MedVault Team
📞 +256 700 000 000`;
        } else if (message_type === 'trial_expiry') {
          const trialEnd = org.trial_ends_at ? new Date(org.trial_ends_at) : null;
          const daysLeft = trialEnd ? Math.ceil((trialEnd - new Date()) / 86400000) : 0;
          msg = `Dear ${org.owner_name || org.name},

Your MedVault free trial ${daysLeft > 0 ? `expires in ${daysLeft} day(s)` : 'has expired'}.

Upgrade now to continue using MedVault without interruption. Plans start from UGX 20,000/month.

Contact us to upgrade:
📞 +256 700 000 000
🌐 medvault.ug

MedVault Team`;
        } else if (message_type === 'custom' && custom_message) {
          msg = custom_message.replace(/{name}/g, org.owner_name || org.name)
                              .replace(/{pharmacy}/g, org.name)
                              .replace(/{plan}/g, org.plan || 'pro');
        } else {
          results.push({ org_id: org.id, name: org.name, phone: org.phone, success: false, error: 'No message content' });
          continue;
        }

        try {
          const result = await sendWhatsApp(org.phone, msg);
          // Log to notifications table if it exists
          try {
            await query(
              `INSERT INTO notification_log (org_id, channel, message, status, created_at)
               VALUES ($1, 'whatsapp', $2, $3, NOW())
               ON CONFLICT DO NOTHING`,
              [org.id, msg.slice(0, 500), result.success ? 'sent' : 'failed']
            );
          } catch(e) { /* log table may not exist yet — ignore */ }

          results.push({ org_id: org.id, name: org.name, phone: org.phone, success: result.success, sandbox: result.sandbox });
        } catch(e) {
          results.push({ org_id: org.id, name: org.name, phone: org.phone, success: false, error: e.message });
        }
      }

      const sent   = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;
      res.json({ sent, failed, total: results.length, results });
    } catch(e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // GET /api/admin/messaging/recipients — preview who will receive
  app.get('/api/admin/messaging/recipients', auth, adminOnly, async (req, res) => {
    const { target } = req.query;
    try {
      let filter = `WHERE o.email != 'admin@medvault.ug' AND o.phone IS NOT NULL AND o.phone != ''`;
      if (target === 'overdue') filter += ` AND s.status = 'overdue'`;
      else if (target === 'trial')   filter += ` AND s.status = 'trial'`;

      const result = await query(`
        SELECT o.id, o.name, o.owner_name, o.phone, o.plan,
               s.status AS sub_status, s.next_billing, s.trial_ends_at
        FROM organisations o
        LEFT JOIN subscriptions s ON s.organisation_id = o.id
        ${filter}
        ORDER BY o.name
      `);
      res.json({ recipients: result.rows, total: result.rowCount });
    } catch(e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

};
