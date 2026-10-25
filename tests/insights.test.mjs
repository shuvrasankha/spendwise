// Run: node --test tests/*.test.mjs — Insights numbers, periods and markdown
process.env.TZ = 'Asia/Kolkata';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { periodRange, summarize, factsText, renderMarkdown, hasData } from '../assets/js/modules/insights-data.js';

const today = new Date(2026, 9, 21); // 21 Oct 2026
const money = n => `Rs ${Math.round(n)}`;

test('this month runs to today, compares with the same days last month', () => {
  const r = periodRange('month', today);
  assert.equal(r.start, '2026-10-01');
  assert.equal(r.end, '2026-10-21');
  assert.equal(r.elapsedDays, 21);
  assert.equal(r.monthDays, 31);
  assert.equal(r.prevStart, '2026-09-01');
  assert.equal(r.prevEnd, '2026-09-21');
});

test('last 3 months means Aug 1 to today (the old code used the calendar quarter)', () => {
  const r = periodRange('quarter', today);
  assert.equal(r.start, '2026-08-01');
  assert.equal(r.end, '2026-10-21');
  assert.equal(r.prevEnd, '2026-07-31');
  assert.equal(r.elapsedDays, 82);
});

test('last month in January wraps to the previous year', () => {
  const r = periodRange('lastMonth', new Date(2026, 0, 10));
  assert.equal(r.start, '2025-12-01');
  assert.equal(r.end, '2025-12-31');
  assert.equal(r.prevStart, '2025-11-01');
});

test('this month on 31 March compares with all of February', () => {
  const r = periodRange('month', new Date(2026, 2, 31));
  assert.equal(r.prevEnd, '2026-02-28');
});

test('custom range is validated', () => {
  assert.ok(periodRange('custom', today, { start: '2026-10-10', end: '2026-10-01' }).error);
  assert.ok(periodRange('custom', today, { start: '', end: '2026-10-01' }).error);
  const r = periodRange('custom', today, { start: '2026-10-01', end: '2026-10-10' });
  assert.equal(r.prevStart, '2026-09-21');
  assert.equal(r.prevEnd, '2026-09-30');
});

const data = {
  expenses: [
    { amount: 15000, category: 'Rent', date: '2026-10-01' },
    { amount: 3200, category: 'Shopping', date: '2026-10-12' },
    { amount: 600, category: 'Food & Dining', date: '2026-10-18' },
    { amount: 400, category: 'Food & Dining', date: '2026-10-20' },
    { amount: 15000, category: 'Rent', date: '2026-09-01' },
    { amount: 500, category: 'Food & Dining', date: '2026-09-10' },
    { amount: 999, category: 'Shopping', date: '2026-09-25' }, // after the 21st: not in the comparison
  ],
  income: [{ amount: 60000, source: 'Salary', date: '2026-10-01' }],
  debts: [
    { amount: 5000, type: 'i-owe', date: '2026-03-01', settled: false },      // old but still unpaid: counts
    { amount: 2000, type: 'they-owe', date: '2026-10-05', settled: false },
    { amount: 700, type: 'i-owe', date: '2026-09-01', settled: true, settledDate: '2026-10-02' },
  ],
};

test('summary: totals, per-day average over elapsed days, comparison, projection', () => {
  const s = summarize(data, periodRange('month', today));
  assert.equal(s.spent, 19200);
  assert.equal(s.earned, 60000);
  assert.equal(s.saved, 40800);
  assert.equal(s.savingsRate, 68);
  assert.ok(Math.abs(s.dailyAvg - 19200 / 21) < 1e-9); // not / 31
  assert.ok(Math.abs(s.projection - (19200 / 21) * 31) < 1e-9);
  assert.equal(s.prevSpent, 15500);
  assert.equal(s.categories[0].category, 'Rent');
  assert.equal(s.categories[1].change, null); // Shopping had nothing in the comparison days
  assert.equal(Math.round(s.categories.find(c => c.category === 'Food & Dining').change), 100);
  assert.deepEqual(s.biggest.map(b => b.amount), [15000, 3200, 600]);
});

test('investments count as saved, not spent', () => {
  const r = periodRange('month', today);
  const withSip = {
    ...data,
    expenses: [...data.expenses,
      { amount: 10000, category: 'Investment', date: '2026-10-05' },
      { amount: 7000, category: 'Investment', date: '2026-09-05' }], // in the comparison days
  };
  const s = summarize(withSip, r);
  assert.equal(s.spent, 19200);    // unchanged by the SIP
  assert.equal(s.invested, 10000);
  assert.equal(s.saved, 40800);    // income minus spending: the SIP is part of what was saved
  assert.equal(s.prevSpent, 15500);
  assert.ok(!s.categories.some(c => c.category === 'Investment'));
  assert.ok(!s.biggest.some(b => b.category === 'Investment'));
  assert.match(factsText(s, r, money), /INVESTED: Rs 10000/);
  // a period with only an investment still has something to show
  assert.equal(hasData(summarize({ expenses: [{ amount: 500, category: 'Investment', date: '2026-10-02' }] }, r)), true);
});

test('debts count every unsettled debt, not just ones created in the period', () => {
  const s = summarize(data, periodRange('month', today));
  assert.equal(s.debts.youOwe, 5000);
  assert.equal(s.debts.owedToYou, 2000);
  assert.equal(s.debts.activeCount, 2);
  assert.equal(s.debts.settledInPeriod, 1);
});

