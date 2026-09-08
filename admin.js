/* =====================================================================
   Admin panel

   Ported from SplittyWise's admin console, but built out of this app's own
   pieces — the same modal, the same .btn and .switch and .seg, the same
   colours and dark mode. It is a tab in the app, not a second application.

   Two halves, split by what each one needs:

     • Reads and profile edits go straight to Supabase through the admin_*
       functions in supabase/admin.sql, using the admin's own token. Those
       are security definer and re-check et.is_admin on their first line.

     • Anything touching Supabase's own auth tables — blocking, creating,
       deleting, resetting a password, acting as somebody — needs the
       service_role key, which never reaches a browser. Those go through
       /.netlify/functions/admin.

   Nothing here is reachable without user_profiles.is_admin, and the menu
   item stays hidden until the flag is confirmed against the database.

   Loaded before script.js so MODAL_CLOSERS can name closeAdminModal.
   ===================================================================== */

const ADMIN_FN_URL = '/.netlify/functions/admin';

let isAdminUser = false;
let adminTab = 'people';
let adminUsers = [];
let adminSelectedId = null;
let adminSearchTerm = '';

/**
 * Asked once, after sign-in. The answer decides whether the menu item is
 * even rendered — but it is not the security boundary: every function and
 * every endpoint re-checks the flag, so a user who flips this in the console
 * gets a panel that refuses everything it is asked.
 */
async function refreshAdminFlag() {
    isAdminUser = false;
    show('admin-menu-item', false);
    if (!currentUser) return false;

    try {
        const { data, error } = await supabase
            .from('user_profiles').select('is_admin')
            .eq('user_id', currentUser.id).maybeSingle();
        if (error) throw error;
        isAdminUser = !!(data && data.is_admin);
    } catch (error) {
        // The column does not exist until supabase/admin.sql has been run,
        // which is the normal state for an install that never wanted this.
        isAdminUser = false;
    }

    show('admin-menu-item', isAdminUser, 'flex');
    return isAdminUser;
}

/** Call one of the service_role actions, with the admin's own token. */
async function adminCall(action, payload) {
    const { data } = await supabase.auth.getSession();
    const token = data && data.session ? data.session.access_token : null;
    if (!token) throw new Error('Your session has expired — sign in again.');

    const res = await fetch(ADMIN_FN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify(Object.assign({ action }, payload || {}))
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'That did not work.');
    return body;
}

/** Call one of the SQL functions. */
async function adminRpc(name, args) {
    const { data, error } = await supabase.rpc(name, args || {});
    if (error) throw new Error(error.message);
    return data;
}

/* =====================================================================
   Shell
   ===================================================================== */

function showAdminModal() {
    if (!isAdminUser) {
        showNotification('You are not an administrator.', 'error');
        return;
    }
    openModal('admin-modal');
    adminTab = 'people';
    adminSelectedId = null;
    renderAdminTabs();
    loadAdminTab();
}

function closeAdminModal() {
    closeModal('admin-modal');
    adminSelectedId = null;
    $('admin-body').innerHTML = '';
}

function switchAdminTab(tab) {
    adminTab = tab;
    adminSelectedId = null;
    renderAdminTabs();
    loadAdminTab();
}

function renderAdminTabs() {
    document.querySelectorAll('#admin-tabs .seg').forEach(button => {
        button.classList.toggle('active', button.getAttribute('data-admin-tab') === adminTab);
    });
}

function adminBusy(message) {
    $('admin-body').innerHTML =
        '<div class="admin-empty"><div class="skeleton-row"></div>' +
        '<p>' + esc(message || 'Loading…') + '</p></div>';
}

