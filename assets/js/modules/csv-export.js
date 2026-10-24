// csv-export.js — History's Export: entries as a CSV file that opens cleanly in Excel, Numbers and
// Google Sheets. One set of columns for expenses and income alike (a Type column tells them apart),
// UTF-8 with a byte-order mark so ₹ and non-English text survive Excel, and text that a spreadsheet
// would run as a formula (=, +, -, @) is defused.

const FORMULA = /^[=+\-@\t\r]/;

// One CSV field: quoted only when it has to be
export function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (FORMULA.test(s)) s = "'" + s; // "=HYPERLINK(…)" in a description must stay text
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const text = v => (v && v !== '-' ? v : '');
const COLUMNS = [
  ['Date', e => e.row.date],
  ['Type', e => (e.kind === 'income' ? 'Income' : 'Expense')],
  ['Category or source', e => (e.kind === 'income' ? e.row.source : e.row.category)],
  ['Description', e => (e.kind === 'income' ? '' : text(e.row.description))],
  ['Payment', e => (e.kind === 'income' ? e.row.paymentType : e.row.payment)],
  ['Card or bank', e => (e.kind === 'income' ? e.row.bank : e.row.cardName)],
  ['Tags', e => (e.row.tags || []).map(t => '#' + t).join(' ')],
  ['Notes', e => text(e.row.notes)],
];

const sum = (entries, kind) => entries.filter(e => e.kind === kind).reduce((s, e) => s + (Number(e.row.amount) || 0), 0);

// entries: [{ kind: 'expense' | 'income', row }], already in the order wanted. total adds a line per
// kind present (and Net when both are), under a blank line so a sort or filter in the sheet skips them.
export function buildCsv(entries, { currency = 'INR', total = false } = {}) {
  const lines = [[...COLUMNS.map(([h]) => h), `Amount (${currency})`].map(csvCell).join(',')];
  for (const e of entries) {
    lines.push([...COLUMNS.map(([, get]) => csvCell(get(e))), (Number(e.row.amount) || 0).toFixed(2)].join(','));
  }
  if (total && entries.length) {
    const blank = COLUMNS.length - 1;
    const line = (label, amount) => [label, ...Array(blank).fill(''), amount.toFixed(2)].join(',');
    const spent = sum(entries, 'expense'), earned = sum(entries, 'income');
    const kinds = new Set(entries.map(e => e.kind));
    lines.push('');
    if (kinds.has('expense')) lines.push(line('Total spent', spent));
    if (kinds.has('income')) lines.push(line('Total income', earned));
    if (kinds.size === 2) lines.push(line('Net', earned - spent));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// "SpendWise_Expenses_2026-10-01_to_2026-10-24.csv", or "…_all-time_<today>.csv" with no dates
export function exportFileName(what, from, to, today) {
  const span = from || to ? `${from || 'start'}_to_${to || today}` : `all-time_${today}`;
  return `SpendWise_${what}_${span}.csv`;
}
