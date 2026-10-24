// Run: node --test tests/*.test.mjs — Investments: holdings, worth, SIPs, goals and debts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holdingOf, portfolio, linkedToGoals, withLinked, afterDebts, kindOf } from '../assets/js/modules/invest-data.js';
import { forecast, goalPace } from '../assets/js/utils/helpers.js';

const INV = 'Savings & Investments';
const axis = { id: 'h1', name: 'Axis Bluechip', kind: 'mf', goalId: 'g1' };
const fd = { id: 'h2', name: 'SBI FD', kind: 'fd', value: 105000, valueDate: '2026-09-30' };
const holdings = [axis, fd];
const today = '2026-10-24';

const sip = (date, extra = {}) => ({ amount: 5000, category: INV, description: 'Axis Bluechip', date, holdingId: 'h1', repeat: 'monthly', ...extra });
const expenses = [
  sip('2026-08-05'), sip('2026-09-05'), sip('2026-10-05'),
  { amount: 100000, category: INV, description: 'SBI FD', date: '2026-01-10', holdingId: 'h2' },
  { amount: 2000, category: INV, description: 'sbi fd ', date: '2026-10-12' }, // made on the expense form: matched by name
  { amount: 3000, category: INV, description: 'Gold coin', date: '2026-10-02' }, // in no holding
  { amount: 900, category: 'Food & Dining', description: 'Axis Bluechip', date: '2026-10-03' }, // spending, never a holding's
  { amount: 5000, category: INV, description: 'Axis Bluechip', date: '2026-11-05', holdingId: 'h1' }, // future: not counted yet
];

test('an entry belongs to its holdingId, else to a holding with the same name, never when it is spending', () => {
  assert.equal(holdingOf(expenses[0], holdings), axis);
  assert.equal(holdingOf(expenses[4], holdings), fd);
  assert.equal(holdingOf(expenses[5], holdings), null);
  assert.equal(holdingOf(expenses[6], holdings), null);
  // a deleted holding's entries fall back to the name, then to no holding
  assert.equal(holdingOf({ ...expenses[0], holdingId: 'gone' }, holdings), axis);
  assert.equal(holdingOf({ ...expenses[5], holdingId: 'gone' }, holdings), null);
});

test('worth is the last value given plus what went in after it; with no value, what went in', () => {
  const p = portfolio(holdings, expenses, today);
  const [first, second] = p.rows;
  assert.equal(first.holding, fd); // the bigger one first
  assert.equal(first.invested, 102000);
  assert.equal(first.value, 107000); // 105,000 on 30 Sep, plus 2,000 on 12 Oct
  assert.equal(first.gain, 5000);
  assert.equal(second.holding, axis);
  assert.equal(second.invested, 15000);
  assert.equal(second.value, 15000);
  assert.equal(second.gain, null); // no value given: nothing to compare with
  assert.deepEqual(p.other, { invested: 3000, count: 1, entries: [expenses[5]] });
  assert.equal(p.invested, 120000);
  assert.equal(p.value, 125000);
  assert.equal(p.gain, 5000);
  assert.ok(Math.abs(p.gainPct - (5000 / 102000) * 100) < 1e-9); // against the valued holdings only
  assert.equal(p.thisMonth, 10000);
  assert.equal(p.thisYear, 120000);
});

test('a SIP is the holding repeating monthly: amount and next date; stopping it ends it', () => {
  const p = portfolio(holdings, expenses, today);
  const a = p.rows.find(r => r.holding === axis);
  assert.equal(a.sip.amount, 5000);
  assert.equal(a.sip.due, '2026-11-05'); // October's is in
  assert.equal(p.monthly, 5000);
  const stopped = [...expenses.slice(0, 2), sip('2026-10-05', { repeat: 'stopped' })];
  assert.equal(portfolio(holdings, stopped, today).rows.find(r => r.holding === axis).sip, null);
});

test('a goal counts what its linked holdings are worth on top of what was saved by hand', () => {
  const p = portfolio(holdings, expenses, today);
  const linked = linkedToGoals(p.rows);
  assert.deepEqual(linked, { g1: 15000 });
  const goal = withLinked({ id: 'g1', name: 'House', target: 50000, saved: 5000, by: '2027-12' }, linked);
  assert.equal(goal.saved, 20000);
  assert.equal(goal.linked, 15000);
  assert.equal(goalPace(goal, today).left, 30000);
  assert.equal(withLinked({ id: 'g2', target: 100, saved: 10, by: '2027-01' }, linked).saved, 10);
});

test('after debts: worth plus what is owed to you, less what you owe; settled debts are left out', () => {
  const debts = [
    { amount: 2000, type: 'they-owe' }, { amount: 7000, type: 'i-owe' }, { amount: 500, type: 'i-owe', settled: true },
  ];
  assert.deepEqual(afterDebts(125000, debts), { worth: 125000, owedToYou: 2000, youOwe: 7000, total: 120000 });
});

test('an unknown kind shows as Other', () => {
  assert.equal(kindOf('crypto').id, 'other');
  assert.equal(kindOf('ppf').label, 'PPF');
});

test('the month-end forecast leaves a SIP out: money put aside is not spending', () => {
  const rent = { amount: 18000, category: 'Home & Rent', description: 'Rent', date: '2026-09-28', repeat: 'monthly' };
  const f = forecast([rent, sip('2026-09-05')], '2026-10-04');
  assert.deepEqual(f.billsDue.map(b => b.title), ['Rent']);
  assert.equal(f.next.bills, 1);
  assert.equal(f.next.fixed, 18000);
});
