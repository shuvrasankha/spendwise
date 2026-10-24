// Run: node --test tests/*.test.mjs — "Ask about your spending": question → search → answer, on the device
process.env.TZ = 'Asia/Kolkata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessSpec, readSpec, runQuery, answerFor, periodText, askPrompt } from '../assets/js/modules/ask-data.js';

const today = '2026-10-24'; // a Saturday
const money = n => `₹${Math.round(n).toLocaleString('en-IN')}`;
const expenses = [
  { amount: 1299, category: 'Shopping', description: 'Amazon - shoes', date: '2026-09-04', payment: 'UPI' },
  { amount: 3021, category: 'Shopping', description: 'Phone case', notes: 'from amazon', date: '2026-09-20', payment: 'Card' },
  { amount: 499, category: 'Shopping', description: 'Amazon Prime', date: '2026-10-02', payment: 'Card' },
  { amount: 420, category: 'Food & Dining', description: 'Swiggy', date: '2026-10-22', payment: 'UPI', tags: ['goa2026'] },
  { amount: 800, category: 'Food & Dining', description: 'Dinner', date: '2026-10-19', payment: 'Cash' },
  { amount: 5000, category: 'Savings & Investments', description: 'SIP', date: '2026-10-05' },
];
const income = [{ amount: 85000, source: 'Salary', date: '2026-10-01' }, { amount: 12000, source: 'Freelance', notes: 'logo job', date: '2026-09-15' }];
const ask = q => { const spec = guessSpec(q, today); return { spec, result: runQuery(spec, { expenses, income }), answer: answerFor(spec, runQuery(spec, { expenses, income }), money, today) }; };

test('the question as asked: "how much I send in amazon last month"', () => {
  const { spec, result, answer } = ask('how much I send in amazon last month');
  assert.deepEqual([spec.text, spec.from, spec.to, spec.measure, spec.type], ['amazon', '2026-09-01', '2026-09-30', 'total', 'expense']);
  assert.equal(result.count, 2); // the shoes, and the case whose note says amazon; not October's Prime
  assert.deepEqual(answer, { headline: '₹4,320', sentence: 'Spent on Amazon in September · 2 expenses.' });
});

test('dates: this month so far, this week from Monday, a month name, a year, last N days', () => {
  assert.deepEqual([guessSpec('food this month', today).from, guessSpec('food this month', today).to], ['2026-10-01', today]);
  assert.deepEqual([guessSpec('spent this week', today).from], ['2026-10-19']);
  const aug = guessSpec('biggest expense in august', today);
  assert.deepEqual([aug.from, aug.to, aug.measure], ['2026-08-01', '2026-08-31', 'biggest']);
  assert.deepEqual([guessSpec('rent in november', today).from], ['2025-11-01']); // the most recent past November
  assert.deepEqual([guessSpec('total in 2025', today).from, guessSpec('total in 2025', today).to], ['2025-01-01', '2025-12-31']);
  assert.equal(guessSpec('uber last 7 days', today).from, '2026-10-18');
  assert.equal(guessSpec('all my shopping', today).from, null);
});

test('categories, brands, tags, counts and income', () => {
  assert.deepEqual(guessSpec('food last week', today).categories, ['Food & Dining']);
  assert.deepEqual([guessSpec('swiggy this month', today).text, guessSpec('swiggy this month', today).categories], ['swiggy', []]); // the brand, not all food
  const goa = ask('#goa2026 total');
  assert.deepEqual([goa.spec.tag, goa.result.total], ['goa2026', 420]);
  assert.equal(ask('how many times did I order food this month').answer.headline, '2');
  const salary = ask('how much salary did I get this month');
  assert.deepEqual([salary.spec.type, salary.spec.text, salary.result.total], ['income', 'salary', 85000]);
  assert.equal(ask('freelance income in september').result.total, 12000);
});

test('spending leaves investments out unless they are asked for', () => {
  assert.equal(ask('total spent this month').result.total, 499 + 420 + 800);
  assert.equal(ask('how much did I invest this month').result.total, 5000);
});

test('nothing found says so, in the same words', () => {
  assert.deepEqual(ask('netflix last month').answer, { headline: '₹0', sentence: 'Nothing on Netflix in September.' });
});

test("the AI's reply is checked: JSON pulled out, unknown values dropped, dates put in order", () => {
  const spec = readSpec('Sure! {"type":"expense","text":"Amazon","tag":null,"categories":["Shopping","Crypto"],"from":"2026-09-30","to":"2026-09-01","measure":"sum"}');
  assert.deepEqual(spec, { type: 'expense', text: 'amazon', tag: null, categories: ['Shopping'], from: '2026-09-01', to: '2026-09-30', measure: 'total' });
  assert.equal(readSpec('I could not understand that.'), null);
  assert.ok(askPrompt(today).includes('Saturday, 2026-10-24'));
});

test('short dates match the rest of the app', () => {
  assert.equal(answerFor(guessSpec('biggest expense in september', today), runQuery(guessSpec('biggest expense in september', today), { expenses, income }), money, today).sentence,
    'Biggest in September: Phone case, 20 Sep.');
  assert.equal(periodText('2025-12-03', '2026-01-05', today), 'from 3 Dec 2025 to 5 Jan');
});

test('period wording', () => {
  assert.equal(periodText('2026-09-01', '2026-09-30', today), 'in September');
  assert.equal(periodText('2026-10-01', today, today), 'in October so far');
  assert.equal(periodText('2025-11-01', '2025-11-30', today), 'in November 2025');
  assert.equal(periodText('2025-01-01', '2025-12-31', today), 'in 2025');
  assert.equal(periodText('2026-01-01', today, today), 'this year');
  assert.equal(periodText(today, today, today), 'on 24 Oct');
  assert.equal(periodText(null, null, today), 'in all your entries');
});
