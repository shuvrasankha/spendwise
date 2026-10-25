// debt.js — SpendWise Debts page

import { db } from './config/firebase.js';
import { collection, addDoc, getDocs, deleteDoc, doc, query, where, serverTimestamp, updateDoc, deleteField } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { sanitize, escapeHtml, bindDateChips, shortDay, todayStr, countTo, debtLeft, debtPaid, payDebt, debtClaim } from './utils/helpers.js';
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
  const owedToYou = owed.reduce((s, d) => s + debtLeft(d), 0); // what's left after part-payments
  const youOwe = owe.reduce((s, d) => s + debtLeft(d), 0);
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

const keep = t => String(t).replace(/ /g, '\u00a0'); // an amount never splits across lines

// One row: who, which way, when, the amount, then the row's actions. An open debt with part-payments
// shows what's left, with how much of it has been paid back under it.
function debtRow(d, meta, actions) {
  const paid = debtPaid(d);
  const part = !d.settled && paid > 0;
  const share = part ? Math.min(paid / d.amount, 1) * 100 : 0;
  return `<li class="debt-row">
    <div class="hist-row-main">
      <span class="hist-row-title">${escapeHtml(d.person)}</span>
      <span class="hist-row-meta">${escapeHtml(meta)}</span>
      ${part ? `<span class="debt-row-paid">${keep(fmt(paid))} paid back</span>
      <span class="debt-row-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(share)}" aria-label="Paid back"><span style="width:${share.toFixed(1)}%"></span></span>` : ''}
      ${d.notes ? `<span class="hist-row-note">${escapeHtml(d.notes)}</span>` : ''}
    </div>
    <span class="hist-row-amount ${d.type === 'they-owe' ? 'income' : 'owe'}">${fmt(d.settled ? d.amount : debtLeft(d))}${part ? '<small>left</small>' : ''}</span>
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
    // A claim: the person it's shared with says what was paid, and the one who added it confirms
    const c = debtClaim(d);
    const said = c && `${fmt(c.amount)}${c.settles ? ', all of it' : ''}`;
    const claim = !c ? ''
      : d.shared ? `${d.type === 'i-owe' ? 'You said you paid' : `You said ${d.person} paid you`} ${said} · waiting for them`
      : `${d.person} says ${d.type === 'they-owe' ? 'they paid you' : 'you paid them'} ${said}`;
    const meta = [d.type === 'they-owe' ? 'Owes you' : 'You owe', shortDay(d.date), d.shared ? 'Added by them' : d.withEmail ? 'Shared' : '', claim, d.pending ? 'Waiting to sync' : ''].filter(Boolean).join(' · ');
    const who = escapeHtml(d.person);
    const id = escapeHtml(d.id);
    const amount = fmt(debtLeft(d));
    let actions = '';
    if (d.pending) {
      // offline entries have no record to update until they sync
    } else if (d.shared) {
      // They record it; you say what was paid (part or all), and they confirm
      actions = d.claimDate
        ? `<button type="button" class="debt-action" data-claim="undo" data-debt-id="${id}" aria-label="Take back what you said was paid to ${who}">Undo</button>`
        : `<button type="button" class="debt-action" data-action="openDebtSettleModal" data-debt-id="${id}" aria-label="Tell ${who} ${d.type === 'i-owe' ? 'how much you paid' : 'how much you got'} of ${amount}">${d.type === 'i-owe' ? 'I paid' : 'I got paid'}</button>`;
    } else if (d.claimDate) {
      actions = `<div class="debt-claim-actions">
        <button type="button" class="debt-action debt-action-quiet" data-claim="reject" data-debt-id="${id}" aria-label="Not paid yet: ${said} with ${who}">Not yet</button>
        <button type="button" class="debt-action" data-claim="confirm" data-debt-id="${id}" aria-label="Confirm ${said} was paid, with ${who}">Confirm</button>
      </div>`;
    } else {
      actions = `
      <button type="button" class="debt-action" data-action="openDebtSettleModal" data-debt-id="${id}" aria-label="Record a payment on ${amount} with ${who}">${d.type === 'they-owe' ? 'Got paid' : 'I paid'}</button>
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

// ── Payment on a debt ────────────────────────────────────────────────────────
// Part of it is kept as a payment and the debt stays open with what's left; paying what's left
// settles it on the payment's date.
const $ = id => document.getElementById(id);
const syncPayChips = bindDateChips($('debt-pay-date'), $('debt-pay-date-group'));
const parseAmount = v => { const n = parseFloat(String(v).replace(/[^\d.]/g, '')); return isNaN(n) ? null : n; };

function payHint() {
  const d = allDebts.find(x => x.id === settleDebtTarget);
  if (!d) return;
  const n = parseAmount($('debt-pay-amount').value);
  const left = debtLeft(d);
  const off = n > 0 && n >= left - 0.001 && n <= left + 0.001;
  // On a debt someone else added, what you say waits for them to confirm
  const after = d.shared ? ` ${d.person} confirms it, then it counts.` : '';
  $('debt-pay-hint').textContent = !(n > 0) ? ''
    : n > left + 0.001 ? `That's more than the ${fmt(left)} left.`
    : off ? (d.shared ? `That's all of it.${after}` : 'Pays it off: it moves to Settled.')
    : `${fmt(left - n)} will be left.${after}`;
  $('debt-pay-save').textContent = d.shared ? `Tell ${d.person}` : off ? 'Save and settle' : 'Save';
}

function fillPayDialog(d) {
  const paid = debtPaid(d);
  const left = debtLeft(d);
  $('debt-pay-title').textContent = d.type === 'they-owe' ? `${d.person} paid you` : `You paid ${d.person}`;
  $('debt-pay-left').textContent = `${fmt(left)} left`;
  $('debt-pay-of').textContent = `of ${fmt(d.amount)}`;
  const share = d.amount > 0 ? Math.min(paid / d.amount, 1) * 100 : 0;
  $('debt-pay-bar').querySelector('span').style.width = `${share.toFixed(1)}%`;
  $('debt-pay-bar').setAttribute('aria-valuenow', String(Math.round(share)));
  $('debt-pay-bar').classList.toggle('hidden', !paid);
  const list = Array.isArray(d.paid) ? d.paid : [];
  $('debt-pay-history-wrap').classList.toggle('hidden', !list.length);
  $('debt-pay-history').innerHTML = list.map((p, i) => `<li>
      <span>${escapeHtml(shortDay(p.date))}</span><strong>${fmt(p.amount)}</strong>
      ${d.shared ? '' : `<button type="button" class="debt-pay-remove" data-pay-remove="${i}" aria-label="Remove the ${fmt(p.amount)} payment on ${escapeHtml(shortDay(p.date))}">Remove</button>`}
    </li>`).join('');
}

window.openDebtSettleModal = (id) => {
  const d = allDebts.find(x => x.id === id);
  if (!d) return;
  settleDebtTarget = id;
  fillPayDialog(d);
  $('debt-pay-amount').value = debtLeft(d) || '';
  $('debt-pay-date').value = todayStr();
  syncPayChips();
  $('debt-pay-msg').className = 'form-msg budget-msg hidden';
  payHint();
  $('debt-settle-modal').classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
  setTimeout(() => { $('debt-pay-amount').focus(); $('debt-pay-amount').select(); }, 50);
};

window.closeDebtSettleModal = () => {
  $('debt-settle-modal').classList.add('hidden');
  settleDebtTarget = null;
};

function payError(text) {
  $('debt-pay-msg').textContent = text;
  $('debt-pay-msg').className = 'form-msg budget-msg error';
}

const redrawDebts = () => { updateDebtSummary(); renderDebts(); renderDebtHistory(); };

window.confirmDebtSettle = async () => {
  const d = allDebts.find(x => x.id === settleDebtTarget);
  if (!d) return;
  const date = $('debt-pay-date').value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return payError('Pick the date it was paid.');
  const amount = parseAmount($('debt-pay-amount').value);
  const res = payDebt(d, amount, date);
  if (res.error) return payError(res.left !== undefined ? `That's more than the ${fmt(res.left)} left.` : res.error);
  if (d.shared) return sendClaim(d, Math.round(amount * 100) / 100, date);
  const fields = res.settles
    ? { paid: res.paid, settled: true, settledDate: date }
    : { paid: res.paid };
  const btn = $('debt-pay-save');
  btn.disabled = true;
  try {
    await updateDoc(doc(db, 'debts', d.id), { ...fields, ...(res.settles ? { claimDate: deleteField() } : {}) });
    Object.assign(d, fields, res.settles ? { claimDate: '' } : {});
    redrawDebts();
    showToast(res.settles ? 'Paid off. Debt settled!' : `Payment saved. ${fmt(debtLeft(d))} left.`, 'success');
    closeDebtSettleModal();
  } catch (e) {
    console.error(e);
    payError("Couldn't save the payment. Check your connection and try again.");
  } finally {
    btn.disabled = false;
  }
};

// On a debt someone else added: tell them what was paid; it counts once they confirm (split.js)
async function sendClaim(d, amount, date) {
  const btn = $('debt-pay-save');
  btn.disabled = true;
  try {
    Object.assign(d, await claimSettled(d.id, amount, date));
    redrawDebts();
    showToast(`Sent. ${d.person} will confirm it.`, 'success');
    closeDebtSettleModal();
  } catch (err) {
    console.error(err);
    payError(err?.code === 'permission-denied'
      ? "SpendWise can't send this yet. Try again later."
      : "Couldn't send it. Check your connection and try again.");
  } finally {
    btn.disabled = false;
  }
}

// A payment entered by mistake: take it off, and what's left goes back up
$('debt-pay-history')?.addEventListener('click', async e => {
  const btn = e.target.closest('[data-pay-remove]');
  const d = allDebts.find(x => x.id === settleDebtTarget);
  if (!btn || !d) return;
  const paid = (d.paid || []).filter((_, i) => i !== Number(btn.dataset.payRemove));
  btn.disabled = true;
  try {
    await updateDoc(doc(db, 'debts', d.id), { paid });
    d.paid = paid;
    fillPayDialog(d);
    payHint();
    redrawDebts();
    showToast('Payment removed.', 'success');
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    payError("Couldn't remove it. Check your connection and try again.");
  }
});
$('debt-pay-amount')?.addEventListener('input', payHint);
$('debt-settle-modal')?.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); window.confirmDebtSettle(); }
});

