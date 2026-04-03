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

// ── State ────────────────────────────────────────────────────────────────────
let currentUser = null;
let allDebts = [];
let deleteDebtTarget = null;
let settleDebtTarget = null;
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
  setTimeout(() => t.classList.add('hidden'), 3000);
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

    const avatarEl = document.getElementById('user-avatar');
    if (user.photoURL) {
      avatarEl.innerHTML = `<img src="${user.photoURL}" referrerpolicy="no-referrer" alt="Profile" onerror="this.parentElement.textContent='${(user.displayName || user.email || 'U')[0].toUpperCase()}'"/>`;
    } else {
      avatarEl.textContent = (user.displayName || user.email || 'U')[0].toUpperCase();
    }

    updateThemeIcon();
    initCurrencySelector();

    // Init date
    const dateEl = document.getElementById('debt-date');
    if (dateEl && !dateEl.value) dateEl.value = todayStr();

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

// ── Summary Cards ────────────────────────────────────────────────────────────
function updateDebtSummary() {
  const active = allDebts.filter(d => !d.settled);
  const settled = allDebts.filter(d => d.settled);

  const owedToYou = active.filter(d => d.type === 'they-owe').reduce((s, d) => s + d.amount, 0);
  const youOwe = active.filter(d => d.type === 'i-owe').reduce((s, d) => s + d.amount, 0);
  const settledTotal = settled.reduce((s, d) => s + d.amount, 0);

  const owedCount = active.filter(d => d.type === 'they-owe').length;
  const oweCount = active.filter(d => d.type === 'i-owe').length;

  document.getElementById('debt-owed-to-you').textContent = fmt(owedToYou);
  document.getElementById('debt-owed-count').textContent = owedCount + ' pending';
  document.getElementById('debt-you-owe').textContent = fmt(youOwe);
  document.getElementById('debt-owe-count').textContent = oweCount + ' pending';
  document.getElementById('debt-net-balance').textContent = fmt(owedToYou - youOwe);
  document.getElementById('debt-settled-total').textContent = fmt(settledTotal);
  document.getElementById('debt-settled-count').textContent = settled.length + ' settled';

  // Color net balance
  const netEl = document.getElementById('debt-net-balance');
  const net = owedToYou - youOwe;
  netEl.style.color = net >= 0 ? 'var(--success)' : 'var(--danger)';
}

