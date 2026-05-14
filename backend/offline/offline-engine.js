// ============================================================
// MedVault Offline Engine
// Handles: local storage, sync queue, conflict resolution
// Works in any browser — no npm packages needed
// ============================================================

const MedVaultOffline = {

  DB_KEY:     'mv_offline_db',
  QUEUE_KEY:  'mv_sync_queue',
  META_KEY:   'mv_sync_meta',
  API_BASE:   'http://localhost:4000',

  // ── Read entire local DB ─────────────────────────────────
  getDB() {
    try {
      return JSON.parse(localStorage.getItem(this.DB_KEY) || '{}');
    } catch { return {}; }
  },

  // ── Save entire local DB ─────────────────────────────────
  saveDB(db) {
    localStorage.setItem(this.DB_KEY, JSON.stringify(db));
  },

  // ── Get a specific table ─────────────────────────────────
  getTable(table) {
    return this.getDB()[table] || [];
  },

  // ── Save a table ─────────────────────────────────────────
  saveTable(table, rows) {
    const db = this.getDB();
    db[table] = rows;
    this.saveDB(db);
  },

  // ── Queue an action to sync when online ─────────────────
  // action = { type: 'sale'|'order'|'drug', method: 'POST'|'PUT'|'DELETE', url, body }
  queueAction(action) {
    const queue = JSON.parse(localStorage.getItem(this.QUEUE_KEY) || '[]');
    queue.push({
      ...action,
      id:        Date.now() + Math.random(),
      timestamp: new Date().toISOString(),
      synced:    false,
    });
    localStorage.setItem(this.QUEUE_KEY, JSON.stringify(queue));
    this.updateSyncUI();
  },

  // ── Get pending sync queue ───────────────────────────────
  getQueue() {
    return JSON.parse(localStorage.getItem(this.QUEUE_KEY) || '[]');
  },

  // ── Clear synced items from queue ────────────────────────
  clearSynced() {
    const queue = this.getQueue().filter(a => !a.synced);
    localStorage.setItem(this.QUEUE_KEY, JSON.stringify(queue));
  },

  // ── Check if we're online ────────────────────────────────
  isOnline() {
    return navigator.onLine;
  },

  // ── Get sync metadata ────────────────────────────────────
  getMeta() {
    try {
      return JSON.parse(localStorage.getItem(this.META_KEY) || '{}');
    } catch { return {}; }
  },

  saveMeta(meta) {
    localStorage.setItem(this.META_KEY, JSON.stringify({
      ...this.getMeta(), ...meta
    }));
  },

  // ── Full sync: pull server data down to local ────────────
  async pullFromServer(token) {
    if (!this.isOnline()) return { success: false, reason: 'offline' };
    try {
      const headers = { 'Authorization': 'Bearer ' + token };

      const [inv, sales, orders, customers, dash] = await Promise.all([
        fetch(this.API_BASE + '/api/inventory', { headers }).then(r => r.json()),
        fetch(this.API_BASE + '/api/sales?limit=100', { headers }).then(r => r.json()),
        fetch(this.API_BASE + '/api/orders', { headers }).then(r => r.json()),
        fetch(this.API_BASE + '/api/customers', { headers }).then(r => r.json()),
        fetch(this.API_BASE + '/api/dashboard', { headers }).then(r => r.json()),
      ]);

      const db = this.getDB();
      if (inv.drugs)        db.drugs     = inv.drugs;
      if (sales.sales)      db.sales     = sales.sales;
      if (orders.orders)    db.orders    = orders.orders;
      if (customers.customers) db.customers = customers.customers;
      if (dash.revenueToday !== undefined) db.dashboard = dash;
      this.saveDB(db);

      this.saveMeta({ lastSync: new Date().toISOString(), status: 'synced' });
      this.updateSyncUI();
      return { success: true, synced: new Date().toISOString() };

    } catch (err) {
      this.saveMeta({ status: 'error', lastError: err.message });
      return { success: false, reason: err.message };
    }
  },

  // ── Push queued actions to server ────────────────────────
  async pushToServer(token) {
    if (!this.isOnline()) return { success: false, pushed: 0 };
    const queue = this.getQueue().filter(a => !a.synced);
    if (!queue.length) return { success: true, pushed: 0 };

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
    };

    let pushed = 0;
    for (const action of queue) {
      try {
        const res = await fetch(this.API_BASE + action.url, {
          method: action.method,
          headers,
          body: action.body ? JSON.stringify(action.body) : undefined,
        });
        if (res.ok) {
          action.synced = true;
          pushed++;
        }
      } catch (e) {
        // Keep in queue, try next time
      }
    }

    localStorage.setItem(this.QUEUE_KEY, JSON.stringify(queue));
    this.clearSynced();
    this.saveMeta({ lastPush: new Date().toISOString() });
    this.updateSyncUI();
    return { success: true, pushed };
  },

  // ── Full bidirectional sync ───────────────────────────────
  async sync(token) {
    const push = await this.pushToServer(token);
    const pull = await this.pullFromServer(token);
    return { push, pull };
  },

  // ── LOCAL OPERATIONS (work offline) ─────────────────────

  // Record a sale locally
  recordSaleLocal(saleData) {
    const sales = this.getTable('sales');
    const id = Date.now();
    const receiptNum = 'RCP-' + new Date().getFullYear() + '-' + String(sales.length + 1).padStart(4, '0') + '-OFF';
    const sale = {
      id,
      ...saleData,
      receipt_number: receiptNum,
      created_at: new Date().toISOString(),
      _offline: true,
    };
    sales.unshift(sale);
    this.saveTable('sales', sales);

    // Reduce stock locally
    const drugs = this.getTable('drugs');
    (saleData.items || []).forEach(item => {
      const drug = drugs.find(d => d.id === item.drug_id);
      if (drug) drug.quantity = Math.max(0, drug.quantity - item.quantity);
    });
    this.saveTable('drugs', drugs);

    // Queue for server sync
    this.queueAction({
      type: 'sale',
      method: 'POST',
      url: '/api/sales',
      body: saleData,
    });

    return { sale, receipt_number: receiptNum };
  },

  // Place an order locally
  placeOrderLocal(orderData) {
    const orders = this.getTable('orders');
    const order = {
      id: Date.now(),
      ...orderData,
      order_status: 'pending',
      created_at: new Date().toISOString(),
      _offline: true,
    };
    orders.unshift(order);
    this.saveTable('orders', orders);

    this.queueAction({
      type: 'order',
      method: 'POST',
      url: '/api/orders/public/1',
      body: orderData,
    });

    return order;
  },

  // Add a drug locally
  addDrugLocal(drugData) {
    const drugs = this.getTable('drugs');
    const drug = {
      id: 'offline_' + Date.now(),
      ...drugData,
      stock_status: 'ok',
      created_at: new Date().toISOString(),
      _offline: true,
    };
    drugs.push(drug);
    this.saveTable('drugs', drugs);

    this.queueAction({
      type: 'drug',
      method: 'POST',
      url: '/api/inventory',
      body: drugData,
    });

    return drug;
  },

  // ── LOCAL READS ──────────────────────────────────────────

  getDrugs(filters = {}) {
    let drugs = this.getTable('drugs');
    if (filters.search) {
      drugs = drugs.filter(d => d.name.toLowerCase().includes(filters.search.toLowerCase()));
    }
    if (filters.status) {
      drugs = drugs.filter(d => d.stock_status === filters.status);
    }
    return drugs.map(d => ({
      ...d,
      stock_status: d.stock_status || this._calcStatus(d),
      days_to_expiry: d.expiry_date
        ? Math.ceil((new Date(d.expiry_date) - new Date()) / 86400000)
        : 999,
    }));
  },

  _calcStatus(d) {
    if (d.quantity === 0) return 'out';
    if (d.quantity <= d.threshold) return 'critical';
    if (d.quantity <= d.threshold * 1.5) return 'low';
    return 'ok';
  },

  getSales(limit = 50) {
    return this.getTable('sales').slice(0, limit);
  },

  getOrders(status = '') {
    const orders = this.getTable('orders');
    return status ? orders.filter(o => o.order_status === status) : orders;
  },

  getCustomers() {
    return this.getTable('customers');
  },

  getDashboardStats() {
    const drugs   = this.getTable('drugs');
    const sales   = this.getTable('sales');
    const today   = new Date().toDateString();
    const todaySales = sales.filter(s => new Date(s.created_at).toDateString() === today);

    return {
      revenueToday:      todaySales.reduce((s, x) => s + (x.total_amount || 0), 0),
      transactionsToday: todaySales.length,
      lowStockCount:     drugs.filter(d => d.quantity <= d.threshold).length,
      expiringCount:     drugs.filter(d => {
        const days = Math.ceil((new Date(d.expiry_date) - new Date()) / 86400000);
        return days <= 30 && days >= 0;
      }).length,
      totalDrugs:        drugs.length,
      recentSales:       sales.slice(0, 5),
    };
  },

  getWeeklyRevenue() {
    const sales = this.getTable('sales');
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const label = d.toLocaleDateString('en-UG', { weekday: 'short' });
      const revenue = sales
        .filter(s => new Date(s.created_at).toDateString() === d.toDateString())
        .reduce((s, x) => s + (x.total_amount || 0), 0);
      days.push({ day: d.toISOString().split('T')[0], label, revenue });
    }
    return days;
  },

  // ── SYNC UI ──────────────────────────────────────────────
  updateSyncUI() {
    const queue    = this.getQueue().filter(a => !a.synced);
    const meta     = this.getMeta();
    const online   = this.isOnline();
    const bar      = document.getElementById('syncBar');
    const dot      = document.getElementById('syncDot');
    const txt      = document.getElementById('syncTxt');
    const badge    = document.getElementById('syncBadge');

    if (!bar) return;

    if (!online) {
      bar.style.background  = 'rgba(239,68,68,0.12)';
      bar.style.borderColor = 'rgba(239,68,68,0.25)';
      dot.style.background  = '#ef4444';
      txt.textContent       = '📴 Offline — changes saved locally';
      dot.style.animation   = 'none';
    } else if (queue.length > 0) {
      bar.style.background  = 'rgba(245,158,11,0.1)';
      bar.style.borderColor = 'rgba(245,158,11,0.2)';
      dot.style.background  = '#f59e0b';
      txt.textContent       = `⏳ ${queue.length} change${queue.length > 1 ? 's' : ''} waiting to sync…`;
    } else {
      bar.style.background  = 'rgba(16,185,129,0.08)';
      bar.style.borderColor = 'rgba(16,185,129,0.15)';
      dot.style.background  = '#10b981';
      const t = meta.lastSync ? new Date(meta.lastSync).toLocaleTimeString('en-UG', { hour: '2-digit', minute: '2-digit' }) : 'never';
      txt.textContent       = `✅ Synced · Last: ${t}`;
      dot.style.animation   = 'pulse 2s infinite';
    }

    if (badge) {
      badge.textContent     = queue.length || '';
      badge.style.display   = queue.length ? 'flex' : 'none';
    }
  },

  // ── INIT: listen for online/offline events ───────────────
  init(token) {
    this._token = token;

    window.addEventListener('online', async () => {
      this.updateSyncUI();
      const result = await this.sync(token);
      if (result.push.pushed > 0) {
        this._showToast(`☁️ Synced ${result.push.pushed} offline change${result.push.pushed > 1 ? 's' : ''} to server!`);
      }
    });

    window.addEventListener('offline', () => {
      this.updateSyncUI();
      this._showToast('📴 You\'re offline — MedVault keeps working. Changes will sync when you reconnect.', 'warn');
    });

    this.updateSyncUI();

    // Auto-sync every 2 minutes when online
    setInterval(async () => {
      if (this.isOnline() && this._token) {
        await this.sync(this._token);
      }
    }, 120000);
  },

  _showToast(msg, type = '') {
    const t = document.getElementById('toast');
    if (!t) return;
    document.getElementById('toastMsg').textContent = msg;
    t.className = 'toast ' + type;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 4000);
  },

  // ── STORAGE INFO ─────────────────────────────────────────
  getStorageInfo() {
    const db    = localStorage.getItem(this.DB_KEY) || '';
    const queue = localStorage.getItem(this.QUEUE_KEY) || '';
    const kbUsed = Math.round((db.length + queue.length) / 1024);
    return {
      kbUsed,
      mbUsed:      (kbUsed / 1024).toFixed(2),
      queueLength: this.getQueue().filter(a => !a.synced).length,
      lastSync:    this.getMeta().lastSync || 'Never',
      drugsStored: this.getTable('drugs').length,
      salesStored: this.getTable('sales').length,
    };
  },

  // ── CLEAR all local data ─────────────────────────────────
  clearLocalData() {
    localStorage.removeItem(this.DB_KEY);
    localStorage.removeItem(this.QUEUE_KEY);
    localStorage.removeItem(this.META_KEY);
  },
};

// Make globally available
window.MedVaultOffline = MedVaultOffline;
