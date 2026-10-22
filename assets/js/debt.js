// debt.js — SpendWise Debt Tracker Module

import { auth, db } from './config/firebase.js';
import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { collection, addDoc, getDocs, deleteDoc, doc, query, where, serverTimestamp, updateDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// Currency helpers from global scope
const fmt = window.fmt;
const getCurrency = window.getCurrency;
const getCurrencyInfo = window.getCurrencyInfo;
const buildCurrencyOptions = window.buildCurrencyOptions;
const updateCurrencyDisplay = window.updateCurrencyDisplay;
const setCurrency = window.setCurrency;

// Sanitize helper from utils
import { sanitize, friendlyErr, escapeHtml, bindDateChips, shortDay } from './utils/helpers.js';

// ── State ────────────────────────────────────────────────────────────────────
let currentUser = null;
let allDebts = [];
let deleteDebtTarget = null;
let settleDebtTarget = null;
let reactivateDebtTarget = null;
let currentDebtType = 'they-owe';
let editingDebtId = null;

// ── Helpers ──────────────────────────────────────────────────────────────────
function pad(n) { return String(n).padStart(2, '0'); }
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function formatDate(ds) {
  return new Date(ds + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + (type || 'success');
  t.classList.remove('hidden');
  // Errors stay until tapped (accessibility.js); a slow reader must not lose them
  if (type !== 'error') setTimeout(() => t.classList.add('hidden'), 3000);
}

function showDebtFormMsg(msg, type) {
  const el = document.getElementById('debt-form-msg');
  el.textContent = msg;
  el.className = 'form-msg ' + type;
  el.classList.remove('hidden');
  if (type === 'success') setTimeout(() => el.classList.add('hidden'), 3000);
}

// ── Page Loader ───────────────────────────────────────────────────────────────
function dismissPageLoader() {
  const loader = document.getElementById('page-loader');
  if (!loader) return;
  loader.classList.add('fade-out');
  setTimeout(() => loader.remove(), 450);
}

// ── Avatar helper (XSS-safe) ────────────────────────────────────────────────
function updateUserAvatar(user) {
  const avatarEl = document.getElementById('user-avatar');
  if (!avatarEl) return;
  avatarEl.innerHTML = '';
  if (user.photoURL) {
    const img = document.createElement('img');
    img.src = user.photoURL;
    img.referrerPolicy = 'no-referrer';
    img.alt = 'Profile';
    img.addEventListener('error', () => {
      avatarEl.textContent = (user.displayName || user.email || 'U')[0].toUpperCase();
    });
    avatarEl.appendChild(img);
  } else {
    avatarEl.textContent = (user.displayName || user.email || 'U')[0].toUpperCase();
  }
}


// ── Auth ──────────────────────────────────────────────────────────────────────
onAuthStateChanged(auth, user => {
  dismissPageLoader();
  if (user) {
    if (!user.emailVerified && user.providerData[0]?.providerId === 'password') {
      signOut(auth);
      window.location.href = 'index.html';
      return;
    }
    currentUser = user;
    document.getElementById('app').classList.remove('hidden');
    updateUserAvatar(user);

    initCurrencySelector();

    // Init date
    const dateEl = document.getElementById('debt-date');
    if (dateEl && !dateEl.value) dateEl.value = todayStr();
    syncDateChips();

    loadDebts();
  } else {
    window.location.href = 'index.html';
  }
});

// ── Profile Menu ──────────────────────────────────────────────────────────────
window.toggleProfileMenu = (e) => {
  if (e) e.stopPropagation();
  const dropdown = document.getElementById('profile-dropdown');
  if (dropdown) dropdown.classList.toggle('hidden');
};

document.addEventListener('click', (e) => {
  const menu = document.getElementById('profile-menu');
  const dropdown = document.getElementById('profile-dropdown');
  if (dropdown && !dropdown.classList.contains('hidden')) {
    if (!menu || !menu.contains(e.target)) {
      dropdown.classList.add('hidden');
    }
  }
});

window.handleLogout = async () => {
  await signOut(auth);
  window.location.href = 'index.html';
};

// ── Mobile Menu ──────────────────────────────────────────────────────────────
window.toggleMobileMenu = () => {
  const overlay = document.getElementById('mobile-menu-overlay');
  const panel = document.getElementById('mobile-menu-panel');
  if (overlay && panel) {
    overlay.classList.toggle('open');
    panel.classList.toggle('open');
  }
};

window.closeMobileMenu = () => {
  const overlay = document.getElementById('mobile-menu-overlay');
  const panel = document.getElementById('mobile-menu-panel');
  if (overlay) overlay.classList.remove('open');
  if (panel) panel.classList.remove('open');
};

window.navigateTo = (url) => {
  closeMobileMenu();
  const allowed = ['index.html', 'expense.html', 'income.html', 'history.html', 'debt.html', 'insights.html'];
  const clean = url.split('#')[0].split('?')[0];
  if (allowed.includes(clean)) {
    window.location.href = url;
  }
};

// ── Currency ────────────────────────────────────────────────────────────────
function initCurrencySelector() {
  const sel = document.getElementById('currency-select');
  if (!sel) return;
  sel.innerHTML = buildCurrencyOptions(getCurrency());
  requestAnimationFrame(() => {
    updateCurrencyDisplay();
  });
}

window.handleCurrencyChange = (code) => {
  setCurrency(code);
  updateCurrencyDisplay();
  if (currentUser) {
    updateDebtSummary();
  }
};

// ── Load Debts ───────────────────────────────────────────────────────────────
async function loadDebts() {
  if (!currentUser) return;
  try {
    const q = query(collection(db, 'debts'), where('uid', '==', currentUser.uid));
    const snap = await getDocs(q);
    allDebts = snap.docs.map(d => {
      const raw = d.data();
      const amt = parseFloat(raw.amount);
      return {
        id: d.id,
        ...raw,
        amount: isNaN(amt) ? 0 : amt,
        settledDate: raw.settledDate || '',
      };
    });
    allDebts.sort((a, b) => b.date.localeCompare(a.date));
    updateDebtSummary();
    renderDebts();
    renderDebtHistory();
  } catch (e) {
    console.error(e);
    showToast('Error loading debt data.', 'error');
  }
}

// ── Summary: net balance and each direction ──────────────────────────────────
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function updateDebtSummary() {
  const active = allDebts.filter(d => !d.settled);
  const owed = active.filter(d => d.type === 'they-owe');
  const owe = active.filter(d => d.type === 'i-owe');
  const owedToYou = owed.reduce((s, d) => s + d.amount, 0);
  const youOwe = owe.reduce((s, d) => s + d.amount, 0);
  const net = owedToYou - youOwe;

  const netEl = document.getElementById('debt-net-balance');
  netEl.textContent = fmt(Math.abs(net));
  netEl.classList.toggle('is-income', net > 0);
  netEl.classList.toggle('is-owe', net < 0);
  document.getElementById('debt-net-word').textContent = net > 0 ? 'in your favour' : net < 0 ? 'you owe overall' : 'all square';
  const people = new Set(active.map(d => d.person)).size;
  document.getElementById('debt-net-sub').textContent = active.length
    ? `${plural(active.length, 'open debt', 'open debts')} with ${plural(people, 'person', 'people')}`
    : 'No open debts';
  document.getElementById('debt-owed-to-you').textContent = fmt(owedToYou);
  document.getElementById('debt-you-owe').textContent = fmt(youOwe);
  document.getElementById('debt-owe-count').textContent = `${owe.length} open`;
  document.getElementById('debt-owed-count').textContent = `${owed.length} open`;

  // Names used before, so a repeat person is picked rather than retyped
  document.getElementById('debt-person-list').innerHTML = [...new Set(allDebts.map(d => d.person).filter(Boolean))]
    .map(p => `<option value="${escapeHtml(p)}"></option>`).join('');
}

// One row: who, which way, when, the amount, then the row's actions
function debtRow(d, meta, actions) {
  return `<li class="debt-row">
    <div class="hist-row-main">
      <span class="hist-row-title">${escapeHtml(d.person)}</span>
      <span class="hist-row-meta">${escapeHtml(meta)}</span>
      ${d.notes ? `<span class="hist-row-note">${escapeHtml(d.notes)}</span>` : ''}
    </div>
    <span class="hist-row-amount ${d.type === 'they-owe' ? 'income' : 'owe'}">${fmt(d.amount)}</span>
    ${actions}
  </li>`;
}

// ── Open debts ───────────────────────────────────────────────────────────────
function renderDebts() {
  const list = document.getElementById('debt-body');
  const active = allDebts.filter(d => !d.settled);
  document.getElementById('debt-open-total').textContent = active.length ? String(active.length) : '';
  if (!active.length) {
    list.innerHTML = '<li class="hist-empty">No open debts. Add one above when someone borrows or lends.</li>';
    return;
  }
  list.innerHTML = active.map(d => {
    const meta = [d.type === 'they-owe' ? 'Owes you' : 'You owe', shortDay(d.date), d.pending ? 'Waiting to sync' : ''].filter(Boolean).join(' · ');
    const who = escapeHtml(d.person);
    // offline entries have no record to update until they sync
    const actions = d.pending ? '' : `
      <button type="button" class="debt-action" data-action="openDebtSettleModal" data-debt-id="${escapeHtml(d.id)}" aria-label="Settle ${fmt(d.amount)} with ${who}">Settle</button>
      <button type="button" class="icon-btn" data-action="openDebtDeleteModal" data-debt-id="${escapeHtml(d.id)}" aria-label="Delete debt with ${who}" title="Delete"><i data-lucide="trash-2"></i></button>`;
    return debtRow(d, meta, actions);
  }).join('');
  if (window.lucide) lucide.createIcons();
}

// ── Settled debts (collapsed until opened) ───────────────────────────────────
function renderDebtHistory() {
  const settled = allDebts.filter(d => d.settled).sort((a, b) => (b.settledDate || '').localeCompare(a.settledDate || ''));
  document.getElementById('debt-settled').classList.toggle('hidden', !settled.length);
  document.getElementById('debt-settled-count').textContent = `Settled · ${settled.length}`;
  document.getElementById('debt-settled-total').textContent = fmt(settled.reduce((s, d) => s + d.amount, 0));
  document.getElementById('debt-history-body').innerHTML = settled.map(d => {
    const meta = [d.type === 'they-owe' ? 'Paid you back' : 'You paid back', d.settledDate ? shortDay(d.settledDate) : ''].filter(Boolean).join(' · ');
    return debtRow(d, meta, `<button type="button" class="debt-action" data-action="openDebtReactivateModal" data-debt-id="${escapeHtml(d.id)}" aria-label="Reopen debt with ${escapeHtml(d.person)}">Reopen</button>`);
  }).join('');
}

// ── Add Debt ─────────────────────────────────────────────────────────────────
window.addDebt = async () => {
  const amount = parseFloat(document.getElementById('debt-amount').value);
  const person = sanitize(document.getElementById('debt-person').value.trim(), 100);
  const date = document.getElementById('debt-date').value;
  const notes = sanitize(document.getElementById('debt-notes').value.trim(), 500);

  if (!amount || amount <= 0) { showDebtFormMsg('Enter a valid amount.', 'error'); return; }
  if (!person) { showDebtFormMsg('Enter person name.', 'error'); return; }
  if (!date) { showDebtFormMsg('Select a date.', 'error'); return; }

  const debtData = {
    uid: currentUser.uid,
    amount,
    type: currentDebtType,
    person,
    date,
    notes: notes || '',
    settled: false,
    settledDate: '',
    encoding: 'plain',
    createdAt: serverTimestamp()
  };

  if (window.isOffline && window.isOffline()) {
    if (typeof window.addToOfflineQueue === 'function') {
      window.addToOfflineQueue('debt', debtData);
      allDebts.unshift({ id: 'offline-' + Date.now(), amount, type: currentDebtType, person, date, notes: notes || '', settled: false, settledDate: '', pending: true });
      allDebts.sort((a, b) => b.date.localeCompare(a.date));
      updateDebtSummary();
      renderDebts();
      renderDebtHistory();
      resetDebtForm();
      showDebtFormMsg('Debt saved offline. Will sync when online.', 'success');
      showToast('Saved offline!', 'success');
    } else {
      showDebtFormMsg('Cannot save offline. Please check your connection.', 'error');
    }
    return;
  }

  try {
    const ref = await addDoc(collection(db, 'debts'), debtData);

    allDebts.unshift({ id: ref.id, amount, type: currentDebtType, person, date, notes: notes || '', settled: false, settledDate: '' });
    allDebts.sort((a, b) => b.date.localeCompare(a.date));
    updateDebtSummary();
    renderDebts();
    renderDebtHistory();
    resetDebtForm();
    showDebtFormMsg('Debt added successfully!', 'success');
    showToast('Debt added!', 'success');
    window.markLoggedToday?.(); // skips today's reminder (reminders.js)
  } catch (e) {
    console.error(e);
    if (window.addToOfflineQueue && navigator.onLine === false) {
      window.addToOfflineQueue('debt', debtData);
      allDebts.unshift({ id: 'offline-' + Date.now(), amount, type: currentDebtType, person, date, notes: notes || '', settled: false, settledDate: '', pending: true });
      allDebts.sort((a, b) => b.date.localeCompare(a.date));
      updateDebtSummary();
      renderDebts();
      renderDebtHistory();
      resetDebtForm();
      showDebtFormMsg('Saved offline due to error. Will sync when online.', 'success');
      showToast('Saved offline!', 'success');
    } else {
      showDebtFormMsg('Failed to save. Try again.', 'error');
    }
  }
};

// ── Reset Form ───────────────────────────────────────────────────────────────
window.resetDebtForm = () => {
  ['debt-amount', 'debt-person', 'debt-notes'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('debt-date').value = todayStr();
  document.getElementById('debt-form-msg').classList.add('hidden');
  setDebtType('they-owe');
  editingDebtId = null;
  syncDateChips();
  document.getElementById('debt-form-heading').textContent = 'Add a debt';
  document.getElementById('debt-btn-label').textContent = 'Add debt';
};

const syncDateChips = bindDateChips(document.getElementById('debt-date'), document.getElementById('add-debt-section'));

// ── Debt Type Toggle ─────────────────────────────────────────────────────────
window.setDebtType = (type) => {
  currentDebtType = type;
  document.querySelectorAll('#add-debt-section [data-type]').forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.dataset.type === type));
  });
};

