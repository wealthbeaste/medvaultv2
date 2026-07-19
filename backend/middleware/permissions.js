// ============================================================
// MedVault — Centralised RBAC Permissions
// ============================================================
// BUG FIXES (2025):
//   1. Added 'pharmacist' role to all relevant permissions
//      (it existed in the frontend page-access map but was
//       MISSING from every backend PERMISSIONS entry — so
//       pharmacists got 403 on every protected API call)
//   2. Added 'inventory_manager' role (alias for pharmacist
//      in the context of stock — mapped the same permissions)
//   3. 'dispensor' already existed; kept intact
//   4. Normalise role strings to lower-case before matching
//      so that DB values with mixed case (e.g. "Staff") never
//      cause silent 403s
// ============================================================

'use strict';

const PERMISSIONS = {

  // ── Dashboard ────────────────────────────────────────────
  'dashboard:view':           ['owner', 'manager', 'pharmacist', 'inventory_manager', 'cashier', 'staff', 'dispensor'],

  // ── Inventory ────────────────────────────────────────────
  'inventory:read':           ['owner', 'manager', 'pharmacist', 'inventory_manager', 'cashier', 'dispensor', 'staff'],
  'inventory:write':          ['owner', 'manager', 'pharmacist', 'inventory_manager'],
  'settings:write':           ['owner', 'manager'],
  'inventory:delete':         ['owner', 'manager', 'pharmacist', 'inventory_manager'],
  'inventory:alerts':         ['owner', 'manager', 'pharmacist', 'inventory_manager', 'cashier', 'staff', 'dispensor'],

  // ── Sales ────────────────────────────────────────────────
  'sales:read':               ['owner', 'manager', 'pharmacist', 'inventory_manager', 'cashier', 'staff', 'dispensor'],
  'sales:create':             ['owner', 'manager', 'pharmacist', 'dispensor', 'staff'],

  // ── Dispatch (dispensor → cashier workflow) ───────────────
  'dispatch:create':          ['owner', 'manager', 'pharmacist', 'dispensor', 'staff'],
  'dispatch:collect':         ['owner', 'manager', 'cashier', 'staff'],
  'dispatch:view_pending':    ['owner', 'manager', 'pharmacist', 'cashier', 'staff', 'dispensor'],
  'dispatch:view_mine':       ['owner', 'manager', 'pharmacist', 'cashier', 'dispensor', 'staff'],
  'dispatch:cancel':          ['owner', 'manager', 'pharmacist', 'cashier', 'dispensor', 'staff'],

  // ── Shifts ───────────────────────────────────────────────
  'shifts:manage':            ['owner', 'manager', 'cashier', 'staff'],

  // ── Orders ───────────────────────────────────────────────
  'orders:read':              ['owner', 'manager', 'pharmacist', 'inventory_manager', 'cashier', 'staff'],
  'orders:update_status':     ['owner', 'manager', 'pharmacist', 'cashier', 'staff'],

  // ── Customers ────────────────────────────────────────────
  'customers:read':           ['owner', 'manager', 'pharmacist', 'cashier', 'staff'],
  'customers:write':          ['owner', 'manager', 'pharmacist', 'cashier', 'staff'],
  'customers:delete':         ['owner', 'manager'],

  // ── Credit ───────────────────────────────────────────────
  'credit:read':              ['owner', 'manager', 'pharmacist', 'cashier', 'staff'],
  'credit:write':             ['owner', 'manager', 'pharmacist'],
  'credit:remind':            ['owner', 'manager', 'pharmacist', 'cashier', 'staff'],

  // ── Branches ─────────────────────────────────────────────
  'branches:read':            ['owner', 'manager', 'pharmacist', 'inventory_manager', 'cashier', 'dispensor', 'staff'],
  'branches:write':           ['owner', 'super_admin'],

  // ── Stock Transfers ──────────────────────────────────────
  'transfers:read':           ['owner', 'manager', 'pharmacist', 'inventory_manager'],
  'transfers:request':        ['owner', 'manager', 'pharmacist', 'inventory_manager'],
  'transfers:approve':        ['owner'],

  // ── Staff ────────────────────────────────────────────────
  'staff:read':               ['owner', 'manager'],
  'staff:invite':             ['owner', 'super_admin'],
  'staff:deactivate':         ['owner', 'super_admin'],

  // ── Reports ──────────────────────────────────────────────
  'reports:nda':              ['owner', 'manager', 'pharmacist', 'inventory_manager'],
  'reports:tax':              ['owner'],
  'reports:activity':         ['owner', 'manager', 'pharmacist'],
  'reports:variance':         ['owner', 'manager', 'pharmacist', 'inventory_manager'],
  'reports:forecast':         ['owner', 'manager', 'pharmacist', 'inventory_manager'],
  'reports:expiry':           ['owner', 'manager', 'pharmacist', 'inventory_manager'],
  'reports:org_summary':      ['owner'],
  'reports:financial':        ['owner', 'manager'],

  // ── Subscription ─────────────────────────────────────────
  'subscription:read':        ['owner'],

  // ── Super Admin platform management ──────────────────────
  'admin:platform':           ['super_admin'],

  // ── Marketplace Supplier portal ───────────────────────────
  'supplier:portal':          ['supplier'],
  'supplier:admin':           ['super_admin'],

  // ── Phase 3: Clinic & Medical Center ──────────────────────
  'patients:read':            ['owner', 'manager', 'pharmacist', 'doctor', 'nurse', 'receptionist', 'staff'],
  'patients:write':           ['owner', 'manager', 'pharmacist', 'doctor', 'nurse', 'receptionist'],
  'doctors:read':             ['owner', 'manager', 'pharmacist', 'doctor', 'nurse', 'receptionist', 'staff'],
  'doctors:write':            ['owner', 'manager'],
  'appointments:read':        ['owner', 'manager', 'pharmacist', 'doctor', 'nurse', 'receptionist', 'staff'],
  'appointments:write':       ['owner', 'manager', 'doctor', 'nurse', 'receptionist'],
  'consultations:read':       ['owner', 'manager', 'pharmacist', 'doctor', 'nurse'],
  'consultations:write':      ['owner', 'manager', 'doctor'],
  'prescriptions:read':       ['owner', 'manager', 'pharmacist', 'doctor', 'nurse', 'dispensor', 'staff'],
  'prescriptions:write':      ['owner', 'manager', 'doctor'],
  'prescriptions:dispense':   ['owner', 'manager', 'pharmacist', 'dispensor'],

  // ── Phase 4: Laboratory ───────────────────────────────────
  'lab:read':                 ['owner', 'manager', 'pharmacist', 'doctor', 'nurse', 'lab_technician', 'staff'],
  'lab:manage':               ['owner', 'manager'],
  'lab:request':              ['owner', 'manager', 'pharmacist', 'doctor', 'nurse', 'staff'],
  'lab:collect':              ['owner', 'manager', 'pharmacist', 'lab_technician', 'nurse', 'staff'],
  'lab:results':              ['owner', 'manager', 'pharmacist', 'lab_technician', 'staff'],

  // ── Phase 5: Hospital ─────────────────────────────────────
  'hospital:read':            ['owner', 'manager', 'doctor', 'nurse', 'pharmacist', 'receptionist', 'staff'],
  'hospital:manage':          ['owner', 'manager'],
  'hospital:admit':           ['owner', 'manager', 'doctor', 'nurse', 'receptionist'],
  'hospital:discharge':       ['owner', 'manager', 'doctor'],
  'hospital:charge':          ['owner', 'manager', 'doctor', 'nurse', 'pharmacist'],
  'insurance:read':           ['owner', 'manager', 'doctor', 'nurse', 'receptionist', 'staff'],
  'insurance:manage':         ['owner', 'manager'],

  // ── Phase 6: Enterprise ───────────────────────────────────
  'enterprise:manage':        ['owner', 'super_admin'],
  'enterprise:regional':      ['owner', 'manager'],

  // ── GL Accounting ─────────────────────────────────────────
  'accounting:read':          ['owner', 'manager'],
  'accounting:manage':        ['owner'],

  // ── SMS ───────────────────────────────────────────────────
  'sms:send':                 ['owner', 'manager', 'pharmacist'],
};

function can(permission) {
  const allowed = PERMISSIONS[permission];

  if (!allowed) {
    throw new Error(`[permissions] Unknown permission: "${permission}". Add it to PERMISSIONS map.`);
  }

  return function checkPermission(req, res, next) {
    // FIX: normalise role to lowercase so DB values like "Staff" or "Manager"
    // don't silently fail the includes() check
    const role = (req.user && req.user.role || '').toString().trim().toLowerCase();

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

function hasPermission(role, permission) {
  const normalisedRole = (role || '').toString().trim().toLowerCase();
  const allowed = PERMISSIONS[permission] || [];
  return allowed.includes(normalisedRole);
}

module.exports = { can, hasPermission, PERMISSIONS };
