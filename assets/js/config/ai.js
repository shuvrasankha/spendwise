// config/ai.js — AI requests go through our Cloudflare Worker (see worker/),
// which runs them on Workers AI and checks the user is signed in.
import { auth } from './firebase.js';

// URL printed by `npx wrangler deploy` in worker/
export const AI_PROXY_URL = 'https://spendwise-ai.spendwise-ai.workers.dev';

export async function callAI(body) {
  const user = auth.currentUser;
  if (!user) throw new Error('NOT_AUTHENTICATED');
  return fetch(AI_PROXY_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${await user.getIdToken()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
}
