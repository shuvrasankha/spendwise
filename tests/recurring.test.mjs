// Run: node --test tests/*.test.mjs — repeating expenses, budget limits and savings goals
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueRecurring, upcomingBills, recurringKey, budgetState, goalPace } from '../assets/js/utils/helpers.js';

const rent = { id: 'r1', amount: 18000, category: 'Rent', description: 'Flat rent', date: '2026-09-01', repeat: 'monthly' };
const netflix = { id: 'n1', amount: 649, category: 'Subscription', description: 'Netflix', date: '2026-09-25', repeat: 'monthly' };

test('due once its day has come this month, dated on that day', () => {
  const due = dueRecurring([rent, netflix], '2026-10-04');
  assert.deepEqual(due.map(d => [d.template.id, d.due]), [['r1', '2026-10-01']]); // Netflix isn't due till the 25th
});

test('not due again once something is entered for it this month', () => {
  const added = { ...rent, id: 'r2', date: '2026-10-01' };
  assert.equal(dueRecurring([rent, added], '2026-10-04').length, 0);
  // an entry added by hand, without the repeat tick, also counts
  const manual = { amount: 18000, category: 'Home & Rent', description: 'flat rent ', date: '2026-10-02' };
  assert.equal(dueRecurring([rent, manual], '2026-10-04').length, 0);
});

test('the 31st falls on the last day of a shorter month', () => {
  const emi = { ...rent, id: 'e1', description: 'EMI', date: '2026-10-31' };
  assert.equal(dueRecurring([emi], '2026-11-29').length, 0);
  assert.equal(dueRecurring([emi], '2026-11-30')[0].due, '2026-11-30');
});

test('skipped for the month, or stopped', () => {
  assert.equal(dueRecurring([rent], '2026-10-04', (key, month) => key === recurringKey(rent) && month === '2026-10').length, 0);
  assert.equal(dueRecurring([rent], '2026-11-04', (key, month) => month === '2026-10').length, 1);
  const stopped = { ...rent, id: 'r2', date: '2026-09-02', repeat: 'stopped' };
  assert.equal(dueRecurring([rent, stopped], '2026-10-04').length, 0);
});

test('entries without the repeat tick never start a series', () => {
  assert.equal(dueRecurring([{ ...rent, repeat: undefined }], '2026-10-04').length, 0);
});

test('budget: share used, money left, and when to warn', () => {
  assert.equal(budgetState(500, 0), null);
  assert.deepEqual(budgetState(7000, 10000), { ratio: 0.7, left: 3000, state: 'ok' });
  assert.equal(budgetState(8000, 10000).state, 'near');
  assert.equal(budgetState(10000, 10000).state, 'near');
  assert.equal(budgetState(10500, 10000).state, 'over');
});

test('savings goal: monthly pace counts the current month, then done or late', () => {
  const goa = { target: 30000, saved: 6000, by: '2027-03' };
  assert.deepEqual(goalPace(goa, '2026-10-23'), { ratio: 0.2, left: 24000, months: 6, monthly: 4000, state: 'on' });
  assert.equal(goalPace(goa, '2027-03-31').monthly, 24000);
  assert.deepEqual(goalPace(goa, '2027-04-01'), { ratio: 0.2, left: 24000, months: 0, monthly: 0, state: 'late' });
  assert.equal(goalPace({ ...goa, saved: 31000 }, '2026-10-23').state, 'done');
  assert.equal(goalPace({ ...goa, saved: 31000 }, '2026-10-23').left, 0);
});

test('upcoming bills: this month until entered, skipped or passed, then next month', () => {
  const dues = (list, today, skipped) => upcomingBills(list, today, skipped).map(b => [b.title, b.due]);
  assert.deepEqual(dues([rent, netflix], '2026-10-04'), [['Netflix', '2026-10-25'], ['Flat rent', '2026-11-01']]); // rent overdue: Home lists it
  const paid = { ...netflix, id: 'n2', date: '2026-10-20', repeat: undefined };
  assert.deepEqual(dues([netflix, paid], '2026-10-04'), [['Netflix', '2026-11-25']]);
  assert.deepEqual(dues([netflix], '2026-10-04', () => true), [['Netflix', '2026-11-25']]);
  assert.deepEqual(dues([{ ...netflix, date: '2026-01-31' }], '2026-12-31'), [['Netflix', '2026-12-31']]);
  assert.deepEqual(dues([{ ...netflix, date: '2026-01-31' }, { ...paid, date: '2026-12-02' }], '2026-12-31'), [['Netflix', '2027-01-31']]);
  assert.deepEqual(dues([{ ...netflix, repeat: 'stopped' }], '2026-10-04'), []);
});
