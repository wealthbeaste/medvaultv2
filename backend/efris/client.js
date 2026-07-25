'use strict';
// ============================================================
// EFRIS client — talks to an EFRIS-accredited aggregator (default:
// EFRISBuddy, efris.dev), NOT URA's raw EFRIS API directly. Each
// pharmacy brings their own aggregator API key/credentials via
// EFRIS Settings; MedVault never holds a direct URA relationship.
//
// ⚠️ PLACEHOLDER FIELD NAMES: the exact request/response shape below
// is a reasonable placeholder based on general REST e-invoicing
// conventions, NOT a verified copy of EFRISBuddy's real API spec.
// Before going live, confirm actual endpoint paths, auth header
// format, and field names against EFRISBuddy's real docs/Postman
// collection, and adjust this file accordingly.
// ============================================================
const axios = require('axios');

function makeClient({ base_url, api_key }) {
  return axios.create({
    baseURL: base_url || 'https://api.efris.dev',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + api_key,
    },
    timeout: 20000,
  });
}

async function testConnection({ base_url, api_key, client_id }) {
  try {
    const client = makeClient({ base_url, api_key });
    const res = await client.get('/api/status', { params: { clientId: client_id } });
    return { success: true, message: 'Connected successfully.', detail: res.data };
  } catch (e) {
    const status = e.response?.status;
    if (status === 401) return { success: false, error: 'Invalid API key.' };
    if (status === 404) return { success: false, error: 'Base URL or status endpoint not found — verify against EFRISBuddy docs.' };
    return { success: false, error: e.message };
  }
}

function buildInvoicePayload(sale, saleItems, settings) {
  const invoiceKind = settings.tin ? 1 : 2;
  return {
    clientId: settings.client_id,
    deviceNo: settings.device_no || null,
    invoiceKind,
    tin: settings.tin || null,
    buyerDetails: {
      name: sale.customer_name || 'Walk-in',
      phone: sale.customer_phone || null,
    },
    goodsDetails: saleItems.map(item => ({
      itemName: item.drug_name,
      quantity: item.quantity,
      unitPrice: item.unit_price,
      total: item.total_price,
      taxType: item.tax_type === 'vatable' ? 'VAT' : 'ZERO_RATED',
      taxAmount: item.tax_amount || 0,
    })),
    totalAmount: sale.total_amount,
    currency: 'UGX',
    invoiceDate: sale.created_at,
    reference: sale.receipt_number,
  };
}

async function submitInvoice({ base_url, api_key }, payload) {
  try {
    const client = makeClient({ base_url, api_key });
    const res = await client.post('/api/invoices/submit', payload);
    const d = res.data || {};
    return {
      success: true,
      fdn: d.fdn || d.fiscalDocumentNumber || null,
      invoiceId: d.invoiceId || null,
      qrCodeUrl: d.qrCodeUrl || d.qrCode || null,
      raw: d,
    };
  } catch (e) {
    return { success: false, error: e.response?.data?.message || e.message, raw: e.response?.data || null };
  }
}

module.exports = { testConnection, buildInvoicePayload, submitInvoice };
