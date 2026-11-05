// debt.js — SpendWise Debts page

import { db } from './config/firebase.js';
import { collection, addDoc, getDocs, deleteDoc, doc, query, where, serverTimestamp, updateDoc, deleteField } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { sanitize, escapeHtml, bindDateChips, shortDay, todayStr, countTo, debtLeft, debtPaid, payDebt, debtClaim } from './utils/helpers.js';
import { showToast, requireUser, initCurrencySelector } from './modules/page-shell.js';
import { fetchSharedDebts, emailError, shareFields, announceDebts, claimSettled, withdrawClaim, confirmClaim, rejectClaim } from './modules/split.js';
import { setKnownPeople } from './modules/people.js';
import { debtsByPerson, isPersons } from './modules/debt-data.js';
import { getCreditCards, getCreditCardTransactions, createCardRefund, createCardPayment } from './modules/credit-card-store.js';
import { cardOutstanding, currentStatementPeriod, statementPeriodFor, statementAmount, refundRemaining, cardPaymentId, creditCardLabel } from './modules/credit-card-data.js';

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
let personFilter = null; // a debtsByPerson row: the Open list shows only theirs
let creditCards = [];
let cardExpenses = [];
let cardRefunds = [];
let cardPayments = [];

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
  document.getElementById('credit-card-refund-date').value = todayStr();
  const month = document.getElementById('credit-card-report-month');
  month.value = todayStr().slice(0, 7);
  loadCreditCardManager();
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

async function loadCreditCardManager() {
  if (!currentUser) return;
  try {
    creditCards = await getCreditCards(currentUser.uid);
    const transactions = await getCreditCardTransactions(currentUser.uid);
    cardExpenses = transactions.expenses;
    cardRefunds = transactions.refunds;
    cardPayments = transactions.payments;
    if (navigator.onLine === false) {
      const cache = JSON.parse(sessionStorage.getItem(`spendwise_expenses_${currentUser.uid}`) || '{"data":[]}');
      const cachedRows = Array.isArray(cache.data) ? cache.data : [];
      const expenseIds = new Set(cardExpenses.map(item => item.id));
      const refundIds = new Set(cardRefunds.map(item => item.id));
      for (const row of cachedRows) {
        if (row.transactionType === 'refund' && row.creditCardId && row.originalExpenseId) {
          const id = String(row.id).replace(/^refund-/, '');
          if (!refundIds.has(id)) cardRefunds.push({
            id, uid: currentUser.uid, creditCardId: row.creditCardId,
            originalExpenseId: row.originalExpenseId, amount: Math.abs(Number(row.amount) || 0),
            refundDate: row.date, description: row.description || '',
          });
        } else if (row.payment === 'Credit Card' && row.creditCardId && !expenseIds.has(row.id)) {
          cardExpenses.push(row);
        }
      }
    }
    const queued = (window.getOfflineQueueItems?.() || []).filter(item => item.data?.uid === currentUser.uid);
    const addOrMarkPending = (items, record) => {
      const index = items.findIndex(existing => existing.id === record.id);
      if (index < 0) items.push(record);
      else items[index] = { ...items[index], ...record };
    };
    for (const item of queued) {
      const record = { id: item.docId || item.id, ...item.data, pending: true };
      if (item.type === 'expense' && item.data.payment === 'Credit Card') addOrMarkPending(cardExpenses, record);
      if (item.type === 'cardRefund') addOrMarkPending(cardRefunds, record);
      if (item.type === 'cardPayment') addOrMarkPending(cardPayments, record);
    }
    cardExpenses = cardExpenses.filter(expense => expense.payment === 'Credit Card' && expense.creditCardId);
    renderCreditCardManager();
    renderCreditCardReport();
    renderRefundPurchaseOptions();
  } catch (error) {
    console.error('Could not load credit card data:', error);
    document.getElementById('credit-card-list').innerHTML = '<p class="hist-empty">Credit card details could not be loaded. Check your connection and try again.</p>';
    document.getElementById('credit-card-report-body').innerHTML = '<tr><td colspan="6" class="empty-row">Credit card report could not be loaded.</td></tr>';
  }
}

