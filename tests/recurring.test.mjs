// Run: node --test tests/*.test.mjs — repeating expenses, budget limits and savings goals
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueRecurring, upcomingBills, recurringKey, budgetState, goalPace, emiPlans, forecast } from '../assets/js/utils/helpers.js';

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

// ── EMIs: a monthly series with a set number of payments ──
const phone = (date, extra = {}) => ({ id: date, amount: 5000, category: 'Shopping', description: 'iPhone EMI', date, repeat: 'monthly', emiTotal: 6, ...extra });

test('EMI: due shows which payment it is, and stops once all are paid', () => {
  const paid = ['2026-05-10', '2026-06-10', '2026-07-10', '2026-08-10', '2026-09-10'].map(d => phone(d));
  const due = dueRecurring(paid, '2026-10-12');
  assert.deepEqual(due.map(d => [d.due, d.emi]), [['2026-10-10', { paid: 5, total: 6 }]]); // the 6th payment
  const all = [...paid, phone('2026-10-10')];
  assert.equal(dueRecurring(all, '2026-11-12').length, 0);
  assert.equal(upcomingBills(all, '2026-10-20').length, 0); // no bill alert after the last one
});

test('EMI: payments made before SpendWise count', () => {
  const due = dueRecurring([phone('2026-09-10', { emiTotal: 12, emiPaidBefore: 4 })], '2026-10-12');
  assert.deepEqual(due[0].emi, { paid: 5, total: 12 });
  assert.equal(dueRecurring([phone('2026-09-10', { emiTotal: 12, emiPaidBefore: 11 })], '2026-10-12').length, 0);
});

test('EMI plans: progress, what is left, next payment and the month it ends', () => {
  const [plan] = emiPlans([phone('2026-09-10'), phone('2026-10-10')], '2026-10-24');
  assert.deepEqual({ paid: plan.paid, total: plan.total, left: plan.left, next: plan.next, ends: plan.ends, done: plan.done, title: plan.title },
    { paid: 2, total: 6, left: 20000, next: '2026-11-10', ends: '2027-02', done: false, title: 'iPhone EMI' });
  // this month's not paid yet: it is the next one, even with its day gone by
  assert.equal(emiPlans([phone('2026-09-10')], '2026-10-24')[0].next, '2026-10-10');
});

test('EMI plans: paid off ones last, a stopped one left out, plain repeats ignored', () => {
  const done = ['2026-05-10', '2026-06-10'].map(d => ({ ...phone(d, { emiTotal: 2 }), description: 'Fridge EMI' }));
  const running = phone('2026-10-10');
  const stopped = { ...phone('2026-10-01', { repeat: 'stopped' }), description: 'Old loan' };
  const plans = emiPlans([...done, running, stopped, rent], '2026-10-24');
  assert.deepEqual(plans.map(p => [p.title, p.done]), [['iPhone EMI', false], ['Fridge EMI', true]]);
  assert.equal(plans[1].ends, '2026-06');
});

// ── Forecast: spent so far + bills still due + usual flexible pace for the days left ──
test('month-end forecast: spent, bills still due, usual pace; and next month', () => {
  const today = '2026-10-24'; // 7 days left in October
  const ex = [
    // rent paid on the 1st each month (fixed), wifi due on the 28th (not yet this month)
    { amount: 6500, category: 'Home & Rent', description: 'Rent', date: '2026-09-01', repeat: 'monthly' },
    { amount: 6500, category: 'Home & Rent', description: 'Rent', date: '2026-10-01', repeat: 'monthly' },
    { amount: 600, category: 'Bills & Utilities', description: 'Wifi', date: '2026-09-28', repeat: 'monthly' },
    // an EMI with its last payment due on the 26th: not in next month's bills
    { amount: 5000, category: 'Shopping', description: 'Phone EMI', date: '2026-09-26', repeat: 'monthly', emiTotal: 2 },
    // flexible: 90 days of ₹100 a day = 9,000 from 27 Jul to 24 Oct
    ...Array.from({ length: 90 }, (_, i) => { const d = new Date(2026, 9, 24 - i); return { amount: 100, category: 'Food & Dining', description: 'x', date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }; }),
    { amount: 5000, category: 'Savings & Investments', description: 'SIP', date: '2026-10-05' }, // not spending
  ];
  const f = forecast(ex, today);
  assert.equal(f.spent, 6500 + 24 * 100);
  assert.deepEqual(f.billsDue.map(b => [b.title, b.amount, b.due]), [['Phone EMI', 5000, '2026-10-26'], ['Wifi', 600, '2026-10-28']]);
  assert.equal(Math.round(f.perDay), 100);
  assert.equal(f.daysLeft, 7);
  assert.equal(Math.round(f.total), 8900 + 5600 + 700);
  assert.equal(f.next.bills, 2); // rent and wifi; the EMI ends this month
  assert.equal(Math.round(f.next.total), 7100 + 30 * 100);
});

test('forecast: a skipped bill is left out, a new account uses the days it has', () => {
  const ex = [
    { amount: 600, category: 'Bills & Utilities', description: 'Wifi', date: '2026-09-28', repeat: 'monthly' },
    { amount: 300, category: 'Food & Dining', description: 'x', date: '2026-10-20' },
    { amount: 200, category: 'Food & Dining', description: 'y', date: '2026-10-24' },
  ];
  const skipped = (key, month) => key.startsWith('Bills') && month === '2026-10';
  const f = forecast(ex, '2026-10-24', skipped);
  assert.equal(f.billsTotal, 0);
  assert.equal(Math.round(f.perDay), 19); // ₹500 flexible over the 27 days since the first entry (28 Sep), not 90
});

test('forecast: one-off big expenses are left out of the usual pace', () => {
  const day = i => { const d = new Date(2026, 9, 24 - i); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const ex = [
    ...Array.from({ length: 90 }, (_, i) => ({ amount: 100, category: 'Food & Dining', description: 'x', date: day(i) })),
    { amount: 10000, category: 'Travel', description: 'Hotel', date: day(40) }, // 10% of 19,000: a one-off
  ];
  const f = forecast(ex, '2026-10-24');
  assert.equal(f.oneOffs, 1);
  assert.equal(Math.round(f.perDay), 100);
  // too few entries to tell a one-off from a habit: nothing is left out
  assert.equal(forecast([ex[0], ex[1], ex[90]], '2026-10-24').oneOffs, 0);
});
