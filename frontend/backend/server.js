'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');
const { URL } = require('url');

// ── Load .env (local dev only, ignored on Railway) ────────
try {
  const ep = path.join(__dirname, '.env');
  if (fs.existsSync(ep)) {
    fs.readFileSync(ep,'utf8').split('\n').forEach(l => {
      const i = l.indexOf('=');
      if (i > 0 && !l.startsWith('#')) {
        process.env[l.slice(0,i).trim()] = l.slice(i+1).trim();
      }
    });
  }
} catch(e) {}

// ── CORS + JSON helpers ───────────────────────────────────
function addHelpers(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.json = (data, status) => {
    res.writeHead(status || 200, {'Content-Type':'application/json'});
    res.end(JSON.stringify(data));
  };
}

function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
  });
}

// ── Load core modules safely ──────────────────────────────
let App, seedData, registerRoutes;

try { App = require('./core/framework').App; }
catch(e) { console.error('framework missing:', e.message); process.exit(1); }

try { seedData = require('./database/memdb').seedData; }
catch(e) { console.error('memdb missing:', e.message); process.exit(1); }

try { registerRoutes = require('./routes/index'); }
catch(e) { console.error('routes missing:', e.message); process.exit(1); }

// ── Start app ─────────────────────────────────────────────
const app = new App();
registerRoutes(app);

// Optional modules
['./payments/momo', './notifications/whatsapp'].forEach(mod => {
  try {
    const m = require(mod);
    if (m.registerMomoRoutes)     m.registerMomoRoutes(app);
    if (m.registerWhatsAppRoutes) m.registerWhatsAppRoutes(app);
    if (m.startScheduler)         m.startScheduler();
    console.log('✅ Loaded:', mod);
  } catch(e) {
    console.log('⚠️  Optional module skipped:', mod, '-', e.message);
  }
});

// ── Listen ────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 4000;
const HOST = '0.0.0.0';

app.server().listen(PORT, HOST, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════╗');
  console.log('║  💊 MedVault API — LIVE on Railway    ║');
  console.log('╚═══════════════════════════════════════╝');
  console.log(`   Port : ${PORT}`);
  console.log(`   Host : ${HOST}`);
  console.log(`   Env  : ${process.env.NODE_ENV || 'production'}`);
  console.log(`   Login: admin@katopharma.ug / admin123`);
  console.log('');
});

try { seedData(); console.log('✅ Demo data seeded'); }
catch(e) { console.error('Seed error:', e.message); }
