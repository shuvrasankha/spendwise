// budget-data.js — "Suggest from my income" in the Monthly budget dialog (budget.js).
// The last three months are added up here on the device; the AI gets only those numbers (monthly
// income, spending per category, bills, goals), never an entry, description or name. Whatever it
// answers is checked against the same numbers before it reaches the form, and if it can't be asked,
// suggestFromFacts() gives a plan worked out on the device instead.
import { EXPENSE_CATEGORIES, isSpending, normalizeCategory, goalPace, addMonths } from '../utils/helpers.js';

const LOOKBACK = 3;          // whole months before this one
const SAVE_TARGET = 0.2;     // aim to keep a fifth of income when spending allows
const INVEST = 'Savings & Investments';
export const BUDGET_CATEGORIES = EXPENSE_CATEGORIES.filter(c => c !== INVEST); // what a budget limits

const round = (n, step = 100) => Math.round(n / step) * step;
const roundUp = (n, step = 100) => Math.ceil(n / step) * step;

// Monthly averages over the last three whole months that have any entries:
// { months, income, spent, invested, cats: { category: avg }, fixed: { category: avg }, goalsMonthly }
// null when none of those months has income (the suggestion is based on it).
export function budgetFacts({ expenses = [], income = [], goals = [] }, today) {
  const month = today.slice(0, 7);
  const months = Array.from({ length: LOOKBACK }, (_, i) => addMonths(month, -(i + 1)));
  const inMonth = m => r => (r.date || '').slice(0, 7) === m;
  const active = months.filter(m => expenses.some(inMonth(m)) || income.some(inMonth(m)));
  const incomeMonths = active.filter(m => income.some(inMonth(m)));
  if (!incomeMonths.length) return null;
  const n = active.length;
  const sum = list => list.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const recent = expenses.filter(e => active.includes((e.date || '').slice(0, 7)));
  const spending = recent.filter(isSpending);
  const cats = {}, fixed = {};
  spending.forEach(e => {
    const c = normalizeCategory(e.category);
    cats[c] = (cats[c] || 0) + e.amount / n;
    if (e.repeat === 'monthly' || e.emiTotal > 0) fixed[c] = (fixed[c] || 0) + e.amount / n;
  });
  const goalsMonthly = goals.reduce((s, g) => {
    if (!(g.target > 0) || !/^\d{4}-\d{2}$/.test(g.by || '')) return s;
    const p = goalPace({ target: g.target, saved: g.saved || 0, by: g.by }, today);
    return s + (p.state === 'on' ? p.monthly : 0);
  }, 0);
  return {
    months: n,
    income: sum(income.filter(i => active.includes((i.date || '').slice(0, 7)))) / n,
    spent: sum(spending) / n,
    invested: sum(recent.filter(e => !isSpending(e))) / n,
    cats, fixed, goalsMonthly,
  };
}

// The numbers the AI sees, as plain lines (categories are the app's own fixed names)
export function factsLines(f, symbol) {
  const m = v => `${symbol}${Math.round(v)}`;
  const byCat = BUDGET_CATEGORIES.filter(c => f.cats[c] > 0)
    .map(c => `- ${c}: ${m(f.cats[c])}${f.fixed[c] ? ` (of which ${m(f.fixed[c])} repeating bills/EMIs)` : ''}`);
  return [
    `Monthly averages over the last ${f.months} ${f.months === 1 ? 'month' : 'months'}:`,
    `Income: ${m(f.income)}`,
    `Spending: ${m(f.spent)}`,
    `Invested: ${m(f.invested)}`,
    f.goalsMonthly ? `Savings goals need: ${m(f.goalsMonthly)} a month` : 'Savings goals: none',
    'Spending by category:',
    ...(byCat.length ? byCat : ['- none']),
  ].join('\n');
}

export function budgetPrompt(f, currency) {
  return {
    system: `You set a monthly spending budget for a SpendWise user from their own numbers. Amounts are in ${currency.code} (${currency.symbol}).
Rules:
- The total must leave money over from income: aim to keep at least 20% of income, more if savings goals need it, but never cut a category below its repeating bills/EMIs.
- Cut flexible categories (food, shopping, entertainment, travel) before essentials (groceries, bills, rent, health, education).
- Only use categories from this list: ${BUDGET_CATEGORIES.join(', ')}. Leave out categories with no spending.
- Whole numbers only. Use only the numbers given; never invent income or spending.
Reply with ONLY one JSON object, no other text:
{"total":<number>,"cats":{"<category>":<number>},"tip":"<one sentence, under 25 words, on where the saving comes from>"}`,
    user: factsLines(f, currency.symbol),
  };
}

// A plan worked out on the device: spending as it was, trimmed toward keeping a fifth of income
// (or what goals need), the trim taken from flexible spending only, never below the bills.
export function suggestFromFacts(f) {
  const keep = Math.max(SAVE_TARGET * f.income, f.goalsMonthly);
  const fixedTotal = Object.values(f.fixed).reduce((s, v) => s + v, 0);
  const target = Math.max(Math.min(f.spent, f.income - keep), fixedTotal);
  const flexible = f.spent - fixedTotal;
  const scale = flexible > 0 ? Math.max(target - fixedTotal, 0) / flexible : 1;
  const cats = {};
  BUDGET_CATEGORIES.forEach(c => {
    if (!(f.cats[c] > 0)) return;
    const fixed = f.fixed[c] || 0;
    const v = roundUp(fixed) + Math.floor(((f.cats[c] - fixed) * scale) / 100) * 100; // the trimmed part rounds down, so the categories fit the total
    if (v > 0) cats[c] = v;
  });
  return checkSuggestion({ total: target, cats }, f);
}

// Makes any suggestion (the AI's or ours) safe to show: known categories only, whole hundreds, no
// category below its bills, and a total that covers the categories and stays within income.
// null when it has nothing usable.
export function checkSuggestion(raw, f) {
  if (!raw || typeof raw !== 'object') return null;
  const cats = {};
  const given = raw.cats && typeof raw.cats === 'object' ? raw.cats : {};
  Object.entries(given).forEach(([name, v]) => {
    const c = normalizeCategory(name);
    const n = Number(v);
    if (!BUDGET_CATEGORIES.includes(c) || !(n > 0) || !(f.cats[c] > 0)) return;
    cats[c] = Math.max(roundUp(n), roundUp(f.fixed[c] || 0));
  });
  const catSum = Object.values(cats).reduce((s, v) => s + v, 0);
  let total = Number(raw.total);
  if (!(total > 0)) total = catSum;
  total = Math.max(round(total), catSum);
  if (!(total > 0)) return null;
  if (total > f.income) total = Math.max(Math.floor(f.income / 100) * 100, catSum); // over income only when the bills are
  const tip = typeof raw.tip === 'string' ? raw.tip.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
  return { total, cats, tip, saves: f.income - total };
}

// The AI's reply as JSON (it may wrap it in a code block or add words around it)
export function readReply(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
