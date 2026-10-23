// split.js — Split an expense. On the Add Expense form: the people to share it with (dashboard.js
// addExpense saves your share as the expense and a "they owe me" debt per person). A person with an
// email sees that debt in their own account as one they owe you, read-only (firestore.rules › debts).
import { auth, db } from '../config/firebase.js';
import { callWorker } from '../config/ai.js';
import { collection, getDocs, query, where, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { sanitize, splitAmount, sharedDebtView, peopleFrom, escapeHtml } from '../utils/helpers.js';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_PEOPLE = 10;

const list = () => document.getElementById('split-people');

// Suggestions: people from your debts and from bills split with you (dashboard.js passes its debts).
// A name's suggestion fills its email, and an email's fills the name.
let people = [];
let byName = new Map(); // suggestion value -> person
export function setKnownPeople(debts) {
  people = peopleFrom(debts);
  const counts = people.reduce((m, p) => m.set(p.name.toLowerCase(), (m.get(p.name.toLowerCase()) || 0) + 1), new Map());
  // Two people with one name are told apart by their email
  byName = new Map(people.map(p => [counts.get(p.name.toLowerCase()) > 1 ? `${p.name} · ${p.email}` : p.name, p]));
  const names = document.getElementById('split-name-list');
  const emails = document.getElementById('split-email-list');
  if (!names || !emails) return;
  names.innerHTML = [...byName].map(([value, p]) => `<option value="${escapeHtml(value)}">${escapeHtml(p.email)}</option>`).join('');
  emails.innerHTML = people.filter(p => p.email).map(p => `<option value="${escapeHtml(p.email)}">${escapeHtml(p.name)}</option>`).join('');
}

function fillFromSuggestion(input) {
  const row = input.closest('.split-person');
  const nameEl = row.querySelector('.split-name');
  const emailEl = row.querySelector('.split-email');
  if (input === nameEl) {
    const p = byName.get(nameEl.value);
    if (!p) return;
    nameEl.value = p.name;
    if (p.email) emailEl.value = p.email;
  } else {
    const p = people.find(x => x.email && x.email === emailEl.value.trim().toLowerCase());
    if (p && !nameEl.value.trim()) nameEl.value = p.name;
  }
}

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
  li.innerHTML = `
    <input type="text" class="split-name" maxlength="100" placeholder="Name" aria-label="Person ${n} name" autocomplete="off" list="split-name-list" />
    <input type="email" class="split-email" maxlength="254" placeholder="Email (optional)" aria-label="Person ${n} email" autocomplete="off" inputmode="email" list="split-email-list" />
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
  if (e.target.matches('.split-name, .split-email')) fillFromSuggestion(e.target);
  if (e.target.closest('#split-people') || e.target.id === 'exp-amount') updateSummary();
});

// The people to split with, or null when not splitting; { error } when a row needs fixing
export function getSplit() {
  const people = rows().filter(p => p.name || p.email);
  if (!people.length) return null;
  const mine = auth.currentUser?.email?.toLowerCase();
  for (const p of people) {
    if (!p.name) return { error: 'Enter a name for each person you split with.' };
    if (p.email && !EMAIL.test(p.email)) return { error: `"${p.email}" doesn't look like an email address.` };
    if (p.email && p.email === mine) return { error: "That's your own email. Leave yourself out: your share is worked out for you." };
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
  const user = auth.currentUser;
  return people.map(p => ({
    uid: user.uid,
    amount: each,
    type: 'they-owe',
    person: p.name,
    date,
    notes: sanitize(`Split: ${label}`, 500),
    settled: false,
    settledDate: '',
    encoding: 'plain',
    createdAt: serverTimestamp(),
    // fromEmail lets them pick you when they split back (firestore.rules checks it's really yours)
    ...(p.email && { withEmail: p.email, fromName: sanitize(user.displayName || user.email, 100), fromEmail: user.email.toLowerCase() }),
  }));
}

// Debts other people recorded with this account's verified email. Empty if there are none or they
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

// After a split is saved: ask the Worker to push it to each person named by email (worker/src/push.js
// checks the debt is ours and new, and sends once). Best effort: the debt is already in their account.
export function announceSplit(debtRefs, debts) {
  const symbol = window.getCurrencyInfo?.(window.getCurrency())?.symbol;
  debts.forEach((d, i) => {
    if (d.withEmail) callWorker('/push/debt', { debtId: debtRefs[i].id, symbol }).catch(() => {});
  });
}
