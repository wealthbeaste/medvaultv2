// MedVault V2 — Route Registry
// This file only wires modules together; business logic lives in each module.
'use strict';

module.exports = function registerRoutes(app) {
  const { query, pool, getNextReceiptNumber, getNextPoNumber, getNextGrnNumber, getNextReturnNumber } = require('../database/db');
  const { hash, compare }    = require('../core/password');
  const { sign }             = require('../core/jwt');
  const auth                 = require('../middleware/auth');
  const { can }              = require('../middleware/permissions');
  const { validate, schemas }= require('../middleware/validate');
  const { audit }            = require('../utils/audit');
  const { rateLimit }        = require('../utils/rateLimit');

  // Shared dependency bag passed to every module
  const deps = { query, pool, getNextReceiptNumber, getNextPoNumber, getNextGrnNumber, getNextReturnNumber, hash, compare, sign, auth, can, validate, schemas, audit, rateLimit };

  require('./system')(app, deps);
  require('./auth')(app, deps);
  require('./inventory')(app, deps);
  require('./sales')(app, deps);
  require('./orders')(app, deps);
  require('./customers')(app, deps);
  require('./org')(app, deps);          // branches + transfers + staff
  require('./operations')(app, deps);   // credit + shifts + dispatch
  require('./reports')(app, deps);      // dashboard + analytics + NDA + tax
  require('./suppliers')(app, deps);    // suppliers + notifications
  require('./procurement')(app, deps);  // purchase orders, GRN, AP ledger, price levels, returns
  require('./admin')(app, deps);        // super-admin + subscription
  require('./loyalty')(app, deps);       // loyalty programme
  require('./warehouses')(app, deps);   // warehouse locations
  require('./marketplace')(app, deps);  // supplier portal + marketplace admin
  require('./drug-catalog')(app, deps); // shared drug catalog (search + create)
  require('./ai')(app);                 // AI proxy (no shared deps needed)

  // Phase 3 — Clinic & Medical Center
  require('./clinic')(app, deps);       // patients, doctors, appointments, consultations, prescriptions

  // Phase 4 — Laboratory
  require('./laboratory')(app, deps);   // test catalogue, lab requests, results

  // Phase 5 — Hospital ERP
  require('./hospital')(app, deps);     // departments, wards, beds, admissions, insurance

  // Phase 6 — Enterprise
  require('./enterprise')(app, deps);   // API keys, regional dashboard, AI forecasting, webhooks

  // GL Accounting
  require('./accounting')(app, deps);   // chart of accounts, journals, trial balance, P&L

  // SMS Gateway
  require('./sms')(app, deps);          // Africa's Talking SMS integration

  // DHIS2 integration
  require('./dhis2')(app);              // HMIS/DHIS2 export reports
};