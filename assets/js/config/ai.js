// config/ai.js — Calls to our Cloudflare Worker (see worker/): AI on Workers AI and
// daily reminder subscriptions. Every call carries the user's Firebase ID token.
import { auth } from './firebase.js';

// URL printed by `npx wrangler deploy` in worker/
export const AI_PROXY_URL = 'https://spendwise-ai.spendwise-ai.workers.dev';

// Public VAPID key for push subscriptions (matches VAPID_PUBLIC_KEY in worker/wrangler.toml)
export const VAPID_PUBLIC_KEY = 'BKCNrZarOI82d2swFOI1qMD6FgS15PcD8L66FymoziBQPbOKzvv8QYX8PocmeOIzpY_QPDl5YTUC6OkFIEyK07w';

export async function callWorker(path, body) {
  const user = auth.currentUser;
  if (!user) throw new Error('NOT_AUTHENTICATED');
  return fetch(new URL(path, AI_PROXY_URL), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${await user.getIdToken()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
}

export const callAI = (body) => callWorker('/', body);
