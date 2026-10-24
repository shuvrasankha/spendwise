// invest.js — SpendWise Investments page: holdings, what they're worth, and money put into them.
// The numbers come from invest-data.js; money put in is saved as a 'Savings & Investments' expense
// with holdingId, so the Dashboard, History, Insights and Ask all see it as they did before.

import { db } from './config/firebase.js';
import { collection, addDoc, getDocs, deleteDoc, doc, query, where, serverTimestamp, updateDoc, deleteField } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { sanitize, escapeHtml, bindDateChips, shortDay, todayStr, countTo, normalizeCategory } from './utils/helpers.js';
import { showToast, requireUser, initCurrencySelector } from './modules/page-shell.js';
import { HOLDING_KINDS, kindOf, holdingOf, portfolio, afterDebts } from './modules/invest-data.js';
import { getGoals } from './modules/goals.js';
import { fetchSharedDebts } from './modules/split.js';

const fmt = window.fmt;
const INV = 'Savings & Investments';
const RECENT_COUNT = 10;

// ── State ────────────────────────────────────────────────────────────────────
let currentUser = null;
let holdings = [];
let expenses = []; // only investment entries
let debts = [];
let chosen = null; // id of the holding the form puts money into
let editingHolding = null; // holding being edited, or null for a new one
let editingEntry = null;
let opener = null;

const $ = id => document.getElementById(id);
const moneyWhole = n => {
  const c = window.getCurrencyInfo(window.getCurrency());
  return `${c.symbol} ${Math.round(n).toLocaleString(c.locale)}`;
};
const signed = n => `${n < 0 ? '−' : '+'}${moneyWhole(Math.abs(n))}`;
const num = v => { const n = parseFloat(String(v).replace(/[^\d.]/g, '')); return n >= 0 && isFinite(n) ? Math.round(n * 100) / 100 : null; };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const offline = () => window.isOffline?.() || navigator.onLine === false;

requireUser(user => {
  currentUser = user;
  initCurrencySelector(render);
  $('inv-date').value = todayStr();
  syncDateChips();
  load();
});

// ── Load ─────────────────────────────────────────────────────────────────────
async function load() {
  if (!currentUser) return;
  const mine = coll => getDocs(query(collection(db, coll), where('uid', '==', currentUser.uid)));
  try {
    const [h, e] = await Promise.all([mine('holdings'), mine('expenses')]);
    holdings = h.docs.map(d => ({ id: d.id, ...d.data() }));
    expenses = e.docs.map(d => {
      const raw = d.data();
      const amt = parseFloat(raw.amount);
      return { id: d.id, ...raw, amount: isNaN(amt) ? 0 : amt, category: normalizeCategory(raw.category) };
    }).filter(x => x.category === INV).sort((a, b) => b.date.localeCompare(a.date));
    if (!holdings.some(x => x.id === chosen)) chosen = holdings[0]?.id || null;
    render();
  } catch (err) {
    console.error(err);
    // Before the updated rules are published, holdings can't be read: say so plainly
    const denied = err?.code === 'permission-denied';
    $('inv-holdings').innerHTML = `<li class="hist-empty">${denied
      ? "Investments aren't switched on for this account yet. The app's security rules need an update."
      : "Couldn't load your investments. Check your connection and reload."}</li>`;
    $('inv-recent').innerHTML = '';
  }
  // Debts only feed "After debts", so they load on their own and never hold up the page
  try {
    const [own, shared] = await Promise.all([mine('debts'), fetchSharedDebts(currentUser)]);
    debts = own.docs.map(d => {
      const raw = d.data();
      return { ...raw, amount: parseFloat(raw.amount) || 0, settled: raw.settled === true || raw.settled === 'true' || raw.settled === 1 };
    }).concat(shared);
    renderHero();
  } catch (err) { console.warn('Debts unavailable:', err); }
}

// ── Draw ─────────────────────────────────────────────────────────────────────
function render() {
  renderHero();
  renderHoldingChips();
  renderHoldings();
  renderRecent();
  window.lucide?.createIcons();
}

