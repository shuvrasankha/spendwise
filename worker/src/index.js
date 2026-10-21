// worker/src/index.js — SpendWise backend for signed-in users (verified Firebase ID token):
//   POST /         AI requests on Cloudflare Workers AI (free daily allowance, no API key)
//   POST /push/*   daily reminder subscriptions (see push.js); the cron sends them

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { handlePushRoute, sendDueReminders } from './push.js';

const GOOGLE_JWKS = createRemoteJWKSet(new URL(
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
));
// Only the models the app uses, so a signed-in user can't run anything pricier
const ALLOWED_MODELS = new Set([
  '@cf/qwen/qwen2.5-coder-32b-instruct',      // voice-command.js, csv-upload.js
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast', // insights-v2.js
]);
const MAX_TOKENS = 4096;

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
    let uid;
    try {
      const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
        issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
        audience: env.FIREBASE_PROJECT_ID,
      });
      if (!payload.sub) throw new Error('no subject');
      uid = payload.sub;
    } catch {
      return json(401, { error: 'Not signed in' }, cors);
    }

    let body;
    try { body = await req.json(); } catch { return json(400, { error: 'Invalid JSON' }, cors); }

    const path = new URL(req.url).pathname;
    if (path.startsWith('/push/')) {
      const [status, result] = await handlePushRoute(path, body, uid, env);
      return json(status, result, cors);
    }
    if (!body || !ALLOWED_MODELS.has(body.model) || !Array.isArray(body.messages)) {
      return json(400, { error: 'Model or messages not allowed' }, cors);
    }

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
  },
};
