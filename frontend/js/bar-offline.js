
// ============================================================
// MedVault Bar — Offline Engine
// ------------------------------------------------------------
// Why this isn't just a copy of the pharmacy offline engine:
// a pharmacy sale is one atomic POST. A bar tab is built over
// hours with several *dependent* calls against the same order
// id (create order → add item → add item → payment → close).
// If the order itself was created while offline, every later
// call in that chain only has a temporary local id to work
// with until the create-order call finally reaches the server.
//
// This engine queues actions FIFO (so a create always syncs
// before the item/payment/close calls that depend on it) and
// resolves any "local_..." id — in the URL or in the request
// body — against a real server id the moment it's known.
// ============================================================

const BarOffline = {
  CACHE_KEY: 'mv_bar_cache',   // { tables:[...], menu_items:[...] }
  ORDERS_KEY: 'mv_bar_local_orders', // { [id]: orderObject } incl. offline-created orders
  QUEUE_KEY: 'mv_bar_queue',
  FAILED_KEY: 'mv_bar_failed_queue', // actions that got a definitive rejection from the server
  META_KEY: 'mv_bar_meta',     // { idMap:{local_id: realId}, lastSync, lastPush, status }

  // ── low-level storage ────────────────────────────────────
  _read(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || fallback); }
    catch { return JSON.parse(fallback); }
  },
  _write(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} },

  getCache() { return this._read(this.CACHE_KEY, '{}'); },
  saveCache(c) { this._write(this.CACHE_KEY, c); },

  getLocalOrders() { return this._read(this.ORDERS_KEY, '{}'); },
  saveLocalOrders(o) { this._write(this.ORDERS_KEY, o); },

  getQueue() { return this._read(this.QUEUE_KEY, '[]'); },
  saveQueue(q) { this._write(this.QUEUE_KEY, q); },

  getFailed() { return this._read(this.FAILED_KEY, '[]'); },
  saveFailed(f) { this._write(this.FAILED_KEY, f); },

  getMeta() { return this._read(this.META_KEY, '{"idMap":{}}'); },
  saveMeta(m) { this._write(this.META_KEY, { ...this.getMeta(), ...m }); },

  isOnline() { return navigator.onLine; },

  // ── read caches (tables + menu) ──────────────────────────
  cacheTables(tables) { const c = this.getCache(); c.tables = tables; this.saveCache(c); },
  getCachedTables() { return this.getCache().tables || []; },

  cacheMenu(items) { const c = this.getCache(); c.menu_items = items; this.saveCache(c); },
  getCachedMenu() { return this.getCache().menu_items || []; },

  // ── local order helpers ──────────────────────────────────
  getLocalOrder(id) { return this.getLocalOrders()[id] || null; },
  saveLocalOrder(order) { const o = this.getLocalOrders(); o[order.id] = order; this.saveLocalOrders(o); },

  findOpenLocalOrderForTable(tableId) {
    const orders = this.getLocalOrders();
    return Object.values(orders).find(o => o.table_id === tableId && o.status === 'open') || null;
  },

  _genLocalId(prefix) {
    return 'local_' + prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  },

  // ── queueing ──────────────────────────────────────────────
  // action.url / action.body may contain "local_..." ids (in the path
  // or as an *_id field) that only get resolved once their creating
  // action has synced. createsLocalId + createsField tell the push
  // loop "when this succeeds, remember the server id it was given".
  queueAction(action) {
    const q = this.getQueue();
    q.push({ ...action, id: Date.now() + '_' + Math.random(), timestamp: new Date().toISOString() });
    this.saveQueue(q);
    this.updateSyncUI();
  },

  // ── LOCAL WRITES (work fully offline) ────────────────────

  createTableLocal(tableNumber, capacity) {
    const localId = this._genLocalId('table');
    const table = { id: localId, table_number: tableNumber, capacity: capacity || 4, status: 'available', _offline: true };
    const tables = this.getCachedTables();
    tables.push(table);
    this.cacheTables(tables);
    this.queueAction({
      type: 'bar_table_create', method: 'POST', url: '/api/bar/tables',
      body: { table_number: tableNumber, capacity: capacity || 4 },
      createsLocalId: localId, createsField: 'table',
    });
    return table;
  },

  createOrderLocal(tableId) {
    const localId = this._genLocalId('order');
    const order = {
      id: localId, table_id: tableId, status: 'open', items: [],
      total_amount: 0, paid_amount: 0, balance_due: 0,
      opened_at: new Date().toISOString(), _offline: true,
    };
    this.saveLocalOrder(order);
    this.queueAction({
      type: 'bar_order_create', method: 'POST', url: '/api/bar/orders',
      body: { table_id: tableId },
      createsLocalId: localId, createsField: 'order',
    });
    return order;
  },

  addItemLocal(order, menuItem, quantity) {
    quantity = quantity || 1;
    const item = {
      id: this._genLocalId('item'), item_name: menuItem.name, quantity,
      unit_price: Number(menuItem.price), menu_item_id: menuItem.id,
      created_at: new Date().toISOString(), _offline: true,
    };
    order.items = order.items || [];
    order.items.push(item);
    order.total_amount = order.items.reduce((s, i) => s + i.quantity * Number(i.unit_price), 0);
    order.balance_due = order.total_amount - (order.paid_amount || 0);
    this.saveLocalOrder(order);

    // Reflect the depletion in the cached menu so the low-stock hint
    // and "Add" buttons don't drift while offline.
    const menu = this.getCachedMenu();
    const mi = menu.find(m => m.id === menuItem.id);
    if (mi && mi.quantity_on_hand != null) mi.quantity_on_hand = Math.max(0, mi.quantity_on_hand - quantity);
    this.cacheMenu(menu);

    this.queueAction({
      type: 'bar_item_add', method: 'POST',
      url: `/api/bar/orders/${order.id}/items`,
      body: { menu_item_id: menuItem.id, quantity },
    });
    return item;
  },

  recordPaymentLocal(order, paymentBody) {
    const payment = { ...paymentBody, id: this._genLocalId('pay'), created_at: new Date().toISOString(), _offline: true };
    order.paid_amount = Number(order.paid_amount || 0) + Number(paymentBody.amount);
    order.balance_due = Math.max(0, order.total_amount - order.paid_amount);
    order.payments = order.payments || [];
    order.payments.push(payment);
    if (order.balance_due <= 0.01) { order.status = 'paid'; order.closed_at = new Date().toISOString(); }
    this.saveLocalOrder(order);

    this.queueAction({
      type: 'bar_payment', method: 'POST',
      url: `/api/bar/orders/${order.id}/payments`,
      body: paymentBody,
    });
    return payment;
  },

  voidOrderLocal(order) {
    order.status = 'void';
    order.closed_at = new Date().toISOString();
    this.saveLocalOrder(order);
    this.queueAction({
      type: 'bar_order_close', method: 'POST',
      url: `/api/bar/orders/${order.id}/close`,
      body: {},
    });
    return order;
  },

  // ── SYNC ──────────────────────────────────────────────────

  // Replace any "local_xxx" token — in the URL path or as a body field —
  // with its resolved server id. Returns {ready:false} if something it
  // depends on hasn't synced yet, so the caller leaves it queued.
  _resolve(action, idMap) {
    let ready = true;
    const sub = (s) => s.replace(/local_[a-zA-Z0-9_]+/g, (m) => {
      if (idMap[m] != null) return idMap[m];
      ready = false;
      return m;
    });
    const url = sub(action.url);
    let body = action.body;
    if (body && typeof body === 'object') {
      body = { ...body };
      for (const k of Object.keys(body)) {
        if (typeof body[k] === 'string' && body[k].startsWith('local_')) {
          if (idMap[body[k]] != null) body[k] = idMap[body[k]];
          else ready = false;
        }
      }
    }
    return { ready, url, body };
  },

  async _request(base, token, method, url, body) {
    try {
      const res = await fetch(base + url, {
        method,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (token || '') },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let data = {};
      try { data = await res.json(); } catch (e) {}
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      return { ok: false, status: 0, data: { error: e.message || 'Network error' } };
    }
  },

  // Pushes the queue FIFO. Because create-order/create-table actions are
  // always queued before anything that depends on them, one linear pass
  // is enough to resolve ids within the same sync — no separate ordering
  // logic needed.
  async pushToServer(base, token) {
    if (!this.isOnline()) return { pushed: 0, failed: 0 };
    const queue = this.getQueue();
    if (!queue.length) return { pushed: 0, failed: 0 };
    const meta = this.getMeta();
    const idMap = { ...(meta.idMap || {}) };
    const remaining = [];
    const newlyFailed = [];
    let pushed = 0;

    for (const action of queue) {
      const { ready, url, body } = this._resolve(action, idMap);
      if (!ready) { remaining.push(action); continue; }

      const res = await this._request(base, token, action.method, url, body);

      if (res.ok) {
        pushed++;
        if (action.createsLocalId && res.data && res.data[action.createsField] && res.data[action.createsField].id) {
          idMap[action.createsLocalId] = String(res.data[action.createsField].id);
        }
      } else if (res.status === 0) {
        // Network problem mid-sync — stop here, keep this and everything
        // after it queued for the next attempt.
        remaining.push(action);
        remaining.push(...queue.slice(queue.indexOf(action) + 1).filter(a => !remaining.includes(a)));
        break;
      } else {
        // Server gave a definitive answer and rejected it (e.g. stock ran
        // out, order already closed by another terminal). Retrying forever
        // would just hide a real conflict, so this goes to a separate
        // failed list for a human to review instead.
        newlyFailed.push({ ...action, error: res.data?.error || `Failed (${res.status})`, failedAt: new Date().toISOString() });
      }
    }

    this.saveQueue(remaining);
    if (newlyFailed.length) this.saveFailed([...this.getFailed(), ...newlyFailed]);
    this.saveMeta({ idMap, lastPush: new Date().toISOString() });
    this.updateSyncUI();
    return { pushed, failed: newlyFailed.length };
  },

  async pullFromServer(base, token) {
    if (!this.isOnline()) return { success: false, reason: 'offline' };
    try {
      const headers = { 'Authorization': 'Bearer ' + (token || '') };
      const [tablesRes, menuRes] = await Promise.all([
        fetch(base + '/api/bar/tables', { headers }).then(r => r.json()).catch(() => null),
        fetch(base + '/api/bar/menu-items', { headers }).then(r => r.json()).catch(() => null),
      ]);
      if (tablesRes && tablesRes.tables) this.cacheTables(tablesRes.tables);
      if (menuRes && menuRes.items) this.cacheMenu(menuRes.items);
      this.saveMeta({ lastSync: new Date().toISOString(), status: 'synced' });
      this.updateSyncUI();
      return { success: true };
    } catch (e) {
      return { success: false, reason: e.message };
    }
  },

  async sync(base, token) {
    const push = await this.pushToServer(base, token);
    const pull = await this.pullFromServer(base, token);
    return { push, pull };
  },

  getPendingCount() { return this.getQueue().length; },
  getFailedCount() { return this.getFailed().length; },

  // ── sync status bar ───────────────────────────────────────
  updateSyncUI() {
    const bar = document.getElementById('barSyncBar');
    if (!bar) return;
    const pending = this.getPendingCount();
    const failed = this.getFailedCount();
    const online = this.isOnline();
    const meta = this.getMeta();

    if (failed > 0) {
      bar.style.background = 'rgba(231,76,60,.12)'; bar.style.borderColor = 'rgba(231,76,60,.3)';
      bar.textContent = `⚠ ${failed} change${failed > 1 ? 's' : ''} couldn't sync — needs review`;
    } else if (!online) {
      bar.style.background = 'rgba(231,76,60,.1)'; bar.style.borderColor = 'rgba(231,76,60,.25)';
      bar.textContent = '📴 Offline — orders and payments are saving on this device';
    } else if (pending > 0) {
      bar.style.background = 'rgba(245,166,35,.1)'; bar.style.borderColor = 'rgba(245,166,35,.25)';
      bar.textContent = `⏳ ${pending} change${pending > 1 ? 's' : ''} waiting to sync…`;
    } else {
      bar.style.background = 'rgba(46,204,113,.08)'; bar.style.borderColor = 'rgba(46,204,113,.2)';
      const t = meta.lastSync ? new Date(meta.lastSync).toLocaleTimeString('en-UG', { hour: '2-digit', minute: '2-digit' }) : 'never';
      bar.textContent = `✅ Synced · last ${t}`;
    }
    bar.style.display = 'block';
  },

  init(base, token) {
    window.addEventListener('online', async () => {
      this.updateSyncUI();
      const r = await this.sync(base, token);
      if (r.push.pushed > 0 && typeof window.onBarSynced === 'function') window.onBarSynced(r);
    });
    window.addEventListener('offline', () => this.updateSyncUI());
    this.updateSyncUI();
    setInterval(async () => {
      if (this.isOnline()) {
        const r = await this.sync(base, token);
        if (r.push.pushed > 0 && typeof window.onBarSynced === 'function') window.onBarSynced(r);
      }
    }, 45000);
  },
};

window.BarOffline = BarOffline;
