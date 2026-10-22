// sw.js — SpendWise Service Worker with caching strategy

// The deploy workflow replaces 'spendwise-dev' with the commit id, so every deploy gets a fresh cache
const CACHE_NAME = 'spendwise-dev';
const STATIC_ASSETS = [
  './',
  './index.html',
  './expense.html',
  './income.html',
  './history.html',
  './debt.html',
  './insights.html',
  './assets/css/style.css',
  './assets/css/tokens.css',
  './assets/css/responsive.css',
  './assets/js/utils/currency.js',
  './assets/js/utils/helpers.js',
  './assets/js/config/firebase.js',
  './assets/js/config/ai.js',
  './assets/js/theme.js',
  './assets/js/dashboard.js',
  './assets/js/event-delegation.js',
  './assets/js/income.js',
  './assets/js/debt.js',
  './assets/js/modules/auth.js',
  './assets/js/modules/voice-command.js',
  './assets/js/modules/insights-v2.js',
  './assets/js/modules/network-status.js',
  './assets/js/modules/offline-queue.js',
  './assets/js/modules/csv-upload.js',
  './assets/js/modules/backup.js',
  './assets/js/modules/accessibility.js',
  './assets/js/modules/reminders.js',
  './assets/js/modules/insights-data.js',
  './assets/js/modules/sms-parse.js',
  './assets/js/modules/history-data.js',
  './assets/images/logo-96.png',
  './assets/images/logo-192.png',
  './manifest.json',
  'https://unpkg.com/lucide@0.378.0/dist/umd/lucide.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap'
];

// Install: cache static assets
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // 'reload' skips the browser's HTTP cache so a new deploy never precaches old files
      return cache.addAll(STATIC_ASSETS.map((url) => new Request(url, { cache: 'reload' }))).catch((err) => {
        // Some assets may fail (e.g., fonts) — don't block install
        console.warn('SW: Failed to cache some assets:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: cache-first for static, stale-while-revalidate for HTML
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Skip non-http/https requests (chrome-extension:, blob:, etc.) and writes (AI proxy, Firestore)
  if (!url.protocol.startsWith('http') || e.request.method !== 'GET') return;

  // HTML pages: show the cached page at once and refresh the cache in the background,
  // so switching tabs never waits on the network. A deploy is picked up on the next visit.
  if (e.request.destination === 'document' || url.pathname.endsWith('.html')) {
    e.respondWith(
      caches.match(e.request, { ignoreSearch: true }).then((cached) => {
        const fresh = fetch(e.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
          }
          return response;
        });
        if (!cached) return fresh;
        e.waitUntil(fresh.catch(() => {})); // offline: the cached page is enough
        return cached;
      })
    );
    return;
  }

  // Static assets (CSS, JS, images, fonts): cache-first
  if (['style', 'script', 'image', 'font'].includes(e.request.destination)) {
    e.respondWith(
      // ignoreSearch: style.css?v=4 is served from the precached style.css
      caches.match(e.request, { ignoreSearch: true }).then((cached) => {
        if (cached) return cached;
        return fetch(e.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Everything else: network-first
  e.respondWith(
    fetch(e.request)
      .catch(() => caches.match(e.request))
  );
});

// Daily reminder (worker/src/push.js sends an empty push; the text lives here)
self.addEventListener('push', (e) => {
  e.waitUntil(self.registration.showNotification("Log today's spending", {
    body: 'Add what you spent today. It only takes a few seconds.',
    icon: './assets/images/logo-192.png',
    tag: 'daily-reminder', // a newer reminder replaces an unread one
    data: { url: new URL('./expense.html', self.registration.scope).href },
  }));
});

// Tapping the reminder opens Add Expense, reusing an open SpendWise window if there is one
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || self.registration.scope;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => w.url.startsWith(self.registration.scope));
      if (open) return open.navigate(url).then((w) => (w || open).focus());
      return self.clients.openWindow(url);
    })
  );
});
