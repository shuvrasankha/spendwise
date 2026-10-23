// Run: npm test — month-end summary: the app's month totals, and the push on the 1st at the reminder time
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK } from 'jose';
import { handlePushRoute, summaryDue, summaryMessage, sendMonthSummaries } from './src/push.js';
import { b64url } from './src/webpush.js';

const { privateKey } = await generateKeyPair('ES256', { extractable: true });
const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const p256dh = b64url.encode(new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey)));
const row = (over = {}) => ({
  uid: 'me', month: '2026-10', spent: 24100, symbol: '₹', prev: 26200,
  endpoint: 'https://fcm.googleapis.com/fcm/send/mine', remind_at: '21:00', tz: 'Asia/Kolkata',
  p256dh, auth: b64url.encode(new Uint8Array(16).fill(7)), ...over,
});
const nov1 = new Date('2026-11-01T15:40:00Z'); // 21:10 IST

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

test('sent on the 1st of the next month, in the hour after the reminder time', () => {
  assert.equal(summaryDue(row(), nov1), true);
  assert.equal(summaryDue(row(), new Date('2026-11-01T14:00:00Z')), false); // 19:30
  assert.equal(summaryDue(row(), new Date('2026-11-02T15:40:00Z')), false); // the 2nd
  assert.equal(summaryDue(row({ month: '2026-09' }), nov1), false);          // a month late
  assert.equal(summaryDue(row({ month: '2026-12' }), new Date('2027-01-01T15:40:00Z')), true); // across a year
});

test('message compares with the month before', () => {
  const msg = r => JSON.parse(summaryMessage(row(r)));
  assert.equal(msg().title, 'October: you spent ₹24,100');
  assert.equal(msg().body, '8% less than September');
  assert.equal(msg({ prev: 20000 }).body, '21% more than September');
  assert.equal(msg({ prev: 24100 }).body, 'About the same as September');
  assert.equal(msg({ prev: null }).body, 'See where it went in Insights');
  assert.equal(msg({ month: '2027-01' }).body, '8% less than December');
});

test('cron pushes encrypted and marks the month sent', async () => {
  const db = fakeDB([row()]);
  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { requests.push({ url: String(url), init }); return new Response(null, { status: 201 }); };
  const env = { DB: db, VAPID_PRIVATE_JWK: JSON.stringify(await exportJWK(privateKey)), VAPID_PUBLIC_KEY: 'k', VAPID_SUBJECT: 'https://x' };
  try { assert.deepEqual(await sendMonthSummaries(env, nov1), { sent: 1, gone: 0, failed: 0 }); }
  finally { globalThis.fetch = realFetch; }
  assert.ok(!new TextDecoder().decode(requests[0].init.body).includes('October'), 'message is encrypted');
  assert.deepEqual(db.calls.at(-1).args, ['me', '2026-10']);
});

test('month totals: stored per user, older months dropped, bad input refused', async () => {
  const db = fakeDB();
  const ok = await handlePushRoute('/push/months', { totals: { '2026-11': 300, '2026-10': 24100 }, symbol: '₹' }, 'me', { DB: db });
  assert.deepEqual(ok, [200, { ok: true }]);
  assert.deepEqual(db.calls[0].args, ['me', '2026-11', 300, '₹']);
  assert.deepEqual(db.calls.at(-1).args, ['me', '2026-09']); // keeps the month before last month
  const status = totals => handlePushRoute('/push/months', { totals }, 'me', { DB: fakeDB() }).then(r => r[0]);
  assert.equal(await status({ '2026-13': 5 }), 400);
  assert.equal(await status({ '2026-10': -1 }), 400);
  assert.equal(await status({}), 400);
  assert.equal(await status({ '2026-08': 1, '2026-09': 1, '2026-10': 1 }), 400);
  assert.equal(await status(null), 400);
});
