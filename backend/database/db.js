'use strict';

// ============================================================
// MedVault Database — uses pg (PostgreSQL driver)
// DATABASE_URL is read from process.env — never hardcoded
// ============================================================

let pool;

function getPool() {
  if (pool) return pool;
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  pool.on('error', (err) => {
    console.error('DB pool error:', err.message);
  });
  return pool;
}

async function query(sql, params = []) {
  const p = getPool();
  const result = await p.query(sql, params);
  return { rows: result.rows, rowCount: result.rowCount };
}

async function runMigrations() {
  console.log('🔄 Running migrations...');
  const stmts = [
    `CREATE TABLE IF NOT EXISTS organisations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      owner_name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      phone VARCHAR(50) NOT NULL,
      plan VARCHAR(50) NOT NULL DEFAULT 'single',
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS pharmacies (
      id SERIAL PRIMARY KEY,
      organisation_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      address VARCHAR(500),
      phone VARCHAR(50),
      is_head_office BOOLEAN NOT NULL DEFAULT false,
      is_active BOOLEAN NOT NULL DEFAULT true,
      nda_number VARCHAR(100),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      organisation_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      pharmacy_id INTEGER REFERENCES pharmacies(id) ON DELETE SET NULL,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL DEFAULT 'staff',
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      organisation_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      plan VARCHAR(50) NOT NULL DEFAULT 'single',
      branch_count INTEGER NOT NULL DEFAULT 1,
      amount_ugx INTEGER NOT NULL DEFAULT 50000,
      status VARCHAR(50) NOT NULL DEFAULT 'trial',
      trial_ends_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '14 days'),
      next_billing TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS drugs (
      id SERIAL PRIMARY KEY,
      pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      generic_name VARCHAR(255),
      category VARCHAR(100) DEFAULT 'General',
      quantity INTEGER NOT NULL DEFAULT 0,
      max_quantity INTEGER NOT NULL DEFAULT 0,
      unit_price NUMERIC(12,2) NOT NULL DEFAULT 0,
      cost_price NUMERIC(12,2) NOT NULL DEFAULT 0,
      threshold INTEGER NOT NULL DEFAULT 20,
      expiry_date DATE,
      supplier VARCHAR(255),
      barcode VARCHAR(100),
      requires_rx BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY,
      pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id),
      receipt_number VARCHAR(50) UNIQUE NOT NULL,
      customer_name VARCHAR(255) DEFAULT 'Walk-in',
      customer_phone VARCHAR(50),
      subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
      discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
      discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      payment_method VARCHAR(50) NOT NULL DEFAULT 'cash',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS sale_items (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      drug_id INTEGER REFERENCES drugs(id) ON DELETE SET NULL,
      drug_name VARCHAR(255) NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price NUMERIC(12,2) NOT NULL,
      total_price NUMERIC(12,2) NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      customer_name VARCHAR(255) NOT NULL,
      customer_phone VARCHAR(50) NOT NULL,
      delivery_address VARCHAR(500),
      delivery_type VARCHAR(50) DEFAULT 'delivery',
      payment_method VARCHAR(50) DEFAULT 'cash',
      total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      order_status VARCHAR(50) NOT NULL DEFAULT 'pending',
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      drug_id INTEGER REFERENCES drugs(id) ON DELETE SET NULL,
      drug_name VARCHAR(255) NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price NUMERIC(12,2) NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      phone VARCHAR(50),
      email VARCHAR(255),
      total_spent NUMERIC(12,2) NOT NULL DEFAULT 0,
      visit_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS stock_transfers (
      id SERIAL PRIMARY KEY,
      organisation_id INTEGER NOT NULL REFERENCES organisations(id),
      from_pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
      to_pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
      drug_id INTEGER NOT NULL REFERENCES drugs(id),
      drug_name VARCHAR(255) NOT NULL,
      quantity INTEGER NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      requested_by INTEGER REFERENCES users(id),
      approved_by INTEGER REFERENCES users(id),
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_drugs_pharmacy  ON drugs(pharmacy_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sales_pharmacy  ON sales(pharmacy_id)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_pharmacy ON orders(pharmacy_id)`,
    `CREATE INDEX IF NOT EXISTS idx_users_email     ON users(email)`,
    `CREATE INDEX IF NOT EXISTS idx_pharmacies_org  ON pharmacies(organisation_id)`,
    `CREATE TABLE IF NOT EXISTS credit_sales (
      id                SERIAL PRIMARY KEY,
      pharmacy_id       INTEGER       NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      user_id           INTEGER       REFERENCES users(id),
      customer_name     VARCHAR(255)  NOT NULL,
      customer_phone    VARCHAR(50),
      items_description TEXT,
      amount_owed       NUMERIC(12,2) NOT NULL DEFAULT 0,
      amount_paid       NUMERIC(12,2) NOT NULL DEFAULT 0,
      due_date          DATE,
      status            VARCHAR(50)   NOT NULL DEFAULT 'pending',
      notes             TEXT,
      last_reminded     TIMESTAMPTZ,
      paid_at           TIMESTAMPTZ,
      created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_credit_pharmacy ON credit_sales(pharmacy_id)`,
    `CREATE INDEX IF NOT EXISTS idx_credit_status   ON credit_sales(status)`,
  ];

  let ok = 0, warn = 0;
  for (const s of stmts) {
    try { await query(s); ok++; }
    catch(e) { console.warn('Migration warn:', e.message.slice(0,100)); warn++; }
  }
  console.log(`✅ Migrations: ${ok} OK, ${warn} warnings`);
}

async function seedSuperAdmin() {
  try {
    const exists = await query(
      `SELECT id FROM organisations WHERE email = $1`,
      ['admin@medvault.ug']
    );
    if (exists.rows.length > 0) { console.log('✅ Super admin exists'); return; }

    const { hash } = require('../core/password');
    const pw = await hash('MedVault2026!');

    const org = await query(
      `INSERT INTO organisations (name, owner_name, email, phone, plan)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      ['MedVault Platform','Super Admin','admin@medvault.ug','+256700000000','enterprise']
    );
    const oid = org.rows[0].id;

    const ph = await query(
      `INSERT INTO pharmacies (organisation_id, name, address, is_head_office)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [oid,'MedVault HQ','Kampala Uganda',true]
    );
    const pid = ph.rows[0].id;

    await query(
      `INSERT INTO users (organisation_id, pharmacy_id, name, email, password_hash, role)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [oid, pid,'Super Admin','admin@medvault.ug', pw,'super_admin']
    );
    await query(
      `INSERT INTO subscriptions (organisation_id, plan, status) VALUES ($1,$2,$3)`,
      [oid,'enterprise','active']
    );
    console.log('✅ Super admin: admin@medvault.ug / MedVault2026!');
  } catch(e) { console.error('Seed error:', e.message); }
}

async function getNextReceiptNumber(pharmacyId) {
  const r = await query(
    `SELECT COUNT(*) as cnt FROM sales WHERE pharmacy_id = $1`,
    [pharmacyId]
  );
  const n = parseInt(r.rows[0].cnt) + 1;
  return `RCP-${new Date().getFullYear()}-${String(n).padStart(4,'0')}`;
}

module.exports = { query, runMigrations, seedSuperAdmin, getNextReceiptNumber };
