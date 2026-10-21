// worker/src/index.js — Holds the Hugging Face token server-side and forwards
// chat requests only for signed-in SpendWise users (verified Firebase ID token).

import { createRemoteJWKSet, jwtVerify } from 'jose';

const HF_API_URL = 'https://router.huggingface.co/v1/chat/completions';
const GOOGLE_JWKS = createRemoteJWKSet(new URL(
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
));
// Only the models the app uses, so a stolen session can't run anything pricier
const ALLOWED_MODELS = new Set([
  'Qwen/Qwen2.5-Coder-32B-Instruct:fastest', // voice-command.js
  'Qwen/Qwen2.5-7B-Instruct',                // csv-upload.js
  'Qwen/Qwen2.5-72B-Instruct',               // insights-v2.js
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
    try {
      const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
        issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
        audience: env.FIREBASE_PROJECT_ID,
      });
      if (!payload.sub) throw new Error('no subject');
    } catch {
      return json(401, { error: 'Not signed in' }, cors);
    }

    let body;
    try { body = await req.json(); } catch { return json(400, { error: 'Invalid JSON' }, cors); }
    if (!body || !ALLOWED_MODELS.has(body.model) || !Array.isArray(body.messages)) {
      return json(400, { error: 'Model or messages not allowed' }, cors);
    }
    body.max_tokens = Math.min(Number(body.max_tokens) || 1024, MAX_TOKENS);
    body.stream = false;

    const upstream = await fetch(HF_API_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.HF_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...cors, 'Content-Type': upstream.headers.get('Content-Type') || 'application/json' },
    });
  },
};
