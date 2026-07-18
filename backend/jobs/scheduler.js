'use strict';

// ============================================================
// MedVault — Background Job Scheduler
// Phase 1: Simple setInterval-based scheduler. No external queue.
// Started after server is listening — never blocks startup.
// ============================================================

const { query } = require('../database/db');

const SIX_HOURS  = 6  * 60 * 60 * 1000;
const ONE_DAY    = 24 * 60 * 60 * 1000;

// ── EXPIRY ALERT ─────────────────────────────────────────────
async function checkExpiryAlerts() {
  try {
    const drugs = await query(
      `SELECT d.id, d.name, d.expiry_date, d.pharmacy_id, d.quantity,
              p.organisation_id as org_id
       FROM drugs d
       JOIN pharmacies p ON p.id = d.pharmacy_id
       WHERE d.expiry_date IS NOT NULL
         AND d.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
         AND d.quantity > 0`
    );

    for (const d of drugs.rows) {
      const daysLeft = Math.ceil((new Date(d.expiry_date) - new Date()) / (1000 * 60 * 60 * 24));
      const title = `Expiry Alert: ${d.name}`;
      const body  = `${d.name} expires in ${daysLeft} day(s) (${d.expiry_date.toISOString?.().slice(0,10) || d.expiry_date}). Stock: ${d.quantity} units.`;

      // Use ON CONFLICT DO NOTHING keyed on (pharmacy_id, type, data->>'drug_id', date)
      // We use a simple duplicate-guard: skip if same notification in last 24h
      const recent = await query(
        `SELECT id FROM notifications
         WHERE pharmacy_id = $1 AND type = 'expiry'
           AND data->>'drug_id' = $2
           AND created_at >= NOW() - INTERVAL '24 hours'
         LIMIT 1`,
        [d.pharmacy_id, String(d.id)]
      );
      if (recent.rows.length) continue;

      await query(
        `INSERT INTO notifications (org_id, pharmacy_id, type, title, body, data)
         VALUES ($1, $2, 'expiry', $3, $4, $5)`,
        [d.org_id, d.pharmacy_id, title, body, JSON.stringify({ drug_id: String(d.id), days_left: daysLeft })]
      );
    }
    if (drugs.rows.length > 0)
      console.log(`⏰ [Scheduler] Expiry check: ${drugs.rows.length} drugs near expiry`);
  } catch (e) {
    console.error('⚠️  [Scheduler] Expiry check failed:', e.message);
  }
}

// ── LOW STOCK SCANNER ─────────────────────────────────────────
async function checkLowStock() {
  try {
    const drugs = await query(
      `SELECT d.id, d.name, d.quantity, d.threshold, d.pharmacy_id,
              p.organisation_id as org_id
       FROM drugs d
       JOIN pharmacies p ON p.id = d.pharmacy_id
       WHERE d.quantity <= d.threshold AND d.quantity >= 0`
    );

    for (const d of drugs.rows) {
      const recent = await query(
        `SELECT id FROM notifications
         WHERE pharmacy_id = $1 AND type = 'low_stock'
           AND data->>'drug_id' = $2
           AND created_at >= NOW() - INTERVAL '6 hours'
         LIMIT 1`,
        [d.pharmacy_id, String(d.id)]
      );
      if (recent.rows.length) continue;

      await query(
        `INSERT INTO notifications (org_id, pharmacy_id, type, title, body, data)
         VALUES ($1, $2, 'low_stock', $3, $4, $5)`,
        [
          d.org_id, d.pharmacy_id,
          `Low Stock: ${d.name}`,
          `${d.name} has only ${d.quantity} units left (threshold: ${d.threshold}).`,
          JSON.stringify({ drug_id: String(d.id), quantity: d.quantity, threshold: d.threshold }),
        ]
      );
    }
    if (drugs.rows.length > 0)
      console.log(`⏰ [Scheduler] Low stock check: ${drugs.rows.length} items below threshold`);
  } catch (e) {
    console.error('⚠️  [Scheduler] Low stock check failed:', e.message);
  }
}