// ── Settle claims on shared debts (split.js) ─────────────────────────────────
const CLAIM_DONE = {
  undo: 'Taken back.',
  confirm: 'Payment confirmed.',
  reject: 'Not counted. They can say so again once it’s paid.',
};

document.getElementById('debt-body')?.addEventListener('click', async e => {
  const btn = e.target.closest('[data-claim]');
  if (!btn) return;
  const kind = btn.dataset.claim;
  const d = allDebts.find(x => x.id === btn.dataset.debtId);
  if (!d) return;
  btn.disabled = true;
  try {
    if (kind === 'undo' || kind === 'reject') { await (kind === 'undo' ? withdrawClaim : rejectClaim)(d.id); Object.assign(d, { claimDate: '', claimAmount: 0 }); }
    else if (kind === 'confirm') Object.assign(d, await confirmClaim(d));
    updateDebtSummary();
    renderDebts();
    renderDebtHistory();
    showToast(kind === 'confirm' && d.settled ? 'Paid off. Debt settled!' : CLAIM_DONE[kind], 'success');
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    // permission-denied: the published Firestore rules don't allow it (firestore.rules › debts), not the network
    showToast(err?.code === 'permission-denied'
      ? "SpendWise can't update this debt yet. Try again later."
      : "Couldn't update the debt. Check your connection and try again.", 'error');
  }
});

// ── Reactivate Debt ──────────────────────────────────────────────────────────
window.openDebtReactivateModal = (id) => {
  reactivateDebtTarget = id;
  const debt = allDebts.find(d => d.id === id);
  if (debt) {
    const last = debtLeft(debt) === 0 && debt.paid?.length ? debt.paid[debt.paid.length - 1] : null;
    document.getElementById('debt-reactivate-msg').textContent = last
      ? `${fmt(last.amount)} with ${debt.person} moves back to Open, and the payment of ${fmt(last.amount)} on ${shortDay(last.date)} is taken off.`
      : `${fmt(debtLeft(debt))} with ${debt.person} moves back to Open.`;
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
    const debt = allDebts.find(d => d.id === reactivateDebtTarget);
    // Paid off by payments: the last one comes off, so it's open with that much owed again
    const paid = debt && debtLeft(debt) === 0 && debt.paid?.length ? debt.paid.slice(0, -1) : null;
    await updateDoc(debtRef, { settled: false, settledDate: '', ...(paid ? { paid } : {}) });
    if (debt) Object.assign(debt, { settled: false, settledDate: '' }, paid ? { paid } : {});

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
