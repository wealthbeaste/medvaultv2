// ============================================================
// MedVault API Routes
// All endpoints in one place — easy to read and modify
// ============================================================

const { helpers, db } = require('../database/memdb');
const { hash, compare } = require('../core/password');
const { sign } = require('../core/jwt');
const auth = require('../middleware/auth');

module.exports = function registerRoutes(app) {

  // ══════════════════════════════════════════════════════════
  // HEALTH CHECK
  // ══════════════════════════════════════════════════════════

  app.get('/health', async (req, res) => {
    res.json({ status: 'ok', service: 'MedVault API', time: new Date() });
  });


  // ══════════════════════════════════════════════════════════
  // AUTH — Login & Register
  // ══════════════════════════════════════════════════════════

  // POST /api/auth/login
  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password)
      return res.json({ error: 'Email and password required' }, 400);

    const user = helpers.findOne('users', { email: email.toLowerCase(), is_active: true });
    if (!user || !compare(password, user.password_hash))
      return res.json({ error: 'Invalid email or password' }, 401);

    const pharmacy = helpers.findOne('pharmacies', { id: user.pharmacy_id });
    user.last_login = new Date();

    const token = sign({
      userId: user.id,
      pharmacyId: user.pharmacy_id,
      role: user.role,
      name: user.name,
    });

    res.json({
      message: 'Login successful! Welcome back, ' + user.name,
      token,
      user: {
        id: user.id, name: user.name, email: user.email,
        role: user.role, pharmacyId: user.pharmacy_id,
        pharmacyName: pharmacy?.name, plan: pharmacy?.plan,
      },
    });
  });

  // POST /api/auth/register
  app.post('/api/auth/register', async (req, res) => {
    const { pharmacyName, address, phone, email, password } = req.body;
    if (!pharmacyName || !email || !password)
      return res.json({ error: 'Pharmacy name, email and password required' }, 400);
    if (password.length < 6)
      return res.json({ error: 'Password must be at least 6 characters' }, 400);
    if (helpers.findOne('users', { email: email.toLowerCase() }))
      return res.json({ error: 'Account with this email already exists' }, 409);

    const pharmacy = helpers.insert('pharmacies', {
      name: pharmacyName, address, phone,
      email: email.toLowerCase(), plan: 'basic', is_active: true,
    });

    const user = helpers.insert('users', {
      pharmacy_id: pharmacy.id,
      name: pharmacyName + ' Admin',
      email: email.toLowerCase(),
      password_hash: hash(password),
      role: 'admin', is_active: true,
    });

    helpers.insert('subscriptions', {
      pharmacy_id: pharmacy.id, plan: 'basic',
      amount: 20000, status: 'trial',
      next_billing: new Date(Date.now() + 14*86400000),
    });

    const token = sign({ userId: user.id, pharmacyId: pharmacy.id, role: 'admin', name: user.name });
    res.json({ message: '14-day free trial started!', token, user: { ...user, pharmacyName } });
  });

  // GET /api/auth/me  (protected)
  app.get('/api/auth/me', auth, async (req, res) => {
    const user = helpers.findOne('users', { id: req.user.userId });
    const pharmacy = helpers.findOne('pharmacies', { id: req.user.pharmacyId });
    if (!user) return res.json({ error: 'User not found' }, 404);
    res.json({ ...user, password_hash: undefined, pharmacy });
  });


  // ══════════════════════════════════════════════════════════
  // DASHBOARD — Stats & Charts
  // ══════════════════════════════════════════════════════════

  // GET /api/dashboard
  app.get('/api/dashboard', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const allDrugs = helpers.find('drugs', { pharmacy_id: pharmacyId });
    const recentSales = helpers.find('sales', { pharmacy_id: pharmacyId })
      .sort((a,b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 5);

    const today = new Date().toDateString();
    const todaySales = helpers.find('sales', { pharmacy_id: pharmacyId })
      .filter(s => new Date(s.created_at).toDateString() === today);

    res.json({
      revenueToday: todaySales.reduce((s,x) => s + x.total_amount, 0),
      transactionsToday: todaySales.length,
      lowStockCount: allDrugs.filter(d => d.quantity <= d.threshold).length,
      expiringCount: allDrugs.filter(d => helpers.daysToExpiry(d) <= 30 && helpers.daysToExpiry(d) >= 0).length,
      totalDrugs: allDrugs.length,
      recentSales,
    });
  });

  // GET /api/dashboard/weekly
  app.get('/api/dashboard/weekly', auth, async (req, res) => {
    res.json({ weekly: helpers.weeklyRevenue(req.user.pharmacyId) });
  });


  // ══════════════════════════════════════════════════════════
  // INVENTORY — Drugs Management
  // ══════════════════════════════════════════════════════════

  // GET /api/inventory?search=para&category=Analgesic&status=low
  app.get('/api/inventory', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const { search, category, status } = req.query;

    let drugs = helpers.find('drugs', { pharmacy_id: pharmacyId });

    if (search) drugs = drugs.filter(d => d.name.toLowerCase().includes(search.toLowerCase()));
    if (category) drugs = drugs.filter(d => d.category === category);
    if (status) {
      if (status === 'low')      drugs = drugs.filter(d => helpers.stockStatus(d) === 'low');
      if (status === 'critical') drugs = drugs.filter(d => helpers.stockStatus(d) === 'critical');
      if (status === 'ok')       drugs = drugs.filter(d => helpers.stockStatus(d) === 'ok');
      if (status === 'expiring') drugs = drugs.filter(d => helpers.daysToExpiry(d) <= 30);
    }

    drugs = drugs.map(d => ({
      ...d,
      stock_status: helpers.stockStatus(d),
      days_to_expiry: helpers.daysToExpiry(d),
    }));

    res.json({ drugs, total: drugs.length });
  });

  // GET /api/inventory/alerts
  app.get('/api/inventory/alerts', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const all = helpers.find('drugs', { pharmacy_id: pharmacyId });
    res.json({
      lowStock: all.filter(d => d.quantity <= d.threshold).sort((a,b) => a.quantity - b.quantity),
      expiring: all.filter(d => helpers.daysToExpiry(d) <= 30 && helpers.daysToExpiry(d) >= 0)
                   .sort((a,b) => helpers.daysToExpiry(a) - helpers.daysToExpiry(b)),
    });
  });

  // GET /api/inventory/:id
  app.get('/api/inventory/:id', auth, async (req, res) => {
    const drug = helpers.findOne('drugs', { id: parseInt(req.params.id), pharmacy_id: req.user.pharmacyId });
    if (!drug) return res.json({ error: 'Drug not found' }, 404);
    res.json({ drug });
  });

  // POST /api/inventory
  app.post('/api/inventory', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const { name, category, quantity, unit_price, cost_price, expiry_date, supplier, threshold, requires_rx } = req.body;
    if (!name || !quantity || !unit_price)
      return res.json({ error: 'Name, quantity, and unit price are required' }, 400);
    const drug = helpers.insert('drugs', {
      pharmacy_id: pharmacyId, name, category, quantity: parseInt(quantity),
      max_quantity: parseInt(quantity), unit_price: parseFloat(unit_price),
      cost_price: parseFloat(cost_price || 0),
      expiry_date: expiry_date ? new Date(expiry_date) : null,
      supplier, threshold: parseInt(threshold || 20),
      requires_rx: Boolean(requires_rx),
    });
    res.json({ message: '✅ Drug added to inventory!', drug });
  });

  // PUT /api/inventory/:id
  app.put('/api/inventory/:id', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const id = parseInt(req.params.id);
    const drug = helpers.findOne('drugs', { id, pharmacy_id: pharmacyId });
    if (!drug) return res.json({ error: 'Drug not found' }, 404);
    const { name, category, quantity, unit_price, cost_price, expiry_date, supplier, threshold, requires_rx } = req.body;
    Object.assign(drug, {
      name: name || drug.name,
      category: category || drug.category,
      quantity: quantity !== undefined ? parseInt(quantity) : drug.quantity,
      unit_price: unit_price !== undefined ? parseFloat(unit_price) : drug.unit_price,
      cost_price: cost_price !== undefined ? parseFloat(cost_price) : drug.cost_price,
      expiry_date: expiry_date ? new Date(expiry_date) : drug.expiry_date,
      supplier: supplier || drug.supplier,
      threshold: threshold !== undefined ? parseInt(threshold) : drug.threshold,
      requires_rx: requires_rx !== undefined ? Boolean(requires_rx) : drug.requires_rx,
      updated_at: new Date(),
    });
    res.json({ message: '✅ Drug updated!', drug });
  });

  // DELETE /api/inventory/:id
  app.delete('/api/inventory/:id', auth, async (req, res) => {
    const removed = helpers.remove('drugs', { id: parseInt(req.params.id), pharmacy_id: req.user.pharmacyId });
    if (!removed) return res.json({ error: 'Drug not found' }, 404);
    res.json({ message: '🗑 Drug removed from inventory' });
  });


  // ══════════════════════════════════════════════════════════
  // SALES — Record Sales & Receipts
  // ══════════════════════════════════════════════════════════

  // GET /api/sales
  app.get('/api/sales', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    const sales = helpers.find('sales', { pharmacy_id: pharmacyId })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, parseInt(req.query.limit || 50));
    res.json({ sales, total: sales.length });
  });

  // GET /api/sales/:id
  app.get('/api/sales/:id', auth, async (req, res) => {
    const sale = helpers.findOne('sales', { id: parseInt(req.params.id), pharmacy_id: req.user.pharmacyId });
    if (!sale) return res.json({ error: 'Sale not found' }, 404);
    const items = helpers.find('saleItems', { sale_id: sale.id });
    res.json({ sale, items });
  });

  // POST /api/sales  — record a new sale
  app.post('/api/sales', auth, async (req, res) => {
    const { pharmacyId, userId } = req.user;
    const { customer_name, customer_phone, items, discount_pct = 0, payment_method } = req.body;
    if (!items || !items.length)
      return res.json({ error: 'Sale must have at least one item' }, 400);

    // Calculate totals
    let subtotal = items.reduce((s, i) => s + (i.unit_price * i.quantity), 0);
    const discount_amount = Math.round(subtotal * discount_pct / 100);
    const total_amount = subtotal - discount_amount;

    // Generate receipt number
    const saleCount = helpers.find('sales', { pharmacy_id: pharmacyId }).length;
    const receipt_number = `RCP-${new Date().getFullYear()}-${String(saleCount + 1).padStart(4, '0')}`;

    const sale = helpers.insert('sales', {
      pharmacy_id: pharmacyId, user_id: userId,
      customer_name: customer_name || 'Walk-in',
      customer_phone, subtotal, discount_pct,
      discount_amount, total_amount, payment_method, receipt_number,
    });

    // Save items + deduct from stock
    for (const item of items) {
      helpers.insert('saleItems', {
        sale_id: sale.id, drug_id: item.drug_id,
        drug_name: item.drug_name, quantity: item.quantity,
        unit_price: item.unit_price,
        total_price: item.unit_price * item.quantity,
      });
      // Reduce stock
      const drug = helpers.findOne('drugs', { id: item.drug_id, pharmacy_id: pharmacyId });
      if (drug) drug.quantity = Math.max(0, drug.quantity - item.quantity);
    }

    res.json({ message: '✅ Sale recorded!', sale, receipt_number });
  });


  // ══════════════════════════════════════════════════════════
  // ORDERS — Online Customer Orders
  // ══════════════════════════════════════════════════════════

  // POST /api/orders/public/:pharmacyId  — customer places order (no login)
  app.post('/api/orders/public/:pharmacyId', async (req, res) => {
    const pharmacyId = parseInt(req.params.pharmacyId);
    const pharmacy = helpers.findOne('pharmacies', { id: pharmacyId });
    if (!pharmacy) return res.json({ error: 'Pharmacy not found' }, 404);

    const { customer_name, customer_phone, delivery_address, delivery_type, payment_method, items } = req.body;
    if (!customer_name || !customer_phone || !items?.length)
      return res.json({ error: 'Name, phone, and items are required' }, 400);

    const subtotal = items.reduce((s, i) => s + (i.unit_price * i.quantity), 0);
    const delivery_fee = delivery_type === 'pickup' ? 0 : 5000;
    const total_amount = subtotal + delivery_fee;

    const order = helpers.insert('orders', {
      pharmacy_id: pharmacyId, customer_name, customer_phone,
      delivery_address, delivery_type, payment_method,
      payment_status: 'pending', order_status: 'pending',
      subtotal, delivery_fee, total_amount,
    });

    items.forEach(item => helpers.insert('orderItems', {
      order_id: order.id, drug_id: item.drug_id,
      drug_name: item.drug_name, quantity: item.quantity,
      unit_price: item.unit_price, total_price: item.unit_price * item.quantity,
    }));

    res.json({
      message: '🎉 Order placed! Preparing your medicines.',
      order_id: `ORD-${new Date().getFullYear()}-${String(order.id).padStart(4, '0')}`,
      order_number: order.id,
      estimated_delivery: '25–35 minutes',
    });
  });

  // GET /api/orders  — pharmacy views all orders (protected)
  app.get('/api/orders', auth, async (req, res) => {
    const { pharmacyId } = req.user;
    let orders = helpers.find('orders', { pharmacy_id: pharmacyId })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    if (req.query.status) orders = orders.filter(o => o.order_status === req.query.status);
    res.json({ orders, total: orders.length });
  });

  // PATCH /api/orders/:id/status
  app.patch('/api/orders/:id/status', auth, async (req, res) => {
    const { status } = req.body;
    const valid = ['pending','processing','ready','delivered','cancelled'];
    if (!valid.includes(status)) return res.json({ error: 'Invalid status' }, 400);
    const order = helpers.findOne('orders', { id: parseInt(req.params.id), pharmacy_id: req.user.pharmacyId });
    if (!order) return res.json({ error: 'Order not found' }, 404);
    order.order_status = status;
    order.updated_at = new Date();
    res.json({ message: `✅ Order marked as ${status}`, order });
  });


  // ══════════════════════════════════════════════════════════
  // CUSTOMERS
  // ══════════════════════════════════════════════════════════

  app.get('/api/customers', auth, async (req, res) => {
    const customers = helpers.find('customers', { pharmacy_id: req.user.pharmacyId })
      .sort((a, b) => b.total_spent - a.total_spent);
    res.json({ customers, total: customers.length });
  });

  app.post('/api/customers', auth, async (req, res) => {
    const { name, phone, email, address } = req.body;
    if (!name) return res.json({ error: 'Name required' }, 400);
    const customer = helpers.insert('customers', {
      pharmacy_id: req.user.pharmacyId, name, phone, email, address,
      total_spent: 0, order_count: 0,
    });
    res.json({ message: '✅ Customer added!', customer });
  });


  // ══════════════════════════════════════════════════════════
  // SUBSCRIPTION
  // ══════════════════════════════════════════════════════════

  app.get('/api/subscription', auth, async (req, res) => {
    const subs = helpers.find('subscriptions', { pharmacy_id: req.user.pharmacyId })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({ current: subs[0] || null, history: subs });
  });

  app.post('/api/subscription/upgrade', auth, async (req, res) => {
    const { plan, payment_method } = req.body;
    const prices = { basic: 20000, pro: 50000, enterprise: 150000 };
    if (!prices[plan]) return res.json({ error: 'Invalid plan' }, 400);
    const pharmacy = helpers.findOne('pharmacies', { id: req.user.pharmacyId });
    pharmacy.plan = plan;
    helpers.insert('subscriptions', {
      pharmacy_id: req.user.pharmacyId, plan,
      amount: prices[plan], payment_method, status: 'active',
      billing_date: new Date(),
      next_billing: new Date(Date.now() + 30*86400000),
    });
    res.json({ message: `🎉 Upgraded to ${plan} plan!` });
  });

};