test('no income means no savings rate (instead of 0%)', () => {
  const s = summarize({ expenses: data.expenses }, periodRange('month', today));
  assert.equal(s.savingsRate, null);
  assert.equal(hasData(s), true);
  assert.equal(hasData(summarize({}, periodRange('month', today))), false);
});

test('facts for the AI carry numbers only (no descriptions or names)', () => {
  const withPrivate = {
    ...data,
    expenses: data.expenses.map(e => ({ ...e, description: 'secret note', notes: 'x' })),
    debts: data.debts.map(d => ({ ...d, person: 'Ravi' })),
  };
  const r = periodRange('month', today);
  const text = factsText(summarize(withPrivate, r), r, money);
  assert.match(text, /SPENT: Rs 19200 in 4 expenses/);
  assert.match(text, /user owes Rs 5000/);
  assert.doesNotMatch(text, /secret|Ravi/);
});

test('markdown: lists, headings, bold, and HTML is escaped', () => {
  const html = renderMarkdown('Based on your data:\n\n1. Cut **Shopping**\n2. Keep *rent*\n\n### Next\n- <script>alert(1)</script>');
  assert.equal(html, '<p>Based on your data:</p><ol><li>Cut <strong>Shopping</strong></li><li>Keep <em>rent</em></li></ol><h4>Next</h4><ul><li>&lt;script&gt;alert(1)&lt;/script&gt;</li></ul>');
});

test('the new Savings & Investments name is also counted as saved', () => {
  const r = periodRange('month', today);
  const s = summarize({ ...data, expenses: [...data.expenses, { amount: 4000, category: 'Savings & Investments', date: '2026-10-06' }] }, r);
  assert.equal(s.spent, 19200);
  assert.equal(s.invested, 4000);
});

// ── Analysis the Dashboard doesn't show ──
const oct = periodRange('month', today); // 1–21 Oct against 1–21 Sep
const octData = {
  expenses: [
    { amount: 1200, category: 'Food & Dining', date: '2026-10-03', payment: 'UPI', description: 'Dinner out' },   // Sat
    { amount: 300, category: 'Food & Dining', date: '2026-10-10', payment: 'UPI' },                               // Sat
    { amount: 18000, category: 'Home & Rent', date: '2026-10-05', payment: 'Net Banking', description: 'Rent', repeat: 'monthly' }, // Mon
    { amount: 5000, category: 'Shopping', date: '2026-10-07', payment: 'Credit Card', description: 'iPhone EMI', repeat: 'monthly', emiTotal: 6 }, // Wed
    { amount: 500, category: 'Food & Dining', date: '2026-09-06', payment: 'Cash' },
    { amount: 18000, category: 'Home & Rent', date: '2026-09-05', payment: 'Net Banking', repeat: 'monthly' },
    { amount: 2500, category: 'Travel', date: '2026-09-12', payment: 'UPI' },
  ],
  income: [{ amount: 85000, date: '2026-10-01' }, { amount: 80000, date: '2026-09-01' }],
};

test('compared with the same days last period: spending and income', () => {
  const s = summarize(octData, oct);
  assert.equal(s.spent, 24500);
  assert.equal(s.prevSpent, 21000);
  assert.equal(s.prevEarned, 80000);
  assert.equal(s.prevIncomeCount, 1);
});

test('what changed: biggest rises then biggest falls, a category gone to nothing counts', () => {
  const m = summarize(octData, oct).movers.map(x => [x.category, x.diff]);
  assert.deepEqual(m, [['Shopping', 5000], ['Food & Dining', 1000], ['Travel', -2500]]);
});

test('patterns: by weekday (Monday first), by payment method, fixed vs flexible', () => {
  const s = summarize(octData, oct);
  assert.deepEqual(s.weekdays.map(w => w.amount), [18000, 0, 5000, 0, 0, 1500, 0]);
  assert.deepEqual(s.payments.map(p => [p.name, p.amount]), [['Net Banking', 18000], ['Credit Card', 5000], ['UPI', 1500]]);
  assert.equal(s.fixed, 23000); // rent and the EMI
  assert.deepEqual(s.biggest[0], { category: 'Home & Rent', amount: 18000, date: '2026-10-05', description: 'Rent' });
});

test('the pie shows the biggest categories and folds the rest into Other', async () => {
  const { pieSlices } = await import('../assets/js/modules/insights-data.js');
  const cats = [['Food', 400], ['Travel', 300], ['Bills', 150], ['Health', 80], ['Fun', 40], ['Books', 30]].map(([category, amount]) => ({ category, amount }));
  const s = pieSlices(cats);
  assert.deepEqual(s.map(x => x.label), ['Food', 'Travel', 'Bills', 'Health', 'Other']);
  assert.equal(s[4].amount, 70);
  assert.equal(s[4].other, true);
  assert.equal(s[1].start, 40); // 400 of 1000 before it
  assert.equal(Math.round(s.reduce((t, x) => t + x.share, 0)), 100);
  // five or fewer: all shown; a single leftover keeps its own name
  assert.equal(pieSlices(cats.slice(0, 5)).length, 5);
  assert.equal(pieSlices(cats.slice(0, 6), 5).at(-1).label, 'Other');
  assert.deepEqual(pieSlices([{ category: 'Food', amount: 0 }]), []);
});
