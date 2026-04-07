// sw.js — SpendWise Service Worker with caching strategy

const CACHE_NAME = 'spendwise-v2';
const STATIC_ASSETS = [
  './',
  './index.html',
  './expense.html',
  './income.html',
  './history.html',
  './debt.html',
  './insights.html',
  './assets/css/style.css',
  './assets/js/utils/currency.js',
  './assets/js/utils/helpers.js',
  './assets/js/config/firebase.js',
  './assets/js/dashboard.js',
  './assets/js/income.js',
  './assets/js/debt.js',
  './assets/js/modules/auth.js',
  './assets/js/modules/voice-command.js',
  './assets/js/modules/insights-v2.js',
  './assets/js/modules/network-status.js',
  './assets/js/modules/csv-upload.js',
  './assets/js/modules/backup.js',
  './assets/images/logo.png',
  './assets/images/logo2.png',
  './manifest.json',
  'https://unpkg.com/lucide@0.378.0/dist/umd/lucide.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap'
];

// Install: cache static assets
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
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

// Fetch: cache-first for static, network-first for HTML
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Skip non-http/https requests (chrome-extension:, blob:, etc.)
  if (!url.protocol.startsWith('http')) return;

  // HTML pages: network-first (always get latest)
  if (e.request.destination === 'document' || url.pathname.endsWith('.html')) {
    e.respondWith(
      fetch(e.request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
          return response;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Static assets (CSS, JS, images, fonts): cache-first
  if (['style', 'script', 'image', 'font'].includes(e.request.destination)) {
    e.respondWith(
      caches.match(e.request).then((cached) => {
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
