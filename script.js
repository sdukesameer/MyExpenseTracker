/* =====================================================================
   Expense Tracker
   ---------------------------------------------------------------------
   Vanilla JS + Supabase. No build step: this file is served as-is.
   ===================================================================== */

'use strict';

/* ---------------------------------------------------------------------
   Config
   --------------------------------------------------------------------- */

// Both values live in config.js, which is regenerated from Netlify's
// environment at deploy time. The fallbacks keep `npm run dev` and the test
// harness working with no build step — see config.js for what may live there.
const APP_CONFIG = window.APP_CONFIG || {};

// The project itself. The browser normally goes through the proxy below, but
// this is the address the proxy forwards to and the one the Netlify functions
// talk to directly.
const DIRECT_SUPABASE_URL = APP_CONFIG.SUPABASE_URL || '';

// A Cloudflare Worker in front of Supabase, because some Indian ISPs will not
// route to *.supabase.co reliably. Blank falls back to talking to Supabase
// directly rather than to an empty origin.
const PROXY_URL = APP_CONFIG.SUPABASE_PROXY_URL || '';

const supabaseUrl = PROXY_URL || DIRECT_SUPABASE_URL;
const supabaseKey = APP_CONFIG.SUPABASE_ANON_KEY || '';

// All dates in this app are "calendar dates in India", independent of the
// device clock's timezone. See the date helpers below.
const APP_TIMEZONE = 'Asia/Kolkata';

const MAX_AMOUNT = 1000000;
const MAX_NOTE_LENGTH = 500;

/* ---------------------------------------------------------------------
   Global state
   --------------------------------------------------------------------- */

let supabase = null;
let currentUser = null;
let currentChart = null;
let currentChartType = 'line';
let filteredExpenses = [];
let allExpensesCache = [];
let isPasswordResetFlow = false;
let monthlyBilledBudget = 0;
let monthlyUnbilledBudget = 0;
let editedExpenses = new Set();
let expenseEdits = {};
let lastDeletedExpense = null;
let isDarkMode = localStorage.getItem('darkMode') === 'true';

/* Budget alert levels. Each fires at most one toast per calendar month,
   the first time spending crosses it. Scope is total / billed / unbilled;
   the last two are ignored while billing tracking is off. */
const DEFAULT_ALERT_RULES = [
    { scope: 'total', percent: 90 },
    { scope: 'total', percent: 100 },
    { scope: 'billed', percent: 100 },
    { scope: 'unbilled', percent: 100 }
];
const MAX_ALERT_RULES = 12;

const DEFAULT_SETTINGS = {
    trackBilling: true,     // show/hide the whole billed-vs-unbilled concept
    defaultBilled: false,   // pre-select "Billed" on the add form
    budgetAlerts: true,
    alertRules: DEFAULT_ALERT_RULES
};
let settings = { ...DEFAULT_SETTINGS };

/* Alert levels already fired this month, persisted so a page reload
   doesn't replay every toast. */
let firedAlerts = new Set();

/* ---------------------------------------------------------------------
   Bootstrap the Supabase client
   --------------------------------------------------------------------- */

function fatalError(message) {
    document.body.classList.add('loaded');
    const spinner = document.getElementById('loading-spinner');
    if (spinner) spinner.style.display = 'none';
    const container = document.querySelector('.container');
    if (container) {
        container.innerHTML =
            '<div class="empty-state"><div class="empty-state-icon">⚠️</div>' +
            '<h3 class="card-title" style="margin-bottom:.5rem">Something went wrong</h3>' +
            '<p>' + esc(message) + '</p></div>';
    }
}

try {
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
        throw new Error('The Supabase library failed to load.');
    }
    supabase = window.supabase.createClient(supabaseUrl, supabaseKey);
} catch (error) {
    console.error('Supabase init failed:', error);
    document.addEventListener('DOMContentLoaded', function () {
        fatalError('Could not reach the server. Check your connection and reload the page.');
    });
}

/* =====================================================================
   Escaping & formatting helpers
   ===================================================================== */

/** Escape for use as HTML text content. */
function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/** Escape for use inside a double-quoted HTML attribute. */
function attr(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Kept as aliases: older call sites (and any external snippets) use these names.
const sanitizeHTML = esc;
const escapeHtml = esc;

let _inrFormatter = null;
function inrFormatter() {
    if (!_inrFormatter) {
        try {
            _inrFormatter = new Intl.NumberFormat('en-IN', {
                style: 'currency', currency: 'INR',
                minimumFractionDigits: 2, maximumFractionDigits: 2
            });
        } catch (error) {
            _inrFormatter = { format: n => '₹' + Number(n).toFixed(2) };
        }
    }
    return _inrFormatter;
}

/** ₹1,23,456.00 — Indian digit grouping. */
function money(value) {
    const n = Number(value);
    if (!isFinite(n)) return '₹0.00';
    return inrFormatter().format(n);
}

/** ₹1,23,456 — same grouping, no paise. Used for big display numbers. */
function moneyShort(value) {
    const n = Number(value);
    if (!isFinite(n)) return '₹0';
    try {
        return new Intl.NumberFormat('en-IN', {
            style: 'currency', currency: 'INR', maximumFractionDigits: 0
        }).format(n);
    } catch (error) {
        return '₹' + Math.round(n);
    }
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

/* =====================================================================
   Dates
   ---------------------------------------------------------------------
   Expense dates are stored as plain DATE ('YYYY-MM-DD') in Postgres, so
   every calculation here works on date *strings* anchored to
   APP_TIMEZONE. Never build a Date from a stored date and read local
   getters off it — that silently shifts the day for anyone whose device
   is not on IST, and double-shifts for anyone who is.
   ===================================================================== */

let _tzParts = null;
function tzPartsFormatter() {
    if (_tzParts === null) {
        try {
            _tzParts = new Intl.DateTimeFormat('en-GB', {
                timeZone: APP_TIMEZONE,
                year: 'numeric', month: '2-digit', day: '2-digit'
            });
            // Confirm the engine actually honours the timeZone option.
            _tzParts.formatToParts(new Date());
        } catch (error) {
            _tzParts = false;
        }
    }
    return _tzParts;
}

/** The calendar date in APP_TIMEZONE for an instant, as 'YYYY-MM-DD'. */
function toAppDateISO(date) {
    const when = date instanceof Date ? date : new Date();
    const formatter = tzPartsFormatter();
    if (formatter) {
        const parts = formatter.formatToParts(when);
        const pick = type => (parts.find(p => p.type === type) || {}).value;
        const year = pick('year'), month = pick('month'), day = pick('day');
        if (year && month && day) return `${year}-${month}-${day}`;
    }
    // Fallback for engines without full Intl: fixed +05:30 offset.
    return new Date(when.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Today in APP_TIMEZONE, as 'YYYY-MM-DD'. */
function todayISO() {
    return toAppDateISO(new Date());
}

/** Split 'YYYY-MM-DD' into numbers. Returns null for anything malformed. */
function splitISO(iso) {
    if (typeof iso !== 'string') return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!match) return null;
    return { year: +match[1], month: +match[2], day: +match[3] };
}

/** { year, month, day } for today in APP_TIMEZONE. month is 1-12. */
function todayParts() {
    return splitISO(todayISO());
}

function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Inclusive first/last date strings of a month. */
function monthBounds(year, month) {
    return {
        first: `${year}-${pad2(month)}-01`,
        last: `${year}-${pad2(month)}-${pad2(daysInMonth(year, month))}`
    };
}

function previousMonth(year, month) {
    return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

/** Shift a 'YYYY-MM-DD' string by whole days, staying on the calendar. */
function addDaysISO(iso, days) {
    const parts = splitISO(iso);
    if (!parts) return iso;
    const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
    return shifted.toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' -> Date at *local* midnight. Display only, never storage. */
function isoToDisplayDate(iso) {
    const parts = splitISO(iso);
    if (!parts) return new Date(NaN);
    return new Date(parts.year, parts.month - 1, parts.day);
}

/** '2026-08-05' -> '5 Aug 2026' */
function formatDate(iso) {
    const parts = splitISO(iso);
    if (!parts) return String(iso || '');
    const date = isoToDisplayDate(iso);
    try {
        return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch (error) {
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return `${parts.day} ${months[parts.month - 1]} ${parts.year}`;
    }
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

function monthLabel(year, month, short) {
    const name = MONTH_NAMES[month - 1] || '';
    return (short ? name.slice(0, 3) : name) + ' ' + year;
}

function getCurrentMonthName() {
    return MONTH_NAMES[todayParts().month - 1];
}

/** True when an ISO date string falls inside [first, last] inclusive. */
function withinRange(iso, first, last) {
    return typeof iso === 'string' && iso >= first && iso <= last;
}

/* =====================================================================
   Settings (per user; DB-backed when the column exists, else local)
   ===================================================================== */

function settingsStorageKey() {
    return 'et:settings:' + (currentUser ? currentUser.id : 'anon');
}

function readLocalSettings() {
    try {
        const raw = localStorage.getItem(settingsStorageKey());
        return raw ? JSON.parse(raw) : {};
    } catch (error) {
        return {};
    }
}

function writeLocalSettings(next) {
    try {
        localStorage.setItem(settingsStorageKey(), JSON.stringify(next));
    } catch (error) {
        /* Private browsing on iOS can reject writes — not fatal. */
    }
}

async function loadSettings() {
    settings = { ...DEFAULT_SETTINGS, ...readLocalSettings() };
    if (!currentUser) return;
    try {
        const { data, error } = await supabase
            .from('user_profiles')
            .select('settings')
            .eq('user_id', currentUser.id)
            .maybeSingle();
        if (!error && data && data.settings && typeof data.settings === 'object') {
            settings = { ...settings, ...data.settings };
            writeLocalSettings(settings);
        }
    } catch (error) {
        // The `settings` column is optional; local storage is the fallback.
    }
}

async function saveSettings(patch) {
    settings = { ...settings, ...patch };
    writeLocalSettings(settings);
    if (!currentUser) return;
    try {
        await supabase
            .from('user_profiles')
            .upsert([{ user_id: currentUser.id, settings }], { onConflict: 'user_id' });
    } catch (error) {
        // Optional column missing — the local copy still applies.
    }
}

const trackingBilling = () => settings.trackBilling !== false;

/* ---------------------------------------------------------------------
   Budget alert levels
   --------------------------------------------------------------------- */

function alertRules() {
    const rules = Array.isArray(settings.alertRules) ? settings.alertRules : DEFAULT_ALERT_RULES;
    return rules
        .filter(rule => rule && ['total', 'billed', 'unbilled'].indexOf(rule.scope) !== -1
            && Number(rule.percent) > 0)
        .map(rule => ({ scope: rule.scope, percent: Math.round(Number(rule.percent)) }))
        .sort((a, b) => a.scope.localeCompare(b.scope) || a.percent - b.percent);
}

function alertRuleKey(rule) {
    return rule.scope + ':' + rule.percent;
}

function firedAlertsStorageKey() {
    const parts = todayParts();
    return 'et:alerts:' + (currentUser ? currentUser.id : 'anon') +
        ':' + parts.year + '-' + pad2(parts.month);
}

function loadFiredAlerts() {
    try {
        const raw = localStorage.getItem(firedAlertsStorageKey());
        firedAlerts = new Set(raw ? JSON.parse(raw) : []);
    } catch (error) {
        firedAlerts = new Set();
    }
}

function saveFiredAlerts() {
    try {
        localStorage.setItem(firedAlertsStorageKey(), JSON.stringify(Array.from(firedAlerts)));
    } catch (error) {
        /* Private browsing — alerts just replay after a reload. */
    }
}

/** Called when the budget or the levels change: everything is re-armed. */
function resetFiredAlerts() {
    firedAlerts = new Set();
    saveFiredAlerts();
}

/* =====================================================================
   Small DOM helpers
   ===================================================================== */

function $(id) {
    return document.getElementById(id);
}

function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
}

function show(el, visible, displayValue) {
    const node = typeof el === 'string' ? $(el) : el;
    if (node) node.style.display = visible ? (displayValue || '') : 'none';
}

function debounce(fn, delay) {
    let timer;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
}

/* =====================================================================
   Theme
   ===================================================================== */

function applyTheme() {
    document.body.classList.toggle('dark-mode', isDarkMode);
    const icon = $('theme-icon');
    if (icon) {
        const use = icon.querySelector('use');
        if (use) use.setAttribute('href', isDarkMode ? '#i-sun' : '#i-moon');
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', isDarkMode ? '#0d0f16' : '#eef0f8');
    refreshChartTheme();
}

function toggleTheme() {
    isDarkMode = !isDarkMode;
    localStorage.setItem('darkMode', String(isDarkMode));
    applyTheme();
}

/* =====================================================================
   Notifications
   ===================================================================== */

function showNotification(message, type = 'info', duration = 3200, action = null) {
    const container = $('notification-container');
    if (!container) return;

    const notification = document.createElement('div');
    notification.className = 'notification ' + type;

    const text = document.createElement('span');
    text.className = 'notification-text';
    text.textContent = message;
    notification.appendChild(text);

    let dismissTimer = null;
    const dismiss = () => {
        clearTimeout(dismissTimer);
        notification.classList.remove('show');
        setTimeout(() => notification.remove(), 320);
    };

    if (action && action.label && typeof action.onClick === 'function') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'notification-action';
        button.textContent = action.label;
        button.addEventListener('click', () => {
            dismiss();
            action.onClick();
        });
        notification.appendChild(button);
    }

    container.appendChild(notification);
    requestAnimationFrame(() => notification.classList.add('show'));
    dismissTimer = setTimeout(dismiss, duration);
}

function showAlert(containerId, message, type) {
    const container = $(containerId);
    if (!container) return;
    container.innerHTML = '<div class="alert alert-' + attr(type) + '">' + esc(message) + '</div>';
    clearTimeout(container._alertTimer);
    container._alertTimer = setTimeout(() => { container.innerHTML = ''; }, 6000);
}

/* =====================================================================
   Modals
   ===================================================================== */

const openModals = [];
let savedScrollY = 0;

function lockBodyScroll() {
    if (document.body.classList.contains('modal-open')) return;
    savedScrollY = window.scrollY || window.pageYOffset || 0;
    document.body.style.top = -savedScrollY + 'px';
    document.body.classList.add('modal-open');
}

function unlockBodyScroll() {
    if (!document.body.classList.contains('modal-open')) return;
    document.body.classList.remove('modal-open');
    document.body.style.top = '';
    window.scrollTo(0, savedScrollY);
}

function openModal(id) {
    const modal = $(id);
    if (!modal) return;
    modal.classList.add('open');
    modal.style.display = 'flex';
    if (openModals.indexOf(id) === -1) openModals.push(id);
    lockBodyScroll();
}

function closeModal(id) {
    const modal = $(id);
    if (!modal) return;
    modal.classList.remove('open');
    modal.style.display = 'none';
    const index = openModals.indexOf(id);
    if (index !== -1) openModals.splice(index, 1);
    if (openModals.length === 0) unlockBodyScroll();
}

const MODAL_CLOSERS = {
    'add-type-modal': closeAddTypeModal,
    'edit-type-modal': closeEditTypeModal,
    'delete-type-modal': closeDeleteTypeModal,
    'budget-modal': closeBudgetModal,
    'edit-profile-modal': closeEditProfileModal,
    'visualization-modal': closeVisualizationModal,
    'search-modal': closeSearchModal,
    'insights-modal': closeInsightsModal,
    'import-expenses-modal': closeImportExpensesModal,
    'settings-modal': closeSettingsModal,
    'recurring-modal': closeRecurringModal,
    'change-password-modal': closeChangePasswordModal,
    'scan-modal': closeScanModal,
    'admin-modal': closeAdminModal
};

function closeTopModal() {
    const id = openModals[openModals.length - 1];
    if (!id) return;
    if (id === 'change-password-modal' && isPasswordResetFlow) return;
    const closer = MODAL_CLOSERS[id];
    if (closer) closer(); else closeModal(id);
}

// Backdrop click closes the modal it belongs to. pointerdown so it also
// fires reliably for taps on iOS Safari.
document.addEventListener(window.PointerEvent ? 'pointerdown' : 'mousedown', function (event) {
    if (!event.target.classList || !event.target.classList.contains('modal')) return;
    const id = event.target.id;
    if (id === 'change-password-modal' && isPasswordResetFlow) return;
    const closer = MODAL_CLOSERS[id];
    if (closer) closer(); else closeModal(id);
});


/* =====================================================================
   Category colours — a type keeps the same colour everywhere
   ===================================================================== */

const CATEGORY_PALETTE = [
    { bg: 'rgba(99,102,241,.14)', fg: '#4f46e5', bd: 'rgba(99,102,241,.30)', chart: '#6366f1' },
    { bg: 'rgba(16,185,129,.14)', fg: '#047857', bd: 'rgba(16,185,129,.30)', chart: '#10b981' },
    { bg: 'rgba(245,158,11,.16)', fg: '#b45309', bd: 'rgba(245,158,11,.32)', chart: '#f59e0b' },
    { bg: 'rgba(236,72,153,.14)', fg: '#be185d', bd: 'rgba(236,72,153,.30)', chart: '#ec4899' },
    { bg: 'rgba(14,165,233,.14)', fg: '#0369a1', bd: 'rgba(14,165,233,.30)', chart: '#0ea5e9' },
    { bg: 'rgba(139,92,246,.14)', fg: '#6d28d9', bd: 'rgba(139,92,246,.30)', chart: '#8b5cf6' },
    { bg: 'rgba(244,63,94,.14)', fg: '#be123c', bd: 'rgba(244,63,94,.30)', chart: '#f43f5e' },
    { bg: 'rgba(20,184,166,.14)', fg: '#0f766e', bd: 'rgba(20,184,166,.30)', chart: '#14b8a6' },
    { bg: 'rgba(132,204,22,.16)', fg: '#4d7c0f', bd: 'rgba(132,204,22,.32)', chart: '#84cc16' },
    { bg: 'rgba(249,115,22,.16)', fg: '#c2410c', bd: 'rgba(249,115,22,.32)', chart: '#f97316' },
    { bg: 'rgba(6,182,212,.14)', fg: '#0e7490', bd: 'rgba(6,182,212,.30)', chart: '#06b6d4' },
    { bg: 'rgba(168,85,247,.14)', fg: '#7e22ce', bd: 'rgba(168,85,247,.30)', chart: '#a855f7' }
];

function categoryColor(name) {
    const key = String(name || '');
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
        hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    }
    return CATEGORY_PALETTE[hash % CATEGORY_PALETTE.length];
}

function typeStyleAttr(name) {
    const color = categoryColor(name);
    return `--type-bg:${color.bg};--type-fg:${color.fg};--type-bd:${color.bd}`;
}

function typeBadge(name) {
    return `<span class="expense-type" style="${typeStyleAttr(name)}">${esc(name)}</span>`;
}

function billingBadge(billed) {
    if (!trackingBilling()) return '';
    return billed
        ? '<span class="billed-badge">BILLED</span>'
        : '<span class="unbilled-badge">UNBILLED</span>';
}

/* =====================================================================
   Charts — theme awareness
   ===================================================================== */

const chartsAvailable = () => typeof window.Chart !== 'undefined';

function chartInk() {
    return isDarkMode ? '#b8c0d2' : '#4b5162';
}

function chartGrid() {
    return isDarkMode ? 'rgba(255,255,255,.08)' : 'rgba(16,20,40,.08)';
}

function applyChartDefaults() {
    if (!chartsAvailable()) return;
    Chart.defaults.font.family =
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif';
    Chart.defaults.font.size = 12;
    Chart.defaults.color = chartInk();
    Chart.defaults.plugins.legend.labels.usePointStyle = true;
    Chart.defaults.plugins.legend.labels.boxWidth = 8;
    Chart.defaults.plugins.tooltip.backgroundColor = isDarkMode ? '#242938' : '#171a24';
    Chart.defaults.plugins.tooltip.padding = 10;
    Chart.defaults.plugins.tooltip.cornerRadius = 8;
    Chart.defaults.plugins.tooltip.displayColors = false;
}

function axisConfig(extra) {
    return Object.assign({
        grid: { color: chartGrid(), drawBorder: false },
        ticks: { color: chartInk() }
    }, extra || {});
}

function refreshChartTheme() {
    if (!chartsAvailable()) return;
    applyChartDefaults();
    if (currentChart) updateChart(currentChartType);
    if (insightsChart || velocityChart) {
        if (document.getElementById('insights-modal').classList.contains('open')) {
            loadSpendingInsights();
        }
    }
}

function calculateStepSize(maxValue) {
    if (!isFinite(maxValue) || maxValue <= 0) return 100;
    const magnitude = Math.pow(10, Math.floor(Math.log10(maxValue)));
    const normalized = maxValue / magnitude;
    if (normalized <= 1) return magnitude / 10;
    if (normalized <= 2) return magnitude / 5;
    if (normalized <= 5) return magnitude / 2;
    return magnitude;
}

function calculateMaxValue(maxValue) {
    if (!isFinite(maxValue) || maxValue <= 0) return 1000;
    const step = calculateStepSize(maxValue);
    return Math.ceil(maxValue / step) * step;
}

/** Math.max over a possibly-empty array without returning -Infinity. */
function safeMax(values) {
    let max = 0;
    for (const value of values) {
        const n = Number(value);
        if (isFinite(n) && n > max) max = n;
    }
    return max;
}

/* =====================================================================
   Validation
   ===================================================================== */

function validateExpenseInput(amount, type, note) {
    const errors = [];
    if (!amount || isNaN(amount) || amount <= 0) errors.push('Valid amount is required');
    if (amount > MAX_AMOUNT) errors.push('Amount cannot exceed ₹10,00,000');
    if (!type || String(type).trim() === '') errors.push('Expense type is required');
    if (!note || String(note).trim() === '') errors.push('Description is required');
    if (note && String(note).length > MAX_NOTE_LENGTH) {
        errors.push('Description cannot exceed ' + MAX_NOTE_LENGTH + ' characters');
    }
    return errors;
}

/* =====================================================================
   App start
   ===================================================================== */

document.addEventListener('DOMContentLoaded', async function () {
    if (!supabase) return;

    show('loading-spinner', true, 'block');
    applyTheme();
    applyChartDefaults();

    const today = todayISO();
    const { year, month } = todayParts();
    $('date').value = today;
    $('end-date').value = today;
    $('start-date').value = monthBounds(year, month).first;

    renderAmountChips();
    wireAmountChips();
    initVoiceButton();
    initImportExpensesUI();
    wireForms();
    registerServiceWorker();
    wireOfflineHandling();
    handleSecureEmailLink();
    handleEmailChangeConfirmation();

    supabase.auth.onAuthStateChange((event, session) => {
        if (event === 'PASSWORD_RECOVERY') {
            currentUser = session && session.user ? session.user : null;
            isPasswordResetFlow = true;
            if (currentUser) showForcedPasswordChange();
            else showSignIn();
        } else if (event === 'SIGNED_IN' && session && session.user) {
            if (!isPasswordResetFlow) {
                currentUser = session.user;
                showDashboard();
            }
        } else if (event === 'SIGNED_OUT') {
            currentUser = null;
            isPasswordResetFlow = false;
            showSignIn();
        } else if (event === 'USER_UPDATED' && session && session.user) {
            if (!window.location.search.includes('type=email_change')) {
                currentUser = session.user;
                if (!isPasswordResetFlow && $('dashboard').style.display !== 'none') {
                    showDashboard();
                }
            }
        }
        show('loading-spinner', false);
        document.body.classList.add('loaded');
    });

    try {
        // getSession() reads the stored token locally. Calling getUser()
        // straight away costs a request that 401s for every signed-out
        // visitor, so only reach for it once a session actually exists.
        const { data: sessionData } = await supabase.auth.getSession();
        if (sessionData && sessionData.session) {
            const { data } = await supabase.auth.getUser();
            if (data && data.user) {
                currentUser = data.user;
                await showDashboard();
            } else {
                showSignIn();
            }
        } else {
            showSignIn();
        }
    } catch (error) {
        console.error('Auth check failed:', error);
        showSignIn();
    } finally {
        show('loading-spinner', false);
        document.body.classList.add('loaded');
    }

    updateDateDisplay();
});

function wireForms() {
    $('signin').addEventListener('submit', handleSignIn);
    $('signup').addEventListener('submit', handleSignUp);
    $('forgot-password').addEventListener('submit', handleForgotPassword);
    $('expense-form').addEventListener('submit', handleAddExpense);
    $('add-type-form').addEventListener('submit', handleAddType);
    $('edit-type-form').addEventListener('submit', handleEditType);
    $('delete-type-form').addEventListener('submit', handleDeleteType);
    $('change-password-form').addEventListener('submit', handleChangePassword);
    $('edit-profile-form').addEventListener('submit', handleEditProfile);
    $('profile-password-form').addEventListener('submit', handleProfilePasswordChange);

    // The amount suggestions are drawn from the type and the note, so they
    // have to be redrawn whenever either changes — including when quick-add
    // or the scanner fills them in, which is why 'change' is listened for on
    // the note as well as 'input'.
    const rerenderChips = debounce(renderAmountChips, 150);
    ['note', 'type'].forEach(id => {
        const field = $(id);
        if (!field) return;
        field.addEventListener('input', rerenderChips);
        field.addEventListener('change', rerenderChips);
    });

    // The analytics filters used to need an Apply button. They now re-run
    // themselves — debounced, because a date input fires `change` on every
    // arrow-key nudge through a month and each run is a round trip.
    const rerunFilter = debounce(applyDateFilter, 250);
    ['start-date', 'end-date', 'type-filter', 'billing-filter'].forEach(id => {
        const field = $(id);
        if (field) field.addEventListener('change', rerunFilter);
    });
    $('budget-form').addEventListener('submit', handleBudgetSubmit);
    $('search-input').addEventListener('input', debounce(performSearch, 180));
    $('recurring-form').addEventListener('submit', handleRecurringSubmit);

    const quickInput = $('quick-add-input');
    quickInput.addEventListener('input', updateQuickAddPreview);
    quickInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') { event.preventDefault(); submitQuickAdd(); }
    });

    // "120+80+45" in the amount box resolves to 245 on blur or Enter.
    const amountInput = $('amount');
    amountInput.addEventListener('blur', resolveAmountExpression);
    amountInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') resolveAmountExpression();
    });

    ['total-budget-amount', 'billed-budget-amount', 'unbilled-budget-amount'].forEach(id => {
        $(id).addEventListener('input', updateBudgetModalTotal);
    });

    // The billed switch on the add form should be keyboard operable.
    $('form-billed-toggle').addEventListener('keydown', function (event) {
        if (event.key === ' ' || event.key === 'Enter') {
            event.preventDefault();
            toggleFormBilling();
        }
    });
}

/* Keyboard shortcuts */
document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
        if (openModals.length) {
            closeTopModal();
        } else {
            closeUserMenu();
        }
        return;
    }
    const target = event.target;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' ||
        target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (!currentUser || $('dashboard').style.display === 'none') return;

    if (event.key === '/') {
        event.preventDefault();
        showSearchModal();
    } else if (event.key === 'n' || event.key === 'N') {
        event.preventDefault();
        focusAddExpense();
    }
});

