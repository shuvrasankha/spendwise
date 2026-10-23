// Run: node --test tests/ — the money score weighs only the factors that have data
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { financeScore } from '../assets/js/utils/helpers.js';

const base = { income: 1000, spent: 800, invested: 100, budget: 0, monthShare: 1, owe: 0, goals: [] };

test('no income means no score', () => {
  assert.equal(financeScore({ ...base, income: 0 }), null);
});

test('saving 20% with no debt is a perfect score', () => {
  assert.deepEqual(financeScore(base), {
    score: 100, label: 'Great', tip: 'Everything is on track this month',
    parts: [{ name: 'Saving', value: 1 }, { name: 'Investing', value: 1 }, { name: 'Debt', value: 1 }],
  });
});

test('overspending and debt drag it down and name the weakest factor', () => {
  const s = financeScore({ ...base, spent: 1200, owe: 500 });
  assert.equal(s.score, 33); // savings 0/40, investing 15/15, debt 10/20 → 25/75
  assert.equal(s.tip, 'Try to keep 20% of your income unspent');
});

test('budget pace: on pace is full, projected 50% over is zero', () => {
  assert.equal(financeScore({ ...base, budget: 1600, spent: 800, monthShare: 0.5 }).score, 100);
  const over = financeScore({ ...base, budget: 1000, spent: 750, monthShare: 0.5 }); // projects 1500
  assert.equal(over.score, Math.round((40 + 15 + 20) / 105 * 100));
  assert.equal(over.tip, 'Spending is running ahead of your budget');
});

test('late goals count against it', () => {
  assert.equal(financeScore({ ...base, goals: [{ state: 'late' }, { state: 'on' }] }).score, 94); // 80/85
});

test('investing less than 10% of income costs points', () => {
  const s = financeScore({ ...base, invested: 50 });
  assert.equal(s.score, 90); // investing 7.5/15 → 67.5/75 → 90
  assert.equal(s.tip, 'Putting 10% of your income into investments will lift your score');
});