function renderHero() {
  const p = portfolio(holdings, expenses, todayStr());
  const worth = $('inv-worth');
  if (!p.invested && !holdings.length) {
    worth.textContent = moneyWhole(0);
    $('inv-worth-sub').textContent = 'Add a holding below, then the money you put in.';
    $('inv-month-sub').textContent = '';
    $('inv-after').classList.add('hidden');
    return;
  }
  countTo(worth, p.value, moneyWhole);
  $('inv-worth-sub').textContent = p.gain === null
    ? `${moneyWhole(p.invested)} put in`
    : `${moneyWhole(p.invested)} put in · ${signed(p.gain)}${p.gainPct !== null ? ` (${p.gainPct >= 0 ? '+' : '−'}${Math.abs(p.gainPct).toFixed(1)}%)` : ''} ${p.gain >= 0 ? 'gain' : 'loss'}`;
  const month = new Date().toLocaleDateString('en-US', { month: 'long' });
  $('inv-month-sub').textContent = [
    `${moneyWhole(p.thisMonth)} put in this ${month}`,
    p.monthly ? `${moneyWhole(p.monthly)} a month in SIPs` : '',
  ].filter(Boolean).join(' · ');
  const a = afterDebts(p.value, debts);
  const show = a.owedToYou > 0 || a.youOwe > 0;
  $('inv-after').classList.toggle('hidden', !show);
  if (show) {
    $('inv-after-total').textContent = a.total < 0 ? `−${moneyWhole(-a.total)}` : moneyWhole(a.total);
    $('inv-after-note').textContent = [
      'Investments',
      a.owedToYou ? `plus ${moneyWhole(a.owedToYou)} owed to you` : '',
      a.youOwe ? `less ${moneyWhole(a.youOwe)} you owe` : '',
    ].filter(Boolean).join(', ') + '. Bank balances aren\'t counted.';
  }
}

function renderHoldingChips() {
  $('inv-holding-chips').innerHTML = holdings.map(h =>
    `<button type="button" class="chip" data-inv-holding="${escapeHtml(h.id)}" aria-pressed="${h.id === chosen}">${escapeHtml(h.name)}</button>`
  ).join('') + `<button type="button" class="chip chip-new" data-holding-new><i data-lucide="plus" aria-hidden="true"></i>New holding</button>`;
  // A SIP's switch starts on when the chosen holding already repeats monthly
  const sip = portfolio(holdings, expenses, todayStr()).rows.find(r => r.holding.id === chosen)?.sip;
  $('inv-repeat').checked = !!sip;
  if (sip && !$('inv-amount').value) $('inv-amount').placeholder = String(sip.amount);
  else $('inv-amount').placeholder = '0.00';
}

function renderHoldings() {
  const p = portfolio(holdings, expenses, todayStr());
  const goals = getGoals();
  $('inv-holdings-count').textContent = holdings.length ? plural(holdings.length, 'holding', 'holdings') : '';
  const rows = p.rows.map(r => {
    const h = r.holding, kind = kindOf(h.kind);
    const goal = h.goalId && goals.find(g => g.id === h.goalId);
    const sub = [
      kind.label.toLowerCase() === h.name.trim().toLowerCase() ? '' : kind.label, // "PPF" named PPF says it once
      r.sip ? `${moneyWhole(r.sip.amount)} a month` : '',
      goal ? `for ${goal.name}` : '',
    ].filter(Boolean).join(' · ');
    const gain = r.gain === null ? (r.count ? `${moneyWhole(r.invested)} put in` : 'Nothing put in yet')
      : `${signed(r.gain)} ${r.gain >= 0 ? 'gain' : 'loss'}`;
    return `<li class="ins-row inv-row">
      <button type="button" class="inv-row-btn" data-holding-edit="${escapeHtml(h.id)}" aria-label="${escapeHtml(h.name)}, worth ${moneyWhole(r.value)}. Edit">
        <span class="ins-icon" aria-hidden="true"><i data-lucide="${kind.icon}"></i></span>
        <span class="ins-row-body">
          <span class="home-row-main"><span class="home-row-title">${escapeHtml(h.name)}</span><span class="home-row-meta">${escapeHtml(sub)}</span></span>
          <span class="inv-row-figures"><span class="ins-row-value">${moneyWhole(r.value)}</span><span class="inv-row-gain${r.gain === null ? '' : r.gain >= 0 ? ' up' : ' down'}">${escapeHtml(gain)}</span></span>
        </span>
      </button>
    </li>`;
  });
  // Entries from before holdings, or from the expense form, SMS or a CSV, that match no holding
  if (p.other.count) rows.push(`<li class="ins-row inv-row">
      <span class="ins-icon inv-icon-quiet" aria-hidden="true"><i data-lucide="inbox"></i></span>
      <span class="ins-row-body">
        <span class="home-row-main"><span class="home-row-title">Not in a holding</span><span class="home-row-meta">${plural(p.other.count, 'entry', 'entries')} · tap one below to sort it</span></span>
        <span class="inv-row-figures"><span class="ins-row-value">${moneyWhole(p.other.invested)}</span></span>
      </span>
    </li>`);
  $('inv-holdings').innerHTML = rows.length ? rows.join('')
    : `<li class="goals-empty"><span class="goals-empty-icon" aria-hidden="true"><i data-lucide="line-chart"></i></span><span>A SIP, an FD, your PPF: add each one as a holding to see what it's worth.</span></li>`;
}

