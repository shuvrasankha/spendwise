// Run: npm test — native Android devices ("fcm:<token>"): subscribing, the FCM v1 body, and sending
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportPKCS8, jwtVerify } from 'jose';
import { handlePushRoute, fcmBody, sendFcm, deliver, sendDueReminders, billMessage } from './src/push.js';

const IST = 'Asia/Kolkata';
const TOKEN = 'dGVzdA:' + 'A'.repeat(156); // shaped like a real FCM token (163 characters)

function fakeDB(rows = [], devices = 0) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind: (...args) => ({ run: async () => calls.push({ sql, args }), all: async () => ({ results: rows }), first: async () => ({ n: devices }) }),
        all: async () => ({ results: rows }),
      };
    },
  };
}

// A throwaway service account: never the real key
const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
const SA = JSON.stringify({ client_email: 'test@spendwise-app-f7227.iam.gserviceaccount.com', private_key: await exportPKCS8(privateKey) });
const fcmEnv = (extra = {}) => ({ FIREBASE_PROJECT_ID: 'spendwise-app-f7227', FCM_SERVICE_ACCOUNT: SA, ...extra });

// Stubs fetch: the OAuth token endpoint answers a token; FCM answers `fcm(url, init)`
async function withFetch(fcm, run) {
  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).startsWith('https://oauth2.googleapis.com/')) return Response.json({ access_token: 'at-1', expires_in: 3600 });
    return fcm(String(url), init);
  };
  try { return { result: await run(), requests }; } finally { globalThis.fetch = realFetch; }
}

test('subscribe accepts fcm:<token> and refuses malformed tokens', async () => {
  const status = endpoint => handlePushRoute('/push/subscribe', { endpoint, remindAt: '21:00', tz: IST }, 'u1', { DB: fakeDB() }).then(r => r[0]);
  assert.equal(await status(`fcm:${TOKEN}`), 200);
  for (const bad of ['fcm:', 'fcm:short', `fcm:${TOKEN}/x`, `fcm:${TOKEN} x`, `fcm:${'A'.repeat(600)}`, 'fcm://evil.example']) {
    assert.equal(await status(bad), 400, bad);
  }
});

test('a native device with a verified email can take message pushes; without one only reminders', async () => {
  const env = { DB: fakeDB() };
  await handlePushRoute('/push/subscribe', { endpoint: `fcm:${TOKEN}`, remindAt: '21:00', tz: IST }, 'u1', env, { email: 'a@x.com' });
  const keys = env.DB.calls.find(c => c.sql.includes('push_keys'));
  assert.deepEqual(keys.args, [`fcm:${TOKEN}`, 'a@x.com', '', '']);

  const noEmail = { DB: fakeDB() };
  await handlePushRoute('/push/subscribe', { endpoint: `fcm:${TOKEN}`, remindAt: '21:00', tz: IST }, 'u1', noEmail);
  assert.ok(!noEmail.DB.calls.some(c => c.sql.includes('push_keys')));
});

test('unsubscribe takes an fcm endpoint', async () => {
  assert.equal((await handlePushRoute('/push/unsubscribe', { endpoint: `fcm:${TOKEN}` }, 'u1', { DB: fakeDB() }))[0], 200);
});

test('the FCM body: a reminder has no text; a message carries the browser\'s fields as strings', () => {
  assert.deepEqual(fcmBody('t', null), { message: { token: 't', data: { kind: 'reminder' }, android: { priority: 'normal', ttl: '3600s' } } });
  const bill = billMessage({ title: 'Netflix', amount: 649, symbol: '₹', key: 'Bills|Netflix', due: '2026-11-01' });
  const { message } = fcmBody('t', bill);
  assert.equal(message.data.kind, 'message');
  assert.equal(message.data.title, 'Netflix due tomorrow');
  assert.ok(Object.values(message.data).every(v => typeof v === 'string'));
  assert.equal(message.android.ttl, '86400s');
  assert.equal(message.android.collapse_key, message.data.tag);
});

test('sendFcm signs in with the service account once, then reuses the token', async () => {
  const { result, requests } = await withFetch(async () => Response.json({ name: 'ok' }), async () =>
    [await sendFcm(TOKEN, fcmEnv()), await sendFcm(TOKEN, fcmEnv())]);
  assert.deepEqual(result, ['sent', 'sent']);
  const oauth = requests.filter(r => r.url.startsWith('https://oauth2.googleapis.com/'));
  assert.equal(oauth.length, 1);
  const assertion = new URLSearchParams(oauth[0].init.body).get('assertion');
  const { payload } = await jwtVerify(assertion, publicKey, { audience: 'https://oauth2.googleapis.com/token' });
  assert.equal(payload.iss, 'test@spendwise-app-f7227.iam.gserviceaccount.com');
  assert.equal(payload.scope, 'https://www.googleapis.com/auth/firebase.messaging');

  const send = requests.filter(r => r.url.includes('messages:send'));
  assert.equal(send[0].url, 'https://fcm.googleapis.com/v1/projects/spendwise-app-f7227/messages:send');
  assert.equal(send[0].init.headers.Authorization, 'Bearer at-1');
  assert.equal(JSON.parse(send[0].init.body).message.token, TOKEN);
});

test('only 404 or UNREGISTERED counts as gone', async () => {
  const outcome = res => withFetch(async () => res, () => sendFcm(TOKEN, fcmEnv())).then(r => r.result);
  assert.equal(await outcome(new Response(null, { status: 404 })), 'gone');
  assert.equal(await outcome(Response.json({ error: { details: [{ errorCode: 'UNREGISTERED' }] } }, { status: 400 })), 'gone');
  assert.equal(await outcome(Response.json({ error: { details: [{ errorCode: 'INVALID_ARGUMENT' }] } }, { status: 400 })), 'failed');
  assert.equal(await outcome(new Response('boom', { status: 500 })), 'failed');
});

test('deliver sends fcm: rows to FCM and browser rows to their push service', async () => {
  const { requests } = await withFetch(async () => new Response(null, { status: 201 }), async () => {
    await deliver({ endpoint: `fcm:${TOKEN}` }, fcmEnv());
  });
  assert.ok(requests.some(r => r.url.includes('/messages:send')));
  assert.ok(!requests.some(r => r.url.includes('/fcm/send/')));
});

test('the cron drops a native device FCM no longer knows', async () => {
  const gone = { endpoint: `fcm:${TOKEN}`, remind_at: '21:00', tz: IST, last_logged: null, last_sent: null };
  const env = fcmEnv({ DB: fakeDB([gone]) });
  const { result } = await withFetch(async () => new Response(null, { status: 404 }), () => sendDueReminders(env, new Date('2026-10-21T15:40:00Z')));
  assert.deepEqual(result, { sent: 0, gone: 1, failed: 0 });
  assert.deepEqual(env.DB.calls.map(c => c.sql.split(' ')[0] + ' ' + c.args.join('|')), [`DELETE fcm:${TOKEN}`, `DELETE fcm:${TOKEN}`]);
});
