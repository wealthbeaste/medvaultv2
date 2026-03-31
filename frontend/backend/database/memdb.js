// ============================================================
// MedVault In-Memory Database
// Stores all data in memory — works with ZERO setup
// Data resets when server restarts (perfect for demo/testing)
// Later: swap this for PostgreSQL by changing the query() function
// ============================================================

const { hash } = require('../core/password');

// ── AUTO-INCREMENT IDs ─────────────────────────────────────
const counters = { pharmacies: 1, users: 1, drugs: 1, sales: 1, saleItems: 1, orders: 1, orderItems: 1, customers: 1, subscriptions: 1 };
const nextId = (table) => counters[table]++;

// ── TABLES (just arrays of objects) ───────────────────────
const db = {
  pharmacies: [],
  users: [],
  drugs: [],
  sales: [],
  saleItems: [],
  orders: [],
  orderItems: [],
  customers: [],
  subscriptions: [],
};

// ── SEED DEMO DATA ─────────────────────────────────────────
function seedData() {
  // Pharmacy
  const pharmaId = nextId('pharmacies');
  db.pharmacies.push({
    id: pharmaId, name: 'Kato Pharma',
    address: 'Kampala Road, Kampala', phone: '+256700123456',
    email: 'admin@katopharma.ug', nda_reg: 'NDA/PH/2024/001',
    plan: 'pro', is_active: true, created_at: new Date()
  });

  // Admin user
  db.users.push({
    id: nextId('users'), pharmacy_id: pharmaId,
    name: 'Kato Admin', email: 'admin@katopharma.ug',
    password_hash: hash('admin123'), role: 'admin',
    is_active: true, last_login: null, created_at: new Date()
  });

  // Drugs
  const drugData = [
    ['Paracetamol 500mg',   'Analgesic',       240, 300, 500,   350,  '2026-12-01', 'Cipla Uganda',    30, false],
    ['Amoxicillin 250mg',   'Antibiotic',       18, 200, 3500, 2500,  '2026-04-15', 'Cipla Uganda',    30, true ],
    ['Coartem (AL) 6-tabs', 'Antimalarial',     95, 150, 12000, 8000, '2026-11-20', 'Novartis Uganda', 20, true ],
    ['Metformin 850mg',     'Antidiabetic',      5, 100, 2500,  1800, '2026-03-31', 'Cipla Uganda',    20, true ],
    ['ORS Sachets 1L',      'Rehydration',     380, 400, 800,   500,  '2027-08-10', 'UNICEF Supply',   50, false],
    ['Vitamin C 500mg',     'Vitamin',         120, 200, 1000,  700,  '2027-01-15', 'Local Supplier',  30, false],
    ['Atenolol 50mg',       'Antihypertensive', 22, 150, 1800,  1200, '2026-09-05', 'Cipla Uganda',    25, true ],
    ['Omeprazole 20mg',     'Gastric',          60, 120, 2000,  1400, '2027-03-20', 'Cipla Uganda',    20, true ],
    ['Fluconazole 150mg',   'Antifungal',        8,  80, 5000,  3500, '2026-06-10', 'Cipla Uganda',    15, true ],
    ['Ciprofloxacin 500mg', 'Antibiotic',       45, 100, 4500,  3200, '2026-10-18', 'Cipla Uganda',    20, true ],
    ['Ibuprofen 400mg',     'Analgesic',       180, 250, 700,   500,  '2027-02-28', 'Cipla Uganda',    30, false],
    ['Doxycycline 100mg',   'Antibiotic',       30, 120, 2800,  2000, '2026-07-22', 'Cipla Uganda',    25, true ],
  ];

  drugData.forEach(([name,cat,qty,max,price,cost,expiry,supplier,threshold,rx]) => {
    db.drugs.push({
      id: nextId('drugs'), pharmacy_id: pharmaId, name, category: cat,
      quantity: qty, max_quantity: max, unit_price: price, cost_price: cost,
      expiry_date: new Date(expiry), supplier, threshold, requires_rx: rx,
      created_at: new Date(), updated_at: new Date()
    });
  });

  // Customers
  const custData = [
    ['Amara Nakato',  '0770234567', 'amara@gmail.com',  284000, 12],
    ['James Okello',  '0752891234', 'james@gmail.com',  192500,  8],
    ['Sarah Emong',   '0701445678', 'sarah@gmail.com',  375000, 15],
    ['Brian Mugisha', '0780123456', null,               156000,  6],
    ['Rose Atim',     '0762334890', 'rose@gmail.com',   480000, 20],
    ['David Ssemuju', '0703567123', null,                98000,  4],
  ];

  custData.forEach(([name,phone,email,spent,orders]) => {
    db.customers.push({
      id: nextId('customers'), pharmacy_id: pharmaId,
      name, phone, email, total_spent: spent, order_count: orders, created_at: new Date()
    });
  });

  // Demo sales (last 7 days)
  const saleNames = ['Amara Nakato','James Okello','Sarah Emong','Brian Mugisha','Rose Atim','Walk-in'];
  for (let i = 0; i < 7; i++) {
    const amount = Math.floor(Math.random() * 150000) + 20000;
    const methods = ['cash','mtn_momo','airtel_money'];
    const saleId = nextId('sales');
    const daysAgo = new Date(); daysAgo.setDate(daysAgo.getDate() - i);
    db.sales.push({
      id: saleId, pharmacy_id: pharmaId, user_id: 1,
      customer_name: saleNames[i % saleNames.length],
      subtotal: amount, discount_pct: 0, discount_amount: 0, total_amount: amount,
      payment_method: methods[i % 3],
      receipt_number: `RCP-2026-${String(i+1).padStart(4,'0')}`,
      created_at: daysAgo
    });
  }

  // Subscription
  db.subscriptions.push({
    id: nextId('subscriptions'), pharmacy_id: pharmaId,
    plan: 'pro', amount: 50000, payment_method: 'mtn_momo',
    status: 'active', billing_date: new Date(),
    next_billing: new Date(Date.now() + 30*24*60*60*1000),
    created_at: new Date()
  });

  console.log('✅ Demo data loaded — Kato Pharma ready');
}

