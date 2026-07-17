'use strict';
const err = require('./_err');
const https = require('https');

// ============================================================
// SMS MODULE — Africa's Talking Gateway
// Env vars: AT_API_KEY, AT_USERNAME, AT_SENDER_ID
// Free tier: 10 free SMS on sandbox for testing
// Production: ~UGX 60 per SMS in Uganda
// ============================================================

module.exports = function registerSmsRoutes(app, { query, auth, can, audit }) {

  // Send a single SMS
  app.post('/api/sms/send', auth, can('sms:send'), async (req, res) => {
    const { orgId, pharmacyId, userId } = req.user;
    const { phone, message } = req.body;
    if (!phone || !message) return err(res, 400, 'VALIDATION_REQUIRED', 'phone and message required');

    try {
      const result = await sendSMS(phone, message);

      // Log the SMS
      await query(
        `INSERT INTO sms_log (org_id,pharmacy_id,recipient,message,status,provider,external_id,error,sent_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [orgId, pharmacyId, phone, message, result.success?'sent':'failed', 'africastalking',
         result.messageId||null, result.error||null, result.success?new Date().toISOString():null]
      );

      await audit(query, { req, action:'sms.send', entity:'sms', entityId:null, payload:{phone,status:result.success?'sent':'failed'} });
      res.json({ success:result.success, message:result.success?'✅ SMS sent':'❌ SMS failed: '+result.error, sms_id:result.messageId });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // Send credit reminder via SMS
  app.post('/api/sms/credit-reminder', auth, can('credit:remind'), async (req, res) => {
    const { orgId, pharmacyId } = req.user;
    const { credit_id } = req.body;
    if (!credit_id) return err(res, 400, 'VALIDATION_REQUIRED', 'credit_id required');

    try {
      const credit = await query(
        `SELECT cs.*, p.name as pharmacy_name FROM credit_sales cs
         JOIN pharmacies p ON p.id=cs.pharmacy_id
         WHERE cs.id=$1 AND cs.pharmacy_id=$2`, [credit_id, pharmacyId]
      );
      if (!credit.rows.length) return err(res, 404, 'NOT_FOUND', 'Credit record not found');
      const c = credit.rows[0];
      if (!c.customer_phone) return err(res, 400, 'VALIDATION_INVALID', 'Customer has no phone number');

      const msg = `Dear ${c.customer_name}, this is a reminder from ${c.pharmacy_name}. You have an outstanding balance of UGX ${Number(c.amount_owed).toLocaleString()}${c.due_date?' due by '+new Date(c.due_date).toLocaleDateString():''}. Please visit us to settle. Thank you.`;
      const result = await sendSMS(c.customer_phone, msg);

      // Update last reminded
      await query(`UPDATE credit_sales SET last_reminded=NOW() WHERE id=$1`, [credit_id]);

      // Log
      await query(
        `INSERT INTO sms_log (org_id,pharmacy_id,recipient,message,status,provider,external_id) VALUES ($1,$2,$3,$4,$5,'africastalking',$6)`,
        [orgId, pharmacyId, c.customer_phone, msg, result.success?'sent':'failed', result.messageId||null]
      );

      res.json({ success:result.success, message:result.success?'✅ Reminder sent via SMS':'❌ Failed: '+result.error });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // Bulk SMS — send to multiple recipients
  app.post('/api/sms/bulk', auth, can('sms:send'), async (req, res) => {
    const { orgId, pharmacyId } = req.user;
    const { phones, message } = req.body;
    if (!Array.isArray(phones) || !phones.length || !message) return err(res, 400, 'VALIDATION_REQUIRED', 'phones array and message required');

    let sent = 0, failed = 0;
    for (const phone of phones.slice(0, 100)) { // Cap at 100 per request
      try {
        const result = await sendSMS(phone, message);
        await query(
          `INSERT INTO sms_log (org_id,pharmacy_id,recipient,message,status,provider,external_id) VALUES ($1,$2,$3,$4,$5,'africastalking',$6)`,
          [orgId, pharmacyId, phone, message, result.success?'sent':'failed', result.messageId||null]
        );
        if (result.success) sent++; else failed++;
      } catch(e) { failed++; }
    }
    res.json({ success:true, message:`✅ ${sent} sent, ${failed} failed`, sent, failed });
  });

  // SMS log
  app.get('/api/sms/log', auth, can('sms:send'), async (req, res) => {
    const { orgId } = req.user;
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const offset = (page - 1) * limit;
    try {
      const [rows, countRes] = await Promise.all([
        query(`SELECT * FROM sms_log WHERE org_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [orgId, limit, offset]),
        query(`SELECT COUNT(*) as total FROM sms_log WHERE org_id=$1`, [orgId]),
      ]);
      const total = parseInt(countRes.rows[0].total);
      res.json({ messages: rows.rows, pagination:{ page, limit, total, pages:Math.ceil(total/limit) } });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });
};

// ── Africa's Talking SMS API ────────────────────────────────
function sendSMS(phone, message) {
  return new Promise((resolve) => {
    const apiKey   = process.env.AT_API_KEY;
    const username = process.env.AT_USERNAME || 'sandbox';
    const senderId = process.env.AT_SENDER_ID || '';

    if (!apiKey) {
      return resolve({ success:false, error:'AT_API_KEY not configured. Set it in Railway environment variables.' });
    }

    // Format phone for Uganda (+256)
    let formatted = phone.replace(/\s+/g, '');
    if (formatted.startsWith('0')) formatted = '+256' + formatted.slice(1);
    if (!formatted.startsWith('+')) formatted = '+' + formatted;

    const host = username === 'sandbox' ? 'api.sandbox.africastalking.com' : 'api.africastalking.com';
    const body = `username=${encodeURIComponent(username)}&to=${encodeURIComponent(formatted)}&message=${encodeURIComponent(message)}${senderId?'&from='+encodeURIComponent(senderId):''}`;

    const options = {
      hostname: host,
      port: 443,
      path: '/version1/messaging',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'apiKey': apiKey,
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const recipients = parsed?.SMSMessageData?.Recipients || [];
          if (recipients.length && recipients[0].statusCode === 101) {
            resolve({ success:true, messageId:recipients[0].messageId });
          } else {
            resolve({ success:false, error: recipients[0]?.status || 'Unknown error', messageId: recipients[0]?.messageId });
          }
        } catch(e) {
          resolve({ success:false, error:'Invalid API response' });
        }
      });
    });

    req.on('error', (e) => resolve({ success:false, error:e.message }));
    req.write(body);
    req.end();
  });
}