const cardById = id => creditCards.find(card => card.id === id);
const cardLabel = id => creditCardLabel(cardById(id) || { name: 'Archived card', issuer: '', last4: '' });
const inReportMonth = date => {
  const month = document.getElementById('credit-card-report-month').value;
  return !month || String(date || '').startsWith(month);
};

function renderCreditCardManager() {
  const total = creditCards.reduce((sum, card) => sum + cardOutstanding(card.id, cardExpenses, cardRefunds, cardPayments), 0);
  document.getElementById('credit-card-total').textContent = fmt(total);
  const list = document.getElementById('credit-card-list');
  if (!creditCards.length) {
    list.innerHTML = '<p class="hist-empty">No credit cards yet. <a href="settings.html">Add one in Settings</a>.</p>';
    return;
  }
  list.innerHTML = creditCards.map(card => {
    const outstanding = cardOutstanding(card.id, cardExpenses, cardRefunds, cardPayments);
    const latestPeriod = card.statementDay ? currentStatementPeriod(todayStr(), card.statementDay) : null;
    const latestAmount = latestPeriod ? statementAmount(card.id, latestPeriod, cardExpenses, cardRefunds, cardPayments) : 0;
    const periodKeys = new Map();
    [...cardExpenses.filter(item => item.creditCardId === card.id).map(item => ({ date: item.date, id: item.id })),
      ...cardRefunds.filter(item => item.creditCardId === card.id).map(item => ({ date: item.refundDate, id: item.id }))]
      .forEach(item => {
        const period = statementPeriodFor(item.date, card.statementDay);
        if (period && period.end <= todayStr()) periodKeys.set(period.id, period);
      });
    const unpaidPeriods = [...periodKeys.values()].sort((a, b) => a.start.localeCompare(b.start))
      .filter(period => statementAmount(card.id, period, cardExpenses, cardRefunds, cardPayments) > 0);
    const paymentPeriod = unpaidPeriods[0] || latestPeriod;
    const amount = card.statementDay
      ? paymentPeriod ? statementAmount(card.id, paymentPeriod, cardExpenses, cardRefunds, cardPayments) : 0
      : outstanding;
    const latestPaid = latestPeriod && cardPayments.some(payment => payment.creditCardId === card.id && payment.statementId === latestPeriod.id);
    const afterLatest = latestPeriod
      ? cardExpenses.filter(item => item.creditCardId === card.id && item.date > latestPeriod.end).reduce((sum, item) => sum + Number(item.amount || 0), 0)
        - cardRefunds.filter(item => item.creditCardId === card.id && item.refundDate > latestPeriod.end).reduce((sum, item) => sum + Number(item.amount || 0), 0)
      : 0;
    const status = latestPeriod
      ? (latestAmount > 0 ? `Latest statement · ${fmt(latestAmount)}${latestPaid ? ' · Paid' : ' · Unpaid'}`
        : latestPaid ? 'Latest statement · Paid' : 'No tracked purchases in the latest statement')
      : 'Current tracked outstanding · no statement cycle configured';
    const utilization = card.creditLimit > 0
      ? `<span>${Math.round(outstanding / card.creditLimit * 100)}% of ${fmt(card.creditLimit)} limit</span>`
      : '';
    const due = card.dueDay ? `<span>Payment due day ${card.dueDay}</span>` : '';
    const paymentAction = amount > 0
      ? `<button type="button" class="btn-secondary" data-pay-card="${escapeHtml(card.id)}" data-statement-id="${paymentPeriod?.id || ''}">${paymentPeriod ? `Pay full statement · ${escapeHtml(paymentPeriod.start)}–${escapeHtml(paymentPeriod.end)}` : 'Pay full outstanding'}</button>`
      : '';
    return `<article class="credit-card-debt-row">
      <div class="credit-card-debt-main"><strong>${escapeHtml(creditCardLabel(card))}${card.active === false ? ' · Archived' : ''}</strong>
        <span>${escapeHtml(status)}</span>${latestPeriod && afterLatest > 0 ? `<span>Purchases after statement · ${fmt(afterLatest)}</span>` : ''}<span>${utilization}${utilization && due ? ' · ' : ''}${due}</span>
      </div>
      <div class="credit-card-debt-balance"><strong>${fmt(outstanding)}</strong><small>Outstanding</small>${paymentAction}</div>
    </article>`;
  }).join('');
}

