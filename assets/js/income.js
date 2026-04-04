// income.js — SpendWise Income Tracker (Firebase Modular SDK)

import { auth, gProvider, db } from './config/firebase.js';
import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { collection, addDoc, getDocs, deleteDoc, doc, query, where, serverTimestamp, updateDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// Currency helpers from global scope (currency.js loads before this module)
const fmt = window.fmt;
const getCurrency = window.getCurrency;
const getCurrencyInfo = window.getCurrencyInfo;
const buildCurrencyOptions = window.buildCurrencyOptions;
const updateCurrencyDisplay = window.updateCurrencyDisplay;
const setCurrency = window.setCurrency;

// Sanitize helper from utils
import { sanitize } from './utils/helpers.js';



// ── State ────────────────────────────────────────────────────────────────────
let currentUser = null;
let allIncome = [];
let editingIncomeId = null;
let deleteIncomeTarget = null;


// ── Helpers ──────────────────────────────────────────────────────────────────
// fmt() is now provided by currency.js
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
  setTimeout(() => t.classList.add('hidden'), 3000);
}

function showFormMsg(msg, type) {
  const el = document.getElementById('income-form-msg');
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

// ── Theme ─────────────────────────────────────────────────────────────────────
const savedTheme = localStorage.getItem('theme') ||
  (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
document.documentElement.setAttribute('data-theme', savedTheme);

window.toggleTheme = () => {
  const html = document.documentElement;
  const dark = html.getAttribute('data-theme') === 'dark';
  html.setAttribute('data-theme', dark ? 'light' : 'dark');
  localStorage.setItem('theme', dark ? 'light' : 'dark');
  updateThemeIcon();
};

function updateThemeIcon() {
  const icon = document.getElementById('theme-icon');
  if (!icon) return;
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  icon.setAttribute('data-lucide', isDark ? 'sun' : 'moon');
  if (window.lucide) lucide.createIcons();
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

    // Set greeting
    const h = new Date().getHours();
    const g = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const n = user.displayName ? user.displayName.split(' ')[0] : '';
    document.getElementById('income-greeting').textContent = g + (n ? ', ' + n : '') + '!';

    updateThemeIcon();
    initCurrencySelector();

    // Init date
    const dateEl = document.getElementById('inc-date');
    if (dateEl && !dateEl.value) dateEl.value = todayStr();

    loadIncome();
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
    updateIncomeSummaryCards();
  }
};

// ── Load Income ───────────────────────────────────────────────────────────────
async function loadIncome() {
  if (!currentUser) return;
  try {
    const q = query(collection(db, 'income'), where('uid', '==', currentUser.uid));
    const snap = await getDocs(q);
    allIncome = snap.docs.map(d => {
      const raw = d.data();
      const amt = parseFloat(raw.amount);
      return {
        id: d.id,
        ...raw,
        amount: isNaN(amt) ? 0 : amt,
      };
    });
    allIncome.sort((a, b) => b.date.localeCompare(a.date));
    updateIncomeSummaryCards();
  } catch (e) {
    console.error(e);
    showToast('Error loading income data.', 'error');
  }
}

// ── Summary Cards ─────────────────────────────────────────────────────────────
function updateIncomeSummaryCards() {
  const now = new Date();
  const ms = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-01';
  const ys = now.getFullYear() + '-01-01';
  const today = todayStr();

  const monthly = allIncome.filter(i => i.date >= ms && i.date <= today);
  const yearly = allIncome.filter(i => i.date >= ys && i.date <= today);
  const cashAll = allIncome.filter(i => i.paymentType === 'Cash');
  const onlineAll = allIncome.filter(i => i.paymentType === 'Online');

  const monthTotal = monthly.reduce((s, i) => s + i.amount, 0);
  const yearTotal = yearly.reduce((s, i) => s + i.amount, 0);
  const cashTotal = cashAll.reduce((s, i) => s + i.amount, 0);
  const onlineTotal = onlineAll.reduce((s, i) => s + i.amount, 0);

  document.getElementById('inc-monthly').textContent = fmt(monthTotal);
  document.getElementById('inc-monthly-count').textContent = monthly.length + ' entr' + (monthly.length !== 1 ? 'ies' : 'y');
  document.getElementById('inc-yearly').textContent = fmt(yearTotal);
  document.getElementById('inc-yearly-count').textContent = yearly.length + ' entr' + (yearly.length !== 1 ? 'ies' : 'y');
  document.getElementById('inc-cash').textContent = fmt(cashTotal);
  document.getElementById('inc-cash-label').textContent = cashAll.length + ' entr' + (cashAll.length !== 1 ? 'ies' : 'y');
  document.getElementById('inc-online').textContent = fmt(onlineTotal);
  document.getElementById('inc-online-label').textContent = onlineAll.length + ' entr' + (onlineAll.length !== 1 ? 'ies' : 'y');
}

// ── Add Income ────────────────────────────────────────────────────────────────
window.addIncome = async () => {
  const amount = parseFloat(document.getElementById('inc-amount').value);
  const date = document.getElementById('inc-date').value;
  const source = sanitize(document.getElementById('inc-source').value.trim(), 100);
  const paymentType = document.getElementById('inc-payment').value;
  const bank = sanitize(paymentType === 'Online' ? document.getElementById('inc-bank').value.trim() : '', 100);
  const notes = sanitize(document.getElementById('inc-notes').value.trim(), 500);

  if (!amount || amount <= 0) { showFormMsg('Enter a valid amount.', 'error'); return; }
  if (!date) { showFormMsg('Select a date.', 'error'); return; }
  if (!source) { showFormMsg('Enter income source / from.', 'error'); return; }
  if (paymentType === 'Online' && !bank) { showFormMsg('Enter bank/wallet name for online payments.', 'error'); return; }

  try {
    const ref = await addDoc(collection(db, 'income'), {
      uid: currentUser.uid,
      amount,
      date,
      source,
      paymentType,
      bank: bank || '',
      notes: notes || '',
      encoding: 'plain',
      createdAt: serverTimestamp()
    });

    allIncome.unshift({ id: ref.id, amount, date, source, paymentType, bank: bank || '', notes: notes || '' });
    allIncome.sort((a, b) => b.date.localeCompare(a.date));
    updateIncomeSummaryCards();
    resetIncomeForm();
    showFormMsg('Income added successfully!', 'success');
    showToast('Income added!', 'success');
  } catch (e) {
    console.error(e);
    showFormMsg('Failed to save. Try again.', 'error');
  }
};

// ── Reset Form ────────────────────────────────────────────────────────────────
window.resetIncomeForm = () => {
  ['inc-amount', 'inc-source', 'inc-bank', 'inc-notes'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('inc-payment').value = 'Online';
  document.getElementById('inc-date').value = todayStr();
  document.getElementById('inc-bank-wrap').style.display = '';
  document.getElementById('income-form-msg').classList.add('hidden');
  // Reset heading in case it was in edit mode
  document.getElementById('income-form-heading').textContent = 'Add Income';
  document.getElementById('income-btn-label').textContent = 'Add Income';
  editingIncomeId = null;
};

// ── Toggle Bank Field ─────────────────────────────────────────────────────────
window.toggleBankField = (val) => {
  const wrap = document.getElementById('inc-bank-wrap');
  if (!wrap) return;
  wrap.style.display = val === 'Online' ? '' : 'none';
  if (val === 'Cash') document.getElementById('inc-bank').value = '';
};

window.toggleEditBankField = (val) => {
  const wrap = document.getElementById('edit-inc-bank-wrap');
  if (!wrap) return;
  wrap.style.display = val === 'Online' ? '' : 'none';
  if (val === 'Cash') document.getElementById('edit-inc-bank').value = '';
};



// ── Edit Income ───────────────────────────────────────────────────────────────
window.openIncomeEdit = (id) => {
  const entry = allIncome.find(i => i.id === id);
  if (!entry) return;
  editingIncomeId = id;

  document.getElementById('edit-inc-amount').value = entry.amount;
  updateCurrencyDisplay();
  document.getElementById('edit-inc-date').value = entry.date;
  document.getElementById('edit-inc-source').value = entry.source || '';
  document.getElementById('edit-inc-payment').value = entry.paymentType || 'Online';
  document.getElementById('edit-inc-bank').value = entry.bank || '';
  document.getElementById('edit-inc-notes').value = entry.notes || '';
  toggleEditBankField(entry.paymentType || 'Online');

  document.getElementById('edit-inc-error').classList.add('hidden');
  document.getElementById('income-edit-modal').classList.remove('hidden');
};

window.closeIncomeEditModal = () => {
  document.getElementById('income-edit-modal').classList.add('hidden');
  editingIncomeId = null;
};

window.saveEditIncome = async () => {
  if (!editingIncomeId) return;

  const amount = parseFloat(document.getElementById('edit-inc-amount').value);
  const date = document.getElementById('edit-inc-date').value;
  const source = sanitize(document.getElementById('edit-inc-source').value.trim(), 100);
  const paymentType = document.getElementById('edit-inc-payment').value;
  const bank = sanitize(paymentType === 'Online' ? document.getElementById('edit-inc-bank').value.trim() : '', 100);
  const notes = sanitize(document.getElementById('edit-inc-notes').value.trim(), 500);

  const errEl = document.getElementById('edit-inc-error');

  if (!amount || amount <= 0) { errEl.textContent = 'Enter a valid amount.'; errEl.classList.remove('hidden'); return; }
  if (!date) { errEl.textContent = 'Select a date.'; errEl.classList.remove('hidden'); return; }
  if (!source) { errEl.textContent = 'Enter income source.'; errEl.classList.remove('hidden'); return; }
  if (paymentType === 'Online' && !bank) { errEl.textContent = 'Enter bank/wallet name.'; errEl.classList.remove('hidden'); return; }

  try {
    await updateDoc(doc(db, 'income', editingIncomeId), {
      amount, date, source, paymentType, bank: bank || '', notes: notes || '', encoding: 'plain'
    });

    const idx = allIncome.findIndex(i => i.id === editingIncomeId);
    if (idx >= 0) {
      allIncome[idx] = { ...allIncome[idx], amount, date, source, paymentType, bank: bank || '', notes: notes || '' };
      allIncome.sort((a, b) => b.date.localeCompare(a.date));
    }

    updateIncomeSummaryCards();
    closeIncomeEditModal();
    showToast('Income updated!', 'success');
  } catch (e) {
    console.error(e);
    errEl.textContent = 'Failed to update. Try again.';
    errEl.classList.remove('hidden');
  }
};

// ── Delete Income ─────────────────────────────────────────────────────────────
window.deleteIncomeEntry = (id) => {
  deleteIncomeTarget = id;
  document.getElementById('income-delete-modal').classList.remove('hidden');
};

window.closeIncomeDeleteModal = () => {
  document.getElementById('income-delete-modal').classList.add('hidden');
  deleteIncomeTarget = null;
};

window.confirmIncomeDelete = async () => {
  if (!deleteIncomeTarget) return;
  try {
    await deleteDoc(doc(db, 'income', deleteIncomeTarget));
    allIncome = allIncome.filter(i => i.id !== deleteIncomeTarget);
    updateIncomeSummaryCards();
    showToast('Deleted.', 'success');
  } catch (e) {
    showToast('Delete failed.', 'error');
  }
  closeIncomeDeleteModal();
};

window.deleteFromIncomeEdit = async () => {
  if (!editingIncomeId) return;
  deleteIncomeTarget = editingIncomeId;
  closeIncomeEditModal();
  document.getElementById('income-delete-modal').classList.remove('hidden');
};


