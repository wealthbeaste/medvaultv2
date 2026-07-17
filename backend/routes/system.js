'use strict';
const err = require('./_err');

module.exports = function registerSystemRoutes(app, { query }) {

  app.get('/health', async (req, res) => {
    try {
      await query('SELECT 1');
      res.json({ status: 'ok', service: 'MedVault API v2', db: 'connected' });
    } catch (e) {
      res.json({ status: 'ok', service: 'MedVault API v2', db: 'error: ' + e.message });
    }
  });

  app.get('/api/setup', async (req, res) => {
    try {
      const { runMigrations, seedSuperAdmin } = require('../database/db');
      await runMigrations();
      await seedSuperAdmin();
      const exists = await query(`SELECT id,email FROM users WHERE email = $1`, ['admin@medvault.ug']);
      if (exists.rows.length) {
        res.json({ message: '✅ Setup complete!', email: 'admin@medvault.ug', password: 'MedVault2026!', id: exists.rows[0].id });
      } else {
        res.json({ message: '⚠️ Seed may have failed', hint: 'Check DATABASE_URL in Railway Variables' });
      }
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  app.get('/api/dbtest', async (req, res) => {
    try {
      const r = await query('SELECT NOW() as time');
      const u = await query('SELECT COUNT(*) as cnt FROM users').catch(() => ({ rows: [{ cnt: 'table missing' }] }));
      res.json({ status: 'connected', time: r.rows[0].time, userCount: u.rows[0].cnt });
    } catch (e) {
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });
};