// The three ways this fails on a fresh install all look alike from here, and
// each has a different fix, so say which one it is rather than echoing the
// database's wording and leaving somebody to guess.
function adminFailed(error) {
    const message = String((error && error.message) || error);
    let hint = '';

    if (/schema cache|does not exist|42883/i.test(message)) {
        hint = 'The admin functions are not in the database yet. Apply ' +
               'supabase/admin.sql in the Supabase SQL editor.';
    } else if (/not an administrator/i.test(message)) {
        hint = 'The migration is applied but this account does not have the ' +
               'flag. In the SQL editor: select public.grant_admin(\'' +
               ((currentUser && currentUser.email) || 'you@example.com') + '\');';
    } else if (/failed to fetch|networkerror|load failed/i.test(message)) {
        hint = 'Could not reach the database. If this app talks to Supabase ' +
               'through a proxy, check that it forwards /rest/v1/rpc/.';
    }

    $('admin-body').innerHTML =
        '<div class="admin-empty"><div class="empty-state-icon">🛠️</div>' +
        '<p>' + esc(message) + '</p>' +
        (hint ? '<p class="setting-desc">' + esc(hint) + '</p>' : '') +
        '</div>';
}

async function loadAdminTab() {
    try {
        if (adminTab === 'people') await renderAdminPeople();
        else if (adminTab === 'access') await renderAdminAccess();
        else await renderAdminAudit();
    } catch (error) {
        adminFailed(error);
    }
}

function adminDate(value) {
    if (!value) return '—';
    const iso = String(value).slice(0, 10);
    return splitISO(iso) ? formatDate(iso) : '—';
}

/* =====================================================================
   People
   ===================================================================== */

async function renderAdminPeople() {
    adminBusy('Loading people…');

    const [stats, users] = await Promise.all([
        adminRpc('admin_stats'),
        adminRpc('admin_users', { p_search: adminSearchTerm, p_limit: 200 })
    ]);
    adminUsers = users || [];

    $('admin-body').innerHTML =
        '<div class="admin-stats">' +
            adminStatCard('People', stats.users, stats.admins + ' admin' + (stats.admins === 1 ? '' : 's')) +
            adminStatCard('Expenses', stats.expenses, moneyShort(stats.spend) + ' all time') +
            adminStatCard('Last 30 days', stats.expenses_30d,
                stats.new_users_30d + ' new ' + (stats.new_users_30d === 1 ? 'person' : 'people')) +
            adminStatCard('Blocked', stats.banned,
                stats.invite_only ? 'invite only' : (stats.signups_enabled ? 'signups open' : 'signups closed')) +
        '</div>' +
        '<div class="search-field admin-search">' +
            '<svg class="icon search-field-icon"><use href="#i-search" /></svg>' +
            '<input type="text" id="admin-search" placeholder="Search by name or email…" ' +
                   'autocomplete="off" value="' + attr(adminSearchTerm) + '">' +
        '</div>' +
        '<div class="admin-list" id="admin-user-list">' + adminUserRows() + '</div>' +
        '<div id="admin-detail"></div>';

    const search = $('admin-search');
    search.addEventListener('input', debounce(async function () {
        adminSearchTerm = search.value.trim();
        try {
            adminUsers = await adminRpc('admin_users',
                { p_search: adminSearchTerm, p_limit: 200 }) || [];
            $('admin-user-list').innerHTML = adminUserRows();
        } catch (error) {
            showNotification(error.message, 'error');
        }
    }, 250));

    if (adminSelectedId) await openAdminUser(adminSelectedId);
}

function adminStatCard(label, value, sub) {
    return '<div class="admin-stat">' +
        '<div class="admin-stat-label">' + esc(label) + '</div>' +
        '<div class="admin-stat-value">' + esc(String(value)) + '</div>' +
        '<div class="admin-stat-sub">' + esc(sub) + '</div></div>';
}

