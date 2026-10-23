// debt.js — SpendWise Debts page

import { db } from './config/firebase.js';
import { collection, addDoc, getDocs, deleteDoc, doc, query, where, serverTimestamp, updateDoc, deleteField } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { sanitize, escapeHtml, bindDateChips, shortDay, todayStr, countTo } from './utils/helpers.js';
import { showToast, requireUser, initCurrencySelector } from './modules/page-shell.js';
import { fetchSharedDebts, emailError, shareFields, announceDebts, claimSettled, withdrawClaim, confirmClaim, rejectClaim } from './modules/split.js';
import { setKnownPeople } from './modules/people.js';

// Currency helpers from global scope (currency.js loads before this module)
const fmt = window.fmt;

// ── State ────────────────────────────────────────────────────────────────────
let currentUser = null;
let allDebts = [];
let deleteDebtTarget = null;
let settleDebtTarget = null;
let reactivateDebtTarget = null;
let currentDebtType = 'they-owe';
let editingDebtId = null;

function showDebtFormMsg(msg, type) {
  const el = document.getElementById('debt-form-msg');
  el.textContent = msg;
  el.className = 'form-msg ' + type;
  el.classList.remove('hidden');
  if (type === 'success') setTimeout(() => el.classList.add('hidden'), 3000);
}

requireUser(user => {
  currentUser = user;
  // every amount on the page is in the chosen currency, lists included
  initCurrencySelector(() => { updateDebtSummary(); renderDebts(); renderDebtHistory(); });
  const dateEl = document.getElementById('debt-date');
  if (dateEl && !dateEl.value) dateEl.value = todayStr();
  syncDateChips();
  loadDebts();
});

// ── Load Debts ───────────────────────────────────────────────────────────────
async function loadDebts() {
  if (!currentUser) return;
  try {
    const q = query(collection(db, 'debts'), where('uid', '==', currentUser.uid));
    // Plus debts others split with this account's email: shown, but only they can change them
    const [snap, shared] = await Promise.all([getDocs(q), fetchSharedDebts(currentUser)]);
    allDebts = snap.docs.map(d => {
      const raw = d.data();
      const amt = parseFloat(raw.amount);
      return {
        id: d.id,
        ...raw,
        amount: isNaN(amt) ? 0 : amt,
        settledDate: raw.settledDate || '',
      };
    }).concat(shared);
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
  countTo(netEl, Math.abs(net), fmt);
  netEl.classList.toggle('is-income', net > 0);
  netEl.classList.toggle('is-owe', net < 0);
  document.getElementById('debt-net-word').textContent = net > 0 ? 'in your favour' : net < 0 ? 'you owe overall' : 'all square';
  const people = new Set(active.map(d => d.person)).size;
  document.getElementById('debt-net-sub').textContent = active.length
    ? `${plural(active.length, 'open debt', 'open debts')} with ${plural(people, 'person', 'people')}`
    : 'No open debts';
  countTo(document.getElementById('debt-owed-to-you'), owedToYou, fmt);
  countTo(document.getElementById('debt-you-owe'), youOwe, fmt);
  document.getElementById('debt-owe-count').textContent = `${owe.length} open`;
  document.getElementById('debt-owed-count').textContent = `${owed.length} open`;

  // People dealt with before, so a repeat person (and their email) is picked rather than retyped
  setKnownPeople(allDebts);
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
    // A settle claim: the person it's shared with says it's settled, and the one who added it confirms
    const claim = !d.claimDate ? '' : d.shared ? 'You said it’s settled · waiting for them' : `${d.person} says it’s settled`;
    const meta = [d.type === 'they-owe' ? 'Owes you' : 'You owe', shortDay(d.date), d.shared ? 'Added by them' : d.withEmail ? 'Shared' : '', claim, d.pending ? 'Waiting to sync' : ''].filter(Boolean).join(' · ');
    const who = escapeHtml(d.person);
    const id = escapeHtml(d.id);
    const amount = fmt(d.amount);
    let actions = '';
    if (d.pending) {
      // offline entries have no record to update until they sync
    } else if (d.shared) {
      actions = d.claimDate
        ? `<button type="button" class="debt-action" data-claim="undo" data-debt-id="${id}" aria-label="Undo saying ${amount} with ${who} is settled">Undo</button>`
        : `<button type="button" class="debt-action" data-claim="claim" data-debt-id="${id}" aria-label="Tell ${who} ${d.type === 'i-owe' ? `you paid ${amount}` : `you got ${amount}`}">${d.type === 'i-owe' ? 'I paid' : 'I got paid'}</button>`;
    } else if (d.claimDate) {
      actions = `<div class="debt-claim-actions">
        <button type="button" class="debt-action debt-action-quiet" data-claim="reject" data-debt-id="${id}" aria-label="Not settled yet: ${amount} with ${who}">Not yet</button>
        <button type="button" class="debt-action" data-claim="confirm" data-debt-id="${id}" aria-label="Confirm ${amount} with ${who} is settled">Confirm</button>
      </div>`;
    } else {
      actions = `
      <button type="button" class="debt-action" data-action="openDebtSettleModal" data-debt-id="${id}" aria-label="Settle ${amount} with ${who}">Settle</button>
      <button type="button" class="icon-btn" data-action="openDebtDeleteModal" data-debt-id="${id}" aria-label="Delete debt with ${who}" title="Delete"><i data-lucide="trash-2"></i></button>`;
    }
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
    if (d.shared) return debtRow(d, `${meta} · Added by them`, '');
    return debtRow(d, meta, `<button type="button" class="debt-action" data-action="openDebtReactivateModal" data-debt-id="${escapeHtml(d.id)}" aria-label="Reopen debt with ${escapeHtml(d.person)}">Reopen</button>`);
  }).join('');
}

