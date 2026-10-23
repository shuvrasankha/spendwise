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

// The tag a search names, as '#goa2026' (lowercase, without '#'), or null for a plain search
export const searchTag = q => /^#\S+$/.test(q.trim()) ? q.trim().slice(1).toLowerCase() : null;

// Rows within the dates, in the chosen kinds (categories or sources), matching the search, sorted.
// kindOf(row), textOf(row) and tagsOf(row) come from the tab: expenses and income keep different fields.
// A '#tag' search matches that tag exactly, for a trip's or event's entries.
export function filterHistory(rows, { from = '', to = '', kinds = new Set(), kindOf, q = '', textOf, tagsOf, sort = 'newest' }) {
  const tag = tagsOf && searchTag(q);
  q = q.toLowerCase().trim();
  const matches = r => tag
    ? tagsOf(r).some(t => String(t).toLowerCase() === tag)
    : textOf(r).some(v => v && String(v).toLowerCase().includes(q));
  const out = rows.filter(r =>
    (!from || r.date >= from) && (!to || r.date <= to) &&
    (!kinds.size || kinds.has(kindOf(r))) &&
    (!q || matches(r)));
  if (sort === 'largest') return out.sort((a, b) => b.amount - a.amount);
  if (sort === 'oldest') return out.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return out.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

// [kind, total] largest first: where a trip's money went
export function totalsBy(rows, kindOf) {
  const totals = {};
  rows.forEach(r => { const k = kindOf(r); totals[k] = (totals[k] || 0) + r.amount; });
  return Object.entries(totals).sort((a, b) => b[1] - a[1]);
}

// Tags in use, most used first, as written the first time they were seen
export function tagsInUse(rows, tagsOf) {
  const seen = new Map();
  rows.forEach(r => tagsOf(r).forEach(t => {
    const k = String(t).toLowerCase();
    seen.set(k, { tag: seen.get(k)?.tag ?? String(t), n: (seen.get(k)?.n || 0) + 1 });
  }));
  return [...seen.values()].sort((a, b) => b.n - a.n).map(x => x.tag);
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
