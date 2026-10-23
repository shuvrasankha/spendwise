// Run: npm test — telling someone a bill was split with them: only for the sender's own new debt, once
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK } from 'jose';
import { handlePushRoute, debtMessage } from './src/push.js';
import { b64url } from './src/webpush.js';

const { privateKey } = await generateKeyPair('ES256', { extractable: true });
const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const device = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/friend',
  p256dh: b64url.encode(new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey))),
  auth: b64url.encode(crypto.getRandomValues(new Uint8Array(16))),
};

// D1 stand-in: remembers which debts were already announced and how many this sender sent today
function fakeDB({ sentToday = 0 } = {}) {
  const announced = new Set();
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return { bind: (...args) => ({
        first: async () => ({ n: sentToday }),
        all: async () => ({ results: sql.includes('FROM push_keys') && args[0] === 'friend@y.com' ? [device] : [] }),
        run: async () => {
          calls.push({ sql, args });
          if (sql.startsWith('INSERT OR IGNORE INTO debt_pushes')) {
            const fresh = !announced.has(args[0]);
            announced.add(args[0]);
            return { meta: { changes: fresh ? 1 : 0 } };
          }
          return { meta: { changes: 1 } };
        },
      }) };
    },
  };
}

const debtDoc = (over = {}) => ({
  createTime: new Date(Date.now() - 60_000).toISOString(),
  fields: { uid: { stringValue: 'me' }, withEmail: { stringValue: 'friend@y.com' }, fromName: { stringValue: 'Ravi' },
    amount: { integerValue: '300' }, notes: { stringValue: 'Split: Dinner' }, ...over.fields },
  ...over.doc,
});

async function call(body, { doc = debtDoc(), status = 200, db = fakeDB(), uid = 'me' } = {}) {
  const env = { DB: db, FIREBASE_PROJECT_ID: 'p', VAPID_PRIVATE_JWK: JSON.stringify(await exportJWK(privateKey)), VAPID_PUBLIC_KEY: 'k', VAPID_SUBJECT: 'https://x' };
  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).startsWith('https://firestore.googleapis.com/')) return new Response(JSON.stringify(doc), { status });
    return new Response(null, { status: 201 });
  };
  try { return { result: await handlePushRoute('/push/debt', body, uid, env, { idToken: 'tok' }), requests, env }; }
  finally { globalThis.fetch = realFetch; }
}

test('the sender\'s new shared debt is pushed, encrypted, to the friend\'s devices, read as the sender', async () => {
  const { result, requests } = await call({ debtId: 'abc123', symbol: '₹' });
  assert.deepEqual(result, [200, { sent: 1 }]);
  assert.equal(requests[0].url, 'https://firestore.googleapis.com/v1/projects/p/databases/(default)/documents/debts/abc123');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer tok');
  const push = requests[1];
  assert.equal(push.url, device.endpoint);
  assert.equal(push.init.headers['Content-Encoding'], 'aes128gcm');
  assert.ok(!new TextDecoder().decode(push.init.body).includes('Ravi'), 'message is encrypted');
});

test('a debt is announced only once', async () => {
  const db = fakeDB();
  assert.deepEqual((await call({ debtId: 'abc123' }, { db })).result, [200, { sent: 1 }]);
  const again = await call({ debtId: 'abc123' }, { db });
  assert.deepEqual(again.result, [200, { sent: 0 }]);
  assert.equal(again.requests.length, 1); // read the debt, sent nothing
});

test('refused: someone else\'s debt, no email, an old debt, unreadable, bad id', async () => {
  assert.equal((await call({ debtId: 'a1' }, { uid: 'stranger' })).result[0], 404);
  assert.equal((await call({ debtId: 'a1' }, { doc: debtDoc({ fields: { withEmail: undefined } }) })).result[0], 404);
  assert.equal((await call({ debtId: 'a1' }, { doc: debtDoc({ doc: { createTime: new Date(Date.now() - 2 * 3600e3).toISOString() } }) })).result[0], 404);
  assert.equal((await call({ debtId: 'a1' }, { status: 403 })).result[0], 404);
  assert.equal((await call({ debtId: '../x' })).result[0], 400);
});

test('a sender is capped per day', async () => {
  assert.equal((await call({ debtId: 'a1' }, { db: fakeDB({ sentToday: 50 }) })).result[0], 429);
});

test('the message names the sender, the amount and the note', () => {
  const split = { fromName: 'Ravi', type: 'they-owe', amount: 1250.5, notes: 'Split: Dinner' };
  assert.deepEqual(JSON.parse(debtMessage(split, 'd1', '₹')), { title: 'Ravi split a bill with you', body: 'You owe ₹1,250.5 · Split: Dinner', url: 'debt.html', tag: 'debt-d1' });
  // added on Debts, either way round
  assert.equal(JSON.parse(debtMessage({ fromName: 'Ravi', type: 'they-owe', amount: 500, notes: '' }, 'd2')).body, 'You owe 500');
  const theyOwe = JSON.parse(debtMessage({ fromName: 'Ravi', type: 'i-owe', amount: 500, notes: 'Rent' }, 'd3', '₹'));
  assert.deepEqual([theyOwe.title, theyOwe.body], ['Ravi added a debt with you', 'Ravi owes you ₹500 · Rent']);
});
