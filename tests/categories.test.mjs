// Run: node --test tests/ — merged expense categories
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXPENSE_CATEGORIES, CATEGORY_ALIASES, normalizeCategory, isSpending } from '../assets/js/utils/helpers.js';

test('older names map to the merged categories', () => {
  assert.equal(normalizeCategory('Subscription'), 'Bills & Utilities');
  assert.equal(normalizeCategory('Personal Care'), 'Shopping');
  assert.equal(normalizeCategory('Gifts'), 'Other');
  assert.equal(normalizeCategory('Rent'), 'Home & Rent');
  assert.equal(normalizeCategory('Investment'), 'Savings & Investments');
});

test('current names, unknown names and blanks', () => {
  assert.equal(normalizeCategory('Groceries'), 'Groceries');
  assert.equal(normalizeCategory('Pets'), 'Pets'); // kept as typed, never dropped
  assert.equal(normalizeCategory(''), 'Other');
  assert.equal(normalizeCategory(undefined), 'Other');
});

test('every alias points at a category the form offers', () => {
  assert.equal(EXPENSE_CATEGORIES.length, 12);
  for (const to of Object.values(CATEGORY_ALIASES)) assert.ok(EXPENSE_CATEGORIES.includes(to), to);
});

test('savings are not spending, under the old name or the new', () => {
  assert.equal(isSpending({ category: 'Investment' }), false);
  assert.equal(isSpending({ category: 'Savings & Investments' }), false);
  assert.equal(isSpending({ category: 'Rent' }), true);
});

test('every category tells the AI what it covers, and fuel is Transport', async () => {
  const { CATEGORY_EXAMPLES, categoryGuide } = await import('../assets/js/utils/helpers.js');
  for (const c of EXPENSE_CATEGORIES) assert.ok(CATEGORY_EXAMPLES[c], c);
  assert.match(categoryGuide(), /^- Transport: petrol, diesel/m);
});
