// Run: node --test tests/*.test.mjs — splitting an expense, and a shared debt seen from the other side
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitAmount, sharedDebtView, notificationsFrom, peopleFrom } from '../assets/js/utils/helpers.js';

test('an even split gives everyone the same share', () => {
  assert.deepEqual(splitAmount(900, 2), { each: 300, mine: 300 });
});

test('your share absorbs the rounding, so the parts add back to the total', () => {
  const { each, mine } = splitAmount(100, 2);
  assert.equal(each, 33.33);
  assert.equal(mine, 33.34);
  assert.equal(Math.round((each * 2 + mine) * 100) / 100, 100);
});

test('a debt they recorded as owed to them is one you owe, from them', () => {
  const d = sharedDebtView('d1', { uid: 'them', type: 'they-owe', amount: 250, fromName: 'Ravi', date: '2026-10-20', notes: 'Split: Dinner', settled: false, withEmail: 'me@x.com' });
  assert.deepEqual(d, { id: 'd1', amount: 250, type: 'i-owe', person: 'Ravi', email: '', date: '2026-10-20', notes: 'Split: Dinner', settled: false, settledDate: '', createdAt: 0, shared: true });
});

test('settled on their side shows settled on yours', () => {
  assert.equal(sharedDebtView('d2', { type: 'they-owe', amount: 1, settled: true, settledDate: '2026-10-22' }).settled, true);
});

test('notifications: each split, then its settling, newest first', () => {
  const open = sharedDebtView('a', { type: 'they-owe', amount: 300, fromName: 'Ravi', date: '2026-10-20', notes: 'Split: Dinner', createdAt: { toMillis: () => 1000 } });
  const paid = sharedDebtView('b', { type: 'they-owe', amount: 120, fromName: 'Asha', date: '2026-10-18', settled: true, settledDate: '2026-10-22', createdAt: { toMillis: () => 500 } });
  const items = notificationsFrom([open, paid]);
  assert.deepEqual(items.map(i => i.id), ['b:settled', 'a:split', 'b:split']);
  assert.deepEqual(items[0], { id: 'b:settled', kind: 'settled', type: 'i-owe', at: Date.parse('2026-10-22T23:59:59'), day: '2026-10-22', person: 'Asha', amount: 120, note: '' });
  assert.equal(items[1].person, 'Ravi');
});

test('people: from your debts and from splits with you, newest first, one each', () => {
  const debts = [
    { person: 'Ravi', withEmail: 'ravi@x.com', date: '2026-10-01' },
    { person: 'ravi', date: '2026-10-20' },                                    // same Ravi, email known elsewhere
    { person: 'Asha', date: '2026-10-10' },                                    // name only
    { person: 'Ravi', withEmail: 'ravi@x.com', date: '2026-09-01' },          // repeat
    sharedDebtView('s1', { type: 'they-owe', fromName: 'Meera', fromEmail: 'meera@y.com', date: '2026-10-15' }),
    { person: 'Ravi', withEmail: 'ravi.k@z.com', date: '2026-08-01' },        // a second Ravi
  ];
  assert.deepEqual(peopleFrom(debts), [
    { name: 'Meera', email: 'meera@y.com' },
    { name: 'Asha', email: '' },
    { name: 'Ravi', email: 'ravi@x.com' },
    { name: 'Ravi', email: 'ravi.k@z.com' },
  ]);
});
