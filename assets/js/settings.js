// settings.js — The Settings page: account, appearance, currency, monthly budget, daily reminder,
// app lock and backup. The reminder and app-lock switches are put in #settings-reminder and
// #settings-lock by their own modules (reminders.js, app-lock.js); the budget row opens budget.js's
// dialog ([data-open-budget]) and the backup row backup.js's (openBackupModal).
import { requireUser, initCurrencySelector } from './modules/page-shell.js';

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