// ── OVERDUE CREDIT FLAGGER ────────────────────────────────────
async function flagOverdueCredit() {
  try {
    const result = await query(
      `UPDATE credit_sales
       SET status = 'overdue'
       WHERE status = 'pending'
         AND due_date < CURRENT_DATE
       RETURNING id, pharmacy_id, customer_name, amount_owed`
    );

    for (const c of result.rows) {
      // Get org_id
      const ph = await query(`SELECT organisation_id FROM pharmacies WHERE id = $1`, [c.pharmacy_id]);
      if (!ph.rows.length) continue;

      await query(
        `INSERT INTO notifications (org_id, pharmacy_id, type, title, body, data)
         VALUES ($1, $2, 'credit_overdue', $3, $4, $5)`,
        [
          ph.rows[0].organisation_id, c.pharmacy_id,
          `Credit Overdue: ${c.customer_name}`,
          `${c.customer_name} has an overdue balance of UGX ${Number(c.amount_owed).toLocaleString()}.`,
          JSON.stringify({ credit_id: String(c.id), amount: c.amount_owed }),
        ]
      );
    }
    if (result.rowCount > 0)
      console.log(`⏰ [Scheduler] Credit: ${result.rowCount} accounts marked overdue`);
  } catch (e) {
    console.error('⚠️  [Scheduler] Credit flag failed:', e.message);
  }
}

// ── TRIAL EXPIRY CHECKER ──────────────────────────────────────
async function checkTrialExpiry() {
  try {
    const result = await query(
      `SELECT s.id, s.organisation_id, o.name as org_name
       FROM subscriptions s
       JOIN organisations o ON o.id = s.organisation_id
       WHERE s.status = 'trial'
         AND s.trial_ends_at < NOW()`
    );

    for (const s of result.rows) {
      console.log(`⏰ [Scheduler] Trial expired for org: ${s.org_name} (${s.organisation_id})`);
      // Notification to owner (user_id=null means broadcast to pharmacy)
      const ph = await query(
        `SELECT id FROM pharmacies WHERE organisation_id=$1 AND is_head_office=true LIMIT 1`,
        [s.organisation_id]
      );
      if (!ph.rows.length) continue;

      const recent = await query(
        `SELECT id FROM notifications
         WHERE org_id=$1 AND type='trial_expired'
           AND created_at >= NOW() - INTERVAL '24 hours' LIMIT 1`,
        [s.organisation_id]
      );
      if (recent.rows.length) continue;

      await query(
        `INSERT INTO notifications (org_id, pharmacy_id, type, title, body)
         VALUES ($1, $2, 'trial_expired', $3, $4)`,
        [
          s.organisation_id, ph.rows[0].id,
          'Your free trial has ended',
          'Your 14-day MedVault trial has expired. Please subscribe to continue using all features.',
        ]
      );
    }
  } catch (e) {
    console.error('⚠️  [Scheduler] Trial check failed:', e.message);
  }
}


