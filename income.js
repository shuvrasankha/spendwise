// income.js — SpendWise Income Tracker (Firebase Modular SDK)

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged, signOut, GoogleAuthProvider } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, addDoc, getDocs, deleteDoc, doc, query, where, serverTimestamp, updateDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const firebaseConfig = {
  apiKey: "AIzaSyBKOgU4yeEhwGedRfVZfp8p0LGibfPO2hI",
  authDomain: "spendwise-app-f7227.firebaseapp.com",
  projectId: "spendwise-app-f7227",
  storageBucket: "spendwise-app-f7227.firebasestorage.app",
  messagingSenderId: "243303574314",
  appId: "1:243303574314:web:e1c66c625f814559c38c53",
  measurementId: "G-W8LZXEF75G"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ── State ────────────────────────────────────────────────────────────────────
let currentUser = null;
let allIncome = [];
let editingIncomeId = null;
let deleteIncomeTarget = null;
let incomeSortCol = 'date';
let incomeSortAsc = false;
let incomeHistoryPage = 1;
const INCOME_PER_PAGE = 10;

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmt(n) {
  return 'Rs ' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
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

    // Set greeting
    const h = new Date().getHours();
    const g = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const n = user.displayName ? user.displayName.split(' ')[0] : '';
    document.getElementById('income-greeting').textContent = g + (n ? ', ' + n : '') + '!';

    updateThemeIcon();

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
    renderIncomeTable();
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
  const source = document.getElementById('inc-source').value.trim();
  const paymentType = document.getElementById('inc-payment').value;
  const bank = paymentType === 'Online' ? document.getElementById('inc-bank').value.trim() : '';
  const notes = document.getElementById('inc-notes').value.trim();

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
    renderIncomeTable();
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

// ── Render Table ──────────────────────────────────────────────────────────────
window.sortIncomeTable = (col) => {
  if (incomeSortCol === col) {
    incomeSortAsc = !incomeSortAsc;
  } else {
    incomeSortCol = col;
    incomeSortAsc = col === 'amount' ? false : true;
  }
  incomeHistoryPage = 1;
  renderIncomeTable();
};

function renderIncomeTable() {
  const sorted = allIncome.slice().sort((a, b) => {
    let valA = a[incomeSortCol];
    let valB = b[incomeSortCol];
    if (typeof valA === 'string') valA = valA.toLowerCase();
    if (typeof valB === 'string') valB = valB.toLowerCase();
    if (valA < valB) return incomeSortAsc ? -1 : 1;
    if (valA > valB) return incomeSortAsc ? 1 : -1;
    return 0;
  });

  // Update sort header icons
  document.querySelectorAll('#income-table-body').forEach(() => {});
  document.querySelectorAll('th.sortable[data-col]').forEach(th => {
    th.classList.remove('active', 'asc', 'desc');
    if (th.dataset.col === incomeSortCol) {
      th.classList.add('active', incomeSortAsc ? 'asc' : 'desc');
    }
  });

  const total = sorted.reduce((s, i) => s + i.amount, 0);
  document.getElementById('income-count').textContent = sorted.length + ' entr' + (sorted.length !== 1 ? 'ies' : 'y');
  const totalEl = document.getElementById('income-total');
  if (totalEl) totalEl.textContent = sorted.length ? 'Total: ' + fmt(total) : '';

  const totalPages = Math.max(1, Math.ceil(sorted.length / INCOME_PER_PAGE));
  if (incomeHistoryPage > totalPages) incomeHistoryPage = totalPages;

  const start = (incomeHistoryPage - 1) * INCOME_PER_PAGE;
  const pageRows = sorted.slice(start, start + INCOME_PER_PAGE);

  const tbody = document.getElementById('income-table-body');

  if (!pageRows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-row">No income entries yet. Add your first one above!</td></tr>`;
    document.getElementById('income-pagination').innerHTML = '';
    return;
  }

  tbody.innerHTML = '';
  pageRows.forEach(entry => {
    const tr = document.createElement('tr');

    const tdDate = document.createElement('td');
    tdDate.dataset.label = 'Date';
    tdDate.textContent = formatDate(entry.date);
    tr.appendChild(tdDate);

    const tdSrc = document.createElement('td');
    tdSrc.dataset.label = 'Source';
    const badge = document.createElement('span');
    badge.className = 'category-badge income-source-badge';
    badge.textContent = entry.source || '-';
    tdSrc.appendChild(badge);
    tr.appendChild(tdSrc);

    const tdPay = document.createElement('td');
    tdPay.dataset.label = 'Payment';
    tdPay.textContent = entry.paymentType || '-';
    tr.appendChild(tdPay);

    const tdBank = document.createElement('td');
    tdBank.dataset.label = 'Bank';
    tdBank.textContent = entry.bank || '-';
    tr.appendChild(tdBank);

    const tdNotes = document.createElement('td');
    tdNotes.dataset.label = 'Notes';
    tdNotes.textContent = entry.notes || '-';
    tr.appendChild(tdNotes);

    const tdAmt = document.createElement('td');
    tdAmt.dataset.label = 'Amount';
    tdAmt.className = 'text-right income-amount-cell';
    tdAmt.textContent = fmt(entry.amount);
    tr.appendChild(tdAmt);

    const tdAct = document.createElement('td');
    tdAct.className = 'text-center';
    tdAct.innerHTML = `<div class='action-buttons'><button class='btn-action edit' onclick="openIncomeEdit('${entry.id}')" title='Edit'><i class='lucide' data-lucide='pencil'></i></button><button class='btn-action delete' onclick="deleteIncomeEntry('${entry.id}')" title='Delete'><i class='lucide' data-lucide='trash-2'></i></button></div>`;
    tr.appendChild(tdAct);

    tbody.appendChild(tr);
  });

  if (window.lucide) lucide.createIcons();
  renderIncomePagination(sorted.length, totalPages);
}

function renderIncomePagination(totalItems, totalPages) {
  const el = document.getElementById('income-pagination');
  if (!el) return;
  if (totalPages <= 1) { el.innerHTML = ''; return; }

  const MAX_VISIBLE = 7;
  let startP = Math.max(1, incomeHistoryPage - Math.floor(MAX_VISIBLE / 2));
  let endP = Math.min(totalPages, startP + MAX_VISIBLE - 1);
  if (endP - startP + 1 < MAX_VISIBLE) startP = Math.max(1, endP - MAX_VISIBLE + 1);

  let html = `<button class="page-btn" onclick="goToIncomePage(${incomeHistoryPage - 1})" ${incomeHistoryPage === 1 ? 'disabled' : ''}><i data-lucide="chevron-left"></i></button>`;
  if (startP > 1) {
    html += `<button class="page-btn" onclick="goToIncomePage(1)">1</button>`;
    if (startP > 2) html += `<span class="pagination-dots">…</span>`;
  }
  for (let i = startP; i <= endP; i++) {
    html += `<button class="page-btn${i === incomeHistoryPage ? ' active' : ''}" onclick="goToIncomePage(${i})">${i}</button>`;
  }
  if (endP < totalPages) {
    if (endP < totalPages - 1) html += `<span class="pagination-dots">…</span>`;
    html += `<button class="page-btn" onclick="goToIncomePage(${totalPages})">${totalPages}</button>`;
  }
  const from = (incomeHistoryPage - 1) * INCOME_PER_PAGE + 1;
  const to = Math.min(incomeHistoryPage * INCOME_PER_PAGE, totalItems);
  html += `<span class="pagination-info">${from}–${to} of ${totalItems}</span>`;
  html += `<button class="page-btn" onclick="goToIncomePage(${incomeHistoryPage + 1})" ${incomeHistoryPage === totalPages ? 'disabled' : ''}><i data-lucide="chevron-right"></i></button>`;

  el.innerHTML = html;
  if (window.lucide) lucide.createIcons();
}

window.goToIncomePage = (p) => {
  incomeHistoryPage = p;
  renderIncomeTable();
};

// ── Edit Income ───────────────────────────────────────────────────────────────
window.openIncomeEdit = (id) => {
  const entry = allIncome.find(i => i.id === id);
  if (!entry) return;
  editingIncomeId = id;

  document.getElementById('edit-inc-amount').value = entry.amount;
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
  const source = document.getElementById('edit-inc-source').value.trim();
  const paymentType = document.getElementById('edit-inc-payment').value;
  const bank = paymentType === 'Online' ? document.getElementById('edit-inc-bank').value.trim() : '';
  const notes = document.getElementById('edit-inc-notes').value.trim();

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
    renderIncomeTable();
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
    renderIncomeTable();
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

// ── Download CSV ──────────────────────────────────────────────────────────────
window.downloadIncomeCSV = () => {
  if (!allIncome.length) { showToast('No data to export.', 'error'); return; }
  const hdr = ['Date', 'Source', 'Payment Type', 'Bank/Wallet', 'Notes', 'Amount (Rs)'];
  const csv = [hdr.join(','), ...allIncome.map(i => [
    i.date,
    '"' + (i.source || '').replace(/"/g, '""') + '"',
    '"' + (i.paymentType || '') + '"',
    '"' + (i.bank || '').replace(/"/g, '""') + '"',
    '"' + (i.notes || '').replace(/"/g, '""') + '"',
    i.amount.toFixed(2)
  ].join(','))].join('\n');

  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'SpendWise_Income_' + todayStr() + '.csv';
  a.click();
  showToast('CSV downloaded!', 'success');
};
