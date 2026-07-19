'use strict';
const err = require('./_err');
const crypto = require('crypto');
const { sendEmail, passwordResetEmailHtml } = require('../core/email');

module.exports = function registerAuthRoutes(app, { query, pool, hash, compare, sign, auth, rateLimit, audit }) {

  app.post(
    '/api/auth/register',
    rateLimit({ max: 3, windowMs: 60 * 60 * 1000, message: 'Too many registrations from this device. Try again in 1 hour.' }),
    async (req, res) => {
      const { orgName, ownerName, email, phone, password, plan } = req.body;
      if (!orgName)   return err(res, 400, 'VALIDATION_REQUIRED', 'Organisation name is required', 'orgName');
      if (!ownerName) return err(res, 400, 'VALIDATION_REQUIRED', 'Owner name is required', 'ownerName');
      if (!email)     return err(res, 400, 'VALIDATION_REQUIRED', 'Email is required', 'email');
      if (!phone)     return err(res, 400, 'VALIDATION_REQUIRED', 'Phone number is required', 'phone');
      if (!password)  return err(res, 400, 'VALIDATION_REQUIRED', 'Password is required', 'password');

      const client = await pool.connect();
      try {
        const exists = await client.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
        if (exists.rows.length) {
          client.release();
          return err(res, 409, 'AUTH_EMAIL_EXISTS', 'Email already registered. Please log in.', 'email');
        }

        const pwHash = await hash(password);
        const selectedPlan = plan || 'single';

        await client.query('BEGIN');

        const org = await client.query(
          `INSERT INTO organisations (name,owner_name,email,phone,plan) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [orgName, ownerName, email.toLowerCase(), phone, selectedPlan]
        );
        const orgId = org.rows[0].id;

        const pharma = await client.query(
          `INSERT INTO pharmacies (organisation_id,name,address,phone,is_head_office) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [orgId, orgName, req.body.address || '', phone, true]
        );
        const pharmacyId = pharma.rows[0].id;

        const userRes = await client.query(
          `INSERT INTO users (organisation_id,pharmacy_id,name,email,password_hash,role) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,name,email,role`,
          [orgId, pharmacyId, ownerName, email.toLowerCase(), pwHash, 'owner']
        );
        const user = userRes.rows[0];

        const prices = { drug_shop: 20000, single: 50000, branch: 40000, chain: 30000, enterprise: 20000 };
        await client.query(
          `INSERT INTO subscriptions (organisation_id,plan,branch_count,amount_ugx,status) VALUES ($1,$2,$3,$4,$5)`,
          [orgId, selectedPlan, 1, prices[selectedPlan] || 50000, 'trial']
        );

        await client.query('COMMIT');

        // FIX: normalise role to lowercase in JWT payload
        const role = (user.role || 'owner').toLowerCase();
        const token = sign({ userId: user.id, orgId, pharmacyId, role });
        res.json({
          message: '✅ Account created! 14-day free trial started.',
          token,
          user: { id: user.id, name: user.name, email: user.email, role, orgId, orgName, pharmacyId, plan: selectedPlan },
        });
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        return err(res, 500, 'SERVER_ERROR', 'Registration failed: ' + e.message);
      } finally {
        client.release();
      }
    }
  );

  app.post(
    '/api/auth/login',
    rateLimit({ max: 5, windowMs: 15 * 60 * 1000, message: 'Too many login attempts. Try again in 15 minutes.' }),
    async (req, res) => {
      const { email, password } = req.body;
      if (!email)    return err(res, 400, 'VALIDATION_REQUIRED', 'Email is required', 'email');
      if (!password) return err(res, 400, 'VALIDATION_REQUIRED', 'Password is required', 'password');
      try {
        const result = await query(
          `SELECT u.id,u.name,u.email,u.password_hash,u.role,u.organisation_id,u.pharmacy_id,u.is_active,
                  o.name as org_name,o.plan,p.name as pharmacy_name
           FROM users u
           JOIN organisations o ON o.id=u.organisation_id
           LEFT JOIN pharmacies p ON p.id=u.pharmacy_id
           WHERE u.email=$1`,
          [email.toLowerCase()]
        );
        if (!result.rows.length) return err(res, 401, 'AUTH_NOT_FOUND', 'No account found with this email', 'email');
        const user = result.rows[0];
        if (!user.is_active) return err(res, 403, 'AUTH_SUSPENDED', 'Account suspended. Contact support.');
        const valid = await compare(password, user.password_hash);
        if (!valid) return err(res, 401, 'AUTH_BAD_PASSWORD', 'Incorrect password', 'password');

        let resolvedPharmacyId   = user.pharmacy_id;
        let resolvedPharmacyName = user.pharmacy_name;

        // FIX: if user has no pharmacy_id, fall back to the head-office pharmacy
        // of their organisation. This covers staff created without an explicit
        // pharmacy assignment.
        if (!resolvedPharmacyId) {
          const fb = await query(
            `SELECT id,name FROM pharmacies WHERE organisation_id=$1 AND is_active=true ORDER BY is_head_office DESC,id ASC LIMIT 1`,
            [user.organisation_id]
          );
          if (fb.rows.length) {
            resolvedPharmacyId   = fb.rows[0].id;
            resolvedPharmacyName = fb.rows[0].name;
            // Persist the resolved pharmacy so future logins are immediate
            await query(`UPDATE users SET pharmacy_id=$1 WHERE id=$2 AND pharmacy_id IS NULL`, [resolvedPharmacyId, user.id]);
          }
        }

        // FIX: normalise role to lowercase in JWT payload so auth middleware
        // and RBAC checks never fail due to mixed-case DB values.
        const role = (user.role || 'staff').toLowerCase();
        const token = sign({ userId: user.id, orgId: user.organisation_id, pharmacyId: resolvedPharmacyId, role });

        res.json({
          token,
          user: {
            id: user.id, name: user.name, email: user.email, role,
            orgId: user.organisation_id, orgName: user.org_name,
            pharmacyId: resolvedPharmacyId, pharmacyName: resolvedPharmacyName, plan: user.plan,
          },
        });
      } catch (e) {
        return err(res, 500, 'SERVER_ERROR', 'Login failed: ' + e.message);
      }
    }
  );

  app.get('/api/auth/me', auth, async (req, res) => {
    try {
      const result = await query(
        `SELECT u.id,u.name,u.email,u.role,u.organisation_id,u.pharmacy_id,
                o.name as org_name,o.plan,p.name as pharmacy_name,p.address,p.is_head_office,
                s.status as sub_status,s.trial_ends_at
         FROM users u
         JOIN organisations o ON o.id=u.organisation_id
         LEFT JOIN pharmacies p ON p.id=u.pharmacy_id
         LEFT JOIN subscriptions s ON s.organisation_id=u.organisation_id
         WHERE u.id=$1 ORDER BY s.created_at DESC LIMIT 1`,
        [req.user.userId]
      );
      if (!result.rows.length) return err(res, 404, 'AUTH_USER_NOT_FOUND', 'User not found');
      const row = result.rows[0];
      // FIX: normalise role in /me response too
      row.role = (row.role || 'staff').toLowerCase();
      res.json({ user: row });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // ============================================================
  // SELF-SERVICE PASSWORD RESET (email-based, via Resend)
  // ============================================================

  // POST /api/auth/forgot-password
  // Always responds with the same generic message whether or not the
  // email exists — this prevents an attacker from using this endpoint
  // to discover which emails are registered on the platform.
  app.post(
    '/api/auth/forgot-password',
    rateLimit({ max: 3, windowMs: 15 * 60 * 1000, message: 'Too many reset requests from this device. Try again in 15 minutes.' }),
    async (req, res) => {
      const { email } = req.body;
      if (!email) return err(res, 400, 'VALIDATION_REQUIRED', 'Email is required', 'email');
      const generic = { message: 'If an account exists with that email, a password reset link has been sent.' };
      try {
        const u = await query(
          `SELECT id, name, email FROM users WHERE email=$1 AND is_active=true`,
          [email.toLowerCase().trim()]
        );
        if (!u.rows.length) return res.json(generic); // don't reveal non-existence
        const user = u.rows[0];

        // Raw token goes only in the email link. Only its SHA-256 hash is
        // stored — mirrors how passwords themselves are never stored raw.
        const rawToken   = crypto.randomBytes(32).toString('hex');
        const tokenHash  = crypto.createHash('sha256').update(rawToken).digest('hex');
        const expiresAt  = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
        const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || null;

        // Invalidate any earlier unused tokens for this user first, so only
        // the most recently requested link can ever be used.
        await query(`UPDATE password_resets SET used_at=NOW() WHERE user_id=$1 AND used_at IS NULL`, [user.id]);
        await query(
          `INSERT INTO password_resets (user_id, token_hash, expires_at, requested_ip) VALUES ($1,$2,$3,$4)`,
          [user.id, tokenHash, expiresAt, ip]
        );

        const appUrl   = process.env.APP_URL || 'https://medvaultv3.vercel.app';
        const resetUrl = `${appUrl}/login.html?resetToken=${rawToken}`;
        const emailResult = await sendEmail({
          to: user.email,
          subject: 'Reset your MedVault password',
          html: passwordResetEmailHtml({ name: user.name, resetUrl }),
          text: `Hi ${user.name}, reset your MedVault password here (expires in 1 hour, single use): ${resetUrl}\n\nIf you didn't request this, you can ignore this email.`,
        });
        if (!emailResult.sent) {
          // Not fatal to the request (still return generic success — see
          // comment above), but must be visible in logs/audit for support
          // to catch a broken Resend key etc. If this keeps failing, the
          // admin manual reset (POST /api/admin/users/:id/reset-password)
          // is the fallback path.
          console.error(`[auth] Password reset email failed for user ${user.id} (${user.email}):`, emailResult.reason);
        }

        await audit(query, {
          req, action: 'auth.password_reset_requested', entity: 'user', entityId: user.id,
          payload: { email: user.email, email_sent: emailResult.sent, email_fail_reason: emailResult.sent ? null : emailResult.reason },
        });

        return res.json(generic);
      } catch (e) {
        return err(res, 500, 'SERVER_ERROR', e.message);
      }
    }
  );

  // POST /api/auth/reset-password
  app.post(
    '/api/auth/reset-password',
    rateLimit({ max: 8, windowMs: 15 * 60 * 1000, message: 'Too many attempts. Try again in 15 minutes.' }),
    async (req, res) => {
      const { token, password } = req.body;
      if (!token)    return err(res, 400, 'VALIDATION_REQUIRED', 'Reset token is required', 'token');
      if (!password || password.length < 6)
        return err(res, 400, 'VALIDATION_REQUIRED', 'Password must be at least 6 characters', 'password');
      try {
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const r = await query(
          `SELECT pr.id, pr.user_id, u.email
           FROM password_resets pr JOIN users u ON u.id = pr.user_id
           WHERE pr.token_hash=$1 AND pr.used_at IS NULL AND pr.expires_at > NOW()`,
          [tokenHash]
        );
        if (!r.rows.length)
          return err(res, 400, 'AUTH_RESET_INVALID', 'This reset link is invalid or has expired. Please request a new one.');
        const resetRow = r.rows[0];

        const pwHash = await hash(password);
        await query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [pwHash, resetRow.user_id]);
        // Mark used, and defensively invalidate any other outstanding
        // tokens for this user (e.g. if they requested the email twice).
        await query(`UPDATE password_resets SET used_at=NOW() WHERE user_id=$1 AND used_at IS NULL`, [resetRow.user_id]);

        await audit(query, {
          req, action: 'auth.password_reset_completed', entity: 'user', entityId: resetRow.user_id,
          payload: { email: resetRow.email },
        });

        res.json({ message: '✅ Password reset successfully. You can now log in with your new password.' });
      } catch (e) {
        return err(res, 500, 'SERVER_ERROR', e.message);
      }
    }
  );
};