function adminUserRows() {
    if (!adminUsers.length) {
        return '<div class="admin-empty"><p>Nobody matches that.</p></div>';
    }
    return adminUsers.map(user => {
        const name = user.full_name || (user.email || '').split('@')[0] || 'Someone';
        return '<button type="button" class="admin-row' +
                 (String(user.user_id) === String(adminSelectedId) ? ' is-open' : '') + '" ' +
                 'onclick="openAdminUser(\'' + attr(user.user_id) + '\')">' +
            '<span class="admin-row-main">' +
                '<span class="admin-row-name">' + esc(name) +
                    (user.is_admin ? '<span class="admin-tag is-admin">ADMIN</span>' : '') +
                    (user.banned ? '<span class="admin-tag is-banned">BLOCKED</span>' : '') +
                '</span>' +
                '<span class="admin-row-sub">' + esc(user.email || 'no address') + '</span>' +
            '</span>' +
            '<span class="admin-row-figures">' +
                '<span class="admin-row-amount">' + esc(moneyShort(user.spend || 0)) + '</span>' +
                '<span class="admin-row-sub">' + user.expenses + ' expense' +
                    (Number(user.expenses) === 1 ? '' : 's') + '</span>' +
            '</span>' +
        '</button>';
    }).join('');
}

/* ---- one person, and their log ---- */

