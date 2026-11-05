import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./stub-loader.mjs', import.meta.url);

const {
  createCardPayment, createCardRefund, getCreditCardTransactions, getCreditCards, saveCreditCard,
} = await import('../assets/js/modules/credit-card-store.js');

const records = new Map();
const key = ref => `${ref.coll}/${ref.id}`;
const copy = value => structuredClone(value);

function installFirebase() {
  let nextId = 0;
  globalThis.__firebase = {
    autoId: () => `AUTO-${++nextId}`,
    setDoc: async (ref, data) => records.set(key(ref), copy(data)),
    getDoc: async ref => {
      const data = records.get(key(ref));
      return { exists: () => data !== undefined, data: () => data && copy(data) };
    },
    getDocs: async ref => ({
      docs: [...records.entries()]
        .filter(([recordKey]) => recordKey.startsWith(`${ref.coll}/`))
        .map(([recordKey, data]) => ({
          id: recordKey.slice(ref.coll.length + 1),
          data: () => copy(data),
        })),
    }),
    runTransaction: async (_db, callback) => {
      const writes = [];
      const transaction = {
        get: async ref => {
          const data = records.get(key(ref));
          return { exists: () => data !== undefined, data: () => data && copy(data) };
        },
        set: (ref, data) => writes.push({ kind: 'set', ref, data }),
        update: (ref, data) => writes.push({ kind: 'update', ref, data }),
      };
      const result = await callback(transaction);
      for (const write of writes) {
        if (write.kind === 'set') records.set(key(write.ref), copy(write.data));
        else records.set(key(write.ref), { ...records.get(key(write.ref)), ...copy(write.data) });
      }
      return result;
    },
  };
}

beforeEach(() => {
  records.clear();
  const queue = [];
  globalThis.localStorage = {
    values: new Map(),
    getItem(name) { return this.values.get(name) || null; },
    setItem(name, value) { this.values.set(name, value); },
  };
  globalThis.window = {
    getOfflineQueueItems: () => queue,
    addToOfflineQueue: (type, data, docId) => queue.push({ type, data, docId }),
    queue,
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
  installFirebase();
});

test('card saving validates input, persists online, and merges pending offline cards into reads', async () => {
  await assert.rejects(saveCreditCard('user-1', { issuer: 'Bank' }), /card name/i);
  const saved = await saveCreditCard('user-1', { name: ' Travel ', issuer: ' Bank ' });
  assert.equal(saved.id, 'AUTO-1');
  assert.deepEqual((await getCreditCards('user-1')).map(card => card.name), ['Travel']);

  navigator.onLine = false;
  const queued = await saveCreditCard('user-1', { name: 'Backup', issuer: 'Credit Union' });
  assert.equal(queued.id, 'AUTO-2');
  assert.equal(window.queue.length, 1);
  assert.deepEqual((await getCreditCards('user-1')).map(card => card.name), ['Backup', 'Travel']);
});

test('refund transactions are idempotent and reject amounts above the remaining purchase value', async () => {
  records.set('expenses/purchase-1', {
    uid: 'user-1', payment: 'Credit Card', creditCardId: 'card-1', amount: 100, refundedTotal: 0,
  });
  const input = {
    creditCardId: 'card-1', originalExpenseId: 'purchase-1', amount: 60,
    refundDate: '2026-04-12', description: 'Returned item',
  };

  const first = await createCardRefund('user-1', input);
  const duplicate = await createCardRefund('user-1', input, first.id);
  assert.equal(first.id, duplicate.id);
  assert.equal(records.get('expenses/purchase-1').refundedTotal, 60);
  await assert.rejects(createCardRefund('user-1', { ...input, amount: 41, refundDate: '2026-04-13' }), /remaining amount/i);
  assert.equal(records.get('expenses/purchase-1').refundedTotal, 60);
  const secondRefund = await createCardRefund('user-1', { ...input, amount: 40 });
  assert.notEqual(first.id, secondRefund.id);
  assert.equal(records.get('expenses/purchase-1').refundedTotal, 100);
  assert.equal([...records.keys()].filter(recordKey => recordKey.startsWith('cardRefunds/')).length, 2);
});

test('refund transaction accepts decimal amounts that exactly exhaust a purchase', async () => {
  records.set('expenses/decimal-purchase', {
    uid: 'user-1', payment: 'Credit Card', creditCardId: 'card-1', amount: 0.3,
  });
  const input = {
    creditCardId: 'card-1', originalExpenseId: 'decimal-purchase',
    refundDate: '2026-04-12', description: 'Small refund',
  };
  await createCardRefund('user-1', { ...input, amount: 0.1 });
  await createCardRefund('user-1', { ...input, amount: 0.2 });
  assert.equal(records.get('expenses/decimal-purchase').refundedTotal, 0.3);
});

test('payments use a stable document ID and offline writes are queued', async () => {
  const payment = { creditCardId: 'card-1', amount: 100, paymentDate: '2026-04-30', statementId: 'cycle-1' };
  await createCardPayment('user-1', 'payment-1', payment);
  await createCardPayment('user-1', 'payment-1', payment);
  assert.equal([...records.keys()].filter(recordKey => recordKey === 'cardPayments/payment-1').length, 1);

  navigator.onLine = false;
  const queued = await createCardPayment('user-1', 'payment-2', payment);
  assert.equal(queued.pending, true);
  assert.equal(window.queue.at(-1).type, 'cardPayment');
  assert.equal(window.queue.at(-1).docId, 'payment-2');
});

test('credit-card transactions are cached online and available offline', async () => {
  records.set('expenses/purchase-1', { uid: 'user-1', payment: 'Credit Card', creditCardId: 'card-1', amount: 100 });
  records.set('expenses/cash-1', { uid: 'user-1', payment: 'Cash', amount: 20 });
  records.set('cardRefunds/refund-1', { uid: 'user-1', creditCardId: 'card-1', amount: 10 });
  records.set('cardPayments/payment-1', { uid: 'user-1', creditCardId: 'card-1', amount: 90 });

  const online = await getCreditCardTransactions('user-1');
  assert.deepEqual(online.expenses.map(item => item.id), ['purchase-1']);
  assert.deepEqual(online.refunds.map(item => item.id), ['refund-1']);
  assert.deepEqual(online.payments.map(item => item.id), ['payment-1']);

  records.clear();
  navigator.onLine = false;
  const getDocs = globalThis.__firebase.getDocs;
  globalThis.__firebase.getDocs = async ref => {
    if (navigator.onLine === false) throw new Error('offline');
    return getDocs(ref);
  };
  assert.deepEqual(await getCreditCardTransactions('user-1'), online);
});
