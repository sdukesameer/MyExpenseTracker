/* Installed via evaluateOnNewDocument, BEFORE script.js runs.
   Replaces window.supabase with an in-memory fake so the app can be
   exercised end to end without touching the production database. */
window.__MOCK__ = (function () {
    const state = {
        expenses: [],
        expense_types: [],
        user_budgets: [],
        user_profiles: [],
        recurring_expenses: [],
        banned_emails: [],
        allowed_emails: [],
        admin_audit: [],
        settings: { signups_enabled: true, invite_only: false },
        nextId: 1000,
        calls: []
    };

    function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

    function makeQuery(table, mode, payload, opts) {
        const filters = [];
        let orderBy = null, orderAsc = true, limit = null, single = false;

        const api = {
            select() { return api; },
            eq(col, val) { filters.push(r => String(r[col]) === String(val)); return api; },
            neq(col, val) { filters.push(r => String(r[col]) !== String(val)); return api; },
            gte(col, val) { filters.push(r => r[col] >= val); return api; },
            lte(col, val) { filters.push(r => r[col] <= val); return api; },
            ilike(col, val) {
                const needle = String(val).toLowerCase();
                filters.push(r => String(r[col]).toLowerCase() === needle);
                return api;
            },
            like(col, val) {
                const needle = String(val).replace(/%/g, '').toLowerCase();
                filters.push(r => String(r[col] || '').toLowerCase().includes(needle));
                return api;
            },
            order(col, o) { orderBy = col; orderAsc = !(o && o.ascending === false); return api; },
            limit(n) { limit = n; return api; },
            single() { single = 'strict'; return api; },
            maybeSingle() { single = 'maybe'; return api; },
            then(resolve, reject) { return api._run().then(resolve, reject); },
            catch(fn) { return api._run().catch(fn); },

            _run() {
                state.calls.push({ table, mode });
                try {
                    if (mode === 'insert') {
                        const rows = (Array.isArray(payload) ? payload : [payload]).map(row =>
                            Object.assign({
                                id: state.nextId++,
                                updated_at: new Date().toISOString(),
                                created_at: new Date().toISOString()
                            }, row));
                        state[table].push(...rows);
                        return Promise.resolve({ data: rows, error: null });
                    }
                    if (mode === 'upsert') {
                        const conflict = String((opts && opts.onConflict) || 'id').split(',');
                        const rows = Array.isArray(payload) ? payload : [payload];
                        for (const row of rows) {
                            const existing = state[table].find(r =>
                                conflict.every(k => String(r[k]) === String(row[k])));
                            if (existing) Object.assign(existing, row);
                            else state[table].push(Object.assign({ id: state.nextId++ }, row));
                        }
                        return Promise.resolve({ data: rows, error: null });
                    }

                    let rows = state[table].filter(r => filters.every(f => f(r)));

                    if (mode === 'delete') {
                        state[table] = state[table].filter(r => !rows.includes(r));
                        return Promise.resolve({ data: rows, error: null });
                    }
                    if (mode === 'update') {
                        rows.forEach(r => Object.assign(r, payload,
                            { updated_at: new Date().toISOString() }));
                        return Promise.resolve({ data: rows, error: null });
                    }

                    if (orderBy) {
                        rows = rows.slice().sort((a, b) =>
                            orderAsc ? cmp(a[orderBy], b[orderBy]) : cmp(b[orderBy], a[orderBy]));
                    }
                    if (limit !== null) rows = rows.slice(0, limit);

                    if (single) {
                        if (rows.length === 0) {
                            return Promise.resolve(single === 'maybe'
                                ? { data: null, error: null }
                                : { data: null, error: { message: 'no rows' } });
                        }
                        return Promise.resolve({ data: rows[0], error: null });
                    }
                    return Promise.resolve({ data: rows, error: null });
                } catch (error) {
                    return Promise.resolve({ data: null, error: { message: String(error) } });
                }
            }
        };
        return api;
    }

    const USER = {
        id: 'user-test-0001',
        email: 'tester@example.com',
        user_metadata: { display_name: 'Test User' }
    };

    /* The admin_* functions from supabase/admin.sql, in memory. They are
       security definer in Postgres and gated on is_admin; here the gate is
       the same check against the caller's own user_profiles row, so a test
       that forgets to grant the flag gets the same refusal the real one
       would give. */
    function profileOf(id) {
        return state.user_profiles.find(p => String(p.user_id) === String(id));
    }
    function callerIsAdmin() {
        const me = profileOf(USER.id);
        return !!(me && me.is_admin);
    }
    function audit(action, targetEmail, detail) {
        const me = profileOf(USER.id) || {};
        state.admin_audit.unshift({
            actor_email: me.email || '', action, target_email: targetEmail || null,
            detail: detail || {}, at: new Date().toISOString()
        });
    }
    function spendOf(id) {
        return state.expenses.filter(e => String(e.user_id) === String(id))
            .reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);
    }

    const RPC = {
        admin_stats() {
            return {
                users: state.user_profiles.length,
                admins: state.user_profiles.filter(p => p.is_admin).length,
                banned: state.banned_emails.length,
                allowed: state.allowed_emails.length,
                expenses: state.expenses.length,
                spend: state.expenses.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0),
                expenses_30d: state.expenses.length,
                new_users_30d: state.user_profiles.length,
                signups_enabled: state.settings.signups_enabled,
                invite_only: state.settings.invite_only
            };
        },
        admin_users(args) {
            const q = String((args && args.p_search) || '').trim().toLowerCase();
            return state.user_profiles
                .filter(p => !q ||
                    String(p.email || '').toLowerCase().includes(q) ||
                    String(p.full_name || '').toLowerCase().includes(q))
                .map(p => ({
                    user_id: p.user_id, email: p.email, full_name: p.full_name,
                    is_admin: !!p.is_admin, created_at: p.created_at || '2026-01-01T00:00:00Z',
                    banned: state.banned_emails.some(b => b.email === p.email),
                    expenses: state.expenses.filter(e => String(e.user_id) === String(p.user_id)).length,
                    spend: spendOf(p.user_id), last_write: null
                }));
        },
        admin_user_detail(args) {
            const id = args.p_user;
            const mine = state.expenses.filter(e => String(e.user_id) === String(id));
            const profile = profileOf(id) || null;
            return {
                profile,
                totals: {
                    count: mine.length,
                    spend: mine.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0),
                    billed: mine.filter(e => e.billed).reduce((s, e) => s + (+e.amount || 0), 0),
                    unbilled: mine.filter(e => !e.billed).reduce((s, e) => s + (+e.amount || 0), 0),
                    first: mine.length ? mine.map(e => e.date).sort()[0] : null,
                    last: mine.length ? mine.map(e => e.date).sort().slice(-1)[0] : null
                },
                types: Object.entries(mine.reduce((acc, e) => {
                    acc[e.type] = (acc[e.type] || 0) + (parseFloat(e.amount) || 0);
                    return acc;
                }, {})).map(([name, total]) => ({ name, total })),
                budgets: state.user_budgets
                    .filter(b => String(b.user_id) === String(id))
                    .map(b => ({ year: b.budget_year, month: b.budget_month,
                                 billed: b.monthly_billed_budget,
                                 unbilled: b.monthly_unbilled_budget })),
                expenses: mine.slice().sort((a, b) => cmp(b.date, a.date))
            };
        },
        admin_set_profile(args) {
            const row = profileOf(args.p_user);
            if (!row) throw new Error('No such person.');
            if (String(args.p_user) === String(USER.id) && args.p_is_admin === false) {
                throw new Error('You cannot remove your own admin rights.');
            }
            if (args.p_full_name) row.full_name = args.p_full_name;
            if (args.p_is_admin !== undefined && args.p_is_admin !== null) {
                row.is_admin = args.p_is_admin;
            }
            audit('profile_edited', row.email, { is_admin: args.p_is_admin });
            return row;
        },
        admin_set_setting(args) {
            if (['signups_enabled', 'invite_only'].indexOf(args.p_key) === -1) {
                throw new Error('Unknown setting ' + args.p_key + '.');
            }
            state.settings[args.p_key] = !!args.p_enabled;
            audit('setting_changed', null, { key: args.p_key, enabled: !!args.p_enabled });
            return { key: args.p_key, enabled: !!args.p_enabled };
        },
        admin_allow_email(args) {
            const addr = String(args.p_email || '').trim().toLowerCase();
            if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) {
                throw new Error('That is not an email address.');
            }
            const existing = state.allowed_emails.find(a => a.email === addr);
            if (existing) existing.note = args.p_note || null;
            else state.allowed_emails.push({ email: addr, note: args.p_note || null,
                                             added_at: new Date().toISOString() });
            audit('email_allowed', addr, {});
            return null;
        },
        admin_disallow_email(args) {
            const addr = String(args.p_email || '').trim().toLowerCase();
            state.allowed_emails = state.allowed_emails.filter(a => a.email !== addr);
            audit('email_disallowed', addr, {});
            return null;
        },
        admin_lists() {
            return {
                banned: state.banned_emails.map(b => ({
                    email: b.email, reason: b.reason, at: b.banned_at, by: null,
                    has_account: state.user_profiles.some(p => p.email === b.email)
                })),
                allowed: state.allowed_emails.map(a => ({
                    email: a.email, note: a.note, at: a.added_at,
                    signed_up: state.user_profiles.some(p => p.email === a.email)
                }))
            };
        },
        admin_audit_log() { return state.admin_audit.slice(); }
    };

    const client = {
        rpc(name, args) {
            state.calls.push({ rpc: name });
            const fn = RPC[name];
            if (!fn) {
                return Promise.resolve({ data: null, error: {
                    message: 'Could not find the function public.' + name + ' in the schema cache' } });
            }
            if (!callerIsAdmin()) {
                return Promise.resolve({ data: null, error: { message: 'Not an administrator.' } });
            }
            try {
                return Promise.resolve({ data: fn(args || {}), error: null });
            } catch (error) {
                return Promise.resolve({ data: null, error: { message: error.message } });
            }
        },
        from(table) {
            if (state.missingTables && state.missingTables.indexOf(table) !== -1) {
                const fail = () => Promise.resolve({ data: null,
                    error: { message: 'relation "' + table + '" does not exist', code: '42P01' } });
                const stub = new Proxy({}, { get: (_, prop) =>
                    prop === 'then' ? (res, rej) => fail().then(res, rej) : () => stub });
                return stub;
            }
            if (!state[table]) state[table] = [];
            return {
                select: (...a) => makeQuery(table, 'select').select(...a),
                insert: p => makeQuery(table, 'insert', p),
                update: p => makeQuery(table, 'update', p),
                delete: () => makeQuery(table, 'delete'),
                upsert: (p, o) => makeQuery(table, 'upsert', p, o)
            };
        },
        auth: {
            getSession: () => Promise.resolve({
                data: { session: { user: USER, access_token: 'test-token' } }, error: null }),
            getUser: () => Promise.resolve({ data: { user: USER }, error: null }),
            onAuthStateChange: () => ({ data: { subscription: { unsubscribe() { } } } }),
            signInWithPassword: () => Promise.resolve({ data: { user: USER }, error: null }),
            signOut: () => Promise.resolve({ error: null }),
            updateUser: () => Promise.resolve({ data: { user: USER }, error: null }),
            verifyOtp: () => Promise.resolve({ data: {}, error: null }),
            resetPasswordForEmail: () => Promise.resolve({ error: null }),
            signUp: () => Promise.resolve({ data: { user: USER }, error: null })
        }
    };

    window.supabase = { createClient: () => client };
    return { state, USER };
})();