function renderRecent() {
  const list = $('inv-recent');
  list.innerHTML = expenses.length ? expenses.slice(0, RECENT_COUNT).map(e => {
    const h = holdingOf(e, holdings);
    const meta = [shortDay(e.date), !h ? 'Not in a holding' : '', e.repeat === 'monthly' ? 'Every month' : '', e.pending ? 'Waiting to sync' : ''].filter(Boolean).join(' · ');
    const title = h ? h.name : e.description && e.description !== '-' ? e.description : 'Investment';
    return `<li><button type="button" class="hist-row" data-entry-id="${escapeHtml(e.id)}" ${e.pending ? 'disabled' : ''}>
      <span class="hist-row-main">
        <span class="hist-row-title">${escapeHtml(title)}</span>
        <span class="hist-row-meta">${escapeHtml(meta)}</span>
      </span>
      <span class="hist-row-amount">${fmt(e.amount)}</span>
    </button></li>`;
  }).join('') : '<li class="hist-empty">Nothing put in yet. Pick a holding above and add the first amount.</li>';
}

// ── Put money in ─────────────────────────────────────────────────────────────
function formMsg(text, type) {
  const el = $('inv-form-msg');
  el.textContent = text;
  el.className = 'form-msg ' + type;
  if (type === 'success') setTimeout(() => el.classList.add('hidden'), 3000);
}

async function addEntry() {
  const h = holdings.find(x => x.id === chosen);
  const amountRaw = $('inv-amount').value || $('inv-amount').placeholder;
  const amount = parseFloat(amountRaw);
  const date = $('inv-date').value;
  if (!h) return formMsg('Pick a holding first, or add a new one.', 'error');
  if (!amount || amount <= 0) return formMsg('Enter the amount you put in.', 'error');
  if (!date) return formMsg('Pick the date.', 'error');
  const repeat = $('inv-repeat').checked ? 'monthly' : null;
  // The newest entry carrying a repeat field is the series' template: switching off stops the SIP
  const wasSip = portfolio(holdings, expenses, todayStr()).rows.find(r => r.holding.id === h.id)?.sip;
  const data = {
    uid: currentUser.uid, amount, category: INV, date, payment: $('inv-payment').value, cardName: '',
    description: h.name, notes: sanitize($('inv-notes').value.trim(), 500), tags: [], holdingId: h.id, encoding: 'plain',
    ...(repeat ? { repeat } : wasSip ? { repeat: 'stopped' } : {}),
  };
  const btn = $('inv-add');
  btn.disabled = true;
  try {
    if (offline() && window.addToOfflineQueue) {
      window.addToOfflineQueue('expense', data);
      expenses.unshift({ ...data, id: 'offline-' + Date.now(), pending: true });
      formMsg('Saved on this device. It syncs when you are back online.', 'success');
    } else {
      const ref = await addDoc(collection(db, 'expenses'), { ...data, createdAt: serverTimestamp() });
      expenses.unshift({ ...data, id: ref.id });
      showToast(`${moneyWhole(amount)} put into ${h.name}.`, 'success');
      window.markLoggedToday?.();
    }
    expenses.sort((a, b) => b.date.localeCompare(a.date));
    $('inv-amount').value = '';
    $('inv-notes').value = '';
    render();
  } catch (err) {
    console.error(err);
    formMsg("Couldn't save it. Check your connection and try again.", 'error');
  } finally {
    btn.disabled = false;
  }
}

// ── Holding dialog ───────────────────────────────────────────────────────────
function openModal(id) {
  opener = document.activeElement;
  $(id).classList.remove('hidden');
  window.lucide?.createIcons();
}
function closeModal(id) {
  $(id).classList.add('hidden');
  opener?.focus?.({ preventScroll: true });
}
function modalMsg(id, text) {
  const el = $(id);
  el.textContent = text;
  el.className = 'form-msg budget-msg error';
}

