// Run: npm test — daily reminder timing, input checks, and sending
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, jwtVerify, importJWK } from 'jose';
import { isDue, localParts, handlePushRoute, sendDueReminders } from './src/push.js';

const IST = 'Asia/Kolkata';
const at = iso => new Date(iso); // UTC instant
const sub = (extra = {}) => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', remind_at: '21:00', tz: IST, last_logged: null, last_sent: null, ...extra });

// Fake D1: records statements, returns `rows` for SELECTs
function fakeDB(rows = []) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return { bind: (...args) => ({ run: async () => calls.push({ sql, args }), all: async () => ({ results: rows }) }), all: async () => ({ results: rows }) };
    },
  };
}

test('local time is computed in the user time zone', () => {
  assert.deepEqual(localParts(at('2026-10-21T15:30:00Z'), IST), { date: '2026-10-21', minutes: 21 * 60 }); // 21:00 IST
  assert.deepEqual(localParts(at('2026-10-21T19:00:00Z'), IST), { date: '2026-10-22', minutes: 30 });       // 00:30 IST next day
});

test('due in the hour after the chosen time, once per day', () => {
  assert.equal(isDue(sub(), at('2026-10-21T15:29:00Z')), false); // 20:59 IST
  assert.equal(isDue(sub(), at('2026-10-21T15:30:00Z')), true);  // 21:00
  assert.equal(isDue(sub(), at('2026-10-21T16:29:00Z')), true);  // 21:59
  assert.equal(isDue(sub(), at('2026-10-21T16:30:00Z')), false); // 22:00, window over
  assert.equal(isDue(sub({ last_sent: '2026-10-21' }), at('2026-10-21T15:45:00Z')), false);
});

test('not due when the user already logged today', () => {
  assert.equal(isDue(sub({ last_logged: '2026-10-21' }), at('2026-10-21T15:45:00Z')), false);
  assert.equal(isDue(sub({ last_logged: '2026-10-20' }), at('2026-10-21T15:45:00Z')), true);
});

test('subscribe validates input and stores it for the signed-in user', async () => {
  const env = { DB: fakeDB() };
  assert.equal((await handlePushRoute('/push/subscribe', { endpoint: 'http://x', remindAt: '21:00', tz: IST }, 'u1', env))[0], 400);
  assert.equal((await handlePushRoute('/push/subscribe', { endpoint: sub().endpoint, remindAt: '25:00', tz: IST }, 'u1', env))[0], 400);
  assert.equal((await handlePushRoute('/push/subscribe', { endpoint: sub().endpoint, remindAt: '21:00', tz: 'Mars/Base' }, 'u1', env))[0], 400);
  assert.equal(env.DB.calls.length, 0);

  const [status] = await handlePushRoute('/push/subscribe', { endpoint: sub().endpoint, remindAt: '20:30', tz: IST }, 'u1', env);
  assert.equal(status, 200);
  assert.deepEqual(env.DB.calls[0].args.slice(0, 4), [sub().endpoint, 'u1', '20:30', IST]);
});

test('unsubscribe and logged only touch the caller\'s own rows', async () => {
  const env = { DB: fakeDB() };
  await handlePushRoute('/push/unsubscribe', { endpoint: sub().endpoint }, 'u1', env);
  await handlePushRoute('/push/logged', { date: '2026-10-21' }, 'u1', env);
  assert.match(env.DB.calls[0].sql, /WHERE endpoint = \?1 AND uid = \?2/);
  assert.deepEqual(env.DB.calls[0].args, [sub().endpoint, 'u1']);
  assert.deepEqual(env.DB.calls[1].args, ['2026-10-21', 'u1']);
  assert.equal((await handlePushRoute('/push/logged', { date: 'today' }, 'u1', env))[0], 400);
});

test('cron sends a signed push to due subscriptions, records it, and drops revoked ones', async () => {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(privateKey);
  const pubJwk = await exportJWK(publicKey);
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pubJwk.x, 'base64url'), Buffer.from(pubJwk.y, 'base64url')]).toString('base64url');

  const due = sub({ endpoint: 'https://fcm.googleapis.com/fcm/send/due' });
  const gone = sub({ endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/gone' });
  const logged = sub({ endpoint: 'https://web.push.apple.com/logged', last_logged: '2026-10-21' });
  const env = { DB: fakeDB([due, gone, logged]), VAPID_PRIVATE_JWK: JSON.stringify(jwk), VAPID_PUBLIC_KEY: raw, VAPID_SUBJECT: 'https://shuvrasankha.github.io/spendwise/' };

  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return new Response(null, { status: url.includes('gone') ? 410 : 201 }); };
  try {
    const counts = await sendDueReminders(env, at('2026-10-21T15:40:00Z')); // 21:10 IST
    assert.deepEqual(counts, { sent: 1, gone: 1, failed: 0 });
  } finally { globalThis.fetch = realFetch; }

  assert.deepEqual(requests.map(r => r.url), [due.endpoint, gone.endpoint]); // the logged-today one is skipped
  const [, token, key] = requests[0].init.headers.Authorization.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(key, raw);
  const { payload } = await jwtVerify(token, await importJWK(pubJwk, 'ES256'), { audience: 'https://fcm.googleapis.com' });
  assert.equal(payload.sub, env.VAPID_SUBJECT);
  assert.equal(requests[0].init.headers['Content-Length'], '0');

  const writes = env.DB.calls.map(c => c.sql.split(' ')[0] + ' ' + c.args.join('|'));
  assert.deepEqual(writes, [`UPDATE 2026-10-21|${due.endpoint}`, `DELETE ${gone.endpoint}`]);
});
