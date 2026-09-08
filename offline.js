/* =====================================================================
   Offline writes — an outbox in IndexedDB

   The service worker lets the app open with no signal, but on its own that
   only gets you a screen you cannot use: every write still failed. The
   moment you most want to add an expense is standing at a counter on bad
   mobile data, so an add that cannot reach Supabase is kept here instead and
   sent when the connection comes back.

   A queued expense shows in Recent Expenses straight away, marked PENDING,
   and counts towards the month's totals and the budget — otherwise adding
   something offline looks like it did nothing.

   Loaded before script.js, which calls into it from createExpense().
   ===================================================================== */

const OUTBOX_DB = 'expense-tracker';
const OUTBOX_STORE = 'outbox';
const OUTBOX_VERSION = 1;

let outboxDbPromise = null;
let outboxFlushing = false;

function openOutboxDb() {
    if (outboxDbPromise) return outboxDbPromise;
    outboxDbPromise = new Promise(function (resolve, reject) {
        if (!window.indexedDB) return reject(new Error('No IndexedDB'));
        const request = window.indexedDB.open(OUTBOX_DB, OUTBOX_VERSION);
        request.onupgradeneeded = function () {
            const db = request.result;
            if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
                db.createObjectStore(OUTBOX_STORE, { keyPath: 'id' });
            }
        };
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error); };
    }).catch(function (error) {
        // Private browsing and some locked-down profiles refuse IndexedDB
        // outright. Offline queueing is then simply unavailable, which is
        // survivable — the add fails the way it always used to.
        outboxDbPromise = null;
        throw error;
    });
    return outboxDbPromise;
}

function outboxTx(mode, fn) {
    return openOutboxDb().then(function (db) {
        return new Promise(function (resolve, reject) {
            const transaction = db.transaction(OUTBOX_STORE, mode);
            const result = fn(transaction.objectStore(OUTBOX_STORE));
            transaction.oncomplete = function () {
                resolve(result && result.result !== undefined ? result.result : result);
            };
            transaction.onerror = function () { reject(transaction.error); };
            transaction.onabort = function () { reject(transaction.error); };
        });
    });
}

/**
 * A failed request, as opposed to a refusal from the server. Only the first
 * kind is worth queueing: a row the database rejected will be rejected again
 * in an hour, and retrying it forever would block everything behind it.
 */
function isOfflineError(error) {
    if (!navigator.onLine) return true;
    const message = String((error && error.message) || error || '').toLowerCase();
    return message.indexOf('failed to fetch') > -1 ||
        message.indexOf('networkerror') > -1 ||
        message.indexOf('network request failed') > -1 ||
        message.indexOf('load failed') > -1 ||
        message.indexOf('err_internet_disconnected') > -1;
}

/** Queue one expense and hand back the row the UI should show meanwhile. */
async function queueExpense(fields, userId) {
    const entry = {
        id: 'pending-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        userId: userId,
        fields: {
            user_id: userId,
            amount: fields.amount,
            date: fields.date,
            type: fields.type,
            note: fields.note,
            billed: !!fields.billed
        },
        queuedAt: new Date().toISOString()
    };
    await outboxTx('readwrite', function (store) { store.put(entry); });
    renderOutboxChip();
    return entry;
}

/** Queued rows shaped like real expense rows, newest first. */
async function pendingExpenses(userId) {
    try {
        const rows = await outboxTx('readonly', function (store) { return store.getAll(); });
        return (rows || [])
            .filter(row => !userId || row.userId === userId)
            .sort((a, b) => (a.queuedAt < b.queuedAt ? 1 : -1))
            .map(row => ({
                id: row.id,
                amount: row.fields.amount,
                date: row.fields.date,
                type: row.fields.type,
                note: row.fields.note,
                billed: row.fields.billed,
                updated_at: row.queuedAt,
                pending: true
            }));
    } catch (error) {
        return [];
    }
}

async function outboxCount(userId) {
    return (await pendingExpenses(userId)).length;
}

async function removeQueued(id) {
    try {
        await outboxTx('readwrite', function (store) { store.delete(id); });
    } catch (error) { /* already gone */ }
}

