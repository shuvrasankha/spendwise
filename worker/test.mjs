// Run: npm test — checks the worker never forwards to Hugging Face without a valid sign-in
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './src/index.js';

const env = {
  FIREBASE_PROJECT_ID: 'spendwise-app-f7227',
  ALLOWED_ORIGINS: 'https://shuvrasankha.github.io',
  HF_TOKEN: 'hf_secret',
};
const URL_ = 'https://spendwise-ai.example.workers.dev';
const body = JSON.stringify({ model: 'Qwen/Qwen2.5-7B-Instruct', messages: [] });

// Fail loudly if anything tries to reach Hugging Face
const realFetch = globalThis.fetch;
globalThis.fetch = (url, ...rest) => {
  if (String(url).includes('huggingface')) throw new Error('forwarded to Hugging Face');
  return realFetch(url, ...rest);
};

test('preflight answers with CORS for the app origin', async () => {
  const res = await worker.fetch(new Request(URL_, { method: 'OPTIONS', headers: { Origin: 'https://shuvrasankha.github.io' } }), env);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://shuvrasankha.github.io');
});

test('other origins do not get echoed back', async () => {
  const res = await worker.fetch(new Request(URL_, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), env);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://shuvrasankha.github.io');
});

test('GET is rejected', async () => {
  const res = await worker.fetch(new Request(URL_), env);
  assert.equal(res.status, 405);
});

test('no token is rejected', async () => {
  const res = await worker.fetch(new Request(URL_, { method: 'POST', body }), env);
  assert.equal(res.status, 401);
});

test('forged token is rejected', async () => {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const fake = `${b64({ alg: 'RS256', kid: 'x' })}.${b64({ sub: 'u', aud: env.FIREBASE_PROJECT_ID })}.sig`;
  const res = await worker.fetch(new Request(URL_, { method: 'POST', body, headers: { Authorization: `Bearer ${fake}` } }), env);
  assert.equal(res.status, 401);
});
