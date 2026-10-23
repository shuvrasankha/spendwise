// Run: node --test tests/ — splitting an expense, and a shared debt seen from the other side
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitAmount, sharedDebtView } from '../assets/js/utils/helpers.js';

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
  assert.deepEqual(d, { id: 'd1', amount: 250, type: 'i-owe', person: 'Ravi', date: '2026-10-20', notes: 'Split: Dinner', settled: false, settledDate: '', shared: true });
});

test('settled on their side shows settled on yours', () => {
  assert.equal(sharedDebtView('d2', { type: 'they-owe', amount: 1, settled: true, settledDate: '2026-10-22' }).settled, true);
});
