// ============================================================
// MedVault — Centralised RBAC Permissions
// ============================================================
// Single source of truth for every role → action mapping.
// Adding a new role or permission means editing ONE file here,
// not hunting through hundreds of route lines.
//
// Usage in routes:
//   const { can } = require('../middleware/permissions');
//   app.get('/api/inventory', auth, can('inventory:read'), handler);
// ============================================================

'use strict';

// ── Permission map ────────────────────────────────────────────────────────
// Each key is a permission string.
// Each value is the list of roles that hold that permission.
// Roles: super_admin | owner | manager | cashier | dispensor | staff
// ─────────────────────────────────────────────────────────────────────────
const PERMISSIONS = {

  // ── Dashboard ────────────────────────────────────────────
  'dashboard:view':           ['owner', 'manager', 'cashier'],

  // ── Inventory ────────────────────────────────────────────
  'inventory:read':           ['owner', 'manager', 'cashier', 'dispensor'],
  'inventory:write':          ['owner', 'manager'],
  'inventory:delete':         ['owner', 'manager'],
  'inventory:alerts':         ['owner', 'manager', 'cashier'],

  // ── Sales ────────────────────────────────────────────────
  'sales:read':               ['owner', 'manager', 'cashier'],
  'sales:create':             ['owner', 'manager', 'dispensor'],
  // cashiers collect via dispatch — they cannot POST /api/sales directly

  // ── Dispatch (dispensor → cashier workflow) ───────────────
  'dispatch:create':          ['owner', 'manager', 'dispensor'],
  'dispatch:collect':         ['owner', 'manager', 'cashier'],
  'dispatch:view_pending':    ['owner', 'manager', 'cashier'],
  'dispatch:view_mine':       ['owner', 'manager', 'cashier', 'dispensor'],
  'dispatch:cancel':          ['owner', 'manager', 'cashier', 'dispensor'],

  // ── Shifts ───────────────────────────────────────────────
  'shifts:manage':            ['owner', 'manager', 'cashier'],

  // ── Orders ───────────────────────────────────────────────
  'orders:read':              ['owner', 'manager', 'cashier'],
  'orders:update_status':     ['owner', 'manager', 'cashier'],

  // ── Customers ────────────────────────────────────────────
  'customers:read':           ['owner', 'manager', 'cashier'],
  'customers:write':          ['owner', 'manager', 'cashier'],
  'customers:delete':         ['owner', 'manager'],

  // ── Credit ───────────────────────────────────────────────
  'credit:read':              ['owner', 'manager', 'cashier'],
  'credit:write':             ['owner', 'manager'],
  'credit:remind':            ['owner', 'manager', 'cashier'],

  // ── Branches ─────────────────────────────────────────────
  'branches:read':            ['owner', 'manager', 'cashier', 'dispensor'],
  'branches:write':           ['owner', 'super_admin'],

  // ── Stock Transfers ──────────────────────────────────────
  'transfers:read':           ['owner', 'manager'],
  'transfers:request':        ['owner', 'manager'],
  'transfers:approve':        ['owner'],

  // ── Staff ────────────────────────────────────────────────
  'staff:read':               ['owner', 'manager'],
  'staff:invite':             ['owner', 'super_admin'],
  'staff:deactivate':         ['owner', 'super_admin'],

  // ── Reports ──────────────────────────────────────────────
  'reports:nda':              ['owner', 'manager'],
  'reports:tax':              ['owner'],
  'reports:activity':         ['owner', 'manager'],
  'reports:variance':         ['owner', 'manager'],
  'reports:forecast':         ['owner', 'manager'],
  'reports:expiry':           ['owner', 'manager'],
  'reports:org_summary':      ['owner'],

  // ── Subscription ─────────────────────────────────────────
  'subscription:read':        ['owner'],

  // ── AI ───────────────────────────────────────────────────
  // AI endpoint is public (no auth required) so no permission entry needed

  // ── Super Admin platform management ──────────────────────
  'admin:platform':           ['super_admin'],
};

// ── can() middleware factory ──────────────────────────────────────────────
// Returns a middleware function that checks one permission.
// On failure: 403 with a clear message naming the missing permission.
// On success: calls next() immediately.
//
// Example:
//   app.post('/api/inventory', auth, can('inventory:write'), handler)
// ─────────────────────────────────────────────────────────────────────────
function can(permission) {
  const allowed = PERMISSIONS[permission];

  if (!allowed) {
    // Catch typos at startup time, not at runtime
    throw new Error(`[permissions] Unknown permission: "${permission}". Add it to PERMISSIONS map.`);
  }

  return function checkPermission(req, res, next) {
    const role = req.user && req.user.role;

    if (!role) {
      return res.status(401).json({
        success: false,
        error:   'Not authenticated.',
      });
    }

    if (!allowed.includes(role)) {
      return res.status(403).json({
        success:    false,
        error:      'You do not have permission to perform this action.',
        required:   permission,
        your_role:  role,
      });
    }

    next();
  };
}

// ── hasPermission() — non-middleware helper for conditional logic ──────────
// Use when you need to CHECK a permission inside a handler without blocking.
//
// Example:
//   if (hasPermission(req.user.role, 'reports:tax')) { ... }
// ─────────────────────────────────────────────────────────────────────────
function hasPermission(role, permission) {
  const allowed = PERMISSIONS[permission] || [];
  return allowed.includes(role);
}

module.exports = { can, hasPermission, PERMISSIONS };
