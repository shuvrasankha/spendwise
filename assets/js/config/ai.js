// config/ai.js — AI requests go through our Cloudflare Worker (see worker/),
// which keeps the Hugging Face token off the client and checks the user is signed in.
import { auth } from './firebase.js';

// Set this to the URL printed by `npx wrangler deploy` in worker/
export const AI_PROXY_URL = 'https://spendwise-ai.YOUR_SUBDOMAIN.workers.dev';

export async function callAI(body) {
  if (AI_PROXY_URL.includes('YOUR_SUBDOMAIN')) throw new Error('AI_NOT_CONFIGURED');
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
