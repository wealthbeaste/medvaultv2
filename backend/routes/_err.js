'use strict';

/**
 * Structured error helper.
 * Shape: { error: string, code: string, field?: string }
 *
 * Error Code Registry:
 *
 *  AUTH_*         Authentication / authorisation
 *  VALIDATION_*   Input validation
 *  NOT_FOUND_*    Resource look-ups
 *  CONFLICT_*     Duplicate / state conflicts
 *  PERMISSION_*   Access / role checks
 *  STOCK_*        Inventory business rules
 *  AI_*           Anthropic gateway
 *  SERVER_ERROR   – unexpected internal error (500)
 */
function err(res, httpStatus, code, message, field) {
  const body = { error: message, code };
  if (field !== undefined) body.field = field;
  return res.status(httpStatus).json(body);
}

module.exports = err;