// ── Delete Debt ──────────────────────────────────────────────────────────────
window.openDebtDeleteModal = (id) => {
  deleteDebtTarget = id;
  document.getElementById('debt-delete-modal').classList.remove('hidden');
};

window.closeDebtDeleteModal = () => {
  document.getElementById('debt-delete-modal').classList.add('hidden');
  deleteDebtTarget = null;
};

window.confirmDebtDelete = async () => {
  if (!deleteDebtTarget) return;
  try {
    await deleteDoc(doc(db, 'debts', deleteDebtTarget));
    allDebts = allDebts.filter(d => d.id !== deleteDebtTarget);
    updateDebtSummary();
    renderDebts();
    renderDebtHistory();
    showToast('Debt deleted.', 'success');
  } catch (e) {
    showToast('Delete failed.', 'error');
  }
  closeDebtDeleteModal();
};

// ── Settle Debt ──────────────────────────────────────────────────────────────
window.openDebtSettleModal = (id) => {
  settleDebtTarget = id;
  const debt = allDebts.find(d => d.id === id);
  if (debt) {
    document.getElementById('debt-settle-msg').textContent = `${fmt(debt.amount)} with ${debt.person} moves to Settled. You can reopen it later.`;
  }
  document.getElementById('debt-settle-modal').classList.remove('hidden');
};

