// Run: node --test tests/*.test.mjs — Daily spending aggregation and local month layout
process.env.TZ = 'Asia/Kolkata';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateDailySpending,
  buildCalendarMonth,
  makeCalendarDateKey,
  scaleDailySpending,
  shiftCalendarMonth,
} from '../assets/js/modules/spending-calendar.js';

test('aggregates positive spending by stored local date and excludes savings and invalid amounts', () => {
  const expenses = [
    { id: 'a', date: '2026-10-22', amount: 240, category: 'Food & Dining' },
    { id: 'b', date: '2026-10-22', amount: '180', category: 'Transport' },
    { id: 'c', date: '2026-10-21', amount: 1299, category: 'Shopping' },
    { id: 'd', date: '2026-10-22', amount: 9999, category: 'Savings & Investments' },
    { id: 'e', date: '2026-09-30', amount: 500, category: 'Food & Dining' },
    { id: 'f', date: '2026-11-01', amount: 500, category: 'Food & Dining' },
    { id: 'g', date: '2026-10-22', amount: 0, category: 'Food & Dining' },
    { id: 'h', date: '2026-10-22', amount: -1, category: 'Food & Dining' },
    { id: 'i', date: '2026-10-22', amount: 'NaN', category: 'Food & Dining' },
    { id: 'j', date: '2026-10-22', amount: Infinity, category: 'Food & Dining' },
    { id: 'k', date: '2026-10-22', amount: 20, category: 'Subscription' },
    { id: 'l', date: '2026-10-22', amount: 20, category: 'Investment' },
    { id: 'm', date: '2026-10-32', amount: 20, category: 'Food & Dining' },
  ];

  const { totals, transactionsByDate } = aggregateDailySpending(expenses, 2026, 9);
  assert.deepEqual([...totals], [['2026-10-22', 440], ['2026-10-21', 1299]]);
  assert.deepEqual(transactionsByDate.get('2026-10-22').map(expense => expense.id), ['a', 'b', 'k']);
  assert.equal(transactionsByDate.has('2026-10-21'), true);
});

test('empty input and current-month cutoff produce no fabricated future spending', () => {
  assert.deepEqual([...aggregateDailySpending([], 2026, 9).totals], []);

  const expenses = [
    { date: '2026-10-21', amount: 50, category: 'Food & Dining' },
    { date: '2026-10-22', amount: 75, category: 'Food & Dining' },
    { date: '2026-10-23', amount: 100, category: 'Food & Dining' },
  ];
  const { totals } = aggregateDailySpending(expenses, 2026, 9, { throughDate: '2026-10-22' });
  assert.deepEqual([...totals], [['2026-10-21', 50], ['2026-10-22', 75]]);
});

test('month grid uses Monday-first alignment and includes complete five- or six-week rows', () => {
  const mondayStart = buildCalendarMonth(2024, 0);
  assert.equal(mondayStart.leadingBlanks, 0);
  assert.equal(mondayStart.cells[0].dateKey, '2024-01-01');

  const sundayStart = buildCalendarMonth(2026, 10);
  assert.equal(sundayStart.leadingBlanks, 6);
  assert.equal(sundayStart.cells[6].dateKey, '2026-11-01');

  assert.equal(buildCalendarMonth(2026, 1).daysInMonth, 28);
  assert.equal(buildCalendarMonth(2024, 1).daysInMonth, 29);
  assert.equal(buildCalendarMonth(2026, 3).daysInMonth, 30);
  assert.equal(buildCalendarMonth(2026, 7).daysInMonth, 31);
  assert.equal(buildCalendarMonth(2026, 7).cells.length, 42);
  assert.equal(makeCalendarDateKey(2026, 0, 1), '2026-01-01');
});

test('month navigation crosses year boundaries', () => {
  assert.deepEqual(shiftCalendarMonth(2026, 0, -1), { year: 2025, monthIndex: 11 });
  assert.deepEqual(shiftCalendarMonth(2025, 11, 1), { year: 2026, monthIndex: 0 });
});

test('daily markers use bounded square-root sizes and month-relative intensity ranks', () => {
  const markers = scaleDailySpending(new Map([
    ['low', 100],
    ['mid', 400],
    ['high', 1600],
    ['same-high', 1600],
  ]));

  assert.equal(markers.get('low').diameter, 23);
  assert.equal(markers.get('mid').diameter, 27);
  assert.equal(markers.get('high').diameter, 36);
  assert.equal(markers.get('low').intensity, 1);
  assert.equal(markers.get('mid').intensity, 3);
  assert.equal(markers.get('high').intensity, 4);
  assert.equal(markers.get('same-high').intensity, 4);
  assert.equal(scaleDailySpending(new Map([['only', 5]])).get('only').intensity, 2);
  assert.equal(scaleDailySpending(new Map([['zero', 0]])).size, 0);
});