// ── HELPER FUNCTIONS (mimic SQL queries) ──────────────────
const helpers = {
  // Get all matching rows
  find: (table, filter = {}) => {
    return db[table].filter(row =>
      Object.entries(filter).every(([k, v]) => row[k] === v)
    );
  },

  // Get one row
  findOne: (table, filter) => {
    return db[table].find(row =>
      Object.entries(filter).every(([k, v]) => row[k] === v)
    );
  },

  // Insert a row
  insert: (table, data) => {
    const row = { id: nextId(table), ...data, created_at: new Date() };
    db[table].push(row);
    return row;
  },

  // Update matching rows
  update: (table, filter, updates) => {
    const rows = helpers.find(table, filter);
    rows.forEach(row => Object.assign(row, updates, { updated_at: new Date() }));
    return rows;
  },

  // Delete matching rows
  remove: (table, filter) => {
    const before = db[table].length;
    db[table] = db[table].filter(row =>
      !Object.entries(filter).every(([k, v]) => row[k] === v)
    );
    return before - db[table].length;
  },

  // Get drug stock status
  stockStatus: (drug) => {
    if (drug.quantity === 0) return 'out';
    if (drug.quantity <= drug.threshold) return 'critical';
    if (drug.quantity <= drug.threshold * 1.5) return 'low';
    return 'ok';
  },

  // Days until expiry
  daysToExpiry: (drug) => {
    return Math.ceil((new Date(drug.expiry_date) - new Date()) / 86400000);
  },

  // Today's revenue
  todayRevenue: (pharmacyId) => {
    const today = new Date().toDateString();
    return db.sales
      .filter(s => s.pharmacy_id === pharmacyId && new Date(s.created_at).toDateString() === today)
      .reduce((sum, s) => sum + s.total_amount, 0);
  },

  // Weekly revenue (last 7 days)
  weeklyRevenue: (pharmacyId) => {
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const dateStr = d.toDateString();
      const label = d.toLocaleDateString('en-UG', { weekday: 'short' });
      const revenue = db.sales
        .filter(s => s.pharmacy_id === pharmacyId && new Date(s.created_at).toDateString() === dateStr)
        .reduce((sum, s) => sum + s.total_amount, 0);
      days.push({ day: d.toISOString().split('T')[0], label, revenue });
    }
    return days;
  }
};

module.exports = { db, helpers, seedData };
