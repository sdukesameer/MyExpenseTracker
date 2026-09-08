const puppeteer = require('puppeteer-core');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MOCK = fs.readFileSync(__dirname + '/mock-supabase.js', 'utf8');
const SHOTS = path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const CHROME = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].find(p => fs.existsSync(p));
if (!CHROME) {
  console.error('No Chrome/Chromium found. Set CHROME_PATH to your browser binary.');
  process.exit(2);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
               '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

let pass = 0, failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

function serve() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const route = decodeURIComponent(req.url.split('?')[0]);

      // Stand in for Netlify, deployed without GEMINI_API_KEY — the state most
      // installs are in, and the one where the scanner falls back to reading
      // on the device. Serving it also keeps a 404 out of the console, which
      // the error assertion at the end of run A would otherwise trip over.
      if (route === '/.netlify/functions/admin') {
        let raw = '';
        req.on('data', c => { raw += c; });
        return req.on('end', () => {
          const body = JSON.parse(raw || '{}');
          const auth = req.headers.authorization || '';
          res.writeHead(auth.startsWith('Bearer ') ? 200 : 401,
            { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(auth.startsWith('Bearer ')
            ? { ok: true, message: 'Done (' + body.action + ')',
                link: 'https://example.test/one-time-link' }
            : { error: 'Not signed in' }));
        });
      }

      if (route === '/.netlify/functions/scan') {
        res.writeHead(req.method === 'GET' ? 200 : 501, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(req.method === 'GET'
          ? { ready: false }
          : { error: 'unconfigured' }));
      }

      const file = path.join(ROOT, route === '/' ? 'index.html' : route);
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end('nf'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// Fixture: known totals so assertions are exact.
// "Now" is pinned to 31 Aug 2026, 19:00 IST = 13:30 UTC — the exact instant
// the old code rolled the dashboard forward into September.
const FAKE_NOW = Date.UTC(2026, 7, 31, 13, 30, 0);
const FIXTURE = {
  types: ['Food', 'Travel', 'Utilities'],
  expenses: [
    // August 2026 (current month): billed 3000, unbilled 2000, total 5000, 4 txn
    { amount: 2000, date: '2026-08-31', type: 'Food',      note: 'Late dinner', billed: false },
    { amount: 1000, date: '2026-08-15', type: 'Travel',    note: 'Cab',         billed: true  },
    { amount: 2000, date: '2026-08-02', type: 'Travel',    note: 'Flight',      billed: true  },
    { amount: 0,    date: '2026-08-10', type: 'Utilities', note: 'Zero test',   billed: false, skip: true },
    // July 2026 (last month): total 4000
    { amount: 4000, date: '2026-07-20', type: 'Utilities', note: 'Power bill',  billed: false },
    // June 2026
    { amount: 1500, date: '2026-06-05', type: 'Food',      note: 'Groceries',   billed: false }
  ].filter(e => !e.skip),
  budget: { billed: 4000, unbilled: 6000 } // total 10000
};

async function boot(browser, { timezone = 'Asia/Kolkata', viewport = { width: 1280, height: 900 } } = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('requestfailed', r => {
    const u = r.url();
    if (!u.includes('favicon') && !u.includes('icons/')) errors.push('requestfailed: ' + u);
  });
  page.on('console', m => { if (m.type() === 'log' && process.env.VERBOSE) console.log('    [page] ' + m.text()); });

  await page.setViewport(viewport);
  await page.emulateTimezone(timezone);

  // The real supabase-js UMD bundle would overwrite window.supabase and
  // then try to reach the production API. Block just that one script.
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (req.url().includes('supabase-js')) {
      req.respond({ status: 200, contentType: 'text/javascript', body: '/* blocked in tests */' });
    } else {
      req.continue();
    }
  });

  await page.evaluateOnNewDocument(`
    (function(){
      const REAL = Date;
      const OFFSET = ${FAKE_NOW} - REAL.now();
      function FakeDate(...a){ return a.length ? new REAL(...a) : new REAL(REAL.now() + OFFSET); }
      FakeDate.prototype = REAL.prototype;
      FakeDate.now = () => REAL.now() + OFFSET;
      FakeDate.parse = REAL.parse; FakeDate.UTC = REAL.UTC;
      window.Date = FakeDate;
    })();
  `);
  await page.evaluateOnNewDocument(MOCK);
  await page.evaluateOnNewDocument(`
    (function(){
      const F = ${JSON.stringify(FIXTURE)};
      const u = 'user-test-0001';
      const s = window.__MOCK__.state;
      F.types.forEach((n,i) => s.expense_types.push({ id: i+1, user_id: u, name: n }));
      F.expenses.forEach((e,i) => s.expenses.push(Object.assign({
        id: 100+i, user_id: u, updated_at: '2026-08-' + String(20-i).padStart(2,'0') + 'T00:00:00Z'
      }, e)));
      s.user_budgets.push({ id: 1, user_id: u, budget_month: 8, budget_year: 2026,
        monthly_billed_budget: F.budget.billed, monthly_unbilled_budget: F.budget.unbilled });
      try { localStorage.clear(); } catch(e){}
    })();
  `);

  return { page, errors };
}

const txt = (page, sel) => page.$eval(sel, el => el.textContent.trim());
const visible = (page, sel) => page.$eval(sel, el => {
  const s = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
}).catch(() => false);

(async () => {
  const server = await serve();
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  try {
    /* ============ A. Dashboard, IST device ============ */
    console.log('\n── A. Dashboard @ 31 Aug 2026 19:00 IST, device TZ = Asia/Kolkata');
    let { page, errors } = await boot(browser);
    await page.goto(base, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 900));

    check('dashboard is visible', await visible(page, '#dashboard'));
    check('budget header says August (not September)',
      (await txt(page, '#budget-header')) === 'August Budget',
      await txt(page, '#budget-header'));
    check('this month = ₹5,000.00', (await txt(page, '#monthly-expenses')) === '₹5,000.00',
      await txt(page, '#monthly-expenses'));
    check('last month = ₹4,000.00', (await txt(page, '#total-expenses')) === '₹4,000.00',
      await txt(page, '#total-expenses'));
    check('transactions = 3', (await txt(page, '#expense-count')) === '3',
      await txt(page, '#expense-count'));
    check('billed = ₹3,000.00', (await txt(page, '#billed-expenses')) === '₹3,000.00',
      await txt(page, '#billed-expenses'));
    check('unbilled = ₹2,000.00', (await txt(page, '#unbilled-expenses')) === '₹2,000.00',
      await txt(page, '#unbilled-expenses'));
    check('month delta shown (+25%)', (await txt(page, '#month-delta')).includes('25'),
      await txt(page, '#month-delta'));

    /* ---- Requested feature 1: total budget = billed + unbilled ---- */
    console.log('\n── B. Total budget = billed + unbilled');
    check('total budget = ₹10,000', (await txt(page, '#total-budget-total')) === '₹10,000',
      await txt(page, '#total-budget-total'));
    check('total spent = ₹5,000', (await txt(page, '#total-budget-spent')) === '₹5,000',
      await txt(page, '#total-budget-spent'));
    check('total remaining = ₹5,000.00',
      (await txt(page, '#total-budget-remaining')).includes('5,000.00'),
      await txt(page, '#total-budget-remaining'));
    check('pace shown for the 1 remaining day',
      (await txt(page, '#total-budget-pace')).includes('1 day'),
      await txt(page, '#total-budget-pace'));
    check('total progress bar at 50%',
      (await page.$eval('#total-budget-progress-bar', e => e.style.width)) === '50%');
    check('billed remaining = ₹1,000.00',
      (await txt(page, '#billed-budget-remaining')).includes('1,000.00'),
      await txt(page, '#billed-budget-remaining'));

    /* ---- Recent list ---- */
    console.log('\n── C. Recent expenses list');
    check('5 recent rows render', (await page.$$('#expenses-container .expense-item')).length === 5,
      String((await page.$$('#expenses-container .expense-item')).length));
    check('amount uses Indian grouping',
      (await txt(page, '#expenses-container .expense-amount')).match(/₹[\d,]+\.\d\d/) !== null,
      await txt(page, '#expenses-container .expense-amount'));
    check('BILLED badge present', (await page.$$('#expenses-container .billed-badge')).length === 2);
    check('repeat + edit + delete on every row',
      (await page.$$('#expenses-container .expense-actions .icon-btn')).length === 15,
      String((await page.$$('#expenses-container .expense-actions .icon-btn')).length));

    /* ---- Requested feature 2: deactivate the billed flag ---- */
    console.log('\n── D. Simple mode (billed flag deactivated)');
    await page.evaluate(() => showSettingsModal());
    await new Promise(r => setTimeout(r, 200));
    check('settings modal opens', await visible(page, '#settings-modal'));
    check('track-billing switch starts ON',
      await page.$eval('#setting-track-billing', e => e.classList.contains('on')));

    await page.evaluate(() => toggleTrackBilling());
    await new Promise(r => setTimeout(r, 700));
    await page.evaluate(() => closeSettingsModal());
    await new Promise(r => setTimeout(r, 250));

    check('billed/unbilled budget split hidden', !(await visible(page, '#budget-split')));
    check('billed stat card hidden', !(await visible(page, '#stat-billed-card')));
    check('unbilled stat card hidden', !(await visible(page, '#stat-unbilled-card')));
    check('billing toggle removed from add form', !(await visible(page, '#billing-status-group')));
    check('no BILLED badges anywhere',
      (await page.$$('#expenses-container .billed-badge')).length === 0);
    check('total budget still ₹10,000', (await txt(page, '#total-budget-total')) === '₹10,000',
      await txt(page, '#total-budget-total'));
    check('total spent still ₹5,000 (all spends counted)',
      (await txt(page, '#total-budget-spent')) === '₹5,000', await txt(page, '#total-budget-spent'));

    await page.evaluate(() => setBudget());
    await new Promise(r => setTimeout(r, 250));
    check('budget modal shows ONE total field', await visible(page, '#budget-total-group'));
    check('budget modal hides the billed field', !(await visible(page, '#budget-billed-group')));
    check('total field pre-filled with 10000',
      (await page.$eval('#total-budget-amount', e => e.value)) === '10000',
      await page.$eval('#total-budget-amount', e => e.value));
    check('hidden billed field is not `required` (would block submit)',
      (await page.$eval('#billed-budget-amount', e => e.required)) === false);
    await page.evaluate(() => closeBudgetModal());

    // New expense in simple mode must save as unbilled.
    await page.evaluate(() => {
      document.getElementById('note').value = 'Simple mode entry';
      document.getElementById('type').value = 'Food';
      document.getElementById('amount').value = '250';
      document.getElementById('expense-form')
        .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 800));
    const saved = await page.evaluate(() =>
      window.__MOCK__.state.expenses.find(e => e.note === 'Simple mode entry'));
    check('new expense saved', !!saved);
    check('  …with billed = false', saved && saved.billed === false, saved && String(saved.billed));
    check('  …dated today in IST (2026-08-31)', saved && saved.date === '2026-08-31',
      saved && saved.date);

    // Back to advanced mode; the split must return intact.
    await page.evaluate(() => toggleTrackBilling());
    await new Promise(r => setTimeout(r, 700));
    check('split reappears when re-enabled', await visible(page, '#budget-split'));
    check('billed budget preserved (₹4,000)',
      (await txt(page, '#billed-budget-total')).includes('4,000'),
      await txt(page, '#billed-budget-total'));

    /* ============ D2. Quick add ============ */
    console.log('\n── D2. Quick add: calculator, parsing, presets');

    const calc = await page.evaluate(() => [
      evalArithmetic('120+80+45'), evalArithmetic('2*150'), evalArithmetic('(100+50)/2'),
      evalArithmetic('450'), evalArithmetic('1/0'), evalArithmetic('alert(1)'),
      evalArithmetic('100-250')
    ]);
    check('calculator: 120+80+45 = 245', calc[0] === 245, String(calc[0]));
    check('calculator: 2*150 = 300', calc[1] === 300, String(calc[1]));
    check('calculator: (100+50)/2 = 75', calc[2] === 75, String(calc[2]));
    check('calculator: a plain number is left alone', calc[3] === null);
    check('calculator: divide-by-zero rejected', calc[4] === null);
    check('calculator: non-arithmetic input rejected', calc[5] === null);
    check('calculator: negative result rejected', calc[6] === null);

    const amountResolved = await page.evaluate(() => {
      document.getElementById('amount').value = '120+80+45';
      resolveAmountExpression();
      return document.getElementById('amount').value;
    });
    check('amount field accepts and resolves an expression', amountResolved === '245', amountResolved);
    const submittedSum = await page.evaluate(async () => {
      document.getElementById('note').value = 'Split bill';
      document.getElementById('type').value = 'Food';
      document.getElementById('amount').value = '200+55';
      document.getElementById('expense-form')
        .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 700));
      const e = window.__MOCK__.state.expenses.find(x => x.note === 'Split bill');
      return e ? e.amount : null;
    });
    check('submitting "200+55" stores 255', submittedSum === 255, String(submittedSum));
    await page.evaluate(() => { document.getElementById('amount').value = ''; });

    const parsed = await page.evaluate(() => [
      parseQuickAdd('450 lunch swiggy'),
      parseQuickAdd('1.2k flight to bengaluru'),
      parseQuickAdd('₹250 airport cab'),
      parseQuickAdd('groceries')
    ]);
    check('parses "450 lunch swiggy" -> 450', parsed[0].amount === 450, JSON.stringify(parsed[0]));
    check('  …note excludes the amount', parsed[0].note === 'lunch swiggy', parsed[0].note);
    check('parses "1.2k" -> 1200', parsed[1].amount === 1200, String(parsed[1].amount));
    check('  …infers Travel from "flight" in history', parsed[1].type === 'Travel', parsed[1].type);
    check('parses "₹250" -> 250', parsed[2].amount === 250, String(parsed[2].amount));
    check('  …infers Travel from "cab"', parsed[2].type === 'Travel', parsed[2].type);
    check('no amount -> null, not a guess', parsed[3].amount === null, String(parsed[3].amount));
    const unknownType = await page.evaluate(() => parseQuickAdd('99 zzzqqq').type);
    check('unknown words -> empty type, never a wrong guess', unknownType === '', unknownType);

    const before = await page.evaluate(() => window.__MOCK__.state.expenses.length);
    await page.evaluate(() => {
      const i = document.getElementById('quick-add-input');
      i.value = '325 airport cab';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 200));
    check('preview shows the parsed amount',
      (await txt(page, '#quick-add-preview')).includes('325'), await txt(page, '#quick-add-preview'));
    await page.evaluate(() => submitQuickAdd());
    await new Promise(r => setTimeout(r, 900));
    const qaRow = await page.evaluate(() =>
      window.__MOCK__.state.expenses.slice(-1)[0]);
    check('quick add saved the expense',
      (await page.evaluate(() => window.__MOCK__.state.expenses.length)) === before + 1);
    check('  …with the inferred type', qaRow.type === 'Travel', qaRow.type);
    check('  …dated today in IST', qaRow.date === '2026-08-31', qaRow.date);
    check('  …and cleared the box',
      (await page.$eval('#quick-add-input', e => e.value)) === '');

    // Presets are mined from repeats: add a duplicate and it should surface.
    await page.evaluate(() => {
      const s = window.__MOCK__.state;
      s.expenses.push({ id: 7001, user_id: 'user-test-0001', amount: 20, date: '2026-08-05',
        type: 'Food', note: 'Chai', billed: false, updated_at: '2026-08-05T00:00:00Z' });
      s.expenses.push({ id: 7002, user_id: 'user-test-0001', amount: 20, date: '2026-08-06',
        type: 'Food', note: 'Chai', billed: false, updated_at: '2026-08-06T00:00:00Z' });
      return loadRecentActivity();
    });
    await new Promise(r => setTimeout(r, 600));
    const presetLabels = await page.$$eval('#preset-chips .preset-chip', els =>
      els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
    check('repeated expense becomes a one-tap preset',
      presetLabels.some(l => l.includes('Chai')), presetLabels.join(' | '));

    const beforePreset = await page.evaluate(() => window.__MOCK__.state.expenses.length);
    await page.evaluate(() => {
      const chips = [...document.querySelectorAll('#preset-chips .preset-chip')];
      const chai = chips.find(c => c.textContent.includes('Chai'));
      chai.click();
    });
    await new Promise(r => setTimeout(r, 900));
    const presetRow = await page.evaluate(() => window.__MOCK__.state.expenses.slice(-1)[0]);
    check('one tap on a preset saves an expense',
      (await page.evaluate(() => window.__MOCK__.state.expenses.length)) === beforePreset + 1);
    check('  …with the preset amount and today\'s date',
      presetRow.amount === 20 && presetRow.date === '2026-08-31',
      JSON.stringify({ a: presetRow.amount, d: presetRow.date }));
    check('  …and offers an Undo action',
      (await page.$$('.notification-action')).length > 0);

    /* ============ D3. Recurring ============ */
    console.log('\n── D3. Recurring expenses');
    await page.evaluate(() => {
      window.__MOCK__.state.recurring_expenses.push(
        { id: 501, user_id: 'user-test-0001', amount: 18000, type: 'Rent', note: 'August rent',
          billed: false, day_of_month: 1, active: true, last_added_year: null, last_added_month: null },
        { id: 502, user_id: 'user-test-0001', amount: 499, type: 'Utilities', note: 'Broadband',
          billed: false, day_of_month: 5, active: true, last_added_year: 2026, last_added_month: 8 },
        { id: 503, user_id: 'user-test-0001', amount: 999, type: 'Food', note: 'Paused rule',
          billed: false, day_of_month: 2, active: false, last_added_year: null, last_added_month: null });
      return loadRecurring();
    });
    await new Promise(r => setTimeout(r, 500));
    check('due card appears', await visible(page, '#recurring-due'));
    check('only the genuinely due rule is listed (1 of 3)',
      (await page.$$('#recurring-due-list .recurring-due-item')).length === 1,
      String((await page.$$('#recurring-due-list .recurring-due-item')).length));
    check('  …already-added rule excluded',
      !(await txt(page, '#recurring-due-list')).includes('Broadband'));
    check('  …paused rule excluded',
      !(await txt(page, '#recurring-due-list')).includes('Paused rule'));

    const beforeRec = await page.evaluate(() => window.__MOCK__.state.expenses.length);
    await page.evaluate(() => addRecurringNow('501'));
    await new Promise(r => setTimeout(r, 900));
    const recRow = await page.evaluate(() =>
      window.__MOCK__.state.expenses.find(e => e.note === 'August rent'));
    check('adding a due rule creates the expense',
      (await page.evaluate(() => window.__MOCK__.state.expenses.length)) === beforeRec + 1);
    check('  …dated on the rule\'s day of month', recRow.date === '2026-08-01', recRow.date);
    check('  …and the card disappears once nothing is due',
      !(await visible(page, '#recurring-due')));
    check('  …rule stamped so it will not re-offer this month',
      await page.evaluate(() => {
        const r = window.__MOCK__.state.recurring_expenses.find(x => x.id === 501);
        return r.last_added_year === 2026 && r.last_added_month === 8;
      }));

    // A short month must clamp a day-31 rule.
    const clamped = await page.evaluate(() =>
      recurringDateFor({ day_of_month: 31 }, 2026, 2));
    check('day-31 rule clamps to the last day of February', clamped === '2026-02-28', clamped);

    // Missing table must degrade, not crash.
    await page.evaluate(() => {
      window.__MOCK__.state.missingTables = ['recurring_expenses'];
      return loadRecurring();
    });
    await new Promise(r => setTimeout(r, 400));
    check('missing table hides the feature instead of erroring',
      !(await visible(page, '#recurring-due')));
    await page.evaluate(() => showRecurringModal());
    await new Promise(r => setTimeout(r, 500));
    check('manage window offers the SQL to create it',
      (await txt(page, '#recurring-sql')).includes('CREATE TABLE'));
    await page.evaluate(() => {
      closeRecurringModal();
      window.__MOCK__.state.missingTables = [];
      return loadRecurring();
    });
    await new Promise(r => setTimeout(r, 400));

    /* ============ D4. Budget alert levels ============ */
    console.log('\n── D4. Budget alert levels');
    await page.evaluate(() => setBudget());
    await new Promise(r => setTimeout(r, 350));
    check('budget modal has Amounts + Alerts tabs',
      (await page.$$('#budget-modal .tab')).length === 2);
    await page.evaluate(() => switchBudgetTab('alerts'));
    await new Promise(r => setTimeout(r, 250));
    check('alerts tab shown, amounts hidden',
      (await visible(page, '#budget-tab-alerts')) && !(await visible(page, '#budget-tab-amounts')));
    const defaultRules = await page.evaluate(() => alertRules().length);
    check('default levels present', defaultRules === 4, String(defaultRules));
    check('a level shows the rupee value it fires at',
      (await txt(page, '#alert-rules-list')).includes('Fires at'),
      (await txt(page, '#alert-rules-list')).slice(0, 90));

    await page.evaluate(() => {
      document.getElementById('alert-new-scope').value = 'total';
      document.getElementById('alert-new-percent').value = '50';
      return addAlertRule();
    });
    await new Promise(r => setTimeout(r, 350));
    check('added a 50% total level',
      await page.evaluate(() => alertRules().some(r => r.scope === 'total' && r.percent === 50)));
    await page.evaluate(() => {
      document.getElementById('alert-new-scope').value = 'total';
      document.getElementById('alert-new-percent').value = '50';
      return addAlertRule();
    });
    await new Promise(r => setTimeout(r, 300));
    check('duplicate level rejected',
      (await txt(page, '#alert-rules-alert')).includes('already exists'),
      await txt(page, '#alert-rules-alert'));
    check('  …and not stored twice',
      (await page.evaluate(() =>
        alertRules().filter(r => r.scope === 'total' && r.percent === 50).length)) === 1);
    await page.evaluate(() => {
      document.getElementById('alert-new-percent').value = '0';
      return addAlertRule();
    });
    await new Promise(r => setTimeout(r, 300));
    check('0% rejected',
      (await txt(page, '#alert-rules-alert')).includes('between 1 and 500'));

    // Firing: only the highest crossed level per scope, once per month.
    const fired = await page.evaluate(async () => {
      const seen = [];
      const real = window.showNotification;
      window.showNotification = (m, t) => seen.push(t + ': ' + m);
      resetFiredAlerts();
      await checkBudgetWarnings();
      const first = seen.slice();
      seen.length = 0;
      await checkBudgetWarnings();
      const second = seen.slice();
      window.showNotification = real;
      return { first, second };
    });
    // 50/90/100 are all crossed for total by now, so the property under test
    // is "one toast per scope", not "one toast overall".
    const totalAlerts = fired.first.filter(m => m.includes('total budget')).length;
    const unbilledAlerts = fired.first.filter(m => m.includes('unbilled budget')).length;
    const billedAlerts = fired.first.filter(m => /(?<!un)billed budget/.test(m)).length;
    check('total scope alerts exactly once despite 50/90/100 all crossed',
      totalAlerts === 1, 'got ' + totalAlerts + ' :: ' + JSON.stringify(fired.first));
    check('each crossed scope alerts at most once',
      unbilledAlerts <= 1 && billedAlerts <= 1,
      JSON.stringify({ unbilledAlerts, billedAlerts }));
    check('a scope under its threshold stays silent (billed at 75%)',
      billedAlerts === 0, JSON.stringify(fired.first));
    check('  …and does not repeat on the next check',
      fired.second.length === 0, JSON.stringify(fired.second));
    await page.evaluate(() => removeAlertRule(
      alertRules().findIndex(r => r.scope === 'total' && r.percent === 50)));
    await new Promise(r => setTimeout(r, 300));
    check('level can be removed',
      !(await page.evaluate(() => alertRules().some(r => r.scope === 'total' && r.percent === 50))));
    await page.evaluate(() => closeBudgetModal());

    /* ---- Modals ---- */
    console.log('\n── E. Every modal opens and closes');
    for (const [open, close, sel] of [
      ['showVisualizationModal', 'closeVisualizationModal', '#visualization-modal'],
      ['showInsightsModal', 'closeInsightsModal', '#insights-modal'],
      ['showSearchModal', 'closeSearchModal', '#search-modal'],
      ['showImportExpenses', 'closeImportExpensesModal', '#import-expenses-modal'],
      ['showEditProfile', 'closeEditProfileModal', '#edit-profile-modal'],
      ['showAddTypeModal', 'closeAddTypeModal', '#add-type-modal'],
      ['showEditTypeModal', 'closeEditTypeModal', '#edit-type-modal'],
      ['showDeleteTypeModal', 'closeDeleteTypeModal', '#delete-type-modal'],
      ['setBudget', 'closeBudgetModal', '#budget-modal'],
      ['openScanModal', 'closeScanModal', '#scan-modal']
    ]) {
      await page.evaluate(fn => window[fn](), open);
      await new Promise(r => setTimeout(r, 400));
      const opened = await visible(page, sel);
      await page.evaluate(fn => window[fn](), close);
      await new Promise(r => setTimeout(r, 250));
      const closed = !(await visible(page, sel));
      check(`${sel} opens & closes`, opened && closed, `open=${opened} closed=${closed}`);
    }
    check('floating theme button still reachable after modals',
      await visible(page, '.theme-toggle'));
    check('body scroll lock released', !(await page.evaluate(
      () => document.body.classList.contains('modal-open'))));

    /* ---- Analytics ---- */
    console.log('\n── F. Analytics & charts');
    await page.evaluate(() => showVisualizationModal());
    await new Promise(r => setTimeout(r, 900));
    check('filtered list rendered', (await page.$$('#filtered-list-mount .expense-item')).length > 0);
    for (const t of ['line', 'horizontalBar', 'doughnut', 'bubble']) {
      await page.evaluate(t => updateChartType(t), t);
      await new Promise(r => setTimeout(r, 350));
      check(`chart type "${t}" renders`, await page.evaluate(() => !!window.currentChart ||
        !!document.querySelector('#expenseChart')));
    }
    await page.evaluate(() => applyRangePreset('all'));
    await new Promise(r => setTimeout(r, 700));
    const allTotal = await txt(page, '.expense-total');
    const expectedTotal = await page.evaluate(() =>
      money(window.__MOCK__.state.expenses.reduce((s, e) => s + Number(e.amount), 0)));
    check('all-time total matches the sum of every stored expense',
      allTotal.includes(expectedTotal), allTotal + ' vs ' + expectedTotal);

    // Empty range -> overlay, not a crash
    await page.evaluate(() => {
      document.getElementById('start-date').value = '2020-01-01';
      document.getElementById('end-date').value = '2020-01-31';
    });
    await page.evaluate(() => applyDateFilter());
    await new Promise(r => setTimeout(r, 600));
    check('empty range shows the empty-state overlay',
      await page.evaluate(() => !!document.querySelector('.chart-empty')));
    await page.evaluate(() => closeVisualizationModal());

    /* ---- Export ---- */
    console.log('\n── F2. Export matrix');
    await page.evaluate(() => showVisualizationModal());
    await new Promise(r => setTimeout(r, 500));
    await page.evaluate(() => applyRangePreset('this-month'));
    await new Promise(r => setTimeout(r, 600));

    const matrixTracked = await page.evaluate(async () => {
      const { rows, startDate, endDate } = await fetchExportRows();
      return await buildExportMatrix(rows, startDate, endDate);
    });
    check('tracked export header has Billed column',
      matrixTracked[0].join(',') === 'Date,Type,Note,Amount,Billed', matrixTracked[0].join(','));
    const totalRow = matrixTracked.find(r => r[2] === 'TOTAL');
    check('TOTAL caption in Note col, figure in Amount col',
      totalRow && typeof totalRow[3] === 'number', JSON.stringify(totalRow));
    const tbRow = matrixTracked.find(r => r[2] === 'TOTAL BUDGET');
    check('TOTAL BUDGET row = 10000', tbRow && tbRow[3] === 10000, JSON.stringify(tbRow));

    // A note with a comma and a double quote must reach the sheet intact.
    await page.evaluate(() => {
      window.__MOCK__.state.expenses.push({ id: 8888, user_id: 'user-test-0001', amount: 42,
        date: '2026-08-20', type: 'Food', billed: false,
        note: 'Chai, "extra" sugar', updated_at: '2026-08-20T00:00:00Z' });
    });
    const awkward = await page.evaluate(async () => {
      const { rows, startDate, endDate } = await fetchExportRows();
      const m = await buildExportMatrix(rows, startDate, endDate);
      return m.find(r => String(r[2]).includes('extra'));
    });
    check('quotes and commas survive into the export matrix',
      awkward && awkward[2] === 'Chai, "extra" sugar', JSON.stringify(awkward));

    // Same check with billing tracking off (4-column layout).
    await page.evaluate(() => saveSettings({ trackBilling: false }).then(applyBillingMode));
    await new Promise(r => setTimeout(r, 400));
    const matrixSimple = await page.evaluate(async () => {
      const { rows, startDate, endDate } = await fetchExportRows();
      return await buildExportMatrix(rows, startDate, endDate);
    });
    check('simple-mode export header drops Billed column',
      matrixSimple[0].join(',') === 'Date,Type,Note,Amount', matrixSimple[0].join(','));
    const simpleTotal = matrixSimple.find(r => r[2] === 'TOTAL');
    check('simple-mode TOTAL still lands in the Amount column',
      simpleTotal && typeof simpleTotal[3] === 'number', JSON.stringify(simpleTotal));
    await page.evaluate(() => saveSettings({ trackBilling: true }).then(applyBillingMode));
    await new Promise(r => setTimeout(r, 400));
    await page.evaluate(() => closeVisualizationModal());

    /* ---- Insights ---- */
    console.log('\n── G. Insights');
    await page.evaluate(() => showInsightsModal());
    await new Promise(r => setTimeout(r, 1100));
    const insightsHtml = await page.$eval('#insights-content', e => e.innerHTML.slice(0, 300));
    check('insight cards render', (await page.$$('#insights-content .insight-card')).length === 4,
      'got ' + (await page.$$('#insights-content .insight-card')).length + ' :: ' + insightsHtml.replace(/\s+/g,' '));
    if (errors.length) console.log('    errors so far: ' + errors.slice(0,4).join(' | '));
    const painted = sel => page.evaluate(s => {
      const c = document.querySelector(s);
      if (!c) return 0;
      // A blank canvas compresses to a tiny PNG; a drawn chart does not.
      return c.toDataURL('image/png').length;
    }, sel);
    check('monthly trend chart painted', (await painted('#monthlyTrendChart')) > 8000,
      'dataURL len ' + await painted('#monthlyTrendChart'));
    check('velocity chart painted', (await painted('#velocityChart')) > 8000,
      'dataURL len ' + await painted('#velocityChart'));
    await page.evaluate(() => { updateVelocityByDay(15); });
    await new Promise(r => setTimeout(r, 500));
    check('day slider redraw works', (await painted('#velocityChart')) > 8000);
    await page.evaluate(() => {
      const r = document.querySelector('input[name="velocityChartType"][value="line"]');
      r.checked = true; updateBothChartTypes();
    });
    await new Promise(r => setTimeout(r, 400));
    check('switching to line charts works', (await painted('#monthlyTrendChart')) > 8000);
    const heat = await page.evaluate(() => ({
      cells: document.querySelectorAll('#month-heatmap .heat-grid .heat-cell:not(.heat-pad)').length,
      filled: document.querySelectorAll('#month-heatmap .heat-grid .heat-cell.level-1, #month-heatmap .heat-grid .heat-cell.level-2, #month-heatmap .heat-grid .heat-cell.level-3, #month-heatmap .heat-grid .heat-cell.level-4').length,
      today: document.querySelectorAll('#month-heatmap .heat-grid .heat-cell.is-today').length,
      legend: (document.querySelector('#month-heatmap .heat-legend') || {}).textContent || ''
    }));
    check('heatmap renders one cell per day of August (31)', heat.cells === 31, String(heat.cells));
    check('  …days with spend are shaded', heat.filled > 0, String(heat.filled));
    check('  …today is marked exactly once', heat.today === 1, String(heat.today));
    check('  …legend counts logged vs blank days', heat.legend.includes('logged'), heat.legend);
    await page.evaluate(() => closeInsightsModal());

    /* ---- Backup ---- */
    console.log('\n── H0. Full JSON backup');
    const backup = await page.evaluate(async () => {
      let captured = null;
      const realCreate = URL.createObjectURL;
      URL.createObjectURL = b => { captured = b; return 'blob:stub'; };
      const realClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { };
      await downloadFullBackup();
      URL.createObjectURL = realCreate;
      HTMLAnchorElement.prototype.click = realClick;
      return captured ? JSON.parse(await captured.text()) : null;
    });
    check('backup produced a JSON file', backup !== null);
    check('  …tagged with format + version',
      backup.format === 'my-expense-tracker-backup' && backup.version === 1);
    check('  …contains every expense', backup.data.expenses.length === backup.counts.expenses
      && backup.counts.expenses > 0, String(backup.counts.expenses));
    check('  …includes types, budgets, recurring and settings',
      backup.data.expense_types.length > 0 && backup.data.user_budgets.length > 0
      && Array.isArray(backup.data.recurring_expenses) && !!backup.settings);

    /* ---- Search ---- */
    console.log('\n── H. Search');
    await page.evaluate(() => showSearchModal());
    await new Promise(r => setTimeout(r, 600));
    await page.evaluate(() => {
      const i = document.getElementById('search-input');
      i.value = 'power bill'; i.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 450));
    check('search finds "power bill"', (await txt(page, '.search-summary')).startsWith('1 expense'),
      await txt(page, '.search-summary'));
    check('match is highlighted', (await page.$$('#search-results mark')).length > 0);
    await page.evaluate(() => closeSearchModal());

    /* ---- XSS ---- */
    /* ---- Receipt scanner ---- */
    // The OCR readers need a real screenshot, so what is exercised here is
    // everything downstream of them: the editable list, the tick that drops a
    // line, the running total, and the note that reaches the form.
    console.log('\n── H2. Receipt scanner');
    const typeInto = (sel, value) => page.evaluate((s, v) => {
      const el = document.querySelector(s);
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, sel, value);

    await page.evaluate(() => openScanModal());
    await new Promise(r => setTimeout(r, 350));
    check('scanner opens on the picker', await visible(page, '#scan-pick'));

    await page.evaluate(() => document.getElementById('scan-manual').click());
    await new Promise(r => setTimeout(r, 250));
    check('by-hand route gives one blank line',
      (await page.$$('#scan-rows .scan-row')).length === 1);

    await typeInto('#scan-rows .scan-row:nth-child(1) .scan-name', 'Milk Maid');
    await typeInto('#scan-rows .scan-row:nth-child(1) .scan-qty', '2');
    await typeInto('#scan-rows .scan-row:nth-child(1) .scan-price', '120.50');
    await page.evaluate(() => document.getElementById('scan-add').click());
    await new Promise(r => setTimeout(r, 150));
    await typeInto('#scan-rows .scan-row:nth-child(2) .scan-name', 'Potato');
    await typeInto('#scan-rows .scan-row:nth-child(2) .scan-price', '30');
    await page.evaluate(() => document.getElementById('scan-add').click());
    await new Promise(r => setTimeout(r, 150));
    await typeInto('#scan-rows .scan-row:nth-child(3) .scan-name', 'Delivery Fee');
    await typeInto('#scan-rows .scan-row:nth-child(3) .scan-price', '20');
    await new Promise(r => setTimeout(r, 150));

    check('all three lines count toward the total',
      (await txt(page, '#scan-foot .is-total .v')) === '₹170.50',
      await txt(page, '#scan-foot .is-total .v'));

    await page.evaluate(() => {
      const tick = document.querySelector('#scan-rows .scan-row:nth-child(3) .scan-tick');
      tick.checked = false;
      tick.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 200));
    check('unticking a line takes it off the total',
      (await txt(page, '#scan-foot .is-total .v')) === '₹150.50',
      await txt(page, '#scan-foot .is-total .v'));
    check('the dropped line is still shown, struck off',
      await page.evaluate(() =>
        document.querySelector('#scan-rows .scan-row:nth-child(3)').classList.contains('is-off')));
    check('note preview leaves the dropped line out',
      (await txt(page, '#scan-foot .scan-note-preview .val')) === 'Milk Maid ×2 + Potato ×1',
      await txt(page, '#scan-foot .scan-note-preview .val'));

    await page.evaluate(() => document.getElementById('scan-apply').click());
    await new Promise(r => setTimeout(r, 400));
    check('scanner closes on apply', !(await visible(page, '#scan-modal')));
    check('note prefilled with the itemisation',
      await page.evaluate(() => document.getElementById('note').value) === 'Milk Maid ×2 + Potato ×1',
      await page.evaluate(() => document.getElementById('note').value));
    check('amount prefilled with the kept total',
      await page.evaluate(() => document.getElementById('amount').value) === '150.50',
      await page.evaluate(() => document.getElementById('amount').value));

    await page.evaluate(() => {
      document.getElementById('note').value = '';
      document.getElementById('amount').value = '';
    });

    /* ---- Quick add: type names, history, and the amount chips ---- */
    console.log('\n── H2b. Quick add and the amount field');
    await page.evaluate(() => loadRecentActivity());
    await new Promise(r => setTimeout(r, 700));

    // A word that IS a type files itself, whatever case it is typed in.
    const swiggy = await page.evaluate(() => {
      const s = window.__MOCK__.state.expense_types;
      s.push({ id: 90, user_id: 'user-test-0001', name: 'Swiggy' });
      s.push({ id: 91, user_id: 'user-test-0001', name: 'Personal Care' });
      return loadUserTypes().then(() => parseQuickAdd('450 swiggy'));
    });
    check('a lower-case type name matches the type',
      swiggy.type === 'Swiggy' && swiggy.amount === 450, JSON.stringify(swiggy));
    check('…and becomes the note, so it is addable as it stands',
      swiggy.note === 'Swiggy', JSON.stringify(swiggy));

    const both = await page.evaluate(() => parseQuickAdd('450 swiggy office lunch'));
    check('the type word is dropped from the note when there is more to say',
      both.type === 'Swiggy' && both.note === 'office lunch', JSON.stringify(both));

    // Word order carries no meaning: each part is found by what it is.
    const orders = await page.evaluate(() => [
      'swiggy 450', 'swiggy 450 office lunch', 'office 450 lunch swiggy',
      'office lunch swiggy 450'
    ].map(text => parseQuickAdd(text)));
    check('the amount is found wherever it sits',
      orders.every(p => p.amount === 450), JSON.stringify(orders.map(p => p.amount)));
    check('the type is found wherever it sits',
      orders.every(p => p.type === 'Swiggy'), JSON.stringify(orders.map(p => p.type)));
    check('and what is left over is the summary, in the order typed',
      orders.slice(1).every(p => p.note === 'office lunch'),
      JSON.stringify(orders.map(p => p.note)));

    const sums = await page.evaluate(() => parseQuickAdd('dinner 120+80'));
    check('a sum is recognised mid-line too',
      sums.amount === 200 && sums.note === 'dinner', JSON.stringify(sums));

    // Two words that are both type names: the first is the type, the rest
    // becomes the summary.
    const ambiguous = await page.evaluate(() => parseQuickAdd('450 food travel'));
    check('two type words — the first is the type, the other the summary',
      ambiguous.type === 'Food' && ambiguous.note === 'travel', JSON.stringify(ambiguous));

    // A multi-word type is matched whole, and beats a shorter match inside it.
    const care = await page.evaluate(() => parseQuickAdd('300 personal care shampoo'));
    check('a multi-word type name matches as one span',
      care.type === 'Personal Care' && care.note === 'shampoo', JSON.stringify(care));

    // A word seen in past notes is filed the way it was filed before. The
    // fixture has "Cab" and "Flight" under Travel.
    const cab = await page.evaluate(() => parseQuickAdd('45 cab'));
    check('a word from your history picks up its type',
      cab.type === 'Travel' && cab.amount === 45, JSON.stringify(cab));

    const unknown = await page.evaluate(() => parseQuickAdd('90 something novel here'));
    check('an unrecognised note leaves the note intact',
      unknown.note === 'something novel here', JSON.stringify(unknown));

    // The chips under Amount come from what has actually been spent.
    await page.evaluate(() => {
      document.getElementById('note').value = '';
      document.getElementById('type').value = 'Travel';
      renderAmountChips();
    });
    await new Promise(r => setTimeout(r, 250));
    const travelChips = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#amount-chips .chip.is-seen'))
        .map(c => c.dataset.set));
    check('Travel suggests the amounts spent on Travel',
      travelChips.includes('1000') && travelChips.includes('2000'),
      JSON.stringify(travelChips));

    await page.evaluate(() =>
      document.querySelector('#amount-chips .chip.is-seen').click());
    check('tapping one sets the amount rather than adding to it',
      (await page.$eval('#amount', e => e.value)) !== '',
      await page.$eval('#amount', e => e.value));

    // With nothing to go on, the fixed increments come back.
    await page.evaluate(() => {
      document.getElementById('note').value = '';
      document.getElementById('type').value = '';
      document.getElementById('amount').value = '';
      renderAmountChips();
    });
    await new Promise(r => setTimeout(r, 250));
    check('no history means the +50/+100/+200/+500 fallback',
      await page.evaluate(() =>
        Array.from(document.querySelectorAll('#amount-chips .chip'))
          .map(c => c.textContent.trim()).join(',') === '+50,+100,+200,+500,Clear'),
      await page.$eval('#amount-chips', e => e.textContent));

    // The operators a decimal keypad does not offer.
    await page.evaluate(() => {
      document.getElementById('amount').value = '120';
      appendAmountOperator('+');
    });
    check('the + key appends an operator',
      (await page.$eval('#amount', e => e.value)) === '120+',
      await page.$eval('#amount', e => e.value));
    await page.evaluate(() => appendAmountOperator('-'));
    check('a second operator swaps rather than stacks',
      (await page.$eval('#amount', e => e.value)) === '120-',
      await page.$eval('#amount', e => e.value));
    await page.evaluate(() => {
      document.getElementById('amount').value = '120+80+45';
      resolveAmountExpression();
    });
    check('the expression still resolves',
      (await page.$eval('#amount', e => e.value)) === '245',
      await page.$eval('#amount', e => e.value));
    await page.evaluate(() => {
      document.getElementById('amount').value = '';
      document.getElementById('note').value = '';
    });

    /* ---- Filters that apply themselves ---- */
    console.log('\n── H3. Filters, offline queue, admin');
    await page.evaluate(() => showVisualizationModal());
    await new Promise(r => setTimeout(r, 700));
    check('no Apply Filter button left',
      await page.evaluate(() => !/Apply Filter/.test(document.getElementById('filter-hint')
        .closest('.filter-actions').textContent)));
    check('no CSV export button left',
      await page.evaluate(() => !/Export CSV/.test(document.body.textContent)));

    const rowsBefore = (await page.$$('#filtered-list-mount .expense-item')).length;
    await page.evaluate(() => {
      const field = document.getElementById('type-filter');
      field.value = 'Travel';
      field.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 900));
    const rowsAfter = (await page.$$('#filtered-list-mount .expense-item')).length;
    check('changing a filter re-runs it with no Apply press',
      rowsAfter > 0 && rowsAfter < rowsBefore, `before=${rowsBefore} after=${rowsAfter}`);
    check('…and narrows to exactly that type',
      await page.evaluate(() => Array.from(
        document.querySelectorAll('#filtered-list-mount .expense-type'))
        .every(el => el.textContent.trim() === 'Travel')));
    await page.evaluate(() => {
      const field = document.getElementById('type-filter');
      field.value = 'all';
      field.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 800));
    await page.evaluate(() => closeVisualizationModal());

    /* ---- Editing from the dashboard list ---- */
    const recentId = await page.evaluate(() =>
      document.querySelector('#expenses-container .expense-item').getAttribute('data-id'));
    await page.evaluate(id => toggleEditMode('recent', id), recentId);
    await new Promise(r => setTimeout(r, 400));
    check('Recent Expenses rows edit in place',
      await page.evaluate(id =>
        !!document.querySelector(`#expenses-container [data-id="${id}"] .expense-note input`),
        recentId));
    await page.evaluate(id => {
      const input = document.querySelector(
        `#expenses-container [data-id="${id}"] .expense-note input`);
      input.value = 'Edited from the dashboard';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, recentId);
    await new Promise(r => setTimeout(r, 250));
    check('its own Save button appears, not the analytics one',
      await page.evaluate(() =>
        document.querySelector('[data-save-scope="recent"]').style.display === 'block'));
    await page.evaluate(() => saveAllChanges('recent'));
    await new Promise(r => setTimeout(r, 900));
    check('the edit reaches the database',
      await page.evaluate(id => (window.__MOCK__.state.expenses
        .find(e => String(e.id) === String(id)) || {}).note === 'Edited from the dashboard',
        recentId));

    /* ---- Change password lives in Edit Profile ---- */
    await page.evaluate(() => showEditProfile());
    await new Promise(r => setTimeout(r, 400));
    check('Edit Profile carries the password fields',
      await visible(page, '#profile-new-password') && await visible(page, '#profile-confirm-password'));
    check('Change Password is gone from the user menu',
      await page.evaluate(() => !/Change Password/.test(
        document.getElementById('user-menu').textContent)));
    await page.evaluate(() => closeEditProfileModal());

    /* ---- The offline outbox ---- */
    check('queued rows are readable before anything is queued',
      (await page.evaluate(() => pendingExpenses('user-test-0001').then(r => r.length))) === 0);
    const queued = await page.evaluate(async () => {
      const entry = await queueExpense({ amount: 275, date: '2026-08-31', type: 'Food',
        note: 'Queued while offline', billed: false }, 'user-test-0001');
      await loadExpenses();
      return entry.id;
    });
    await new Promise(r => setTimeout(r, 500));
    check('a queued expense shows as PENDING in Recent Expenses',
      (await page.$$('#expenses-container .expense-item.is-pending')).length === 1);
    check('it is not in the database yet',
      await page.evaluate(() => !window.__MOCK__.state.expenses
        .some(e => e.note === 'Queued while offline')));
    check('the queue chip says how many are waiting',
      (await txt(page, '#offline-chip')).includes('1 waiting'),
      await txt(page, '#offline-chip'));
    await page.evaluate(() => flushOutbox({ quiet: true }));
    await new Promise(r => setTimeout(r, 900));
    check('flushing sends it',
      await page.evaluate(() => window.__MOCK__.state.expenses
        .some(e => e.note === 'Queued while offline')));
    check('and the queue empties',
      (await page.evaluate(() => pendingExpenses('user-test-0001').then(r => r.length))) === 0);
    await page.evaluate(id => removeQueued(id), queued);

    /* ---- Admin ---- */
    // Checked with the menu actually open: an item inside a closed menu still
    // has a box, so viewport visibility alone would pass either way.
    const menuShows = async label => {
      await page.evaluate(() => toggleUserMenu(new Event('click')));
      await new Promise(r => setTimeout(r, 250));
      const seen = await visible(page, label);
      await page.evaluate(() => closeUserMenu());
      await new Promise(r => setTimeout(r, 200));
      return seen;
    };

    check('Admin is hidden for an ordinary account', !(await menuShows('#admin-menu-item')));

    await page.evaluate(() => {
      const rows = window.__MOCK__.state.user_profiles;
      const mine = rows.find(p => p.user_id === 'user-test-0001');
      const me = { user_id: 'user-test-0001', email: 'tester@example.com',
                   full_name: 'Test User', is_admin: true, created_at: '2026-01-02T00:00:00Z' };
      if (mine) Object.assign(mine, me); else rows.push(me);
      rows.push({ user_id: 'user-test-0002', email: 'someone@example.com',
                  full_name: 'Someone Else', is_admin: false,
                  created_at: '2026-02-02T00:00:00Z' });
      return refreshAdminFlag();
    });
    await new Promise(r => setTimeout(r, 300));
    check('Admin appears once the flag is set, above Logout',
      (await menuShows('#admin-menu-item')) &&
      await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('#user-menu .user-menu-item'));
        return items.findIndex(el => el.id === 'admin-menu-item') ===
               items.findIndex(el => /Logout/.test(el.textContent)) - 1;
      }));

    await page.evaluate(() => showAdminModal());
    await new Promise(r => setTimeout(r, 800));
    check('People tab lists everybody',
      (await page.$$('#admin-user-list .admin-row')).length === 2,
      String((await page.$$('#admin-user-list .admin-row')).length));
    check('the ADMIN tag marks the admin',
      (await page.$$('#admin-user-list .admin-tag.is-admin')).length === 1);

    await page.evaluate(() => openAdminUser('user-test-0001'));
    await new Promise(r => setTimeout(r, 600));
    check("a person's expense log opens",
      (await page.$$('#admin-detail .admin-log-row')).length > 0,
      String((await page.$$('#admin-detail .admin-log-row')).length));
    check('acting as yourself is refused, not offered',
      await page.evaluate(() => !/Sign in as them/.test(
        document.getElementById('admin-detail').textContent)));

    await page.evaluate(() => openAdminUser('user-test-0002'));
    await new Promise(r => setTimeout(r, 600));
    check('somebody else gets the full action set',
      await page.evaluate(() => {
        const text = document.getElementById('admin-detail').textContent;
        return ['Make admin', 'Sign in as them', 'Block', 'Delete account']
          .every(label => text.includes(label));
      }));

    await page.evaluate(() => switchAdminTab('access'));
    await new Promise(r => setTimeout(r, 600));
    check('Access shows both signup switches',
      await visible(page, '#admin-signups-switch') && await visible(page, '#admin-invite-switch'));
    check('signups start open',
      await page.evaluate(() =>
        document.getElementById('admin-signups-switch').classList.contains('on')));
    await page.evaluate(() => adminToggleSetting('signups_enabled'));
    await new Promise(r => setTimeout(r, 500));
    check('closing signups persists',
      await page.evaluate(() => window.__MOCK__.state.settings.signups_enabled === false));
    check('and the switch follows',
      await page.evaluate(() =>
        !document.getElementById('admin-signups-switch').classList.contains('on')));

    await page.evaluate(() => switchAdminTab('audit'));
    await new Promise(r => setTimeout(r, 600));
    check('the audit log records it',
      (await page.$eval('#admin-body', e => e.textContent)).includes('changed a setting'));

    await page.evaluate(() => closeAdminModal());
    await new Promise(r => setTimeout(r, 300));
    check('admin modal closes', !(await visible(page, '#admin-modal')));

    console.log('\n── I. Injection safety');
    await page.evaluate(() => {
      window.__MOCK__.state.expenses.push({
        id: 9999, user_id: 'user-test-0001', amount: 11,
        date: '2026-08-30', type: 'Food', billed: false,
        note: '"><img src=x onerror=window.__XSS__=1>',
        updated_at: '2026-08-31T23:00:00Z'
      });
    });
    await page.evaluate(() => loadExpenses());
    await new Promise(r => setTimeout(r, 500));
    await page.evaluate(() => showVisualizationModal());
    await new Promise(r => setTimeout(r, 400));
    await page.evaluate(() => applyRangePreset('all'));
    await new Promise(r => setTimeout(r, 800));
    await page.evaluate(() => toggleEditMode('filtered', '9999'));
    await new Promise(r => setTimeout(r, 400));
    check('hostile note does not execute (list + edit mode)',
      await page.evaluate(() => window.__XSS__ === undefined));
    check('hostile note round-trips into the edit input intact',
      await page.evaluate(() => {
        const i = document.querySelector('#filtered-list-mount [data-id="9999"] .expense-note input');
        return i && i.value === '"><img src=x onerror=window.__XSS__=1>';
      }));
    await page.evaluate(() => closeVisualizationModal());

    check('NO console/page errors in run A', errors.length === 0, errors.slice(0, 6).join(' | '));
    await page.close();

    /* ============ J. Same instant, device in Los Angeles ============ */
    console.log('\n── J. Same instant, device TZ = America/Los_Angeles');
    const la = await boot(browser, { timezone: 'America/Los_Angeles' });
    await la.page.goto(base, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 900));
    check('still August in India', (await txt(la.page, '#budget-header')) === 'August Budget',
      await txt(la.page, '#budget-header'));
    check('this month still ₹5,000.00',
      (await txt(la.page, '#monthly-expenses')) === '₹5,000.00',
      await txt(la.page, '#monthly-expenses'));
    check('date field defaults to 2026-08-31',
      (await la.page.$eval('#date', e => e.value)) === '2026-08-31',
      await la.page.$eval('#date', e => e.value));
    check('a 31 Aug expense renders as 31 Aug (no off-by-one)',
      (await la.page.$eval('#expenses-container .expense-item .expense-date',
        e => e.textContent)).includes('31 Aug 2026'),
      await la.page.$eval('#expenses-container .expense-item .expense-date',
        e => e.textContent));
    check('no errors in the LA run', la.errors.length === 0, la.errors.slice(0, 5).join(' | '));
    await la.page.close();

    /* ============ K. iPhone 13 Pro Max ============ */
    console.log('\n── K. iPhone 13 Pro Max (428 × 926, DPR 3)');
    const ip = await boot(browser, {
      viewport: { width: 428, height: 926, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
    });
    await ip.page.goto(base, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 900));

    const overflow = await ip.page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      win: window.innerWidth,
      culprits: [...document.querySelectorAll('body *')]
        .filter(el => el.getBoundingClientRect().right > window.innerWidth + 1)
        .slice(0, 5).map(el => el.tagName + '.' + String(el.className.baseVal || el.className || '').split(' ')[0])
    }));
    check('no horizontal overflow on the dashboard',
      overflow.doc <= overflow.win + 1, `scrollWidth=${overflow.doc} vs ${overflow.win} :: ${overflow.culprits.join(', ')}`);

    const smallFonts = await ip.page.evaluate(() =>
      [...document.querySelectorAll('input:not([type=hidden]), select, textarea')]
        .filter(el => el.offsetParent !== null && parseFloat(getComputedStyle(el).fontSize) < 16)
        .map(el => (el.id || el.tagName) + '@' + getComputedStyle(el).fontSize));
    check('every visible input is ≥16px (no iOS focus-zoom)',
      smallFonts.length === 0, smallFonts.join(', '));

    const taps = await ip.page.evaluate(() =>
      [...document.querySelectorAll('button, a, select, input[type=date]')]
        .filter(el => el.offsetParent !== null)
        .map(el => ({ id: el.id || el.className, h: Math.round(el.getBoundingClientRect().height),
                      w: Math.round(el.getBoundingClientRect().width) }))
        .filter(t => t.h > 0 && (t.h < 32 || t.w < 32)));
    check('touch targets are at least 32px', taps.length === 0,
      taps.slice(0, 5).map(t => `${t.id}:${t.w}x${t.h}`).join(', '));

    check('FAB visible on mobile', await visible(ip.page, '#fab-add'));

    await ip.page.evaluate(() => showVisualizationModal());
    await new Promise(r => setTimeout(r, 900));
    const modalOverflow = await ip.page.evaluate(() => {
      const m = document.querySelector('#visualization-modal .modal-content');
      return { right: Math.round(m.getBoundingClientRect().right), win: window.innerWidth,
               locked: document.body.classList.contains('modal-open') };
    });
    check('modal fits the viewport width', modalOverflow.right <= modalOverflow.win + 1,
      `${modalOverflow.right} > ${modalOverflow.win}`);
    check('background scroll locked while a modal is open', modalOverflow.locked);
    await ip.page.evaluate(() => closeVisualizationModal());
    await new Promise(r => setTimeout(r, 300));
    check('scroll lock released after close',
      !(await ip.page.evaluate(() => document.body.classList.contains('modal-open'))));

    await ip.page.screenshot({ path: SHOTS + '/shot-iphone-light.png', fullPage: true });
    await ip.page.evaluate(() => toggleTheme());
    await new Promise(r => setTimeout(r, 500));
    await ip.page.screenshot({ path: SHOTS + '/shot-iphone-dark.png', fullPage: true });
    check('no errors on iPhone viewport', ip.errors.length === 0, ip.errors.slice(0, 5).join(' | '));
    await ip.page.close();

    /* ============ L. Desktop screenshots ============ */
    const d = await boot(browser, { viewport: { width: 1280, height: 1000 } });
    await d.page.goto(base, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 900));
    await d.page.screenshot({ path: SHOTS + '/shot-desktop-light.png', fullPage: true });
    await d.page.evaluate(() => toggleTheme());
    await new Promise(r => setTimeout(r, 400));
    await d.page.screenshot({ path: SHOTS + '/shot-desktop-dark.png', fullPage: true });
    await d.page.evaluate(() => { toggleTheme(); showInsightsModal(); });
    await new Promise(r => setTimeout(r, 1300));
    await d.page.screenshot({ path: SHOTS + '/shot-insights.png' });
    await d.page.evaluate(() => { closeInsightsModal(); showVisualizationModal(); });
    await new Promise(r => setTimeout(r, 1200));
    await d.page.screenshot({ path: SHOTS + '/shot-analytics.png' });
    await d.page.close();

  } catch (error) {
    failures.push('HARNESS CRASH: ' + error.stack);
    console.log('\n!! ' + error.stack);
  } finally {
    await browser.close();
    server.close();
  }

  console.log('\n' + '='.repeat(62));
  console.log(`${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log('\nFAILURES:'); failures.forEach(f => console.log(' • ' + f)); }
  process.exit(failures.length ? 1 : 0);
})();
