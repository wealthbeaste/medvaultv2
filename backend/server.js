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

// Validate required env vars
const required = ['DATABASE_URL', 'JWT_SECRET'];
const missing  = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`\n❌ Missing environment variables: ${missing.join(', ')}`);
  console.error('Add them in Railway → Variables tab\n');
  process.exit(1);
}

const { App }            = require('./core/framework');
const { runMigrations, seedSuperAdmin } = require('./database/db');
const registerRoutes     = require('./routes/index');

const app = new App();
registerRoutes(app);

// Optional modules
try {
  const { registerMomoRoutes } = require('./payments/momo');
  registerMomoRoutes(app);
  console.log('✅ MoMo payments loaded');
} catch(e) { console.log('⚠️  MoMo skipped:', e.message); }

try {
  const { registerWhatsAppRoutes, startScheduler } = require('./notifications/whatsapp');
  registerWhatsAppRoutes(app);
  startScheduler();
  console.log('✅ WhatsApp loaded');
} catch(e) { console.log('⚠️  WhatsApp skipped:', e.message); }

const PORT = parseInt(process.env.PORT) || 4000;

async function start() {
  try {
    console.log('\n🔄 Connecting to Neon PostgreSQL...');
    await runMigrations();
    await seedSuperAdmin();

    app.server().listen(PORT, '0.0.0.0', () => {
      console.log('\n╔════════════════════════════════════════════╗');
      console.log('║   💊 MedVault API v2 — PostgreSQL + Live   ║');
      console.log('╚════════════════════════════════════════════╝');
      console.log(`\n🚀 Port:     ${PORT}`);
      console.log(`🗄️  Database: Neon PostgreSQL ✅`);
      console.log(`🌍 Env:      ${process.env.NODE_ENV || 'production'}`);
      console.log(`\n📡 Endpoints:`);
      console.log(`   POST /api/auth/register`);
      console.log(`   POST /api/auth/login`);
      console.log(`   GET  /api/dashboard`);
      console.log(`   GET  /api/inventory`);
      console.log(`   POST /api/inventory`);
      console.log(`   GET  /api/branches`);
      console.log(`   POST /api/transfers`);
      console.log(`\n🔐 Super admin: admin@medvault.ug / MedVault2026!\n`);
    });
  } catch(e) {
    console.error('❌ Startup failed:', e.message);
    process.exit(1);
  }
}

start();
