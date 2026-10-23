// worker/src/push.js — Push: subscription storage (D1) and sending.
// The daily reminder carries no payload; the service worker shows a fixed "Log today's spending".
// A debt shared with someone by email (a split bill, or one added on Debts) is one encrypted message
// to each of their devices (webpush.js).

import { importJWK, SignJWT } from 'jose';
import { encryptPush } from './webpush.js';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WINDOW_MINUTES = 60; // send if the cron runs within an hour after the chosen time
// The cron POSTs to every stored endpoint daily, so only browsers' own push services are accepted
const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'];
const PUSH_HOST_SUFFIXES = ['.notify.windows.com', '.push.apple.com'];
const MAX_DEVICES = 10; // per user; a phone, a laptop and a few browsers fit easily
const KEY = /^[A-Za-z0-9_-]{16,128}$/; // base64url subscription keys
const DOC_ID = /^[A-Za-z0-9]{1,64}$/; // Firestore auto ids
const DEBT_FRESH_MS = 60 * 60 * 1000; // only a debt created in the last hour can be announced
const DEBT_PUSHES_PER_DAY = 50; // per sender

// Local date and HH:MM for `now` in time zone `tz`
export function localParts(now, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

// A reminder is due once per local day, in the hour after remind_at, unless the user already logged today
export function isDue(sub, now) {
  const { date, minutes } = localParts(now, sub.tz);
  const [h, m] = sub.remind_at.split(':').map(Number);
  const since = minutes - (h * 60 + m);
  return since >= 0 && since < WINDOW_MINUTES && sub.last_sent !== date && sub.last_logged !== date;
}

export function validTz(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

function validEndpoint(endpoint) {
  try {
    const { protocol, hostname } = new URL(endpoint);
    return protocol === 'https:' && endpoint.length <= 1024 &&
      (PUSH_HOSTS.includes(hostname) || PUSH_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix)));
  } catch { return false; }
}

