'use strict';
const err = require('./_err');

// ============================================================
// GL ACCOUNTING MODULE
// Chart of accounts, journal entries, trial balance, P&L
// Entries are immutable — only reversals allowed.
// ============================================================

module.exports = function registerAccountingRoutes(app, { query, pool, auth, can, audit }) {

  // ═══════════════════════════════════════════════════════════
  // CHART OF ACCOUNTS
  // ═══════════════════════════════════════════════════════════

  app.get('/api/accounting/accounts', auth, can('accounting:read'), async (req, res) => {
    const { orgId } = req.user;
    try {
      const r = await query(`SELECT * FROM gl_accounts WHERE org_id=$1 ORDER BY code`, [orgId]);
      res.json({ accounts: r.rows });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/accounting/accounts', auth, can('accounting:manage'), async (req, res) => {
    const { orgId } = req.user;
    const { code, name, account_type, parent_id } = req.body;
    if (!code || !name || !account_type) return err(res, 400, 'VALIDATION_REQUIRED', 'code, name, account_type required');
    const validTypes = ['asset','liability','equity','revenue','expense'];
    if (!validTypes.includes(account_type)) return err(res, 400, 'VALIDATION_INVALID', 'account_type must be: ' + validTypes.join(', '));
    try {
      const r = await query(
        `INSERT INTO gl_accounts (org_id,code,name,account_type,parent_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [orgId, code.trim(), name.trim(), account_type, parent_id||null]
      );
      await audit(query, { req, action:'gl.account_create', entity:'gl_account', entityId:r.rows[0].id, payload:{code,name,account_type} });
      res.status(201).json({ success:true, message:'✅ Account created', account:r.rows[0] });
    } catch (e) {
      if (e.code === '23505') return err(res, 409, 'DUPLICATE', 'Account code already exists');
      return err(res, 500, 'SERVER_ERROR', e.message);
    }
  });

  // Seed default chart of accounts
  app.post('/api/accounting/seed', auth, can('accounting:manage'), async (req, res) => {
    const { orgId } = req.user;
    const defaults = [
      ['1000','Cash','asset'],['1010','Bank','asset'],['1100','Accounts Receivable','asset'],
      ['1200','Inventory','asset'],['1300','Prepaid Expenses','asset'],
      ['2000','Accounts Payable','liability'],['2100','Accrued Expenses','liability'],
      ['3000','Owner Equity','equity'],['3100','Retained Earnings','equity'],
      ['4000','Drug Sales Revenue','revenue'],['4010','Consultation Revenue','revenue'],
      ['4020','Lab Revenue','revenue'],['4030','Bed Charges Revenue','revenue'],
      ['5000','Cost of Goods Sold','expense'],['5010','Salaries & Wages','expense'],
      ['5020','Rent','expense'],['5030','Utilities','expense'],['5040','Supplies','expense'],
      ['5050','Depreciation','expense'],['5060','Insurance Expense','expense'],
    ];
    let added = 0;
    for (const [code,name,type] of defaults) {
      try {
        await query(`INSERT INTO gl_accounts (org_id,code,name,account_type) VALUES ($1,$2,$3,$4) ON CONFLICT (org_id,code) DO NOTHING`, [orgId,code,name,type]);
        added++;
      } catch(e) {}
    }
    res.json({ success:true, message:`✅ ${added} default accounts seeded` });
  });

  // ═══════════════════════════════════════════════════════════
  // JOURNAL ENTRIES
  // ═══════════════════════════════════════════════════════════

  app.get('/api/accounting/journals', auth, can('accounting:read'), async (req, res) => {
    const { orgId } = req.user;
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const offset = (page - 1) * limit;
    try {
      const [rows, countRes] = await Promise.all([
        query(`SELECT je.*, u.name as created_by_name,
                      json_agg(json_build_object('id',jl.id,'account_id',jl.account_id,'description',jl.description,
                        'debit',jl.debit_amount,'credit',jl.credit_amount,'account_code',ga.code,'account_name',ga.name)) as lines
               FROM journal_entries je
               LEFT JOIN users u ON u.id=je.created_by
               LEFT JOIN journal_lines jl ON jl.journal_id=je.id
               LEFT JOIN gl_accounts ga ON ga.id=jl.account_id
               WHERE je.org_id=$1 GROUP BY je.id,u.name ORDER BY je.entry_date DESC, je.id DESC
               LIMIT $2 OFFSET $3`, [orgId, limit, offset]),
        query(`SELECT COUNT(*) as total FROM journal_entries WHERE org_id=$1`, [orgId]),
      ]);
      const total = parseInt(countRes.rows[0].total);
      res.json({ journals: rows.rows, pagination:{ page, limit, total, pages:Math.ceil(total/limit) } });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  app.post('/api/accounting/journals', auth, can('accounting:manage'), async (req, res) => {
    const { orgId, pharmacyId, userId } = req.user;
    const { description, reference, entry_date, lines } = req.body;
    if (!description) return err(res, 400, 'VALIDATION_REQUIRED', 'description required');
    if (!Array.isArray(lines) || lines.length < 2) return err(res, 400, 'VALIDATION_REQUIRED', 'At least 2 journal lines required');

    // Validate debits = credits
    let totalDebit = 0, totalCredit = 0;
    for (const l of lines) {
      totalDebit  += parseFloat(l.debit_amount || 0);
      totalCredit += parseFloat(l.credit_amount || 0);
    }
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      return err(res, 400, 'VALIDATION_INVALID', `Debits (${totalDebit}) must equal credits (${totalCredit})`);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Atomic entry number
      const ctr = await client.query(`UPDATE pharmacies SET journal_counter=journal_counter+1 WHERE id=$1 RETURNING journal_counter`, [pharmacyId]);
      const num = ctr.rows.length ? `JE-${new Date().getFullYear()}-${String(ctr.rows[0].journal_counter).padStart(5,'0')}` : `JE-${Date.now().toString(36)}`;

      const je = await client.query(
        `INSERT INTO journal_entries (org_id,pharmacy_id,entry_number,description,reference,entry_date,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [orgId, pharmacyId, num, description, reference||null, entry_date||new Date().toISOString().slice(0,10), userId]
      );
      const entry = je.rows[0];

      for (const l of lines) {
        await client.query(
          `INSERT INTO journal_lines (journal_id,account_id,description,debit_amount,credit_amount)
           VALUES ($1,$2,$3,$4,$5)`,
          [entry.id, l.account_id, l.description||null, parseFloat(l.debit_amount||0), parseFloat(l.credit_amount||0)]
        );
        // Update account balance
        const net = parseFloat(l.debit_amount||0) - parseFloat(l.credit_amount||0);
        await client.query(`UPDATE gl_accounts SET balance=balance+$1 WHERE id=$2`, [net, l.account_id]);
      }

      await client.query('COMMIT');
      await audit(query, { req, action:'gl.journal_create', entity:'journal_entry', entityId:entry.id, payload:{entry_number:num, total:totalDebit} });
      res.status(201).json({ success:true, message:'✅ Journal entry recorded', journal:entry });
    } catch (e) {
      await client.query('ROLLBACK');
      return err(res, 500, 'SERVER_ERROR', e.message);
    } finally { client.release(); }
  });

  // Reverse a journal entry
  app.post('/api/accounting/journals/:id/reverse', auth, can('accounting:manage'), async (req, res) => {
    const { orgId, pharmacyId, userId } = req.user;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const orig = await client.query(`SELECT * FROM journal_entries WHERE id=$1 AND org_id=$2`, [req.params.id, orgId]);
      if (!orig.rows.length) { await client.query('ROLLBACK'); return err(res, 404, 'NOT_FOUND', 'Journal entry not found'); }

      const origLines = await client.query(`SELECT * FROM journal_lines WHERE journal_id=$1`, [req.params.id]);

      const ctr = await client.query(`UPDATE pharmacies SET journal_counter=journal_counter+1 WHERE id=$1 RETURNING journal_counter`, [pharmacyId]);
      const num = `JE-${new Date().getFullYear()}-${String(ctr.rows[0].journal_counter).padStart(5,'0')}`;

      const rev = await client.query(
        `INSERT INTO journal_entries (org_id,pharmacy_id,entry_number,description,reference,entry_date,is_reversal,reverses_id,created_by)
         VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,true,$6,$7) RETURNING *`,
        [orgId, pharmacyId, num, 'REVERSAL: '+orig.rows[0].description, orig.rows[0].entry_number, req.params.id, userId]
      );

      // Swap debits and credits
      for (const l of origLines.rows) {
        await client.query(
          `INSERT INTO journal_lines (journal_id,account_id,description,debit_amount,credit_amount) VALUES ($1,$2,$3,$4,$5)`,
          [rev.rows[0].id, l.account_id, 'Reversal', l.credit_amount, l.debit_amount]
        );
        const net = parseFloat(l.credit_amount) - parseFloat(l.debit_amount);
        await client.query(`UPDATE gl_accounts SET balance=balance+$1 WHERE id=$2`, [net, l.account_id]);
      }

      await client.query('COMMIT');
      res.json({ success:true, message:'✅ Journal reversed', reversal:rev.rows[0] });
    } catch (e) {
      await client.query('ROLLBACK');
      return err(res, 500, 'SERVER_ERROR', e.message);
    } finally { client.release(); }
  });

  // ═══════════════════════════════════════════════════════════
  // TRIAL BALANCE
  // ═══════════════════════════════════════════════════════════

  app.get('/api/accounting/trial-balance', auth, can('accounting:read'), async (req, res) => {
    const { orgId } = req.user;
    try {
      const r = await query(
        `SELECT ga.code, ga.name, ga.account_type, ga.balance,
                CASE WHEN ga.balance > 0 THEN ga.balance ELSE 0 END as debit_balance,
                CASE WHEN ga.balance < 0 THEN ABS(ga.balance) ELSE 0 END as credit_balance
         FROM gl_accounts ga WHERE ga.org_id=$1 AND (ga.balance != 0 OR ga.is_active) ORDER BY ga.code`, [orgId]
      );
      const totals = r.rows.reduce((acc, a) => {
        acc.debit  += parseFloat(a.debit_balance);
        acc.credit += parseFloat(a.credit_balance);
        return acc;
      }, { debit:0, credit:0 });
      res.json({ accounts: r.rows, totals, balanced: Math.abs(totals.debit - totals.credit) < 0.01 });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });

  // ═══════════════════════════════════════════════════════════
  // INCOME STATEMENT (P&L)
  // ═══════════════════════════════════════════════════════════

  app.get('/api/accounting/income-statement', auth, can('accounting:read'), async (req, res) => {
    const { orgId } = req.user;
    const { from_date, to_date } = req.query;
    try {
      const dateFilter = from_date && to_date ? `AND je.entry_date BETWEEN '${from_date}' AND '${to_date}'` : '';
      const r = await query(
        `SELECT ga.code, ga.name, ga.account_type,
                COALESCE(SUM(jl.credit_amount) - SUM(jl.debit_amount), 0) as net_amount
         FROM gl_accounts ga
         LEFT JOIN journal_lines jl ON jl.account_id = ga.id
         LEFT JOIN journal_entries je ON je.id = jl.journal_id ${dateFilter}
         WHERE ga.org_id=$1 AND ga.account_type IN ('revenue','expense')
         GROUP BY ga.id ORDER BY ga.account_type DESC, ga.code`, [orgId]
      );
      const revenue  = r.rows.filter(a => a.account_type === 'revenue');
      const expenses = r.rows.filter(a => a.account_type === 'expense');
      const totalRevenue  = revenue.reduce((s,a) => s + parseFloat(a.net_amount), 0);
      const totalExpenses = expenses.reduce((s,a) => s + Math.abs(parseFloat(a.net_amount)), 0);
      res.json({ revenue, expenses, total_revenue: totalRevenue, total_expenses: totalExpenses, net_income: totalRevenue - totalExpenses });
    } catch (e) { return err(res, 500, 'SERVER_ERROR', e.message); }
  });
};
