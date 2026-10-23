// Run: node --test tests/ — money figures count to their value, or jump there when motion is unwelcome
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countTo } from '../assets/js/utils/helpers.js';

let reduce = false;
let now = 0;
const frames = [];
globalThis.window = { matchMedia: () => ({ matches: reduce }) };
globalThis.document = { hidden: false };
globalThis.performance = { now: () => now };
globalThis.requestAnimationFrame = fn => frames.push(fn);
globalThis.cancelAnimationFrame = () => {};
const run = ms => { now = ms; const due = frames.splice(0); due.forEach(fn => fn(ms)); };
const fmt = n => String(Math.round(n));
const el = () => ({ dataset: {}, textContent: '' });

test('eases from the shown value and lands exactly on the new one', () => {
  const e = el();
  e.dataset.value = '100';
  countTo(e, 500, fmt);
  run(350);
  assert.ok(+e.textContent > 100 && +e.textContent < 500, `midway: ${e.textContent}`);
  run(700);
  assert.equal(e.textContent, '500');
  assert.equal(frames.length, 0);
});

test('jumps straight there with reduced motion or no change', () => {
  reduce = true;
  const e = el();
  countTo(e, 42, fmt);
  assert.equal(e.textContent, '42');
  reduce = false;
  countTo(e, 42, n => `₹${n}`); // same value, new currency: just redraws
  assert.equal(e.textContent, '₹42');
  assert.equal(frames.length, 0);
});