window.closeDebtSettleModal = () => {
  document.getElementById('debt-settle-modal').classList.add('hidden');
  settleDebtTarget = null;
};

window.confirmDebtSettle = async () => {
  if (!settleDebtTarget) return;
  try {
    const debtRef = doc(db, 'debts', settleDebtTarget);
    const settledDate = todayStr();
    await updateDoc(debtRef, { settled: true, settledDate });

    const idx = allDebts.findIndex(d => d.id === settleDebtTarget);
    if (idx >= 0) {
      allDebts[idx].settled = true;
      allDebts[idx].settledDate = settledDate;
    }

    updateDebtSummary();
    renderDebts();
    renderDebtHistory();
    showToast('Debt settled!', 'success');
  } catch (e) {
    showToast('Settlement failed.', 'error');
  }
  closeDebtSettleModal();
};

// ── Reactivate Debt ──────────────────────────────────────────────────────────
window.openDebtReactivateModal = (id) => {
  reactivateDebtTarget = id;
  const debt = allDebts.find(d => d.id === id);
  if (debt) {
    document.getElementById('debt-reactivate-msg').textContent = `${fmt(debt.amount)} with ${debt.person} moves back to Open.`;
  }
  document.getElementById('debt-reactivate-modal').classList.remove('hidden');
};

