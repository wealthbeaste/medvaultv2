'use strict';
const fs   = require('fs');
const path = require('path');

// ── Load .env for local dev ───────────────────────────────
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

// ── Log all env vars for debugging ───────────────────────
console.log('=== MedVault Starting ===');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('PORT:', process.env.PORT);
console.log('DATABASE_URL set:', !!process.env.DATABASE_URL);
console.log('JWT_SECRET set:', !!process.env.JWT_SECRET);

// ── PORT — use Railway's PORT exactly as given ────────────
// Railway sets PORT automatically — DO NOT hardcode
const PORT = parseInt(process.env.PORT || '8080');
const HOST = '0.0.0.0';

// ── Load framework ────────────────────────────────────────
let App;
try {
  App = require('./core/framework').App;
  console.log('✅ Framework loaded');
} catch(e) {
  console.error('❌ Framework failed:', e.message);
  process.exit(1);
}

// ── Load routes ───────────────────────────────────────────
let registerRoutes;
try {
  registerRoutes = require('./routes/index');
  console.log('✅ Routes loaded');
} catch(e) {
  console.error('❌ Routes failed:', e.message);
  process.exit(1);
}

const app = new App();
registerRoutes(app);

// ── Optional modules ──────────────────────────────────────
['./payments/momo', './notifications/whatsapp'].forEach(mod => {
  try {
    const m = require(mod);
    if (m.registerMomoRoutes)     m.registerMomoRoutes(app);
    if (m.registerWhatsAppRoutes) m.registerWhatsAppRoutes(app);
    if (m.startScheduler)         m.startScheduler();
    console.log('✅ Optional module loaded:', mod);
  } catch(e) {
    console.log('⚠️  Optional skipped:', mod);
  }
});

// ── Start HTTP server IMMEDIATELY ────────────────────────
// Must start fast — Railway kills if no response within 60s
const server = app.server();

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  💊 MedVault API — LIVE                  ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('🚀 Port:', PORT);
  console.log('🌍 Host:', HOST);
  console.log('❤️  Health: /health');
  console.log('');

  // Run DB setup AFTER server is listening
  if (process.env.DATABASE_URL) {
    setTimeout(() => {
      try {
        const { runMigrations, seedSuperAdmin } = require('./database/db');
        runMigrations()
          .then(() => seedSuperAdmin())
          .then(() => console.log('✅ Database ready'))
          .catch(e => console.error('⚠️  DB setup error:', e.message));
      } catch(e) {
        console.error('⚠️  DB module error:', e.message);
      }
    }, 2000); // 2 second delay after server starts
  } else {
    console.warn('⚠️  No DATABASE_URL — set it in Railway Variables');
  }
});

server.on('error', err => {
  console.error('❌ Server error:', err.message);
  process.exit(1);
});

// Keep alive
process.on('uncaughtException',  e => console.error('Uncaught:', e.message));
process.on('unhandledRejection', e => console.error('Rejection:', e));
