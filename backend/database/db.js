// ============================================================
// MedVault — PostgreSQL Database (Neon.tech)
// Uses process.env.DATABASE_URL — never hardcoded
// Direct TLS connection — no npm packages needed
// ============================================================
'use strict';

const net   = require('net');
const tls   = require('tls');
const https = require('https');

// ── Parse DATABASE_URL ────────────────────────────────────
function parseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL environment variable is not set. Add it in Railway → Variables.');
  const u = new URL(url);
  return {
    host:     u.hostname,
    port:     parseInt(u.port) || 5432,
    database: decodeURIComponent(u.pathname.slice(1)),
    user:     decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    ssl:      true,
  };
}

// ── Neon Serverless HTTP API ───────────────────────────────
// Neon supports a simple HTTP API for running queries
// This avoids needing the pg npm package entirely
async function query(sql, params = []) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const u = new URL(url);
  const host = u.hostname;
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);
  const db   = decodeURIComponent(u.pathname.slice(1));

  // Replace $1, $2 etc with actual values for Neon HTTP API
  let finalSql = sql;
  if (params.length > 0) {
    params.forEach((p, i) => {
      const placeholder = `$${i + 1}`;
      let val;
      if (p === null || p === undefined) {
        val = 'NULL';
      } else if (typeof p === 'boolean') {
        val = p ? 'TRUE' : 'FALSE';
      } else if (typeof p === 'number') {
        val = String(p);
      } else {
        // Escape string — replace single quotes
        val = `'${String(p).replace(/'/g, "''")}'`;
      }
      finalSql = finalSql.replace(placeholder, val);
    });
  }

  return new Promise((resolve, reject) => {
    const credentials = Buffer.from(`${user}:${pass}`).toString('base64');
    const body = JSON.stringify({ query: finalSql });

    const options = {
      hostname: host,
      path:     '/sql',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization':  `Basic ${credentials}`,
        'Neon-Database':  db,
      },
    };

    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          if (res.statusCode !== 200) {
            reject(new Error(`DB error (${res.statusCode}): ${data.message || data.error || raw.slice(0,100)}`));
            return;
          }
          resolve({
            rows:     data.rows     || [],
            rowCount: data.rowCount || (data.rows ? data.rows.length : 0),
          });
        } catch (e) {
          reject(new Error('DB parse error: ' + raw.slice(0, 200)));
        }
      });
    });

    req.on('error', err => reject(new Error('DB connection error: ' + err.message)));
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('DB timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Run all table migrations ───────────────────────────────
async function runMigrations() {
  console.log('🔄 Running database migrations...');

  const tables = [
    `CREATE TABLE IF NOT EXISTS organisations (
      id            SERIAL PRIMARY KEY,
      name          VARCHAR(255) NOT NULL,
      owner_name    VARCHAR(255) NOT NULL,
      email         VARCHAR(255) UNIQUE NOT NULL,
      phone         VARCHAR(50)  NOT NULL,
      plan          VARCHAR(50)  NOT NULL DEFAULT 'single',
      is_active     BOOLEAN      NOT NULL DEFAULT true,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS pharmacies (
      id              SERIAL PRIMARY KEY,
      organisation_id INTEGER      NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      name            VARCHAR(255) NOT NULL,
      address         VARCHAR(500),
      phone           VARCHAR(50),
      is_head_office  BOOLEAN      NOT NULL DEFAULT false,
      is_active       BOOLEAN      NOT NULL DEFAULT true,
      nda_number      VARCHAR(100),
      created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS users (
      id              SERIAL PRIMARY KEY,
      organisation_id INTEGER      NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      pharmacy_id     INTEGER      REFERENCES pharmacies(id) ON DELETE SET NULL,
      name            VARCHAR(255) NOT NULL,
      email           VARCHAR(255) UNIQUE NOT NULL,
      password_hash   VARCHAR(255) NOT NULL,
      role            VARCHAR(50)  NOT NULL DEFAULT 'staff',
      is_active       BOOLEAN      NOT NULL DEFAULT true,
      created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS subscriptions (
      id              SERIAL PRIMARY KEY,
      organisation_id INTEGER      NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      plan            VARCHAR(50)  NOT NULL DEFAULT 'single',
      branch_count    INTEGER      NOT NULL DEFAULT 1,
      amount_ugx      INTEGER      NOT NULL DEFAULT 50000,
      status          VARCHAR(50)  NOT NULL DEFAULT 'trial',
      trial_ends_at   TIMESTAMPTZ  NOT NULL DEFAULT (NOW() + INTERVAL '14 days'),
      next_billing    TIMESTAMPTZ,
      created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS drugs (
      id              SERIAL PRIMARY KEY,
      pharmacy_id     INTEGER       NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      name            VARCHAR(255)  NOT NULL,
      generic_name    VARCHAR(255),
      category        VARCHAR(100)  DEFAULT 'General',
      quantity        INTEGER       NOT NULL DEFAULT 0,
      max_quantity    INTEGER       NOT NULL DEFAULT 0,
      unit_price      NUMERIC(12,2) NOT NULL DEFAULT 0,
      cost_price      NUMERIC(12,2) NOT NULL DEFAULT 0,
      threshold       INTEGER       NOT NULL DEFAULT 20,
      expiry_date     DATE,
      supplier        VARCHAR(255),
      barcode         VARCHAR(100),
      requires_rx     BOOLEAN       NOT NULL DEFAULT false,
      created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS sales (
      id              SERIAL PRIMARY KEY,
      pharmacy_id     INTEGER       NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      user_id         INTEGER       REFERENCES users(id),
      receipt_number  VARCHAR(50)   UNIQUE NOT NULL,
      customer_name   VARCHAR(255)  DEFAULT 'Walk-in',
      customer_phone  VARCHAR(50),
      subtotal        NUMERIC(12,2) NOT NULL DEFAULT 0,
      discount_pct    NUMERIC(5,2)  NOT NULL DEFAULT 0,
      discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      total_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
      payment_method  VARCHAR(50)   NOT NULL DEFAULT 'cash',
      created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS sale_items (
      id          SERIAL PRIMARY KEY,
      sale_id     INTEGER       NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      drug_id     INTEGER       REFERENCES drugs(id) ON DELETE SET NULL,
      drug_name   VARCHAR(255)  NOT NULL,
      quantity    INTEGER       NOT NULL,
      unit_price  NUMERIC(12,2) NOT NULL,
      total_price NUMERIC(12,2) NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS orders (
      id               SERIAL PRIMARY KEY,
      pharmacy_id      INTEGER       NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      customer_name    VARCHAR(255)  NOT NULL,
      customer_phone   VARCHAR(50)   NOT NULL,
      delivery_address VARCHAR(500),
      delivery_type    VARCHAR(50)   DEFAULT 'delivery',
      payment_method   VARCHAR(50)   DEFAULT 'cash',
      total_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
      order_status     VARCHAR(50)   NOT NULL DEFAULT 'pending',
      notes            TEXT,
      created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS order_items (
      id          SERIAL PRIMARY KEY,
      order_id    INTEGER       NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      drug_id     INTEGER       REFERENCES drugs(id) ON DELETE SET NULL,
      drug_name   VARCHAR(255)  NOT NULL,
      quantity    INTEGER       NOT NULL,
      unit_price  NUMERIC(12,2) NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS customers (
      id              SERIAL PRIMARY KEY,
      pharmacy_id     INTEGER       NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      name            VARCHAR(255)  NOT NULL,
      phone           VARCHAR(50),
      email           VARCHAR(255),
      total_spent     NUMERIC(12,2) NOT NULL DEFAULT 0,
      visit_count     INTEGER       NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS stock_transfers (
      id               SERIAL PRIMARY KEY,
      organisation_id  INTEGER       NOT NULL REFERENCES organisations(id),
      from_pharmacy_id INTEGER       NOT NULL REFERENCES pharmacies(id),
      to_pharmacy_id   INTEGER       NOT NULL REFERENCES pharmacies(id),
      drug_id          INTEGER       NOT NULL REFERENCES drugs(id),
      drug_name        VARCHAR(255)  NOT NULL,
      quantity         INTEGER       NOT NULL,
      status           VARCHAR(50)   NOT NULL DEFAULT 'pending',
      requested_by     INTEGER       REFERENCES users(id),
      approved_by      INTEGER       REFERENCES users(id),
      notes            TEXT,
      created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )`,

    `CREATE INDEX IF NOT EXISTS idx_drugs_pharmacy  ON drugs(pharmacy_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sales_pharmacy  ON sales(pharmacy_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sales_created   ON sales(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_pharmacy ON orders(pharmacy_id)`,
    `CREATE INDEX IF NOT EXISTS idx_users_email     ON users(email)`,
    `CREATE INDEX IF NOT EXISTS idx_users_org       ON users(organisation_id)`,
    `CREATE INDEX IF NOT EXISTS idx_pharmacies_org  ON pharmacies(organisation_id)`,
  ];

  let ok = 0, warn = 0;
  for (const sql of tables) {
    try {
      await query(sql);
      ok++;
    } catch (e) {
      console.warn('Migration warning:', e.message.slice(0, 100));
      warn++;
    }
  }
  console.log(`✅ Migrations: ${ok} OK, ${warn} warnings`);
}

// ── Seed super admin ──────────────────────────────────────
async function seedSuperAdmin() {
  try {
    const exists = await query(
      `SELECT id FROM organisations WHERE email = 'admin@medvault.ug'`
    );
    if (exists.rows.length > 0) {
      console.log('✅ Super admin already exists');
      return;
    }

    const { hash } = require('../core/password');
    const pwHash = await hash('MedVault2026!');

    const org = await query(
      `INSERT INTO organisations (name, owner_name, email, phone, plan)
       VALUES ('MedVault Platform', 'Super Admin', 'admin@medvault.ug', '+256700000000', 'enterprise')
       RETURNING id`
    );
    const orgId = org.rows[0].id;

    const pharma = await query(
      `INSERT INTO pharmacies (organisation_id, name, address, is_head_office)
       VALUES (${orgId}, 'MedVault HQ', 'Kampala, Uganda', TRUE)
       RETURNING id`
    );
    const pharmacyId = pharma.rows[0].id;

    await query(
      `INSERT INTO users (organisation_id, pharmacy_id, name, email, password_hash, role)
       VALUES (${orgId}, ${pharmacyId}, 'Super Admin', 'admin@medvault.ug', '${pwHash}', 'super_admin')`
    );

    await query(
      `INSERT INTO subscriptions (organisation_id, plan, status)
       VALUES (${orgId}, 'enterprise', 'active')`
    );

    console.log('✅ Super admin created: admin@medvault.ug / MedVault2026!');
  } catch (e) {
    console.error('Seed error:', e.message);
  }
}

// ── Receipt number helper ─────────────────────────────────
async function getNextReceiptNumber(pharmacyId) {
  const res = await query(
    `SELECT COUNT(*) as cnt FROM sales WHERE pharmacy_id = ${pharmacyId}`
  );
  const n    = parseInt(res.rows[0].cnt) + 1;
  const year = new Date().getFullYear();
  return `RCP-${year}-${String(n).padStart(4, '0')}`;
}

module.exports = { query, runMigrations, seedSuperAdmin, getNextReceiptNumber };
