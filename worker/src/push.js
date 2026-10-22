// worker/src/push.js — Daily reminder push: subscription storage (D1) and sending.
// Pushes carry no payload, so no message encryption is needed; the service worker
// shows a fixed "Log today's spending" notification. Only the VAPID JWT is signed.

import { importJWK, SignJWT } from 'jose';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WINDOW_MINUTES = 60; // send if the cron runs within an hour after the chosen time
// The cron POSTs to every stored endpoint daily, so only browsers' own push services are accepted
const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'];
const PUSH_HOST_SUFFIXES = ['.notify.windows.com', '.push.apple.com'];
const MAX_DEVICES = 10; // per user; a phone, a laptop and a few browsers fit easily

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

// ── HTTP routes (caller already verified the Firebase user) ─────────────────
export async function handlePushRoute(path, body, uid, env) {
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
    return [200, { ok: true }];
  }
  if (path === '/push/unsubscribe') {
    const { endpoint } = body || {};
    if (!validEndpoint(endpoint)) return [400, { error: 'Invalid endpoint' }];
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
  return [404, { error: 'Not found' }];
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

// Returns 'sent' | 'gone' | 'failed'
export async function sendPush(endpoint, env) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Authorization': await vapidHeader(endpoint, env), 'TTL': '3600', 'Urgency': 'normal', 'Content-Length': '0' },
  });
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
      await env.DB.prepare('DELETE FROM subscriptions WHERE endpoint = ?1').bind(sub.endpoint).run();
    } else if (outcome === 'sent') {
      await env.DB.prepare('UPDATE subscriptions SET last_sent = ?1 WHERE endpoint = ?2')
        .bind(localParts(now, sub.tz).date, sub.endpoint).run();
    }
  }
  return counts;
}
