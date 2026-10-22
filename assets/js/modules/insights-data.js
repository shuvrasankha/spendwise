// insights-data.js — Pure calculations for the Insights page (no DOM, no Firebase), so they can be tested.
// All dates are local 'YYYY-MM-DD' strings, compared as text.

import { isSpending } from '../utils/helpers.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT = MONTHS.map(m => m.slice(0, 3));
const DAY = 864e5;

const pad = n => String(n).padStart(2, '0');
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => new Date(s + 'T00:00:00'); // local midnight, not UTC
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / DAY) + 1; // inclusive
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
const monthEnd = (y, m) => new Date(y, m + 1, 0).getDate(); // m is 0-based

export function shortDate(s) {
  const d = parse(s);
  return `${d.getDate()} ${SHORT[d.getMonth()]}`;
}

// The selected period plus the matching period before it, for comparison.
// "To date" periods end today; the comparison covers the same number of days.
export function periodRange(period, today = new Date(), custom = {}) {
  const y = today.getFullYear(), m = today.getMonth(), d = today.getDate();
  const t = ymd(today);
  let start, end, label, prevStart, prevEnd, prevLabel, monthDays = null;

  if (period === 'month') {
    start = `${y}-${pad(m + 1)}-01`; end = t;
    label = `${MONTHS[m]} ${y} (1–${d} ${SHORT[m]})`;
    monthDays = monthEnd(y, m);
    const py = m === 0 ? y - 1 : y, pm = m === 0 ? 11 : m - 1;
    prevStart = `${py}-${pad(pm + 1)}-01`;
    prevEnd = `${py}-${pad(pm + 1)}-${pad(Math.min(d, monthEnd(py, pm)))}`;
    prevLabel = `the same days of ${MONTHS[pm]}`;
  } else if (period === 'lastMonth') {
    const ly = m === 0 ? y - 1 : y, lm = m === 0 ? 11 : m - 1;
    start = `${ly}-${pad(lm + 1)}-01`; end = `${ly}-${pad(lm + 1)}-${pad(monthEnd(ly, lm))}`;
    label = `${MONTHS[lm]} ${ly}`;
    const py = lm === 0 ? ly - 1 : ly, pm = lm === 0 ? 11 : lm - 1;
    prevStart = `${py}-${pad(pm + 1)}-01`; prevEnd = `${py}-${pad(pm + 1)}-${pad(monthEnd(py, pm))}`;
    prevLabel = MONTHS[pm];
  } else if (period === 'quarter') { // last 3 months: this month so far + the two before
    const s = new Date(y, m - 2, 1);
    start = ymd(s); end = t;
    label = `Last 3 months (${shortDate(start)} – ${shortDate(end)})`;
  } else if (period === 'year') {
    start = `${y}-01-01`; end = t;
    label = `${y} so far`;
    prevStart = `${y - 1}-01-01`;
    prevEnd = `${y - 1}-${pad(m + 1)}-${pad(Math.min(d, monthEnd(y - 1, m)))}`;
    prevLabel = `the same part of ${y - 1}`;
  } else if (period === 'custom') {
    start = custom.start; end = custom.end;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '')) return { error: 'Pick both a start and an end date.' };
    if (start > end) return { error: 'The start date is after the end date.' };
    label = `${shortDate(start)} – ${shortDate(end)} ${end.slice(0, 4)}`;
  } else {
    return { error: 'Unknown period.' };
  }

  if (!prevStart) { // quarter / custom: the same number of days right before
    const len = daysBetween(start, end);
    prevEnd = addDays(start, -1);
    prevStart = addDays(prevEnd, -(len - 1));
    prevLabel = 'the period before';
  }
  // Days that have happened, so averages don't divide by future days
  const elapsedDays = daysBetween(start, end < t ? end : t);
  return { period, start, end, label, prevStart, prevEnd, prevLabel, elapsedDays: Math.max(elapsedDays, 1), monthDays };
}

const inRange = (date, a, b) => !!date && date >= a && date <= b;
const sum = list => list.reduce((s, x) => s + x.amount, 0);
const pct = (now, before) => (before > 0 ? ((now - before) / before) * 100 : null);