function renderCreditCardReport() {
  const filter = document.getElementById('credit-card-report-filter');
  const selected = filter.value;
  filter.innerHTML = '<option value="">All cards</option>' + creditCards.map(card =>
    `<option value="${escapeHtml(card.id)}">${escapeHtml(creditCardLabel(card))}${card.active === false ? ' (archived)' : ''}</option>`
  ).join('');
  filter.value = selected;
  const allowed = id => !filter.value || id === filter.value;
  const purchases = cardExpenses.filter(item => allowed(item.creditCardId) && inReportMonth(item.date));
  const refunds = cardRefunds.filter(item => allowed(item.creditCardId) && inReportMonth(item.refundDate));
  const payments = cardPayments.filter(item => allowed(item.creditCardId) && inReportMonth(item.paymentDate));
  const purchaseTotal = purchases.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const refundTotal = refunds.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  document.getElementById('credit-card-purchases-total').textContent = fmt(purchaseTotal);
  document.getElementById('credit-card-refunds-total').textContent = fmt(refundTotal);
  document.getElementById('credit-card-net-total').textContent = fmt(purchaseTotal - refundTotal);
  const rows = [
    ...purchases.map(item => ({ date: item.date, description: item.description || '-', category: item.category || '-', cardId: item.creditCardId, type: 'Purchase', amount: Number(item.amount || 0) })),
    ...refunds.map(item => ({ date: item.refundDate, description: item.description || 'Credit card refund', category: 'Refund', cardId: item.creditCardId, type: 'Refund', amount: -Number(item.amount || 0) })),
    ...payments.map(item => ({ date: item.paymentDate, description: 'Credit-card bill payment', category: '-', cardId: item.creditCardId, type: 'Card payment', amount: -Number(item.amount || 0), pending: item.pending })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  document.getElementById('credit-card-report-body').innerHTML = rows.length ? rows.map(row => `<tr>
    <td data-label="Date">${escapeHtml(shortDay(row.date))}</td>
    <td data-label="Description">${escapeHtml(row.description)}</td>
    <td data-label="Category">${escapeHtml(row.category)}</td>
    <td data-label="Card">${escapeHtml(cardLabel(row.cardId))}</td>
    <td data-label="Type">${row.type}${row.pending ? ' · Waiting to sync' : ''}</td>
    <td data-label="Amount" class="text-right">${fmt(row.amount)}</td>
  </tr>`).join('') : '<tr><td colspan="6" class="empty-row">No credit-card transactions in this period.</td></tr>';
}

function renderRefundPurchaseOptions() {
  const cardSelect = document.getElementById('credit-card-refund-card');
  const purchaseSelect = document.getElementById('credit-card-refund-purchase');
  const selectedCard = cardSelect.value;
  cardSelect.innerHTML = '<option value="">Choose a card</option>' + creditCards.map(card =>
    `<option value="${escapeHtml(card.id)}">${escapeHtml(creditCardLabel(card))}${card.active === false ? ' (archived)' : ''}</option>`
  ).join('');
  cardSelect.value = selectedCard;
  const purchases = cardExpenses.filter(expense => (!selectedCard || expense.creditCardId === selectedCard)
    && refundRemaining(expense, cardRefunds) > 0);
  purchaseSelect.innerHTML = '<option value="">Choose a purchase</option>' + purchases.map(expense =>
    `<option value="${escapeHtml(expense.id)}">${escapeHtml(shortDay(expense.date))} · ${escapeHtml(expense.description || expense.category || 'Purchase')} · ${fmt(expense.amount)} remaining</option>`
  ).join('');
}

async function payCreditCard(cardId, statementId) {
  const card = cardById(cardId);
  if (!card) return;
  const [start, end] = statementId.split('_');
  const period = statementId && /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end)
    ? { start, end, id: statementId } : null;
  if (statementId && !period) return showToast('This statement is invalid. Refresh the page before paying.', 'error');
  const amount = period
    ? statementAmount(cardId, period, cardExpenses, cardRefunds, cardPayments)
    : cardOutstanding(cardId, cardExpenses, cardRefunds, cardPayments);
  if (!(amount > 0)) return;
  const scope = period ? `statement ${period.start} to ${period.end}` : 'current tracked outstanding';
  if (!window.confirm(`Pay ${fmt(amount)} for ${card.name} (${scope})? This records a bill payment, not a new expense.`)) return;
  const scopedExpenses = period ? cardExpenses.filter(item => item.creditCardId === cardId && item.date >= period.start && item.date <= period.end) : cardExpenses.filter(item => item.creditCardId === cardId);
  const scopedRefunds = period ? cardRefunds.filter(item => item.creditCardId === cardId && item.refundDate >= period.start && item.refundDate <= period.end) : cardRefunds.filter(item => item.creditCardId === cardId);
  const id = cardPaymentId(cardId, period?.id || '', [...scopedExpenses, ...scopedRefunds]);
  try {
    await createCardPayment(currentUser.uid, id, {
      creditCardId: cardId,
      ...(period && { statementId: period.id }),
      amount,
      paymentDate: todayStr(),
      paymentType: period ? 'full_statement' : 'full_current_outstanding',
    });
    await loadCreditCardManager();
    showToast('Full card payment recorded. It was not added to expenses.', 'success');
  } catch (error) {
    console.error('Could not record credit card payment:', error);
    showToast(error.message || 'Credit card payment could not be saved.', 'error');
  }
}

async function saveCreditCardRefund() {
  const errorEl = document.getElementById('credit-card-refund-error');
  const cardId = document.getElementById('credit-card-refund-card').value;
  const originalExpenseId = document.getElementById('credit-card-refund-purchase').value;
  const expense = cardExpenses.find(item => item.id === originalExpenseId);
  const amount = Number(document.getElementById('credit-card-refund-amount').value);
  const refundDate = document.getElementById('credit-card-refund-date').value;
  if (!expense || expense.creditCardId !== cardId) {
    errorEl.textContent = 'Choose a purchase made with the selected card.';
    errorEl.classList.remove('hidden');
    return;
  }
  const remaining = refundRemaining(expense, cardRefunds);
  if (!Number.isFinite(amount) || amount <= 0 || amount > remaining) {
    errorEl.textContent = `Refund must be greater than zero and no more than ${fmt(remaining)} remaining.`;
    errorEl.classList.remove('hidden');
    return;
  }
  const saveButton = document.getElementById('save-credit-card-refund');
  if (saveButton.disabled) return;
  saveButton.disabled = true;
  try {
    await createCardRefund(currentUser.uid, {
      creditCardId: cardId, originalExpenseId, amount, refundDate,
      description: document.getElementById('credit-card-refund-description').value,
    });
    document.getElementById('credit-card-refund-amount').value = '';
    document.getElementById('credit-card-refund-description').value = '';
    errorEl.classList.add('hidden');
    await loadCreditCardManager();
    showToast('Credit-card refund recorded and net spending updated.', 'success');
  } catch (error) {
    console.error('Could not record credit card refund:', error);
    errorEl.textContent = error.message || 'Credit-card refund could not be saved.';
    errorEl.classList.remove('hidden');
  } finally {
    saveButton.disabled = false;
  }
}

document.getElementById('credit-card-list')?.addEventListener('click', event => {
  const button = event.target.closest('[data-pay-card]');
  if (button) payCreditCard(button.dataset.payCard, button.dataset.statementId || '');
});
document.getElementById('credit-card-report-filter')?.addEventListener('change', renderCreditCardReport);
document.getElementById('credit-card-report-month')?.addEventListener('change', renderCreditCardReport);
document.getElementById('credit-card-refund-card')?.addEventListener('change', renderRefundPurchaseOptions);
document.getElementById('save-credit-card-refund')?.addEventListener('click', saveCreditCardRefund);

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

// ── By person: what each person owes overall, or is owed ────────────────────
function renderPeople() {
  const people = debtsByPerson(allDebts);
  const card = document.getElementById('debt-people-card');
  // Worth a list once there's more than one debt to add up
  const show = allDebts.filter(d => !d.settled).length > 1;
  card.classList.toggle('hidden', !show);
  if (personFilter && !people.some(p => p.key === personFilter.key)) personFilter = null;
  if (!show) { personFilter = null; return; }
  document.getElementById('debt-people-count').textContent = String(people.length);
  document.getElementById('debt-people').innerHTML = people.map(p => {
    const balance = p.net > 0 ? `Owes you ${fmt(p.net)}` : p.net < 0 ? `You owe ${fmt(-p.net)}` : 'All square';
    const both = p.owedToYou > 0 && p.youOwe > 0 ? ` · ${fmt(p.owedToYou)} to you, ${fmt(p.youOwe)} from you` : '';
    const sub = [`${p.count} open`, p.email].filter(Boolean).join(' · ') + both;
    const on = personFilter?.key === p.key;
    return `<li><button type="button" class="debt-person${on ? ' on' : ''}" data-person-key="${escapeHtml(p.key)}" aria-pressed="${on}" aria-label="${escapeHtml(p.name)}: ${escapeHtml(balance)}. ${on ? 'Showing only theirs' : 'Show only theirs'}">
      <span class="debt-person-tile" aria-hidden="true">${escapeHtml(p.name.charAt(0).toUpperCase())}</span>
      <span class="hist-row-main"><span class="hist-row-title">${escapeHtml(p.name)}</span><span class="hist-row-meta">${escapeHtml(sub)}</span></span>
      <span class="hist-row-amount ${p.net > 0 ? 'income' : p.net < 0 ? 'owe' : ''}">${p.net ? fmt(Math.abs(p.net)) : fmt(0)}<small>${p.net > 0 ? 'owes you' : p.net < 0 ? 'you owe' : 'square'}</small></span>
    </button></li>`;
  }).join('');
}

document.getElementById('debt-people')?.addEventListener('click', e => {
  const btn = e.target.closest('[data-person-key]');
  if (!btn) return;
  const p = debtsByPerson(allDebts).find(x => x.key === btn.dataset.personKey);
  personFilter = personFilter?.key === p?.key ? null : p;
  renderPeople();
  renderDebts();
  if (personFilter) document.getElementById('debt-open-title').scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
});
document.getElementById('debt-filter-clear')?.addEventListener('click', () => { personFilter = null; renderPeople(); renderDebts(); });

// ── Open debts ───────────────────────────────────────────────────────────────
function renderDebts() {
  renderPeople();
  const list = document.getElementById('debt-body');
  const active = allDebts.filter(d => !d.settled && (!personFilter || isPersons(d, personFilter)));
  document.getElementById('debt-open-title').textContent = personFilter ? `Open with ${personFilter.name}` : 'Open';
  document.getElementById('debt-filter-clear').classList.toggle('hidden', !personFilter);
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
