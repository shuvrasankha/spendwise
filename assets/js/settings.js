// settings.js — The Settings page: account, appearance, currency, monthly budget, daily reminder,
// app lock, backup, and refreshing the app. The reminder and app-lock switches are put in #settings-reminder and
// #settings-lock by their own modules (reminders.js, app-lock.js); the budget row opens budget.js's
// dialog ([data-open-budget]) and the backup row backup.js's (openBackupModal).
import { requireUser, initCurrencySelector, showToast } from './modules/page-shell.js';

requireUser(user => {
  initCurrencySelector(() => {}); // nothing on this page shows money

  document.getElementById('settings-name').textContent = user.displayName || 'Your account';
  document.getElementById('settings-email').textContent = user.email || '';
  const avatar = document.getElementById('settings-avatar');
  const initial = () => { avatar.textContent = (user.displayName || user.email || 'U')[0].toUpperCase(); };
  if (!user.photoURL) { initial(); return; }
  const img = document.createElement('img');
  img.src = user.photoURL;
  img.referrerPolicy = 'no-referrer';
  img.alt = '';
  img.addEventListener('error', initial);
  avatar.replaceChildren(img);
});

// ── Refresh the app ─────────────────────────────────────────────────────────
// A hard refresh for a home-screen app, which has no reload shortcut: drops the offline copy (the
// service worker and its caches), fetches every file this page used past the browser's own cache,
// then reloads. Sign-in, settings and entries waiting to sync (localStorage, IndexedDB) are untouched.
async function refreshApp() {
  const btn = document.getElementById('settings-refresh');
  const sub = document.getElementById('settings-refresh-sub');
  if (window.isOffline?.() || navigator.onLine === false) {
    showToast("You're offline. Refresh once you're connected, or the app won't open without a connection.", 'error');
    return;
  }
  btn.disabled = true;
  sub.textContent = 'Getting the latest version…';
  try {
    // The files to re-fetch: this page and everything it loaded from this site
    const here = location.origin;
    const urls = new Set([location.href.split('#')[0]]);
    performance.getEntriesByType('resource').forEach(r => { if (r.name.startsWith(here)) urls.add(r.name); });
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    // The Dashboard's copy of the data (dashboard.js getCacheKey) loads again; app lock's state stays
    try {
      Object.keys(sessionStorage).filter(k => /^spendwise_(expenses|income|debts|holdings)_/.test(k)).forEach(k => sessionStorage.removeItem(k));
    } catch { /* storage blocked */ }
    await Promise.allSettled([...urls].map(u => fetch(u, { cache: 'reload' })));
  } catch (e) {
    console.error('Refresh failed:', e);
  }
  location.reload();
}
document.getElementById('settings-refresh')?.addEventListener('click', refreshApp);