// ── Render Active Debts ──────────────────────────────────────────────────────
function renderDebts() {
  const tbody = document.getElementById('debt-body');
  const active = allDebts.filter(d => !d.settled);

  if (!active.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-row">No debts recorded yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = '';
  active.forEach(d => {
    const tr = document.createElement('tr');

    // Type badge
    const tdType = document.createElement('td');
    tdType.dataset.label = 'Type';
    const badge = document.createElement('span');
    badge.className = d.type === 'they-owe' ? 'debt-badge-green' : 'debt-badge-red';
    badge.textContent = d.type === 'they-owe' ? 'They Owe Me' : 'I Owe Them';
    tdType.appendChild(badge);
    tr.appendChild(tdType);

    // Person
    const tdPerson = document.createElement('td');
    tdPerson.dataset.label = 'Person';
    tdPerson.textContent = d.person;
    tr.appendChild(tdPerson);

    // Date
    const tdDate = document.createElement('td');
    tdDate.dataset.label = 'Date';
    tdDate.textContent = formatDate(d.date);
    tr.appendChild(tdDate);

    // Notes
    const tdNotes = document.createElement('td');
    tdNotes.dataset.label = 'Notes';
    tdNotes.textContent = d.notes || '-';
    tr.appendChild(tdNotes);

    // Amount
    const tdAmt = document.createElement('td');
    tdAmt.dataset.label = 'Amount';
    tdAmt.className = 'text-right';
    tdAmt.textContent = fmt(d.amount);
    tr.appendChild(tdAmt);

    // Actions
    const tdAct = document.createElement('td');
    tdAct.dataset.label = 'Actions';
    tdAct.className = 'text-center';
    tdAct.innerHTML = `
      <div class="action-buttons">
        <button class="btn-action settle" onclick="openDebtSettleModal('${d.id}')" title="Settle">
          <i data-lucide="check-circle"></i>
        </button>
        <button class="btn-action delete" onclick="openDebtDeleteModal('${d.id}')" title="Delete">
          <i data-lucide="trash-2"></i>
        </button>
      </div>
    `;
    tr.appendChild(tdAct);

    tbody.appendChild(tr);
  });

  if (window.lucide) lucide.createIcons();
}

// ── Render Settled Debt History ──────────────────────────────────────────────
function renderDebtHistory() {
  const tbody = document.getElementById('debt-history-body');
  const settled = allDebts.filter(d => d.settled).sort((a, b) => (b.settledDate || '').localeCompare(a.settledDate || ''));

  if (!settled.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-row">No settled debts yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = '';
  settled.forEach(d => {
    const tr = document.createElement('tr');

    // Type badge
    const tdType = document.createElement('td');
    tdType.dataset.label = 'Type';
    const badge = document.createElement('span');
    badge.className = d.type === 'they-owe' ? 'debt-badge-green' : 'debt-badge-red';
    badge.textContent = d.type === 'they-owe' ? 'They Owe Me' : 'I Owe Them';
    tdType.appendChild(badge);
    tr.appendChild(tdType);

    // Person
    const tdPerson = document.createElement('td');
    tdPerson.dataset.label = 'Person';
    tdPerson.textContent = d.person;
    tr.appendChild(tdPerson);

    // Date
    const tdDate = document.createElement('td');
    tdDate.dataset.label = 'Date';
    tdDate.textContent = formatDate(d.date);
    tr.appendChild(tdDate);

    // Settled Date
    const tdSettled = document.createElement('td');
    tdSettled.dataset.label = 'Settled On';
    tdSettled.textContent = d.settledDate ? formatDate(d.settledDate) : '-';
    tr.appendChild(tdSettled);

    // Amount
    const tdAmt = document.createElement('td');
    tdAmt.dataset.label = 'Amount';
    tdAmt.className = 'text-right';
    tdAmt.textContent = fmt(d.amount);
    tr.appendChild(tdAmt);

    tbody.appendChild(tr);
  });
}

// ── Add Debt ─────────────────────────────────────────────────────────────────
window.addDebt = async () => {
  const amount = parseFloat(document.getElementById('debt-amount').value);
  const person = document.getElementById('debt-person').value.trim();
  const date = document.getElementById('debt-date').value;
  const notes = document.getElementById('debt-notes').value.trim();

  if (!amount || amount <= 0) { showDebtFormMsg('Enter a valid amount.', 'error'); return; }
  if (!person) { showDebtFormMsg('Enter person name.', 'error'); return; }
  if (!date) { showDebtFormMsg('Select a date.', 'error'); return; }

  try {
    const ref = await addDoc(collection(db, 'debts'), {
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
    });

    allDebts.unshift({ id: ref.id, amount, type: currentDebtType, person, date, notes: notes || '', settled: false, settledDate: '' });
    allDebts.sort((a, b) => b.date.localeCompare(a.date));
    updateDebtSummary();
    renderDebts();
    renderDebtHistory();
    resetDebtForm();
    showDebtFormMsg('Debt added successfully!', 'success');
    showToast('Debt added!', 'success');
  } catch (e) {
    console.error(e);
    showDebtFormMsg('Failed to save. Try again.', 'error');
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
  document.getElementById('debt-form-heading').textContent = 'Add Debt';
  document.getElementById('debt-btn-label').textContent = 'Add Debt';
};

// ── Debt Type Toggle ─────────────────────────────────────────────────────────
window.setDebtType = (type) => {
  currentDebtType = type;
  document.querySelectorAll('.debt-type-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.type === type);
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
    document.getElementById('debt-settle-msg').textContent = `Settle ${fmt(debt.amount)} with ${debt.person}?`;
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

function friendlyErr(code) {
  const m = {
    'auth/user-not-found': 'No account with this email.',
    'auth/wrong-password': 'Incorrect password.',
    'auth/email-already-in-use': 'Email already registered.',
    'auth/invalid-email': 'Invalid email.',
    'auth/weak-password': 'Password too short.',
    'auth/popup-closed-by-user': 'Sign-in cancelled.',
    'auth/invalid-credential': 'Invalid email or password.'
  };
  return m[code] || 'Something went wrong. Try again.';
}

// Import auth functions
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, signInWithPopup, GoogleAuthProvider, updateProfile, sendEmailVerification } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
const gProvider = new GoogleAuthProvider();