function openHolding(h) {
  editingHolding = h || null;
  $('holding-title').textContent = h ? 'Edit holding' : 'New holding';
  $('holding-name').value = h?.name || '';
  $('holding-kind').innerHTML = HOLDING_KINDS.map(k => `<option value="${k.id}">${escapeHtml(k.label)}</option>`).join('');
  $('holding-kind').value = h ? kindOf(h.kind).id : 'mf';
  $('holding-value').value = typeof h?.value === 'number' ? h.value : '';
  $('holding-value-help').textContent = typeof h?.value === 'number' && h.valueDate
    ? `Last updated ${shortDay(h.valueDate)}. Money put in since then is added to it.`
    : 'Leave it empty to count what you put in. Update it now and then to see your gain.';
  const goals = getGoals();
  $('holding-goal').innerHTML = `<option value="">No goal</option>` + goals.map(g => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`).join('');
  $('holding-goal').value = h?.goalId && goals.some(g => g.id === h.goalId) ? h.goalId : '';
  $('holding-goal').closest('.form-group').classList.toggle('hidden', !goals.length);
  $('holding-delete').classList.toggle('hidden', !h);
  $('holding-msg').className = 'form-msg budget-msg hidden';
  openModal('holding-modal');
  setTimeout(() => $('holding-name').focus(), 50);
}

async function saveHolding() {
  const name = sanitize($('holding-name').value.trim(), 60);
  const kind = $('holding-kind').value;
  const valueRaw = $('holding-value').value.trim();
  const value = valueRaw ? num(valueRaw) : null;
  const goalId = $('holding-goal').value;
  if (!name) return modalMsg('holding-msg', 'Give it a name, like the fund or the bank.');
  if (holdings.some(x => x !== editingHolding && x.name.trim().toLowerCase() === name.toLowerCase())) return modalMsg('holding-msg', 'You already have a holding with that name.');
  if (valueRaw && value === null) return modalMsg('holding-msg', 'Enter what it is worth as a number, or leave it empty.');
  if (offline()) return modalMsg('holding-msg', 'Holdings need a connection. Try again once you are online.');
  const h = editingHolding;
  // A new value is dated today; an unchanged one keeps its date, so later payments still add to it
  const valueChanged = value !== (typeof h?.value === 'number' ? h.value : null);
  const fields = {
    name, kind,
    ...(value !== null ? { value, valueDate: valueChanged ? todayStr() : h.valueDate } : {}),
    ...(goalId ? { goalId } : {}),
  };
  const btn = $('holding-save');
  btn.disabled = true;
  try {
    if (h) {
      await updateDoc(doc(db, 'holdings', h.id), {
        ...fields,
        ...(value === null && 'value' in h ? { value: deleteField(), valueDate: deleteField() } : {}),
        ...(!goalId && h.goalId ? { goalId: deleteField() } : {}),
      });
      const next = { id: h.id, uid: h.uid, ...fields };
      holdings = holdings.map(x => x === h ? next : x);
    } else {
      const ref = await addDoc(collection(db, 'holdings'), { uid: currentUser.uid, ...fields, createdAt: serverTimestamp() });
      holdings.push({ id: ref.id, uid: currentUser.uid, ...fields });
      chosen = ref.id;
    }
    closeModal('holding-modal');
    render();
    showToast(h ? 'Holding saved.' : `${name} added. Now put money in.`, 'success');
    if (!h) $('inv-amount').focus({ preventScroll: true });
  } catch (err) {
    console.error(err);
    modalMsg('holding-msg', err?.code === 'permission-denied'
      ? "This account can't save holdings yet. The app's security rules need an update."
      : "Couldn't save it. Check your connection and try again.");
  } finally {
    btn.disabled = false;
  }
}

async function deleteHolding() {
  const h = editingHolding;
  if (!h || !confirm(`Delete "${h.name}"? The money you put in stays in History, under Not in a holding.`)) return;
  try {
    // Its SIP stops too, so the Dashboard doesn't keep offering it
    const sip = portfolio(holdings, expenses, todayStr()).rows.find(r => r.holding === h)?.sip;
    if (sip && !sip.template.pending) {
      await updateDoc(doc(db, 'expenses', sip.template.id), { repeat: 'stopped' });
      sip.template.repeat = 'stopped';
    }
    await deleteDoc(doc(db, 'holdings', h.id));
    // Its entries keep its name, so a new holding with that name takes them back
    holdings = holdings.filter(x => x !== h);
    if (chosen === h.id) chosen = holdings[0]?.id || null;
    closeModal('holding-modal');
    render();
    showToast('Holding deleted.', 'success');
  } catch (err) {
    console.error(err);
    modalMsg('holding-msg', "Couldn't delete it. Check your connection and try again.");
  }
}

// ── Entry dialog ─────────────────────────────────────────────────────────────
function openEntry(e) {
  editingEntry = e;
  const h = holdingOf(e, holdings);
  $('entry-holding').innerHTML = `<option value="">Not in a holding</option>` + holdings.map(x => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`).join('');
  $('entry-holding').value = h ? h.id : '';
  $('entry-amount').value = e.amount;
  $('entry-date').value = e.date;
  $('entry-msg').className = 'form-msg budget-msg hidden';
  openModal('entry-modal');
  setTimeout(() => $('entry-holding').focus(), 50);
}

