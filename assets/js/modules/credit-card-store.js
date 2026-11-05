import { db } from '../config/firebase.js';
import {
  collection, doc, getDocs, getDoc, query, where, setDoc, serverTimestamp, runTransaction
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { normalizeCreditCard, validateCreditCard, isValidDateKey, moneyFromCents, moneyToCents } from './credit-card-data.js';

const CACHE = 'spendwise_credit_cards_';
const TRANSACTION_CACHE = 'spendwise_credit_card_transactions_';

function readCache(uid) {
  try {
    const cards = JSON.parse(localStorage.getItem(CACHE + uid) || '[]');
    return Array.isArray(cards) ? cards : [];
  } catch (error) {
    console.error('Could not read cached credit cards:', error);
    return [];
  }
}

function writeCache(uid, cards) {
  try {
    localStorage.setItem(CACHE + uid, JSON.stringify(cards));
  } catch (error) {
    console.error('Could not cache credit cards:', error);
  }
}

function readTransactionCache(uid) {
  try {
    const records = JSON.parse(localStorage.getItem(TRANSACTION_CACHE + uid) || 'null');
    return records && Array.isArray(records.expenses) && Array.isArray(records.refunds) && Array.isArray(records.payments)
      ? records
      : { expenses: [], refunds: [], payments: [] };
  } catch (error) {
    console.error('Could not read cached credit-card transactions:', error);
    return { expenses: [], refunds: [], payments: [] };
  }
}

function writeTransactionCache(uid, records) {
  try {
    localStorage.setItem(TRANSACTION_CACHE + uid, JSON.stringify(records));
  } catch (error) {
    console.error('Could not cache credit-card transactions:', error);
  }
}

function pendingCards(uid) {
  return (window.getOfflineQueueItems?.() || [])
    .filter(item => item.type === 'creditCard' && item.data?.uid === uid)
    .map(item => ({ id: item.docId || item.id, ...item.data }));
}

export async function getCreditCardTransactions(uid) {
  if (!uid) throw new Error('A signed-in user is required to load credit-card transactions.');
  try {
    const collections = ['expenses', 'cardRefunds', 'cardPayments'];
    const snapshots = await Promise.all(collections.map(name =>
      getDocs(query(collection(db, name), where('uid', '==', uid)))
    ));
    const [expenses, refunds, payments] = snapshots.map(snap => snap.docs.map(item => ({ id: item.id, ...item.data() })));
    const records = {
      expenses: expenses.filter(item => item.payment === 'Credit Card' && item.creditCardId),
      refunds,
      payments,
    };
    writeTransactionCache(uid, records);
    return records;
  } catch (error) {
    if (navigator.onLine !== false) throw error;
    return readTransactionCache(uid);
  }
}

export async function getCreditCards(uid) {
  if (!uid) throw new Error('A signed-in user is required to load credit cards.');
  try {
    const snap = await getDocs(query(collection(db, 'creditCards'), where('uid', '==', uid)));
    const cards = snap.docs.map(card => ({ id: card.id, ...card.data() }));
    const byId = new Map(cards.map(card => [card.id, card]));
    for (const card of pendingCards(uid)) byId.set(card.id, card);
    const result = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
    writeCache(uid, result);
    return result;
  } catch (error) {
    if (navigator.onLine !== false) throw error;
    const byId = new Map(readCache(uid).map(card => [card.id, card]));
    for (const card of pendingCards(uid)) byId.set(card.id, card);
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

export async function saveCreditCard(uid, input, cardId = '') {
  const error = validateCreditCard(input);
  if (!uid) throw new Error('A signed-in user is required to save a credit card.');
  if (error) throw new Error(error);
  const id = cardId || doc(collection(db, 'creditCards')).id;
  const existing = readCache(uid).find(card => card.id === id);
  const card = {
    ...normalizeCreditCard(input),
    uid,
    createdAt: existing?.createdAt || serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  if (navigator.onLine === false) {
    if (!window.addToOfflineQueue) throw new Error('Offline saving is unavailable. Try again when online.');
    window.addToOfflineQueue('creditCard', card, id);
  } else {
    await setDoc(doc(db, 'creditCards', id), card);
  }
  const cards = readCache(uid).filter(item => item.id !== id).concat({ id, ...card });
  writeCache(uid, cards);
  return { id, ...card };
}

export async function createCardRefund(uid, input, refundId = doc(collection(db, 'cardRefunds')).id) {
  if (!uid) throw new Error('A signed-in user is required to save a refund.');
  const refund = {
    uid,
    creditCardId: input.creditCardId,
    originalExpenseId: input.originalExpenseId,
    amount: moneyFromCents(moneyToCents(input.amount)),
    refundDate: input.refundDate,
    description: String(input.description || '').trim().slice(0, 200),
    createdAt: serverTimestamp(),
  };
  if (!refund.creditCardId || !refund.originalExpenseId || !Number.isFinite(refund.amount) || refund.amount <= 0
    || !isValidDateKey(refund.refundDate)) {
    throw new Error('Enter a valid credit-card refund.');
  }
  const id = refundId;
  if (!id) throw new Error('A valid credit-card refund ID is required.');
  if (navigator.onLine === false) {
    if (!window.addToOfflineQueue) throw new Error('Offline saving is unavailable. Try again when online.');
    window.addToOfflineQueue('cardRefund', refund, id);
  } else {
    await runTransaction(db, async transaction => {
      const refundRef = doc(db, 'cardRefunds', id);
      const expenseRef = doc(db, 'expenses', refund.originalExpenseId);
      const existing = await transaction.get(refundRef);
      if (existing.exists()) return;
      const purchase = await transaction.get(expenseRef);
      if (!purchase.exists() || purchase.data().uid !== uid
        || purchase.data().payment !== 'Credit Card' || purchase.data().creditCardId !== refund.creditCardId) {
        throw new Error('The original credit-card purchase could not be found.');
      }
      const currentRefunded = moneyToCents(purchase.data().refundedTotal || 0);
      const purchaseAmount = moneyToCents(purchase.data().amount);
      const refundAmount = moneyToCents(refund.amount);
      if (currentRefunded + refundAmount > purchaseAmount) {
        throw new Error('Refund exceeds the remaining amount for this purchase.');
      }
      transaction.update(expenseRef, { refundedTotal: moneyFromCents(currentRefunded + refundAmount) });
      transaction.set(refundRef, refund);
    });
  }
  return { id, ...refund };
}

export async function createCardPayment(uid, id, payment) {
  if (!uid) throw new Error('A signed-in user is required to save a payment.');
  if (!id || !Number.isFinite(Number(payment.amount)) || Number(payment.amount) <= 0
    || !isValidDateKey(payment.paymentDate)) {
    throw new Error('Enter a valid full card payment.');
  }
  const data = { ...payment, uid, amount: Number(payment.amount), idempotencyKey: id, createdAt: serverTimestamp() };
  if (navigator.onLine === false) {
    if (!window.addToOfflineQueue) throw new Error('Offline saving is unavailable. Try again when online.');
    window.addToOfflineQueue('cardPayment', data, id);
    return { id, ...data, pending: true };
  }
  const ref = doc(db, 'cardPayments', id);
  const existing = await getDoc(ref);
  if (existing.exists()) return { id, ...existing.data() };
  await runTransaction(db, async transaction => {
    const existing = await transaction.get(ref);
    if (!existing.exists()) transaction.set(ref, data);
  });
  return { id, ...data };
}