function handleSecureEmailLink() {
    const params = new URLSearchParams(window.location.search);
    const actualLink = params.get('link');
    if (actualLink && window.location.pathname === '/secure-email-link') {
        window.location.href = actualLink;
    }
}

/* =====================================================================
   Auth screens
   ===================================================================== */

function hideAllForms() {
    ['signin-form', 'signup-form', 'forgot-password-form', 'password-reset-form']
        .forEach(id => $(id).classList.add('hidden'));
    $('dashboard').style.display = 'none';
    document.body.classList.remove('signed-in');
}

function showSignIn() {
    hideAllForms();
    $('signin-form').classList.remove('hidden');
}

function showSignUp() {
    hideAllForms();
    $('signup-form').classList.remove('hidden');
}

async function showForgotPassword() {
    try {
        await supabase.auth.signOut();
        currentUser = null;
    } catch (error) {
        console.error('Error during logout:', error);
    }
    hideAllForms();
    $('forgot-password-form').classList.remove('hidden');
}

async function demoLogin() {
    $('signin-email').value = 'test.expenses@yopmail.com';
    $('signin-password').value = '123456';
    await handleSignIn(new Event('submit'));
}

async function handleSignIn(event) {
    event.preventDefault();
    const email = $('signin-email').value;
    const password = $('signin-password').value;

    try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        currentUser = data.user;
        showAlert('signin-alert', 'Sign in successful!', 'success');
        setTimeout(() => showDashboard(), 600);
    } catch (error) {
        showAlert('signin-alert', error.message, 'error');
    }
}

async function handleSignUp(event) {
    event.preventDefault();
    const name = $('signup-name').value.trim();
    const email = $('signup-email').value.trim();
    const password = $('signup-password').value;
    const confirmPassword = $('signup-confirm-password').value;

    if (password !== confirmPassword) {
        showAlert('signup-alert', 'Passwords do not match.', 'error');
        return;
    }

    try {
        const { data, error } = await supabase.auth.signUp({
            email, password,
            options: {
                data: { display_name: name, name: name, full_name: name },
                emailRedirectTo: window.location.origin
            }
        });
        if (error) throw error;

        if (data.user) {
            const defaults = ['Food', 'Transportation', 'Entertainment', 'Utilities',
                'Shopping', 'Healthcare', 'Education', 'Other'];
            await supabase.from('expense_types')
                .insert(defaults.map(name => ({ user_id: data.user.id, name })));
        }

        showAlert('signup-alert', 'Check your email for the verification link!', 'success');
        setTimeout(() => showSignIn(), 2000);
    } catch (error) {
        showAlert('signup-alert', error.message, 'error');
    }
}

async function handleForgotPassword(event) {
    event.preventDefault();
    const email = $('forgot-email').value.trim();
    try {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: window.location.origin
        });
        if (error) throw error;
        showAlert('forgot-alert', 'Password reset link sent to your email!', 'success');
        setTimeout(() => showSignIn(), 2000);
    } catch (error) {
        showAlert('forgot-alert', "Invalid email or user doesn't exist. Please sign up.", 'error');
    }
}

async function handlePasswordReset(event) {
    event.preventDefault();
    const newPassword = $('reset-password').value;
    const confirmPassword = $('reset-confirm-password').value;

    if (newPassword !== confirmPassword) {
        showAlert('reset-alert', 'Passwords do not match.', 'error');
        return;
    }

    try {
        const { error } = await supabase.auth.updateUser({ password: newPassword });
        if (error) throw error;
        showAlert('reset-alert', 'Password updated successfully!', 'success');
        setTimeout(() => { window.location.hash = ''; }, 1800);
    } catch (error) {
        showAlert('reset-alert', error.message, 'error');
    }
}

async function showForcedPasswordChange() {
    hideAllForms();
    if (!currentUser) {
        showSignIn();
        return;
    }

    try {
        await supabase.from('user_profiles')
            .upsert([{ user_id: currentUser.id, requires_password_reset: true }],
                { onConflict: 'user_id' });
    } catch (error) {
        console.error('Failed to update password reset flag:', error);
    }

    openModal('change-password-modal');

    const closeBtn = document.querySelector('#change-password-modal .close-modal');
    if (closeBtn) closeBtn.style.display = 'none';

    const title = document.querySelector('#change-password-modal h3');
    if (title) title.textContent = 'Set New Password';

    if (!$('password-reset-instruction') && title) {
        const note = document.createElement('p');
        note.id = 'password-reset-instruction';
        note.className = 'setting-desc';
        note.style.marginBottom = '1rem';
        note.textContent = 'Please set a new password to continue using your account.';
        title.insertAdjacentElement('afterend', note);
    }

    $('new-password').focus();
}

/**
 * Setting a new password, shared by the two places that can do it: the
 * recovery modal (which the PASSWORD_RECOVERY flow forces open and which
 * cannot be dismissed), and the section inside Edit Profile. Same rules and
 * the same Supabase call either way — only where the message lands differs.
 *
 * Returns true when the password actually changed.
 */
async function applyNewPassword(newPassword, confirmPassword, alertId) {
    if (newPassword !== confirmPassword) {
        showAlert(alertId, 'New passwords do not match.', 'error');
        return false;
    }
    if (newPassword.length < 6) {
        showAlert(alertId, 'Password must be at least 6 characters long.', 'error');
        return false;
    }

    try {
        const { error } = await supabase.auth.updateUser({ password: newPassword });
        if (error) throw error;

        if (isPasswordResetFlow) {
            await supabase.from('user_profiles')
                .upsert([{ user_id: currentUser.id, requires_password_reset: false }],
                    { onConflict: 'user_id' });
        }

        showAlert(alertId, 'Password changed successfully!', 'success');
        return true;
    } catch (error) {
        showAlert(alertId, error.message, 'error');
        return false;
    }
}

async function handleChangePassword(event) {
    event.preventDefault();
    const ok = await applyNewPassword($('new-password').value,
        $('confirm-new-password').value, 'change-password-alert');
    if (!ok) return;

    if (isPasswordResetFlow) {
        setTimeout(() => {
            isPasswordResetFlow = false;
            closeChangePasswordModal();
            showDashboard();
            showNotification('Password updated. You can now use your account.', 'success');
        }, 1400);
    } else {
        setTimeout(() => closeChangePasswordModal(), 1600);
    }
}

// The Edit Profile copy. It stays open afterwards — you may well have come in
// to change your name too — so it just clears the fields.
async function handleProfilePasswordChange(event) {
    event.preventDefault();
    const ok = await applyNewPassword($('profile-new-password').value,
        $('profile-confirm-password').value, 'profile-password-alert');
    if (!ok) return;
    $('profile-password-form').reset();
    showNotification('Password updated', 'success');
}

function closeChangePasswordModal() {
    if (isPasswordResetFlow) return;

    closeModal('change-password-modal');
    $('change-password-form').reset();
    $('change-password-alert').innerHTML = '';

    const closeBtn = document.querySelector('#change-password-modal .close-modal');
    if (closeBtn) closeBtn.style.display = '';

    const title = document.querySelector('#change-password-modal h3');
    if (title) title.textContent = 'Change Password';

    const note = $('password-reset-instruction');
    if (note) note.remove();
}

async function logout() {
    isAdminUser = false;
    show('admin-menu-item', false);
    try {
        const { error } = await supabase.auth.signOut();
        if (error) console.error('Logout error:', error);

        localStorage.removeItem('supabase.auth.token');
        const projectId = supabaseUrl.split('//')[1] ? supabaseUrl.split('//')[1].split('.')[0] : null;
        if (projectId) localStorage.removeItem('sb-' + projectId + '-auth-token');

        currentUser = null;
        isPasswordResetFlow = false;
        showSignIn();
        showNotification('Signed out', 'success');
    } catch (error) {
        console.error('Error during logout:', error);
        currentUser = null;
        showSignIn();
    }
}

/* =====================================================================
   Dashboard
   ===================================================================== */

async function showDashboard() {
    if (!currentUser) return;

    // Anything queued on a previous visit goes now, before the dashboard is
    // painted from figures that would otherwise be missing it.
    flushOutbox({ quiet: true });
    refreshAdminFlag();

    try {
        const { data } = await supabase
            .from('user_profiles')
            .select('requires_password_reset')
            .eq('user_id', currentUser.id)
            .maybeSingle();
        if (data && data.requires_password_reset) {
            isPasswordResetFlow = true;
            showForcedPasswordChange();
            return;
        }
    } catch (error) {
        console.error('Failed to check password reset status:', error);
    }

    hideAllForms();
    $('dashboard').style.display = 'block';
    document.body.classList.add('signed-in');

    const meta = currentUser.user_metadata || {};
    const displayName = meta.display_name || meta.name || meta.full_name ||
        currentUser.email.split('@')[0];

    setText('user-name', 'Welcome, ' + displayName + '!');
    setText('user-email', currentUser.email);
    setText('user-avatar', displayName.charAt(0).toUpperCase());

    await loadSettings();
    loadFiredAlerts();
    applyBillingMode();

    // Amount prefilled by the SMS automation shortcut.
    const params = new URLSearchParams(window.location.search);
    const prefilledAmount = params.get('amount');
    if (prefilledAmount && !isNaN(prefilledAmount)) {
        $('amount').value = Math.ceil(parseFloat(prefilledAmount));
        window.history.replaceState({}, document.title, window.location.pathname);
        focusAddExpense();
    }

    $('date').value = todayISO();
    updateDateDisplay();
    resetBillingToggle();
    renderExpenseSkeleton();

    await loadUserBudget();
    updateBudgetHeader();
    await Promise.all([
        loadUserTypes(),
        loadExpenses(),
        updateStatistics(),
        updateBudgetDisplay(),
        loadRecurring()
    ]);
}

function toggleUserMenu(event) {
    if (event) event.stopPropagation();
    const menu = $('user-menu');
    const open = menu.classList.toggle('open');
    $('user-avatar').setAttribute('aria-expanded', String(open));
}

function closeUserMenu() {
    const menu = $('user-menu');
    if (!menu) return;
    menu.classList.remove('open');
    const avatar = $('user-avatar');
    if (avatar) avatar.setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', function (event) {
    const avatar = $('user-avatar');
    const menu = $('user-menu');
    if (!menu || !avatar) return;
    if (!avatar.contains(event.target) && !menu.contains(event.target)) closeUserMenu();
});

function focusAddExpense() {
    const card = $('add-expense-card');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => {
        const note = $('note');
        if (note) note.focus({ preventScroll: true });
    }, 320);
}

/* ---------------------------------------------------------------------
   Simple mode: billed/unbilled hidden across the whole UI
   --------------------------------------------------------------------- */

function applyBillingMode() {
    const tracking = trackingBilling();
    document.body.classList.toggle('simple-mode', !tracking);

    show('budget-split', tracking, 'grid');
    show('stat-billed-card', tracking);
    show('stat-unbilled-card', tracking);
    show('billing-status-group', tracking);
    show('billing-filter-group', tracking);
    show('import-pill-billed', tracking, 'inline-block');
    show('import-billed-hint', tracking, 'inline');

    document.querySelectorAll('.import-preview-table .col-billed')
        .forEach(cell => { cell.style.display = tracking ? '' : 'none'; });

    // Analytics must not stay filtered by a control the user can no longer see.
    if (!tracking) $('billing-filter').value = 'both';

    // Budget modal switches between one total field and the billed/unbilled pair.
    show('budget-total-group', !tracking);
    show('budget-billed-group', tracking);
    show('budget-unbilled-group', tracking);
    $('total-budget-amount').required = !tracking;
    $('billed-budget-amount').required = tracking;
    $('unbilled-budget-amount').required = tracking;

    show('recurring-billed-group', tracking);
    if (!tracking) $('recurring-billed-toggle').classList.remove('active');

    syncSettingSwitches();
    if ($('budget-modal').classList.contains('open')) renderAlertRules();
    renderRecurringDue();
}

function syncSettingSwitches() {
    const pairs = [
        ['setting-track-billing', trackingBilling()],
        ['setting-default-billed', settings.defaultBilled === true],
        ['setting-budget-alerts', settings.budgetAlerts !== false]
    ];
    pairs.forEach(([id, on]) => {
        const el = $(id);
        if (!el) return;
        el.classList.toggle('on', on);
        el.setAttribute('aria-checked', String(on));
    });
    // "Default to billed" is meaningless when billing isn't tracked.
    const defaultRow = $('setting-default-billed');
    if (defaultRow && defaultRow.parentElement) {
        defaultRow.parentElement.style.display = trackingBilling() ? '' : 'none';
    }
}

function showSettingsModal() {
    syncSettingSwitches();
    openModal('settings-modal');
}

function closeSettingsModal() {
    closeModal('settings-modal');
    $('settings-alert').innerHTML = '';
}

async function toggleTrackBilling() {
    const next = !trackingBilling();
    await saveSettings({ trackBilling: next });
    applyBillingMode();
    resetBillingToggle();

    await Promise.all([loadExpenses(), updateStatistics(), updateBudgetDisplay()]);
    renderRecurringDue();
    renderPresetChips();

    showAlert('settings-alert',
        next
            ? 'Billed / unbilled tracking is on. Budgets are split again.'
            : 'Simplified. One total budget, and new expenses save as unbilled.',
        next ? 'info' : 'success');
}

async function toggleDefaultBilled() {
    await saveSettings({ defaultBilled: !settings.defaultBilled });
    syncSettingSwitches();
    resetBillingToggle();
}

async function toggleBudgetAlerts() {
    await saveSettings({ budgetAlerts: settings.budgetAlerts === false });
    syncSettingSwitches();
}

/* =====================================================================
   Expense types
   ===================================================================== */

async function loadUserTypes() {
    try {
        const { data, error } = await supabase.from('expense_types').select('name').order('name');
        if (error) throw error;

        const select = $('type');
        const previous = select.value;
        select.innerHTML = '<option value="">Select Type</option>';
        data.forEach(type => {
            const option = document.createElement('option');
            option.value = type.name;
            option.textContent = type.name;
            select.appendChild(option);
        });
        if (previous) select.value = previous;

        await loadRecentActivity();
    } catch (error) {
        console.error('Failed to load types:', error);
    }
}

async function loadTypesForEdit() {
    try {
        const { data, error } = await supabase.from('expense_types').select('name').order('name');
        if (error) throw error;
        return data.map(type => type.name);
    } catch (error) {
        console.error('Failed to load types:', error);
        return [];
    }
}

/**
 * One query powers both the "quick select" type bubbles and the quick-add
 * model (presets + the token->type index), so this replaced a separate
 * fetch rather than adding one.
 */
async function loadRecentActivity() {
    const row = $('recent-types-row');
    if (!currentUser) return;

    try {
        const { data, error } = await supabase
            .from('expenses')
            .select('note, amount, type, billed, updated_at')
            .eq('user_id', currentUser.id)
            .order('updated_at', { ascending: false })
            .limit(400);
        if (error) throw error;

        const rows = data || [];
        renderRecentTypeBubbles(rows);
        buildQuickAddModel(rows);
    } catch (error) {
        console.error('Failed to load recent activity:', error);
        if (row) row.style.display = 'none';
    }
}

// Kept as the historical name used by the resize handler.
const loadRecentTypeBubbles = loadRecentActivity;

function renderRecentTypeBubbles(rows) {
    const row = $('recent-types-row');
    const seen = new Set();
    const recentTypes = [];

    for (const entry of rows) {
        if (!entry.type || seen.has(entry.type)) continue;
        seen.add(entry.type);
        recentTypes.push(entry.type);
        if (recentTypes.length === 12) break;
    }

    if (!recentTypes.length) {
        row.style.display = 'none';
        return;
    }
    row.style.display = 'block';
    renderTypeBubblesResponsive(recentTypes);
}

