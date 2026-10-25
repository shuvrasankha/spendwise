// Run: node --test tests/*.test.mjs — what each person owes overall, by email
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { debtsByPerson, isPersons } from '../assets/js/modules/debt-data.js';

const debts = [
  { person: 'Bibhu', withEmail: 'bibhu@x.com', type: 'they-owe', amount: 1768, paid: [{ amount: 500, date: '2026-10-25' }], date: '2026-10-25' },
  { person: 'Bibhusundar Khanra', withEmail: 'Bibhu@x.com', type: 'they-owe', amount: 300, date: '2026-10-20' }, // same email, another name
  { person: 'bibhu', type: 'i-owe', amount: 100, date: '2026-10-21' },                                     // name only: joins by name
  { shared: true, person: 'Ravi', email: 'ravi@y.com', type: 'i-owe', amount: 900, paid: [{ amount: 200, date: '2026-10-22' }], date: '2026-10-20' },
  { person: 'Ravi', withEmail: 'ravi@y.com', type: 'they-owe', amount: 250, date: '2026-10-23' },
  { person: 'Asha', type: 'they-owe', amount: 50, date: '2026-10-01' },
  { person: 'Asha', type: 'they-owe', amount: 60, date: '2026-10-02', settled: true },                      // settled: left out
];

test('one row per email, netting both ways, after part-payments', () => {
  const rows = debtsByPerson(debts);
  assert.deepEqual(rows.map(r => [r.name, r.email, r.owedToYou, r.youOwe, r.net, r.count]), [
    ['Bibhu', 'bibhu@x.com', 1568, 100, 1468, 3],
    ['Ravi', 'ravi@y.com', 250, 700, -450, 2],
    ['Asha', '', 50, 0, 50, 1],
  ]);
});

test('a name used with two emails stays two people', () => {
  const rows = debtsByPerson([
    { person: 'Amit', withEmail: 'a1@x.com', type: 'they-owe', amount: 10 },
    { person: 'Amit', withEmail: 'a2@x.com', type: 'they-owe', amount: 20 },
    { person: 'Amit', type: 'they-owe', amount: 5 },
  ]);
  assert.equal(rows.length, 3);
});

test('filtering the list to one person', () => {
  const [bibhu] = debtsByPerson(debts);
  assert.equal(debts.filter(d => isPersons(d, bibhu)).length, 3);
});
