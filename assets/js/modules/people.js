// people.js — Name and email suggestions for the people you deal with, on the split form
// (split.js) and the Debts form. Built from your debts (dashboard.js and debt.js pass them):
// your own, with the email you shared them with, and ones others shared with you.
//   <datalist data-people="name">, <datalist data-people="email">: filled here
//   inside a [data-person-pair]: [data-person-name] and [data-person-email] inputs; picking a name
//   fills its email, and an email fills an empty name
import { peopleFrom, escapeHtml } from '../utils/helpers.js';

let people = [];
let byName = new Map(); // suggestion value -> person

export function setKnownPeople(debts) {
  people = peopleFrom(debts);
  const counts = people.reduce((m, p) => m.set(p.name.toLowerCase(), (m.get(p.name.toLowerCase()) || 0) + 1), new Map());
  // Two people with one name are told apart by their email
  byName = new Map(people.map(p => [counts.get(p.name.toLowerCase()) > 1 ? `${p.name} · ${p.email}` : p.name, p]));
  const nameOptions = [...byName].map(([value, p]) => `<option value="${escapeHtml(value)}">${escapeHtml(p.email)}</option>`).join('');
  const emailOptions = people.filter(p => p.email).map(p => `<option value="${escapeHtml(p.email)}">${escapeHtml(p.name)}</option>`).join('');
  document.querySelectorAll('datalist[data-people="name"]').forEach(l => { l.innerHTML = nameOptions; });
  document.querySelectorAll('datalist[data-people="email"]').forEach(l => { l.innerHTML = emailOptions; });
}

document.addEventListener('input', e => {
  const input = e.target;
  const pair = input.closest?.('[data-person-pair]');
  if (!pair) return;
  const nameEl = pair.querySelector('[data-person-name]');
  const emailEl = pair.querySelector('[data-person-email]');
  if (input === nameEl) {
    const p = byName.get(nameEl.value);
    if (!p) return;
    nameEl.value = p.name;
    if (p.email) emailEl.value = p.email;
  } else if (input === emailEl) {
    const p = people.find(x => x.email && x.email === emailEl.value.trim().toLowerCase());
    if (p && !nameEl.value.trim()) nameEl.value = p.name;
  }
});