window.closeDebtReactivateModal = () => {
  document.getElementById('debt-reactivate-modal').classList.add('hidden');
  reactivateDebtTarget = null;
};

window.confirmDebtReactivate = async () => {
  if (!reactivateDebtTarget) return;
  try {
    const debtRef = doc(db, 'debts', reactivateDebtTarget);
    await updateDoc(debtRef, { settled: false, settledDate: '' });

    const idx = allDebts.findIndex(d => d.id === reactivateDebtTarget);
    if (idx >= 0) {
      allDebts[idx].settled = false;
      allDebts[idx].settledDate = '';
    }

    updateDebtSummary();
    renderDebts();
    renderDebtHistory();
    showToast('Debt reactivated!', 'success');
  } catch (e) {
    showToast('Reactivation failed.', 'error');
  }
  closeDebtReactivateModal();
};

// ── Modal Click Outside to Close ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Delete modal
  const deleteOverlay = document.getElementById('debt-delete-modal');
  if (deleteOverlay) {
    deleteOverlay.addEventListener('click', e => {
      if (e.target === deleteOverlay) closeDebtDeleteModal();
    });
  }

  // Settle modal
  const settleOverlay = document.getElementById('debt-settle-modal');
  if (settleOverlay) {
    settleOverlay.addEventListener('click', e => {
      if (e.target === settleOverlay) closeDebtSettleModal();
    });
  }

  // Reactivate modal
  const reactivateOverlay = document.getElementById('debt-reactivate-modal');
  if (reactivateOverlay) {
    reactivateOverlay.addEventListener('click', e => {
      if (e.target === reactivateOverlay) closeDebtReactivateModal();
    });
  }
});