// ── DAILY REVENUE SNAPSHOT ────────────────────────────────────
async function writeDailySnapshots() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const pharmacies = await query(`SELECT id FROM pharmacies WHERE is_active = true`);
    for (const ph of pharmacies.rows) {
      await query(
        `INSERT INTO daily_revenue_snapshots (pharmacy_id, snapshot_date, total_sales, sale_count)
         SELECT $1, $2,
                COALESCE(SUM(total_amount), 0),
                COUNT(*)
         FROM sales
         WHERE pharmacy_id = $1 AND voided_at IS NULL AND DATE(created_at) = $2
         ON CONFLICT (pharmacy_id, snapshot_date)
         DO UPDATE SET total_sales = EXCLUDED.total_sales, sale_count = EXCLUDED.sale_count`,
        [ph.id, today]
      );

      // Full logical backup: every sale + its line items for the day,
      // stored as JSON. This is a restorable copy independent of the
      // live tables — if a row were ever lost or corrupted, this
      // snapshot lets us reconstruct it.
      const snap = await query(
        `SELECT s.*, json_agg(json_build_object('drug_id',si.drug_id,'drug_name',si.drug_name,'quantity',si.quantity,'unit_price',si.unit_price,'total_price',si.total_price)) as items
         FROM sales s LEFT JOIN sale_items si ON si.sale_id = s.id
         WHERE s.pharmacy_id = $1 AND DATE(s.created_at) = $2
         GROUP BY s.id`,
        [ph.id, today]
      );
      const revenueForBackup = snap.rows.reduce((sum, s) => sum + (s.voided_at ? 0 : parseFloat(s.total_amount || 0)), 0);
      await query(
        `INSERT INTO sales_backup_log (pharmacy_id, backup_date, sale_count, total_revenue, snapshot)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (pharmacy_id, backup_date)
         DO UPDATE SET sale_count = EXCLUDED.sale_count, total_revenue = EXCLUDED.total_revenue, snapshot = EXCLUDED.snapshot, created_at = NOW()`,
        [ph.id, today, snap.rows.length, revenueForBackup, JSON.stringify(snap.rows)]
      );
    }
    console.log(`⏰ [Scheduler] Daily snapshots + backups written for ${pharmacies.rows.length} pharmacies`);
  } catch (e) {
    console.error('⚠️  [Scheduler] Daily snapshot failed:', e.message);
  }
}

// ── SUBSCRIPTION BILLING REMINDER ─────────────────────────────
async function sendBillingReminders() {
  try {
    const result = await query(
      `SELECT s.id, s.organisation_id, s.plan, s.next_billing, o.name as org_name, o.email
       FROM subscriptions s
       JOIN organisations o ON o.id = s.organisation_id
       WHERE s.status = 'active'
         AND s.next_billing IS NOT NULL
         AND s.next_billing <= NOW() + INTERVAL '7 days'
         AND s.next_billing >= NOW()`
    );

    for (const s of result.rows) {
      const recent = await query(
        `SELECT id FROM notifications
         WHERE org_id=$1 AND type='billing_reminder'
           AND created_at >= NOW() - INTERVAL '7 days' LIMIT 1`,
        [s.organisation_id]
      );
      if (recent.rows.length) continue;

      const ph = await query(
        `SELECT id FROM pharmacies WHERE organisation_id=$1 AND is_head_office=true LIMIT 1`,
        [s.organisation_id]
      );
      if (!ph.rows.length) continue;

      const daysUntil = Math.ceil((new Date(s.next_billing) - new Date()) / (1000*60*60*24));
      await query(
        `INSERT INTO notifications (org_id, pharmacy_id, type, title, body)
         VALUES ($1, $2, 'billing_reminder', $3, $4)`,
        [s.organisation_id, ph.rows[0].id,
         'Subscription Payment Due',
         `Your ${s.plan} plan payment is due in ${daysUntil} day(s). Renew to avoid service interruption.`]
      );
    }
    if (result.rows.length > 0)
      console.log(`⏰ [Scheduler] Billing reminders: ${result.rows.length} orgs approaching billing`);
  } catch (e) {
    console.error('⚠️  [Scheduler] Billing reminder failed:', e.message);
  }
}