async function saveEntry() {
  const e = editingEntry;
  const amount = num($('entry-amount').value);
  const date = $('entry-date').value;
  const h = holdings.find(x => x.id === $('entry-holding').value) || null;
  if (!amount) return modalMsg('entry-msg', 'Enter the amount as a number.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return modalMsg('entry-msg', 'Pick the date.');
  // Moved into a holding: it takes the holding's name, so a SIP stays one series
  const fields = { amount, date, ...(h ? { holdingId: h.id, description: h.name } : {}) };
  try {
    await updateDoc(doc(db, 'expenses', e.id), { ...fields, ...(!h && e.holdingId ? { holdingId: deleteField() } : {}) });
    Object.assign(e, fields);
    if (!h) delete e.holdingId;
    expenses.sort((a, b) => b.date.localeCompare(a.date));
    closeModal('entry-modal');
    render();
    showToast('Saved.', 'success');
  } catch (err) {
    console.error(err);
    modalMsg('entry-msg', "Couldn't save it. Check your connection and try again.");
  }
}

async function deleteEntry() {
  const e = editingEntry;
  if (!confirm(`Delete ${fmt(e.amount)} on ${shortDay(e.date)}?`)) return;
  try {
    await deleteDoc(doc(db, 'expenses', e.id));
    expenses = expenses.filter(x => x !== e);
    closeModal('entry-modal');
    render();
    showToast('Deleted.', 'success');
  } catch (err) {
    console.error(err);
    modalMsg('entry-msg', "Couldn't delete it. Check your connection and try again.");
  }
}

// ── Page wiring ──────────────────────────────────────────────────────────────
const syncDateChips = bindDateChips($('inv-date'), $('inv-form'));
$('inv-add').addEventListener('click', addEntry);
$('holding-save').addEventListener('click', saveHolding);
$('holding-delete').addEventListener('click', deleteHolding);
$('entry-save').addEventListener('click', saveEntry);
$('entry-delete').addEventListener('click', deleteEntry);

document.addEventListener('click', e => {
  const t = e.target;
  if (t.closest('[data-holding-new]')) return openHolding(null);
  const edit = t.closest('[data-holding-edit]');
  if (edit) return openHolding(holdings.find(h => h.id === edit.dataset.holdingEdit));
  const pick = t.closest('[data-inv-holding]');
  if (pick) { chosen = pick.dataset.invHolding; renderHoldingChips(); window.lucide?.createIcons(); return; }
  const row = t.closest('[data-entry-id]');
  if (row && !row.disabled) { const x = expenses.find(y => y.id === row.dataset.entryId); if (x) openEntry(x); return; }
  // Close: the ✕, or a tap on the backdrop
  for (const id of ['holding-modal', 'entry-modal']) {
    const m = $(id);
    if (!m.classList.contains('hidden') && (t === m || t.closest(`#${id} .modal-close-btn`))) return closeModal(id);
  }
});
['holding-modal', 'entry-modal'].forEach(id => $(id).addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); (id === 'holding-modal' ? saveHolding : saveEntry)(); }
}));

// Goals renamed or added in another tab, and queued entries written once back online
window.addEventListener('spendwise:goals', () => renderHoldings());
window.addEventListener('spendwise:synced', () => load());