// A debt read through Firestore's REST API with the caller's own ID token, so Firestore's rules
// decide what they may read: null when it doesn't exist or isn't theirs to read
export async function readDebt(id, idToken, env) {
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/debts/${id}`,
    { headers: { Authorization: `Bearer ${idToken}` } });
  if (!res.ok) return null;
  const doc = await res.json();
  const f = doc.fields || {};
  return {
    uid: f.uid?.stringValue,
    type: f.type?.stringValue,
    withEmail: f.withEmail?.stringValue,
    fromName: f.fromName?.stringValue || 'Someone',
    amount: Number(f.amount?.doubleValue ?? f.amount?.integerValue),
    notes: f.notes?.stringValue || '',
    created: Date.parse(doc.createTime),
  };
}

// What the person a debt was shared with sees, from their side: the sender's "they owe me" is
// "you owe" for them. symbol is the sender's currency sign, if one.
export function debtMessage(debt, debtId, symbol) {
  const amount = `${symbol || ''}${debt.amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  const owed = debt.type === 'i-owe' ? `${debt.fromName} owes you ${amount}` : `You owe ${amount}`;
  return JSON.stringify({
    title: `${debt.fromName} ${debt.notes.startsWith('Split:') ? 'split a bill' : 'added a debt'} with you`.slice(0, 120),
    body: `${owed}${debt.notes ? ` · ${debt.notes}` : ''}`.slice(0, 200),
    url: 'debt.html',
    tag: `debt-${debtId}`,
  });
}

// ── HTTP routes (caller already verified the Firebase user) ─────────────────
// email is the token's verified address (lowercase); idToken is only used to read Firestore as the caller
export async function handlePushRoute(path, body, uid, env, { email, idToken } = {}) {
  if (path === '/push/subscribe') {
    const { endpoint, remindAt, tz } = body || {};
    if (!validEndpoint(endpoint) || !TIME.test(remindAt) || !validTz(tz)) return [400, { error: 'Invalid subscription' }];
    const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE uid = ?1 AND endpoint != ?2')
      .bind(uid, endpoint).first();
    if (n >= MAX_DEVICES) return [409, { error: 'Reminders are on for too many devices. Turn them off on one first.' }];
    // ON CONFLICT keeps last_sent/last_logged, so changing the time doesn't resend today
    await env.DB.prepare(
      `INSERT INTO subscriptions (endpoint, uid, remind_at, tz, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(endpoint) DO UPDATE SET uid = ?2, remind_at = ?3, tz = ?4`
    ).bind(endpoint, uid, remindAt, tz, Date.now()).run();
    // Keys let this device receive message pushes for this email; older clients don't send them
    const { p256dh, auth } = body.keys || {};
    if (email && KEY.test(p256dh || '') && KEY.test(auth || '')) {
      await env.DB.prepare(
        `INSERT INTO push_keys (endpoint, email, p256dh, auth) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(endpoint) DO UPDATE SET email = ?2, p256dh = ?3, auth = ?4`
      ).bind(endpoint, email, p256dh, auth).run();
    }
    return [200, { ok: true }];
  }
  if (path === '/push/unsubscribe') {
    const { endpoint } = body || {};
    if (!validEndpoint(endpoint)) return [400, { error: 'Invalid endpoint' }];
    await env.DB.prepare('DELETE FROM push_keys WHERE endpoint = ?1 AND endpoint IN (SELECT endpoint FROM subscriptions WHERE uid = ?2)').bind(endpoint, uid).run();
    await env.DB.prepare('DELETE FROM subscriptions WHERE endpoint = ?1 AND uid = ?2').bind(endpoint, uid).run();
    return [200, { ok: true }];
  }
  if (path === '/push/logged') {
    const { date } = body || {};
    if (!DATE.test(date)) return [400, { error: 'Invalid date' }];
    // Every device of this user skips today's reminder
    await env.DB.prepare('UPDATE subscriptions SET last_logged = ?1 WHERE uid = ?2').bind(date, uid).run();
    return [200, { ok: true }];
  }
  if (path === '/push/debt') {
    const { debtId, symbol } = body || {};
    if (!DOC_ID.test(debtId || '')) return [400, { error: 'Invalid debt' }];
    // Only the sender's own, just-created debt that names someone by email
    const debt = await readDebt(debtId, idToken, env);
    if (!debt || debt.uid !== uid || !debt.withEmail || !(Date.now() - debt.created < DEBT_FRESH_MS)) return [404, { error: 'No such shared debt' }];
    const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM debt_pushes WHERE uid = ?1 AND sent_at > ?2')
      .bind(uid, Date.now() - 864e5).first();
    if (n >= DEBT_PUSHES_PER_DAY) return [429, { error: 'Too many notifications today' }];
    const claim = await env.DB.prepare('INSERT OR IGNORE INTO debt_pushes (debt_id, uid, sent_at) VALUES (?1, ?2, ?3)')
      .bind(debtId, uid, Date.now()).run();
    if (!claim.meta?.changes) return [200, { sent: 0 }]; // already announced
    const message = debtMessage(debt, debtId, /^\p{Sc}$/u.test(symbol || '') ? symbol : '');
    const { results } = await env.DB.prepare('SELECT endpoint, p256dh, auth FROM push_keys WHERE email = ?1').bind(debt.withEmail).all();
    let sent = 0;
    for (const device of results) {
      let outcome;
      try { outcome = await sendPush(device.endpoint, env, await encryptPush(message, device)); } catch { outcome = 'failed'; }
      if (outcome === 'sent') sent++;
      if (outcome === 'gone') await forget(device.endpoint, env);
    }
    return [200, { sent }];
  }
  return [404, { error: 'Not found' }];
}

async function forget(endpoint, env) {
  await env.DB.prepare('DELETE FROM subscriptions WHERE endpoint = ?1').bind(endpoint).run();
  await env.DB.prepare('DELETE FROM push_keys WHERE endpoint = ?1').bind(endpoint).run();
}

// ── Sending ──────────────────────────────────────────────────────────────────
let vapidKey;
async function vapidHeader(endpoint, env) {
  vapidKey ??= await importJWK(JSON.parse(env.VAPID_PRIVATE_JWK), 'ES256');
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
    .setAudience(new URL(endpoint).origin)
    .setSubject(env.VAPID_SUBJECT)
    .setExpirationTime('12h')
    .sign(vapidKey);
  return `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`;
}

// Returns 'sent' | 'gone' | 'failed'. body: an encrypted message (webpush.js), or none for the reminder
export async function sendPush(endpoint, env, body = null) {
  const headers = { 'Authorization': await vapidHeader(endpoint, env), 'TTL': body ? '86400' : '3600', 'Urgency': 'normal' };
  if (body) Object.assign(headers, { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream' });
  else headers['Content-Length'] = '0';
  const res = await fetch(endpoint, { method: 'POST', headers, body });
  if (res.status === 404 || res.status === 410) return 'gone';
  return res.ok ? 'sent' : 'failed';
}

// Cron: send due reminders, record them, and drop subscriptions the browser has revoked
export async function sendDueReminders(env, now = new Date()) {
  // shortcut: reads every subscription each run; fine for thousands, add a UTC-minute column + index beyond that
  const { results } = await env.DB.prepare('SELECT endpoint, remind_at, tz, last_logged, last_sent FROM subscriptions').all();
  const counts = { sent: 0, gone: 0, failed: 0 };
  for (const sub of results) {
    if (!isDue(sub, now)) continue;
    let outcome;
    try { outcome = await sendPush(sub.endpoint, env); } catch { outcome = 'failed'; }
    counts[outcome]++;
    if (outcome === 'gone') {
      await forget(sub.endpoint, env);
    } else if (outcome === 'sent') {
      await env.DB.prepare('UPDATE subscriptions SET last_sent = ?1 WHERE endpoint = ?2')
        .bind(localParts(now, sub.tz).date, sub.endpoint).run();
    }
  }
  return counts;
}
