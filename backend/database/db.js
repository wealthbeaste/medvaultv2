// ============================================================
// MedVault — PostgreSQL Database (Neon.tech)
// Uses process.env.DATABASE_URL — never hardcoded
// ============================================================
'use strict';

const https = require('https');
const { URL } = require('url');

// ── Parse connection string from environment ───────────────
function getDbConfig() {
  const connStr = process.env.DATABASE_URL;
  if (!connStr) {
    throw new Error('DATABASE_URL environment variable is not set. Add it in Railway → Variables.');
  }
  const u = new URL(connStr);
  return {
    host:     u.hostname,
    port:     parseInt(u.port) || 5432,
    database: u.pathname.slice(1),
    user:     u.username,
    password: u.password,
    ssl:      true,
  };
}

// ── Minimal PostgreSQL wire protocol client ────────────────
// Uses Node.js built-ins only — no npm packages needed
// This sends queries to Neon's HTTP API endpoint

async function query(sql, params = []) {
  const connStr = process.env.DATABASE_URL;
  if (!connStr) throw new Error('DATABASE_URL not set');

  // Use Neon's HTTP API — works without pg npm package
  const u = new URL(connStr);
  const neonHttpUrl = `https://${u.hostname}/sql`;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query: sql, params });
    const options = {
      hostname: u.hostname,
      path: '/sql',
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization':  'Bearer ' + u.password,
        'Neon-Connection-String': connStr,
      },
    };

    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          if (data.error || data.message) {
            // Neon HTTP error
            reject(new Error(data.error || data.message));
          } else {
            resolve({
              rows:    data.rows    || [],
              rowCount: data.rowCount || (data.rows ? data.rows.length : 0),
            });
          }
        } catch (e) {
          reject(new Error('DB parse error: ' + raw.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Run multiple statements (for migrations) ──────────────
async function runMigrations() {
  console.log('🔄 Running database migrations...');

  const statements = [

    // ── ORGANISATIONS (pharmacy chains / companies) ────────
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

    // ── PHARMACIES (branches belong to an organisation) ────
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

    // ── USERS (staff accounts, scoped to a pharmacy) ───────
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

    // ── SUBSCRIPTIONS ──────────────────────────────────────
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

    // ── DRUGS (inventory per pharmacy/branch) ─────────────
    `CREATE TABLE IF NOT EXISTS drugs (
      id              SERIAL PRIMARY KEY,
      pharmacy_id     INTEGER      NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      name            VARCHAR(255) NOT NULL,
      generic_name    VARCHAR(255),
      category        VARCHAR(100),
      quantity        INTEGER      NOT NULL DEFAULT 0,
      max_quantity    INTEGER      NOT NULL DEFAULT 0,
      unit_price      NUMERIC(12,2) NOT NULL DEFAULT 0,
      cost_price      NUMERIC(12,2) NOT NULL DEFAULT 0,
      threshold       INTEGER      NOT NULL DEFAULT 20,
      expiry_date     DATE,
      supplier        VARCHAR(255),
      barcode         VARCHAR(100),
      requires_rx     BOOLEAN      NOT NULL DEFAULT false,
      created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`,

    // ── SALES ──────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS sales (
      id              SERIAL PRIMARY KEY,
      pharmacy_id     INTEGER      NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      user_id         INTEGER      REFERENCES users(id),
      receipt_number  VARCHAR(50)  UNIQUE NOT NULL,
      customer_name   VARCHAR(255) DEFAULT 'Walk-in',
      customer_phone  VARCHAR(50),
      subtotal        NUMERIC(12,2) NOT NULL DEFAULT 0,
      discount_pct    NUMERIC(5,2)  NOT NULL DEFAULT 0,
      discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      total_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
      payment_method  VARCHAR(50)   NOT NULL DEFAULT 'cash',
      created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )`,

    // ── SALE ITEMS ─────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS sale_items (
      id          SERIAL PRIMARY KEY,
      sale_id     INTEGER       NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      drug_id     INTEGER       REFERENCES drugs(id) ON DELETE SET NULL,
      drug_name   VARCHAR(255)  NOT NULL,
      quantity    INTEGER       NOT NULL,
      unit_price  NUMERIC(12,2) NOT NULL,
      total_price NUMERIC(12,2) NOT NULL
    )`,

    // ── ORDERS (customer-facing online orders) ─────────────
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

    // ── ORDER ITEMS ────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS order_items (
      id          SERIAL PRIMARY KEY,
      order_id    INTEGER       NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      drug_id     INTEGER       REFERENCES drugs(id) ON DELETE SET NULL,
      drug_name   VARCHAR(255)  NOT NULL,
      quantity    INTEGER       NOT NULL,
      unit_price  NUMERIC(12,2) NOT NULL
    )`,

    // ── CUSTOMERS ──────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS customers (
      id              SERIAL PRIMARY KEY,
      pharmacy_id     INTEGER      NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      name            VARCHAR(255) NOT NULL,
      phone           VARCHAR(50),
      email           VARCHAR(255),
      total_spent     NUMERIC(12,2) NOT NULL DEFAULT 0,
      visit_count     INTEGER       NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )`,

    // ── STOCK TRANSFERS (between branches) ─────────────────
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

    // ── INDEXES for performance ────────────────────────────
    `CREATE INDEX IF NOT EXISTS idx_drugs_pharmacy     ON drugs(pharmacy_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sales_pharmacy     ON sales(pharmacy_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sales_created      ON sales(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_pharmacy    ON orders(pharmacy_id)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_status      ON orders(order_status)`,
    `CREATE INDEX IF NOT EXISTS idx_users_email        ON users(email)`,
    `CREATE INDEX IF NOT EXISTS idx_users_org          ON users(organisation_id)`,
    `CREATE INDEX IF NOT EXISTS idx_pharmacies_org     ON pharmacies(organisation_id)`,
    `CREATE INDEX IF NOT EXISTS idx_transfers_org      ON stock_transfers(organisation_id)`,
  ];

  let success = 0;
  let failed  = 0;

  for (const sql of statements) {
    try {
      await query(sql);
      success++;
    } catch (e) {
      // Log but don't crash — some may already exist
      console.warn('Migration warning:', e.message.slice(0, 80));
      failed++;
    }
  }

  console.log(`✅ Migrations complete: ${success} OK, ${failed} warnings`);
  return { success, failed };
}

// ── Seed initial super admin account ──────────────────────
async function seedSuperAdmin() {
  try {
    // Check if already seeded
    const existing = await query(
      `SELECT id FROM organisations WHERE email = $1`,
      ['admin@medvault.ug']
    );
    if (existing.rows.length > 0) {
      console.log('✅ Super admin already exists');
      return;
    }

    const { hash } = require('../core/password');
    const pwHash = await hash('MedVault2026!');

    // Create MedVault organisation (the platform itself)
    const org = await query(
      `INSERT INTO organisations (name, owner_name, email, phone, plan)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      ['MedVault Platform', 'Super Admin', 'admin@medvault.ug', '+256700000000', 'enterprise']
    );
    const orgId = org.rows[0].id;

    // Create HQ pharmacy
    const pharma = await query(
      `INSERT INTO pharmacies (organisation_id, name, address, is_head_office)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [orgId, 'MedVault HQ', 'Kampala, Uganda', true]
    );
    const pharmacyId = pharma.rows[0].id;

    // Create super admin user
    await query(
      `INSERT INTO users (organisation_id, pharmacy_id, name, email, password_hash, role)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [orgId, pharmacyId, 'Super Admin', 'admin@medvault.ug', pwHash, 'super_admin']
    );

    // Create subscription
    await query(
      `INSERT INTO subscriptions (organisation_id, plan, status)
       VALUES ($1,$2,$3)`,
      [orgId, 'enterprise', 'active']
    );

    console.log('✅ Super admin seeded: admin@medvault.ug / MedVault2026!');
  } catch (e) {
    console.error('Seed error:', e.message);
  }
}

// ── Helper: get receipt number ─────────────────────────────
async function getNextReceiptNumber(pharmacyId) {
  const res = await query(
    `SELECT COUNT(*) as cnt FROM sales WHERE pharmacy_id = $1`,
    [pharmacyId]
  );
  const n = parseInt(res.rows[0].cnt) + 1;
  const year = new Date().getFullYear();
  return `RCP-${year}-${String(n).padStart(4, '0')}`;
}

module.exports = {
  query,
  runMigrations,
  seedSuperAdmin,
  getNextReceiptNumber,
};
