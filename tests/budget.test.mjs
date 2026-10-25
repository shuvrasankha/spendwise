// Run: node --test tests/*.test.mjs — the budget suggested from income: numbers worked out on the device,
// and any answer (the AI's or ours) checked before it fills the form
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetFacts, factsLines, suggestFromFacts, checkSuggestion, readReply } from '../assets/js/modules/budget-data.js';

const TODAY = '2026-10-25';
const exp = (date, category, amount, extra = {}) => ({ date, category, amount, description: 'secret note', ...extra });
const data = {
  income: [{ date: '2026-07-01', amount: 60000 }, { date: '2026-08-01', amount: 60000 }, { date: '2026-09-01', amount: 60000 }, { date: '2026-10-01', amount: 99999 }],
  expenses: [
    ...['07', '08', '09'].flatMap(m => [
      exp(`2026-${m}-02`, 'Home & Rent', 15000, { repeat: 'monthly' }),
      exp(`2026-${m}-10`, 'Food & Dining', 12000),
      exp(`2026-${m}-12`, 'Shopping', 15000),
      exp(`2026-${m}-15`, 'Groceries', 8000),
      exp(`2026-${m}-20`, 'Savings & Investments', 5000),
    ]),
    exp('2026-10-03', 'Shopping', 50000), // this month: not counted
  ],
  goals: [{ name: 'Goa', target: 30000, saved: 0, by: '2027-02' }],
};

test('facts are monthly averages of the last three whole months, investments apart', () => {
  const f = budgetFacts(data, TODAY);
  assert.equal(f.months, 3);
  assert.equal(f.income, 60000);
  assert.equal(f.spent, 50000);
  assert.equal(f.invested, 5000);
  assert.deepEqual(f.cats, { 'Home & Rent': 15000, 'Food & Dining': 12000, Shopping: 15000, Groceries: 8000 });
  assert.deepEqual(f.fixed, { 'Home & Rent': 15000 });
  assert.equal(f.goalsMonthly, 6000); // 30000 over Oct–Feb
});

test('what the AI sees is numbers only: no descriptions or names', () => {
  const text = factsLines(budgetFacts(data, TODAY), '₹');
  assert.match(text, /Income: ₹60000/);
  assert.match(text, /Home & Rent: ₹15000 \(of which ₹15000 repeating/);
  assert.doesNotMatch(text, /secret|Goa/);
});

test('no income in the last three months: no suggestion', () => {
  assert.equal(budgetFacts({ expenses: data.expenses, income: [{ date: '2026-10-01', amount: 5 }] }, TODAY), null);
});

test('the on-device plan keeps a fifth of income, trimming flexible spending, never the bills', () => {
  const s = suggestFromFacts(budgetFacts(data, TODAY));
  assert.equal(s.total, 48000); // 60000 − 20%
  assert.equal(s.saves, 12000);
  assert.equal(s.cats['Home & Rent'], 15000);
  assert.ok(s.cats.Shopping < 15000 && s.cats['Food & Dining'] < 12000);
  assert.ok(Object.values(s.cats).reduce((a, b) => a + b, 0) <= s.total);
});

test("the AI's answer is checked: unknown categories dropped, bills kept, total within income", () => {
  const f = budgetFacts(data, TODAY);
  const s = checkSuggestion({ total: 90000, cats: { 'Home & Rent': 9000, Shopping: 8020, Crypto: 5000, Health: 3000 }, tip: 'Cut  shopping.' }, f);
  assert.deepEqual(s.cats, { 'Home & Rent': 15000, Shopping: 8100 }); // rent not below its bill; Health had no spending
  assert.equal(s.total, 60000);
  assert.equal(s.tip, 'Cut shopping.');
  assert.equal(checkSuggestion({ total: 'lots' }, f), null);
});

test('reads JSON from a chatty reply', () => {
  assert.deepEqual(readReply('Sure! ```json\n{"total": 40000, "cats": {}}\n```'), { total: 40000, cats: {} });
  assert.equal(readReply('no idea'), null);
});
