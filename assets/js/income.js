// income.js — SpendWise Income page

import { db } from './config/firebase.js';
import { collection, addDoc, getDocs, deleteDoc, doc, query, where, serverTimestamp, updateDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { sanitize, escapeHtml, bindDateChips, shortDay, pad, todayStr } from './utils/helpers.js';
import { showToast, requireUser, initCurrencySelector } from './modules/page-shell.js';

// Currency helpers from global scope (currency.js loads before this module)
const fmt = window.fmt;
const updateCurrencyDisplay = window.updateCurrencyDisplay;

// ── State ────────────────────────────────────────────────────────────────────
let currentUser = null;
let allIncome = [];
let editingIncomeId = null;
let deleteIncomeTarget = null;

function showFormMsg(msg, type) {
  const el = document.getElementById('income-form-msg');
  el.textContent = msg;
  el.className = 'form-msg ' + type;
  el.classList.remove('hidden');
  if (type === 'success') setTimeout(() => el.classList.add('hidden'), 3000);
}

requireUser(user => {
  currentUser = user;
  initCurrencySelector(updateIncomeSummaryCards);
  const dateEl = document.getElementById('inc-date');
  if (dateEl && !dateEl.value) dateEl.value = todayStr();
  syncDateChips();
  loadIncome();
});

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

// ── Page: this month, recent entries, and suggestions from past entries ──────
const RECENT_COUNT = 8;
const countBy = (rows, key) => {
  const counts = {};
  rows.forEach(r => { const k = (r[key] || '').trim(); if (k) counts[k] = (counts[k] || 0) + 1; });
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
};

function updateIncomeSummaryCards() {
  const now = new Date();
  const ms = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-01';
  const ys = now.getFullYear() + '-01-01';
  const today = todayStr();
  const monthly = allIncome.filter(i => i.date >= ms && i.date <= today);
  const yearTotal = allIncome.filter(i => i.date >= ys && i.date <= today).reduce((s, i) => s + i.amount, 0);

  document.getElementById('inc-month-label').textContent = now.toLocaleDateString('en-US', { month: 'long' }) + ' so far';
  document.getElementById('inc-monthly').textContent = fmt(monthly.reduce((s, i) => s + i.amount, 0));
  document.getElementById('inc-monthly-sub').textContent =
    `${monthly.length} ${monthly.length === 1 ? 'entry' : 'entries'} · ${fmt(yearTotal)} this year`;

  // Recent entries; offline ones can't be edited until they sync
  const list = document.getElementById('inc-recent-list');
  list.innerHTML = allIncome.length ? allIncome.slice(0, RECENT_COUNT).map(i => {
    const meta = [shortDay(i.date), i.paymentType === 'Cash' ? 'Cash' : i.bank || 'Online', i.pending ? 'Waiting to sync' : ''].filter(Boolean).join(' · ');
    return `<li><button type="button" class="hist-row" data-income-id="${escapeHtml(i.id)}" ${i.pending ? 'disabled' : ''}>
      <span class="hist-row-main">
        <span class="hist-row-title">${escapeHtml(i.source || 'Income')}</span>
        <span class="hist-row-meta">${escapeHtml(meta)}</span>
        ${i.notes ? `<span class="hist-row-note">${escapeHtml(i.notes)}</span>` : ''}
      </span>
      <span class="hist-row-amount income">+${fmt(i.amount)}</span>
    </button></li>`;
  }).join('') : '<li class="hist-empty">No income yet. Add your first one above.</li>';

  // Choices over typing: sources and banks used before
  document.getElementById('inc-source-chips').innerHTML = countBy(allIncome, 'source').slice(0, 6)
    .map(src => `<button type="button" class="chip" data-inc-source="${escapeHtml(src)}">${escapeHtml(src)}</button>`).join('');
  document.getElementById('inc-bank-list').innerHTML = countBy(allIncome, 'bank')
    .map(b => `<option value="${escapeHtml(b)}"></option>`).join('');
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

  const incomeData = {
    uid: currentUser.uid,
    amount,
    date,
    source,
    paymentType,
    bank: bank || '',
    notes: notes || '',
    encoding: 'plain',
    createdAt: serverTimestamp()
  };

  if (window.isOffline && window.isOffline()) {
    if (typeof window.addToOfflineQueue === 'function') {
      window.addToOfflineQueue('income', incomeData);
      allIncome.unshift({ id: 'offline-' + Date.now(), amount, date, source, paymentType, bank: bank || '', notes: notes || '', pending: true });
      allIncome.sort((a, b) => b.date.localeCompare(a.date));
      updateIncomeSummaryCards();
      resetIncomeForm();
      showFormMsg('Income saved offline. Will sync when online.', 'success');
      showToast('Saved offline!', 'success');
    } else {
      showFormMsg('Cannot save offline. Please check your connection.', 'error');
    }
    return;
  }

  try {
    const ref = await addDoc(collection(db, 'income'), incomeData);

    allIncome.unshift({ id: ref.id, amount, date, source, paymentType, bank: bank || '', notes: notes || '' });
    allIncome.sort((a, b) => b.date.localeCompare(a.date));
    updateIncomeSummaryCards();
    resetIncomeForm();
    showFormMsg('Income added successfully!', 'success');
    showToast('Income added!', 'success');
    window.markLoggedToday?.(); // skips today's reminder (reminders.js)
  } catch (e) {
    console.error(e);
    if (window.addToOfflineQueue && navigator.onLine === false) {
      window.addToOfflineQueue('income', incomeData);
      allIncome.unshift({ id: 'offline-' + Date.now(), amount, date, source, paymentType, bank: bank || '', notes: notes || '', pending: true });
      allIncome.sort((a, b) => b.date.localeCompare(a.date));
      updateIncomeSummaryCards();
      resetIncomeForm();
      showFormMsg('Saved offline due to error. Will sync when online.', 'success');
      showToast('Saved offline!', 'success');
    } else {
      showFormMsg('Failed to save. Try again.', 'error');
    }
  }
};

// ── Reset Form ────────────────────────────────────────────────────────────────
window.resetIncomeForm = () => {
  ['inc-amount', 'inc-source', 'inc-bank', 'inc-notes'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  setIncomePayment('Online');
  document.getElementById('inc-date').value = todayStr();
  syncDateChips();
  document.getElementById('income-form-msg').classList.add('hidden');
  document.getElementById('income-form-heading').textContent = 'Add income';
  document.getElementById('income-btn-label').textContent = 'Add income';
  editingIncomeId = null;
};

// ── Online / Cash ─────────────────────────────────────────────────────────────
function setIncomePayment(val) {
  document.getElementById('inc-payment').value = val;
  document.querySelectorAll('[data-inc-payment]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.incPayment === val)));
  document.getElementById('inc-bank-wrap').style.display = val === 'Online' ? '' : 'none';
  if (val === 'Cash') document.getElementById('inc-bank').value = '';
}

// ── Page wiring ───────────────────────────────────────────────────────────────
const syncDateChips = bindDateChips(document.getElementById('inc-date'), document.getElementById('add-income-section'));
document.querySelectorAll('[data-inc-payment]').forEach(b => b.addEventListener('click', () => setIncomePayment(b.dataset.incPayment)));
document.getElementById('inc-source-chips').addEventListener('click', e => {
  const chip = e.target.closest('[data-inc-source]');
  if (!chip) return;
  document.getElementById('inc-source').value = chip.dataset.incSource;
  // the bank last used with this source is the likely one again
  const last = allIncome.find(i => i.source === chip.dataset.incSource);
  if (last) {
    setIncomePayment(last.paymentType === 'Cash' ? 'Cash' : 'Online');
    if (last.bank) document.getElementById('inc-bank').value = last.bank;
  }
});
document.getElementById('inc-recent-list').addEventListener('click', e => {
  const row = e.target.closest('[data-income-id]');
  if (row && !row.disabled) window.openIncomeEdit(row.dataset.incomeId);
});

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



// Refresh after offline-queue.js writes queued items
window.addEventListener('spendwise:synced', () => loadIncome());
