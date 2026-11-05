import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCreditCard, normalizeCreditCard, statementPeriodFor, currentStatementPeriod,
  refundRemaining, cardOutstanding, statementAmount, cardPaymentId, cardRefundId, refundExpenseRow,
} from '../assets/js/modules/credit-card-data.js';

test('card validation requires only name and issuer and validates optional fields', () => {
  assert.equal(validateCreditCard({ name: 'Daily', issuer: 'ABC' }), '');
  assert.deepEqual(normalizeCreditCard({ name: ' Daily ', issuer: ' ABC ', last4: '', creditLimit: '', statementDay: '', dueDay: '' }), {
    name: 'Daily', issuer: 'ABC', network: '', last4: '', active: true,
  });
  assert.match(validateCreditCard({ name: 'Card', issuer: 'Bank', last4: '123' }), /four numbers/);
  assert.match(validateCreditCard({ name: 'Card', issuer: 'Bank', creditLimit: -1 }), /non-negative/);
  assert.match(validateCreditCard({ name: 'Card', issuer: 'Bank', statementDay: 32 }), /closing day/);
  assert.match(validateCreditCard({ name: 'Card', issuer: 'Bank', dueDay: 2.5 }), /due day/);
  assert.match(validateCreditCard({ issuer: 'Bank' }), /card name/);
  assert.match(validateCreditCard({ name: 'Card' }), /issuer/);
});

test('statement periods include the closing day, clamp short months, and roll across years', () => {
  assert.deepEqual(statementPeriodFor('2026-03-15', 15), {
    start: '2026-02-16', end: '2026-03-15', id: '2026-02-16_2026-03-15',
  });
  assert.deepEqual(statementPeriodFor('2026-03-16', 15), {
    start: '2026-03-16', end: '2026-04-15', id: '2026-03-16_2026-04-15',
  });
  assert.deepEqual(statementPeriodFor('2024-02-29', 31), {
    start: '2024-02-01', end: '2024-02-29', id: '2024-02-01_2024-02-29',
  });
  assert.deepEqual(currentStatementPeriod('2026-01-03', 31), {
    start: '2025-12-01', end: '2025-12-31', id: '2025-12-01_2025-12-31',
  });
  assert.equal(statementPeriodFor('2026-02-30', 15), null);
});

test('statement amount, outstanding and refunds count only against their card and period', () => {
  const expenses = [
    { id: 'a', creditCardId: 'one', date: '2026-11-02', amount: 500 },
    { id: 'b', creditCardId: 'one', date: '2026-11-16', amount: 900 },
    { id: 'c', creditCardId: 'two', date: '2026-11-03', amount: 200 },
  ];
  const refunds = [
    { id: 'r1', creditCardId: 'one', originalExpenseId: 'a', refundDate: '2026-11-08', amount: 100 },
    { id: 'r2', creditCardId: 'one', originalExpenseId: 'b', refundDate: '2026-11-20', amount: 50 },
  ];
  const payments = [{ id: 'p1', creditCardId: 'one', statementId: '2026-10-16_2026-11-15', amount: 400 }];
  const period = { start: '2026-10-16', end: '2026-11-15', id: '2026-10-16_2026-11-15' };

  assert.equal(statementAmount('one', period, expenses, refunds, payments), 0);
  assert.equal(cardOutstanding('one', expenses, refunds, payments), 850);
  assert.equal(cardOutstanding('two', expenses, refunds, payments), 200);
  assert.equal(refundRemaining(expenses[0], refunds), 400);
});

test('refund balances use cents without rejecting valid decimal refunds', () => {
  const purchase = { id: 'decimal', amount: 0.3, creditCardId: 'one' };
  const refunds = [
    { originalExpenseId: 'decimal', creditCardId: 'one', amount: 0.1 },
    { originalExpenseId: 'decimal', creditCardId: 'one', amount: 0.2 },
  ];
  assert.equal(refundRemaining(purchase, refunds), 0);
  assert.equal(cardOutstanding('one', [{ creditCardId: 'one', amount: 0.1 }, { creditCardId: 'one', amount: 0.2 }], [], [
    { creditCardId: 'one', amount: 0.3 },
  ]), 0);
});

test('stable payment/refund IDs and refund rows preserve a separate negative transaction', () => {
  const tx = [{ id: 'purchase', amount: 300, date: '2026-11-01' }];
  assert.equal(cardPaymentId('card-1', 'cycle', tx), cardPaymentId('card-1', 'cycle', tx));
  const refund = { creditCardId: 'card-1', originalExpenseId: 'purchase', refundDate: '2026-11-08', amount: 40, description: 'Returned' };
  assert.equal(cardRefundId(refund), cardRefundId(refund));
  assert.deepEqual(refundExpenseRow({ id: 'r', ...refund }, { id: 'purchase', category: 'Shopping', description: 'Headphones' }), {
    id: 'refund-r', transactionType: 'refund', originalExpenseId: 'purchase', amount: -40,
    category: 'Shopping', date: '2026-11-08', payment: 'Credit Card', creditCardId: 'card-1',
    cardName: '', description: 'Returned', notes: '', tags: [],
  });
});
