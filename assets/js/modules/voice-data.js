// voice-data.js — Checks one entry the AI read from speech, typed text, an SMS or a receipt, and
// fills in what it left out, so the review card can show every field the Add forms have.
import { EXPENSE_CATEGORIES, normalizeCategory, todayStr } from '../utils/helpers.js';

export const PAYMENT_METHODS = ['UPI', 'Cash', 'Credit Card', 'Debit Card', 'Net Banking', 'Other'];
export const DEBT_TYPES = ['they-owe', 'i-owe'];
export const INCOME_PAYMENT_TYPES = ['Online', 'Cash'];
export const isCard = payment => payment === 'Credit Card' || payment === 'Debit Card';

// AI output is untrusted text: keep it a string and within the form fields' limits
const clip = (v, max) => String(v ?? '').trim().slice(0, max);

// "#goa2026, wedding work" or ['goa2026', '#wedding'] → ['goa2026', 'wedding', 'work'], as the
// Add form stores them (no #, no repeats)
export function parseTags(v) {
  const words = (Array.isArray(v) ? v.join(' ') : String(v ?? '')).replace(/,/g, ' ').split(/\s+/);
  return [...new Set(words.map(t => t.replace(/^#+/, '').trim().slice(0, 40)).filter(Boolean))].slice(0, 10);
}

// A whole number of EMI payments, 2 to 600 (as on the Add form), else 0 for none
export function emiCount(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 2 && n <= 600 ? n : 0;
}

export function cleanEntry(data, today = todayStr()) {
  if (!data || typeof data !== 'object') return null;
  if (!['expense', 'income', 'debt'].includes(data.type)) return null;
  const amount = parseFloat(data.amount);
  if (!(amount > 0)) return null;
  const e = { type: data.type, amount, date: /^\d{4}-\d{2}-\d{2}$/.test(data.date || '') ? data.date : today, notes: clip(data.notes, 500) };

  if (e.type === 'expense') {
    // The AI may still use an older name such as "Rent" or "Subscription", or a near miss
    let category = normalizeCategory(data.category);
    if (!EXPENSE_CATEGORIES.includes(category)) {
      const lower = String(data.category || '').toLowerCase();
      category = (lower && EXPENSE_CATEGORIES.find(c => c.toLowerCase().includes(lower) || lower.includes(c.toLowerCase()))) || 'Other';
    }
    e.category = category;
    e.payment = PAYMENT_METHODS.includes(data.payment) ? data.payment : 'UPI';
    e.cardName = isCard(e.payment) ? clip(data.cardName, 100) : '';
    e.description = clip(data.description, 100) || '-';
    e.tags = parseTags(data.tags);
    e.emiTotal = emiCount(data.emiTotal);
    e.repeat = data.repeat === true || data.repeat === 'monthly' || e.emiTotal > 0;
    if (!e.repeat) e.emiTotal = 0;
  } else if (e.type === 'income') {
    e.source = clip(data.source, 100) || 'Other';
    e.paymentType = INCOME_PAYMENT_TYPES.includes(data.paymentType) ? data.paymentType : 'Online';
    e.bank = clip(data.bank, 100);
  } else {
    e.debtType = DEBT_TYPES.includes(data.debtType) ? data.debtType : 'they-owe';
    e.person = clip(data.person, 100);
    const email = clip(data.email, 254).toLowerCase();
    e.email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : '';
  }
  return e;
}