/**
 * Send what is waiting, oldest first, and stop at the first row that fails
 * for want of a network — so the queue keeps its order and nothing is sent
 * twice. A row the server *refuses* is dropped and reported, because it will
 * never succeed and would otherwise wedge everything behind it.
 */
async function flushOutbox(opts) {
    if (outboxFlushing || !navigator.onLine) return 0;
    if (typeof currentUser === 'undefined' || !currentUser) return 0;

    const rows = (await pendingExpenses(currentUser.id)).slice().reverse();  // oldest first
    if (!rows.length) return 0;

    outboxFlushing = true;
    let sent = 0;
    let dropped = 0;

    try {
        for (const row of rows) {
            let failure = null;
            try {
                const { error } = await supabase.from('expenses').insert([{
                    user_id: currentUser.id,
                    amount: row.amount, date: row.date, type: row.type,
                    note: row.note, billed: row.billed
                }]);
                failure = error;
            } catch (thrown) {
                failure = thrown;
            }

            if (!failure) {
                await removeQueued(row.id);
                sent++;
                continue;
            }
            if (isOfflineError(failure)) break;

            await removeQueued(row.id);
            dropped++;
            showNotification('Could not sync "' + (row.note || 'an expense') + '": ' +
                (failure.message || 'rejected'), 'error', 6000);
        }
    } finally {
        outboxFlushing = false;
    }

    if (sent || dropped) {
        await refreshAfterMutation();
        await checkBudgetWarnings();
    }
    if (sent && (!opts || !opts.quiet)) {
        showNotification(sent === 1
            ? 'Synced the expense saved offline'
            : 'Synced ' + sent + ' expenses saved offline', 'success');
    }

    renderOutboxChip();
    return sent;
}

/** Throw away one queued expense without ever sending it. */
async function discardQueued(id) {
    if (!confirm('Discard this expense? It has not been saved to your account yet.')) return;
    await removeQueued(id);
    if (typeof loadExpenses === 'function') await refreshAfterMutation();
    renderOutboxChip();
    showNotification('Removed from the queue', 'success', 2200);
}

/* ---------------------------------------------------------------------
   The header chip

   Hidden entirely when there is nothing waiting and the connection is fine,
   because a permanent "you are online" badge is noise.
   --------------------------------------------------------------------- */

async function renderOutboxChip() {
    const chip = $('offline-chip');
    if (!chip) return;

    const waiting = (typeof currentUser !== 'undefined' && currentUser)
        ? await outboxCount(currentUser.id) : 0;

    if (!waiting && navigator.onLine) {
        chip.style.display = 'none';
        return;
    }

    chip.style.display = 'inline-flex';
    chip.classList.toggle('is-offline', !navigator.onLine);

    if (!navigator.onLine) {
        chip.textContent = waiting
            ? '⚡ Offline · ' + waiting + ' waiting'
            : '⚡ Offline';
    } else {
        chip.textContent = '⚡ ' + waiting + ' waiting · tap to sync';
    }
}

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // file:// has no service worker scope, and registering from one throws.
    if (window.location.protocol === 'file:') return;
    navigator.serviceWorker.register('sw.js').catch(function (error) {
        console.warn('Service worker did not register:', error);
    });
}

function wireOfflineHandling() {
    const chip = $('offline-chip');
    if (chip) {
        chip.addEventListener('click', function () {
            if (!navigator.onLine) {
                showNotification('Still offline — it will go when you reconnect', 'warning');
                return;
            }
            flushOutbox();
        });
    }

    window.addEventListener('online', function () {
        renderOutboxChip();
        flushOutbox();
    });
    window.addEventListener('offline', function () {
        renderOutboxChip();
        showNotification('Offline. New expenses are saved here and sent when you reconnect.',
            'warning', 4200);
    });

    // Coming back to a backgrounded tab is the other moment a queue drains,
    // and the `online` event does not fire for a connection that recovered
    // while the tab was hidden.
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') flushOutbox({ quiet: true });
    });

    renderOutboxChip();
}