// ── PO EXPECTED DELIVERY ALERT ────────────────────────────────
async function checkOverduePOs() {
  try {
    const result = await query(
      `SELECT po.id, po.po_number, po.expected_at, po.pharmacy_id, po.org_id, s.name as supplier_name
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       WHERE po.status = 'submitted'
         AND po.expected_at IS NOT NULL
         AND po.expected_at < CURRENT_DATE`
    );

    for (const po of result.rows) {
      const recent = await query(
        `SELECT id FROM notifications
         WHERE pharmacy_id=$1 AND type='po_overdue'
           AND data->>'po_id' = $2
           AND created_at >= NOW() - INTERVAL '24 hours' LIMIT 1`,
        [po.pharmacy_id, String(po.id)]
      );
      if (recent.rows.length) continue;

      const daysLate = Math.ceil((new Date() - new Date(po.expected_at)) / (1000*60*60*24));
      await query(
        `INSERT INTO notifications (org_id, pharmacy_id, type, title, body, data)
         VALUES ($1, $2, 'po_overdue', $3, $4, $5)`,
        [po.org_id, po.pharmacy_id,
         `PO Overdue: ${po.po_number}`,
         `${po.po_number} from ${po.supplier_name||'supplier'} is ${daysLate} day(s) past expected delivery.`,
         JSON.stringify({ po_id: String(po.id), po_number: po.po_number, days_late: daysLate })]
      );
    }
    if (result.rows.length > 0)
      console.log(`⏰ [Scheduler] Overdue POs: ${result.rows.length} orders past expected delivery`);
  } catch (e) {
    console.error('⚠️  [Scheduler] PO overdue check failed:', e.message);
  }
}

// ── PRESCRIPTION EXPIRY CHECK ─────────────────────────────────
async function checkPrescriptionExpiry() {
  try {
    // Flag prescriptions older than 30 days that are still pending
    const result = await query(
      `UPDATE prescriptions
       SET status = 'expired'
       WHERE status = 'pending'
         AND created_at < NOW() - INTERVAL '30 days'
       RETURNING id, pharmacy_id, patient_id`
    );

    for (const rx of result.rows) {
      const ph = await query(`SELECT organisation_id FROM pharmacies WHERE id = $1`, [rx.pharmacy_id]);
      if (!ph.rows.length) continue;

      await query(
        `INSERT INTO notifications (org_id, pharmacy_id, type, title, body, data)
         VALUES ($1, $2, 'prescription_expired', $3, $4, $5)`,
        [ph.rows[0].organisation_id, rx.pharmacy_id,
         'Prescription Expired',
         `A prescription (ID: ${rx.id}) was not dispensed within 30 days and has been marked expired.`,
         JSON.stringify({ prescription_id: String(rx.id) })]
      );
    }
    if (result.rowCount > 0)
      console.log(`⏰ [Scheduler] Prescriptions: ${result.rowCount} expired (unfilled >30 days)`);
  } catch (e) {
    console.error('⚠️  [Scheduler] Prescription expiry check failed:', e.message);
  }
}

const ONE_WEEK = 7 * ONE_DAY;

// ── SCHEDULER ENTRY POINT ─────────────────────────────────────
function startScheduler() {
  // Run checks immediately on boot, then on intervals
  setTimeout(async () => {
    console.log('⏰ [Scheduler] Running initial checks...');
    await checkExpiryAlerts();
    await checkLowStock();
    await flagOverdueCredit();
    await checkTrialExpiry();
    await writeDailySnapshots();
    await sendBillingReminders();
    await checkOverduePOs();
    await checkPrescriptionExpiry();
  }, 10000); // 10s delay after server starts to let DB settle

  setInterval(checkExpiryAlerts,        SIX_HOURS);
  setInterval(checkLowStock,            SIX_HOURS);
  setInterval(flagOverdueCredit,        ONE_DAY);
  setInterval(checkTrialExpiry,         ONE_DAY);
  setInterval(writeDailySnapshots,      ONE_DAY);
  setInterval(sendBillingReminders,     ONE_WEEK);
  setInterval(checkOverduePOs,          ONE_DAY);
  setInterval(checkPrescriptionExpiry,  ONE_DAY);

  console.log('✅ Background scheduler started (8 jobs)');
}

module.exports = {
  startScheduler,
  checkExpiryAlerts,
  checkLowStock,
  flagOverdueCredit,
  checkTrialExpiry,
  writeDailySnapshots,
  sendBillingReminders,
  checkOverduePOs,
  checkPrescriptionExpiry,
};