async function openAdminUser(userId) {
    adminSelectedId = String(userId);
    document.querySelectorAll('#admin-user-list .admin-row').forEach(row => {
        row.classList.toggle('is-open',
            row.getAttribute('onclick').indexOf("'" + adminSelectedId + "'") > -1);
    });

    // Only the People tab renders a detail host. Being called without one —
    // from a stale onclick after a tab switch, or when the list failed to
    // load at all — must not throw.
    const host = $('admin-detail');
    if (!host) return;
    host.innerHTML = '<div class="admin-empty"><div class="skeleton-row"></div></div>';

    let detail;
    try {
        detail = await adminRpc('admin_user_detail', { p_user: userId, p_limit: 100 });
    } catch (error) {
        host.innerHTML = '<div class="admin-empty"><p>' + esc(error.message) + '</p></div>';
        return;
    }

    const profile = detail.profile || {};
    const totals = detail.totals || {};
    const email = profile.email || '';
    const isSelf = currentUser && String(profile.user_id) === String(currentUser.id);
    const listed = adminUsers.find(u => String(u.user_id) === String(userId)) || {};

    host.innerHTML =
        '<div class="admin-detail">' +
            '<div class="admin-detail-head">' +
                '<div>' +
                    '<h4>' + esc(profile.full_name || 'Someone') + '</h4>' +
                    '<p class="setting-desc">' + esc(email) +
                        ' · joined ' + esc(adminDate(profile.created_at)) + '</p>' +
                '</div>' +
                '<button type="button" class="icon-btn tone-indigo" title="Close"' +
                    ' aria-label="Close this person" onclick="closeAdminUser()">' +
                    '<svg class="icon"><use href="#i-close" /></svg></button>' +
            '</div>' +

            '<div class="admin-stats admin-stats-tight">' +
                adminStatCard('Spend', moneyShort(totals.spend || 0),
                    (totals.count || 0) + ' expense' + (Number(totals.count) === 1 ? '' : 's')) +
                adminStatCard('Billed', moneyShort(totals.billed || 0),
                    moneyShort(totals.unbilled || 0) + ' unbilled') +
                adminStatCard('Active', adminDate(totals.first),
                    'to ' + adminDate(totals.last)) +
            '</div>' +

            (detail.types && detail.types.length
                ? '<div class="admin-chips">' + detail.types.map(t =>
                    '<span class="admin-chip" style="' + typeStyleAttr(t.name) + '">' +
                    esc(t.name) + ' ' + esc(moneyShort(t.total)) + '</span>').join('') + '</div>'
                : '') +

            '<div class="admin-sub-head">Their expense log' +
                '<span>' + adminLogCaption((detail.expenses || []).length) + '</span></div>' +
            '<div class="admin-log">' + adminExpenseRows(detail.expenses || []) + '</div>' +

            '<div class="admin-sub-head">Actions</div>' +
            '<div class="admin-actions">' +
                (isSelf
                    ? '<span class="setting-desc">This is your own account. Blocking, ' +
                      'deleting and acting as yourself are all refused.</span>'
                    : [
                        adminActionButton('btn-secondary',
                            profile.is_admin ? 'Remove admin' : 'Make admin',
                            "adminToggleAdmin('" + attr(userId) + "', " + (!profile.is_admin) + ")"),
                        adminActionButton('btn-secondary', 'Sign in as them',
                            "adminActAs('" + attr(email) + "')"),
                        adminActionButton('btn-secondary', 'Password reset link',
                            "adminResetPassword('" + attr(email) + "')"),
                        adminActionButton('btn-secondary', 'Sign out everywhere',
                            "adminSignOutEverywhere('" + attr(email) + "')"),
                        adminActionButton(listed.banned ? 'btn-success' : 'btn-danger',
                            listed.banned ? 'Unblock' : 'Block',
                            listed.banned
                                ? "adminUnban('" + attr(email) + "')"
                                : "adminBan('" + attr(email) + "')"),
                        adminActionButton('btn-danger', 'Delete account',
                            "adminDeleteUser('" + attr(email) + "')")
                    ].join('')) +
            '</div>' +
        '</div>';

    host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// The log is capped at 100 rows, so the caption has to say whether you are
// looking at all of somebody's spending or the top of it.
function adminLogCaption(count) {
    if (!count) return 'nothing yet';
    if (count === 1) return '1 entry';
    return count >= 100 ? '100 most recent' : count + ' entries';
}

function adminActionButton(tone, label, call) {
    return '<button type="button" class="btn btn-small ' + tone + '" onclick="' +
        attr(call) + '">' + esc(label) + '</button>';
}

function closeAdminUser() {
    adminSelectedId = null;
    $('admin-detail').innerHTML = '';
    document.querySelectorAll('#admin-user-list .admin-row')
        .forEach(row => row.classList.remove('is-open'));
}

function adminExpenseRows(rows) {
    if (!rows.length) return '<div class="admin-empty"><p>Nothing logged yet.</p></div>';
    return rows.map(row =>
        '<div class="admin-log-row">' +
            '<span class="admin-log-amount">' + esc(money(row.amount)) + '</span>' +
            '<span class="admin-log-note">' + (esc(row.note) || 'No description') + '</span>' +
            '<span class="expense-type" style="' + typeStyleAttr(row.type) + '">' +
                esc(row.type) + '</span>' +
            '<span class="admin-log-date">' + esc(formatDate(row.date)) + '</span>' +
        '</div>').join('');
}

/* ---- the actions themselves ---- */

async function adminAfterChange(message) {
    if (message) showNotification(message, 'success', 5000);
    await renderAdminPeople();
}

async function adminToggleAdmin(userId, makeAdmin) {
    const label = makeAdmin ? 'Give this account admin rights?' : 'Remove admin rights?';
    if (!confirm(label)) return;
    try {
        await adminRpc('admin_set_profile', { p_user: userId, p_is_admin: makeAdmin });
        await adminAfterChange(makeAdmin ? 'They are an admin now' : 'Admin rights removed');
    } catch (error) {
        showNotification(error.message, 'error', 6000);
    }
}

async function adminBan(email) {
    const reason = prompt('Block ' + email + '?\n\nThey are signed out everywhere, cannot ' +
        'sign in, and cannot register again with this address.\n\nReason (optional):');
    if (reason === null) return;
    try {
        const res = await adminCall('ban', { email, reason });
        await adminAfterChange(res.message);
    } catch (error) {
        showNotification(error.message, 'error', 6000);
    }
}

async function adminUnban(email) {
    if (!confirm('Unblock ' + email + '? They will be able to sign in again.')) return;
    try {
        const res = await adminCall('unban', { email });
        await adminAfterChange(res.message);
    } catch (error) {
        showNotification(error.message, 'error', 6000);
    }
}

async function adminSignOutEverywhere(email) {
    if (!confirm('Sign ' + email + ' out on every device?')) return;
    try {
        const res = await adminCall('sign-out-everywhere', { email });
        showNotification(res.message, 'success');
    } catch (error) {
        showNotification(error.message, 'error', 6000);
    }
}

async function adminResetPassword(email) {
    try {
        const res = await adminCall('reset-password', { email });
        adminShowLink('Password reset link for ' + email, res.link,
            'Single use, and it expires. Send it to them yourself — it is not emailed.');
    } catch (error) {
        showNotification(error.message, 'error', 6000);
    }
}

async function adminActAs(email) {
    if (!confirm('Sign in as ' + email + '?\n\nOpening the link replaces YOUR session in ' +
        'this browser with theirs. You will be them until you sign out. It is recorded.')) return;
    try {
        const res = await adminCall('act-as', { email });
        adminShowLink('Sign in as ' + email, res.link,
            'Opening this replaces your own session in whichever browser opens it. ' +
            'Single use, and it is in the audit log.');
    } catch (error) {
        showNotification(error.message, 'error', 6000);
    }
}

async function adminDeleteUser(email) {
    if (!confirm('Delete ' + email + '?\n\nEvery expense, type and budget of theirs goes ' +
        'with it. This cannot be undone.')) return;
    if (prompt('Type the address to confirm:') !== email) {
        showNotification('Not deleted — the address did not match', 'warning');
        return;
    }
    try {
        const res = await adminCall('delete-user', { email });
        adminSelectedId = null;
        await adminAfterChange(res.message);
    } catch (error) {
        showNotification(error.message, 'error', 6000);
    }
}

/**
 * A single-use link is useless as a toast — it has to be readable, copyable
 * and openable — so it gets its own small panel above the list.
 */
function adminShowLink(title, link, blurb) {
    const host = $('admin-detail');
    host.insertAdjacentHTML('afterbegin',
        '<div class="admin-link-panel" id="admin-link-panel">' +
            '<div class="admin-sub-head">' + esc(title) +
                '<button type="button" class="btn-textish" ' +
                'onclick="adminDismissLink()">Dismiss</button>' +
            '</div>' +
            '<p class="setting-desc">' + esc(blurb) + '</p>' +
            '<input class="admin-link-input" id="admin-link-value" readonly value="' +
                attr(link) + '">' +
            '<div class="admin-actions">' +
                '<button type="button" class="btn btn-small" onclick="adminCopyLink()">Copy link</button>' +
                '<a class="btn btn-small btn-secondary" href="' + attr(link) +
                    '" target="_blank" rel="noopener">Open it</a>' +
            '</div>' +
        '</div>');
    $('admin-link-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function adminDismissLink() {
    const panel = $('admin-link-panel');
    if (panel) panel.remove();
}

function adminCopyLink() {
    const field = $('admin-link-value');
    field.select();
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(field.value)
            .then(() => showNotification('Link copied', 'success', 2000))
            .catch(() => showNotification('Copy it from the box', 'warning'));
    } else {
        showNotification('Copy it from the box', 'warning');
    }
}

/* =====================================================================
   Access — who may sign up at all
   ===================================================================== */

async function renderAdminAccess() {
    adminBusy('Loading access rules…');
    const [stats, lists] = await Promise.all([
        adminRpc('admin_stats'), adminRpc('admin_lists')
    ]);

    $('admin-body').innerHTML =
        '<div class="setting-row">' +
            '<div class="setting-copy">' +
                '<div class="setting-title">Allow new accounts</div>' +
                '<p class="setting-desc">Off, and nobody can register at all. Existing ' +
                    'accounts are unaffected, and you can still create one below.</p>' +
            '</div>' +
            '<button type="button" class="switch' + (stats.signups_enabled ? ' on' : '') + '" ' +
                'id="admin-signups-switch" role="switch" aria-checked="' +
                (stats.signups_enabled ? 'true' : 'false') + '" ' +
                'aria-label="Allow new accounts" ' +
                'onclick="adminToggleSetting(\'signups_enabled\')"></button>' +
        '</div>' +

        '<div class="setting-row">' +
            '<div class="setting-copy">' +
                '<div class="setting-title">Invite only</div>' +
                '<p class="setting-desc">On, and only the addresses on the allow list below ' +
                    'may register. Anyone you create or invite is added automatically.</p>' +
            '</div>' +
            '<button type="button" class="switch' + (stats.invite_only ? ' on' : '') + '" ' +
                'id="admin-invite-switch" role="switch" aria-checked="' +
                (stats.invite_only ? 'true' : 'false') + '" ' +
                'aria-label="Invite only" ' +
                'onclick="adminToggleSetting(\'invite_only\')"></button>' +
        '</div>' +

        '<div class="admin-sub-head">Add somebody</div>' +
        '<div class="admin-form-row">' +
            '<input type="email" id="admin-new-email" placeholder="them@example.com" ' +
                   'autocomplete="off" inputmode="email">' +
            '<input type="text" id="admin-new-name" placeholder="Name (optional)" autocomplete="off">' +
        '</div>' +
        '<div class="admin-form-row">' +
            '<input type="password" id="admin-new-password" ' +
                   'placeholder="Password, 8+ characters" autocomplete="new-password">' +
            '<div class="admin-actions">' +
                '<button type="button" class="btn btn-small" onclick="adminCreateUser()">' +
                    'Create account</button>' +
                '<button type="button" class="btn btn-small btn-secondary" onclick="adminInviteUser()">' +
                    'Email an invite</button>' +
                '<button type="button" class="btn btn-small btn-secondary" onclick="adminAllowEmail()">' +
                    'Allow only</button>' +
            '</div>' +
        '</div>' +
        '<p class="setting-desc">Create makes the account outright with the password you ' +
            'type and the address already confirmed. Invite emails them a link — Supabase ' +
            'caps that sharply on the free tier. Allow only adds them to the list without ' +
            'creating anything.</p>' +

        '<div class="admin-sub-head">Blocked' +
            '<span>' + lists.banned.length + '</span></div>' +
        '<div class="admin-list">' + adminBannedRows(lists.banned) + '</div>' +

        '<div class="admin-sub-head">Allow list' +
            '<span>' + lists.allowed.length + '</span></div>' +
        '<div class="admin-list">' + adminAllowedRows(lists.allowed) + '</div>' +
        '<div id="admin-detail"></div>';
}

function adminBannedRows(rows) {
    if (!rows.length) return '<div class="admin-empty"><p>Nobody is blocked.</p></div>';
    return rows.map(row =>
        '<div class="admin-row is-static">' +
            '<span class="admin-row-main">' +
                '<span class="admin-row-name">' + esc(row.email) +
                    (row.has_account ? '' : '<span class="admin-tag">NO ACCOUNT</span>') + '</span>' +
                '<span class="admin-row-sub">' + esc(row.reason || 'no reason given') +
                    ' · ' + esc(adminDate(row.at)) + '</span>' +
            '</span>' +
            '<button type="button" class="btn btn-small btn-secondary" onclick="adminUnbanFromList(\'' +
                attr(row.email) + '\')">Unblock</button>' +
        '</div>').join('');
}

function adminAllowedRows(rows) {
    if (!rows.length) {
        return '<div class="admin-empty"><p>Empty. With invite only on, that means ' +
            'nobody new can register.</p></div>';
    }
    return rows.map(row =>
        '<div class="admin-row is-static">' +
            '<span class="admin-row-main">' +
                '<span class="admin-row-name">' + esc(row.email) +
                    (row.signed_up ? '<span class="admin-tag is-admin">SIGNED UP</span>' : '') + '</span>' +
                '<span class="admin-row-sub">' + esc(row.note || 'no note') +
                    ' · ' + esc(adminDate(row.at)) + '</span>' +
            '</span>' +
            '<button type="button" class="btn btn-small btn-secondary" onclick="adminRemoveAllowed(\'' +
                attr(row.email) + '\')">Remove</button>' +
        '</div>').join('');
}

async function adminToggleSetting(key) {
    const button = $(key === 'invite_only' ? 'admin-invite-switch' : 'admin-signups-switch');
    const next = !button.classList.contains('on');
    try {
        await adminRpc('admin_set_setting', { p_key: key, p_enabled: next });
        button.classList.toggle('on', next);
        button.setAttribute('aria-checked', String(next));
        showNotification('Saved', 'success', 1800);
    } catch (error) {
        showNotification(error.message, 'error', 6000);
    }
}

function adminNewEmail() {
    const value = ($('admin-new-email').value || '').trim().toLowerCase();
    if (!value) {
        showNotification('Type an email address first', 'error');
        return null;
    }
    return value;
}

async function adminCreateUser() {
    const email = adminNewEmail();
    if (!email) return;
    const password = $('admin-new-password').value;
    if (password.length < 8) {
        showNotification('Give them a password of at least 8 characters', 'error');
        return;
    }
    try {
        const res = await adminCall('create-user',
            { email, password, full_name: $('admin-new-name').value.trim() });
        showNotification(res.message, 'success', 5000);
        await renderAdminAccess();
    } catch (error) {
        showNotification(error.message, 'error', 6000);
    }
}

async function adminInviteUser() {
    const email = adminNewEmail();
    if (!email) return;
    try {
        const res = await adminCall('invite-user', { email });
        showNotification(res.message, 'success', 5000);
        await renderAdminAccess();
    } catch (error) {
        showNotification(error.message, 'error', 6000);
    }
}

async function adminAllowEmail() {
    const email = adminNewEmail();
    if (!email) return;
    try {
        await adminRpc('admin_allow_email',
            { p_email: email, p_note: $('admin-new-name').value.trim() || null });
        showNotification('Added to the allow list', 'success');
        await renderAdminAccess();
    } catch (error) {
        showNotification(error.message, 'error', 6000);
    }
}

async function adminRemoveAllowed(email) {
    if (!confirm('Remove ' + email + ' from the allow list?')) return;
    try {
        await adminRpc('admin_disallow_email', { p_email: email });
        await renderAdminAccess();
    } catch (error) {
        showNotification(error.message, 'error', 6000);
    }
}

async function adminUnbanFromList(email) {
    if (!confirm('Unblock ' + email + '?')) return;
    try {
        const res = await adminCall('unban', { email });
        showNotification(res.message, 'success');
        await renderAdminAccess();
    } catch (error) {
        showNotification(error.message, 'error', 6000);
    }
}

/* =====================================================================
   Audit — what has been done, and by whom
   ===================================================================== */

const ADMIN_ACTION_LABELS = {
    banned: 'blocked', unbanned: 'unblocked', user_created: 'created',
    user_invited: 'invited', user_deleted: 'deleted',
    password_reset_link: 'made a reset link for', sessions_revoked: 'signed out',
    acted_as: 'signed in as', profile_edited: 'edited', setting_changed: 'changed a setting',
    email_allowed: 'allowed', email_disallowed: 'removed from the allow list'
};

async function renderAdminAudit() {
    adminBusy('Loading the audit log…');
    const rows = await adminRpc('admin_audit_log', { p_limit: 300 }) || [];

    if (!rows.length) {
        $('admin-body').innerHTML =
            '<div class="admin-empty"><div class="empty-state-icon">📋</div>' +
            '<p>Nothing has been done yet. Every admin action lands here, ' +
               'append-only.</p></div>';
        return;
    }

    $('admin-body').innerHTML =
        '<p class="setting-desc">Append-only, newest first. Signing in as somebody is ' +
            'recorded here whether or not the link is ever opened.</p>' +
        '<div class="admin-list">' + rows.map(row => {
            const what = ADMIN_ACTION_LABELS[row.action] || row.action;
            const detail = row.detail && Object.keys(row.detail).length
                ? Object.keys(row.detail)
                    .filter(k => row.detail[k] !== null && row.detail[k] !== undefined)
                    .map(k => k + ': ' + row.detail[k]).join(' · ')
                : '';
            return '<div class="admin-row is-static">' +
                '<span class="admin-row-main">' +
                    '<span class="admin-row-name">' + esc(row.actor_email || 'someone') +
                        ' <span class="admin-verb">' + esc(what) + '</span> ' +
                        esc(row.target_email || '') + '</span>' +
                    (detail ? '<span class="admin-row-sub">' + esc(detail) + '</span>' : '') +
                '</span>' +
                '<span class="admin-row-sub">' + esc(adminDate(row.at)) + '</span>' +
            '</div>';
        }).join('') + '</div>';
}
