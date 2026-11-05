// Run: node --test tests/*.test.mjs — restoring a large backup must work and never duplicate
import { register } from 'node:module';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

register('./stub-loader.mjs', import.meta.url);

// Every commit() records the refs it wrote; commit number failCommitNumber throws once
const fb = globalThis.__firebase = {
  user: { uid: 'me' },
  commits: [],
  docs: new Map(),
  failCommitNumber: 0,
  writeBatch() {
    const sets = [];
    return {
      set: (ref, data, options) => sets.push({ ref, data, options }),
      commit: async () => {
        if (fb.commits.length + 1 === fb.failCommitNumber) { fb.failCommitNumber = 0; throw new Error('unavailable'); }
        fb.commits.push(sets);
        for (const { ref, data, options } of sets) {
          const key = `${ref.coll}/${ref.id}`;
          fb.docs.set(key, options?.merge ? { ...fb.docs.get(key), ...data } : data);
        }
      },
    };
  },
  async runTransaction(_db, callback) {
    const writes = [];
    const transaction = {
      get: async ref => {
        const data = fb.docs.get(`${ref.coll}/${ref.id}`);
        return { exists: () => data !== undefined, data: () => data };
      },
      set: (ref, data) => writes.push({ kind: 'set', ref, data }),
      update: (ref, data) => writes.push({ kind: 'update', ref, data }),
    };
    const result = await callback(transaction);
    for (const write of writes) {
      const key = `${write.ref.coll}/${write.ref.id}`;
      fb.docs.set(key, write.kind === 'set' ? write.data : { ...fb.docs.get(key), ...write.data });
    }
    return result;
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
  fb.docs.clear();
  fb.failCommitNumber = 0;
  statuses.length = 0;
});

test('1,201 items are written in batches of at most 500', async () => {
  fileText = backup(Array.from({ length: 1201 }, (_, i) => expense(i)));

  await window.handleImportClick();

  assert.deepEqual(fb.commits.map(c => c.length), [500, 500, 201]);
  assert.equal(statuses.at(-1), 'Imported 1201 items successfully!');
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
  assert.equal(statuses.at(-1), 'Import failed. Please try again.');

  await window.handleImportClick();
  const all = refs();
  assert.equal(new Set(all).size, 600); // 500 rewritten + 100 new, still 600 distinct docs
});

test('records without a usable id get a new id; other accounts are skipped', async () => {
  fileText = backup([expense(1, { id: undefined }), expense(2, { id: 'bad/id' }), expense(3, { uid: 'someone-else' })]);

  await window.handleImportClick();

  assert.deepEqual(refs(), ['expenses/AUTO', 'expenses/AUTO']);
});

test('holdings come back with their ids and only the fields the rules allow; older backups have none', async () => {
  const fund = { id: 'h1', uid: 'me', name: 'Axis Bluechip', kind: 'mf', value: 12000, valueDate: '2026-10-01', goalId: 'g1', extra: 'x' };
  fileText = JSON.stringify({ version: '1.0', expenses: [expense(1, { holdingId: 'h1' })], income: [], debts: [],
    holdings: [fund, { id: 'h2', uid: 'me', name: 'Crypto', kind: 'crypto' }, { id: 'h3', uid: 'someone-else', name: 'FD', kind: 'fd' }] });

  await window.handleImportClick();

  assert.deepEqual(refs(), ['holdings/h1', 'expenses/exp1']);
  const { createdAt, ...saved } = fb.commits[0][0].data;
  assert.deepEqual(saved, { uid: 'me', name: 'Axis Bluechip', kind: 'mf', value: 12000, valueDate: '2026-10-01', goalId: 'g1' });
  assert.equal(fb.commits[0][1].data.holdingId, 'h1');
});

test('credit-card backups restore each payment once and replay refunds without changing totals', async () => {
  const purchase = expense(1, { payment: 'Credit Card', creditCardId: 'card-1' });
  fileText = JSON.stringify({
    version: '1.0',
    expenses: [purchase],
    income: [],
    debts: [],
    creditCards: [{ id: 'card-1', uid: 'me', name: 'Daily', issuer: 'Bank' }],
    cardPayments: [{
      id: 'payment-1', idempotencyKey: 'payment-1', uid: 'me', creditCardId: 'card-1',
      amount: 10, paymentDate: '2026-10-25', paymentType: 'full_current_outstanding',
    }],
    cardRefunds: [{
      id: 'refund-1', uid: 'me', creditCardId: 'card-1', originalExpenseId: 'exp1',
      amount: 4, refundDate: '2026-10-22', description: 'Returned',
    }],
  });

  await window.handleImportClick();
  assert.equal(fb.commits.flat().filter(write => write.ref.coll === 'cardPayments').length, 1);
  assert.equal(fb.docs.get('expenses/exp1').refundedTotal, 4);
  assert.equal(fb.docs.get('cardRefunds/refund-1').amount, 4);

  await window.handleImportClick();
  assert.equal(fb.commits.flat().filter(write => write.ref.coll === 'cardPayments').length, 2);
  assert.equal(fb.docs.get('expenses/exp1').refundedTotal, 4);
});
