// Run: node --test tests/ — settings (budget, goals) follow the account and stay readable offline
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('./stub-loader.mjs', import.meta.url);

const store = new Map();
globalThis.localStorage = {
  getItem: k => store.has(k) ? store.get(k) : null,
  setItem: (k, v) => store.set(k, String(v)),
};
const writes = [];
globalThis.__firebase = {
  user: { uid: 'me' },
  getDoc: async ref => ({ data: () => ref.id === 'me' ? { goals: [{ id: 'a', name: 'Goa', target: 30000, saved: 0, by: '2027-03' }] } : undefined }),
  setDoc: async (ref, data, opts) => { writes.push({ ref, data, opts }); },
};

const { getSetting, onSettings, saveSettings } = await import('../assets/js/modules/settings.js');

test('the account copy is cached for instant reads, per user', async () => {
  assert.equal(getSetting('goals'), undefined);
  const got = await new Promise(resolve => onSettings(resolve));
  assert.equal(got.goals[0].name, 'Goa');
  assert.equal(getSetting('goals')[0].name, 'Goa');
  globalThis.__firebase.user = { uid: 'someone-else' };
  assert.equal(getSetting('goals'), undefined);
  globalThis.__firebase.user = { uid: 'me' };
});

test('saving replaces only the given field, in the cache at once and in Firestore', async () => {
  await saveSettings({ budget: { total: 20000, cats: {} } });
  assert.deepEqual(writes.at(-1), { ref: { coll: 'settings', id: 'me' }, data: { budget: { total: 20000, cats: {} } }, opts: { mergeFields: ['budget'] } });
  assert.equal(getSetting('budget').total, 20000);
  assert.equal(getSetting('goals')[0].name, 'Goa');
});