function renderTypeBubblesResponsive(recentTypes) {
    const container = $('recent-types-bubbles');
    const MIN_BUBBLES = 3;
    const selected = $('type').value;

    container.innerHTML = '';
    recentTypes.forEach(name => {
        const bubble = document.createElement('button');
        bubble.type = 'button';
        bubble.className = 'type-bubble' + (name === selected ? ' active' : '');
        bubble.textContent = name;
        bubble.onclick = () => selectTypeFromBubble(name);
        container.appendChild(bubble);
    });

    requestAnimationFrame(() => {
        const containerWidth = container.clientWidth;
        if (!containerWidth) return;
        const gap = 6;
        const bubbles = Array.from(container.children);

        let usedWidth = 0;
        let fitCount = 0;
        for (let i = 0; i < bubbles.length; i++) {
            const next = usedWidth + (fitCount > 0 ? gap : 0) + bubbles[i].offsetWidth;
            if (next <= containerWidth || fitCount < MIN_BUBBLES) {
                usedWidth = next;
                fitCount++;
            } else {
                break;
            }
        }
        fitCount = Math.max(MIN_BUBBLES, Math.min(fitCount, bubbles.length));
        bubbles.forEach((bubble, index) => {
            if (index >= fitCount) bubble.remove();
        });
    });
}

function selectTypeFromBubble(name) {
    $('type').value = name;
    document.querySelectorAll('.type-bubble').forEach(bubble => {
        bubble.classList.toggle('active', bubble.textContent === name);
    });
}

function showAddTypeModal() {
    openModal('add-type-modal');
    $('new-type').focus();
}

function closeAddTypeModal() {
    closeModal('add-type-modal');
    $('add-type-form').reset();
    $('type-alert').innerHTML = '';
}

async function handleAddType(event) {
    event.preventDefault();
    const newType = $('new-type').value.trim();
    if (!newType) {
        showAlert('type-alert', 'Please enter a type name.', 'error');
        return;
    }

    try {
        const { data: existing } = await supabase
            .from('expense_types').select('name').ilike('name', newType);
        if (existing && existing.length > 0) {
            showAlert('type-alert', 'This type already exists.', 'error');
            return;
        }

        const { error } = await supabase
            .from('expense_types').insert([{ user_id: currentUser.id, name: newType }]);
        if (error) throw error;

        await loadUserTypes();
        $('type').value = newType;
        showAlert('type-alert', 'Type added successfully!', 'success');
        setTimeout(() => closeAddTypeModal(), 1200);
    } catch (error) {
        showAlert('type-alert', error.message || 'Failed to add type.', 'error');
    }
}

function showEditTypeModal() {
    openModal('edit-type-modal');
    loadTypesForEdit().then(types => {
        const select = $('edit-type-select');
        select.innerHTML = '<option value="">Select Type</option>';
        types.forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            select.appendChild(option);
        });
        const currentType = $('type').value;
        if (currentType) {
            select.value = currentType;
            $('edit-type-name').value = currentType;
        }
    });
}

function closeEditTypeModal() {
    closeModal('edit-type-modal');
    $('edit-type-form').reset();
    $('edit-type-alert').innerHTML = '';
}

function populateEditField() {
    $('edit-type-name').value = $('edit-type-select').value;
}

async function handleEditType(event) {
    event.preventDefault();
    const oldName = $('edit-type-select').value;
    const newName = $('edit-type-name').value.trim();

    if (!oldName) {
        showAlert('edit-type-alert', 'Please select a type to edit.', 'error');
        return;
    }
    if (!newName) {
        showAlert('edit-type-alert', 'Please enter a new type name.', 'error');
        return;
    }
    if (oldName === newName) {
        showAlert('edit-type-alert', 'No changes found. Please modify the type name.', 'error');
        return;
    }

    try {
        const { data: existing } = await supabase
            .from('expense_types').select('name').ilike('name', newName).neq('name', oldName);
        if (existing && existing.length > 0) {
            showAlert('edit-type-alert', 'A type with this name already exists.', 'error');
            return;
        }

        const { error: typeError } = await supabase
            .from('expense_types').update({ name: newName })
            .eq('name', oldName).eq('user_id', currentUser.id);
        if (typeError) throw typeError;

        const { error: expenseError } = await supabase
            .from('expenses').update({ type: newName })
            .eq('type', oldName).eq('user_id', currentUser.id);
        if (expenseError) throw expenseError;

        await loadUserTypes();
        $('type').value = newName;

        if ($('visualization-modal').classList.contains('open')) {
            await loadTypesForFilter();
            await applyDateFilter();
        }
        await loadExpenses();

        showAlert('edit-type-alert', 'Type updated successfully!', 'success');
        setTimeout(() => closeEditTypeModal(), 1200);
    } catch (error) {
        showAlert('edit-type-alert', error.message || 'Failed to update type.', 'error');
    }
}

function showDeleteTypeModal() {
    openModal('delete-type-modal');
    const currentType = $('type').value;
    loadTypesForDeletion().then(() => {
        if (currentType) $('delete-type-select').value = currentType;
    });
}

function closeDeleteTypeModal() {
    closeModal('delete-type-modal');
    $('delete-type-form').reset();
    $('delete-type-alert').innerHTML = '';
}

async function loadTypesForDeletion() {
    try {
        const { data, error } = await supabase.from('expense_types').select('name').order('name');
        if (error) throw error;
        const select = $('delete-type-select');
        select.innerHTML = '<option value="">Select Type</option>';
        data.forEach(type => {
            const option = document.createElement('option');
            option.value = type.name;
            option.textContent = type.name;
            select.appendChild(option);
        });
    } catch (error) {
        console.error('Failed to load types:', error);
    }
}

async function handleDeleteType(event) {
    event.preventDefault();
    const typeName = $('delete-type-select').value;
    if (!typeName) {
        showAlert('delete-type-alert', 'Please select a type to delete.', 'error');
        return;
    }

    try {
        const { data: used, error: checkError } = await supabase
            .from('expenses').select('id').eq('type', typeName).limit(1);
        if (checkError) throw checkError;

        if (used && used.length > 0) {
            showAlert('delete-type-alert',
                'Cannot delete a type that is still used by an expense.', 'error');
            return;
        }
        if (!confirm('Delete the type "' + typeName + '"?')) return;

        const { error } = await supabase
            .from('expense_types').delete()
            .eq('name', typeName).eq('user_id', currentUser.id);
        if (error) throw error;

        await loadUserTypes();
        showAlert('delete-type-alert', 'Type deleted successfully!', 'success');
        setTimeout(() => closeDeleteTypeModal(), 1200);
    } catch (error) {
        showAlert('delete-type-alert', error.message || 'Failed to delete type.', 'error');
    }
}

/* =====================================================================
   Add expense
   ===================================================================== */

/**
 * The amounts you have actually spent on whatever is currently in the Type
 * and Note fields, commonest first. A generic +500 is a guess; your own
 * ₹450 is a fact, and one tap instead of four.
 *
 * The note is weighted above the type: "Swiggy" tells you less than
 * "office lunch" does.
 */
function suggestedAmounts(limit) {
    const model = quickAddModel;
    if (!model.typeAmounts) return [];

    const score = {};
    const add = (bucket, weight) => {
        if (!bucket) return;
        Object.keys(bucket).forEach(amount => {
            score[amount] = (score[amount] || 0) + bucket[amount] * weight;
        });
    };

    tokenizeNote(($('note') || {}).value || '')
        .forEach(token => add(model.tokenAmounts[token], 3));
    add(model.typeAmounts[($('type') || {}).value || ''], 1);

    return Object.keys(score)
        .map(Number)
        .filter(amount => amount > 0)
        .sort((a, b) => score[b] - score[a] || b - a)
        .slice(0, limit || 4);
}

// A phone's decimal keypad has no + or −, which made the calculator in the
// amount field desktop-only. These two put them within reach.
const AMOUNT_FALLBACK_STEPS = [50, 100, 200, 500];

function renderAmountChips() {
    const container = $('amount-chips');
    if (!container) return;

    const seen = suggestedAmounts(4);
    container.innerHTML =
        (seen.length
            ? seen.map(value =>
                `<button type="button" class="chip is-seen" data-set="${attr(value)}"
                    title="You have spent this before">${esc(moneyShort(value))}</button>`).join('')
            : AMOUNT_FALLBACK_STEPS.map(value =>
                `<button type="button" class="chip" data-add="${value}">+${value}</button>`).join('')) +
        '<button type="button" class="chip" data-clear="1">Clear</button>';
}

// Delegated once, at startup: renderAmountChips() replaces the markup every
// time the type or note changes, and a listener per render would stack up.
function wireAmountChips() {
    const container = $('amount-chips');
    if (!container) return;
    container.addEventListener('click', function (event) {
        const button = event.target.closest('button');
        if (!button) return;
        const input = $('amount');
        if (button.dataset.clear) {
            input.value = '';
        } else if (button.dataset.set) {
            input.value = button.dataset.set;
        } else {
            const current = parseFloat(input.value) || 0;
            input.value = Math.min(current + Number(button.dataset.add), MAX_AMOUNT);
        }
        input.focus();
    });
}

/** Append an operator, so the calculator works on a numeric keypad. */
function appendAmountOperator(operator) {
    const input = $('amount');
    const value = String(input.value || '').trim();
    if (!value) {
        // A leading "+" is meaningless and a leading "−" would be a negative
        // amount, which validation refuses anyway.
        input.focus();
        return;
    }
    input.value = /[+\-*/]$/.test(value)
        ? value.slice(0, -1) + operator      // swap the operator rather than stack it
        : value + operator;
    input.focus();
}

/* =====================================================================
   Quick add
   ---------------------------------------------------------------------
   Three small things that remove typing:
     · presets  — (note, amount, type) combinations you've repeated
     · parsing  — "450 lunch swiggy" split into fields, type inferred from
                  your own history (no server, no model download)
     · maths    — "120+80+45" in the amount box
   All derived from data already in the expenses table; no schema change.
   ===================================================================== */

let quickAddModel = { presets: [], tokenTypes: {}, typeCounts: {}, totalNotes: 0 };

const QUICK_ADD_STOPWORDS = new Set([
    'for', 'the', 'a', 'an', 'of', 'at', 'on', 'in', 'to', 'and', 'with',
    'my', 'from', 'via', 'per', 'by'
]);

