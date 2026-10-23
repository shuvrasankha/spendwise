// split.js — Debts shared by email, and splitting an expense.
// A debt with withEmail is visible, read-only, to whoever signs in with that verified email
// (firestore.rules › debts); they see it from their side and get one push (worker/src/push.js).
// On the Add Expense form: the people to share it with (dashboard.js addExpense saves your share
// as the expense and a "they owe me" debt per person). The Debts form shares one debt (debt.js).
import { auth, db } from '../config/firebase.js';
import { callWorker } from '../config/ai.js';
import { collection, getDocs, query, where, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { sanitize, splitAmount, sharedDebtView } from '../utils/helpers.js';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_PEOPLE = 10;

// ── Sharing a debt by email ──────────────────────────────────────────────────
// Why an email can't be used, or null when it's empty or fine
export function emailError(email) {
  if (!email) return null;
  if (!EMAIL.test(email)) return `"${email}" doesn't look like an email address.`;
  if (email === auth.currentUser?.email?.toLowerCase()) return "That's your own email. Use the other person's.";
  return null;
}

// Fields that share a debt with `email` (lowercase); none without one. fromEmail lets them pick you
// when they add one back (the rules check it's really yours).
export function shareFields(email) {
  if (!email) return {};
  const user = auth.currentUser;
  return { withEmail: email, fromName: sanitize(user.displayName || user.email, 100), fromEmail: user.email.toLowerCase() };
}

// Debts other people shared with this account's verified email. Empty if there are none or they
// can't be read (for example before the updated rules are published), so own debts still load.
export async function fetchSharedDebts(user) {
  if (!user?.email || !user.emailVerified) return [];
  try {
    const snap = await getDocs(query(collection(db, 'debts'), where('withEmail', '==', user.email.toLowerCase())));
    return snap.docs.map(d => sharedDebtView(d.id, d.data()));
  } catch (e) {
    console.warn('Shared debts unavailable:', e);
    return [];
  }
}

// After shared debts are saved: ask the Worker to push each to the person named by email (it checks
// the debt is ours and new, and sends once). Best effort: the debt is already in their account.
export function announceDebts(refs, debts) {
  const symbol = window.getCurrencyInfo?.(window.getCurrency())?.symbol;
  debts.forEach((d, i) => {
    if (d.withEmail) callWorker('/push/debt', { debtId: refs[i].id, symbol }).catch(() => {});
  });
}

// ── Splitting an expense ─────────────────────────────────────────────────────
const list = () => document.getElementById('split-people');

function rows() {
  return [...(list()?.querySelectorAll('.split-person') || [])].map(li => ({
    name: li.querySelector('.split-name').value.trim(),
    email: li.querySelector('.split-email').value.trim().toLowerCase(),
  }));
}

function addRow() {
  const ul = list();
  if (!ul || ul.children.length >= MAX_PEOPLE) return;
  const n = ul.children.length + 1;
  const li = document.createElement('li');
  li.className = 'split-person';
  li.dataset.personPair = '';
  li.innerHTML = `
    <input type="text" class="split-name" data-person-name maxlength="100" placeholder="Name" aria-label="Person ${n} name" autocomplete="off" list="split-name-list" />
    <input type="email" class="split-email" data-person-email maxlength="254" placeholder="Email (optional)" aria-label="Person ${n} email" autocomplete="off" inputmode="email" list="split-email-list" />
    <button type="button" class="icon-btn split-remove" data-split-remove aria-label="Remove person ${n}" title="Remove"><i data-lucide="x"></i></button>`;
  ul.append(li);
  if (window.lucide) lucide.createIcons();
  li.querySelector('.split-name').focus();
  updateSummary();
}

// "Your share ₹300 · each owes ₹300", kept in step with the amount and the people
function updateSummary() {
  const hint = document.getElementById('exp-split-hint');
  const note = document.getElementById('split-summary');
  if (!hint || !note) return;
  const people = rows().filter(p => p.name).length;
  const amount = parseFloat(document.getElementById('exp-amount')?.value);
  if (!people) { hint.textContent = ''; note.textContent = 'Add the people who shared this. It is split equally.'; return; }
  hint.textContent = `${people} ${people === 1 ? 'person' : 'people'}`;
  if (!(amount > 0)) { note.textContent = 'Enter the full amount above to see each share.'; return; }
  const { each, mine } = splitAmount(amount, people);
  note.textContent = `Your share ${window.fmt(mine)} is saved as the expense · each person owes you ${window.fmt(each)}`;
}

document.addEventListener('click', e => {
  if (e.target.closest('[data-split-add]')) addRow();
  const remove = e.target.closest('[data-split-remove]');
  if (remove) { remove.closest('.split-person').remove(); updateSummary(); }
});
document.addEventListener('input', e => {
  if (e.target.closest('#split-people') || e.target.id === 'exp-amount') updateSummary();
});

// The people to split with, or null when not splitting; { error } when a row needs fixing
export function getSplit() {
  const people = rows().filter(p => p.name || p.email);
  if (!people.length) return null;
  for (const p of people) {
    if (!p.name) return { error: 'Enter a name for each person you split with.' };
    const bad = emailError(p.email);
    if (bad) return { error: bad };
  }
  return { people: people.map(p => ({ name: sanitize(p.name, 100), email: p.email })) };
}

export function resetSplit() {
  list()?.replaceChildren();
  const more = document.getElementById('exp-split');
  if (more) more.open = false;
  updateSummary();
}

// One "they owe me" debt per person, for the share each owes on the expense's date
export function splitDebts(people, each, { date, label }) {
  return people.map(p => ({
    uid: auth.currentUser.uid,
    amount: each,
    type: 'they-owe',
    person: p.name,
    date,
    notes: sanitize(`Split: ${label}`, 500),
    settled: false,
    settledDate: '',
    encoding: 'plain',
    createdAt: serverTimestamp(),
    ...shareFields(p.email),
  }));
}
