'use strict';

// ============================================================
// MedVault — Transactional Email (via Resend)
// Uses native fetch (Node 18+, no SDK/dependency needed) to call
// Resend's REST API directly. Free tier: 3,000 emails/mo, 100/day.
//
// Setup:
//   1. Create a free account at https://resend.com
//   2. Get an API key and set RESEND_API_KEY in Railway env vars
//   3. (Optional) Verify your own domain and set RESEND_FROM,
//      e.g. "MedVault <noreply@yourdomain.com>". Until you do,
//      emails send fine from Resend's shared test address, which
//      is sufficient to get the reset flow working immediately.
//
// If RESEND_API_KEY is not set, sendEmail() logs a warning and
// returns { sent:false } instead of throwing — callers must treat
// email delivery as best-effort and never let it block the
// underlying operation (see routes/auth.js forgot-password, which
// always returns success to the client regardless of email result,
// both for security — no account-enumeration — and reliability).
// ============================================================

async function sendEmail({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[email] RESEND_API_KEY not set — skipping send. Configure it in Railway env vars to enable emails.');
    console.warn('[email] Would have sent to:', to, '| subject:', subject);
    return { sent: false, reason: 'RESEND_API_KEY not configured' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || 'MedVault <onboarding@resend.dev>',
        to: [to],
        subject,
        html,
        text,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[email] Resend API rejected send:', res.status, data);
      return { sent: false, reason: data.message || `Resend HTTP ${res.status}` };
    }
    return { sent: true, id: data.id };
  } catch (e) {
    console.error('[email] send failed:', e.message);
    return { sent: false, reason: e.message };
  }
}

function passwordResetEmailHtml({ name, resetUrl }) {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;background:#0b1120;padding:32px 24px;border-radius:14px;color:#e5e7eb">
    <div style="font-size:22px;font-weight:800;color:#00d4aa;margin-bottom:4px">💊 MedVault</div>
    <p style="color:#9ca3af;font-size:13px;margin-top:0">Password reset request</p>
    <p>Hi ${escapeHtml(name || '')},</p>
    <p>We received a request to reset your MedVault password. Click the button below to choose a new one — this link expires in <strong>1 hour</strong> and can only be used once.</p>
    <p style="text-align:center;margin:28px 0">
      <a href="${resetUrl}" style="background:#00d4aa;color:#04120e;text-decoration:none;font-weight:700;padding:12px 28px;border-radius:10px;display:inline-block">Reset my password</a>
    </p>
    <p style="color:#9ca3af;font-size:12px">If the button doesn't work, copy and paste this link into your browser:<br><span style="word-break:break-all">${resetUrl}</span></p>
    <p style="color:#9ca3af;font-size:12px">If you didn't request this, you can safely ignore this email — your password will not be changed.</p>
    <hr style="border:none;border-top:1px solid #1f2937;margin:24px 0">
    <p style="color:#4b5563;font-size:11px">MedVault Pharmacy Management · Uganda</p>
  </div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

module.exports = { sendEmail, passwordResetEmailHtml };
