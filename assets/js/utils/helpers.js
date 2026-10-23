// utils/helpers.js — Shared utility functions

export function pad(n) { return String(n).padStart(2, '0'); }

// Local-calendar YYYY-MM-DD. Never use toISOString() for this: it is UTC,
// so in India (UTC+5:30) local midnight becomes the previous day.
export function todayStr(d = new Date()) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// Expense categories, in the order the Add form shows them (until usage reorders them)
export const EXPENSE_CATEGORIES = [
  'Food & Dining', 'Groceries', 'Transport', 'Travel', 'Shopping', 'Bills & Utilities',
  'Home & Rent', 'Health', 'Entertainment', 'Education', 'Savings & Investments', 'Other'
];

// What each category covers, for the AI that reads voice commands and receipts. Without it a
// petrol pump bill had no obvious home and landed in Other.
export const CATEGORY_EXAMPLES = {
  'Food & Dining': 'restaurants, cafes, Swiggy, Zomato, takeaway, snacks, tea',
  'Groceries': 'supermarkets, kirana stores, Blinkit, Zepto, BigBasket, vegetables, milk',
  'Transport': 'petrol, diesel, CNG, fuel stations, EV charging, parking, tolls, FASTag, cabs, autos, metro, bus, bike or car service',
  'Travel': 'flights, trains, IRCTC, hotels, holiday bookings',
  'Shopping': 'clothes, electronics, Amazon, Flipkart, salon, personal care, household items',
  'Bills & Utilities': 'electricity, water, gas cylinder, mobile recharge, broadband, DTH, subscriptions',
  'Home & Rent': 'rent, maintenance, repairs, furniture',
  'Health': 'pharmacy, medicines, doctor, hospital, lab tests, gym',
  'Entertainment': 'movies, events, games, streaming one-offs',
  'Education': 'school or college fees, courses, books, stationery',
  'Savings & Investments': 'SIP, mutual funds, stocks, FD, RD, insurance premiums',
  'Other': 'only when nothing above fits'
};
// One line per category for an AI prompt: "- Transport: petrol, diesel, …"
export const categoryGuide = () => EXPENSE_CATEGORIES.map(c => `- ${c}: ${CATEGORY_EXAMPLES[c]}`).join('\n');

// Older names, merged or renamed. Saved entries keep the old name; they are shown and
// counted under the new one, and editing an entry saves the new name.
export const CATEGORY_ALIASES = {
  'Subscription': 'Bills & Utilities',
  'Personal Care': 'Shopping',
  'Gifts': 'Other',
  'Rent': 'Home & Rent',
  'Investment': 'Savings & Investments'
};

export function normalizeCategory(c) {
  const name = String(c ?? '').trim();
  return CATEGORY_ALIASES[name] || name || 'Other';
}

// Money put into savings or investments is saved, not spent: every spending total, chart and projection leaves it out
export const isSpending = e => normalizeCategory(e.category) !== 'Savings & Investments';

// A budget limit against what's been spent: share used, what's left, and whether to warn
// ('near' from 80%, 'over' past 100%). null when there is no limit.
export function budgetState(spent, limit) {
  if (!(limit > 0)) return null;
  const ratio = spent / limit;
  return { ratio, left: limit - spent, state: ratio > 1 ? 'over' : ratio >= 0.8 ? 'near' : 'ok' };
}

// A savings goal ({ target, saved, by: 'YYYY-MM' }) on a given day: share saved, money still to go,
// months left counting the current one, and what to put away each of those months
export function goalPace(goal, today) {
  const left = Math.max(goal.target - goal.saved, 0);
  const [y, m] = today.split('-').map(Number);
  const [gy, gm] = goal.by.split('-').map(Number);
  const months = (gy - y) * 12 + (gm - m) + 1;
  return {
    ratio: goal.target > 0 ? goal.saved / goal.target : 0,
    left,
    months,
    monthly: left && months > 0 ? left / months : 0,
    state: !left ? 'done' : months > 0 ? 'on' : 'late',
  };
}

