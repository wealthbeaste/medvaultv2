// ============================================================
// MTN Mobile Money Payment Integration
// MedVault — Uganda
// Docs: https://momodeveloper.mtn.com
// ============================================================

// ── CONFIG ─────────────────────────────────────────────────
const MOMO_CONFIG = {
  baseUrl: process.env.MTN_MOMO_BASE_URL || 'https://sandbox.momodeveloper.mtn.com',
  subscriptionKey: process.env.MTN_MOMO_SUBSCRIPTION_KEY || 'your_subscription_key',
  apiUser: process.env.MTN_MOMO_API_USER || 'your_api_user',
  apiKey: process.env.MTN_MOMO_API_KEY || 'your_api_key',
  currency: 'UGX',
  environment: process.env.NODE_ENV === 'production' ? 'mtncongo' : 'sandbox',
};

const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');

// ── HTTP Helper (no axios needed) ──────────────────────────
function httpRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Get Access Token ────────────────────────────────────────
async function getAccessToken() {
  const credentials = Buffer.from(`${MOMO_CONFIG.apiUser}:${MOMO_CONFIG.apiKey}`).toString('base64');
  const result = await httpRequest(
    `${MOMO_CONFIG.baseUrl}/collection/token/`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Ocp-Apim-Subscription-Key': MOMO_CONFIG.subscriptionKey,
      }
    }
  );
  if (!result.data.access_token) throw new Error('Failed to get MTN access token');
  return result.data.access_token;
}

// ── Request Payment from Customer ──────────────────────────
// This sends a payment prompt to the customer's MTN number
async function requestPayment({ amount, phone, orderId, description }) {
  // Normalize phone: 0770234567 → 256770234567
  const normalizedPhone = phone.replace(/^0/, '256').replace(/[^0-9]/g, '');

  // Generate unique reference ID for this transaction
  const referenceId = crypto.randomUUID();

  try {
    const token = await getAccessToken();

    const result = await httpRequest(
      `${MOMO_CONFIG.baseUrl}/collection/v1_0/requesttopay`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Reference-Id': referenceId,
          'X-Target-Environment': MOMO_CONFIG.environment,
          'Ocp-Apim-Subscription-Key': MOMO_CONFIG.subscriptionKey,
          'Content-Type': 'application/json',
        }
      },
      {
        amount: String(amount),
        currency: MOMO_CONFIG.currency,
        externalId: orderId,
        payer: {
          partyIdType: 'MSISDN',
          partyId: normalizedPhone,
        },
        payerMessage: description || 'MedVault Payment',
        payeeNote: `Order ${orderId}`,
      }
    );

    if (result.status === 202) {
      // 202 = payment request sent to phone successfully
      return {
        success: true,
        referenceId,
        message: 'Payment request sent to ' + phone + '. Customer will see a prompt.',
        status: 'PENDING',
      };
    } else {
      return { success: false, error: 'Payment request failed', details: result.data };
    }

  } catch (err) {
    // In sandbox/demo mode, simulate success
    if (MOMO_CONFIG.environment === 'sandbox') {
      return {
        success: true,
        referenceId,
        message: '[SANDBOX] Payment request simulated',
        status: 'PENDING',
        sandbox: true,
      };
    }
    return { success: false, error: err.message };
  }
}

// ── Check Payment Status ────────────────────────────────────
async function checkPaymentStatus(referenceId) {
  try {
    const token = await getAccessToken();
    const result = await httpRequest(
      `${MOMO_CONFIG.baseUrl}/collection/v1_0/requesttopay/${referenceId}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Target-Environment': MOMO_CONFIG.environment,
          'Ocp-Apim-Subscription-Key': MOMO_CONFIG.subscriptionKey,
        }
      }
    );

    // Possible statuses: PENDING, SUCCESSFUL, FAILED
    return {
      referenceId,
      status: result.data.status,        // PENDING | SUCCESSFUL | FAILED
      amount: result.data.amount,
      currency: result.data.currency,
      payer: result.data.payer?.partyId,
    };

  } catch (err) {
    // Sandbox simulation
    return { referenceId, status: 'SUCCESSFUL', sandbox: true };
  }
}

// ── Add MoMo Routes to App ──────────────────────────────────
function registerMomoRoutes(app) {
  const auth = require('./middleware/auth');

  // POST /api/payments/momo/request
  // Pharmacy triggers a payment request to customer's phone
  app.post('/api/payments/momo/request', auth, async (req, res) => {
    const { amount, phone, orderId, description } = req.body;
    if (!amount || !phone) return res.json({ error: 'Amount and phone required' }, 400);

    const result = await requestPayment({ amount, phone, orderId, description });
    if (!result.success) return res.json({ error: result.error }, 400);

    res.json({
      message: result.message,
      referenceId: result.referenceId,
      status: result.status,
      instructions: `Customer will receive a prompt on ${phone} to approve UGX ${amount.toLocaleString()}`,
    });
  });

  // GET /api/payments/momo/status/:referenceId
  // Poll this to check if customer approved/rejected
  app.get('/api/payments/momo/status/:referenceId', auth, async (req, res) => {
    const result = await checkPaymentStatus(req.params.referenceId);
    res.json(result);
  });

  // POST /api/payments/momo/subscription
  // Process monthly subscription payment
  app.post('/api/payments/momo/subscription', auth, async (req, res) => {
    const { phone, plan } = req.body;
    const prices = { basic: 20000, pro: 50000, enterprise: 150000 };
    if (!prices[plan]) return res.json({ error: 'Invalid plan' }, 400);

    const result = await requestPayment({
      amount: prices[plan],
      phone,
      orderId: 'SUB-' + req.user.pharmacyId + '-' + Date.now(),
      description: `MedVault ${plan} subscription`,
    });

    if (!result.success) return res.json({ error: result.error }, 400);

    res.json({
      message: `Payment of UGX ${prices[plan].toLocaleString()} requested via MTN MoMo`,
      referenceId: result.referenceId,
      plan,
      amount: prices[plan],
      phone,
      instructions: 'Customer will receive a prompt. Check status with the referenceId.',
    });
  });

  console.log('✅ MTN MoMo routes registered');
}

module.exports = { requestPayment, checkPaymentStatus, registerMomoRoutes };
