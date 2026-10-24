// Run: node --test tests/*.test.mjs — History's Export: a CSV that spreadsheets open cleanly and safely
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, buildCsv, exportFileName } from '../assets/js/modules/csv-export.js';

const lunch = { date: '2026-10-22', amount: 240, category: 'Food & Dining', description: 'Lunch, "the usual"', payment: 'Card', cardName: 'HDFC', tags: ['work', 'goa2026'], notes: 'with team\nsplit later' };
const salary = { date: '2026-10-01', amount: 85000, source: 'Salary', paymentType: 'Bank transfer', bank: 'SBI', notes: '' };

test('fields are quoted only when needed, and quotes are doubled', () => {
  assert.equal(csvCell('Groceries'), 'Groceries');
  assert.equal(csvCell('Lunch, "the usual"'), '"Lunch, ""the usual"""');
  assert.equal(csvCell('line one\nline two'), '"line one\nline two"');
  assert.equal(csvCell(undefined), '');
});

test('text a spreadsheet would run as a formula stays text', () => {
  assert.equal(csvCell('=HYPERLINK("http://x","click")'), `"'=HYPERLINK(""http://x"",""click"")"`);
  for (const s of ['+1', '-2', '@SUM(A1)']) assert.equal(csvCell(s), "'" + s);
});

test('one set of columns for expenses and income, with a byte-order mark and CRLF lines', () => {
  const csv = buildCsv([{ kind: 'expense', row: lunch }, { kind: 'income', row: salary }], { currency: 'INR' });
  assert.ok(csv.startsWith('﻿Date,Type,Category or source,Description,Payment,Card or bank,Tags,Notes,Amount (INR)\r\n'));
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[1], '2026-10-22,Expense,Food & Dining,"Lunch, ""the usual""",Card,HDFC,#work #goa2026,"with team\nsplit later",240.00');
  assert.equal(lines[2], '2026-10-01,Income,Salary,,Bank transfer,SBI,,,85000.00');
  assert.equal(lines.length, 4); // header, two rows, and the empty string after the last CRLF
});

test('a "-" description (no description) is left blank, and the currency names the amount column', () => {
  const csv = buildCsv([{ kind: 'expense', row: { ...lunch, description: '-', notes: '', tags: [] } }], { currency: 'USD' });
  assert.ok(csv.includes('Amount (USD)'));
  assert.ok(csv.includes('2026-10-22,Expense,Food & Dining,,Card,HDFC,,,240.00'));
});

test('totals: per kind present, and Net when both are, under a blank line', () => {
  const both = buildCsv([{ kind: 'expense', row: lunch }, { kind: 'income', row: salary }], { total: true }).trimEnd().split('\r\n');
  assert.deepEqual(both.slice(-4), ['', 'Total spent,,,,,,,,240.00', 'Total income,,,,,,,,85000.00', 'Net,,,,,,,,84760.00']);
  const spent = buildCsv([{ kind: 'expense', row: lunch }], { total: true }).trimEnd().split('\r\n');
  assert.deepEqual(spent.slice(-2), ['', 'Total spent,,,,,,,,240.00']);
  assert.ok(!buildCsv([], { total: true }).includes('Total'));
});

test('file names say what and which dates', () => {
  assert.equal(exportFileName('Expenses', '2026-10-01', '2026-10-24', '2026-10-24'), 'SpendWise_Expenses_2026-10-01_to_2026-10-24.csv');
  assert.equal(exportFileName('Income', '', '', '2026-10-24'), 'SpendWise_Income_all-time_2026-10-24.csv');
});
