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

    // ── STEP 2: Receipt counter — atomic, race-condition-free receipt numbers ─
    `ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS receipt_counter INTEGER NOT NULL DEFAULT 0`,

    // Back-fill: find the highest sequential number already embedded in any
    // existing receipt_number for this pharmacy (pattern RCP-YYYY-NNNN).
    // Using MAX of the numeric suffix means the next increment is always 1
    // higher than any receipt that was ever issued — no collisions possible.
    `UPDATE pharmacies p
       SET receipt_counter = COALESCE((
         SELECT MAX(
           CAST(
             NULLIF(REGEXP_REPLACE(s.receipt_number, '.*-', ''), '') AS INTEGER
           )
         )
         FROM sales s
         WHERE s.pharmacy_id = p.id
       ), 0)
       WHERE receipt_counter = 0`,

    // =========================================================
    // NOTIFICATIONS
    // =========================================================

    `CREATE TABLE IF NOT EXISTS notifications (
      id          BIGSERIAL PRIMARY KEY,
      org_id      INTEGER REFERENCES organisations(id) ON DELETE CASCADE,
      pharmacy_id INTEGER REFERENCES pharmacies(id) ON DELETE CASCADE,
      type        VARCHAR(50) NOT NULL,
      title       VARCHAR(255) NOT NULL,
      body        TEXT,
      data        JSONB,
      is_read     BOOLEAN NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    `CREATE INDEX IF NOT EXISTS idx_notifications_pharmacy
       ON notifications(pharmacy_id, is_read, created_at DESC)`,

    `CREATE INDEX IF NOT EXISTS idx_notifications_org
       ON notifications(org_id, is_read, created_at DESC)`,

    // =========================================================
    // AUDIT LOGS
    // =========================================================

    `CREATE TABLE IF NOT EXISTS audit_logs (
      id          BIGSERIAL PRIMARY KEY,
      org_id      INTEGER,
      pharmacy_id INTEGER,
      user_id     INTEGER,
      action      VARCHAR(100) NOT NULL,
      entity      VARCHAR(100),
      entity_id   VARCHAR(100),
      payload     JSONB,
      ip_address  VARCHAR(50),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    `CREATE INDEX IF NOT EXISTS idx_audit_pharmacy
       ON audit_logs(pharmacy_id, created_at DESC)`,

    // =========================================================
    // SUPPLIERS
    // =========================================================

    `CREATE TABLE IF NOT EXISTS suppliers (
      id           SERIAL PRIMARY KEY,
      org_id       INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      name         VARCHAR(255) NOT NULL,
      contact_name VARCHAR(255),
      phone        VARCHAR(50),
      email        VARCHAR(255),
      address      TEXT,
      payment_terms VARCHAR(100),
      notes        TEXT,
      is_active    BOOLEAN NOT NULL DEFAULT true,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    `CREATE INDEX IF NOT EXISTS idx_suppliers_org
       ON suppliers(org_id)`,

    // Add pharmacy_id to suppliers if missing (for pharmacies that existed before this migration)
    `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS pharmacy_id INTEGER REFERENCES pharmacies(id) ON DELETE CASCADE`,

    `CREATE INDEX IF NOT EXISTS idx_suppliers_pharmacy
       ON suppliers(pharmacy_id)`,

    // Link drugs.supplier_id FK

    // ── Phase 1 completion migrations ─────────────────────────────────────

    // stock_adjustments table
    `CREATE TABLE IF NOT EXISTS stock_adjustments (
      id               BIGSERIAL PRIMARY KEY,
      pharmacy_id      INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      drug_id          INTEGER NOT NULL REFERENCES drugs(id) ON DELETE CASCADE,
      user_id          INTEGER REFERENCES users(id),
      type             VARCHAR(50) NOT NULL,
      quantity_before  INTEGER NOT NULL,
      quantity_after   INTEGER NOT NULL,
      variance         INTEGER NOT NULL,
      reason           TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_adj_pharmacy ON stock_adjustments(pharmacy_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_adj_drug     ON stock_adjustments(drug_id)`,

    // daily revenue snapshots for fast analytics
    `CREATE TABLE IF NOT EXISTS daily_revenue_snapshots (
      id           SERIAL PRIMARY KEY,
      pharmacy_id  INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      snapshot_date DATE NOT NULL,
      total_sales  NUMERIC(14,2) NOT NULL DEFAULT 0,
      sale_count   INTEGER NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(pharmacy_id, snapshot_date)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_snapshots_pharmacy ON daily_revenue_snapshots(pharmacy_id, snapshot_date DESC)`,

    // updated_by columns
    `ALTER TABLE drugs ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES users(id)`,
    `ALTER TABLE sales ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES users(id)`,

    // Performance indexes from roadmap
    `CREATE INDEX IF NOT EXISTS idx_sales_created    ON sales(pharmacy_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_drugs_name       ON drugs(pharmacy_id, name)`,
    `CREATE INDEX IF NOT EXISTS idx_drugs_expiry     ON drugs(pharmacy_id, expiry_date)`,
    `CREATE INDEX IF NOT EXISTS idx_drugs_category   ON drugs(pharmacy_id, category)`,
    `CREATE INDEX IF NOT EXISTS idx_sale_items_drug  ON sale_items(drug_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sale_items_sale  ON sale_items(sale_id)`,
    `CREATE INDEX IF NOT EXISTS idx_users_org        ON users(organisation_id, role)`,
    `CREATE INDEX IF NOT EXISTS idx_transfers_org    ON stock_transfers(organisation_id, status)`,

    // Phase 3 foundation: org_type allows gating clinic/hospital features per org
    `ALTER TABLE organisations ADD COLUMN IF NOT EXISTS org_type VARCHAR(50) NOT NULL DEFAULT 'pharmacy'`,

    // =========================================================
    // PHASE 2 — ADVANCED PHARMACY ERP
    // =========================================================

    // ---------------------------------------------------------
    // PRICE LEVELS  (retail, wholesale, staff, insurance, etc.)
    // Must come before drug_prices which references it.
    // ---------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS price_levels (
      id           SERIAL PRIMARY KEY,
      org_id       INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      name         VARCHAR(100) NOT NULL,          -- 'Retail', 'Wholesale', 'Staff', 'Insurance'
      description  TEXT,
      discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0, -- convenience: % off retail (0 = use drug_prices)
      is_default   BOOLEAN NOT NULL DEFAULT false,
      is_active    BOOLEAN NOT NULL DEFAULT true,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    // ---------------------------------------------------------
    // DRUG PRICES  — per-drug override per price level
    // If no row exists for a drug+level, fall back to drugs.unit_price
    // ---------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS drug_prices (
      id             SERIAL PRIMARY KEY,
      drug_id        INTEGER NOT NULL REFERENCES drugs(id) ON DELETE CASCADE,
      price_level_id INTEGER NOT NULL REFERENCES price_levels(id) ON DELETE CASCADE,
      price          NUMERIC(12,2) NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (drug_id, price_level_id)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_drug_prices_drug  ON drug_prices(drug_id)`,
    `CREATE INDEX IF NOT EXISTS idx_drug_prices_level ON drug_prices(price_level_id)`,

    // ---------------------------------------------------------
    // PURCHASE ORDERS
    // ---------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS purchase_orders (
      id           SERIAL PRIMARY KEY,
      org_id       INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      pharmacy_id  INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      supplier_id  INTEGER NOT NULL REFERENCES suppliers(id),
      po_number    VARCHAR(50) UNIQUE NOT NULL,
      status       VARCHAR(50) NOT NULL DEFAULT 'draft',
      -- draft | submitted | partial | received | cancelled
      ordered_at   TIMESTAMPTZ,
      expected_at  DATE,
      notes        TEXT,
      total_cost   NUMERIC(14,2) NOT NULL DEFAULT 0,
      created_by   INTEGER REFERENCES users(id),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS purchase_order_items (
      id                SERIAL PRIMARY KEY,
      po_id             INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      drug_id           INTEGER REFERENCES drugs(id) ON DELETE SET NULL,
      drug_name         VARCHAR(255) NOT NULL,
      quantity_ordered  INTEGER NOT NULL CHECK (quantity_ordered > 0),
      quantity_received INTEGER NOT NULL DEFAULT 0,
      unit_cost         NUMERIC(12,2) NOT NULL DEFAULT 0,
      total_cost        NUMERIC(12,2) NOT NULL DEFAULT 0
    )`,

    `CREATE INDEX IF NOT EXISTS idx_po_pharmacy ON purchase_orders(pharmacy_id, status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_po_supplier ON purchase_orders(supplier_id)`,
    `CREATE INDEX IF NOT EXISTS idx_po_items_po ON purchase_order_items(po_id)`,

    // ---------------------------------------------------------
    // GOODS RECEIVED NOTES (GRN)
    // ---------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS grn (
      id           SERIAL PRIMARY KEY,
      org_id       INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      pharmacy_id  INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      po_id        INTEGER REFERENCES purchase_orders(id) ON DELETE SET NULL,
      supplier_id  INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
      grn_number   VARCHAR(50) UNIQUE NOT NULL,
      received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      received_by  INTEGER REFERENCES users(id),
      invoice_ref  VARCHAR(100),
      total_cost   NUMERIC(14,2) NOT NULL DEFAULT 0,
      notes        TEXT
    )`,

    `CREATE TABLE IF NOT EXISTS grn_items (
      id           SERIAL PRIMARY KEY,
      grn_id       INTEGER NOT NULL REFERENCES grn(id) ON DELETE CASCADE,
      drug_id      INTEGER REFERENCES drugs(id) ON DELETE SET NULL,
      drug_name    VARCHAR(255) NOT NULL,
      batch_number VARCHAR(100),
      expiry_date  DATE,
      quantity     INTEGER NOT NULL CHECK (quantity > 0),
      unit_cost    NUMERIC(12,2) NOT NULL DEFAULT 0,
      total_cost   NUMERIC(12,2) NOT NULL DEFAULT 0
    )`,

    `CREATE INDEX IF NOT EXISTS idx_grn_pharmacy ON grn(pharmacy_id, received_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_grn_po       ON grn(po_id)`,
    `CREATE INDEX IF NOT EXISTS idx_grn_items    ON grn_items(grn_id)`,
    `CREATE INDEX IF NOT EXISTS idx_grn_drug     ON grn_items(drug_id)`,

    // ---------------------------------------------------------
    // ACCOUNTS PAYABLE LEDGER
    // One row per supplier invoice / payment event
    // ---------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS ap_ledger (
      id           SERIAL PRIMARY KEY,
      org_id       INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      pharmacy_id  INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      supplier_id  INTEGER NOT NULL REFERENCES suppliers(id),
      grn_id       INTEGER REFERENCES grn(id) ON DELETE SET NULL,
      type         VARCHAR(50) NOT NULL, -- 'invoice' | 'payment' | 'credit_note'
      reference    VARCHAR(100),         -- invoice number or payment ref
      amount       NUMERIC(14,2) NOT NULL,
      balance_after NUMERIC(14,2) NOT NULL DEFAULT 0,
      notes        TEXT,
      recorded_by  INTEGER REFERENCES users(id),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    `CREATE INDEX IF NOT EXISTS idx_ap_supplier ON ap_ledger(supplier_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_ap_pharmacy ON ap_ledger(pharmacy_id, created_at DESC)`,

    // ---------------------------------------------------------
    // DRUG RETURNS TO SUPPLIER
    // ---------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS drug_returns (
      id           SERIAL PRIMARY KEY,
      org_id       INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      pharmacy_id  INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      supplier_id  INTEGER NOT NULL REFERENCES suppliers(id),
      return_number VARCHAR(50) UNIQUE NOT NULL,
      status       VARCHAR(50) NOT NULL DEFAULT 'pending',
      -- pending | sent | credited | closed
      reason       VARCHAR(100) NOT NULL, -- 'expired','damaged','overstock','wrong_item'
      notes        TEXT,
      total_value  NUMERIC(14,2) NOT NULL DEFAULT 0,
      created_by   INTEGER REFERENCES users(id),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS drug_return_items (
      id           SERIAL PRIMARY KEY,
      return_id    INTEGER NOT NULL REFERENCES drug_returns(id) ON DELETE CASCADE,
      drug_id      INTEGER REFERENCES drugs(id) ON DELETE SET NULL,
      drug_name    VARCHAR(255) NOT NULL,
      batch_number VARCHAR(100),
      quantity     INTEGER NOT NULL CHECK (quantity > 0),
      unit_cost    NUMERIC(12,2) NOT NULL DEFAULT 0,
      total_cost   NUMERIC(12,2) NOT NULL DEFAULT 0
    )`,

    `CREATE INDEX IF NOT EXISTS idx_returns_pharmacy ON drug_returns(pharmacy_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_returns_supplier ON drug_returns(supplier_id)`,

    // ---------------------------------------------------------
    // LOYALTY PROGRAMME
    // ---------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS loyalty_accounts (
      id             SERIAL PRIMARY KEY,
      org_id         INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      pharmacy_id    INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      customer_id    INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      points_balance INTEGER NOT NULL DEFAULT 0,
      total_earned   INTEGER NOT NULL DEFAULT 0,
      total_redeemed INTEGER NOT NULL DEFAULT 0,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (customer_id)
    )`,

    `CREATE TABLE IF NOT EXISTS loyalty_transactions (
      id          SERIAL PRIMARY KEY,
      account_id  INTEGER NOT NULL REFERENCES loyalty_accounts(id) ON DELETE CASCADE,
      pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      type        VARCHAR(20) NOT NULL,  -- 'earn' | 'redeem' | 'adjust' | 'expire'
      points      INTEGER NOT NULL,      -- positive = earned, negative = redeemed/expired
      balance_after INTEGER NOT NULL,
      sale_id     INTEGER REFERENCES sales(id) ON DELETE SET NULL,
      notes       TEXT,
      created_by  INTEGER REFERENCES users(id),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    `CREATE INDEX IF NOT EXISTS idx_loyalty_customer ON loyalty_accounts(customer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_loyalty_org      ON loyalty_accounts(org_id)`,
    `CREATE INDEX IF NOT EXISTS idx_loyalty_tx       ON loyalty_transactions(account_id, created_at DESC)`,

    // ---------------------------------------------------------
    // WAREHOUSES  (for chains with central stock)
    // ---------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS warehouses (
      id           SERIAL PRIMARY KEY,
      org_id       INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      name         VARCHAR(255) NOT NULL,
      address      TEXT,
      manager_id   INTEGER REFERENCES users(id),
      is_active    BOOLEAN NOT NULL DEFAULT true,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    // ---------------------------------------------------------
    // PHASE 2 COLUMN ADDITIONS
    // ---------------------------------------------------------

    // Phase 2 column additions:
    // sales can now carry a price_level (wholesale vs retail)
    `ALTER TABLE sales ADD COLUMN IF NOT EXISTS price_level_id INTEGER REFERENCES price_levels(id)`,

    // PO counter on pharmacies (same pattern as receipt_counter)
    `ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS po_counter INTEGER NOT NULL DEFAULT 0`,

    // GRN counter on pharmacies
    `ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS grn_counter INTEGER NOT NULL DEFAULT 0`,

    // Return counter on pharmacies
    `ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS return_counter INTEGER NOT NULL DEFAULT 0`,

    // =========================================================
    // PHASE 2 — WAREHOUSE STOCK MODEL
    // Central mother-store stock: GRN lands here first,
    // then warehouse→branch transfers move it to branch drugs.
    // =========================================================

    // warehouse_stock  — qty per drug per warehouse
    `CREATE TABLE IF NOT EXISTS warehouse_stock (
      id           SERIAL PRIMARY KEY,
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      org_id       INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      drug_id      INTEGER REFERENCES drugs(id) ON DELETE SET NULL,
      drug_name    VARCHAR(255) NOT NULL,
      generic_name VARCHAR(255),
      category     VARCHAR(100) DEFAULT 'General',
      quantity     INTEGER NOT NULL DEFAULT 0,
      cost_price   NUMERIC(12,2) NOT NULL DEFAULT 0,
      unit_price   NUMERIC(12,2) NOT NULL DEFAULT 0,
      batch_number VARCHAR(100),
      expiry_date  DATE,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (warehouse_id, drug_name)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_wstock_warehouse ON warehouse_stock(warehouse_id)`,
    `CREATE INDEX IF NOT EXISTS idx_wstock_org       ON warehouse_stock(org_id)`,
    `CREATE INDEX IF NOT EXISTS idx_wstock_drug      ON warehouse_stock(drug_id)`,
    `CREATE INDEX IF NOT EXISTS idx_wstock_name      ON warehouse_stock(warehouse_id, drug_name)`,

    // warehouse_transfers  — request → approve → dispatch flow
    `CREATE TABLE IF NOT EXISTS warehouse_transfers (
      id              SERIAL PRIMARY KEY,
      org_id          INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      warehouse_id    INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      to_pharmacy_id  INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      transfer_number VARCHAR(50) UNIQUE NOT NULL,
      status          VARCHAR(50) NOT NULL DEFAULT 'pending',
      drug_name       VARCHAR(255) NOT NULL,
      drug_id         INTEGER REFERENCES drugs(id) ON DELETE SET NULL,
      quantity        INTEGER NOT NULL CHECK (quantity > 0),
      unit_cost       NUMERIC(12,2) NOT NULL DEFAULT 0,
      notes           TEXT,
      requested_by    INTEGER REFERENCES users(id),
      approved_by     INTEGER REFERENCES users(id),
      dispatched_by   INTEGER REFERENCES users(id),
      requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      approved_at     TIMESTAMPTZ,
      dispatched_at   TIMESTAMPTZ
    )`,

    `CREATE INDEX IF NOT EXISTS idx_wtransfer_org       ON warehouse_transfers(org_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_wtransfer_warehouse ON warehouse_transfers(warehouse_id)`,
    `CREATE INDEX IF NOT EXISTS idx_wtransfer_branch    ON warehouse_transfers(to_pharmacy_id)`,

    // wt_counter for atomic transfer number generation (same pattern as receipt_counter)
    `ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS wt_counter INTEGER NOT NULL DEFAULT 0`,

    // GRN carries optional warehouse_id so stock lands in warehouse_stock
    `ALTER TABLE grn ADD COLUMN IF NOT EXISTS warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE SET NULL`,

    // =========================================================
    // PHASE 2 — AR LEDGER (Accounts Receivable)
    // Tracks credit extended to customers beyond credit_sales table.
    // credit_sales covers individual credit invoices;
    // ar_ledger is the running balance per customer account.
    // =========================================================
    `CREATE TABLE IF NOT EXISTS ar_ledger (
      id           SERIAL PRIMARY KEY,
      org_id       INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      pharmacy_id  INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      customer_id  INTEGER REFERENCES customers(id) ON DELETE SET NULL,
      customer_name VARCHAR(255) NOT NULL,
      type         VARCHAR(50) NOT NULL,
      reference    VARCHAR(100),
      amount       NUMERIC(14,2) NOT NULL,
      balance_after NUMERIC(14,2) NOT NULL DEFAULT 0,
      notes        TEXT,
      recorded_by  INTEGER REFERENCES users(id),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    `CREATE INDEX IF NOT EXISTS idx_ar_customer ON ar_ledger(customer_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_ar_pharmacy  ON ar_ledger(pharmacy_id, created_at DESC)`,

    // =========================================================
    // PHASE 3 — B2B MARKETPLACE
    // These tables are platform-level, NOT scoped to an org.
    // They sit alongside the existing pharmacy tables without
    // touching or altering any of them.
    // =========================================================

    // ---------------------------------------------------------
    // MARKETPLACE_SUPPLIERS
    // Manufacturers, importers, and wholesale distributors who
    // apply to list on the MedVault B2B marketplace.
    // Status flow: pending → approved | rejected → suspended
    // ---------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS marketplace_suppliers (
      id                  SERIAL PRIMARY KEY,
      user_id             INTEGER REFERENCES users(id) ON DELETE SET NULL,
      business_name       VARCHAR(255) NOT NULL,
      supplier_type       VARCHAR(50)  NOT NULL
                          CHECK (supplier_type IN ('manufacturer','importer','distributor')),
      registration_number VARCHAR(100),
      nda_permit          VARCHAR(100),
      contact_name        VARCHAR(255) NOT NULL,
      phone               VARCHAR(50)  NOT NULL,
      email               VARCHAR(255) UNIQUE NOT NULL,
      address             TEXT,
      status              VARCHAR(50)  NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','approved','rejected','suspended')),
      rejection_reason    TEXT,
      documents           JSONB        NOT NULL DEFAULT '[]',
      commission_rate     NUMERIC(5,2) NOT NULL DEFAULT 5.00,
      verified_at         TIMESTAMPTZ,
      verified_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`,

    `CREATE INDEX IF NOT EXISTS idx_mkt_suppliers_status
       ON marketplace_suppliers(status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_mkt_suppliers_email
       ON marketplace_suppliers(email)`,
    `CREATE INDEX IF NOT EXISTS idx_mkt_suppliers_user
       ON marketplace_suppliers(user_id)`,

    // Add password_hash for supplier self-service login
    `ALTER TABLE marketplace_suppliers ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)`,

    // ---------------------------------------------------------
    // SUPPLIER_SUBSCRIPTIONS
    // Listing / subscription fee plans for approved suppliers.
    // Status mirrors pharmacy subscriptions for consistency.
    // ---------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS supplier_subscriptions (
      id              SERIAL PRIMARY KEY,
      supplier_id     INTEGER NOT NULL REFERENCES marketplace_suppliers(id) ON DELETE CASCADE,
      plan            VARCHAR(50) NOT NULL DEFAULT 'basic'
                      CHECK (plan IN ('basic','standard','premium')),
      amount_ugx      NUMERIC(12,2) NOT NULL DEFAULT 0,
      status          VARCHAR(50) NOT NULL DEFAULT 'trial'
                      CHECK (status IN ('trial','active','overdue','suspended')),
      trial_ends_at   TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
      next_billing    TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    `CREATE INDEX IF NOT EXISTS idx_supplier_subs_supplier
       ON supplier_subscriptions(supplier_id)`,
    `CREATE INDEX IF NOT EXISTS idx_supplier_subs_status
       ON supplier_subscriptions(status)`,

    // ---------------------------------------------------------
    // MARKETPLACE_PRODUCTS
    // Products that approved suppliers list on the marketplace.
    // Separate from the pharmacy drugs table — pharmacies browse
    // this catalogue; once an order is delivered they add items
    // to their own drugs table via normal GRN flow.
    // ---------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS marketplace_products (
      id               SERIAL PRIMARY KEY,
      supplier_id      INTEGER NOT NULL REFERENCES marketplace_suppliers(id) ON DELETE CASCADE,
      name             VARCHAR(255) NOT NULL,
      generic_name     VARCHAR(255),
      category         VARCHAR(100) NOT NULL DEFAULT 'General',
      unit             VARCHAR(50)  NOT NULL DEFAULT 'Pack',
      pack_size        INTEGER      NOT NULL DEFAULT 1 CHECK (pack_size > 0),
      wholesale_price  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (wholesale_price >= 0),
      min_order_qty    INTEGER      NOT NULL DEFAULT 1  CHECK (min_order_qty > 0),
      stock_qty        INTEGER      NOT NULL DEFAULT 0  CHECK (stock_qty >= 0),
      description      TEXT,
      image_url        VARCHAR(500),
      requires_rx      BOOLEAN      NOT NULL DEFAULT false,
      is_active        BOOLEAN      NOT NULL DEFAULT true,
      created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`,

    `CREATE INDEX IF NOT EXISTS idx_mkt_products_supplier
       ON marketplace_products(supplier_id, is_active)`,
    `CREATE INDEX IF NOT EXISTS idx_mkt_products_category
       ON marketplace_products(category, is_active)`,
    `CREATE INDEX IF NOT EXISTS idx_mkt_products_name
       ON marketplace_products(name)`,

    // ---------------------------------------------------------
    // MARKETPLACE_ORDERS
    // Wholesale orders placed by pharmacies to marketplace suppliers.
    // Completely separate from the retail orders table.
    // Status flow: pending → confirmed → processing → shipped → delivered | cancelled
    // ---------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS marketplace_orders (
      id               SERIAL PRIMARY KEY,
      order_number     VARCHAR(50)  UNIQUE NOT NULL,
      pharmacy_id      INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE RESTRICT,
      supplier_id      INTEGER NOT NULL REFERENCES marketplace_suppliers(id) ON DELETE RESTRICT,
      placed_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      status           VARCHAR(50)  NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','confirmed','processing','shipped','delivered','cancelled')),
      total_amount     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
      delivery_address TEXT,
      notes            TEXT,
      placed_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      confirmed_at     TIMESTAMPTZ,
      shipped_at       TIMESTAMPTZ,
      delivered_at     TIMESTAMPTZ,
      cancelled_at     TIMESTAMPTZ,
      cancel_reason    TEXT,
      updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`,

    `CREATE INDEX IF NOT EXISTS idx_mkt_orders_pharmacy
       ON marketplace_orders(pharmacy_id, placed_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_mkt_orders_supplier
       ON marketplace_orders(supplier_id, status, placed_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_mkt_orders_status
       ON marketplace_orders(status, placed_at DESC)`,

    // ---------------------------------------------------------
    // MARKETPLACE_ORDER_ITEMS
    // Line items for each wholesale order.
    // Prices are snapshotted at order time so they never change
    // even if the supplier later edits their catalogue.
    // ---------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS marketplace_order_items (
      id              SERIAL PRIMARY KEY,
      order_id        INTEGER NOT NULL REFERENCES marketplace_orders(id) ON DELETE CASCADE,
      product_id      INTEGER REFERENCES marketplace_products(id) ON DELETE SET NULL,
      product_name    VARCHAR(255) NOT NULL,
      unit            VARCHAR(50)  NOT NULL DEFAULT 'Pack',
      pack_size       INTEGER      NOT NULL DEFAULT 1,
      unit_price      NUMERIC(12,2) NOT NULL,
      quantity        INTEGER      NOT NULL CHECK (quantity > 0),
      subtotal        NUMERIC(12,2) NOT NULL
    )`,

    `CREATE INDEX IF NOT EXISTS idx_mkt_order_items_order
       ON marketplace_order_items(order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_mkt_order_items_product
       ON marketplace_order_items(product_id)`,

    // ---------------------------------------------------------
    // MARKETPLACE_COMMISSIONS
    // Immutable ledger — one row per delivered order.
    // Commission is calculated at delivery using the supplier's
    // commission_rate at that moment (snapshot stored here).
    // status: pending → settled (when MoMo payout is processed)
    // ---------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS marketplace_commissions (
      id                SERIAL PRIMARY KEY,
      order_id          INTEGER NOT NULL REFERENCES marketplace_orders(id) ON DELETE RESTRICT,
      supplier_id       INTEGER NOT NULL REFERENCES marketplace_suppliers(id) ON DELETE RESTRICT,
      order_amount      NUMERIC(12,2) NOT NULL,
      commission_rate   NUMERIC(5,2)  NOT NULL,
      commission_amount NUMERIC(12,2) NOT NULL,
      status            VARCHAR(50)   NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','settled')),
      settled_at        TIMESTAMPTZ,
      settled_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )`,

    `CREATE INDEX IF NOT EXISTS idx_mkt_commissions_supplier
       ON marketplace_commissions(supplier_id, status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_mkt_commissions_order
       ON marketplace_commissions(order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_mkt_commissions_status
       ON marketplace_commissions(status)`,

    // Atomic marketplace order number counter on pharmacies table
    // (same pattern as receipt_counter, po_counter etc.)
    `ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS mkt_order_counter INTEGER NOT NULL DEFAULT 0`,

    // marketplace_orders missing columns
    `ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS placed_by INTEGER REFERENCES users(id) ON DELETE SET NULL`,
    `ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50) NOT NULL DEFAULT 'MTN MoMo'`,
    `ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ`,
    `ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMPTZ`,
    `ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ`,
    `ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`,
    `ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT`,
    `ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,

    // marketplace_products missing column
    `ALTER TABLE marketplace_products ADD COLUMN IF NOT EXISTS requires_rx BOOLEAN NOT NULL DEFAULT false`,

    // marketplace_order_items missing columns + fix product_id nullability
    `ALTER TABLE marketplace_order_items ADD COLUMN IF NOT EXISTS unit VARCHAR(50) NOT NULL DEFAULT 'Pack'`,
    `ALTER TABLE marketplace_order_items ADD COLUMN IF NOT EXISTS pack_size INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE marketplace_order_items ADD COLUMN IF NOT EXISTS subtotal NUMERIC(12,2) NOT NULL DEFAULT 0`,
    `ALTER TABLE marketplace_order_items ALTER COLUMN product_id DROP NOT NULL`,

    // =========================================================
    // PHASE 3 — CLINIC & MEDICAL CENTER
    // =========================================================

    // PATIENTS
    `CREATE TABLE IF NOT EXISTS patients (
      id                      SERIAL PRIMARY KEY,
      org_id                  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      pharmacy_id             INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      patient_number          VARCHAR(50) NOT NULL,
      name                    VARCHAR(255) NOT NULL,
      dob                     DATE,
      gender                  VARCHAR(20),
      phone                   VARCHAR(50),
      email                   VARCHAR(255),
      address                 TEXT,
      blood_group             VARCHAR(10),
      allergies               TEXT,
      emergency_contact_name  VARCHAR(255),
      emergency_contact_phone VARCHAR(50),
      notes                   TEXT,
      is_active               BOOLEAN NOT NULL DEFAULT true,
      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_patients_org      ON patients(org_id)`,
    `CREATE INDEX IF NOT EXISTS idx_patients_pharmacy ON patients(pharmacy_id)`,
    `CREATE INDEX IF NOT EXISTS idx_patients_phone    ON patients(phone)`,
    `CREATE INDEX IF NOT EXISTS idx_patients_name     ON patients(org_id, name)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_number ON patients(org_id, patient_number)`,

    // DOCTORS
    `CREATE TABLE IF NOT EXISTS doctors (
      id              SERIAL PRIMARY KEY,
      org_id          INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      pharmacy_id     INTEGER REFERENCES pharmacies(id) ON DELETE SET NULL,
      user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
      name            VARCHAR(255) NOT NULL,
      speciality      VARCHAR(100),
      license_number  VARCHAR(100),
      phone           VARCHAR(50),
      email           VARCHAR(255),
      consultation_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
      is_active       BOOLEAN NOT NULL DEFAULT true,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_doctors_org ON doctors(org_id, is_active)`,

    // APPOINTMENTS
    `CREATE TABLE IF NOT EXISTS appointments (
      id           SERIAL PRIMARY KEY,
      org_id       INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      pharmacy_id  INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      patient_id   INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      doctor_id    INTEGER REFERENCES doctors(id) ON DELETE SET NULL,
      scheduled_at TIMESTAMPTZ NOT NULL,
      duration_min INTEGER NOT NULL DEFAULT 30,
      type         VARCHAR(100) DEFAULT 'consultation',
      status       VARCHAR(50) NOT NULL DEFAULT 'scheduled',
      notes        TEXT,
      created_by   INTEGER REFERENCES users(id),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_appt_pharmacy ON appointments(pharmacy_id, scheduled_at)`,
    `CREATE INDEX IF NOT EXISTS idx_appt_patient  ON appointments(patient_id)`,
    `CREATE INDEX IF NOT EXISTS idx_appt_doctor   ON appointments(doctor_id, scheduled_at)`,
    `CREATE INDEX IF NOT EXISTS idx_appt_status   ON appointments(pharmacy_id, status, scheduled_at)`,

    // CONSULTATIONS
    `CREATE TABLE IF NOT EXISTS consultations (
      id              SERIAL PRIMARY KEY,
      org_id          INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      pharmacy_id     INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      patient_id      INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      doctor_id       INTEGER REFERENCES doctors(id) ON DELETE SET NULL,
      appointment_id  INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
      weight_kg       NUMERIC(5,1),
      height_cm       NUMERIC(5,1),
      bp_systolic     INTEGER,
      bp_diastolic    INTEGER,
      temperature     NUMERIC(4,1),
      pulse           INTEGER,
      spo2            INTEGER,
      chief_complaint TEXT,
      history         TEXT,
      examination     TEXT,
      diagnosis       TEXT,
      treatment_plan  TEXT,
      notes           TEXT,
      fee             NUMERIC(12,2) NOT NULL DEFAULT 0,
      status          VARCHAR(50) NOT NULL DEFAULT 'open',
      created_by      INTEGER REFERENCES users(id),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_consult_pharmacy ON consultations(pharmacy_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_consult_patient  ON consultations(patient_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_consult_doctor   ON consultations(doctor_id, created_at DESC)`,

    // PRESCRIPTIONS
    `CREATE TABLE IF NOT EXISTS prescriptions (
      id              SERIAL PRIMARY KEY,
      org_id          INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      pharmacy_id     INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      consultation_id INTEGER REFERENCES consultations(id) ON DELETE SET NULL,
      patient_id      INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      doctor_id       INTEGER REFERENCES doctors(id) ON DELETE SET NULL,
      status          VARCHAR(50) NOT NULL DEFAULT 'pending',
      notes           TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS prescription_items (
      id              SERIAL PRIMARY KEY,
      prescription_id INTEGER NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
      drug_id         INTEGER REFERENCES drugs(id) ON DELETE SET NULL,
      drug_name       VARCHAR(255) NOT NULL,
      dosage          VARCHAR(255),
      frequency       VARCHAR(100),
      duration        VARCHAR(100),
      quantity        INTEGER NOT NULL DEFAULT 0,
      dispensed_qty   INTEGER NOT NULL DEFAULT 0,
      notes           TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_rx_pharmacy ON prescriptions(pharmacy_id, status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_rx_patient  ON prescriptions(patient_id)`,
    `CREATE INDEX IF NOT EXISTS idx_rx_items    ON prescription_items(prescription_id)`,

    // Patient counter on pharmacies
    `ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS patient_counter INTEGER NOT NULL DEFAULT 0`,

    // =========================================================
    // PHASE 4 — LABORATORY MODULE
    // =========================================================

    // LAB TEST CATALOGUE
    `CREATE TABLE IF NOT EXISTS lab_tests (
      id            SERIAL PRIMARY KEY,
      org_id        INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      name          VARCHAR(255) NOT NULL,
      category      VARCHAR(100) DEFAULT 'General',
      description   TEXT,
      normal_range  VARCHAR(255),
      unit          VARCHAR(50),
      price         NUMERIC(12,2) NOT NULL DEFAULT 0,
      turn_around   VARCHAR(100) DEFAULT '1 day',
      is_active     BOOLEAN NOT NULL DEFAULT true,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_lab_tests_org ON lab_tests(org_id, is_active)`,

    // LAB REQUESTS
    `CREATE TABLE IF NOT EXISTS lab_requests (
      id              SERIAL PRIMARY KEY,
      org_id          INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      pharmacy_id     INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      patient_id      INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      doctor_id       INTEGER REFERENCES doctors(id) ON DELETE SET NULL,
      consultation_id INTEGER REFERENCES consultations(id) ON DELETE SET NULL,
      request_number  VARCHAR(50) NOT NULL,
      status          VARCHAR(50) NOT NULL DEFAULT 'pending',
      priority        VARCHAR(20) NOT NULL DEFAULT 'routine',
      clinical_notes  TEXT,
      total_cost      NUMERIC(12,2) NOT NULL DEFAULT 0,
      requested_by    INTEGER REFERENCES users(id),
      collected_at    TIMESTAMPTZ,
      collected_by    INTEGER REFERENCES users(id),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS lab_request_items (
      id             SERIAL PRIMARY KEY,
      request_id     INTEGER NOT NULL REFERENCES lab_requests(id) ON DELETE CASCADE,
      test_id        INTEGER NOT NULL REFERENCES lab_tests(id) ON DELETE CASCADE,
      test_name      VARCHAR(255) NOT NULL,
      price          NUMERIC(12,2) NOT NULL DEFAULT 0,
      status         VARCHAR(50) NOT NULL DEFAULT 'pending'
    )`,
    `CREATE INDEX IF NOT EXISTS idx_lab_req_pharmacy ON lab_requests(pharmacy_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_lab_req_patient  ON lab_requests(patient_id)`,
    `CREATE INDEX IF NOT EXISTS idx_lab_req_status   ON lab_requests(pharmacy_id, status)`,

    // LAB RESULTS
    `CREATE TABLE IF NOT EXISTS lab_results (
      id              SERIAL PRIMARY KEY,
      request_id      INTEGER NOT NULL REFERENCES lab_requests(id) ON DELETE CASCADE,
      request_item_id INTEGER NOT NULL REFERENCES lab_request_items(id) ON DELETE CASCADE,
      test_id         INTEGER NOT NULL REFERENCES lab_tests(id) ON DELETE CASCADE,
      patient_id      INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      pharmacy_id     INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      result_value    TEXT NOT NULL,
      unit            VARCHAR(50),
      normal_range    VARCHAR(255),
      is_abnormal     BOOLEAN NOT NULL DEFAULT false,
      notes           TEXT,
      entered_by      INTEGER REFERENCES users(id),
      verified_by     INTEGER REFERENCES users(id),
      verified_at     TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_lab_results_req     ON lab_results(request_id)`,
    `CREATE INDEX IF NOT EXISTS idx_lab_results_patient ON lab_results(patient_id, created_at DESC)`,

    // Lab request counter on pharmacies
    `ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS lab_counter INTEGER NOT NULL DEFAULT 0`,

    // =========================================================
    // PHASE 5 — HOSPITAL ERP
    // =========================================================

    // DEPARTMENTS
    `CREATE TABLE IF NOT EXISTS departments (
      id          SERIAL PRIMARY KEY,
      org_id      INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      name        VARCHAR(255) NOT NULL,
      code        VARCHAR(50),
      head_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      is_active   BOOLEAN NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_departments_org ON departments(org_id)`,

    // WARDS
    `CREATE TABLE IF NOT EXISTS wards (
      id            SERIAL PRIMARY KEY,
      org_id        INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      pharmacy_id   INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
      name          VARCHAR(255) NOT NULL,
      ward_type     VARCHAR(100) DEFAULT 'general',
      total_beds    INTEGER NOT NULL DEFAULT 0,
      is_active     BOOLEAN NOT NULL DEFAULT true,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wards_org ON wards(org_id, is_active)`,

    // BEDS
    `CREATE TABLE IF NOT EXISTS beds (
      id         SERIAL PRIMARY KEY,
      ward_id    INTEGER NOT NULL REFERENCES wards(id) ON DELETE CASCADE,
      bed_number VARCHAR(50) NOT NULL,
      bed_type   VARCHAR(50) DEFAULT 'standard',
      status     VARCHAR(50) NOT NULL DEFAULT 'available',
      daily_rate NUMERIC(12,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(ward_id, bed_number)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_beds_ward   ON beds(ward_id, status)`,

    // ADMISSIONS
    `CREATE TABLE IF NOT EXISTS admissions (
      id              SERIAL PRIMARY KEY,
      org_id          INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      pharmacy_id     INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      patient_id      INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      doctor_id       INTEGER REFERENCES doctors(id) ON DELETE SET NULL,
      bed_id          INTEGER REFERENCES beds(id) ON DELETE SET NULL,
      ward_id         INTEGER REFERENCES wards(id) ON DELETE SET NULL,
      admission_number VARCHAR(50) NOT NULL,
      admitted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      discharged_at   TIMESTAMPTZ,
      diagnosis       TEXT,
      status          VARCHAR(50) NOT NULL DEFAULT 'admitted',
      discharge_notes TEXT,
      discharge_type  VARCHAR(50),
      admitted_by     INTEGER REFERENCES users(id),
      discharged_by   INTEGER REFERENCES users(id),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_admissions_pharmacy ON admissions(pharmacy_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_admissions_patient  ON admissions(patient_id)`,
    `CREATE INDEX IF NOT EXISTS idx_admissions_bed      ON admissions(bed_id)`,

    // INPATIENT CHARGES
    `CREATE TABLE IF NOT EXISTS inpatient_charges (
      id            SERIAL PRIMARY KEY,
      admission_id  INTEGER NOT NULL REFERENCES admissions(id) ON DELETE CASCADE,
      pharmacy_id   INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      charge_type   VARCHAR(100) NOT NULL,
      description   VARCHAR(500) NOT NULL,
      quantity      INTEGER NOT NULL DEFAULT 1,
      unit_price    NUMERIC(12,2) NOT NULL DEFAULT 0,
      total_price   NUMERIC(12,2) NOT NULL DEFAULT 0,
      drug_id       INTEGER REFERENCES drugs(id) ON DELETE SET NULL,
      charged_by    INTEGER REFERENCES users(id),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ip_charges_admission ON inpatient_charges(admission_id)`,

    // INSURANCE SCHEMES
    `CREATE TABLE IF NOT EXISTS insurance_schemes (
      id              SERIAL PRIMARY KEY,
      org_id          INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      name            VARCHAR(255) NOT NULL,
      scheme_type     VARCHAR(100) DEFAULT 'private',
      contact_name    VARCHAR(255),
      phone           VARCHAR(50),
      email           VARCHAR(255),
      coverage_pct    NUMERIC(5,2) NOT NULL DEFAULT 80,
      payment_terms   VARCHAR(100) DEFAULT 'net30',
      is_active       BOOLEAN NOT NULL DEFAULT true,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_insurance_org ON insurance_schemes(org_id, is_active)`,

    // INSURANCE CLAIMS
    `CREATE TABLE IF NOT EXISTS insurance_claims (
      id                SERIAL PRIMARY KEY,
      org_id            INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      pharmacy_id       INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      scheme_id         INTEGER NOT NULL REFERENCES insurance_schemes(id) ON DELETE CASCADE,
      patient_id        INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      admission_id      INTEGER REFERENCES admissions(id) ON DELETE SET NULL,
      consultation_id   INTEGER REFERENCES consultations(id) ON DELETE SET NULL,
      claim_number      VARCHAR(50) NOT NULL,
      total_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
      covered_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
      patient_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
      status            VARCHAR(50) NOT NULL DEFAULT 'pending',
      submitted_at      TIMESTAMPTZ,
      approved_at       TIMESTAMPTZ,
      paid_at           TIMESTAMPTZ,
      rejection_reason  TEXT,
      notes             TEXT,
      created_by        INTEGER REFERENCES users(id),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_claims_pharmacy ON insurance_claims(pharmacy_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_claims_scheme   ON insurance_claims(scheme_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_claims_patient  ON insurance_claims(patient_id)`,

    // Admission counter on pharmacies
    `ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS admission_counter INTEGER NOT NULL DEFAULT 0`,
    // Insurance claim counter
    `ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS claim_counter INTEGER NOT NULL DEFAULT 0`,

    // =========================================================
    // PHASE 6 — ENTERPRISE ECOSYSTEM
    // =========================================================

    // AI PREDICTIONS LOG
    `CREATE TABLE IF NOT EXISTS ai_predictions (
      id            SERIAL PRIMARY KEY,
      org_id        INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      pharmacy_id   INTEGER REFERENCES pharmacies(id) ON DELETE CASCADE,
      prediction_type VARCHAR(100) NOT NULL,
      input_data    JSONB,
      output_data   JSONB,
      accuracy      NUMERIC(5,2),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ai_pred_org ON ai_predictions(org_id, created_at DESC)`,

    // API KEYS for external integrations
    `CREATE TABLE IF NOT EXISTS api_keys (
      id          SERIAL PRIMARY KEY,
      org_id      INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      name        VARCHAR(255) NOT NULL,
      key_hash    VARCHAR(255) NOT NULL,
      key_prefix  VARCHAR(20) NOT NULL,
      permissions JSONB NOT NULL DEFAULT '[]',
      is_active   BOOLEAN NOT NULL DEFAULT true,
      last_used   TIMESTAMPTZ,
      expires_at  TIMESTAMPTZ,
      created_by  INTEGER REFERENCES users(id),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_api_keys_org ON api_keys(org_id, is_active)`,

    // REGIONAL ORGANISATIONS (holding company groups)
    `CREATE TABLE IF NOT EXISTS regional_orgs (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(255) NOT NULL,
      country     VARCHAR(100) DEFAULT 'Uganda',
      region      VARCHAR(100),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `ALTER TABLE organisations ADD COLUMN IF NOT EXISTS regional_org_id INTEGER REFERENCES regional_orgs(id) ON DELETE SET NULL`,

    // WEBHOOK CONFIGS
    `CREATE TABLE IF NOT EXISTS webhook_configs (
      id          SERIAL PRIMARY KEY,
      org_id      INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      url         VARCHAR(500) NOT NULL,
      events      JSONB NOT NULL DEFAULT '[]',
      secret      VARCHAR(255) NOT NULL,
      is_active   BOOLEAN NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_webhooks_org ON webhook_configs(org_id, is_active)`,

    // Add nurse role support (extending existing users table)
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL`,

    // =========================================================
    // GL ACCOUNTING (Phase 5 — Hospital-grade)
    // =========================================================

    // Chart of Accounts
    `CREATE TABLE IF NOT EXISTS gl_accounts (
      id           SERIAL PRIMARY KEY,
      org_id       INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      code         VARCHAR(20) NOT NULL,
      name         VARCHAR(255) NOT NULL,
      account_type VARCHAR(50) NOT NULL,
      parent_id    INTEGER REFERENCES gl_accounts(id) ON DELETE SET NULL,
      is_active    BOOLEAN NOT NULL DEFAULT true,
      balance      NUMERIC(16,2) NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(org_id, code)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_gl_accounts_org ON gl_accounts(org_id, account_type)`,

    // Journal Entries (immutable — only reversals allowed)
    `CREATE TABLE IF NOT EXISTS journal_entries (
      id           SERIAL PRIMARY KEY,
      org_id       INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      pharmacy_id  INTEGER REFERENCES pharmacies(id) ON DELETE SET NULL,
      entry_number VARCHAR(50) NOT NULL,
      description  TEXT NOT NULL,
      reference    VARCHAR(255),
      entry_date   DATE NOT NULL DEFAULT CURRENT_DATE,
      is_reversal  BOOLEAN NOT NULL DEFAULT false,
      reverses_id  INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
      created_by   INTEGER REFERENCES users(id),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(org_id, entry_number)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_journal_org ON journal_entries(org_id, entry_date DESC)`,

    // Journal Lines (debit/credit legs)
    `CREATE TABLE IF NOT EXISTS journal_lines (
      id             SERIAL PRIMARY KEY,
      journal_id     INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
      account_id     INTEGER NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
      description    TEXT,
      debit_amount   NUMERIC(16,2) NOT NULL DEFAULT 0,
      credit_amount  NUMERIC(16,2) NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_journal_lines_journal ON journal_lines(journal_id)`,
    `CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(account_id)`,

    // Journal counter on pharmacies
    `ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS journal_counter INTEGER NOT NULL DEFAULT 0`,

    // =========================================================
    // SMS LOG (Phase 6 — Africa's Talking)
    // =========================================================
    `CREATE TABLE IF NOT EXISTS sms_log (
      id           SERIAL PRIMARY KEY,
      org_id       INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      pharmacy_id  INTEGER REFERENCES pharmacies(id) ON DELETE SET NULL,
      recipient    VARCHAR(50) NOT NULL,
      message      TEXT NOT NULL,
      status       VARCHAR(50) NOT NULL DEFAULT 'queued',
      provider     VARCHAR(50) DEFAULT 'africastalking',
      external_id  VARCHAR(255),
      error        TEXT,
      sent_at      TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sms_org ON sms_log(org_id, created_at DESC)`,

    // Patient dedup helper index
    `CREATE INDEX IF NOT EXISTS idx_patients_phone_dedup ON patients(org_id, phone) WHERE phone IS NOT NULL`,

    // ── Phase 3 — Supplier Stock Receiving Fix ────────────────
    // Allow drug_batches.expiry_date to be NULL so ad-hoc receipts
    // without an expiry date don't fail validation.
    `ALTER TABLE drug_batches ALTER COLUMN expiry_date DROP NOT NULL`,

    // Safety: re-create the unique batch index if it was missing
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_batch ON drug_batches(drug_id, batch_number)`,

    // grn_items receiving_status — lets us track partial vs full receipt per line
    `ALTER TABLE grn_items ADD COLUMN IF NOT EXISTS receiving_status VARCHAR(50) NOT NULL DEFAULT 'received'`,

    // marketplace_orders: track whether stock has been received into inventory
    `ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS stock_received BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS stock_received_at TIMESTAMPTZ`,

    // ── Phase 4 — Sales Persistence & Integrity Hardening ─────
    // client_txn_id: a UUID generated on the device *before* the request
    // is sent. Because the offline queue retries requests whose response
    // was lost (timeout, dropped connection after the server already
    // committed), the same sale could previously be inserted twice. The
    // unique index below lets POST /api/sales safely no-op on a repeat
    // send instead of creating a duplicate sale + double stock deduction.
    `ALTER TABLE sales ADD COLUMN IF NOT EXISTS client_txn_id VARCHAR(100)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_client_txn ON sales(pharmacy_id, client_txn_id) WHERE client_txn_id IS NOT NULL`,

    // Soft-delete / integrity columns so a sale is never silently removed —
    // any future correction is a flagged void, not a DELETE.
    `ALTER TABLE sales ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ`,
    `ALTER TABLE sales ADD COLUMN IF NOT EXISTS voided_by INTEGER REFERENCES users(id)`,
    `ALTER TABLE sales ADD COLUMN IF NOT EXISTS void_reason TEXT`,

    // Append-only ledger of every create/void touching a sale, independent
    // of the generic audit_log table, so sales history can always be
    // reconstructed even if audit_log is pruned.
    `CREATE TABLE IF NOT EXISTS sale_audit_trail (
      id           SERIAL PRIMARY KEY,
      sale_id      INTEGER NOT NULL REFERENCES sales(id),
      pharmacy_id  INTEGER NOT NULL REFERENCES pharmacies(id),
      action       VARCHAR(50) NOT NULL,
      user_id      INTEGER REFERENCES users(id),
      before_data  JSONB,
      after_data   JSONB,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sale_audit_sale ON sale_audit_trail(sale_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sale_audit_pharmacy ON sale_audit_trail(pharmacy_id, created_at DESC)`,

    // Nightly logical backup of sales + sale_items, written by the
    // scheduler job. Gives us a restorable snapshot independent of
    // Neon's own point-in-time recovery.
    `CREATE TABLE IF NOT EXISTS sales_backup_log (
      id             SERIAL PRIMARY KEY,
      pharmacy_id    INTEGER NOT NULL REFERENCES pharmacies(id),
      backup_date    DATE NOT NULL,
      sale_count     INTEGER NOT NULL,
      total_revenue  NUMERIC(14,2) NOT NULL,
      snapshot       JSONB NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(pharmacy_id, backup_date)
    )`

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

async function getNextReceiptNumber(pharmacyId) {
  // ── Atomic increment — single UPDATE avoids any race condition ──────────
  // If receipt_counter was backfilled to MAX(existing suffix), this will
  // always produce a number higher than any previously issued receipt.
  const r = await query(
    `UPDATE pharmacies
        SET receipt_counter = receipt_counter + 1
      WHERE id = $1
      RETURNING receipt_counter`,
    [pharmacyId]
  );

  if (!r.rows.length) {
    // Pharmacy not found — fall back to timestamp-based unique string
    // so the sale is never blocked by a missing pharmacy row.
    return `RCP-${new Date().getFullYear()}-${Date.now().toString(36).toUpperCase()}`;
  }

  const n = r.rows[0].receipt_counter;
  return `RCP-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`;
}

// ── getNextPoNumber — atomic PO number generator ─────────────────────────
async function getNextPoNumber(pharmacyId) {
  const r = await query(
    `UPDATE pharmacies SET po_counter = po_counter + 1 WHERE id = $1 RETURNING po_counter`,
    [pharmacyId]
  );
  if (!r.rows.length) return `PO-${new Date().getFullYear()}-${Date.now().toString(36).toUpperCase()}`;
  const n = r.rows[0].po_counter;
  return `PO-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`;
}

// ── getNextGrnNumber — atomic GRN number generator ────────────────────────
async function getNextGrnNumber(pharmacyId) {
  const r = await query(
    `UPDATE pharmacies SET grn_counter = grn_counter + 1 WHERE id = $1 RETURNING grn_counter`,
    [pharmacyId]
  );
  if (!r.rows.length) return `GRN-${new Date().getFullYear()}-${Date.now().toString(36).toUpperCase()}`;
  const n = r.rows[0].grn_counter;
  return `GRN-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`;
}

// ── getNextReturnNumber — atomic return number generator ──────────────────
async function getNextReturnNumber(pharmacyId) {
  const r = await query(
    `UPDATE pharmacies SET return_counter = return_counter + 1 WHERE id = $1 RETURNING return_counter`,
    [pharmacyId]
  );
  if (!r.rows.length) return `RTN-${new Date().getFullYear()}-${Date.now().toString(36).toUpperCase()}`;
  const n = r.rows[0].return_counter;
  return `RTN-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`;
}

// ── getNextWarehouseTransferNumber ────────────────────────────────────────
async function getNextWarehouseTransferNumber(pharmacyId) {
  const r = await query(
    `UPDATE pharmacies SET wt_counter = wt_counter + 1 WHERE id = $1 RETURNING wt_counter`,
    [pharmacyId]
  );
  if (!r.rows.length) return `WTR-${new Date().getFullYear()}-${Date.now().toString(36).toUpperCase()}`;
  const n = r.rows[0].wt_counter;
  return `WTR-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`;
}

async function getNextMktOrderNumber(pharmacyId) {
  const r = await query(
    `UPDATE pharmacies SET mkt_order_counter = mkt_order_counter + 1 WHERE id = $1 RETURNING mkt_order_counter`,
    [pharmacyId]
  );
  if (!r.rows.length) return `MKT-${new Date().getFullYear()}-${Date.now().toString(36).toUpperCase()}`;
  const n = r.rows[0].mkt_order_counter;
  return `MKT-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`;
}

// ── getPool export — used by routes that need a client for transactions ──
module.exports = {
  query,
  pool: { connect: () => getPool().connect() },   // safe lazy proxy
  runMigrations,
  seedSuperAdmin,
  getNextReceiptNumber,
  getNextPoNumber,
  getNextGrnNumber,
  getNextReturnNumber,
  getNextWarehouseTransferNumber,
  getNextMktOrderNumber,
};