function tokenizeNote(note) {
    return String(note || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(token => token.length > 1 && !QUICK_ADD_STOPWORDS.has(token) && !/^\d+$/.test(token));
}

/** '450' | '₹450' | '1.2k' | '1,200' | '450/-' | 'rs450' -> number, else null */
function parseAmountToken(token) {
    const cleaned = String(token)
        .replace(/[₹,]/g, '')
        .replace(/\/-$/, '')
        .replace(/^rs\.?/i, '');
    const match = /^(\d+(?:\.\d+)?)(k)?$/i.exec(cleaned);
    if (!match) return null;
    const value = parseFloat(match[1]) * (match[2] ? 1000 : 1);
    return isFinite(value) && value > 0 ? value : null;
}

/**
 * Evaluate a small arithmetic expression. Recursive descent over a
 * whitelisted character set — never eval().
 */
function evalArithmetic(expression) {
    const text = String(expression).replace(/\s+/g, '');
    if (!text || !/^[0-9+\-*/().]+$/.test(text) || !/[+\-*/]/.test(text)) return null;

    let pos = 0;
    const peek = () => text.charAt(pos);

    function unit() {
        if (peek() === '(') {
            pos++;
            const value = sum();
            if (peek() !== ')') throw new Error('unbalanced');
            pos++;
            return value;
        }
        if (peek() === '-') { pos++; return -unit(); }
        if (peek() === '+') { pos++; return unit(); }
        const match = /^\d+(?:\.\d+)?/.exec(text.slice(pos));
        if (!match) throw new Error('expected number');
        pos += match[0].length;
        return parseFloat(match[0]);
    }

    function product() {
        let value = unit();
        while (peek() === '*' || peek() === '/') {
            const op = text.charAt(pos++);
            const right = unit();
            if (op === '/' && right === 0) throw new Error('divide by zero');
            value = op === '*' ? value * right : value / right;
        }
        return value;
    }

    function sum() {
        let value = product();
        while (peek() === '+' || peek() === '-') {
            const op = text.charAt(pos++);
            const right = product();
            value = op === '+' ? value + right : value - right;
        }
        return value;
    }

    try {
        const value = sum();
        if (pos !== text.length || !isFinite(value) || value < 0) return null;
        return Math.round(value * 100) / 100;
    } catch (error) {
        return null;
    }
}

function resolveAmountExpression() {
    const input = $('amount');
    if (!input) return;
    const result = evalArithmetic(input.value);
    if (result !== null) input.value = result;
}

/** Read the amount box, tolerating "₹1,200", " 450 " and leftover maths. */
function readAmountField() {
    const raw = String($('amount').value || '').trim();
    if (!raw) return NaN;
    const computed = evalArithmetic(raw);
    if (computed !== null) return computed;
    return parseFloat(raw.replace(/[₹,\s]/g, ''));
}

/** Build presets + the token→type index from recent history. */
function buildQuickAddModel(rows) {
    const combos = new Map();
    const tokenTypes = {};
    const typeCounts = {};
    // How often each amount has been spent, per type and per note word. This
    // is what the chips under the Amount field are drawn from: your own
    // ₹450 beats a generic +500 every time.
    const typeAmounts = {};
    const tokenAmounts = {};
    let totalNotes = 0;

    function tally(bucket, key, amount) {
        if (!isFinite(amount) || amount <= 0) return;
        if (!bucket[key]) bucket[key] = {};
        bucket[key][amount] = (bucket[key][amount] || 0) + 1;
    }

    rows.forEach(row => {
        const note = String(row.note || '').trim();
        const type = row.type;
        const amount = Number(row.amount);
        if (!type) return;

        typeCounts[type] = (typeCounts[type] || 0) + 1;
        totalNotes++;
        tally(typeAmounts, type, amount);

        tokenizeNote(note).forEach(token => {
            if (!tokenTypes[token]) tokenTypes[token] = {};
            tokenTypes[token][type] = (tokenTypes[token][type] || 0) + 1;
            tally(tokenAmounts, token, amount);
        });

        if (!note || !isFinite(amount) || amount <= 0) return;
        const key = note.toLowerCase() + '|' + amount + '|' + type;
        const entry = combos.get(key) ||
            { note, amount, type, billed: !!row.billed, count: 0 };
        entry.count++;
        combos.set(key, entry);
    });

    const presets = Array.from(combos.values())
        .filter(entry => entry.count >= 2)
        .sort((a, b) => b.count - a.count || b.amount - a.amount)
        .slice(0, 6);

    quickAddModel = { presets, tokenTypes, typeCounts, typeAmounts, tokenAmounts, totalNotes };
    renderPresetChips();
    renderAmountChips();
    updateQuickAddPreview();
}

/**
 * Naive Bayes over the user's own note vocabulary. Returns '' when no
 * token is recognised — guessing a category on a money record is worse
 * than asking.
 */
/**
 * The run of words that IS one of your expense types, spelled however you
 * like. "450 swiggy", "swiggy 450" and "swiggy lunch 450" all find it.
 *
 * Longest span first, so a type called "Personal Care" wins over a type
 * called "Care" sitting inside the same phrase; then leftmost, which is what
 * settles the case where two separate words are both type names — the first
 * is the type and the rest of the line is the description.
 *
 * Reads the live <select> rather than the model, so a type added a moment
 * ago is matchable immediately.
 *
 * Returns { name, at, span } or null.
 */
const MAX_TYPE_WORDS = 4;

function matchTypeSpan(words) {
    const select = $('type');
    if (!select || !words.length) return null;

    const byName = {};
    for (const option of select.options) {
        if (option.value) byName[option.value.trim().toLowerCase()] = option.value;
    }

    const longest = Math.min(words.length, MAX_TYPE_WORDS);
    for (let span = longest; span >= 1; span--) {
        for (let at = 0; at + span <= words.length; at++) {
            const phrase = words.slice(at, at + span).join(' ').toLowerCase();
            if (byName[phrase]) return { name: byName[phrase], at, span };
        }
    }
    return null;
}

/**
 * The type of the expenses whose notes contain this word. Exact and
 * evidence-based, where inferType() below is a smoothed guess across every
 * token — so "45 uber" lands on whatever you filed the last Ubers under,
 * rather than on whichever type happens to be commonest overall.
 */
function typeFromHistory(note) {
    const counts = {};
    tokenizeNote(note).forEach(token => {
        const seen = quickAddModel.tokenTypes[token];
        if (!seen) return;
        Object.keys(seen).forEach(type => {
            counts[type] = (counts[type] || 0) + seen[type];
        });
    });
    const found = Object.keys(counts);
    if (!found.length) return '';
    return found.reduce((best, type) => (counts[type] > counts[best] ? type : best), found[0]);
}

function inferType(note) {
    const types = Object.keys(quickAddModel.typeCounts);
    if (!types.length) return '';

    const tokens = tokenizeNote(note);
    const scores = {};
    const total = quickAddModel.totalNotes || 1;
    types.forEach(type => {
        scores[type] = Math.log((quickAddModel.typeCounts[type] || 0.5) / total) * 0.4;
    });

    let matched = false;
    tokens.forEach(token => {
        const row = quickAddModel.tokenTypes[token];
        if (!row) return;
        matched = true;
        const seen = Object.keys(row).reduce((sum, type) => sum + row[type], 0);
        types.forEach(type => {
            scores[type] += Math.log(((row[type] || 0) + 0.15) / (seen + 0.15 * types.length));
        });
    });

    if (!matched) return '';
    return types.reduce((best, type) => (scores[type] > scores[best] ? type : best), types[0]);
}

/**
 * "450 swiggy" / "swiggy 450" / "lunch 120+80" / "45 uber" into the three
 * fields. Word order carries no meaning — each part is identified by what it
 * IS, not by where it sits:
 *
 *   amount   the first token that reads as a number or a sum, wherever it is
 *   type     the run of words that matches one of your types, wherever it is
 *   note     everything left over
 *
 * The type is then resolved in order of how sure the app can be:
 *
 *   1. words that ARE one of your types — no guessing involved, and they are
 *      dropped from the note, since "Swiggy · Swiggy" describes nothing;
 *   2. a word you have used in a note before — filed the way you filed it
 *      last time, which is what makes "45 uber" work;
 *   3. the smoothed guess across every token.
 *
 * The note is never left empty when something was typed: a lone type word
 * becomes the note as well, so "450 swiggy" is addable as it stands rather
 * than failing validation on a blank description.
 */
function parseQuickAdd(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;

    const tokens = raw.split(/\s+/);
    let amount = null;
    let amountIndex = -1;

    // Anywhere in the line, not just the front.
    for (let i = 0; i < tokens.length; i++) {
        const value = parseAmountToken(tokens[i]);
        if (value !== null) { amount = value; amountIndex = i; break; }
    }
    // Fall back to an arithmetic expression, e.g. "dinner 120+80".
    if (amount === null) {
        for (let i = 0; i < tokens.length; i++) {
            const value = evalArithmetic(tokens[i]);
            if (value !== null && value > 0) { amount = value; amountIndex = i; break; }
        }
    }

    const rest = tokens.filter((_, i) => i !== amountIndex);

    // 1. Words that name a type, wherever they sit.
    let type = '';
    let noteWords = rest;
    const found = matchTypeSpan(rest);
    if (found) {
        type = found.name;
        noteWords = rest.slice(0, found.at).concat(rest.slice(found.at + found.span));
    }

    let note = noteWords.join(' ').trim();
    // Nothing but the type words: use their proper spelling as the description.
    if (!note && type) note = type;

    // 2 and 3, only when nothing named a type outright.
    if (!type && note) type = typeFromHistory(note) || inferType(note);

    return { amount, note, type };
}

function updateQuickAddPreview() {
    const preview = $('quick-add-preview');
    const input = $('quick-add-input');
    if (!preview || !input) return;

    const parsed = parseQuickAdd(input.value);
    if (!parsed) { preview.innerHTML = ''; return; }

    const bits = [];
    bits.push(parsed.amount !== null
        ? `<span class="qa-amount">${esc(money(parsed.amount))}</span>`
        : '<span class="qa-guess">add an amount</span>');
    if (parsed.type) bits.push(typeBadge(parsed.type));
    else if (parsed.note) bits.push('<span class="qa-guess">pick a type</span>');
    if (parsed.note) bits.push(esc(parsed.note));

    preview.innerHTML = bits.join('<span aria-hidden="true">·</span> ');
}

async function submitQuickAdd() {
    const input = $('quick-add-input');
    const parsed = parseQuickAdd(input.value);
    if (!parsed) { input.focus(); return; }

    // Confident enough to file it; otherwise pre-fill and let the user finish.
    if (parsed.amount !== null && parsed.type && parsed.note) {
        const saved = await createExpense({
            amount: parsed.amount, note: parsed.note,
            type: parsed.type, date: todayISO(),
            billed: trackingBilling() && settings.defaultBilled === true
        }, 'Added ' + money(parsed.amount) + ' · ' + parsed.type, { warnDuplicate: true });
        if (saved) {
            input.value = '';
            updateQuickAddPreview();
            input.focus();
        }
        return;
    }

    if (parsed.note) $('note').value = parsed.note;
    if (parsed.amount !== null) $('amount').value = parsed.amount;
    if (parsed.type) $('type').value = parsed.type;

    input.value = '';
    updateQuickAddPreview();

    if (parsed.amount === null) {
        $('amount').focus();
        showNotification('Add an amount to finish', 'warning', 2600);
    } else {
        $('type').focus();
        showNotification('Pick a type to finish', 'warning', 2600);
    }
}

function renderPresetChips() {
    const row = $('preset-row');
    const container = $('preset-chips');
    if (!row || !container) return;

    if (!quickAddModel.presets.length) {
        row.style.display = 'none';
        container.innerHTML = '';
        return;
    }

    row.style.display = 'block';
    container.innerHTML = quickAddModel.presets.map((preset, index) => {
        const label = preset.note.length > 22 ? preset.note.slice(0, 21) + '…' : preset.note;
        return `<button type="button" class="preset-chip" data-preset="${index}"
            title="${attr(preset.note + ' · ' + preset.type)}">
            ${esc(label)} <span class="preset-amount">${esc(moneyShort(preset.amount))}</span>
        </button>`;
    }).join('');

    container.querySelectorAll('[data-preset]').forEach(button => {
        button.addEventListener('click', () => applyPreset(Number(button.dataset.preset)));
    });
}

async function applyPreset(index) {
    const preset = quickAddModel.presets[index];
    if (!preset) return;
    // A one-tap chip is the easiest thing in the app to press twice.
    await createExpense({
        amount: preset.amount, note: preset.note, type: preset.type,
        date: todayISO(), billed: trackingBilling() ? preset.billed : false
    }, 'Added ' + money(preset.amount) + ' · ' + preset.type, { warnDuplicate: true });
}

function setDateOffset(days) {
    $('date').value = days === 0 ? todayISO() : addDaysISO(todayISO(), days);
    updateDateDisplay();
}

function updateDateDisplay() {
    const input = $('date');
    const display = $('date-display');
    if (!input || !display || !input.value) return;

    const parts = splitISO(input.value);
    if (!parts) {
        display.textContent = '';
        return;
    }

    const date = isoToDisplayDate(input.value);
    let formatted;
    try {
        formatted = date.toLocaleDateString('en-IN', {
            weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
        });
    } catch (error) {
        formatted = formatDate(input.value);
    }

    const day = parts.day;
    const suffix = (day % 10 === 1 && day !== 11) ? 'st'
        : (day % 10 === 2 && day !== 12) ? 'nd'
            : (day % 10 === 3 && day !== 13) ? 'rd' : 'th';

    // Only replace the standalone day number, never a digit inside the year.
    display.textContent = formatted.replace(new RegExp('\\b' + day + '\\b'), day + suffix);

    const today = todayISO();
    if (input.value === today) display.textContent += ' · Today';
    else if (input.value === addDaysISO(today, -1)) display.textContent += ' · Yesterday';
    else if (input.value > today) display.textContent += ' · Future date';
}

function toggleFormBilling() {
    const toggle = $('form-billed-toggle');
    toggle.classList.toggle('active');
    const active = toggle.classList.contains('active');
    toggle.setAttribute('aria-checked', String(active));
    $('billed').checked = active;
}

function resetBillingToggle() {
    const toggle = $('form-billed-toggle');
    const on = trackingBilling() && settings.defaultBilled === true;
    toggle.classList.toggle('active', on);
    toggle.setAttribute('aria-checked', String(on));
    $('billed').checked = on;
}

/**
 * Same amount, same type, same day — almost always a double tap on Add, or
 * the same receipt entered twice from two devices. Returns the offending row
 * so the warning can name it, or null.
 *
 * Deliberately narrow: the note is not compared, because the whole point is
 * to catch the entry you have forgotten you already made, which you will not
 * have worded identically. Two genuine ₹40 chais on one day are the false
 * positive we accept, and the prompt lets them straight through.
 */
async function findSameDayDuplicate(fields) {
    if (!currentUser) return null;
    try {
        const { data, error } = await supabase
            .from('expenses').select('id, note, amount, type, date')
            .eq('user_id', currentUser.id)
            .eq('date', fields.date)
            .eq('type', fields.type)
            .eq('amount', fields.amount)
            .limit(1);
        if (error) throw error;
        return (data && data[0]) || null;
    } catch (error) {
        // A warning that cannot be looked up must never block the write.
        console.error('Duplicate check failed:', error);
        return null;
    }
}

/**
 * The single write path for new expenses: validates, inserts, refreshes
 * every dependent view, and offers an undo. Used by the form, the quick-add
 * box, presets and recurring.
 *
 * `opts.warnDuplicate` asks for the same-day check first. It is opt-in
 * because three of the callers repeat an expense on purpose — Repeat this
 * expense, a recurring rule, a CSV import — and being asked "are you sure?"
 * about the thing you just explicitly requested is noise, not a safeguard.
 */
async function createExpense(fields, successMessage, opts) {
    const errors = validateExpenseInput(fields.amount, fields.type, fields.note);
    if (!fields.date || !splitISO(fields.date)) errors.push('A valid date is required');
    if (errors.length) {
        showNotification(errors[0], 'error');
        return null;
    }

    if (opts && opts.warnDuplicate) {
        const clash = await findSameDayDuplicate(fields);
        if (clash && !confirm(
            'You already logged ' + money(clash.amount) + ' of ' + clash.type +
            ' on ' + formatDate(clash.date) + ' — "' + (clash.note || 'no description') +
            '".\n\nAdd this one as well?')) {
            return null;
        }
    }

    try {
        const { data, error } = await supabase.from('expenses').insert([{
            user_id: currentUser.id,
            amount: fields.amount,
            date: fields.date,
            type: fields.type,
            note: fields.note,
            billed: !!fields.billed
        }]).select();
        if (error) throw error;

        const row = data && data[0] ? data[0] : null;

        await refreshAfterMutation();
        await loadRecentActivity();
        await checkBudgetWarnings();

        showNotification(successMessage || 'Expense added', 'success', 5000,
            row ? { label: 'Undo', onClick: () => deleteExpense(row.id, false, true) } : null);
        return row || true;
    } catch (error) {
        // No network is not a failure to report — it is a write to hold on
        // to. Anything the server actually refused still surfaces as an error,
        // because queueing a row the database rejected would only fail again.
        if (isOfflineError(error)) {
            try {
                const queued = await queueExpense(fields, currentUser.id);
                await refreshAfterMutation();
                showNotification('Saved on this device — it will sync when you reconnect',
                    'warning', 5000);
                return { id: queued.id, pending: true };
            } catch (queueError) {
                console.error('Could not queue offline expense:', queueError);
                showNotification('You are offline and this device cannot hold the ' +
                    'expense. Try again when you have a connection.', 'error');
                return null;
            }
        }
        console.error('Add expense error:', error);
        showNotification('Failed to add expense: ' + error.message, 'error');
        return null;
    }
}

async function handleAddExpense(event) {
    event.preventDefault();
    const button = $('add-expense-btn');
    resolveAmountExpression();

    const type = $('type').value;
    const fields = {
        amount: readAmountField(),
        type,
        note: $('note').value.trim(),
        date: $('date').value,
        // Simple mode hides the billing concept, so everything is unbilled.
        billed: trackingBilling() && $('form-billed-toggle').classList.contains('active')
    };

    button.disabled = true;
    try {
        const saved = await createExpense(fields, null, { warnDuplicate: true });
        if (!saved) return;

        $('expense-form').reset();
        $('date').value = todayISO();
        $('type').value = type;
        resetBillingToggle();
        updateDateDisplay();
        $('note').focus();
    } finally {
        button.disabled = false;
    }
}

/* =====================================================================
   Recent expenses (dashboard)
   ===================================================================== */

function renderExpenseSkeleton() {
    const container = $('expenses-container');
    if (container) container.innerHTML = '<div class="skeleton-row"></div>'.repeat(3);
}

async function loadExpenses() {
    const container = $('expenses-container');
    if (!container || !currentUser) return;

    const limit = parseInt(($('recent-limit') || {}).value, 10) || 5;
    // Queued rows always come first and are never trimmed by the limit: they
    // are the ones you cannot see anywhere else.
    const pending = await pendingExpenses(currentUser.id);

    try {
        const { data: saved, error } = await supabase
            .from('expenses').select('*')
            .order('updated_at', { ascending: false })
            .limit(limit);
        if (error) throw error;

        const data = pending.concat(saved || []);

        if (!data.length) {
            container.innerHTML =
                '<div class="empty-state"><div class="empty-state-icon">🧾</div>' +
                '<p>No expenses yet. Add your first one above!</p></div>';
            return;
        }

        // Repeat belongs to this list only; everything else — edit in place,
        // the billed toggle, delete — is the shared row.
        const repeat = expense => `
                <button class="icon-btn tone-indigo repeat-btn" type="button"
                    title="Repeat this expense today" aria-label="Repeat this expense today"
                    onclick="duplicateExpense('${attr(expense.id)}')">
                    <svg class="icon"><use href="#i-copy" /></svg>
                </button>`;

        container.innerHTML =
            data.map(expense => expenseItemMarkup(expense, 'recent', repeat(expense))).join('') +
            `<div style="display:flex;justify-content:flex-end;margin-top:0.75rem;">
                <button class="save-changes-btn" type="button" data-save-scope="recent"
                    onclick="saveAllChanges('recent')">Save Changes</button>
            </div>`;

        container._rows = data;
        // The list was just redrawn from scratch, so anything half-edited in
        // it is gone from the DOM; drop the records rather than orphan them.
        clearPendingEdits('recent');
    } catch (error) {
        console.error('Failed to load expenses:', error);
        // Offline with something queued: showing "could not load" over the top
        // of an expense you just added is how people conclude it was lost.
        if (pending.length) {
            container.innerHTML =
                '<div class="offline-note">Offline — showing what is waiting to sync.</div>' +
                pending.map(expense => expenseItemMarkup(expense, 'recent')).join('');
            container._rows = pending;
            return;
        }
        container.innerHTML =
            '<div class="empty-state"><div class="empty-state-icon">⚠️</div>' +
            '<p>Could not load your expenses. Check your connection and try again.</p></div>';
    }
}

async function duplicateExpense(id) {
    const container = $('expenses-container');
    const source = (container && container._rows || []).find(row => String(row.id) === String(id))
        || filteredExpenses.find(row => String(row.id) === String(id));
    if (!source) return;

    try {
        const { error } = await supabase.from('expenses').insert([{
            user_id: currentUser.id,
            amount: source.amount,
            date: todayISO(),
            type: source.type,
            note: source.note,
            billed: trackingBilling() ? source.billed : false
        }]);
        if (error) throw error;

        await Promise.all([loadExpenses(), updateStatistics(), updateBudgetDisplay()]);
        await checkBudgetWarnings();
        showNotification('Repeated ' + money(source.amount) + ' on today', 'success');
    } catch (error) {
        showNotification('Could not repeat expense: ' + error.message, 'error');
    }
}

/**
 * Delete an expense. `offerUndo` re-inserts the same values on request
 * (the restored row gets a new id, which is fine for this data model).
 */
async function deleteExpense(id, offerUndo, skipConfirm) {
    const container = $('expenses-container');
    const snapshot =
        (container && container._rows || []).find(row => String(row.id) === String(id)) ||
        filteredExpenses.find(row => String(row.id) === String(id)) ||
        null;

    if (!offerUndo && !skipConfirm && !confirm('Delete this expense?')) return;

    try {
        const { error } = await supabase.from('expenses').delete().eq('id', id);
        if (error) throw error;

        filteredExpenses = filteredExpenses.filter(expense => String(expense.id) !== String(id));
        allExpensesCache = allExpensesCache.filter(expense => String(expense.id) !== String(id));

        await refreshAfterMutation();

        if (offerUndo && snapshot) {
            lastDeletedExpense = snapshot;
            showNotification('Expense deleted', 'success', 6500, {
                label: 'Undo',
                onClick: () => restoreLastDeleted(snapshot)
            });
        } else if (!skipConfirm) {
            showNotification('Expense deleted', 'success');
        } else {
            showNotification('Removed', 'success', 2200);
        }
    } catch (error) {
        showNotification('Failed to delete expense: ' + error.message, 'error');
    }
}

async function restoreLastDeleted(snapshot) {
    const row = snapshot || lastDeletedExpense;
    if (!row) return;
    try {
        const { error } = await supabase.from('expenses').insert([{
            user_id: currentUser.id,
            amount: row.amount,
            date: row.date,
            type: row.type,
            note: row.note,
            billed: row.billed
        }]);
        if (error) throw error;
        lastDeletedExpense = null;
        await refreshAfterMutation();
        showNotification('Expense restored', 'success');
    } catch (error) {
        showNotification('Could not restore expense: ' + error.message, 'error');
    }
}

/** Delete from the analytics list (keeps that list in sync too). */
async function deleteFilteredExpense(id) {
    await deleteExpense(id, true);
}

async function refreshAfterMutation() {
    await Promise.all([loadExpenses(), updateStatistics(), updateBudgetDisplay()]);
    renderRecurringDue();
    if ($('visualization-modal').classList.contains('open')) {
        await applyDateFilter();
    }
}

/* =====================================================================
   Statistics
   ===================================================================== */

async function updateStatistics() {
    if (!currentUser) return;

    try {
        const { data: saved, error } = await supabase.from('expenses').select('amount, date, billed');
        if (error) throw error;

        // Anything queued offline is money already spent; leaving it out makes
        // the dashboard disagree with the list directly beneath it.
        const data = saved.concat(await pendingExpenses(currentUser.id));

        const { year, month } = todayParts();
        const thisMonth = monthBounds(year, month);
        const prev = previousMonth(year, month);
        const lastMonth = monthBounds(prev.year, prev.month);

        let monthlyTotal = 0, monthlyCount = 0, billedTotal = 0, unbilledTotal = 0, lastMonthTotal = 0;

        for (const expense of data) {
            const amount = parseFloat(expense.amount) || 0;
            if (withinRange(expense.date, thisMonth.first, thisMonth.last)) {
                monthlyTotal += amount;
                monthlyCount++;
                if (expense.billed) billedTotal += amount; else unbilledTotal += amount;
            } else if (withinRange(expense.date, lastMonth.first, lastMonth.last)) {
                lastMonthTotal += amount;
            }
        }

        setText('monthly-expenses', money(monthlyTotal));
        setText('total-expenses', money(lastMonthTotal));
        setText('billed-expenses', money(billedTotal));
        setText('unbilled-expenses', money(unbilledTotal));
        setText('expense-count', String(monthlyCount));

        const delta = $('month-delta');
        if (delta) {
            if (lastMonthTotal > 0) {
                const change = ((monthlyTotal - lastMonthTotal) / lastMonthTotal) * 100;
                delta.textContent = (change >= 0 ? '▲ ' : '▼ ') + Math.abs(change).toFixed(0) + '%';
                delta.className = 'stat-delta ' + (change >= 0 ? 'up' : 'down');
            } else {
                delta.textContent = '';
                delta.className = 'stat-delta';
            }
        }
    } catch (error) {
        console.error('Failed to update statistics:', error);
    }
}

/* =====================================================================
   Budget
   ===================================================================== */

function updateBudgetHeader() {
    setText('budget-header', getCurrentMonthName() + ' Budget');
}

async function loadUserBudget() {
    monthlyBilledBudget = 0;
    monthlyUnbilledBudget = 0;
    if (!currentUser) return;

    try {
        const { year, month } = todayParts();
        const { data, error } = await supabase
            .from('user_budgets')
            .select('monthly_billed_budget, monthly_unbilled_budget')
            .eq('user_id', currentUser.id)
            .eq('budget_month', month)
            .eq('budget_year', year);

        if (error) {
            console.error('Budget query error:', error);
        } else if (data && data.length > 0) {
            monthlyBilledBudget = parseFloat(data[0].monthly_billed_budget) || 0;
            monthlyUnbilledBudget = parseFloat(data[0].monthly_unbilled_budget) || 0;
        }
    } catch (error) {
        console.error('Failed to load budget:', error);
    }
    updateBudgetHeader();
    updateBudgetButtonLabel();
}

function updateBudgetButtonLabel() {
    const button = $('budget-set-btn');
    if (!button) return;
    const exists = monthlyBilledBudget > 0 || monthlyUnbilledBudget > 0;
    button.textContent = exists ? 'Update Budget' : 'Set Budget';
}

function setBudget() {
    applyBillingMode();
    openModal('budget-modal');
    setText('budget-modal-title', getCurrentMonthName() + ' Budget');
    switchBudgetTab('amounts');
    loadCurrentMonthBudget();
    renderAlertRules();
}

function switchBudgetTab(tab) {
    const isAmounts = tab !== 'alerts';
    show('budget-tab-amounts', isAmounts, 'block');
    show('budget-tab-alerts', !isAmounts, 'block');

    [['budget-tab-btn-amounts', isAmounts], ['budget-tab-btn-alerts', !isAmounts]]
        .forEach(([id, active]) => {
            const button = $(id);
            if (!button) return;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', String(active));
        });

    if (!isAmounts) renderAlertRules();
}

/* ---------------------------------------------------------------------
   Alert level editor
   --------------------------------------------------------------------- */

function renderAlertRules() {
    const list = $('alert-rules-list');
    if (!list) return;

    syncSettingSwitches();
    show('alert-scope-note', trackingBilling(), 'block');

    const rules = alertRules();
    if (!rules.length) {
        list.innerHTML = '<p class="setting-desc">No alert levels yet. Add one below.</p>';
        return;
    }

    const budgets = {
        total: monthlyBilledBudget + monthlyUnbilledBudget,
        billed: monthlyBilledBudget,
        unbilled: monthlyUnbilledBudget
    };

    list.innerHTML = rules.map((rule, index) => {
        const applies = alertScopeApplies(rule.scope);
        const budget = budgets[rule.scope];
        const detail = !applies
            ? 'Inactive while billing tracking is off'
            : budget > 0
                ? 'Fires at ' + money(budget * rule.percent / 100)
                : 'No ' + rule.scope + ' budget set yet';

        return `<div class="alert-rule">
            <span class="alert-rule-scope ${applies ? attr(rule.scope) : 'inactive'}">${esc(rule.scope)}</span>
            <div class="alert-rule-body">
                <span class="alert-rule-pct">${rule.percent}%</span> of ${esc(rule.scope)} budget
                <div class="alert-rule-sub">${esc(detail)}</div>
            </div>
            <button class="icon-btn tone-red" type="button" title="Remove level"
                aria-label="Remove level" onclick="removeAlertRule(${index})">
                <svg class="icon"><use href="#i-trash" /></svg>
            </button>
        </div>`;
    }).join('');
}

async function addAlertRule() {
    const scope = $('alert-new-scope').value;
    const percent = Math.round(parseFloat($('alert-new-percent').value));

    if (!(percent > 0 && percent <= 500)) {
        showAlert('alert-rules-alert', 'Enter a percentage between 1 and 500.', 'error');
        return;
    }
    const rules = alertRules();
    if (rules.length >= MAX_ALERT_RULES) {
        showAlert('alert-rules-alert', 'That is as many levels as one budget needs.', 'error');
        return;
    }
    if (rules.some(rule => rule.scope === scope && rule.percent === percent)) {
        showAlert('alert-rules-alert', 'That level already exists.', 'error');
        return;
    }

    await saveSettings({ alertRules: rules.concat([{ scope, percent }]) });
    resetFiredAlerts();
    renderAlertRules();
    showAlert('alert-rules-alert',
        `Alert added at ${percent}% of the ${scope} budget.`, 'success');
}

async function removeAlertRule(index) {
    const rules = alertRules();
    if (index < 0 || index >= rules.length) return;
    rules.splice(index, 1);
    await saveSettings({ alertRules: rules });
    resetFiredAlerts();
    renderAlertRules();
}

async function loadCurrentMonthBudget() {
    const { year, month } = todayParts();
    const { data } = await supabase
        .from('user_budgets')
        .select('monthly_billed_budget, monthly_unbilled_budget')
        .eq('user_id', currentUser.id)
        .eq('budget_month', month)
        .eq('budget_year', year);

    const budget = data && data.length > 0 ? data[0] : null;
    const billed = budget ? parseFloat(budget.monthly_billed_budget) || 0 : 0;
    const unbilled = budget ? parseFloat(budget.monthly_unbilled_budget) || 0 : 0;

    $('billed-budget-amount').value = billed || '';
    $('unbilled-budget-amount').value = unbilled || '';
    $('total-budget-amount').value = (billed + unbilled) || '';
    updateBudgetModalTotal();
}

function updateBudgetModalTotal() {
    const box = $('budget-modal-total');
    if (!box) return;
    if (trackingBilling()) {
        const billed = parseFloat($('billed-budget-amount').value) || 0;
        const unbilled = parseFloat($('unbilled-budget-amount').value) || 0;
        box.innerHTML = '<span>Total budget</span><span>' + esc(money(billed + unbilled)) + '</span>';
    } else {
        const total = parseFloat($('total-budget-amount').value) || 0;
        box.innerHTML = '<span>Total budget</span><span>' + esc(money(total)) + '</span>';
    }
}

function closeBudgetModal() {
    closeModal('budget-modal');
}

async function handleBudgetSubmit(event) {
    event.preventDefault();

    try {
        let newBilled, newUnbilled;

        if (trackingBilling()) {
            newBilled = parseFloat($('billed-budget-amount').value) || 0;
            newUnbilled = parseFloat($('unbilled-budget-amount').value) || 0;
        } else {
            // Simple mode: one number, and every expense counts as unbilled.
            newBilled = 0;
            newUnbilled = parseFloat($('total-budget-amount').value) || 0;
        }

        if (newBilled < 0 || newUnbilled < 0) {
            showNotification('Budget amounts cannot be negative.', 'error');
            return;
        }
        if (newBilled > MAX_AMOUNT || newUnbilled > MAX_AMOUNT) {
            showNotification('Budget amount is too large.', 'error');
            return;
        }
        if (newBilled === monthlyBilledBudget && newUnbilled === monthlyUnbilledBudget) {
            showNotification('Please change a value to update the budget.', 'error');
            return;
        }

        const { year, month } = todayParts();
        const { error } = await supabase.from('user_budgets').upsert([{
            user_id: currentUser.id,
            monthly_billed_budget: newBilled,
            monthly_unbilled_budget: newUnbilled,
            budget_month: month,
            budget_year: year
        }], { onConflict: 'user_id,budget_month,budget_year' });
        if (error) throw error;

        monthlyBilledBudget = newBilled;
        monthlyUnbilledBudget = newUnbilled;
        resetFiredAlerts();

        await updateBudgetDisplay();
        updateBudgetHeader();
        updateBudgetButtonLabel();
        closeBudgetModal();
        showNotification(getCurrentMonthName() + ' budget updated', 'success');
    } catch (error) {
        console.error('Budget update error:', error);
        showNotification('Failed to update budget: ' + error.message, 'error');
    }
}

function paintProgress(barId, usedPercentage) {
    const bar = $(barId);
    if (!bar) return;
    bar.style.width = Math.min(Math.max(usedPercentage, 0), 100) + '%';
    bar.classList.toggle('over-budget', usedPercentage > 100);
    bar.classList.toggle('near-budget', usedPercentage >= 85 && usedPercentage <= 100);
}

function remainingText(label, remaining) {
    if (remaining < 0) {
        return `${label}: <span class="budget-over-text">${esc(money(Math.abs(remaining)))} over</span>`;
    }
    return `${label}: ${esc(money(remaining))}`;
}

async function updateBudgetDisplay() {
    const zero = {
        billedUsedPercentage: 0, unbilledUsedPercentage: 0, totalUsedPercentage: 0,
        billedSpent: 0, unbilledSpent: 0, totalSpent: 0
    };
    if (!currentUser) return zero;

    try {
        const { year, month } = todayParts();
        const bounds = monthBounds(year, month);

        const { data: saved, error } = await supabase
            .from('expenses')
            .select('amount, billed')
            .eq('user_id', currentUser.id)
            .gte('date', bounds.first)
            .lte('date', bounds.last);
        if (error) throw error;

        const data = saved.concat((await pendingExpenses(currentUser.id))
            .filter(row => withinRange(row.date, bounds.first, bounds.last)));

        let billedSpent = 0, unbilledSpent = 0;
        for (const expense of data) {
            const amount = parseFloat(expense.amount) || 0;
            if (expense.billed) billedSpent += amount; else unbilledSpent += amount;
        }

        const totalBudget = monthlyBilledBudget + monthlyUnbilledBudget;
        const totalSpent = billedSpent + unbilledSpent;

        // ---- Total (always shown) ----
        const totalRemaining = totalBudget - totalSpent;
        const totalUsedPercentage = totalBudget > 0 ? (totalSpent / totalBudget) * 100 : 0;

        setText('total-budget-spent', moneyShort(totalSpent));
        setText('total-budget-total', totalBudget > 0 ? moneyShort(totalBudget) : 'Not set');
        $('total-budget-remaining').innerHTML = totalBudget > 0
            ? remainingText('Remaining', totalRemaining)
            : 'Set a budget to track your pace';
        paintProgress('total-budget-progress-bar', totalUsedPercentage);

        const pace = $('total-budget-pace');
        if (totalBudget > 0) {
            const today = todayParts();
            const daysLeft = Math.max(daysInMonth(today.year, today.month) - today.day + 1, 1);
            if (totalRemaining < 0) {
                pace.textContent = 'Over budget';
                pace.classList.add('over');
            } else {
                pace.textContent = moneyShort(totalRemaining / daysLeft) + '/day for ' +
                    daysLeft + (daysLeft === 1 ? ' day' : ' days');
                pace.classList.remove('over');
            }
            pace.style.display = '';
        } else {
            pace.textContent = '';
            pace.style.display = 'none';
        }

        // ---- Billed / unbilled split ----
        const billedRemaining = monthlyBilledBudget - billedSpent;
        const unbilledRemaining = monthlyUnbilledBudget - unbilledSpent;
        const billedUsedPercentage = monthlyBilledBudget > 0
            ? (billedSpent / monthlyBilledBudget) * 100 : 0;
        const unbilledUsedPercentage = monthlyUnbilledBudget > 0
            ? (unbilledSpent / monthlyUnbilledBudget) * 100 : 0;

        setText('billed-budget-total', 'Budget: ' + moneyShort(monthlyBilledBudget));
        setText('unbilled-budget-total', 'Budget: ' + moneyShort(monthlyUnbilledBudget));
        $('billed-budget-remaining').innerHTML = remainingText('Remaining', billedRemaining);
        $('unbilled-budget-remaining').innerHTML = remainingText('Remaining', unbilledRemaining);
        paintProgress('billed-budget-progress-bar', billedUsedPercentage);
        paintProgress('unbilled-budget-progress-bar', unbilledUsedPercentage);

        return {
            billedUsedPercentage, unbilledUsedPercentage, totalUsedPercentage,
            billedSpent, unbilledSpent, totalSpent
        };
    } catch (error) {
        console.error('Failed to update budget display:', error);
        return zero;
    }
}

/** Which scopes are meaningful right now, and their spend/budget/percent. */
function budgetScopes(usage) {
    return {
        total: {
            label: 'total', spent: usage.totalSpent,
            budget: monthlyBilledBudget + monthlyUnbilledBudget,
            percent: usage.totalUsedPercentage
        },
        billed: {
            label: 'billed', spent: usage.billedSpent,
            budget: monthlyBilledBudget, percent: usage.billedUsedPercentage
        },
        unbilled: {
            label: 'unbilled', spent: usage.unbilledSpent,
            budget: monthlyUnbilledBudget, percent: usage.unbilledUsedPercentage
        }
    };
}

function alertScopeApplies(scope) {
    return scope === 'total' || trackingBilling();
}

async function checkBudgetWarnings() {
    const usage = await updateBudgetDisplay();
    if (settings.budgetAlerts === false) return;

    const scopes = budgetScopes(usage);

    // Collect every level newly crossed, but toast only the highest one per
    // scope — a single large expense shouldn't fire 50/75/90 all at once.
    const highest = {};
    const crossed = [];

    alertRules().forEach(rule => {
        if (!alertScopeApplies(rule.scope)) return;
        const scope = scopes[rule.scope];
        if (!scope || scope.budget <= 0) return;
        if (scope.percent < rule.percent) return;

        const key = alertRuleKey(rule);
        if (firedAlerts.has(key)) return;

        crossed.push(key);
        if (!highest[rule.scope] || rule.percent > highest[rule.scope].percent) {
            highest[rule.scope] = rule;
        }
    });

    if (!crossed.length) return;

    crossed.forEach(key => firedAlerts.add(key));
    saveFiredAlerts();

    ['total', 'billed', 'unbilled'].forEach(name => {
        const rule = highest[name];
        if (!rule) return;
        const scope = scopes[name];
        const prefix = name === 'total' ? 'your total budget' : 'your ' + name + ' budget';
        const message = rule.percent >= 100
            ? `You've used all of ${prefix} — ${money(scope.spent)} of ${money(scope.budget)}.`
            : `${Math.round(scope.percent)}% of ${prefix} used — ${money(scope.spent)} of ${money(scope.budget)}.`;
        showNotification(message, rule.percent >= 100 ? 'error' : 'warning', 6000);
    });
}

/* =====================================================================
   Recurring expenses
   ---------------------------------------------------------------------
   Rules live in their own table. Nothing is ever inserted behind your
   back: due items are offered on the dashboard and you add or skip them.
   The table is optional — until it exists the feature hides itself and
   the manage window shows the SQL to create it.
   ===================================================================== */

let recurringRules = [];
let recurringAvailable = true;

const RECURRING_SQL = `CREATE TABLE IF NOT EXISTS recurring_expenses (
    id               BIGSERIAL PRIMARY KEY,
    user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    amount           DECIMAL(10,2) NOT NULL CHECK (amount > 0 AND amount <= 1000000),
    type             TEXT NOT NULL,
    note             TEXT NOT NULL,
    billed           BOOLEAN NOT NULL DEFAULT FALSE,
    day_of_month     SMALLINT NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
    active           BOOLEAN NOT NULL DEFAULT TRUE,
    last_added_year  INTEGER,
    last_added_month SMALLINT,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE recurring_expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own recurring expenses"
    ON recurring_expenses FOR ALL USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_recurring_user
    ON recurring_expenses(user_id, active);`;

async function loadRecurring() {
    if (!currentUser) return;
    try {
        const { data, error } = await supabase
            .from('recurring_expenses')
            .select('*')
            .eq('user_id', currentUser.id)
            .order('day_of_month', { ascending: true });

        if (error) {
            recurringAvailable = false;
            recurringRules = [];
        } else {
            recurringAvailable = true;
            recurringRules = data || [];
        }
    } catch (error) {
        recurringAvailable = false;
        recurringRules = [];
    }
    renderRecurringDue();
}

/** Day the rule lands on this month, clamped for short months. */
function recurringDateFor(rule, year, month) {
    const day = Math.min(Number(rule.day_of_month) || 1, daysInMonth(year, month));
    return `${year}-${pad2(month)}-${pad2(day)}`;
}

function dueRecurring() {
    if (!recurringAvailable) return [];
    const { year, month, day } = todayParts();
    return recurringRules.filter(rule => {
        if (!rule.active) return false;
        if (Number(rule.last_added_year) === year && Number(rule.last_added_month) === month) {
            return false;
        }
        return day >= Math.min(Number(rule.day_of_month) || 1, daysInMonth(year, month));
    });
}

function renderRecurringDue() {
    const card = $('recurring-due');
    const list = $('recurring-due-list');
    if (!card || !list) return;

    const due = dueRecurring();
    if (!due.length) {
        card.style.display = 'none';
        return;
    }

    const { year, month } = todayParts();
    card.style.display = 'block';
    setText('recurring-due-title',
        due.length === 1 ? '1 recurring expense due' : due.length + ' recurring expenses due');

    list.innerHTML = due.map(rule => `
        <div class="recurring-due-item">
            <div class="recurring-due-main">
                <div class="recurring-due-note">${esc(rule.note)}</div>
                <div class="recurring-due-meta">
                    ${typeBadge(rule.type)}
                    ${billingBadge(rule.billed)}
                    <span>${esc(formatDate(recurringDateFor(rule, year, month)))}</span>
                </div>
            </div>
            <div class="recurring-due-amount">${esc(money(rule.amount))}</div>
            <div class="recurring-due-actions">
                <button class="icon-btn tone-green" type="button" title="Add this expense"
                    aria-label="Add this expense" onclick="addRecurringNow('${attr(rule.id)}')">
                    <svg class="icon"><use href="#i-check" /></svg>
                </button>
                <button class="icon-btn" type="button" title="Skip this month"
                    aria-label="Skip this month" onclick="skipRecurring('${attr(rule.id)}')">
                    <svg class="icon"><use href="#i-close" /></svg>
                </button>
            </div>
        </div>`).join('');

    show('recurring-add-all', due.length > 1);
}

async function markRecurringHandled(rule) {
    const { year, month } = todayParts();
    const { error } = await supabase
        .from('recurring_expenses')
        .update({ last_added_year: year, last_added_month: month })
        .eq('id', rule.id)
        .eq('user_id', currentUser.id);
    if (error) throw error;
    rule.last_added_year = year;
    rule.last_added_month = month;
}

async function addRecurringNow(id, quiet) {
    const rule = recurringRules.find(entry => String(entry.id) === String(id));
    if (!rule) return false;

    const { year, month } = todayParts();
    try {
        const { error } = await supabase.from('expenses').insert([{
            user_id: currentUser.id,
            amount: rule.amount,
            date: recurringDateFor(rule, year, month),
            type: rule.type,
            note: rule.note,
            billed: trackingBilling() ? !!rule.billed : false
        }]);
        if (error) throw error;

        await markRecurringHandled(rule);
        renderRecurringDue();

        if (!quiet) {
            await refreshAfterMutation();
            await checkBudgetWarnings();
            showNotification('Added ' + money(rule.amount) + ' · ' + rule.note, 'success');
        }
        return true;
    } catch (error) {
        showNotification('Could not add recurring expense: ' + error.message, 'error');
        return false;
    }
}

async function addAllRecurringDue() {
    const due = dueRecurring();
    if (!due.length) return;

    const button = $('recurring-add-all');
    if (button) button.disabled = true;

    let added = 0;
    for (const rule of due) {
        if (await addRecurringNow(rule.id, true)) added++;
    }

    if (button) button.disabled = false;
    renderRecurringDue();
    await refreshAfterMutation();
    await loadRecentActivity();
    await checkBudgetWarnings();
    if (added) showNotification(added + ' recurring expense(s) added', 'success');
}

async function skipRecurring(id) {
    const rule = recurringRules.find(entry => String(entry.id) === String(id));
    if (!rule) return;
    try {
        await markRecurringHandled(rule);
        renderRecurringDue();
        showNotification('Skipped for ' + getCurrentMonthName(), 'success', 2600);
    } catch (error) {
        showNotification('Could not skip: ' + error.message, 'error');
    }
}

async function showRecurringModal() {
    openModal('recurring-modal');
    $('recurring-alert').innerHTML = '';
    $('recurring-sql').textContent = RECURRING_SQL;

    await loadRecurring();
    show('recurring-unavailable', !recurringAvailable, 'block');
    show('recurring-available', recurringAvailable, 'block');
    if (!recurringAvailable) return;

    const select = $('recurring-type');
    const types = await loadTypesForEdit();
    select.innerHTML = '<option value="">Select Type</option>' +
        types.map(name => `<option value="${attr(name)}">${esc(name)}</option>`).join('');

    show('recurring-billed-group', trackingBilling());
    renderRecurringList();
}

function closeRecurringModal() {
    closeModal('recurring-modal');
    $('recurring-form').reset();
    $('recurring-billed-toggle').classList.remove('active');
    $('recurring-alert').innerHTML = '';
}

function copyRecurringSql() {
    const text = RECURRING_SQL;
    const done = () => showAlert('recurring-alert', 'SQL copied to your clipboard.', 'success');
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, () => {
            showAlert('recurring-alert', 'Copy failed — select the text manually.', 'error');
        });
    } else {
        showAlert('recurring-alert', 'Select the text above and copy it manually.', 'error');
    }
}

