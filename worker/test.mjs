// Run: npm test — checks the worker never runs the AI model without a valid sign-in
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './src/index.js';

const env = {
  FIREBASE_PROJECT_ID: 'spendwise-app-f7227',
  ALLOWED_ORIGINS: 'https://shuvrasankha.github.io',
  AI: { run: () => { throw new Error('AI model was called'); } },
};
const URL_ = 'https://spendwise-ai.example.workers.dev';
const body = JSON.stringify({ model: '@cf/qwen/qwen2.5-coder-32b-instruct', messages: [] });

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

test('push routes also require sign-in', async () => {
  const req = new Request(URL_ + '/push/subscribe', { method: 'POST', body: JSON.stringify({ endpoint: 'https://x', remindAt: '21:00', tz: 'Asia/Kolkata' }) });
  const res = await worker.fetch(req, { ...env, DB: { prepare() { throw new Error('DB was touched'); } } });
  assert.equal(res.status, 401);
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

// ── Per-user AI share and verified email (fix for one account using up everyone's allowance) ──
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { userFrom, takeAiQuota, aiBodyError } from './src/index.js';

// The real schema and upsert, on SQLite in memory, behind D1's prepare/bind/first shape
function sqliteD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  return { prepare: sql => ({ bind: (...args) => ({ first: async () => db.prepare(sql.replace(/\?\d/g, '?')).get(...args) }) }) };
}

test('unverified email accounts are refused; verified ones get their uid', () => {
  assert.deepEqual(userFrom({ sub: 'u1', email_verified: false }), { status: 403, error: 'Verify your email first' });
  assert.deepEqual(userFrom({ sub: 'u1' }), { status: 403, error: 'Verify your email first' });
  assert.deepEqual(userFrom({}), { status: 401, error: 'Not signed in' });
  assert.deepEqual(userFrom({ sub: 'u1', email_verified: true }), { uid: 'u1' });
  assert.deepEqual(userFrom({ sub: 'u1', email_verified: true, email: 'Ravi@Gmail.com' }), { uid: 'u1', email: 'ravi@gmail.com' });
});

test('each user gets 100 AI requests per UTC day, then 429; others and the next day are unaffected', async () => {
  const env = { DB: sqliteD1() };
  const day1 = new Date('2026-10-22T10:00:00Z');
  for (let i = 0; i < 100; i++) assert.equal(await takeAiQuota(env, 'heavy', day1), true);
  assert.equal(await takeAiQuota(env, 'heavy', day1), false);
  assert.equal(await takeAiQuota(env, 'other', day1), true);
  assert.equal(await takeAiQuota(env, 'heavy', new Date('2026-10-23T00:00:01Z')), true);
});

test('AI requests: only allowed models, and a receipt photo fits but a huge body is refused', () => {
  const photo = 'data:image/jpeg;base64,' + 'A'.repeat(300_000);
  const vision = (url) => ({ model: '@cf/meta/llama-4-scout-17b-16e-instruct',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Read this' }, { type: 'image_url', image_url: { url } }] }] });
  assert.equal(aiBodyError(vision(photo)), null);
  assert.equal(aiBodyError(vision('data:image/jpeg;base64,' + 'A'.repeat(2_000_000)))[0], 413);
  assert.equal(aiBodyError({ model: '@cf/some/pricier-model', messages: [] })[0], 400);
  assert.equal(aiBodyError({ model: '@cf/qwen/qwen2.5-coder-32b-instruct' })[0], 400);
});

// npm run deploy applies schema.sql to the live database every time, so each statement must be repeatable
test('schema.sql only creates what is missing, so it is safe to run on every deploy', () => {
  const sql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8').replace(/--.*$/gm, '');
  const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
  assert.ok(statements.length > 0);
  for (const s of statements) assert.match(s, /^CREATE (TABLE|INDEX) IF NOT EXISTS /, s.slice(0, 60));
});
