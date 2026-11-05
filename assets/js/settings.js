// settings.js — The Settings page: account, appearance, currency, monthly budget, daily reminder,
// app lock, backup, and refreshing the app. The reminder and app-lock switches are put in #settings-reminder and
// #settings-lock by their own modules (reminders.js, app-lock.js); the budget row opens budget.js's
// dialog ([data-open-budget]) and the backup row backup.js's (openBackupModal).
import { requireUser, initCurrencySelector, showToast } from './modules/page-shell.js';
import { getCreditCards, saveCreditCard } from './modules/credit-card-store.js';
import { creditCardLabel } from './modules/credit-card-data.js';

let currentUser = null;
let creditCards = [];
let editingCreditCardId = '';

requireUser(user => {
  currentUser = user;
  initCurrencySelector(() => {}); // nothing on this page shows money

  document.getElementById('settings-name').textContent = user.displayName || 'Your account';
  document.getElementById('settings-email').textContent = user.email || '';
  const avatar = document.getElementById('settings-avatar');
  const initial = () => { avatar.textContent = (user.displayName || user.email || 'U')[0].toUpperCase(); };
  loadCreditCards();
  if (!user.photoURL) { initial(); return; }
  const img = document.createElement('img');
  img.src = user.photoURL;
  img.referrerPolicy = 'no-referrer';
  img.alt = '';
  img.addEventListener('error', initial);
  avatar.replaceChildren(img);
});

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

async function loadCreditCards() {
  try {
    creditCards = await getCreditCards(currentUser.uid);
    renderCreditCards();
  } catch (error) {
    console.error('Could not load credit cards:', error);
    document.getElementById('settings-credit-cards').innerHTML = '<p class="hist-empty">Credit cards could not be loaded. Check your connection and try again.</p>';
  }
}

function renderCreditCards() {
  const active = creditCards.filter(card => card.active !== false);
  const archived = creditCards.filter(card => card.active === false);
  const row = card => `<li class="credit-card-settings-row">
    <div><strong>${escapeHtml(creditCardLabel(card))}</strong><span>${card.statementDay ? `Closes on day ${card.statementDay}` : 'No statement cycle set'}${card.dueDay ? ` · Due day ${card.dueDay}` : ''}${card.creditLimit != null ? ` · Limit ${escapeHtml(window.fmt(card.creditLimit))}` : ''}${card.active === false ? ' · Archived' : ''}</span></div>
    <div class="credit-card-settings-actions">
      <button type="button" class="btn-secondary" data-card-edit="${escapeHtml(card.id)}">Edit</button>
      <button type="button" class="btn-secondary" data-card-toggle="${escapeHtml(card.id)}" data-active="${card.active === false}">${card.active === false ? 'Reactivate' : 'Archive'}</button>
    </div>
  </li>`;
  const sections = [
    active.length ? `<h3>Active</h3><ul>${active.map(row).join('')}</ul>` : '<p class="hist-empty">No active cards yet. Add one to tag a credit-card expense.</p>',
    archived.length ? `<h3>Archived</h3><ul>${archived.map(row).join('')}</ul>` : '',
  ];
  document.getElementById('settings-credit-cards').innerHTML = sections.join('');
}

window.openCreditCardForm = cardId => {
  editingCreditCardId = cardId || '';
  const card = creditCards.find(item => item.id === editingCreditCardId);
  document.getElementById('credit-card-modal-title').textContent = card ? 'Edit credit card' : 'Add a credit card';
  document.getElementById('credit-card-name').value = card?.name || '';
  document.getElementById('credit-card-issuer').value = card?.issuer || '';
  document.getElementById('credit-card-last4').value = card?.last4 || '';
  document.getElementById('credit-card-network').value = card?.network || '';
  document.getElementById('credit-card-limit').value = card?.creditLimit ?? '';
  document.getElementById('credit-card-statement-day').value = card?.statementDay ?? '';
  document.getElementById('credit-card-due-day').value = card?.dueDay ?? '';
  document.getElementById('credit-card-form-error').classList.add('hidden');
  document.getElementById('credit-card-modal').classList.remove('hidden');
  window.lucide?.createIcons();
};

window.closeCreditCardForm = () => {
  document.getElementById('credit-card-modal').classList.add('hidden');
  editingCreditCardId = '';
};

window.saveCreditCardSettings = async () => {
  const errorEl = document.getElementById('credit-card-form-error');
  const input = {
    name: document.getElementById('credit-card-name').value,
    issuer: document.getElementById('credit-card-issuer').value,
    last4: document.getElementById('credit-card-last4').value,
    network: document.getElementById('credit-card-network').value,
    creditLimit: document.getElementById('credit-card-limit').value,
    statementDay: document.getElementById('credit-card-statement-day').value,
    dueDay: document.getElementById('credit-card-due-day').value,
    active: creditCards.find(card => card.id === editingCreditCardId)?.active !== false,
  };
  try {
    await saveCreditCard(currentUser.uid, input, editingCreditCardId);
    await loadCreditCards();
    window.closeCreditCardForm();
    showToast('Credit card saved.', 'success');
  } catch (error) {
    console.error('Could not save credit card:', error);
    errorEl.textContent = error.message || 'Credit card could not be saved.';
    errorEl.classList.remove('hidden');
  }
};

async function toggleCreditCard(id, button) {
  const card = creditCards.find(item => item.id === id);
  if (!card) return;
  try {
    await saveCreditCard(currentUser.uid, { ...card, active: button?.dataset.active === 'true' }, id);
    await loadCreditCards();
    showToast(button?.dataset.active === 'true' ? 'Credit card reactivated.' : 'Credit card archived.', 'success');
  } catch (error) {
    console.error('Could not update credit card:', error);
    showToast(error.message || 'Credit card could not be updated.', 'error');
  }
}

document.getElementById('add-credit-card').addEventListener('click', () => window.openCreditCardForm());
document.getElementById('save-credit-card').addEventListener('click', () => window.saveCreditCardSettings());
document.getElementById('credit-card-modal').addEventListener('click', event => {
  if (event.target.closest('[data-card-modal-close]') || event.target.id === 'credit-card-modal') window.closeCreditCardForm();
});
document.getElementById('settings-credit-cards').addEventListener('click', event => {
  const edit = event.target.closest('[data-card-edit]');
  const toggle = event.target.closest('[data-card-toggle]');
  if (edit) window.openCreditCardForm(edit.dataset.cardEdit);
  if (toggle) toggleCreditCard(toggle.dataset.cardToggle, toggle);
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
