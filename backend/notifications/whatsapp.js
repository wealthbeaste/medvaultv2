// ============================================================
// MedVault WhatsApp Notification System
// Sends daily reports, order alerts, and low stock warnings
// Uses WhatsApp Business API (free tier: 1000 msgs/month)
// Fallback: Twilio SMS if no WhatsApp
// ============================================================

// ── CONFIG ─────────────────────────────────────────────────
const WA_CONFIG = {
  // WhatsApp Business API (Meta)
  // Get free access at: https://developers.facebook.com/docs/whatsapp
  phoneNumberId:  process.env.WA_PHONE_NUMBER_ID  || 'your_phone_number_id',
  accessToken:    process.env.WA_ACCESS_TOKEN      || 'your_access_token',
  apiVersion:     'v18.0',
  baseUrl:        'https://graph.facebook.com',

  // Your MedVault business number (what shows in client's WhatsApp)
  fromNumber:     process.env.WA_FROM_NUMBER       || '+256700123456',
};

const https = require('https');
const { helpers } = require('../database/memdb');

// ── HTTP Helper ─────────────────────────────────────────────
function postJSON(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data  = JSON.stringify(body);
    const urlObj = new (require('url').URL)(url);
    const req = https.request({
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers,
      },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── SEND A WHATSAPP MESSAGE ─────────────────────────────────
// phone = '0770123456' or '256770123456'
// message = plain text string
async function sendWhatsApp(phone, message) {
  // Normalize phone number
  const normalized = phone
    .replace(/^0/, '256')
    .replace(/[^0-9]/g, '');

  // In sandbox/dev mode — just log it
  if (!process.env.WA_ACCESS_TOKEN || process.env.NODE_ENV !== 'production') {
    console.log(`\n📱 [WhatsApp SANDBOX] → ${normalized}`);
    console.log(`   Message: ${message.substring(0, 100)}...`);
    console.log(`   (Set WA_ACCESS_TOKEN in .env to send real messages)\n`);
    return { success: true, sandbox: true, phone: normalized };
  }

  try {
    const result = await postJSON(
      `${WA_CONFIG.baseUrl}/${WA_CONFIG.apiVersion}/${WA_CONFIG.phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type:    'individual',
        to:                normalized,
        type:              'text',
        text: { body: message, preview_url: false },
      },
      { Authorization: `Bearer ${WA_CONFIG.accessToken}` }
    );

    return {
      success: result.status === 200,
      messageId: result.data?.messages?.[0]?.id,
      phone: normalized,
    };
  } catch (err) {
    console.error('WhatsApp send error:', err.message);
    return { success: false, error: err.message };
  }
}

// ── MESSAGE TEMPLATES ────────────────────────────────────────

// Daily summary report — sent every evening at 8 PM
function buildDailyReport(pharmacy, stats, alerts) {
  const lines = [
    `💊 *MedVault Daily Report*`,
    `📍 *${pharmacy.name}*`,
    `📅 ${new Date().toLocaleDateString('en-UG', { weekday: 'long', day: 'numeric', month: 'long' })}`,
    ``,
    `📊 *Today's Performance*`,
    `💰 Revenue: UGX ${Math.round(stats.revenueToday).toLocaleString()}`,
    `🧾 Transactions: ${stats.transactionsToday}`,
    `🛒 Online Orders: ${stats.pendingOrders || 0} pending`,
    ``,
  ];

  if (alerts.lowStock.length > 0) {
    lines.push(`⚠️ *Low Stock Alert (${alerts.lowStock.length} items)*`);
    alerts.lowStock.slice(0, 5).forEach(d => {
      lines.push(`  • ${d.name}: ${d.quantity} units left`);
    });
    lines.push(``);
  }

  if (alerts.expiring.length > 0) {
    lines.push(`📅 *Expiring Soon (${alerts.expiring.length} items)*`);
    alerts.expiring.slice(0, 3).forEach(d => {
      const days = Math.ceil((new Date(d.expiry_date) - new Date()) / 86400000);
      lines.push(`  • ${d.name}: ${days} days left`);
    });
    lines.push(``);
  }

  lines.push(`🔗 Open dashboard: https://app.medvault.ug`);
  lines.push(`📞 Support: +256 700 123 456`);

  return lines.join('\n');
}

// New order alert — sent immediately when a customer places an order
function buildNewOrderAlert(pharmacy, order, items) {
  const itemList = items.map(i => `  • ${i.drug_name} × ${i.quantity}`).join('\n');
  return [
    `🛒 *New Order Received!*`,
    ``,
    `👤 Customer: *${order.customer_name}*`,
    `📞 Phone: ${order.customer_phone}`,
    `📍 Delivery: ${order.delivery_address || 'Pickup'}`,
    `💳 Payment: ${order.payment_method}`,
    ``,
    `*Items ordered:*`,
    itemList,
    ``,
    `💰 Total: UGX ${parseInt(order.total_amount).toLocaleString()}`,
    ``,
    `Reply *CONFIRM* to accept or *CANCEL* to reject.`,
    `Or open: https://app.medvault.ug`,
  ].join('\n');
}

// Low stock warning — sent when any drug drops below threshold
function buildLowStockAlert(pharmacy, drugs) {
  const list = drugs.map(d =>
    `  ⚠️ ${d.name}: *${d.quantity} units* (min: ${d.threshold})`
  ).join('\n');
  return [
    `📦 *Low Stock Warning*`,
    `📍 ${pharmacy.name}`,
    ``,
    `These drugs need restocking:`,
    list,
    ``,
    `Manage inventory: https://app.medvault.ug`,
  ].join('\n');
}

// Expiry warning
function buildExpiryAlert(pharmacy, drugs) {
  const list = drugs.map(d => {
    const days = Math.ceil((new Date(d.expiry_date) - new Date()) / 86400000);
    return `  📅 ${d.name}: expires in *${days} days*`;
  }).join('\n');
  return [
    `⏰ *Expiry Alert*`,
    `📍 ${pharmacy.name}`,
    ``,
    `These drugs are expiring soon:`,
    list,
    ``,
    `Take action: https://app.medvault.ug`,
  ].join('\n');
}

// Payment reminder (for subscription)
function buildPaymentReminder(pharmacy, amount, daysOverdue) {
  return [
    `💳 *MedVault Subscription Reminder*`,
    ``,
    `Hello *${pharmacy.name}*,`,
    ``,
    daysOverdue > 0
      ? `Your subscription is *${daysOverdue} days overdue*.`
      : `Your subscription renews soon.`,
    ``,
    `Amount due: *UGX ${amount.toLocaleString()}*`,
    ``,
    `Pay via MTN MoMo or Airtel Money:`,
    `• MTN: Dial *165# → Send Money → ${WA_CONFIG.fromNumber}`,
    `• Airtel: Dial *185# → Send Money → ${WA_CONFIG.fromNumber}`,
    ``,
    `Questions? Reply to this message or call +256 700 123 456`,
  ].join('\n');
}

// ── SCHEDULED TASKS ─────────────────────────────────────────

// Send daily report to all active pharmacies
async function sendDailyReports() {
  console.log('📱 Sending daily WhatsApp reports…');
  const pharmacies = helpers.find('pharmacies', {}).filter(p => p.is_active);
  let sent = 0, failed = 0;

  for (const pharmacy of pharmacies) {
    try {
      const drugs   = helpers.find('drugs',   { pharmacy_id: pharmacy.id });
      const sales   = helpers.find('sales',   { pharmacy_id: pharmacy.id });
      const orders  = helpers.find('orders',  { pharmacy_id: pharmacy.id });
      const today   = new Date().toDateString();
      const todaySales = sales.filter(s => new Date(s.created_at).toDateString() === today);

      const stats = {
        revenueToday:      todaySales.reduce((s, x) => s + x.total_amount, 0),
        transactionsToday: todaySales.length,
        pendingOrders:     orders.filter(o => o.order_status === 'pending').length,
      };

      const alerts = {
        lowStock: drugs.filter(d => d.quantity <= d.threshold),
        expiring: drugs.filter(d => {
          const days = Math.ceil((new Date(d.expiry_date) - new Date()) / 86400000);
          return days <= 30 && days >= 0;
        }),
      };

      // Only send if there's something worth reporting
      if (stats.revenueToday > 0 || alerts.lowStock.length > 0 || stats.pendingOrders > 0) {
        const msg = buildDailyReport(pharmacy, stats, alerts);
        const result = await sendWhatsApp(pharmacy.phone, msg);
        if (result.success) sent++;
        else failed++;
      }
    } catch (err) {
      console.error(`Failed to send report to ${pharmacy.name}:`, err.message);
      failed++;
    }
  }

  console.log(`✅ Daily reports: ${sent} sent, ${failed} failed`);
  return { sent, failed };
}

// Send alerts for any pharmacy with critical low stock
async function sendLowStockAlerts() {
  const pharmacies = helpers.find('pharmacies', {}).filter(p => p.is_active);
  let sent = 0;
  for (const pharmacy of pharmacies) {
    const critical = helpers.find('drugs', { pharmacy_id: pharmacy.id })
      .filter(d => d.quantity <= d.threshold && d.quantity > 0);
    if (critical.length > 0) {
      const msg = buildLowStockAlert(pharmacy, critical);
      const result = await sendWhatsApp(pharmacy.phone, msg);
      if (result.success) sent++;
    }
  }
  console.log(`✅ Low stock alerts: ${sent} sent`);
  return { sent };
}

// Send payment reminders for overdue subscriptions
async function sendPaymentReminders() {
  const pharmacies = helpers.find('pharmacies', {});
  let sent = 0;
  for (const pharmacy of pharmacies) {
    const sub = helpers.find('subscriptions', { pharmacy_id: pharmacy.id })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    if (!sub) continue;

    const daysOverdue = Math.ceil((new Date() - new Date(sub.next_billing)) / 86400000);
    if (daysOverdue >= 1) { // Overdue by 1+ days
      const prices = { basic: 20000, pro: 50000, enterprise: 150000 };
      const msg = buildPaymentReminder(pharmacy, prices[sub.plan] || sub.amount, daysOverdue);
      const result = await sendWhatsApp(pharmacy.phone, msg);
      if (result.success) sent++;
    }
  }
  console.log(`✅ Payment reminders: ${sent} sent`);
  return { sent };
}

// ── SCHEDULER: run tasks at the right time ──────────────────
function startScheduler() {
  console.log('⏰ MedVault WhatsApp scheduler started');

  setInterval(() => {
    const now = new Date();
    const h   = now.getHours();
    const m   = now.getMinutes();

    // 8:00 PM — send daily reports
    if (h === 20 && m === 0) sendDailyReports();

    // 9:00 AM — send low stock alerts
    if (h === 9 && m === 0) sendLowStockAlerts();

    // 10:00 AM — send payment reminders
    if (h === 10 && m === 0) sendPaymentReminders();

  }, 60000); // Check every minute
}

// ── REGISTER ROUTES ─────────────────────────────────────────
function registerWhatsAppRoutes(app) {
  const auth = require('../middleware/auth');

  // Manual trigger: send daily report to a specific pharmacy
  app.post('/api/whatsapp/daily-report/:pharmacyId', auth, async (req, res) => {
    const pharmacy = helpers.findOne('pharmacies', { id: parseInt(req.params.pharmacyId) });
    if (!pharmacy) return res.json({ error: 'Pharmacy not found' }, 404);

    const drugs  = helpers.find('drugs',  { pharmacy_id: pharmacy.id });
    const sales  = helpers.find('sales',  { pharmacy_id: pharmacy.id });
    const orders = helpers.find('orders', { pharmacy_id: pharmacy.id });
    const today  = new Date().toDateString();
    const ts     = sales.filter(s => new Date(s.created_at).toDateString() === today);

    const stats  = {
      revenueToday:      ts.reduce((s, x) => s + x.total_amount, 0),
      transactionsToday: ts.length,
      pendingOrders:     orders.filter(o => o.order_status === 'pending').length,
    };
    const alerts = {
      lowStock: drugs.filter(d => d.quantity <= d.threshold),
      expiring: drugs.filter(d => {
        const days = Math.ceil((new Date(d.expiry_date) - new Date()) / 86400000);
        return days <= 30 && days >= 0;
      }),
    };

    const msg    = buildDailyReport(pharmacy, stats, alerts);
    const result = await sendWhatsApp(pharmacy.phone, msg);

    res.json({
      message: result.success ? '✅ Daily report sent!' : '❌ Failed to send',
      phone:   pharmacy.phone,
      sandbox: result.sandbox || false,
      preview: msg,
    });
  });

  // Send new order alert to pharmacy
  app.post('/api/whatsapp/order-alert', auth, async (req, res) => {
    const { pharmacyId, orderId } = req.body;
    const pharmacy = helpers.findOne('pharmacies', { id: pharmacyId });
    const order    = helpers.findOne('orders',     { id: orderId });
    if (!pharmacy || !order) return res.json({ error: 'Not found' }, 404);

    const items  = helpers.find('orderItems', { order_id: orderId });
    const msg    = buildNewOrderAlert(pharmacy, order, items);
    const result = await sendWhatsApp(pharmacy.phone, msg);

    res.json({ message: result.success ? '✅ Order alert sent!' : '❌ Failed', preview: msg });
  });

  // Send low stock alert manually
  app.post('/api/whatsapp/low-stock-alert/:pharmacyId', auth, async (req, res) => {
    const pharmacy = helpers.findOne('pharmacies', { id: parseInt(req.params.pharmacyId) });
    if (!pharmacy) return res.json({ error: 'Pharmacy not found' }, 404);
    const critical = helpers.find('drugs', { pharmacy_id: pharmacy.id })
      .filter(d => d.quantity <= d.threshold);
    if (!critical.length) return res.json({ message: 'No low stock drugs', sent: false });
    const msg    = buildLowStockAlert(pharmacy, critical);
    const result = await sendWhatsApp(pharmacy.phone, msg);
    res.json({ message: result.success ? '✅ Alert sent!' : '❌ Failed', preview: msg });
  });

  // Send payment reminder manually (from admin panel)
  app.post('/api/whatsapp/payment-reminder/:pharmacyId', auth, async (req, res) => {
    const pharmacy = helpers.findOne('pharmacies', { id: parseInt(req.params.pharmacyId) });
    if (!pharmacy) return res.json({ error: 'Not found' }, 404);
    const prices   = { basic: 20000, pro: 50000, enterprise: 150000 };
    const sub      = helpers.find('subscriptions', { pharmacy_id: pharmacy.id })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    const amount   = prices[sub?.plan] || 50000;
    const msg      = buildPaymentReminder(pharmacy, amount, 0);
    const result   = await sendWhatsApp(pharmacy.phone, msg);
    res.json({ message: result.success ? '✅ Reminder sent!' : '❌ Failed', preview: msg });
  });

  // Send all daily reports manually (admin trigger)
  app.post('/api/whatsapp/send-all-reports', auth, async (req, res) => {
    const result = await sendDailyReports();
    res.json({ message: `✅ Reports sent: ${result.sent}, Failed: ${result.failed}`, ...result });
  });

  // Preview a message without sending
  app.get('/api/whatsapp/preview/:pharmacyId', auth, async (req, res) => {
    const pharmacy = helpers.findOne('pharmacies', { id: parseInt(req.params.pharmacyId) });
    if (!pharmacy) return res.json({ error: 'Not found' }, 404);
    const drugs  = helpers.find('drugs',  { pharmacy_id: pharmacy.id });
    const sales  = helpers.find('sales',  { pharmacy_id: pharmacy.id });
    const orders = helpers.find('orders', { pharmacy_id: pharmacy.id });
    const today  = new Date().toDateString();
    const ts     = sales.filter(s => new Date(s.created_at).toDateString() === today);
    const stats  = { revenueToday: ts.reduce((s,x) => s+x.total_amount,0), transactionsToday: ts.length, pendingOrders: orders.filter(o=>o.order_status==='pending').length };
    const alerts = { lowStock: drugs.filter(d=>d.quantity<=d.threshold), expiring: drugs.filter(d=>{ const days=Math.ceil((new Date(d.expiry_date)-new Date())/86400000); return days<=30&&days>=0; }) };
    res.json({ phone: pharmacy.phone, preview: buildDailyReport(pharmacy, stats, alerts) });
  });

  console.log('✅ WhatsApp routes registered');
}

module.exports = {
  sendWhatsApp,
  sendDailyReports,
  sendLowStockAlerts,
  sendPaymentReminders,
  startScheduler,
  registerWhatsAppRoutes,
  buildDailyReport,
  buildNewOrderAlert,
  buildLowStockAlert,
  buildPaymentReminder,
};
