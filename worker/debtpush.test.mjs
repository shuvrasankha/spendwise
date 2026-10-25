// Run: npm test — telling someone a bill was split with them: only for the sender's own new debt, once
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK } from 'jose';
import { handlePushRoute, debtMessage, claimMessage } from './src/push.js';
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
        all: async () => ({ results: sql.includes('FROM push_keys') && ['friend@y.com', 'me@x.com'].includes(args[0]) ? [device] : [] }),
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

async function call(body, { doc = debtDoc(), status = 200, db = fakeDB(), uid = 'me', email = 'me@x.com', path = '/push/debt' } = {}) {
  const env = { DB: db, FIREBASE_PROJECT_ID: 'p', VAPID_PRIVATE_JWK: JSON.stringify(await exportJWK(privateKey)), VAPID_PUBLIC_KEY: 'k', VAPID_SUBJECT: 'https://x' };
  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).startsWith('https://firestore.googleapis.com/')) return new Response(JSON.stringify(doc), { status });
    return new Response(null, { status: 201 });
  };
  try { return { result: await handlePushRoute(path, body, uid, env, { email, idToken: 'tok' }), requests, env }; }
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

test('no verified sender email, no push', async () => {
  assert.equal((await call({ debtId: 'a1' }, { email: '' })).result[0], 404);
});

test('a sender is capped per day', async () => {
  assert.equal((await call({ debtId: 'a1' }, { db: fakeDB({ sentToday: 50 }) })).result[0], 429);
});

test('the message names the sender by verified email, the amount and the note', () => {
  const split = { type: 'they-owe', amount: 1250.5, notes: 'Split: Dinner' };
  assert.deepEqual(JSON.parse(debtMessage(split, 'd1', '₹', 'ravi@x.com')), { title: 'ravi@x.com split a bill with you', body: 'You owe ₹1,250.5 · Split: Dinner', url: 'debt.html', tag: 'debt-d1' });
  // added on Debts, either way round
  assert.equal(JSON.parse(debtMessage({ type: 'they-owe', amount: 500, notes: '' }, 'd2', '', 'ravi@x.com')).body, 'You owe 500');
  const theyOwe = JSON.parse(debtMessage({ type: 'i-owe', amount: 500, notes: 'Rent' }, 'd3', '₹', 'ravi@x.com'));
  assert.deepEqual([theyOwe.title, theyOwe.body], ['ravi@x.com added a debt with you', 'ravi@x.com owes you ₹500 · Rent']);
});

// The friend says the debt is settled: its sender (me@x.com) is told, once per claim
const claimDoc = (fields = {}) => debtDoc({ fields: { fromEmail: { stringValue: 'me@x.com' }, claimDate: { stringValue: '2026-10-23' }, type: { stringValue: 'they-owe' }, ...fields } });
const claim = (opts = {}) => call({ debtId: 'c1', symbol: '₹' }, { path: '/push/claim', uid: 'fr', email: 'friend@y.com', doc: claimDoc(), ...opts });

test('a settle claim is pushed to the debt\'s sender, once per claim', async () => {
  const db = fakeDB();
  const first = await claim({ db });
  assert.deepEqual(first.result, [200, { sent: 1 }]);
  assert.ok(first.requests[0].url.endsWith('/debts/c1'));
  assert.equal(first.requests[1].url, device.endpoint);
  assert.deepEqual((await claim({ db })).result, [200, { sent: 0 }]);
  assert.equal((await claim({ db, doc: claimDoc({ claimDate: { stringValue: '2026-10-24' } }) })).result[1].sent, 1); // claimed again later
  assert.equal((await claim({ db, doc: claimDoc({ claimDate: { stringValue: '2026-10-24' }, claimAmount: { integerValue: '200' } }) })).result[1].sent, 1); // another part, the same day
});

test('settle claim refused: not shared with the caller, no claim, already settled, no sender email', async () => {
  assert.equal((await claim({ email: 'other@z.com' })).result[0], 404);
  assert.equal((await claim({ doc: claimDoc({ claimDate: { stringValue: '' } }) })).result[0], 404);
  assert.equal((await claim({ doc: claimDoc({ settled: { booleanValue: true } }) })).result[0], 404);
  assert.equal((await claim({ doc: claimDoc({ fromEmail: { stringValue: '' } }) })).result[0], 404);
  assert.equal((await claim({ db: fakeDB({ sentToday: 50 }) })).result[0], 429);
});

test('the settle message reads from the sender\'s side', () => {
  const owedToMe = JSON.parse(claimMessage({ type: 'they-owe', amount: 500, notes: 'Rent' }, 'c1', '₹', 'ravi@x.com'));
  assert.deepEqual(owedToMe, { title: 'ravi@x.com says a debt is settled', body: 'They paid you ₹500 · Confirm it in Debts · Rent', url: 'debt.html', tag: 'claim-c1' });
  assert.equal(JSON.parse(claimMessage({ type: 'i-owe', amount: 500, notes: '' }, 'c1', '', 'ravi@x.com')).body, 'You paid them 500 · Confirm it in Debts');
  // part of it: the amount they say was paid
  const part = JSON.parse(claimMessage({ type: 'they-owe', amount: 1768, claimAmount: 500, notes: '' }, 'c1', '₹', 'ravi@x.com'));
  assert.equal(part.title, 'ravi@x.com says part of a debt is paid');
  assert.equal(part.body, 'They paid you ₹500 · Confirm it in Debts');
});
