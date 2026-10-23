// Run: node --test tests/*.test.mjs — History page: date ranges, filters, search, sort, day headings
process.env.TZ = 'Asia/Kolkata';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyRange, filterHistory, historyDay, searchTag, totalsBy, tagsInUse } from '../assets/js/modules/history-data.js';

const now = new Date(2026, 9, 22, 12); // 22 Oct 2026, noon

const expenses = [
  { id: 'a', date: '2026-10-22', amount: 240, category: 'Food & Dining', description: 'Lunch', payment: 'UPI', tags: ['work'] },
  { id: 'b', date: '2026-10-22', amount: 180, category: 'Transport', description: 'Uber to office', payment: 'Card', cardName: 'HDFC' },
  { id: 'c', date: '2026-10-21', amount: 1299, category: 'Shopping', description: 'Shoes', payment: 'Card', cardName: 'ICICI', notes: 'Gift for my brother' },
  { id: 'd', date: '2026-09-12', amount: 3200, category: 'Groceries', description: 'Monthly groceries', payment: 'UPI' },
  { id: 'e', date: '2025-12-30', amount: 450, category: 'Food & Dining', description: 'New year dinner', payment: 'Cash' },
];
const tab = {
  kindOf: e => e.category,
  textOf: e => [e.description, e.category, e.notes, e.payment, e.cardName, ...(e.tags || [])],
};
const ids = opts => filterHistory(expenses, { ...tab, ...opts }).map(e => e.id).join('');

test('date ranges: this month, last month, 3 months, this year, custom, all', () => {
  assert.deepEqual(historyRange('month', now), ['2026-10-01', '2026-10-22']);
  assert.deepEqual(historyRange('lastMonth', now), ['2026-09-01', '2026-09-30']);
  assert.deepEqual(historyRange('quarter', now), ['2026-08-01', '2026-10-22']);
  assert.deepEqual(historyRange('year', now), ['2026-01-01', '2026-10-22']);
  assert.deepEqual(historyRange('custom', now, { from: '2025-12-01', to: '2025-12-31' }), ['2025-12-01', '2025-12-31']);
  assert.deepEqual(historyRange('all', now), ['', '']);
});

test('last month and 3 months in January reach back into the previous year', () => {
  const jan = new Date(2026, 0, 15);
  assert.deepEqual(historyRange('lastMonth', jan), ['2025-12-01', '2025-12-31']);
  assert.deepEqual(historyRange('quarter', jan), ['2025-11-01', '2026-01-15']);
});

test('newest first by default; oldest and largest on request', () => {
  assert.equal(ids({}).slice(2), 'cde'); // a and b share a date
  assert.equal(ids({ sort: 'oldest' })[0], 'e');
  assert.equal(ids({ sort: 'largest' }), 'dceab');
});

test('dates are inclusive at both ends', () => {
  assert.deepEqual([...ids({ from: '2026-10-21', to: '2026-10-22' })].sort(), ['a', 'b', 'c']);
  assert.equal(ids({ from: '2025-12-01', to: '2025-12-31' }), 'e');
});

test('chips: one or several categories', () => {
  assert.equal(ids({ kinds: new Set(['Transport']) }), 'b');
  assert.equal(ids({ kinds: new Set(['Transport', 'Shopping']) }), 'bc');
});

test('search looks at description, notes, payment, card name and tags, ignoring case', () => {
  assert.equal(ids({ q: 'UBER' }), 'b');
  assert.equal(ids({ q: 'brother' }), 'c');
  assert.equal(ids({ q: 'icici' }), 'c');
  assert.equal(ids({ q: 'work' }), 'a');
  assert.equal(ids({ q: 'cash' }), 'e');
  assert.equal(ids({ q: '  ' }), ids({}));
  assert.equal(ids({ q: 'nothing like this' }), '');
});

test('filters combine, and the input list is left as it was', () => {
  const before = expenses.map(e => e.id).join('');
  assert.equal(ids({ from: '2026-10-01', kinds: new Set(['Food & Dining']), q: 'lunch' }), 'a');
  assert.equal(expenses.map(e => e.id).join(''), before);
});

test('day headings', () => {
  assert.equal(historyDay('2026-10-22', now), 'Today');
  assert.equal(historyDay('2026-10-21', now), 'Yesterday');
  assert.equal(historyDay('2026-10-19', now), 'Mon, 19 Oct');
  assert.equal(historyDay('2025-12-30', now), 'Tue, 30 Dec, 2025');
});

test('a #tag search matches that tag exactly, any case; a plain word still searches text', () => {
  const trip = [
    { id: 'h', date: '2026-10-02', amount: 6000, category: 'Travel', description: 'Goa hotel', tags: ['Goa2026'] },
    { id: 'f', date: '2026-10-03', amount: 900, category: 'Food & Dining', description: 'Beach shack', tags: ['goa2026', 'friends'] },
    { id: 'g', date: '2026-10-05', amount: 300, category: 'Food & Dining', description: 'Goa sweets for office', tags: [] },
  ];
  const run = q => filterHistory(trip, { ...tab, tagsOf: e => e.tags, q }).map(e => e.id).sort().join('');
  assert.equal(run('#goa2026'), 'fh');
  assert.equal(run('#goa'), '');      // exact, not a prefix
  assert.equal(run('goa'), 'fgh');    // plain search unchanged
  assert.equal(searchTag(' #Goa2026 '), 'goa2026');
  assert.equal(searchTag('#goa trip'), null);
  assert.deepEqual(totalsBy(trip, e => e.category), [['Travel', 6000], ['Food & Dining', 1200]]);
  assert.deepEqual(tagsInUse(trip, e => e.tags), ['Goa2026', 'friends']);
});
