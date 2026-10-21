// Run: node --test tests/ — restoring a large backup must work and never duplicate
import { register } from 'node:module';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

register('./stub-loader.mjs', import.meta.url);

// Every commit() records the refs it wrote; commit number failCommitNumber throws once
const fb = globalThis.__firebase = {
  user: { uid: 'me' },
  commits: [],
  failCommitNumber: 0,
  writeBatch() {
    const sets = [];
    return {
      set: (ref, data) => sets.push({ ref, data }),
      commit: async () => {
        if (fb.commits.length + 1 === fb.failCommitNumber) { fb.failCommitNumber = 0; throw new Error('unavailable'); }
        fb.commits.push(sets);
      },
    };
  },
};

let fileText = '';
const statuses = [];
globalThis.document = {
  addEventListener: () => {},
  getElementById: id => {
    if (id === 'backup-file-input') return { files: [{ text: async () => fileText }] };
    if (id === 'backup-status') return { set textContent(v) { statuses.push(v); }, classList: { remove() {}, add() {} } };
    return null;
  },
};
globalThis.window = { location: { reload() {} } };
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = () => 0; // skip the 1.5s page reload after import

await import('../assets/js/modules/backup.js');
globalThis.setTimeout = realSetTimeout;

const expense = (n, extra = {}) => ({ id: `exp${n}`, uid: 'me', amount: 10, category: 'Food & Dining', date: '2026-10-21', ...extra });
const backup = (expenses, income = [], debts = []) => JSON.stringify({ version: '1.0', expenses, income, debts });
const refs = () => fb.commits.flat().map(w => `${w.ref.coll}/${w.ref.id}`);

beforeEach(() => {
  fb.commits = [];
  fb.failCommitNumber = 0;
  statuses.length = 0;
});

test('1,201 items are written in batches of at most 500', async () => {
  fileText = backup(Array.from({ length: 1201 }, (_, i) => expense(i)));

  await window.handleImportClick();

  assert.deepEqual(fb.commits.map(c => c.length), [500, 500, 201]);
  assert.equal(statuses.at(-1), '✅ Imported 1201 items successfully!');
});

test('exported ids are reused, so restoring twice writes the same documents', async () => {
  fileText = backup([expense(1), expense(2)]);
  await window.handleImportClick();
  const first = refs();
  fb.commits = [];
  await window.handleImportClick();

  assert.deepEqual(first, ['expenses/exp1', 'expenses/exp2']);
  assert.deepEqual(refs(), first);
});

test('a retry after a failed chunk overwrites the saved chunk instead of duplicating it', async () => {
  fileText = backup(Array.from({ length: 600 }, (_, i) => expense(i)));
  fb.failCommitNumber = 2; // second chunk fails

  await window.handleImportClick();
  assert.equal(fb.commits.length, 1);
  assert.equal(statuses.at(-1), '❌ Import failed. Please try again.');

  await window.handleImportClick();
  const all = refs();
  assert.equal(new Set(all).size, 600); // 500 rewritten + 100 new, still 600 distinct docs
});

test('records without a usable id get a new id; other accounts are skipped', async () => {
  fileText = backup([expense(1, { id: undefined }), expense(2, { id: 'bad/id' }), expense(3, { uid: 'someone-else' })]);

  await window.handleImportClick();

  assert.deepEqual(refs(), ['expenses/AUTO', 'expenses/AUTO']);
});
