// history-data.js — Pure filtering for the History page (no DOM, no Firebase), so it can be tested.
// Dates are local 'YYYY-MM-DD' strings, compared as text.

import { todayStr } from '../utils/helpers.js';

// Start and end of a "Dates" choice ("" = open-ended); `custom` is { from, to } from the date inputs
export function historyRange(key, now = new Date(), custom = {}) {
  const y = now.getFullYear(), m = now.getMonth(), today = todayStr(now);
  const day = (Y, M, D) => todayStr(new Date(Y, M, D)); // Date rolls month -1 into last December
  switch (key) {
    case 'month': return [day(y, m, 1), today];
    case 'lastMonth': return [day(y, m - 1, 1), day(y, m, 0)];
    case 'quarter': return [day(y, m - 2, 1), today];
    case 'year': return [day(y, 0, 1), today];
    case 'custom': return [custom.from || '', custom.to || ''];
    default: return ['', ''];
  }
}

// Rows within the dates, in the chosen kinds (categories or sources), matching the search, sorted.
// kindOf(row) and textOf(row) come from the tab: expenses and income keep different fields.
export function filterHistory(rows, { from = '', to = '', kinds = new Set(), kindOf, q = '', textOf, sort = 'newest' }) {
  q = q.toLowerCase().trim();
  const out = rows.filter(r =>
    (!from || r.date >= from) && (!to || r.date <= to) &&
    (!kinds.size || kinds.has(kindOf(r))) &&
    (!q || textOf(r).some(v => v && String(v).toLowerCase().includes(q))));
  if (sort === 'largest') return out.sort((a, b) => b.amount - a.amount);
  if (sort === 'oldest') return out.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return out.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

// Day heading: Today, Yesterday, "Mon, 19 Oct", or "Tue, 30 Dec 2025" outside this year
export function historyDay(ds, now = new Date()) {
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (ds === todayStr(now)) return 'Today';
  if (ds === todayStr(yesterday)) return 'Yesterday';
  const d = new Date(ds + 'T00:00:00');
  const opts = { weekday: 'short', day: 'numeric', month: 'short' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-IN', opts);
}
