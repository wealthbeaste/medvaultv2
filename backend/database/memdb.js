'use strict';

// ============================================================
// DISABLED — in-memory database, retired 2026-07-18
// ============================================================
// This module used to hold a plain-JS-array "database" (sales, drugs,
// customers, etc.) that lived only in process memory and was wiped on
// every restart/redeploy. It was never wired into server.js or any
// route, but it WAS still being imported by notifications/whatsapp.js
// for daily reports / low-stock alerts, meaning those specific reports
// were quietly computed from empty/demo data instead of real Postgres
// data. whatsapp.js has been fixed to query the real database
// (database/db.js) directly and no longer imports this file.
//
// The real, original content is preserved in memdb.js.disabled in this
// same directory for reference — nothing was deleted, only disconnected.
//
// This stub exists so that if anything ever tries to require this
// module again (a copy-pasted import, a future contributor reaching for
// "the database module" and grabbing the wrong one, etc.) the app fails
// LOUDLY and immediately at require-time, instead of silently running
// against in-memory storage that disappears on restart. Sales records
// must only ever be written to and read from database/db.js (Postgres).
throw new Error(
  'database/memdb.js is disabled. Sales and all other persistent data ' +
  'must go through database/db.js (PostgreSQL) — in-memory storage is ' +
  'not permitted for sales records. See the comment at the top of this ' +
  'file, and database/memdb.js.disabled for the original (unused) code.'
);