function renderRecurringList() {
    const list = $('recurring-list');
    if (!list) return;

    if (!recurringRules.length) {
        list.innerHTML = '<p class="setting-desc">Nothing recurring yet. Add rent, an EMI or a ' +
            'subscription above and it will be offered to you each month.</p>';
        return;
    }

    list.innerHTML = recurringRules.map(rule => `
        <div class="recurring-row ${rule.active ? '' : 'paused'}">
            <div class="recurring-row-main">
                <div class="recurring-row-note">${esc(rule.note)}</div>
                <div class="recurring-row-meta">
                    ${esc(money(rule.amount))} · ${esc(rule.type)} · day ${esc(rule.day_of_month)}${rule.active ? '' : ' · paused'}
                </div>
            </div>
            <div class="recurring-due-actions">
                <button class="icon-btn" type="button"
                    title="${rule.active ? 'Pause' : 'Resume'}"
                    aria-label="${rule.active ? 'Pause' : 'Resume'}"
                    onclick="toggleRecurringActive('${attr(rule.id)}')">
                    <svg class="icon"><use href="#${rule.active ? 'i-minus' : 'i-check'}" /></svg>
                </button>
                <button class="icon-btn tone-red" type="button" title="Delete" aria-label="Delete"
                    onclick="deleteRecurring('${attr(rule.id)}')">
                    <svg class="icon"><use href="#i-trash" /></svg>
                </button>
            </div>
        </div>`).join('');
}

function toggleRecurringBilling() {
    const toggle = $('recurring-billed-toggle');
    toggle.classList.toggle('active');
    toggle.setAttribute('aria-checked', String(toggle.classList.contains('active')));
}

async function handleRecurringSubmit(event) {
    event.preventDefault();

    const note = $('recurring-note').value.trim();
    const type = $('recurring-type').value;
    const amount = parseFloat($('recurring-amount').value);
    const day = parseInt($('recurring-day').value, 10);
    const billed = trackingBilling() && $('recurring-billed-toggle').classList.contains('active');

    const errors = validateExpenseInput(amount, type, note);
    if (!(day >= 1 && day <= 31)) errors.push('Day of month must be between 1 and 31');
    if (errors.length) {
        showAlert('recurring-alert', errors[0], 'error');
        return;
    }

    const button = $('recurring-submit');
    button.disabled = true;
    try {
        const { error } = await supabase.from('recurring_expenses').insert([{
            user_id: currentUser.id,
            amount, type, note, billed,
            day_of_month: day,
            active: true
        }]);
        if (error) throw error;

        $('recurring-form').reset();
        $('recurring-day').value = 1;
        $('recurring-billed-toggle').classList.remove('active');

        await loadRecurring();
        renderRecurringList();
        showAlert('recurring-alert', 'Recurring expense saved.', 'success');
    } catch (error) {
        showAlert('recurring-alert', error.message || 'Could not save.', 'error');
    } finally {
        button.disabled = false;
    }
}

async function toggleRecurringActive(id) {
    const rule = recurringRules.find(entry => String(entry.id) === String(id));
    if (!rule) return;
    try {
        const { error } = await supabase
            .from('recurring_expenses')
            .update({ active: !rule.active })
            .eq('id', id).eq('user_id', currentUser.id);
        if (error) throw error;
        rule.active = !rule.active;
        renderRecurringList();
        renderRecurringDue();
    } catch (error) {
        showAlert('recurring-alert', error.message, 'error');
    }
}

async function deleteRecurring(id) {
    const rule = recurringRules.find(entry => String(entry.id) === String(id));
    if (!rule) return;
    if (!confirm('Delete the recurring rule "' + rule.note + '"? Expenses already added are kept.')) {
        return;
    }
    try {
        const { error } = await supabase
            .from('recurring_expenses').delete()
            .eq('id', id).eq('user_id', currentUser.id);
        if (error) throw error;
        recurringRules = recurringRules.filter(entry => String(entry.id) !== String(id));
        renderRecurringList();
        renderRecurringDue();
        showAlert('recurring-alert', 'Recurring rule deleted.', 'success');
    } catch (error) {
        showAlert('recurring-alert', error.message, 'error');
    }
}

/* =====================================================================
   Analytics modal
   ===================================================================== */

function showVisualizationModal() {
    openModal('visualization-modal');
    applyBillingMode();
    loadTypesForFilter();
    applyDateFilter();
}

function closeVisualizationModal() {
    closeModal('visualization-modal');
    if (currentChart) {
        currentChart.destroy();
        currentChart = null;
    }
    clearPendingEdits('filtered');
}

async function loadTypesForFilter() {
    try {
        const { data, error } = await supabase.from('expense_types').select('name').order('name');
        if (error) throw error;
        const select = $('type-filter');
        const previous = select.value;
        select.innerHTML = '<option value="all">All Types</option>';
        data.forEach(type => {
            const option = document.createElement('option');
            option.value = type.name;
            option.textContent = type.name;
            select.appendChild(option);
        });
        if (previous) select.value = previous;
    } catch (error) {
        console.error('Failed to load types for filter:', error);
    }
}

function applyRangePreset(preset) {
    const { year, month } = todayParts();
    const today = todayISO();
    let start = '', end = today;

    if (preset === 'this-month') {
        start = monthBounds(year, month).first;
    } else if (preset === 'last-month') {
        const prev = previousMonth(year, month);
        const bounds = monthBounds(prev.year, prev.month);
        start = bounds.first;
        end = bounds.last;
    } else if (preset === 'last-30') {
        start = addDaysISO(today, -29);
    } else if (preset === 'this-year') {
        start = year + '-01-01';
    } else if (preset === 'all') {
        start = '';
        end = '';
    }

    $('start-date').value = start;
    $('end-date').value = end;

    document.querySelectorAll('#range-presets .chip').forEach(chip => {
        chip.classList.toggle('active', chip.getAttribute('onclick').indexOf("'" + preset + "'") !== -1);
    });

    applyDateFilter();
}

async function applyDateFilter() {
    const startDate = $('start-date').value;
    const endDate = $('end-date').value;
    const billingFilter = trackingBilling() ? $('billing-filter').value : 'both';
    const typeFilter = $('type-filter').value;

    try {
        let query = supabase.from('expenses').select('*');
        if (startDate) query = query.gte('date', startDate);
        if (endDate) query = query.lte('date', endDate);
        if (billingFilter === 'billed') query = query.eq('billed', true);
        if (billingFilter === 'unbilled') query = query.eq('billed', false);
        if (typeFilter !== 'all') query = query.eq('type', typeFilter);

        const { data, error } = await query.order('date', { ascending: false });
        if (error) throw error;

        filteredExpenses = data || [];
    } catch (error) {
        console.error('Failed to filter expenses:', error);
        filteredExpenses = [];
        showNotification('Could not load expenses for that filter.', 'error');
    }

    clearPendingEdits('filtered');
    updateChart(currentChartType);
    showExpenseList();
}

function updateChartType(type) {
    currentChartType = type;
    document.querySelectorAll('#chart-toolbar .seg').forEach(button => {
        button.classList.toggle('active', button.dataset.chart === type);
    });
    updateChart(type);
}

/**
 * Show/hide a DOM overlay over a chart canvas. Painting the message onto
 * the canvas is unreliable — after Chart#destroy the backing store size
 * and DPR transform are no longer ours to reason about.
 */
function setChartEmptyState(canvas, message) {
    if (!canvas || !canvas.parentNode) return;
    const holder = canvas.parentNode;
    if (getComputedStyle(holder).position === 'static') holder.style.position = 'relative';

    let overlay = holder.querySelector('.chart-empty');
    if (!message) {
        if (overlay) overlay.remove();
        canvas.style.visibility = '';
        return;
    }
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'chart-empty';
        holder.appendChild(overlay);
    }
    overlay.textContent = message;
    canvas.style.visibility = 'hidden';
}