export function summarize({ expenses = [], income = [], debts = [] }, r) {
  const inPeriod = expenses.filter(e => inRange(e.date, r.start, r.end));
  const exp = inPeriod.filter(isSpending);
  const inc = income.filter(i => inRange(i.date, r.start, r.end));
  const prevExp = expenses.filter(e => isSpending(e) && inRange(e.date, r.prevStart, r.prevEnd));

  const spent = sum(exp), earned = sum(inc), prevSpent = sum(prevExp);
  const invested = sum(inPeriod) - spent;
  const byCat = {}, prevByCat = {};
  exp.forEach(e => { byCat[e.category] = (byCat[e.category] || 0) + e.amount; });
  prevExp.forEach(e => { prevByCat[e.category] = (prevByCat[e.category] || 0) + e.amount; });

  const categories = Object.entries(byCat)
    .map(([category, amount]) => ({
      category, amount,
      share: spent > 0 ? (amount / spent) * 100 : 0,
      prevAmount: prevByCat[category] || 0,
      change: pct(amount, prevByCat[category] || 0),
    }))
    .sort((a, b) => b.amount - a.amount);

  // Debts are a current position, not a period total: every unsettled debt counts
  const active = debts.filter(dbt => !dbt.settled);
  const youOwe = sum(active.filter(dbt => dbt.type === 'i-owe'));
  const owedToYou = sum(active.filter(dbt => dbt.type === 'they-owe'));

  const dailyAvg = spent / r.elapsedDays;
  return {
    spent, earned, invested, saved: earned - spent, // what was invested counts as saved
    savingsRate: earned > 0 ? ((earned - spent) / earned) * 100 : null,
    txCount: exp.length, incomeCount: inc.length,
    dailyAvg,
    projection: r.monthDays ? dailyAvg * r.monthDays : null,
    prevSpent, spendChange: pct(spent, prevSpent),
    categories,
    biggest: [...exp].sort((a, b) => b.amount - a.amount).slice(0, 3)
      .map(e => ({ category: e.category, amount: e.amount, date: e.date })),
    debts: {
      youOwe, owedToYou, activeCount: active.length,
      settledInPeriod: debts.filter(dbt => dbt.settled && inRange(dbt.settledDate, r.start, r.end)).length,
    },
  };
}

export const hasData = s => s.txCount > 0 || s.incomeCount > 0 || s.invested > 0 || s.debts.activeCount > 0;

// Compact, number-only facts for the AI. No descriptions, notes or names leave the device.
export function factsText(s, r, money) {
  const lines = [
    `PERIOD: ${r.label}${r.monthDays ? ` — ${r.elapsedDays} of ${r.monthDays} days so far` : ''}`,
    `SPENT: ${money(s.spent)} in ${s.txCount} expenses (${money(s.dailyAvg)} per day)`,
    `INCOME: ${s.incomeCount ? `${money(s.earned)} from ${s.incomeCount} entries` : 'none recorded'}`,
  ];
  if (s.invested > 0) lines.push(`INVESTED: ${money(s.invested)} (counted as saved, not as spending)`);
  if (s.savingsRate !== null) lines.push(`SAVED: ${money(s.saved)} (${s.savingsRate.toFixed(1)}% of income${s.invested > 0 ? ', including what was invested' : ''})`);
  if (s.projection !== null) lines.push(`ON TRACK TO SPEND THIS MONTH: ${money(s.projection)}`);
  lines.push(`COMPARED WITH ${r.prevLabel.toUpperCase()}: spent ${money(s.prevSpent)}` +
    (s.spendChange !== null ? ` (${s.spendChange >= 0 ? '+' : ''}${s.spendChange.toFixed(0)}%)` : ''));
  if (s.categories.length) {
    lines.push('BY CATEGORY: ' + s.categories.map(c =>
      `${c.category} ${money(c.amount)} (${c.share.toFixed(0)}%` +
      (c.change !== null ? `, ${c.change >= 0 ? '+' : ''}${c.change.toFixed(0)}% vs before` : c.prevAmount === 0 ? ', new' : '') + ')'
    ).join('; '));
  }
  if (s.biggest.length) lines.push('BIGGEST EXPENSES: ' + s.biggest.map(b => `${b.category} ${money(b.amount)} on ${shortDate(b.date)}`).join('; '));
  lines.push(s.debts.activeCount
    ? `DEBTS NOW: user owes ${money(s.debts.youOwe)}; others owe the user ${money(s.debts.owedToYou)} (${s.debts.activeCount} unsettled)`
    : 'DEBTS NOW: none unsettled');
  return lines.join('\n');
}

// Minimal, safe markdown for AI answers: escape everything, then add
// headings (#..###), bullet and numbered lists, **bold**, *italic* and paragraphs.
export function renderMarkdown(text) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
  const out = [];
  let list = null, para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map(i => `<li>${i}</li>`).join('')}</${list.tag}>`); list = null; } };

  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    let m;
    if (!line) { flushPara(); flushList(); continue; }
    if ((m = line.match(/^#{1,6}\s+(.*)$/))) { flushPara(); flushList(); out.push(`<h4>${inline(m[1])}</h4>`); continue; }
    if ((m = line.match(/^[-*•]\s+(.*)$/)) || (m = line.match(/^\d+[.)]\s+(.*)$/))) {
      const tag = /^\d/.test(line) ? 'ol' : 'ul';
      flushPara();
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(inline(m[1]));
      continue;
    }
    flushList();
    para.push(inline(line));
  }
  flushPara(); flushList();
  return out.join('') || '<p>No response.</p>';
}
