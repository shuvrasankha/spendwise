// Run: node --test tests/ — dates must follow the user's calendar, not UTC
process.env.TZ = 'Asia/Kolkata'; // UTC+5:30, where toISOString() is a day early before 05:30

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { todayStr } from '../assets/js/utils/helpers.js';

test('local midnight on the 1st stays on the 1st', () => {
  const monthStart = new Date(2026, 9, 1); // 1 Oct 2026, 00:00 IST
  assert.equal(monthStart.toISOString().slice(0, 10), '2026-09-30'); // the old bug
  assert.equal(todayStr(monthStart), '2026-10-01');
});

test('just after midnight is still today, not yesterday', () => {
  assert.equal(todayStr(new Date(2026, 9, 21, 2, 0)), '2026-10-21'); // 02:00 IST
});

test('no argument means now', () => {
  const now = new Date();
  assert.equal(todayStr(), todayStr(now));
});
