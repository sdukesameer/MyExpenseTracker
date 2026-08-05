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

    const client = {
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
            getSession: () => Promise.resolve({ data: { session: { user: USER } }, error: null }),
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
