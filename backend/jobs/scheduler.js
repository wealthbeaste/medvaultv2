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

// ── SCHEDULER ENTRY POINT ─────────────────────────────────────
function startScheduler() {
  // Run checks immediately on boot, then on intervals
  setTimeout(async () => {
    console.log('⏰ [Scheduler] Running initial checks...');
    await checkExpiryAlerts();
    await checkLowStock();
    await flagOverdueCredit();
    await checkTrialExpiry();
  }, 10000); // 10s delay after server starts to let DB settle

  setInterval(checkExpiryAlerts,   SIX_HOURS);
  setInterval(checkLowStock,       SIX_HOURS);
  setInterval(flagOverdueCredit,   ONE_DAY);
  setInterval(checkTrialExpiry,    ONE_DAY);

  console.log('✅ Background scheduler started');
}

module.exports = {
  startScheduler,
  // Exported for testing
  checkExpiryAlerts,
  checkLowStock,
  flagOverdueCredit,
  checkTrialExpiry,
};