// ── Add Debt ─────────────────────────────────────────────────────────────────
window.addDebt = async () => {
  const amount = parseFloat(document.getElementById('debt-amount').value);
  const person = sanitize(document.getElementById('debt-person').value.trim(), 100);
  const date = document.getElementById('debt-date').value;
  const notes = sanitize(document.getElementById('debt-notes').value.trim(), 500);
  const email = document.getElementById('debt-email').value.trim().toLowerCase();

  if (!amount || amount <= 0) { showDebtFormMsg('Enter a valid amount.', 'error'); return; }
  if (!person) { showDebtFormMsg('Enter person name.', 'error'); return; }
  if (!date) { showDebtFormMsg('Select a date.', 'error'); return; }
  const badEmail = emailError(email);
  if (badEmail) { showDebtFormMsg(badEmail, 'error'); return; }

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
    createdAt: serverTimestamp(),
    ...shareFields(email),
  };
  const shared = shareFields(email);

  if (window.isOffline && window.isOffline()) {
    if (typeof window.addToOfflineQueue === 'function') {
      window.addToOfflineQueue('debt', debtData);
      allDebts.unshift({ id: 'offline-' + Date.now(), amount, type: currentDebtType, person, date, notes: notes || '', settled: false, settledDate: '', pending: true, ...shared });
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
    announceDebts([ref], [debtData]);

    allDebts.unshift({ id: ref.id, amount, type: currentDebtType, person, date, notes: notes || '', settled: false, settledDate: '', ...shared });
    allDebts.sort((a, b) => b.date.localeCompare(a.date));
    updateDebtSummary();
    renderDebts();
    renderDebtHistory();
    resetDebtForm();
    showDebtFormMsg(email ? `Debt added and shared with ${email}.` : 'Debt added successfully!', 'success');
    showToast('Debt added!', 'success');
    window.markLoggedToday?.(); // skips today's reminder (reminders.js)
  } catch (e) {
    console.error(e);
    if (window.addToOfflineQueue && navigator.onLine === false) {
      window.addToOfflineQueue('debt', debtData);
      allDebts.unshift({ id: 'offline-' + Date.now(), amount, type: currentDebtType, person, date, notes: notes || '', settled: false, settledDate: '', pending: true, ...shared });
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
  ['debt-amount', 'debt-person', 'debt-email', 'debt-notes'].forEach(id => {
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
    await updateDoc(debtRef, { settled: true, settledDate, claimDate: deleteField() });

    const idx = allDebts.findIndex(d => d.id === settleDebtTarget);
    if (idx >= 0) {
      allDebts[idx].settled = true;
      allDebts[idx].settledDate = settledDate;
      allDebts[idx].claimDate = '';
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

// ── Settle claims on shared debts (split.js) ─────────────────────────────────
const CLAIM_DONE = {
  claim: 'Sent. They’ll confirm it’s settled.',
  undo: 'Taken back.',
  confirm: 'Debt settled!',
  reject: 'Kept open. They can say so again once it’s settled.',
};

document.getElementById('debt-body')?.addEventListener('click', async e => {
  const btn = e.target.closest('[data-claim]');
  if (!btn) return;
  const kind = btn.dataset.claim;
  const d = allDebts.find(x => x.id === btn.dataset.debtId);
  if (!d) return;
  btn.disabled = true;
  try {
    if (kind === 'claim') d.claimDate = await claimSettled(d.id);
    else if (kind === 'undo' || kind === 'reject') { await (kind === 'undo' ? withdrawClaim : rejectClaim)(d.id); d.claimDate = ''; }
    else if (kind === 'confirm') { await confirmClaim(d.id, d.claimDate); Object.assign(d, { settled: true, settledDate: d.claimDate, claimDate: '' }); }
    updateDebtSummary();
    renderDebts();
    renderDebtHistory();
    showToast(CLAIM_DONE[kind], 'success');
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    showToast("Couldn't update the debt. Check your connection and try again.", 'error');
  }
});

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

// Refresh after offline-queue.js writes queued items
window.addEventListener('spendwise:synced', () => loadDebts());
