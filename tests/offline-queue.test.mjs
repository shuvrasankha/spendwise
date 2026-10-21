// Run: node --test tests/ — offline queue must sync the signed-in user's items and never lose any
import { register } from 'node:module';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

register('./stub-loader.mjs', import.meta.url);

// Minimal browser globals for the classic script
const store = new Map();
globalThis.localStorage = {
  getItem: k => store.has(k) ? store.get(k) : null,
  setItem: (k, v) => store.set(k, String(v)),
};
globalThis.document = { readyState: 'complete', querySelectorAll: () => [], getElementById: () => null };
const toasts = [];
const synced = [];
globalThis.window = Object.assign(new EventTarget(), { showToast: (msg, type) => toasts.push({ msg, type }) });
window.addEventListener('spendwise:synced', () => synced.push(true));

await import('../assets/js/modules/offline-queue.js');

const QUEUE_KEY = 'spendwise_offline_queue';
const queue = () => JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');

beforeEach(() => {
  store.clear();
  toasts.length = 0;
  synced.length = 0;
  globalThis.__firebase = { user: { uid: 'me' }, writes: [], setDoc: async (ref, data) => { globalThis.__firebase.writes.push({ ref, data }); } };
});

test('writes the signed-in user\'s items with a fresh createdAt and empties the queue', async () => {
  const id = window.addToOfflineQueue('expense', { uid: 'me', amount: 200, date: '2026-10-21', createdAt: { stale: true } });
  window.addToOfflineQueue('debt', { uid: 'me', amount: 50, date: '2026-10-21' });

  const result = await window.syncOfflineQueue();

  assert.deepEqual(result, { synced: 2, failed: 0 });
  assert.deepEqual(__firebase.writes[0].ref, { coll: 'expenses', id });
  assert.equal(__firebase.writes[0].data.createdAt, 'SERVER_TS');
  assert.equal(__firebase.writes[1].ref.coll, 'debts');
  assert.deepEqual(queue(), []);
  assert.equal(synced.length, 1);
});

test('a failing item is kept with retries counted, however many times it fails', async () => {
  __firebase.setDoc = async () => { throw new Error('permission-denied'); };
  window.addToOfflineQueue('income', { uid: 'me', amount: 1000, date: '2026-10-21' });

  for (let i = 0; i < 5; i++) await window.syncOfflineQueue();

  assert.equal(queue().length, 1);
  assert.equal(queue()[0].retries, 5);
  assert.equal(toasts.at(-1).type, 'error');
});

test('another account\'s items are left in the queue and never written', async () => {
  window.addToOfflineQueue('expense', { uid: 'someone-else', amount: 10, date: '2026-10-21' });
  window.addToOfflineQueue('expense', { uid: 'me', amount: 20, date: '2026-10-21' });

  await window.syncOfflineQueue();

  assert.equal(__firebase.writes.length, 1);
  assert.equal(__firebase.writes[0].data.uid, 'me');
  assert.deepEqual(queue().map(i => i.data.uid), ['someone-else']);
});

test('nothing is written or removed while signed out', async () => {
  __firebase.user = null;
  window.addToOfflineQueue('expense', { uid: 'me', amount: 20, date: '2026-10-21' });

  assert.deepEqual(await window.syncOfflineQueue(), { synced: 0, failed: 0 });
  assert.equal(__firebase.writes.length, 0);
  assert.equal(queue().length, 1);
});

test('an item queued during a sync is not lost', async () => {
  window.addToOfflineQueue('expense', { uid: 'me', amount: 20, date: '2026-10-21' });
  __firebase.setDoc = async () => {
    window.addToOfflineQueue('expense', { uid: 'me', amount: 99, date: '2026-10-21' });
  };

  await window.syncOfflineQueue();

  assert.deepEqual(queue().map(i => i.data.amount), [99]);
});
