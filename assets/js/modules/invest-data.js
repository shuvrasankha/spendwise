// invest-data.js — Investments: holdings (a fund, an FD, a PPF account) and the money put into them.
// A holding is a doc in holdings/{id}: { name, kind, value?, valueDate?, goalId? }. Money put in is
// an expense in 'Savings & Investments' (so every spending total keeps leaving it out) with
// description = the holding's name and holdingId. A SIP is that entry repeating monthly, so the
// Dashboard's "Due this month" offers it like any other repeating payment.
// Pure functions only, so they can be tested (tests/invest.test.mjs).
import { isSpending, recurringKey, upcomingBills, todayStr } from '../utils/helpers.js';

export const HOLDING_KINDS = [
  { id: 'mf', label: 'Mutual fund', icon: 'line-chart' },
  { id: 'stocks', label: 'Stocks', icon: 'candlestick-chart' },
  { id: 'fd', label: 'Fixed deposit', icon: 'landmark' },
  { id: 'rd', label: 'Recurring deposit', icon: 'calendar-clock' },
  { id: 'ppf', label: 'PPF', icon: 'shield-check' },
  { id: 'nps', label: 'NPS', icon: 'umbrella' },
  { id: 'epf', label: 'EPF', icon: 'briefcase' },
  { id: 'gold', label: 'Gold', icon: 'gem' },
  { id: 'other', label: 'Other', icon: 'piggy-bank' },
];
export const kindOf = id => HOLDING_KINDS.find(k => k.id === id) || HOLDING_KINDS[HOLDING_KINDS.length - 1];

export const isInvestment = e => !!e && !isSpending(e);
const nameKey = s => String(s || '').trim().toLowerCase();

// The holding an investment entry belongs to: its holdingId, or, for an entry made before holdings
// (or from the expense form, SMS or a CSV), a holding with the same name as its description
export function holdingOf(e, holdings) {
  if (!isInvestment(e)) return null;
  if (e.holdingId) {
    const h = holdings.find(x => x.id === e.holdingId);
    if (h) return h;
  }
  const key = nameKey(e.description);
  return (key && holdings.find(h => nameKey(h.name) === key)) || null;
}

// Every holding with what was put in, what it is worth and its SIP, plus entries in no holding.
// Worth: the value the user last gave (on valueDate) plus what was put in after that day; with no
// value given, what was put in. gain is null until a value is given (nothing to compare with).
export function portfolio(holdings, expenses, today = todayStr()) {
  const month = today.slice(0, 7), year = today.slice(0, 4);
  const entries = expenses.filter(e => isInvestment(e) && e.date && e.date <= today);
  const bills = upcomingBills(expenses.filter(e => e && e.date && e.date <= today), today);
  const rows = holdings.map(h => ({ holding: h, entries: [] }));
  const other = [];
  for (const e of entries) {
    const h = holdingOf(e, holdings);
    if (h) rows.find(r => r.holding === h).entries.push(e);
    else other.push(e);
  }
  const sum = list => list.reduce((s, e) => s + e.amount, 0);

  const out = rows.map(({ holding: h, entries: list }) => {
    const invested = sum(list);
    const valued = typeof h.value === 'number' && h.value >= 0 && !!h.valueDate;
    const value = valued ? h.value + sum(list.filter(e => e.date > h.valueDate)) : invested;
    const gain = valued ? value - invested : null;
    // A SIP: the newest entry carrying a repeat field is the series' template (helpers.js)
    const template = list.filter(e => e.repeat).sort((a, b) => b.date.localeCompare(a.date))[0];
    const sip = template?.repeat === 'monthly' ? bills.find(b => b.key === recurringKey(template)) : null;
    return {
      holding: h, invested, value, valued, gain,
      gainPct: valued && invested > 0 ? (gain / invested) * 100 : null,
      sip: sip ? { amount: template.amount, due: sip.due, template } : null,
      last: list.reduce((m, e) => (e.date > m ? e.date : m), ''),
      count: list.length,
    };
  }).sort((a, b) => b.value - a.value || a.holding.name.localeCompare(b.holding.name));

  const invested = sum(entries);
  const value = out.reduce((s, r) => s + r.value, 0) + sum(other);
  const valuedRows = out.filter(r => r.valued);
  const gain = valuedRows.length ? valuedRows.reduce((s, r) => s + r.gain, 0) : null;
  const gainBase = valuedRows.reduce((s, r) => s + r.invested, 0);
  return {
    rows: out,
    other: { invested: sum(other), count: other.length, entries: other },
    invested, value, gain,
    gainPct: gain !== null && gainBase > 0 ? (gain / gainBase) * 100 : null,
    thisMonth: sum(entries.filter(e => e.date.slice(0, 7) === month)),
    thisYear: sum(entries.filter(e => e.date.slice(0, 4) === year)),
    monthly: out.reduce((s, r) => s + (r.sip ? r.sip.amount : 0), 0),
  };
}

// What each goal has in linked holdings: { goalId: worth }
export function linkedToGoals(rows) {
  const by = {};
  for (const r of rows) {
    const id = r.holding.goalId;
    if (id) by[id] = (by[id] || 0) + r.value;
  }
  return by;
}

// A goal with its linked holdings counted in: saved by hand plus what those holdings are worth
export const withLinked = (goal, linked) => ({ ...goal, saved: (goal.saved || 0) + (linked[goal.id] || 0), linked: linked[goal.id] || 0 });

// Investments plus money owed to you, less what you owe. Bank balances aren't tracked, so this is
// not a full net worth and the page says so.
export function afterDebts(worth, debts) {
  const active = debts.filter(d => !d.settled);
  const total = type => active.filter(d => d.type === type).reduce((s, d) => s + d.amount, 0);
  const owedToYou = total('they-owe'), youOwe = total('i-owe');
  return { worth, owedToYou, youOwe, total: worth + owedToYou - youOwe };
}
