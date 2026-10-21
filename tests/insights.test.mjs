// Run: node --test tests/ — Insights numbers, periods and markdown
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