function updateChart(chartType) {
    const canvas = $('expenseChart');
    if (!canvas || !chartsAvailable()) return;
    const context = canvas.getContext('2d');

    if (currentChart) {
        currentChart.destroy();
        currentChart = null;
    }
    if (filteredExpenses.length === 0) {
        setChartEmptyState(canvas, 'No expenses in this range');
        return;
    }
    setChartEmptyState(canvas, null);

    applyChartDefaults();
    const moneyTick = value => moneyShort(value);
    let config;

    if (chartType === 'line') {
        config = {
            type: 'line',
            data: prepareLineChartData(),
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    title: { display: true, text: 'Cumulative spend over time' },
                    legend: { display: false },
                    tooltip: {
                        callbacks: { label: ctx => 'Total: ' + money(ctx.parsed.y) }
                    }
                },
                scales: {
                    x: axisConfig(),
                    y: axisConfig({ beginAtZero: true, ticks: { color: chartInk(), callback: moneyTick } })
                }
            }
        };
    } else if (chartType === 'bubble') {
        config = {
            type: 'bubble',
            data: prepareBubbleChartData(),
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    title: { display: true, text: 'Types by amount and frequency' },
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: ctx => `${ctx.raw.label}: ${money(ctx.raw.y)} · ${ctx.raw.x} txn`
                        }
                    }
                },
                scales: {
                    x: axisConfig({ title: { display: true, text: 'Transactions', color: chartInk() } }),
                    y: axisConfig({
                        beginAtZero: true,
                        title: { display: true, text: 'Amount', color: chartInk() },
                        ticks: { color: chartInk(), callback: moneyTick }
                    })
                }
            }
        };
    } else {
        const data = prepareTypeChartData();
        const isHorizontal = chartType === 'horizontalBar';
        const isDoughnut = chartType === 'doughnut';

        config = {
            type: isHorizontal ? 'bar' : chartType,
            data,
            options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: isHorizontal ? 'y' : 'x',
                cutout: isDoughnut ? '62%' : undefined,
                plugins: {
                    title: { display: true, text: 'Spend by type' },
                    legend: { position: 'bottom', display: isDoughnut },
                    tooltip: {
                        callbacks: {
                            label: function (ctx) {
                                const value = isDoughnut ? ctx.parsed
                                    : (isHorizontal ? ctx.parsed.x : ctx.parsed.y);
                                return ctx.label + ': ' + money(value);
                            }
                        }
                    }
                },
                scales: isDoughnut ? {} : {
                    [isHorizontal ? 'x' : 'y']: axisConfig({
                        beginAtZero: true,
                        ticks: { color: chartInk(), callback: moneyTick }
                    }),
                    [isHorizontal ? 'y' : 'x']: axisConfig()
                }
            }
        };
    }

    currentChart = new Chart(context, config);
}

function totalsByType() {
    const totals = {};
    filteredExpenses.forEach(expense => {
        totals[expense.type] = (totals[expense.type] || 0) + (parseFloat(expense.amount) || 0);
    });
    return totals;
}

function prepareTypeChartData() {
    const totals = totalsByType();
    const labels = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
    return {
        labels,
        datasets: [{
            label: 'Amount',
            data: labels.map(label => totals[label]),
            backgroundColor: labels.map(label => categoryColor(label).chart),
            borderWidth: 0,
            borderRadius: 6
        }]
    };
}

function prepareLineChartData() {
    const daily = {};
    filteredExpenses.forEach(expense => {
        daily[expense.date] = (daily[expense.date] || 0) + (parseFloat(expense.amount) || 0);
    });

    const sortedDates = Object.keys(daily).sort();
    let running = 0;
    const cumulative = sortedDates.map(date => (running += daily[date]));

    return {
        labels: sortedDates.map(formatDate),
        datasets: [{
            label: 'Cumulative',
            data: cumulative,
            borderColor: '#6366f1',
            backgroundColor: 'rgba(99, 102, 241, 0.14)',
            borderWidth: 2.5,
            pointRadius: sortedDates.length > 40 ? 0 : 3,
            pointHoverRadius: 5,
            fill: true,
            tension: 0.35
        }]
    };
}

function prepareBubbleChartData() {
    const byType = {};
    filteredExpenses.forEach(expense => {
        if (!byType[expense.type]) byType[expense.type] = { total: 0, count: 0 };
        byType[expense.type].total += parseFloat(expense.amount) || 0;
        byType[expense.type].count += 1;
    });

    const labels = Object.keys(byType);
    return {
        datasets: [{
            label: 'Expense types',
            data: labels.map(label => ({
                x: byType[label].count,
                y: byType[label].total,
                r: Math.max(Math.sqrt(byType[label].total) * 0.5, 8),
                label
            })),
            backgroundColor: labels.map(label => categoryColor(label).chart + 'cc'),
            borderColor: labels.map(label => categoryColor(label).chart),
            borderWidth: 2
        }]
    };
}

/* ---------------------------------------------------------------------
   Editable list under the chart
   --------------------------------------------------------------------- */

function showExpenseList() {
    const mount = $('filtered-list-mount');
    if (!mount) return;

    if (filteredExpenses.length === 0) {
        mount.innerHTML = '';
        return;
    }

    const total = filteredExpenses.reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);
    const rows = filteredExpenses
        .map(expense => expenseItemMarkup(expense, 'filtered')).join('');

    mount.innerHTML = `
        <div class="expense-list-container">
            <div class="panel-title">Filtered expenses (${filteredExpenses.length})</div>
            <div class="expense-list-scroll">${rows}</div>
            <div class="list-total"><span class="expense-total">Total: ${esc(money(total))}</span></div>
            <div style="display:flex;justify-content:flex-end;margin-top:1rem;">
                <button class="save-changes-btn" type="button" data-save-scope="filtered"
                    onclick="saveAllChanges('filtered')">Save Changes</button>
            </div>
        </div>`;

    updateSaveButton();
}

function setIcon(button, symbolId) {
    button.innerHTML = '<svg class="icon"><use href="#' + symbolId + '" /></svg>';
}

/* ---------------------------------------------------------------------
   Inline editing, in both lists

   Two lists show expenses and both can be edited in place: Recent Expenses
   on the dashboard, and the filtered list inside Analytics. They can show
   the *same* expense at the same time, so nothing below may be keyed on the
   expense id alone — every lookup, every element id and every pending-edit
   record carries the scope that owns the row. Getting this wrong meant a
   click in one list silently rewrote the other.
   --------------------------------------------------------------------- */

const EDIT_SCOPES = {
    recent: {
        mount: 'expenses-container',
        rows: () => (($('expenses-container') || {})._rows) || [],
        remove: id => deleteExpense(id, true)
    },
    filtered: {
        mount: 'filtered-list-mount',
        rows: () => filteredExpenses,
        remove: id => deleteFilteredExpense(id)
    }
};

function editKey(scope, expenseId) { return scope + ':' + expenseId; }

// Forget one list's half-finished edits, leaving the other list's alone.
function clearPendingEdits(scope) {
    Array.from(editedExpenses)
        .filter(key => key.indexOf(scope + ':') === 0)
        .forEach(key => { editedExpenses.delete(key); delete expenseEdits[key]; });
    updateSaveButton();
}

function expenseRow(scope, expenseId) {
    const spec = EDIT_SCOPES[scope];
    const mount = spec && $(spec.mount);
    if (!mount) return null;
    const wanted = String(expenseId);
    const rows = mount.querySelectorAll('[data-id]');
    for (let i = 0; i < rows.length; i++) {
        if (rows[i].getAttribute('data-id') === wanted) return rows[i];
    }
    return null;
}

function expenseInScope(scope, expenseId) {
    return EDIT_SCOPES[scope].rows()
        .find(row => String(row.id) === String(expenseId)) || null;
}

/**
 * One row of an expense list. Both lists render the same shape — the
 * data-original attributes are what edit mode reads the pre-edit values back
 * out of, so a row without them cannot be edited or cancelled.
 *
 * `leading` is markup for any extra action button that belongs to this list
 * alone, such as Repeat on the dashboard.
 */
function expenseItemMarkup(expense, scope, leading) {
    const id = attr(expense.id);

    // A queued expense has no database row yet, so there is nothing to edit,
    // repeat or bin — only to wait for, or to throw away before it goes.
    if (expense.pending) {
        return `
        <div class="expense-item is-pending" data-id="${id}">
            <div class="expense-details">
                <div class="expense-amount">${esc(money(expense.amount))}</div>
                <div class="expense-note">${esc(expense.note) || 'No description'}</div>
                <div class="expense-meta">
                    <span class="expense-type" style="${typeStyleAttr(expense.type)}">${esc(expense.type)}</span>
                    <span class="pending-badge">PENDING</span>
                    <span class="expense-date">${esc(formatDate(expense.date))}</span>
                </div>
            </div>
            <div class="expense-actions">
                <button class="icon-btn tone-red" type="button"
                    title="Discard this queued expense" aria-label="Discard this queued expense"
                    onclick="discardQueued('${id}')">
                    <svg class="icon"><use href="#i-trash" /></svg>
                </button>
            </div>
        </div>`;
    }

    return `
        <div class="expense-item" data-id="${id}">
            <div class="expense-details">
                <div class="expense-amount" data-original="${attr(expense.amount)}">${esc(money(expense.amount))}</div>
                <div class="expense-note" data-original="${attr(expense.note || '')}">${esc(expense.note) || 'No description'}</div>
                <div class="expense-meta">
                    <span class="expense-type" data-original="${attr(expense.type)}" style="${typeStyleAttr(expense.type)}">${esc(expense.type)}</span>
                    <span class="billed-status" data-billed="${attr(expense.billed)}">${billingBadge(expense.billed)}</span>
                    <span class="expense-date" data-original="${attr(expense.date)}">${esc(formatDate(expense.date))}</span>
                </div>
            </div>
            <div class="expense-actions">
                <div class="edit-toggle-container" id="edit-container-${attr(scope)}-${id}">
                    <div class="billed-toggle ${expense.billed ? 'active' : ''}"
                        onclick="toggleBillingStatus('${attr(scope)}', '${id}')"></div>
                </div>
                ${leading || ''}
                <button class="icon-btn tone-indigo" type="button" id="edit-icon-${attr(scope)}-${id}"
                    title="Edit expense" aria-label="Edit expense"
                    onclick="toggleEditMode('${attr(scope)}', '${id}')">
                    <svg class="icon"><use href="#i-pencil" /></svg>
                </button>
                <button class="icon-btn tone-red" type="button" id="delete-btn-${attr(scope)}-${id}"
                    title="Delete expense" aria-label="Delete expense"
                    onclick="removeExpenseFrom('${attr(scope)}', '${id}')">
                    <svg class="icon"><use href="#i-trash" /></svg>
                </button>
            </div>
        </div>`;
}

function removeExpenseFrom(scope, expenseId) {
    EDIT_SCOPES[scope].remove(expenseId);
}

async function createEditableElements(scope, expenseId) {
    const item = expenseRow(scope, expenseId);
    if (!item) return;
    const key = attr(scope) + "', '" + attr(expenseId);

    const amountEl = item.querySelector('.expense-amount');
    amountEl.innerHTML = `<input type="number" step="0.01" min="0" max="${MAX_AMOUNT}"
        value="${attr(parseFloat(amountEl.dataset.original))}" inputmode="decimal"
        oninput="trackExpenseChange('${key}')">`;

    const noteEl = item.querySelector('.expense-note');
    noteEl.innerHTML = `<input type="text" value="${attr(noteEl.dataset.original)}"
        placeholder="Add description…" maxlength="${MAX_NOTE_LENGTH}"
        oninput="trackExpenseChange('${key}')">`;

    const typeEl = item.querySelector('.expense-type');
    const originalType = typeEl.dataset.original;
    const types = await loadTypesForEdit();
    if (types.indexOf(originalType) === -1) types.unshift(originalType);
    typeEl.innerHTML = `<select onchange="trackExpenseChange('${key}')">
        ${types.map(name =>
        `<option value="${attr(name)}"${name === originalType ? ' selected' : ''}>${esc(name)}</option>`
    ).join('')}</select>`;

    const dateEl = item.querySelector('.expense-date');
    dateEl.innerHTML = `<input type="date" value="${attr(dateEl.dataset.original)}"
        onchange="trackExpenseChange('${key}')">`;
}

function restoreStaticElements(scope, expenseId) {
    const item = expenseRow(scope, expenseId);
    if (!item) return;
    const edits = expenseEdits[editKey(scope, expenseId)] || {};

    const amountEl = item.querySelector('.expense-amount');
    const amount = edits.amount !== undefined ? edits.amount : parseFloat(amountEl.dataset.original);
    amountEl.textContent = money(amount);

    const noteEl = item.querySelector('.expense-note');
    const note = edits.note !== undefined ? edits.note : noteEl.dataset.original;
    noteEl.textContent = note || 'No description';

    const typeEl = item.querySelector('.expense-type');
    const type = edits.type !== undefined ? edits.type : typeEl.dataset.original;
    typeEl.textContent = type;
    typeEl.setAttribute('style', typeStyleAttr(type));

    const dateEl = item.querySelector('.expense-date');
    const date = edits.date !== undefined ? edits.date : dateEl.dataset.original;
    dateEl.textContent = formatDate(date);
}

function ensureEditRecord(scope, expenseId) {
    const key = editKey(scope, expenseId);
    if (expenseEdits[key]) return expenseEdits[key];

    const item = expenseRow(scope, expenseId);
    if (!item) return null;

    const billedEl = item.querySelector('.billed-status');
    expenseEdits[key] = {
        id: expenseId,
        scope: scope,
        originalAmount: parseFloat(item.querySelector('.expense-amount').dataset.original),
        originalNote: item.querySelector('.expense-note').dataset.original,
        originalType: item.querySelector('.expense-type').dataset.original,
        originalDate: item.querySelector('.expense-date').dataset.original,
        originalBilled: billedEl.dataset.billed === 'true',
        billed: billedEl.dataset.billed === 'true'
    };
    return expenseEdits[key];
}

function recomputeDirty(scope, expenseId) {
    const key = editKey(scope, expenseId);
    const record = expenseEdits[key];
    if (!record) return;
    const changed =
        (record.amount !== undefined && record.amount !== record.originalAmount) ||
        (record.note !== undefined && record.note !== record.originalNote) ||
        (record.type !== undefined && record.type !== record.originalType) ||
        (record.date !== undefined && record.date !== record.originalDate) ||
        (record.billed !== undefined && record.billed !== record.originalBilled);

    if (changed) editedExpenses.add(key);
    else editedExpenses.delete(key);
    updateSaveButton();
}

function trackExpenseChange(scope, expenseId) {
    const item = expenseRow(scope, expenseId);
    if (!item) return;
    const record = ensureEditRecord(scope, expenseId);
    if (!record) return;

    const amountInput = item.querySelector('.expense-amount input');
    const noteInput = item.querySelector('.expense-note input');
    const typeSelect = item.querySelector('.expense-type select');
    const dateInput = item.querySelector('.expense-date input');

    if (amountInput) record.amount = parseFloat(amountInput.value) || 0;
    if (noteInput) record.note = noteInput.value.trim();
    if (typeSelect) record.type = typeSelect.value;
    if (dateInput) record.date = dateInput.value;

    recomputeDirty(scope, expenseId);
}

function toggleBillingStatus(scope, expenseId) {
    const container = $('edit-container-' + scope + '-' + expenseId);
    const toggle = container ? container.querySelector('.billed-toggle') : null;
    if (!toggle) return;
    const record = ensureEditRecord(scope, expenseId);
    if (!record) return;
    toggle.classList.toggle('active');
    record.billed = toggle.classList.contains('active');
    recomputeDirty(scope, expenseId);
}

function toggleEditMode(scope, expenseId) {
    const container = $('edit-container-' + scope + '-' + expenseId);
    const editBtn = $('edit-icon-' + scope + '-' + expenseId);
    const deleteBtn = $('delete-btn-' + scope + '-' + expenseId);
    const item = expenseRow(scope, expenseId);
    if (!container || !editBtn || !deleteBtn || !item) return;

    const isEditing = item.classList.contains('edit-mode');

    if (isEditing) {
        item.classList.remove('edit-mode');
        restoreStaticElements(scope, expenseId);

        const record = expenseEdits[editKey(scope, expenseId)];
        const billedEl = item.querySelector('.billed-status');
        if (record && record.billed !== undefined && billedEl) {
            billedEl.innerHTML = billingBadge(record.billed);
            billedEl.dataset.billed = String(record.billed);
        }

        container.style.display = 'none';
        deleteBtn.style.display = '';

        if (editedExpenses.has(editKey(scope, expenseId))) {
            setIcon(deleteBtn, 'i-close');
            deleteBtn.title = 'Discard changes';
            deleteBtn.onclick = () => cancelEdit(scope, expenseId);
        } else {
            setIcon(deleteBtn, 'i-trash');
            deleteBtn.title = 'Delete expense';
            deleteBtn.onclick = () => removeExpenseFrom(scope, expenseId);
        }

        setIcon(editBtn, 'i-pencil');
        editBtn.classList.remove('tone-green');
        editBtn.classList.add('tone-indigo');
    } else {
        item.classList.add('edit-mode');
        ensureEditRecord(scope, expenseId);
        createEditableElements(scope, expenseId);

        container.style.display = trackingBilling() ? 'flex' : 'none';

        setIcon(editBtn, 'i-check');
        editBtn.classList.remove('tone-indigo');
        editBtn.classList.add('tone-green');

        setIcon(deleteBtn, 'i-close');
        deleteBtn.title = 'Discard changes';
        deleteBtn.onclick = () => cancelEdit(scope, expenseId);
        deleteBtn.style.display = '';
    }

    updateSaveButton();
}

function cancelEdit(scope, expenseId) {
    const container = $('edit-container-' + scope + '-' + expenseId);
    const editBtn = $('edit-icon-' + scope + '-' + expenseId);
    const deleteBtn = $('delete-btn-' + scope + '-' + expenseId);
    const item = expenseRow(scope, expenseId);
    const expense = expenseInScope(scope, expenseId);
    if (!item || !expense) return;

    editedExpenses.delete(editKey(scope, expenseId));
    delete expenseEdits[editKey(scope, expenseId)];
    item.classList.remove('edit-mode');

    const amountEl = item.querySelector('.expense-amount');
    amountEl.textContent = money(expense.amount);
    amountEl.dataset.original = expense.amount;

    const noteEl = item.querySelector('.expense-note');
    noteEl.textContent = expense.note || 'No description';
    noteEl.dataset.original = expense.note || '';

    const typeEl = item.querySelector('.expense-type');
    typeEl.textContent = expense.type;
    typeEl.dataset.original = expense.type;
    typeEl.setAttribute('style', typeStyleAttr(expense.type));

    const dateEl = item.querySelector('.expense-date');
    dateEl.textContent = formatDate(expense.date);
    dateEl.dataset.original = expense.date;

    const billedEl = item.querySelector('.billed-status');
    billedEl.innerHTML = billingBadge(expense.billed);
    billedEl.dataset.billed = String(expense.billed);

    const toggle = container ? container.querySelector('.billed-toggle') : null;
    if (toggle) toggle.classList.toggle('active', !!expense.billed);
    if (container) container.style.display = 'none';

    setIcon(deleteBtn, 'i-trash');
    deleteBtn.title = 'Delete expense';
    deleteBtn.onclick = () => removeExpenseFrom(scope, expenseId);
    deleteBtn.style.display = '';

    setIcon(editBtn, 'i-pencil');
    editBtn.classList.remove('tone-green');
    editBtn.classList.add('tone-indigo');

    updateSaveButton();
}

// Each list carries its own Save Changes button, and only shows it when that
// list has something pending. A dirty row in Analytics must not put a live
// Save button on the dashboard behind it.
function updateSaveButton() {
    Object.keys(EDIT_SCOPES).forEach(scope => {
        const button = document.querySelector('[data-save-scope="' + scope + '"]');
        if (!button) return;
        const pending = Array.from(editedExpenses)
            .filter(key => key.indexOf(scope + ':') === 0).length;
        button.style.display = pending > 0 ? 'block' : 'none';
        button.textContent = pending > 1
            ? 'Save ' + pending + ' Changes'
            : 'Save Changes';
    });
}

async function saveAllChanges(scope) {
    const button = document.querySelector('[data-save-scope="' + scope + '"]');
    if (button) button.disabled = true;

    const keys = Array.from(editedExpenses)
        .filter(key => key.indexOf(scope + ':') === 0);

    try {
        for (const key of keys) {
            const changes = expenseEdits[key];
            if (!changes) continue;

            const update = {};
            if (changes.amount !== undefined && changes.amount !== changes.originalAmount) {
                if (!changes.amount || changes.amount <= 0 || changes.amount > MAX_AMOUNT) {
                    throw new Error('Amount must be between ₹1 and ₹10,00,000');
                }
                update.amount = changes.amount;
            }
            if (changes.note !== undefined && changes.note !== changes.originalNote) {
                update.note = changes.note;
            }
            if (changes.type !== undefined && changes.type !== changes.originalType) {
                update.type = changes.type;
            }
            if (changes.date !== undefined && changes.date !== changes.originalDate) {
                if (!splitISO(changes.date)) throw new Error('Please pick a valid date');
                update.date = changes.date;
            }
            if (changes.billed !== undefined && changes.billed !== changes.originalBilled) {
                update.billed = changes.billed;
            }
            if (Object.keys(update).length === 0) continue;

            const { error } = await supabase.from('expenses')
                .update(update).eq('id', changes.id).eq('user_id', currentUser.id);
            if (error) throw error;

            editedExpenses.delete(key);
            delete expenseEdits[key];
        }

        // Both lists are redrawn: the same expense may be showing in the
        // other one, still displaying the value that has just been replaced.
        if ($('visualization-modal').classList.contains('open')) await applyDateFilter();
        await Promise.all([loadExpenses(), updateStatistics(), updateBudgetDisplay()]);
        await checkBudgetWarnings();
        showNotification('Changes saved', 'success');
    } catch (error) {
        showNotification('Failed to save changes: ' + error.message, 'error');
    } finally {
        if (button) button.disabled = false;
        updateSaveButton();
    }
}

