'use strict';

// ============================================================
// MedVault Database — PostgreSQL
// ============================================================

let pool;

function getPool() {
  if (pool) return pool;

  const { Pool } = require('pg');

  const connStr = process.env.DATABASE_URL || '';

  const cleanConn = connStr.includes('sslmode=')
    ? connStr.replace(/sslmode=[^&]+/, 'sslmode=verify-full')
    : connStr + (connStr.includes('?') ? '&' : '?') + 'sslmode=verify-full';

  pool = new Pool({
    connectionString: cleanConn,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
  });

  pool.on('error', (err) => {
    console.error('DB pool error:', err.message);
  });

  return pool;
}

async function query(sql, params = []) {
  const p = getPool();
  const result = await p.query(sql, params);

  return {
    rows: result.rows,
    rowCount: result.rowCount,
  };
}

async function runMigrations() {
  console.log('🔄 Running migrations...');

  const stmts = [

    // =========================================================
    // ORGANISATIONS
    // =========================================================

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

    // =========================================================
    // PHARMACIES
    // =========================================================

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

    // =========================================================
    // USERS
    // =========================================================

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

    // =========================================================
    // SUBSCRIPTIONS
    // =========================================================

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

    // =========================================================
    // DRUGS
    // =========================================================

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
      sku VARCHAR(100),
      requires_rx BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    // =========================================================
    // DRUG BATCHES
    // =========================================================

    `CREATE TABLE IF NOT EXISTS drug_batches (
      id SERIAL PRIMARY KEY,
      drug_id INTEGER NOT NULL REFERENCES drugs(id) ON DELETE CASCADE,
      pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      batch_number VARCHAR(100) NOT NULL,
      expiry_date DATE NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0,
      cost_price NUMERIC(12,2) DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    // =========================================================
    // SALES
    // =========================================================

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

    // =========================================================
    // SALE ITEMS
    // =========================================================

    `CREATE TABLE IF NOT EXISTS sale_items (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      drug_id INTEGER REFERENCES drugs(id) ON DELETE SET NULL,
      drug_name VARCHAR(255) NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price NUMERIC(12,2) NOT NULL,
      total_price NUMERIC(12,2) NOT NULL
    )`,

    // =========================================================
    // ORDERS
    // =========================================================

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

    // =========================================================
    // ORDER ITEMS
    // =========================================================

    `CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      drug_id INTEGER REFERENCES drugs(id) ON DELETE SET NULL,
      drug_name VARCHAR(255) NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price NUMERIC(12,2) NOT NULL
    )`,

    // =========================================================
    // CUSTOMERS
    // =========================================================

    `CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      phone VARCHAR(50),
      email VARCHAR(255),
      notes TEXT,
      total_spent NUMERIC(12,2) NOT NULL DEFAULT 0,
      visit_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    // =========================================================
    // STOCK TRANSFERS
    // =========================================================

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

    // =========================================================
    // CREDIT SALES
    // =========================================================

    `CREATE TABLE IF NOT EXISTS credit_sales (
      id SERIAL PRIMARY KEY,
      pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id),
      customer_name VARCHAR(255) NOT NULL,
      customer_phone VARCHAR(50),
      items_description TEXT,
      amount_owed NUMERIC(12,2) NOT NULL DEFAULT 0,
      amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0,
      due_date DATE,
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      notes TEXT,
      last_reminded TIMESTAMPTZ,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    // =========================================================
    // INDEXES
    // =========================================================

    `CREATE INDEX IF NOT EXISTS idx_drugs_pharmacy ON drugs(pharmacy_id)`,

    `CREATE INDEX IF NOT EXISTS idx_sales_pharmacy ON sales(pharmacy_id)`,

    `CREATE INDEX IF NOT EXISTS idx_orders_pharmacy ON orders(pharmacy_id)`,

    `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,

    `CREATE INDEX IF NOT EXISTS idx_pharmacies_org ON pharmacies(organisation_id)`,

    `CREATE INDEX IF NOT EXISTS idx_credit_pharmacy ON credit_sales(pharmacy_id)`,

    `CREATE INDEX IF NOT EXISTS idx_credit_status ON credit_sales(status)`,

    `CREATE INDEX IF NOT EXISTS idx_batches_expiry ON drug_batches(expiry_date)`,

    `CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_batch ON drug_batches(drug_id, batch_number)`,

    // Add updated_at to customers if missing (safe to run multiple times)
    `ALTER TABLE customers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,

    // Add notes column to customers if missing
    `ALTER TABLE customers ADD COLUMN IF NOT EXISTS notes TEXT`,

    // Add email column to customers if missing
    `ALTER TABLE customers ADD COLUMN IF NOT EXISTS email VARCHAR(255)`,

    // Add idx for customers
    `CREATE INDEX IF NOT EXISTS idx_customers_pharmacy ON customers(pharmacy_id)`,

    // =========================================================
    // PHASE 1 — STABILISATION MIGRATIONS
    // =========================================================

    // Receipt counter — atomic increment replaces COUNT(*) race condition
    `ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS receipt_counter INTEGER DEFAULT 0`,

    // Tracking columns on drugs and sales
    `ALTER TABLE drugs ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES users(id)`,
    `ALTER TABLE sales ADD COLUMN IF NOT EXISTS voided BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE sales ADD COLUMN IF NOT EXISTS voided_by INTEGER REFERENCES users(id)`,
    `ALTER TABLE sales ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ`,

    // =========================================================
    // AUDIT LOGS — healthcare compliance requirement
    // =========================================================
    `CREATE TABLE IF NOT EXISTS audit_logs (
      id          BIGSERIAL PRIMARY KEY,
      org_id      INTEGER NOT NULL,
      pharmacy_id INTEGER,
      user_id     INTEGER,
      action      VARCHAR(100) NOT NULL,
      entity      VARCHAR(100),
      entity_id   VARCHAR(100),
      payload     JSONB,
      ip_address  VARCHAR(50),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_audit_org      ON audit_logs(org_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_pharmacy  ON audit_logs(pharmacy_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_entity    ON audit_logs(entity, entity_id)`,

    // =========================================================
    // NOTIFICATIONS
    // =========================================================
    `CREATE TABLE IF NOT EXISTS notifications (
      id          SERIAL PRIMARY KEY,
      org_id      INTEGER NOT NULL,
      pharmacy_id INTEGER,
      user_id     INTEGER,
      type        VARCHAR(100) NOT NULL,
      title       VARCHAR(255) NOT NULL,
      body        TEXT,
      data        JSONB,
      is_read     BOOLEAN NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_notif_user    ON notifications(user_id, is_read, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_notif_pharmacy ON notifications(pharmacy_id, created_at DESC)`,

    // =========================================================
    // SUPPLIERS
    // =========================================================
    `CREATE TABLE IF NOT EXISTS suppliers (
      id            SERIAL PRIMARY KEY,
      org_id        INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      name          VARCHAR(255) NOT NULL,
      contact_name  VARCHAR(255),
      phone         VARCHAR(50),
      email         VARCHAR(255),
      address       TEXT,
      payment_terms VARCHAR(100),
      is_active     BOOLEAN NOT NULL DEFAULT true,
      notes         TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_suppliers_org ON suppliers(org_id)`,

    // Link supplier_id to drugs table
    `ALTER TABLE drugs ADD COLUMN IF NOT EXISTS supplier_id INTEGER REFERENCES suppliers(id)`,

    // =========================================================
    // STOCK ADJUSTMENTS
    // =========================================================
    `CREATE TABLE IF NOT EXISTS stock_adjustments (
      id              SERIAL PRIMARY KEY,
      pharmacy_id     INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      drug_id         INTEGER NOT NULL REFERENCES drugs(id) ON DELETE CASCADE,
      user_id         INTEGER REFERENCES users(id),
      type            VARCHAR(50) NOT NULL,
      quantity_before INTEGER NOT NULL,
      quantity_after  INTEGER NOT NULL,
      variance        INTEGER NOT NULL,
      reason          TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_adjustments_pharmacy ON stock_adjustments(pharmacy_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_adjustments_drug     ON stock_adjustments(drug_id)`,

    // =========================================================
    // PERFORMANCE INDEXES — Phase 1
    // =========================================================
    `CREATE INDEX IF NOT EXISTS idx_sales_created   ON sales(pharmacy_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_drugs_name      ON drugs(pharmacy_id, name)`,
    `CREATE INDEX IF NOT EXISTS idx_drugs_expiry    ON drugs(pharmacy_id, expiry_date)`,
    `CREATE INDEX IF NOT EXISTS idx_drugs_category  ON drugs(pharmacy_id, category)`,
    `CREATE INDEX IF NOT EXISTS idx_sale_items_drug ON sale_items(drug_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id)`,
    `CREATE INDEX IF NOT EXISTS idx_users_org       ON users(organisation_id, role)`,
    `CREATE INDEX IF NOT EXISTS idx_transfers_org   ON stock_transfers(organisation_id, status)`

  ];

  let ok = 0;
  let warn = 0;

  for (const s of stmts) {
    try {
      await query(s);
      ok++;
    } catch (e) {
      console.warn('Migration warn:', e.message.slice(0, 100));
      warn++;
    }
  }

  console.log(`✅ Migrations: ${ok} OK, ${warn} warnings`);
}

async function seedSuperAdmin() {
  try {
    const exists = await query(
      `SELECT id FROM organisations WHERE email = $1`,
      ['admin@medvault.ug']
    );

    if (exists.rows.length > 0) {
      console.log('✅ Super admin exists');
      return;
    }

    const { hash } = require('../core/password');

    const pw = await hash('MedVault2026!');

    const org = await query(
      `INSERT INTO organisations
      (name, owner_name, email, phone, plan)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING id`,
      [
        'MedVault Platform',
        'Super Admin',
        'admin@medvault.ug',
        '+256700000000',
        'enterprise'
      ]
    );

    const oid = org.rows[0].id;

    const ph = await query(
      `INSERT INTO pharmacies
      (organisation_id, name, address, is_head_office)
      VALUES ($1,$2,$3,$4)
      RETURNING id`,
      [
        oid,
        'MedVault HQ',
        'Kampala Uganda',
        true
      ]
    );

    const pid = ph.rows[0].id;

    await query(
      `INSERT INTO users
      (organisation_id, pharmacy_id, name, email, password_hash, role)
      VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        oid,
        pid,
        'Super Admin',
        'admin@medvault.ug',
        pw,
        'super_admin'
      ]
    );

    await query(
      `INSERT INTO subscriptions
      (organisation_id, plan, status)
      VALUES ($1,$2,$3)`,
      [
        oid,
        'enterprise',
        'active'
      ]
    );

    console.log('✅ Super admin: admin@medvault.ug / MedVault2026!');

  } catch (e) {
    console.error('Seed error:', e.message);
  }
}

async function getNextReceiptNumber(pharmacyId, client) {
  // ✅ FIXED: Atomic counter — no race condition under concurrent sales
  // Uses UPDATE...RETURNING to atomically increment and read in one query.
  // If client is provided (inside a transaction), use it; otherwise use pool.
  const executor = client || { query: (sql, params) => query(sql, params) };
  const r = await executor.query(
    `UPDATE pharmacies
     SET receipt_counter = COALESCE(receipt_counter, 0) + 1
     WHERE id = $1
     RETURNING receipt_counter`,
    [pharmacyId]
  );
  const n = r.rows[0].receipt_counter;
  return `RCP-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`;
}

module.exports = {
  query,
  getPool,
  runMigrations,
  seedSuperAdmin,
  getNextReceiptNumber,
};