// ── Auth helpers from index.html ─────────────────────────────────────────────
window.switchTab = (tab) => {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.auth-form').forEach(f => f.classList.add('hidden'));
  document.querySelectorAll('.tab-btn')[tab === 'login' ? 0 : 1].classList.add('active');
  document.getElementById(tab + '-form').classList.remove('hidden');
  document.getElementById('auth-error').classList.add('hidden');
};

window.handleLogin = async () => {
  const email = document.getElementById('login-email').value.trim();
  const pass = document.getElementById('login-password').value;
  if (!email || !pass) { showAuthError('Please fill in all fields.'); return; }
  try { await signInWithEmailAndPassword(auth, email, pass); }
  catch (e) { showAuthError(friendlyErr(e.code)); }
};

window.handleSignup = async () => {
  const name = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const pass = document.getElementById('signup-password').value;
  if (!name || !email || !pass) { showAuthError('Please fill in all fields.'); return; }
  if (pass.length < 8) { showAuthError('Password must be at least 8 characters.'); return; }
  if (!/[a-z]/.test(pass)) { showAuthError('Password must contain at least one lowercase letter.'); return; }
  if (!/[A-Z]/.test(pass)) { showAuthError('Password must contain at least one uppercase letter.'); return; }
  if (!/[0-9]/.test(pass)) { showAuthError('Password must contain at least one number.'); return; }
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]+/.test(pass)) { showAuthError('Password must contain at least one special character.'); return; }
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
    await updateProfile(cred.user, { displayName: name });
    await sendEmailVerification(cred.user);
    await signOut(auth);
    switchTab('login');
    showAuthError('Account created! Please check your email to verify.', true);
  }
  catch (e) { showAuthError(friendlyErr(e.code)); }
};

window.handleGoogleLogin = async () => {
  try { await signInWithPopup(auth, gProvider); }
  catch (e) { showAuthError(friendlyErr(e.code)); }
};

function showAuthError(msg, isSuccess = false) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.classList.remove('hidden');
  if (isSuccess) el.style.color = '#10b981';
  else el.style.removeProperty('color');
}

// Import auth functions
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, signInWithPopup, GoogleAuthProvider, updateProfile, sendEmailVerification } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
const gProvider = new GoogleAuthProvider();

// Refresh after offline-queue.js writes queued items
window.addEventListener('spendwise:synced', () => loadDebts());
