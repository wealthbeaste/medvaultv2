'use strict';

// ============================================================
// MedVault — Centralised RBAC Permission Map
// Phase 1: Replace scattered role checks with this registry.
// Usage: app.post('/api/...', auth, can('inventory:write'), handler)
// ============================================================

const PERMISSIONS = {
  // Inventory
  'inventory:read':       ['owner', 'manager', 'cashier', 'dispensor', 'super_admin'],
  'inventory:write':      ['owner', 'manager', 'super_admin'],
  'inventory:delete':     ['owner', 'super_admin'],
  'inventory:adjust':     ['owner', 'manager', 'super_admin'],

  // Sales
  'sales:create':         ['owner', 'manager', 'dispensor', 'super_admin'],
  'sales:read':           ['owner', 'manager', 'cashier', 'dispensor', 'super_admin'],
  'sales:void':           ['owner', 'manager', 'super_admin'],

  // Customers
  'customers:read':       ['owner', 'manager', 'cashier', 'dispensor', 'super_admin'],
  'customers:write':      ['owner', 'manager', 'super_admin'],

  // Staff
  'staff:invite':         ['owner', 'super_admin'],
  'staff:deactivate':     ['owner', 'super_admin'],
  'staff:read':           ['owner', 'manager', 'super_admin'],

  // Branches
  'branches:manage':      ['owner', 'super_admin'],
  'branches:read':        ['owner', 'manager', 'super_admin'],

  // Reports
  'reports:financial':    ['owner', 'super_admin'],
  'reports:nda':          ['owner', 'manager', 'super_admin'],
  'reports:daily':        ['owner', 'manager', 'super_admin'],

  // Credit
  'credit:manage':        ['owner', 'manager', 'super_admin'],
  'credit:read':          ['owner', 'manager', 'cashier', 'super_admin'],

  // Transfers
  'transfers:request':    ['owner', 'manager', 'super_admin'],
  'transfers:approve':    ['owner', 'super_admin'],

  // Suppliers
  'suppliers:read':       ['owner', 'manager', 'super_admin'],
  'suppliers:write':      ['owner', 'manager', 'super_admin'],

  // Notifications
  'notifications:read':   ['owner', 'manager', 'cashier', 'dispensor', 'super_admin'],

  // Audit logs
  'audit:read':           ['owner', 'super_admin'],

  // Platform admin
  'admin:platform':       ['super_admin'],
};

/**
 * Middleware factory — checks if req.user.role has the given permission.
 * @param {string} permission  e.g. 'inventory:write'
 */
function can(permission) {
  return (req, res, next) => {
    const allowed = PERMISSIONS[permission] || [];
    if (!req.user || !allowed.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: `Access denied: requires '${permission}'`,
        code: 'PERMISSION_DENIED',
      });
    }
    next();
  };
}

module.exports = { can, PERMISSIONS };
