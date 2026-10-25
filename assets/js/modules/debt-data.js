// debt-data.js — Debts grouped by person, for the Debts page's "By person" list (no DOM, no Firebase).
// A person is their email when one is known (the one you shared with, or the one who shared with you),
// else their name. A name-only debt joins the person with that name who has an email, if exactly one.
import { debtLeft } from '../utils/helpers.js';

const emailOf = d => ((d.shared ? d.email : d.withEmail) || '').trim().toLowerCase();
const nameKey = d => (d.person || '').trim().toLowerCase();

// Open debts per person: [{ key, name, email, owedToYou, youOwe, net, count }], biggest balance first.
// net > 0: they owe you overall. Amounts are what's left after part-payments.
export function debtsByPerson(debts) {
  const open = debts.filter(d => !d.settled && (d.person || '').trim());
  // Which email each name goes with, when it's only ever one
  const emailsByName = new Map();
  open.forEach(d => {
    const e = emailOf(d);
    if (!e) return;
    const set = emailsByName.get(nameKey(d)) || new Set();
    set.add(e);
    emailsByName.set(nameKey(d), set);
  });
  const people = new Map();
  for (const d of [...open].sort((a, b) => (b.date || '').localeCompare(a.date || ''))) {
    const known = emailsByName.get(nameKey(d));
    const email = emailOf(d) || (known?.size === 1 ? [...known][0] : '');
    const key = email || `name:${nameKey(d)}`;
    const p = people.get(key) || { key, name: d.person.trim(), email, owedToYou: 0, youOwe: 0, count: 0 };
    const left = debtLeft(d);
    if (d.type === 'i-owe') p.youOwe += left; else p.owedToYou += left;
    p.count++;
    people.set(key, p);
  }
  return [...people.values()]
    .map(p => ({ ...p, owedToYou: round(p.owedToYou), youOwe: round(p.youOwe), net: round(p.owedToYou - p.youOwe) }))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || b.count - a.count);
}

// Whether a debt belongs to the person with this key (as debtsByPerson made it)
export function isPersons(d, person) {
  const e = emailOf(d);
  if (person.email) return e === person.email || (!e && nameKey(d) === person.name.toLowerCase());
  return !e && nameKey(d) === person.name.toLowerCase();
}

const round = n => Math.round(n * 100) / 100;
