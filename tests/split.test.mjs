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
  assert.deepEqual(d, { id: 'd1', amount: 250, type: 'i-owe', person: 'Ravi', email: '', date: '2026-10-20', notes: 'Split: Dinner', settled: false, settledDate: '', claimDate: '', paid: [], createdAt: 0, shared: true });
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

test('notifications: the other person saying your shared debt is settled, until you settle it', () => {
  const claimed = { id: 'c', type: 'they-owe', amount: 500, person: 'Ravi', date: '2026-10-10', notes: 'Rent', withEmail: 'ravi@x.com', claimDate: '2026-10-23' };
  const items = notificationsFrom([], [claimed, { ...claimed, id: 'd', claimDate: '' }, { ...claimed, id: 'e', settled: true }]);
  assert.deepEqual(items, [{ id: 'c:claim:2026-10-23:500', kind: 'claim', type: 'they-owe', at: Date.parse('2026-10-23T23:59:59'), day: '2026-10-23', person: 'Ravi', amount: 500, settles: true, note: 'Rent' }]);
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

test('part-payments: what is left, paying it off, and too much', async () => {
  const { debtLeft, debtPaid, payDebt, sharedDebtView } = await import('../assets/js/utils/helpers.js');
  const d = { amount: 1768, paid: [{ amount: 500, date: '2026-10-20' }] };
  assert.equal(debtPaid(d), 500);
  assert.equal(debtLeft(d), 1268);
  assert.equal(debtLeft({ amount: 1768 }), 1768); // older debts have no payments
  const part = payDebt(d, '268', '2026-10-25');
  assert.equal(part.settles, false);
  assert.deepEqual(part.paid.map(p => p.amount), [500, 268]);
  const rest = payDebt({ ...d, paid: part.paid }, 1000, '2026-10-26');
  assert.equal(rest.settles, true);
  assert.equal(payDebt(d, 1300, '2026-10-25').error !== undefined, true);
  assert.equal(payDebt(d, 0, '2026-10-25').error, 'Enter the amount paid.');
  // payments made out of order are kept by date
  assert.deepEqual(payDebt(d, 10, '2026-10-01').paid.map(p => p.date), ['2026-10-01', '2026-10-20']);
  // the other person sees the same left-over amount
  assert.equal(debtLeft(sharedDebtView('x', { amount: 1768, type: 'they-owe', paid: d.paid })), 1268);
});

test('the other person says part was paid: it counts once confirmed', async () => {
  const { debtClaim, notificationsFrom } = await import('../assets/js/utils/helpers.js');
  const d = { id: 'd', amount: 1768, paid: [{ amount: 500, date: '2026-10-20' }], claimDate: '2026-10-25', claimAmount: 300, person: 'Bibhu', type: 'they-owe' };
  assert.deepEqual(debtClaim(d), { amount: 300, date: '2026-10-25', settles: false });
  // a claim from before part-payments (no amount) is all that's left
  assert.deepEqual(debtClaim({ ...d, claimAmount: undefined }), { amount: 1268, date: '2026-10-25', settles: true });
  // never more than what's left
  assert.equal(debtClaim({ ...d, claimAmount: 5000 }).amount, 1268);
  assert.equal(debtClaim({ ...d, settled: true }), null);
  const [item] = notificationsFrom([], [d]);
  assert.equal(item.amount, 300);
  assert.equal(item.settles, false);
});

test('bell items map to the pushes in the phone tray, and seen/cleared lists merge across devices', async () => {
  const { pushTagsFor, mergeIds } = await import('../assets/js/utils/helpers.js');
  assert.deepEqual([...pushTagsFor(['d1:split', 'd1:settled', 'd2:claim:2026-10-25:500'])], ['debt-d1', 'claim-d2']);
  assert.deepEqual(mergeIds(['a', 'b'], ['b', 'c']), ['a', 'b', 'c']);
  assert.equal(mergeIds(Array.from({ length: 250 }, (_, i) => 'x' + i), []).length, 200);
  assert.equal(mergeIds(Array.from({ length: 250 }, (_, i) => 'x' + i), []).at(-1), 'x249'); // keeps the newest
});