// A 0–100 score for this month from what is known: savings rate (20%+ of income is full marks),
// investing (10%+ of income), spending pace against the budget, debt owed against income, and goals on pace. Factors without
// data are left out and the rest scaled up; null until there is income to measure against.
export function financeScore({ income, spent, invested, budget, monthShare, owe, goals }) {
  if (!(income > 0)) return null;
  const clamp = v => Math.min(Math.max(v, 0), 1);
  const parts = [
    { name: 'Saving', weight: 40, value: clamp((income - spent) / income / 0.2), tip: 'Try to keep 20% of your income unspent' },
    { name: 'Investing', weight: 15, value: clamp(invested / income / 0.1), tip: 'Putting 10% of your income into investments will lift your score' },
    { name: 'Debt', weight: 20, value: clamp(1 - owe / income), tip: 'Paying down what you owe will lift your score' },
  ];
  // On pace (projected spend within budget) scores full; projected 50% over budget scores zero
  if (budget > 0) {
    const projected = spent / monthShare / budget;
    parts.push({ name: 'Budget pace', weight: 30, value: clamp((1.5 - projected) / 0.5), tip: 'Spending is running ahead of your budget' });
  }
  if (goals.length) parts.push({ name: 'Goals', weight: 10, value: goals.filter(g => g.state !== 'late').length / goals.length, tip: 'A savings goal is behind its date' });
  const total = parts.reduce((s, p) => s + p.weight, 0);
  const score = Math.round(parts.reduce((s, p) => s + p.weight * p.value, 0) / total * 100);
  const weakest = parts.reduce((a, b) => (b.value < a.value ? b : a));
  return {
    score,
    label: score >= 80 ? 'Great' : score >= 60 ? 'Good' : score >= 40 ? 'Fair' : 'Needs work',
    tip: weakest.value < 1 ? weakest.tip : 'Everything is on track this month',
    parts: parts.map(({ name, value }) => ({ name, value })),
  };
}

// An equal split of total between you and `others` people. Their shares are rounded to 2 places and
// yours absorbs the rounding, so the parts always add back up to total.
export function splitAmount(total, others) {
  const each = Math.round((total / (others + 1)) * 100) / 100;
  return { each, mine: Math.round((total - each * others) * 100) / 100 };
}

// A debt someone else recorded against your email, seen from your side: what they're owed, you owe.
// Read-only here (firestore.rules › debts), so it is flagged shared.
export function sharedDebtView(id, raw) {
  return {
    id,
    amount: Number(raw.amount) || 0,
    type: raw.type === 'they-owe' ? 'i-owe' : 'they-owe',
    person: raw.fromName || 'Someone',
    email: raw.fromEmail || '',
    date: raw.date || '',
    notes: raw.notes || '',
    settled: raw.settled === true,
    settledDate: raw.settledDate || '',
    createdAt: raw.createdAt?.toMillis?.() || 0,
    shared: true,
  };
}

// People you've dealt with, for the split form's suggestions: from your own debts (with the email
// you split with, if any) and from bills others split with you (their email). Most recent first, one
// per name and email; a bare name is dropped when the same name is known with an email.
export function peopleFrom(debts) {
  const byKey = new Map();
  for (const d of [...debts].sort((a, b) => (b.date || '').localeCompare(a.date || ''))) {
    const name = (d.person || '').trim();
    if (!name) continue;
    const email = (d.shared ? d.email : d.withEmail) || '';
    const key = `${name.toLowerCase()}|${email}`;
    if (!byKey.has(key)) byKey.set(key, { name, email });
  }
  const named = new Set([...byKey.values()].filter(p => p.email).map(p => p.name.toLowerCase()));
  return [...byKey.values()].filter(p => p.email || !named.has(p.name.toLowerCase()));
}

// The notification centre's events from debts shared with you, newest first: each was split with
// you, and later maybe marked paid by them. ids are stable, so "seen" can be remembered per item.
export function notificationsFrom(sharedDebts) {
  const items = [];
  for (const d of sharedDebts) {
    const at = d.createdAt || Date.parse(d.date) || 0;
    items.push({ id: `${d.id}:split`, kind: 'split', at, day: d.date, person: d.person, amount: d.amount, note: d.notes });
    if (d.settled) {
      const paidAt = Date.parse(`${d.settledDate}T23:59:59`) || at;
      items.push({ id: `${d.id}:settled`, kind: 'settled', at: Math.max(paidAt, at + 1), day: d.settledDate || d.date, person: d.person, amount: d.amount, note: d.notes });
    }
  }
  return items.sort((a, b) => b.at - a.at);
}

// Counts a money figure from what it shows now (0 the first time) to value, easing out over 700ms.
// Instant with reduced motion, in a hidden tab, or when the value is unchanged. format: number → text.
const countFrames = new WeakMap();
export function countTo(el, value, format) {
  const from = Number(el.dataset.value) || 0;
  el.dataset.value = value;
  cancelAnimationFrame(countFrames.get(el));
  if (from === value || document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = format(value);
    return;
  }
  const start = performance.now();
  const step = now => {
    const t = Math.min((now - start) / 700, 1);
    el.textContent = format(from + (value - from) * (1 - (1 - t) ** 3)); // ease-out cubic
    if (t < 1) countFrames.set(el, requestAnimationFrame(step));
  };
  countFrames.set(el, requestAnimationFrame(step));
}

