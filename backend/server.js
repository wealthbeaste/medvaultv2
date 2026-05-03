'use strict';
const fs   = require('fs');
const path = require('path');

// Load .env for local dev only
try {
  const ep = path.join(__dirname, '.env');
  if (fs.existsSync(ep)) {
    fs.readFileSync(ep,'utf8').split('\n').forEach(l => {
      const i = l.indexOf('=');
      if (i > 0 && !l.startsWith('#')) {
        const k = l.slice(0,i).trim();
        const v = l.slice(i+1).trim();
        if (k && !process.env[k]) process.env[k] = v;
      }
    });
  }
} catch(e) {}

// Check required vars — warn but don't crash
const required = ['DATABASE_URL','JWT_SECRET'];
const missing  = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`❌ Missing: ${missing.join(', ')} — add in Railway Variables`);
}

const { App } = require('./core/framework');
const registerRoutes = require('./routes/index');

const app = new App();
registerRoutes(app);

// Optional modules — never crash if missing
['./payments/momo','./notifications/whatsapp'].forEach(mod => {
  try {
    const m = require(mod);
    if (m.registerMomoRoutes)     m.registerMomoRoutes(app);
    if (m.registerWhatsAppRoutes) m.registerWhatsAppRoutes(app);
    if (m.startScheduler)         m.startScheduler();
    console.log('✅ Loaded:', mod);
  } catch(e) {
    console.log('⚠️  Skipped:', mod, '-', e.message.slice(0,60));
  }
});

// ── START SERVER FIRST — then run DB setup in background ──
const PORT = parseInt(process.env.PORT) || 4000;
const HOST = '0.0.0.0';

const server = app.server();

server.listen(PORT, HOST, () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  💊 MedVault API v2 — Railway Live      ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`\n🚀 Listening on ${HOST}:${PORT}`);
  console.log(`🌍 Env: ${process.env.NODE_ENV || 'production'}`);
  console.log(`❤️  Health check: /health\n`);

  // Run DB migrations AFTER server is already accepting requests
  if (process.env.DATABASE_URL) {
    const { runMigrations, seedSuperAdmin } = require('./database/db');
    runMigrations()
      .then(() => seedSuperAdmin())
      .then(() => console.log('✅ Database ready'))
      .catch(e => console.error('⚠️  DB setup error (server still running):', e.message));
  } else {
    console.warn('⚠️  No DATABASE_URL — running without database');
  }
});

server.on('error', (err) => {
  console.error('❌ Server error:', err.message);
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} already in use`);
    process.exit(1);
  }
});

// Keep process alive
process.on('uncaughtException', err => {
  console.error('Uncaught exception:', err.message);
});
process.on('unhandledRejection', err => {
  console.error('Unhandled rejection:', err.message || err);
});