/* =====================================================================
   Export
   ===================================================================== */

async function fetchExportRows() {
    const startDate = $('start-date').value;
    const endDate = $('end-date').value;
    const billingFilter = trackingBilling() ? $('billing-filter').value : 'both';
    const typeFilter = $('type-filter').value;

    let query = supabase.from('expenses').select('*');
    if (startDate) query = query.gte('date', startDate);
    if (endDate) query = query.lte('date', endDate);
    if (billingFilter === 'billed') query = query.eq('billed', true);
    if (billingFilter === 'unbilled') query = query.eq('billed', false);
    if (typeFilter !== 'all') query = query.eq('type', typeFilter);

    const { data, error } = await query.order('date', { ascending: false });
    if (error) throw error;

    return { rows: data || [], startDate, endDate, billingFilter, typeFilter };
}

function exportFilename(startDate, endDate, typeFilter, billingFilter, extension) {
    let name = 'expenses';
    if (startDate && endDate) {
        name += startDate === endDate ? '_' + startDate : '_' + startDate + '_to_' + endDate;
    } else if (startDate) {
        name += '_from_' + startDate;
    } else if (endDate) {
        name += '_until_' + endDate;
    }
    if (typeFilter !== 'all') name += '_' + typeFilter.replace(/[^\w-]+/g, '-');
    if (trackingBilling()) name += '_' + billingFilter;
    return name + '.' + extension;
}

/** Body rows + totals + (for single-month exports) the budget summary. */
async function buildExportMatrix(rows, startDate, endDate) {
    const tracking = trackingBilling();
    const headers = tracking
        ? ['Date', 'Type', 'Note', 'Amount', 'Billed']
        : ['Date', 'Type', 'Note', 'Amount'];

    const body = rows.map(expense => {
        const base = [expense.date, expense.type, expense.note || '', Number(expense.amount)];
        return tracking ? base.concat(expense.billed ? 'Yes' : 'No') : base;
    });

    // Summary rows always put their caption in the Note column and their
    // figure in the Amount column — fixed positions 2 and 3, since the
    // optional "Billed" column is appended after them.
    const NOTE_COL = 2, AMOUNT_COL = 3;
    const width = headers.length;
    const blank = () => new Array(width).fill('');
    const labelRow = (label, value) => {
        const row = blank();
        row[NOTE_COL] = label;
        row[AMOUNT_COL] = value;
        return row;
    };

    const total = rows.reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);
    body.push(blank());
    body.push(labelRow('TOTAL', Number(total.toFixed(2))));

    const start = splitISO(startDate);
    const end = splitISO(endDate);
    const singleMonth = start && end && start.year === end.year && start.month === end.month;

    if (singleMonth) {
        try {
            const { data: budget } = await supabase
                .from('user_budgets')
                .select('monthly_billed_budget, monthly_unbilled_budget')
                .eq('user_id', currentUser.id)
                .eq('budget_month', start.month)
                .eq('budget_year', start.year)
                .maybeSingle();

            const billedBudget = budget ? parseFloat(budget.monthly_billed_budget) || 0 : 0;
            const unbilledBudget = budget ? parseFloat(budget.monthly_unbilled_budget) || 0 : 0;

            if (billedBudget > 0 || unbilledBudget > 0) {
                const billedSpent = rows.filter(e => e.billed)
                    .reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);
                const unbilledSpent = rows.filter(e => !e.billed)
                    .reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);

                body.push(blank());
                if (tracking) {
                    if (billedBudget > 0) {
                        body.push(labelRow('BILLED BUDGET', billedBudget));
                        body.push(labelRow('BILLED SPENT', Number(billedSpent.toFixed(2))));
                        body.push(labelRow('BILLED REMAINING', Number((billedBudget - billedSpent).toFixed(2))));
                        body.push(blank());
                    }
                    if (unbilledBudget > 0) {
                        body.push(labelRow('UNBILLED BUDGET', unbilledBudget));
                        body.push(labelRow('UNBILLED SPENT', Number(unbilledSpent.toFixed(2))));
                        body.push(labelRow('UNBILLED REMAINING', Number((unbilledBudget - unbilledSpent).toFixed(2))));
                        body.push(blank());
                    }
                }
                const totalBudget = billedBudget + unbilledBudget;
                body.push(labelRow('TOTAL BUDGET', totalBudget));
                body.push(labelRow('TOTAL SPENT', Number(total.toFixed(2))));
                body.push(labelRow('TOTAL REMAINING', Number((totalBudget - total).toFixed(2))));
            }
        } catch (error) {
            console.error('Failed to fetch budget for export month:', error);
        }
    }

    return [headers].concat(body);
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportToXLSX() {
    if (typeof XLSX === 'undefined') {
        showNotification('The spreadsheet library did not load. Reload the page and try again.', 'error');
        return;
    }
    try {
        const { rows, startDate, endDate, billingFilter, typeFilter } = await fetchExportRows();
        if (!rows.length) {
            showNotification('No expenses to export for the selected filters.', 'warning');
            return;
        }
        const matrix = await buildExportMatrix(rows, startDate, endDate);
        const sheet = XLSX.utils.aoa_to_sheet(matrix);
        sheet['!cols'] = [{ wch: 12 }, { wch: 18 }, { wch: 40 }, { wch: 14 }, { wch: 10 }]
            .slice(0, matrix[0].length);
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, sheet, 'Expenses');
        XLSX.writeFile(book, exportFilename(startDate, endDate, typeFilter, billingFilter, 'xlsx'));
        showNotification(rows.length + ' expenses exported', 'success');
    } catch (error) {
        console.error('Excel export failed:', error);
        showNotification('Failed to export: ' + error.message, 'error');
    }
}

/**
 * Complete, restorable snapshot of everything this account owns — not the
 * filtered view the Excel export gives you.
 */
async function downloadFullBackup() {
    const button = $('backup-btn');
    if (button) { button.disabled = true; button.textContent = 'Preparing…'; }

    try {
        const fetchAll = async (table, order) => {
            const query = supabase.from(table).select('*').eq('user_id', currentUser.id);
            const { data, error } = order ? await query.order(order) : await query;
            if (error) throw error;
            return data || [];
        };

        const [expenses, types, budgets] = await Promise.all([
            fetchAll('expenses', 'date'),
            fetchAll('expense_types', 'name'),
            fetchAll('user_budgets')
        ]);

        let recurring = [];
        try {
            recurring = await fetchAll('recurring_expenses');
        } catch (error) {
            /* Optional table — omitted from the backup when absent. */
        }

        const backup = {
            format: 'my-expense-tracker-backup',
            version: 1,
            exportedAt: new Date().toISOString(),
            exportedFor: currentUser.email,
            timezone: APP_TIMEZONE,
            counts: {
                expenses: expenses.length, expense_types: types.length,
                user_budgets: budgets.length, recurring_expenses: recurring.length
            },
            settings,
            data: {
                expenses, expense_types: types,
                user_budgets: budgets, recurring_expenses: recurring
            }
        };

        downloadBlob(
            new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }),
            'expense-tracker-backup-' + todayISO() + '.json');
        showNotification(expenses.length + ' expenses backed up', 'success');
    } catch (error) {
        console.error('Backup failed:', error);
        showNotification('Backup failed: ' + error.message, 'error');
    } finally {
        if (button) { button.disabled = false; button.textContent = 'Download backup'; }
    }
}

/* =====================================================================
   Search
   ===================================================================== */

function showSearchModal() {
    openModal('search-modal');
    $('search-results').innerHTML = '<div class="skeleton-row"></div>'.repeat(3);
    loadAllExpensesForSearch();
    setTimeout(() => $('search-input').focus(), 60);
}

function closeSearchModal() {
    closeModal('search-modal');
    $('search-input').value = '';
    $('search-results').innerHTML = '';
}

async function loadAllExpensesForSearch() {
    try {
        const { data, error } = await supabase
            .from('expenses').select('*').order('date', { ascending: false });
        if (error) throw error;
        allExpensesCache = data || [];
        performSearch();
    } catch (error) {
        console.error('Failed to load expenses for search:', error);
        $('search-results').innerHTML =
            '<div class="empty-state"><p>Could not load expenses.</p></div>';
    }
}

function highlight(text, term) {
    const safe = esc(text);
    // Skip highlighting when the term contains characters that esc()
    // rewrites — matching against the escaped string would split entities.
    if (!term || /[&<>]/.test(term)) return safe;
    const pattern = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return safe.replace(new RegExp('(' + pattern + ')', 'gi'), '<mark>$1</mark>');
}

function performSearch() {
    const term = $('search-input').value.trim().toLowerCase();
    const results = $('search-results');

    let matches = allExpensesCache;
    if (term) {
        matches = allExpensesCache.filter(expense =>
            (expense.note || '').toLowerCase().includes(term) ||
            String(expense.type).toLowerCase().includes(term) ||
            String(expense.amount).includes(term) ||
            formatDate(expense.date).toLowerCase().includes(term)
        );
    }

    if (matches.length === 0) {
        results.innerHTML =
            '<div class="empty-state"><div class="empty-state-icon">🔍</div><p>No expenses found</p></div>';
        return;
    }

    const total = matches.reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);
    const capped = matches.slice(0, 200);

    results.innerHTML = `
        <div class="search-summary">${matches.length} expense${matches.length === 1 ? '' : 's'} · ${esc(money(total))}</div>
        ${capped.map(expense => `
            <div class="expense-item">
                <div class="expense-details">
                    <div class="expense-amount">${esc(money(expense.amount))}</div>
                    <div class="expense-note">${highlight(expense.note || 'No description', term)}</div>
                    <div class="expense-meta">
                        ${typeBadge(expense.type)}
                        ${billingBadge(expense.billed)}
                        <span>${esc(formatDate(expense.date))}</span>
                    </div>
                </div>
            </div>`).join('')}
        ${matches.length > capped.length
            ? `<p class="muted-sm" style="text-align:center;padding:.75rem;">Showing the first ${capped.length} of ${matches.length}. Refine your search to narrow it down.</p>`
            : ''}`;
}

/* =====================================================================
   Insights
   ===================================================================== */

/* Chart handles live in module state, never on `window`. The browser
   exposes every element id as a window property, so a handle stored at
   `window.velocityChart` reads back the <canvas id="velocityChart">
   before first assignment — and then `.destroy()` throws. */
let insightsChart = null;
let velocityChart = null;
let insightsChartData = null;
let velocityChartData = null;
let velocitySource = [];

function showInsightsModal() {
    openModal('insights-modal');
    $('insights-content').innerHTML = '<div class="skeleton-row" style="height:320px"></div>';
    loadSpendingInsights();
}

function closeInsightsModal() {
    closeModal('insights-modal');
    if (insightsChart) {
        insightsChart.destroy();
        insightsChart = null;
    }
    if (velocityChart) {
        velocityChart.destroy();
        velocityChart = null;
    }
    insightsChartData = null;
    velocityChartData = null;
}

async function loadSpendingInsights() {
    try {
        const { data, error } = await supabase
            .from('expenses').select('note, amount, date, type, billed')
            .order('date', { ascending: false });
        if (error) throw error;
        displayInsights(calculateInsights(data || []), data || []);
    } catch (error) {
        console.error('Failed to load insights:', error);
        $('insights-content').innerHTML =
            '<div class="empty-state"><p>Could not load insights.</p></div>';
    }
}

function calculateInsights(expenses) {
    const { year, month, day } = todayParts();
    const bounds = monthBounds(year, month);
    const prev = previousMonth(year, month);
    const prevBounds = monthBounds(prev.year, prev.month);

    const thisMonth = expenses.filter(e => withinRange(e.date, bounds.first, bounds.last));
    const lastMonth = expenses.filter(e => withinRange(e.date, prevBounds.first, prevBounds.last));

    const thisMonthTotal = thisMonth.reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);
    const lastMonthTotal = lastMonth.reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);
    const monthlyChange = lastMonthTotal > 0
        ? ((thisMonthTotal - lastMonthTotal) / lastMonthTotal) * 100 : 0;

    const categoryTotals = {};
    thisMonth.forEach(e => {
        categoryTotals[e.type] = (categoryTotals[e.type] || 0) + (parseFloat(e.amount) || 0);
    });
    const topCategories = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1]).slice(0, 6);

    const dailyAverage = thisMonthTotal / Math.max(day, 1);
    const projectedMonthly = dailyAverage * daysInMonth(year, month);

    const highestExpense = thisMonth.length
        ? thisMonth.reduce((max, e) => parseFloat(e.amount) > parseFloat(max.amount) ? e : max) : null;
    const lowestExpense = thisMonth.length
        ? thisMonth.reduce((min, e) => parseFloat(e.amount) < parseFloat(min.amount) ? e : min) : null;

    // Group by the stored month string — never via a Date, which would
    // shift month boundaries for devices outside IST.
    const monthlyData = {};
    expenses.forEach(expense => {
        const parts = splitISO(expense.date);
        if (!parts) return;
        const key = parts.year + '-' + pad2(parts.month);
        if (!monthlyData[key]) monthlyData[key] = { billed: 0, unbilled: 0, total: 0 };
        const amount = parseFloat(expense.amount) || 0;
        monthlyData[key].total += amount;
        if (expense.billed) monthlyData[key].billed += amount;
        else monthlyData[key].unbilled += amount;
    });

    // Per-day totals for the heatmap.
    const dailyTotals = {};
    thisMonth.forEach(expense => {
        const parts = splitISO(expense.date);
        if (!parts) return;
        dailyTotals[parts.day] = (dailyTotals[parts.day] || 0) + (parseFloat(expense.amount) || 0);
    });

    return {
        thisMonthTotal, lastMonthTotal, monthlyChange, topCategories,
        dailyAverage, projectedMonthly, highestExpense, lowestExpense,
        totalExpenses: thisMonth.length,
        avgPerTransaction: thisMonth.length ? thisMonthTotal / thisMonth.length : 0,
        monthlyData, dailyTotals
    };
}

/**
 * Calendar heatmap of the current month. Blank cells are days with no
 * entry — the point is to make the gaps visible so you backfill them.
 */
function renderMonthHeatmap(dailyTotals) {
    const mount = $('month-heatmap');
    if (!mount) return;

    const { year, month, day: today } = todayParts();
    const total = daysInMonth(year, month);
    // Monday-first column index for the 1st of the month.
    const firstWeekday = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;

    const values = Object.keys(dailyTotals).map(key => dailyTotals[key]);
    const peak = safeMax(values);
    let logged = 0;

    const cells = [];
    for (let i = 0; i < firstWeekday; i++) {
        cells.push('<div class="heat-cell heat-pad" aria-hidden="true"></div>');
    }

    for (let date = 1; date <= total; date++) {
        const amount = dailyTotals[date] || 0;
        const future = date > today;
        if (amount > 0) logged++;

        // Square-root scale, not linear: one big outlier (rent) would
        // otherwise flatten every ordinary day into the palest bucket.
        let level = 0;
        if (amount > 0 && peak > 0) {
            level = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(amount / peak) * 4)));
        }

        const classes = ['heat-cell', 'level-' + level];
        if (date === today) classes.push('is-today');
        if (future) classes.push('is-future');
        if (!future && amount === 0) classes.push('is-empty');

        const label = `${date} ${MONTH_NAMES[month - 1]}: ` +
            (amount > 0 ? money(amount) : future ? 'upcoming' : 'nothing logged');
        cells.push(`<div class="${classes.join(' ')}" title="${attr(label)}">${date}</div>`);
    }

    const missed = Math.max(today - logged, 0);
    mount.innerHTML = `
        <div class="panel">
            <div class="panel-title">${esc(monthLabel(year, month, false))} — daily spend</div>
            <div class="heat-week-labels">
                ${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(d =>
        `<span>${d}</span>`).join('')}
            </div>
            <div class="heat-grid">${cells.join('')}</div>
            <div class="heat-legend">
                <span>${logged} of ${today} day${today === 1 ? '' : 's'} logged${missed ? ` · ${missed} blank` : ''}</span>
                <span class="heat-scale">
                    less
                    ${[0, 1, 2, 3, 4].map(l => `<i class="heat-cell level-${l}"></i>`).join('')}
                    more
                </span>
            </div>
        </div>`;
}

function displayInsights(insights, allExpenses) {
    const container = $('insights-content');
    const { day: currentDay } = todayParts();
    const tracking = trackingBilling();

    const changeUp = insights.monthlyChange > 0;
    const changeCard = insights.lastMonthTotal > 0
        ? `${changeUp ? '+' : ''}${insights.monthlyChange.toFixed(1)}%`
        : '—';

    container.innerHTML = `
        <div class="insights-grid">
            <div class="insight-card c-indigo">
                <h4>This month</h4>
                <div class="insight-value">${esc(moneyShort(insights.thisMonthTotal))}</div>
                <div class="insight-sub">${insights.totalExpenses} transaction${insights.totalExpenses === 1 ? '' : 's'}</div>
            </div>
            <div class="insight-card ${changeUp ? 'c-rose' : 'c-green'}">
                <h4>vs last month</h4>
                <div class="insight-value">${esc(changeCard)}</div>
                <div class="insight-sub">${esc(moneyShort(insights.lastMonthTotal))} last month</div>
            </div>
            <div class="insight-card c-sky">
                <h4>Daily average</h4>
                <div class="insight-value">${esc(moneyShort(insights.dailyAverage))}</div>
                <div class="insight-sub">Projected ${esc(moneyShort(insights.projectedMonthly))}</div>
            </div>
            <div class="insight-card c-amber">
                <h4>Per transaction</h4>
                <div class="insight-value">${esc(moneyShort(insights.avgPerTransaction))}</div>
                <div class="insight-sub">Average this month</div>
            </div>
        </div>

        <div id="month-heatmap"></div>

        <div class="chart-container" style="margin-top:1.25rem;"><canvas id="monthlyTrendChart"></canvas></div>
        ${tracking ? `
        <div class="radio-bar" id="insights-view-bar">
            <label class="radio-pill checked"><input type="radio" name="insightsDataView" value="consolidated" checked onchange="updateInsightsChart()"> All</label>
            <label class="radio-pill"><input type="radio" name="insightsDataView" value="billed" onchange="updateInsightsChart()"> Billed</label>
            <label class="radio-pill"><input type="radio" name="insightsDataView" value="unbilled" onchange="updateInsightsChart()"> Unbilled</label>
            <label class="radio-pill"><input type="radio" name="insightsDataView" value="total" onchange="updateInsightsChart()"> Total only</label>
        </div>` : ''}

        <div class="chart-container" style="margin-top:1.25rem;"><canvas id="velocityChart"></canvas></div>
        <div class="radio-bar" id="insights-type-bar">
            <label class="radio-pill checked"><input type="radio" name="velocityChartType" value="bar" checked onchange="updateBothChartTypes()"> Bars</label>
            <label class="radio-pill"><input type="radio" name="velocityChartType" value="line" onchange="updateBothChartTypes()"> Lines</label>
        </div>

        <div class="slider-panel">
            <div class="panel-title" style="text-align:center;">Compare spending by day of month</div>
            <div class="slider-row">
                <span class="slider-label">Day 1 →</span>
                <input type="range" id="velocity-day-slider" min="1" max="31" value="${currentDay}"
                    oninput="updateVelocityByDay(this.value)" aria-label="Day of month">
                <span class="slider-value" id="velocity-day-display">${currentDay}</span>
            </div>
            <p class="muted-sm" style="text-align:center;margin-top:.5rem;">
                Compares the same stretch of each month, so a part-way month is judged fairly.</p>
        </div>

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem;margin-top:1.5rem;">
            <div class="panel">
                <div class="panel-title">Top categories this month</div>
                ${insights.topCategories.length ? insights.topCategories.map(([category, amount], index) => `
                    <div class="rank-row">
                        <span class="rank-name"><span class="rank-num">${index + 1}</span>${esc(category)}</span>
                        <span class="rank-value">${esc(money(amount))}</span>
                    </div>`).join('') : '<p class="muted-sm">No spending yet this month.</p>'}
            </div>
            <div class="panel">
                <div class="panel-title">Expense range</div>
                ${insights.highestExpense ? `
                    <div class="extreme-card high">
                        <div class="extreme-label">Highest</div>
                        <div class="extreme-value">${esc(money(insights.highestExpense.amount))}</div>
                        <div class="extreme-note">${esc(insights.highestExpense.note) || 'No description'}</div>
                        <div class="extreme-meta">${esc(insights.highestExpense.type)} · ${esc(formatDate(insights.highestExpense.date))}</div>
                    </div>` : ''}
                ${insights.lowestExpense ? `
                    <div class="extreme-card low">
                        <div class="extreme-label">Lowest</div>
                        <div class="extreme-value">${esc(money(insights.lowestExpense.amount))}</div>
                        <div class="extreme-note">${esc(insights.lowestExpense.note) || 'No description'}</div>
                        <div class="extreme-meta">${esc(insights.lowestExpense.type)} · ${esc(formatDate(insights.lowestExpense.date))}</div>
                    </div>` : '<p class="muted-sm">No expenses this month.</p>'}
            </div>
        </div>`;

    wireRadioPills();
    renderMonthHeatmap(insights.dailyTotals || {});

    if (!chartsAvailable()) return;

    const sortedMonths = Object.keys(insights.monthlyData)
        .filter(key => insights.monthlyData[key].total > 0)
        .sort()
        .slice(-12);

    insightsChartData = { sortedMonths, monthlyData: insights.monthlyData };
    velocitySource = allExpenses;

    renderMonthlyTrendChart('bar');
    renderVelocityChart(currentDay, 'bar');
}

