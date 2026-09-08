/* =====================================================================
   Service worker — the app opens with no signal

   Without this the manifest made the app installable and then it white-
   screened the moment the network dropped, which is the worst of both: it
   looks like a native app and behaves like a dead tab.

   Bump CACHE on every deploy. The old shell is thrown away on activate, so
   a stale script.js can never outlive the index.html that points at it.
   ===================================================================== */

const CACHE = 'expense-tracker-v1.2.0';

const SHELL = [
    './',
    './index.html',
    './manifest.json',
    './style.css',
    './script.js',
    './scan.js',
    './offline.js',
    './admin.js',
    './icons/favicon-32x32.png',
    './icons/apple-touch-icon.png',
    './icons/android-chrome-192x192.png',
    './icons/android-chrome-512x512.png'
];

self.addEventListener('install', function (event) {
    event.waitUntil(
        caches.open(CACHE).then(function (cache) {
            // One at a time: cache.addAll rejects the whole install if any
            // single file 404s, which would leave the app with no cache at all
            // and no sign that anything went wrong.
            return Promise.all(SHELL.map(function (url) {
                return cache.add(url).catch(function () { /* skip what is missing */ });
            }));
        }).then(function () { return self.skipWaiting(); })
    );
});

self.addEventListener('activate', function (event) {
    event.waitUntil(
        caches.keys().then(function (keys) {
            return Promise.all(keys
                .filter(function (key) { return key !== CACHE; })
                .map(function (key) { return caches.delete(key); }));
        }).then(function () { return self.clients.claim(); })
    );
});

self.addEventListener('fetch', function (event) {
    const req = event.request;

    // Never touch anything but plain GETs — a queued expense is the outbox's
    // job, not the cache's.
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // Cross-origin traffic is left entirely alone. Supabase calls carry auth
    // and must always be live; the CDNs manage their own HTTP caching; and
    // the receipt reader must never be answered from a cache.
    if (url.origin !== self.location.origin) return;

    // Netlify functions are live calls that happen to be same-origin.
    if (url.pathname.indexOf('/.netlify/') === 0) return;

    // Navigations: try the network so a deploy actually lands, and fall back
    // to the cached shell so the app still opens with no signal.
    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req).then(function (res) {
                const copy = res.clone();
                caches.open(CACHE).then(function (cache) { cache.put('./index.html', copy); });
                return res;
            }).catch(function () {
                return caches.match('./index.html').then(function (hit) {
                    return hit || new Response(
                        '<h1>Offline</h1><p>Reconnect and reopen Expense Tracker.</p>',
                        { headers: { 'Content-Type': 'text/html' } });
                });
            })
        );
        return;
    }

    // Static assets: serve from cache at once, refresh in the background.
    // ignoreSearch so the ?v= cache-buster on script.js and style.css does
    // not turn every deploy's first load into a miss on a dead network.
    event.respondWith(
        caches.match(req, { ignoreSearch: true }).then(function (hit) {
            const live = fetch(req).then(function (res) {
                if (res && res.status === 200 && res.type === 'basic') {
                    const copy = res.clone();
                    caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
                }
                return res;
            }).catch(function () { return hit; });
            return hit || live;
        })
    );
});