// ── Repeating expenses ───────────────────────────────────────────────────────
// An expense with repeat: 'monthly' starts a series (same category and description).
// The newest entry carrying a repeat field is the series' template; repeat: 'stopped' ends it.
export const recurringKey = e => `${normalizeCategory(e.category)}|${String(e.description || '').trim().toLowerCase()}`;

// Series due this month: active, nothing entered for it yet this month, and its day has come
// (the 31st falls on the month's last day). skipped(key, 'YYYY-MM') hides one for a month.
export function dueRecurring(expenses, today = todayStr(), skipped = () => false) {
  const month = today.slice(0, 7);
  const latest = new Map(), template = new Map();
  for (const e of expenses) {
    if (!e || !e.date) continue;
    const key = recurringKey(e);
    if (!latest.has(key) || e.date > latest.get(key).date) latest.set(key, e);
    if (e.repeat && (!template.has(key) || e.date > template.get(key).date)) template.set(key, e);
  }
  const [y, m, d] = today.split('-').map(Number);
  const monthDays = new Date(y, m, 0).getDate();
  const due = [];
  for (const [key, t] of template) {
    if (t.repeat !== 'monthly' || latest.get(key).date.slice(0, 7) >= month || skipped(key, month)) continue;
    const day = Math.min(Number(t.date.slice(8, 10)), monthDays);
    if (d < day) continue;
    due.push({ key, template: t, due: `${month}-${pad(day)}` });
  }
  return due.sort((a, b) => a.due.localeCompare(b.due) || b.template.amount - a.template.amount);
}

// "21 Oct", or "21 Oct 2025" outside the current year: short enough for a list row
export function shortDay(ds) {
  const d = new Date(ds + 'T00:00:00');
  const opts = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-IN', opts);
}

// Today / Yesterday buttons ([data-date-offset] inside `scope`) that set and mirror a date input
export function bindDateChips(input, scope = document) {
  const chips = [...scope.querySelectorAll('[data-date-offset]')];
  const sync = () => chips.forEach(chip => {
    const d = new Date(); d.setDate(d.getDate() - Number(chip.dataset.dateOffset));
    const on = input.value === todayStr(d);
    chip.classList.toggle('active', on);
    chip.setAttribute('aria-pressed', String(on));
  });
  chips.forEach(chip => chip.addEventListener('click', () => {
    const d = new Date(); d.setDate(d.getDate() - Number(chip.dataset.dateOffset));
    input.value = todayStr(d);
    sync();
  }));
  input.addEventListener('change', sync);
  sync();
  return sync; // call after setting the date in code
}

export function getWeekStart() {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const m = new Date(d.setDate(diff));
  return m.getFullYear() + '-' + pad(m.getMonth() + 1) + '-' + pad(m.getDate());
}

export function formatDate(ds) {
  return new Date(ds + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// escapeHtml: neutralises XSS — always call before injecting user text into innerHTML
export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Abbreviated currency for chart Y-axis
export function fmtTick(value) {
  return window.fmtCompact ? window.fmtCompact(value) : value;
}

// Sanitize user input before storing in Firestore
// Strips control characters, enforces max length
export function sanitize(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  // Remove control characters except newlines and tabs
  let clean = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  // Truncate to max length
  if (clean.length > maxLen) clean = clean.substring(0, maxLen);
  return clean.trim();
}

// Friendly error messages for Firebase auth codes: say what happened and what to do next
export function friendlyErr(code) {
  const m = {
    "auth/user-not-found": "No account uses this email. Check it, or sign up.",
    "auth/wrong-password": "That password isn't right. Try again, or reset it.",
    "auth/invalid-credential": "Email or password isn't right. Try again, or reset your password.",
    "auth/email-already-in-use": "This email already has an account. Log in instead.",
    "auth/invalid-email": "Enter an email like name@example.com.",
    "auth/weak-password": "Choose a password with at least 8 characters.",
    "auth/popup-closed-by-user": "Google sign-in was closed before it finished.",
    "auth/network-request-failed": "No connection. Check your internet and try again.",
    "auth/too-many-requests": "Too many attempts. Wait a minute, then try again.",
    "auth/user-disabled": "This account has been disabled."
  };
  return m[code] || "That didn't work. Check your connection and try again.";
}
