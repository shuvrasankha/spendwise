// worker/src/index.js — SpendWise backend for signed-in users (verified Firebase ID token):
//   POST /         AI requests on Cloudflare Workers AI (free daily allowance, no API key)
//   POST /push/*   push subscriptions, the daily reminder, bill-due and month-summary crons; /push/debt tells the person a
//                  bill was split with, /push/claim tells its sender they say it's settled (see push.js)

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { handlePushRoute, sendDueReminders, sendBillAlerts, sendMonthSummaries } from './push.js';

const GOOGLE_JWKS = createRemoteJWKSet(new URL(
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
));
// Only the models the app uses, so a signed-in user can't run anything pricier
const ALLOWED_MODELS = new Set([
  '@cf/qwen/qwen2.5-coder-32b-instruct',      // voice-command.js, csv-upload.js
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast', // insights-v2.js
  '@cf/meta/llama-4-scout-17b-16e-instruct',   // voice-command.js: receipt photos
]);
const MAX_TOKENS = 4096;
// A receipt photo arrives shrunk to ~200 KB; this leaves room for one and refuses anything far larger
const MAX_MESSAGES_CHARS = 1_500_000;
// The free AI allowance is shared by every user and resets at 00:00 UTC, so each user gets a share of it
const AI_DAILY_LIMIT = 100;

// The user a verified token belongs to. Email sign-ups must confirm their address first
// (the app signs them out until they do); Google accounts arrive verified.
export function userFrom(payload) {
  if (!payload?.sub) return { status: 401, error: 'Not signed in' };
  if (payload.email_verified !== true) return { status: 403, error: 'Verify your email first' };
  return { uid: payload.sub, ...(typeof payload.email === 'string' && { email: payload.email.toLowerCase() }) };
}

// Why an AI request body is refused, or null when it's fine: [status, message]
export function aiBodyError(body) {
  if (!body || !ALLOWED_MODELS.has(body.model) || !Array.isArray(body.messages)) return [400, 'Model or messages not allowed'];
  if (JSON.stringify(body.messages).length > MAX_MESSAGES_CHARS) return [413, 'Request too large'];
  return null;
}

// Counts this request and says whether the user is still within today's share.
// One atomic upsert, so parallel requests can't slip past the limit.
export async function takeAiQuota(env, uid, now = new Date()) {
  const day = now.toISOString().slice(0, 10); // UTC day, matching the allowance reset
  const row = await env.DB.prepare(
    'INSERT INTO ai_usage (uid, day, n) VALUES (?1, ?2, 1) ON CONFLICT(uid, day) DO UPDATE SET n = n + 1 RETURNING n'
  ).bind(uid, day).first();
  return row.n <= AI_DAILY_LIMIT;
}

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = env.ALLOWED_ORIGINS.split(',').map(s => s.trim());
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Vary': 'Origin',
  };
}

function json(status, body, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, cors);

    const idToken = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    let payload;
    try {
      ({ payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
        issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
        audience: env.FIREBASE_PROJECT_ID,
      }));
    } catch {
      return json(401, { error: 'Not signed in' }, cors);
    }
    const user = userFrom(payload);
    if (!user.uid) return json(user.status, { error: user.error }, cors);
    const { uid } = user;

    let body;
    try { body = await req.json(); } catch { return json(400, { error: 'Invalid JSON' }, cors); }

    const path = new URL(req.url).pathname;
    if (path.startsWith('/push/')) {
      const [status, result] = await handlePushRoute(path, body, uid, env, { email: user.email, idToken });
      return json(status, result, cors);
    }
    const bad = aiBodyError(body);
    if (bad) return json(bad[0], { error: bad[1] }, cors);
    // 429 is what the app already shows as "today's AI limit is used up"
    let allowed;
    try { allowed = await takeAiQuota(env, uid); } catch { return json(503, { error: 'Usage check failed' }, cors); }
    if (!allowed) return json(429, { error: `Daily AI limit of ${AI_DAILY_LIMIT} requests reached` }, cors);

    let out;
    try {
      out = await env.AI.run(body.model, {
        messages: body.messages,
        max_tokens: Math.min(Number(body.max_tokens) || 1024, MAX_TOKENS),
        temperature: body.temperature,
        top_p: body.top_p,
      });
    } catch (err) {
      // 4006 = free daily neuron allowance used up (resets 00:00 UTC)
      const msg = String(err?.message || err);
      const limited = msg.includes('4006') || /allocation|rate limit/i.test(msg);
      return json(limited ? 429 : 502, { error: msg }, cors);
    }

    // Keep the OpenAI-style shape the app already reads (choices[0].message.content)
    const content = typeof out?.response === 'string' ? out.response : JSON.stringify(out?.response ?? '');
    return json(200, { choices: [{ message: { role: 'assistant', content } }] }, cors);
  },

  // Cron trigger (wrangler.toml): every 15 minutes, send reminders that are due
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDueReminders(env).then(c => console.log('reminders', JSON.stringify(c))));
    ctx.waitUntil(sendBillAlerts(env).then(c => console.log('bill alerts', JSON.stringify(c))));
    ctx.waitUntil(sendMonthSummaries(env).then(c => console.log('month summaries', JSON.stringify(c))));
    // usage counts are only needed for the current UTC day
    const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    ctx.waitUntil(env.DB.prepare('DELETE FROM ai_usage WHERE day < ?1').bind(yesterday).run());
  },
};
