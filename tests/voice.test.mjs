// Run: node --test tests/*.test.mjs — what the AI reads from a voice or typed command keeps every field the Add forms have
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanEntry, parseTags, emiCount } from '../assets/js/modules/voice-data.js';

const TODAY = '2026-10-25';

test('an expense keeps its card, notes, tags and monthly repeat', () => {
  const e = cleanEntry({ type: 'expense', amount: '3500', category: 'Shopping', payment: 'Credit Card', cardName: 'HDFC Millennia',
    description: 'Phone EMI', notes: 'No-cost', tags: ['#gadgets', 'phone'], repeat: true, emiTotal: 12 }, TODAY);
  assert.deepEqual(e, { type: 'expense', amount: 3500, date: TODAY, notes: 'No-cost', category: 'Shopping', payment: 'Credit Card',
    cardName: 'HDFC Millennia', description: 'Phone EMI', tags: ['gadgets', 'phone'], emiTotal: 12, repeat: true });
});

test('what the AI leaves out gets the Add form defaults', () => {
  const e = cleanEntry({ type: 'expense', amount: 80, category: 'Rent', description: '' }, TODAY);
  assert.equal(e.category, 'Home & Rent');
  assert.equal(e.payment, 'UPI');
  assert.equal(e.description, '-');
  assert.deepEqual(e.tags, []);
  assert.equal(e.repeat, false);
  assert.equal(e.emiTotal, 0);
});

test('a card name only goes with a card payment; an EMI count makes it repeat', () => {
  assert.equal(cleanEntry({ type: 'expense', amount: 5, payment: 'UPI', cardName: 'SBI' }, TODAY).cardName, '');
  assert.equal(cleanEntry({ type: 'expense', amount: 5, emiTotal: 6 }, TODAY).repeat, true);
  assert.equal(cleanEntry({ type: 'expense', amount: 5, repeat: true, emiTotal: 1 }, TODAY).emiTotal, 0);
});

test('income keeps its bank and notes', () => {
  const e = cleanEntry({ type: 'income', amount: 20000, source: 'Freelance', paymentType: 'Online', bank: 'SBI', notes: 'Invoice 42', date: '2026-10-20' }, TODAY);
  assert.deepEqual(e, { type: 'income', amount: 20000, date: '2026-10-20', notes: 'Invoice 42', source: 'Freelance', paymentType: 'Online', bank: 'SBI' });
});

test('a debt keeps a valid email, lowercased, to share it', () => {
  assert.equal(cleanEntry({ type: 'debt', amount: 500, person: 'Ravi', email: 'Ravi@Gmail.com' }, TODAY).email, 'ravi@gmail.com');
  assert.equal(cleanEntry({ type: 'debt', amount: 500, person: 'Ravi', email: 'ravi at gmail' }, TODAY).email, '');
});

test('nothing usable: no entry', () => {
  assert.equal(cleanEntry({ type: 'expense', amount: 0 }, TODAY), null);
  assert.equal(cleanEntry({ type: 'none' }, TODAY), null);
});

test('tags and EMI counts', () => {
  assert.deepEqual(parseTags('#goa2026, wedding  goa2026'), ['goa2026', 'wedding']);
  assert.equal(emiCount('12'), 12);
  assert.equal(emiCount('1.5'), 0);
  assert.equal(emiCount(''), 0);
});