/** Older Safari lacks :has(); mirror the checked state onto a class. */
function wireRadioPills() {
    document.querySelectorAll('#insights-content .radio-bar').forEach(bar => {
        const sync = () => bar.querySelectorAll('.radio-pill').forEach(pill => {
            const input = pill.querySelector('input');
            pill.classList.toggle('checked', !!(input && input.checked));
        });
        bar.addEventListener('change', sync);
        sync();
    });
}

function monthKeyLabel(key) {
    const [year, month] = key.split('-');
    return monthLabel(Number(year), Number(month), true);
}

function insightsDatasets(chartType) {
    const { sortedMonths, monthlyData } = insightsChartData;
    const view = trackingBilling()
        ? (document.querySelector('input[name="insightsDataView"]:checked') || {}).value || 'consolidated'
        : 'total';
    const fill = chartType === 'line';

    const series = {
        total: {
            label: 'Total', key: 'total', color: '#6366f1', soft: 'rgba(99,102,241,.18)'
        },
        billed: {
            label: 'Billed', key: 'billed', color: '#10b981', soft: 'rgba(16,185,129,.18)'
        },
        unbilled: {
            label: 'Unbilled', key: 'unbilled', color: '#f43f5e', soft: 'rgba(244,63,94,.18)'
        }
    };

    const build = (name, primary) => ({
        label: series[name].label,
        data: sortedMonths.map(month => monthlyData[month][series[name].key]),
        borderColor: series[name].color,
        backgroundColor: chartType === 'bar' ? series[name].color : series[name].soft,
        borderWidth: primary ? 2.5 : 2,
        fill: fill && primary,
        tension: 0.35,
        borderRadius: 6,
        pointRadius: 3
    });

    if (view === 'consolidated') return [build('total', true), build('billed', false), build('unbilled', false)];
    if (view === 'billed') return [build('billed', true)];
    if (view === 'unbilled') return [build('unbilled', true)];
    return [build('total', true)];
}

function renderMonthlyTrendChart(chartType) {
    const canvas = $('monthlyTrendChart');
    if (!canvas || !insightsChartData) return;

    if (insightsChart) {
        insightsChart.destroy();
        insightsChart = null;
    }

    const { sortedMonths } = insightsChartData;
    if (!sortedMonths.length) {
        setChartEmptyState(canvas, 'No spending recorded yet');
        return;
    }
    setChartEmptyState(canvas, null);

    const datasets = insightsDatasets(chartType);
    const peak = safeMax(datasets.flatMap(dataset => dataset.data));

    insightsChart = new Chart(canvas.getContext('2d'), {
        type: chartType,
        data: { labels: sortedMonths.map(monthKeyLabel), datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                title: { display: true, text: 'Monthly spending trend' },
                legend: { display: datasets.length > 1, position: 'bottom' },
                tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + money(ctx.parsed.y) } }
            },
            scales: {
                x: axisConfig(),
                y: axisConfig({
                    beginAtZero: true,
                    max: calculateMaxValue(peak),
                    ticks: {
                        color: chartInk(),
                        callback: value => moneyShort(value),
                        stepSize: calculateStepSize(peak),
                        maxTicksLimit: 8
                    }
                })
            }
        }
    });
}

function velocityTotals(day) {
    const expenses = velocitySource || [];
    const { year, month } = todayParts();
    const labels = [];
    const data = [];

    for (let back = 5; back >= 0; back--) {
        let targetMonth = month - back;
        let targetYear = year;
        while (targetMonth <= 0) {
            targetMonth += 12;
            targetYear -= 1;
        }
        const first = `${targetYear}-${pad2(targetMonth)}-01`;
        const cutoffDay = Math.min(day, daysInMonth(targetYear, targetMonth));
        const cutoff = `${targetYear}-${pad2(targetMonth)}-${pad2(cutoffDay)}`;

        const total = expenses
            .filter(expense => withinRange(expense.date, first, cutoff))
            .reduce((sum, expense) => sum + (parseFloat(expense.amount) || 0), 0);

        labels.push(monthLabel(targetYear, targetMonth, true));
        data.push(total);
    }
    return { labels, data };
}

function renderVelocityChart(day, chartType) {
    const canvas = $('velocityChart');
    if (!canvas) return;

    if (velocityChart) {
        velocityChart.destroy();
        velocityChart = null;
    }

    const { labels, data } = velocityTotals(Number(day));
    velocityChartData = { labels, data, currentDay: Number(day) };
    const peak = safeMax(data);

    velocityChart = new Chart(canvas.getContext('2d'), {
        type: chartType,
        data: {
            labels,
            datasets: [{
                label: 'Spend through day ' + day,
                data,
                backgroundColor: data.map((_, index) =>
                    index === data.length - 1 ? 'rgba(244,63,94,.75)' : 'rgba(99,102,241,.72)'),
                borderColor: data.map((_, index) =>
                    index === data.length - 1 ? '#f43f5e' : '#6366f1'),
                borderWidth: 2,
                borderRadius: 6,
                tension: 0.35,
                pointRadius: 3,
                fill: chartType === 'line'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                title: { display: true, text: `Spending velocity — first ${day} days of each month` },
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function (ctx) {
                            const previous = data[ctx.dataIndex - 1];
                            const lines = ['Amount: ' + money(ctx.parsed.y)];
                            if (ctx.dataIndex > 0 && previous > 0) {
                                const change = ((ctx.parsed.y - previous) / previous) * 100;
                                lines.push('Change: ' + (change >= 0 ? '+' : '') + change.toFixed(1) + '%');
                            }
                            return lines;
                        }
                    }
                }
            },
            scales: {
                x: axisConfig(),
                y: axisConfig({
                    beginAtZero: true,
                    max: calculateMaxValue(peak),
                    ticks: {
                        color: chartInk(),
                        callback: value => moneyShort(value),
                        stepSize: calculateStepSize(peak),
                        maxTicksLimit: 8
                    }
                })
            }
        }
    });
}

function selectedInsightsChartType() {
    const checked = document.querySelector('input[name="velocityChartType"]:checked');
    return checked ? checked.value : 'bar';
}

function updateInsightsChart() {
    renderMonthlyTrendChart(selectedInsightsChartType());
}

function updateBothChartTypes() {
    const chartType = selectedInsightsChartType();
    renderMonthlyTrendChart(chartType);
    const day = velocityChartData ? velocityChartData.currentDay : todayParts().day;
    renderVelocityChart(day, chartType);
}

let velocityRedrawTimer = null;

// Declared as a function (not a debounced const) so the inline
// oninput="updateVelocityByDay(...)" attribute can resolve it.
function updateVelocityByDay(day) {
    setText('velocity-day-display', String(day));
    clearTimeout(velocityRedrawTimer);
    velocityRedrawTimer = setTimeout(() => {
        renderVelocityChart(Number(day), selectedInsightsChartType());
    }, 90);
}

/* =====================================================================
   Profile
   ===================================================================== */

function currentDisplayName() {
    const meta = currentUser && currentUser.user_metadata ? currentUser.user_metadata : {};
    return meta.display_name || meta.name || meta.full_name || '';
}

function showEditProfile() {
    $('edit-profile-alert').innerHTML = '';
    $('profile-password-alert').innerHTML = '';
    $('profile-password-form').reset();
    show('save-profile-btn', false);
    openModal('edit-profile-modal');

    $('profile-name').value = currentDisplayName();
    $('profile-email').value = currentUser.email;

    $('profile-name').oninput = checkProfileChanges;
    $('profile-email').oninput = checkProfileChanges;
    $('profile-name').focus();
}

function closeEditProfileModal() {
    closeModal('edit-profile-modal');
    $('edit-profile-form').reset();
    $('edit-profile-alert').innerHTML = '';
    $('profile-password-form').reset();
    $('profile-password-alert').innerHTML = '';
    show('save-profile-btn', false);
}

function checkProfileChanges() {
    const nameChanged = $('profile-name').value.trim() !== currentDisplayName();
    const emailChanged = $('profile-email').value.trim() !== currentUser.email;
    show('save-profile-btn', nameChanged || emailChanged, 'flex');
}

async function handleEditProfile(event) {
    event.preventDefault();

    const newName = $('profile-name').value.trim();
    const newEmail = $('profile-email').value.trim();
    const nameChanged = newName !== currentDisplayName();
    const emailChanged = newEmail !== currentUser.email;

    if (!nameChanged && !emailChanged) {
        closeEditProfileModal();
        return;
    }

    try {
        if (nameChanged) {
            const { error } = await supabase.auth.updateUser({
                data: { display_name: newName, name: newName, full_name: newName }
            });
            if (error) throw error;
            setText('user-name', 'Welcome, ' + newName + '!');
            setText('user-avatar', newName.charAt(0).toUpperCase());
        }

        if (emailChanged) {
            localStorage.setItem('pendingEmailChange', JSON.stringify({
                oldEmail: currentUser.email, newEmail, timestamp: Date.now()
            }));

            const { error } = await supabase.auth.updateUser(
                { email: newEmail },
                { emailRedirectTo: window.location.origin + '?type=email_change' }
            );
            if (error) throw error;

            showAlert('edit-profile-alert',
                'Verification sent to both your current and new email. Open the link in each to finish the change.',
                'success');

            setTimeout(async () => {
                await supabase.auth.signOut();
                currentUser = null;
                closeEditProfileModal();
                showSignIn();
                showNotification('Signed out. Check your email for the verification link.', 'info', 5000);
            }, 5000);
            return;
        }

        showAlert('edit-profile-alert', 'Name updated successfully!', 'success');
        setTimeout(() => {
            closeEditProfileModal();
            showNotification('Profile updated', 'success');
        }, 1200);
    } catch (error) {
        showAlert('edit-profile-alert', error.message, 'error');
    }
}

async function handleEmailChangeConfirmation() {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    const type = params.get('type');
    if (type !== 'email_change' || !token) return;

    try {
        const { error } = await supabase.auth.verifyOtp({ token_hash: token, type: 'email_change' });
        if (error) throw error;

        localStorage.removeItem('pendingEmailChange');
        await supabase.auth.signOut();
        localStorage.removeItem('supabase.auth.token');
        const projectId = supabaseUrl.split('//')[1] ? supabaseUrl.split('//')[1].split('.')[0] : null;
        if (projectId) localStorage.removeItem('sb-' + projectId + '-auth-token');

        currentUser = null;
        isPasswordResetFlow = false;
        showNotification('Email changed. Please sign in with your new address.', 'success', 5000);
        showSignIn();
    } catch (error) {
        console.error('Email change verification error:', error);
        showNotification('Email verification failed. Please try again.', 'error');
        showSignIn();
    } finally {
        window.history.replaceState({}, document.title, window.location.pathname);
    }
}

/* =====================================================================
   Import
   ===================================================================== */

let importParsedRows = [];
let importValidRows = [];

const BASE_IMPORT_HEADERS = ['Note', 'Type', 'Amount', 'Date'];
const BILLED_IMPORT_HEADER = 'Billed/Unbilled';

function showImportExpenses() {
    resetImportModal();
    applyBillingMode();
    openModal('import-expenses-modal');
}

function closeImportExpensesModal() {
    closeModal('import-expenses-modal');
    resetImportModal();
}

function resetImportModal() {
    importParsedRows = [];
    importValidRows = [];
    show('import-step-upload', true, 'block');
    show('import-step-progress', false);
    show('import-step-review', false);
    show('import-step-done', false);
    $('import-alert').innerHTML = '';
    $('import-file-input').value = '';
    $('import-preview-body').innerHTML = '';
    const confirmBtn = $('confirm-import-btn');
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Confirm & Upload Valid Rows';
}

function initImportExpensesUI() {
    const dropzone = $('import-dropzone');
    const fileInput = $('import-file-input');
    const sampleLink = $('download-sample-csv');
    if (!dropzone) return;

    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            fileInput.click();
        }
    });
    dropzone.addEventListener('dragover', event => {
        event.preventDefault();
        dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', event => {
        event.preventDefault();
        dropzone.classList.remove('dragover');
        if (event.dataTransfer.files.length) handleImportFile(event.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', event => {
        if (event.target.files.length) handleImportFile(event.target.files[0]);
    });
    sampleLink.addEventListener('click', event => {
        event.preventDefault();
        downloadSampleCsv();
    });
}

function downloadSampleCsv() {
    const tracking = trackingBilling();
    const header = BASE_IMPORT_HEADERS.concat(tracking ? [BILLED_IMPORT_HEADER] : []).join(',');
    const example = ['Lunch with team', 'Food', '500', '01/01/2026']
        .concat(tracking ? ['Unbilled'] : []).join(',');
    downloadBlob(new Blob([header + '\n' + example + '\n'], { type: 'text/csv' }),
        'expense_import_sample.csv');
}

function handleImportFile(file) {
    if (typeof XLSX === 'undefined') {
        showAlert('import-alert', 'The spreadsheet library did not load. Reload the page and try again.', 'error');
        return;
    }

    const reader = new FileReader();
    reader.onerror = () => showAlert('import-alert', 'Could not read that file.', 'error');
    reader.onload = event => {
        try {
            // readAsArrayBuffer, not readAsBinaryString: the latter is
            // deprecated and unreliable in Safari.
            const bytes = new Uint8Array(event.target.result);
            const workbook = XLSX.read(bytes, { type: 'array', cellDates: false });
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });

            if (!rows.length) {
                showAlert('import-alert', 'The file appears to be empty.', 'error');
                return;
            }

            const headers = Object.keys(rows[0]).map(header => header.trim());
            const required = BASE_IMPORT_HEADERS.concat(
                trackingBilling() ? [BILLED_IMPORT_HEADER] : []);
            const missing = required.filter(header => headers.indexOf(header) === -1);
            if (missing.length) {
                showAlert('import-alert', 'Missing required column(s): ' + missing.join(', '), 'error');
                return;
            }

            importParsedRows = rows;
            runImportValidation(rows);
        } catch (error) {
            console.error('Import parse error:', error);
            showAlert('import-alert',
                'Could not read this file. Please check the format and try again.', 'error');
        }
    };
    reader.readAsArrayBuffer(file);
}

async function runImportValidation(rows) {
    show('import-step-upload', false);
    show('import-step-progress', true, 'block');

    const progressBar = $('import-progress-bar');
    const progressLabel = $('import-progress-label');
    const successCounter = $('import-progress-success');
    const failedCounter = $('import-progress-failed');

    const validTypes = await loadTypesForEdit();
    const validated = [];
    let successCount = 0;
    let failedCount = 0;

    // Yield to the browser periodically instead of sleeping per row —
    // a 500-row file used to take 20 seconds of pure delay.
    const chunk = Math.max(1, Math.floor(rows.length / 60));

    for (let i = 0; i < rows.length; i++) {
        const result = validateImportRow(rows[i], validTypes);
        validated.push(result);
        if (result.valid) successCount++; else failedCount++;

        if (i % chunk === 0 || i === rows.length - 1) {
            progressLabel.textContent = `Checking row ${i + 1} of ${rows.length}…`;
            progressBar.style.width = Math.round(((i + 1) / rows.length) * 100) + '%';
            successCounter.textContent = '✓ ' + successCount + ' valid';
            failedCounter.textContent = '✕ ' + failedCount + ' failed';
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    importValidRows = validated;
    showImportReview(validated);
}

function normalizeTypeKey(value) {
    return String(value || '').replace(/[^a-zA-Z]/g, '').toLowerCase();
}

function parseDDMMYYYY(raw) {
    const match = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(String(raw).trim());
    if (!match) return null;

    const day = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const year = parseInt(match[3], 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (day > daysInMonth(year, month)) return null;

    return `${year}-${pad2(month)}-${pad2(day)}`;
}

function validateImportRow(raw, validTypes) {
    const tracking = trackingBilling();
    const note = String(raw['Note'] || '').trim();
    const typeInput = String(raw['Type'] || '').trim();
    const amountRaw = String(raw['Amount'] || '').trim().replace(/[,\s₹]/g, '');
    const dateRaw = String(raw['Date'] || '').trim();
    const billedRaw = String(raw[BILLED_IMPORT_HEADER] || '').trim().toLowerCase();

    const issues = [];
    if (!note) issues.push('Missing note');
    if (note.length > MAX_NOTE_LENGTH) issues.push('Note is too long');

    let matchedType = null;
    if (!typeInput) {
        issues.push('Missing type');
    } else {
        const key = normalizeTypeKey(typeInput);
        matchedType = validTypes.find(type => normalizeTypeKey(type) === key) || null;
        if (!matchedType) issues.push('Unknown type "' + typeInput + '"');
    }

    let amount = NaN;
    if (!amountRaw) {
        issues.push('Missing amount');
    } else if (!/^\d+$/.test(amountRaw)) {
        issues.push('Amount must be a whole number (no decimals)');
    } else {
        amount = parseInt(amountRaw, 10);
        if (amount <= 0) issues.push('Invalid amount');
        else if (amount > MAX_AMOUNT) issues.push('Amount exceeds ₹10,00,000');
    }

    const isoDate = parseDDMMYYYY(dateRaw);
    if (!isoDate) issues.push('Invalid date (use DD/MM/YYYY)');

    let billed = false;
    if (tracking) {
        if (billedRaw === 'billed') billed = true;
        else if (billedRaw === 'unbilled') billed = false;
        else issues.push('Billed/Unbilled must be "Billed" or "Unbilled"');
    }

    return {
        note,
        type: matchedType || typeInput,
        amount,
        date: isoDate || dateRaw,
        displayDate: dateRaw,
        billed,
        valid: issues.length === 0,
        issues
    };
}

function showImportReview(rows) {
    show('import-step-progress', false);
    show('import-step-review', true, 'block');

    const tracking = trackingBilling();
    const validCount = rows.filter(row => row.valid).length;
    const failedCount = rows.length - validCount;

    setText('import-summary-banner',
        `${rows.length} row(s) read — ${validCount} valid, ${failedCount} failed.`);

    $('import-preview-body').innerHTML = rows.map(row => `
        <tr class="${row.valid ? '' : 'row-invalid'}">
            <td><span class="import-row-status ${row.valid ? 'valid' : 'invalid'}">${row.valid ? '✓ Valid' : '✕ Failed'}</span></td>
            <td>${esc(row.note)}</td>
            <td>${esc(row.type)}</td>
            <td>${isNaN(row.amount) ? '—' : esc(moneyShort(row.amount))}</td>
            <td>${esc(row.displayDate || row.date)}</td>
            <td class="col-billed"${tracking ? '' : ' style="display:none"'}>${row.billed ? 'Billed' : 'Unbilled'}</td>
            <td style="color:var(--red-ink);font-size:.8rem;">${esc(row.issues.join(', '))}</td>
        </tr>`).join('');

    document.querySelectorAll('.import-preview-table .col-billed')
        .forEach(cell => { cell.style.display = tracking ? '' : 'none'; });

    const confirmBtn = $('confirm-import-btn');
    confirmBtn.disabled = validCount === 0;
    confirmBtn.textContent = validCount === 0
        ? 'No valid rows to upload'
        : `Confirm & Upload ${validCount} Valid Row${validCount === 1 ? '' : 's'}`;
}

function cancelImportReview() {
    resetImportModal();
}

async function confirmImportUpload() {
    const toInsert = importValidRows.filter(row => row.valid).map(row => ({
        user_id: currentUser.id,
        amount: row.amount,
        date: row.date,
        type: row.type,
        note: row.note,
        billed: trackingBilling() ? row.billed : false
    }));
    if (!toInsert.length) return;

    const confirmBtn = $('confirm-import-btn');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Uploading…';

    try {
        // Chunked so a large import doesn't hit request-size limits.
        const size = 200;
        for (let i = 0; i < toInsert.length; i += size) {
            const { error } = await supabase.from('expenses').insert(toInsert.slice(i, i + size));
            if (error) throw error;
        }

        const failedCount = importValidRows.length - toInsert.length;
        show('import-step-review', false);
        show('import-step-done', true, 'block');
        setText('import-done-title', 'Import complete');
        setText('import-done-summary',
            toInsert.length + ' expense(s) imported successfully' +
            (failedCount > 0 ? ', ' + failedCount + ' row(s) skipped due to errors.' : '.'));

        await Promise.all([loadExpenses(), updateStatistics(), updateBudgetDisplay()]);
        await loadRecentActivity();
        await checkBudgetWarnings();
        showNotification(toInsert.length + ' expenses imported', 'success');
    } catch (error) {
        console.error('Import upload error:', error);
        showAlert('import-alert', 'Failed to upload expenses: ' + error.message, 'error');
        show('import-step-review', true, 'block');
        show('import-step-done', false);
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Retry Upload';
    }
}

/* =====================================================================
   Misc listeners
   ===================================================================== */

window.addEventListener('resize', debounce(() => {
    const row = $('recent-types-row');
    if (row && row.style.display !== 'none') loadRecentTypeBubbles();
}, 250));

// Follow the OS theme when the user hasn't chosen one explicitly.
if (localStorage.getItem('darkMode') === null && window.matchMedia) {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    isDarkMode = query.matches;
    const onChange = event => {
        if (localStorage.getItem('darkMode') !== null) return;
        isDarkMode = event.matches;
        applyTheme();
    };
    if (query.addEventListener) query.addEventListener('change', onChange);
    else if (query.addListener) query.addListener(onChange);
}
