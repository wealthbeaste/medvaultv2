'use strict';

// ============================================================
// MedVault — Request Validation Middleware
// Phase 1: No new npm packages — pure JS schema validation.
// Usage: app.post('/api/...', auth, validate(schema), handler)
// ============================================================

/**
 * Validates req.body against a schema object.
 *
 * Schema format:
 * {
 *   fieldName: {
 *     required: true,
 *     type: 'string' | 'number' | 'boolean',
 *     min: 0,          // numeric minimum
 *     max: 1000,       // numeric maximum
 *     minLen: 2,       // string minimum length
 *     maxLen: 255,     // string maximum length
 *     enum: ['a','b'], // allowed values
 *   }
 * }
 */
function validate(schema) {
  return (req, res, next) => {
    const errors = [];
    const body = req.body || {};

    for (const [field, rules] of Object.entries(schema)) {
      const val = body[field];
      const isEmpty = val === undefined || val === null || val === '';

      if (rules.required && isEmpty) {
        errors.push(`'${field}' is required`);
        continue; // skip further checks if missing
      }

      if (isEmpty) continue; // optional field not provided — skip

      // Type check
      if (rules.type) {
        const actualType = Array.isArray(val) ? 'array' : typeof val;
        if (actualType !== rules.type) {
          errors.push(`'${field}' must be of type ${rules.type} (got ${actualType})`);
          continue;
        }
      }

      // Numeric range
      if (rules.min !== undefined && Number(val) < rules.min) {
        errors.push(`'${field}' must be >= ${rules.min}`);
      }
      if (rules.max !== undefined && Number(val) > rules.max) {
        errors.push(`'${field}' must be <= ${rules.max}`);
      }

      // String length
      if (rules.minLen !== undefined && String(val).length < rules.minLen) {
        errors.push(`'${field}' must be at least ${rules.minLen} characters`);
      }
      if (rules.maxLen !== undefined && String(val).length > rules.maxLen) {
        errors.push(`'${field}' must be at most ${rules.maxLen} characters`);
      }

      // Enum
      if (rules.enum && !rules.enum.includes(val)) {
        errors.push(`'${field}' must be one of: ${rules.enum.join(', ')}`);
      }
    }

    if (errors.length) {
      return res.status(400).json({
        success: false,
        error: errors.join('; '),
        code: 'VALIDATION_ERROR',
        fields: errors,
      });
    }

    next();
  };
}

// ── Common schemas (reuse across routes) ───────────────────

const schemas = {
  sale: {
    items:          { required: true, type: 'array' },
    payment_method: { required: true, enum: ['cash', 'momo', 'mtn_momo', 'airtel_money', 'card', 'credit', 'insurance', 'bank_transfer'] },
    total_amount:   { required: true, type: 'number', min: 0 },
  },

  drug: {
    name:       { required: true, type: 'string', minLen: 1, maxLen: 255 },
    quantity:   { required: true, type: 'number', min: 0 },
    unit_price: { required: true, type: 'number', min: 0 },
    category:   { maxLen: 100 },
  },

  supplier: {
    name:  { required: true, type: 'string', minLen: 1, maxLen: 255 },
    phone: { maxLen: 50 },
    email: { maxLen: 255 },
  },

  stockAdjustment: {
    drug_id:        { required: true, type: 'number', min: 1 },
    quantity_after: { required: true, type: 'number', min: 0 },
    type:           { required: true, enum: ['count', 'damage', 'return', 'expired', 'correction'] },
    reason:         { required: true, type: 'string', minLen: 3 },
  },

  customer: {
    name:  { required: true, type: 'string', minLen: 1, maxLen: 255 },
    phone: { maxLen: 50 },
  },

  // Phase 2 — Procurement
  purchaseOrder: {
    supplier_id: { required: true, type: 'number', min: 1 },
    items:       { required: true, type: 'array' },
  },

  grn: {
    items: { required: true, type: 'array' },
  },

  drugReturn: {
    supplier_id: { required: true, type: 'number', min: 1 },
    reason:      { required: true, enum: ['expired', 'damaged', 'overstock', 'wrong_item'] },
    items:       { required: true, type: 'array' },
  },

  priceLevel: {
    name:         { required: true, type: 'string', minLen: 1, maxLen: 100 },
    discount_pct: { type: 'number', min: 0, max: 100 },
  },

  drugPrice: {
    drug_id:        { required: true, type: 'number', min: 1 },
    price_level_id: { required: true, type: 'number', min: 1 },
    price:          { required: true, type: 'number', min: 0 },
  },

  // Phase 3 — Clinic
  patient_reg: {
    name: { required: true, type: 'string', minLen: 1, maxLen: 255 },
  },

  // Phase 4 — Lab
  labTest: {
    name:  { required: true, type: 'string', minLen: 1, maxLen: 255 },
    price: { type: 'number', min: 0 },
  },
};

module.exports = { validate, schemas };
