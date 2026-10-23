// Run: npm test — bill-due alerts: the app's bill list, and "due tomorrow" pushes at the reminder time
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK } from 'jose';
import { handlePushRoute, billDue, billMessage, sendBillAlerts } from './src/push.js';
import { b64url } from './src/webpush.js';

const { privateKey } = await generateKeyPair('ES256', { extractable: true });
const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const p256dh = b64url.encode(new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey)));
const row = (over = {}) => ({
  uid: 'me', key: 'subscription|netflix', title: 'Netflix', amount: 649, symbol: '₹', due: '2026-10-25', alerted_due: null,
  endpoint: 'https://fcm.googleapis.com/fcm/send/mine', remind_at: '21:00', tz: 'Asia/Kolkata',
  p256dh, auth: b64url.encode(new Uint8Array(16).fill(7)), ...over,
});

function fakeDB(rows = []) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const stmt = { all: async () => ({ results: rows }), run: async () => calls.push({ sql, args: [] }) };
      return { ...stmt, bind: (...args) => ({ ...stmt, run: async () => calls.push({ sql, args }) }) };
    },
  };
}
const env = async db => ({ DB: db, VAPID_PRIVATE_JWK: JSON.stringify(await exportJWK(privateKey)), VAPID_PUBLIC_KEY: 'k', VAPID_SUBJECT: 'https://x' });

test('alerted the day before, in the hour after the reminder time, once per due date', () => {
  const nine = new Date('2026-10-24T15:40:00Z'); // 21:10 IST on the 24th
  assert.equal(billDue(row(), nine), true);
  assert.equal(billDue(row(), new Date('2026-10-24T14:00:00Z')), false); // 19:30, before the reminder time
  assert.equal(billDue(row({ due: '2026-10-24' }), nine), false);         // due today, not tomorrow
  assert.equal(billDue(row({ alerted_due: '2026-10-25' }), nine), false);
  assert.equal(billDue(row({ due: '2026-11-01' }), new Date('2026-10-31T15:40:00Z')), true); // across a month end
});

test('message reads like a bill reminder', () => {
  const msg = JSON.parse(billMessage(row()));
  assert.equal(msg.title, 'Netflix due tomorrow');
  assert.match(msg.body, /^₹649 · /);
  assert.equal(msg.url, 'index.html');
});

test('cron pushes encrypted to the device and records the due date', async () => {
  const db = fakeDB([row()]);
  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { requests.push({ url: String(url), init }); return new Response(null, { status: 201 }); };
  try {
    assert.deepEqual(await sendBillAlerts(await env(db), new Date('2026-10-24T15:40:00Z')), { sent: 1, gone: 0, failed: 0 });
  } finally { globalThis.fetch = realFetch; }
  assert.equal(requests[0].init.headers['Content-Encoding'], 'aes128gcm');
  assert.ok(!new TextDecoder().decode(requests[0].init.body).includes('Netflix'), 'message is encrypted');
  assert.deepEqual(db.calls.at(-1).args, ['2026-10-25', 'me', 'subscription|netflix']);
});

test('bill list: stored per user, bad input refused', async () => {
  const db = fakeDB();
  const bill = { key: 'subscription|netflix', title: 'Netflix', amount: 649, due: '2026-10-25' };
  assert.deepEqual(await handlePushRoute('/push/bills', { bills: [bill], symbol: '₹' }, 'me', { DB: db }), [200, { ok: true }]);
  assert.deepEqual(db.calls[0].args, ['me', '["subscription|netflix"]']); // drops series no longer in the list
  assert.deepEqual(db.calls[1].args, ['me', 'subscription|netflix', 'Netflix', 649, '₹', '2026-10-25']);
  const bad = b => handlePushRoute('/push/bills', { bills: [{ ...bill, ...b }] }, 'me', { DB: fakeDB() }).then(r => r[0]);
  assert.equal(await bad({ amount: -5 }), 400);
  assert.equal(await bad({ due: 'soon' }), 400);
  assert.equal(await bad({ title: ' ' }), 400);
  assert.equal((await handlePushRoute('/push/bills', { bills: Array(51).fill(bill) }, 'me', { DB: fakeDB() }))[0], 400);
  assert.equal((await handlePushRoute('/push/bills', { bills: [bill], symbol: '<b>' }, 'me', { DB: db }))[0], 200);
  assert.equal(db.calls.at(-1).args[4], ''); // unknown symbol dropped
});
