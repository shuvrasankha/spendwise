const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const moneyToCents = value => {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round((amount + Number.EPSILON) * 100) : 0;
};
export const moneyFromCents = value => value / 100;

const dateParts = value => {
  if (!DATE.test(value || '')) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? { year, month, day, date }
    : null;
};

export const isValidDateKey = value => !!dateParts(value);

const pad = value => String(value).padStart(2, '0');
const monthEnd = (year, month) => new Date(year, month, 0).getDate();
const dateKey = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const closingDate = (year, month, day) => `${year}-${pad(month)}-${pad(Math.min(day, monthEnd(year, month)))}`;
const shiftMonth = (year, month, delta) => {
  const date = new Date(year, month - 1 + delta, 1);
  return { year: date.getFullYear(), month: date.getMonth() + 1 };
};
const addDay = value => {
  const parts = dateParts(value);
  if (!parts) return '';
  parts.date.setDate(parts.date.getDate() + 1);
  return dateKey(parts.date);
};

export function validateCreditCard(card) {
  if (!String(card?.name || '').trim()) return 'Enter a card name.';
  if (!String(card?.issuer || '').trim()) return 'Enter the bank or issuer.';
  if (card.last4 && !/^\d{4}$/.test(String(card.last4))) return 'Last four digits must be exactly four numbers.';
  if (card.creditLimit !== '' && card.creditLimit != null
    && (!Number.isFinite(Number(card.creditLimit)) || Number(card.creditLimit) < 0)) {
    return 'Credit limit must be a non-negative amount.';
  }
  for (const [label, value] of [['Statement closing day', card.statementDay], ['Payment due day', card.dueDay]]) {
    if (value !== '' && value != null && (!Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 31)) {
      return `${label} must be a day from 1 to 31.`;
    }
  }
  return '';
}

export function normalizeCreditCard(card) {
  return {
    name: String(card.name).trim(),
    issuer: String(card.issuer).trim(),
    network: String(card.network || '').trim(),
    last4: String(card.last4 || '').trim(),
    ...(card.creditLimit !== '' && card.creditLimit != null ? { creditLimit: Number(card.creditLimit) } : {}),
    ...(card.statementDay !== '' && card.statementDay != null ? { statementDay: Number(card.statementDay) } : {}),
    ...(card.dueDay !== '' && card.dueDay != null ? { dueDay: Number(card.dueDay) } : {}),
    active: card.active !== false,
  };
}

export function creditCardLabel(card) {
  return `${card.name} · ${card.issuer}${card.last4 ? ` ···· ${card.last4}` : ''}`;
}

export function statementPeriodFor(date, closingDay) {
  const parts = dateParts(date);
  const day = Number(closingDay);
  if (!parts || !Number.isInteger(day) || day < 1 || day > 31) return null;
  const thisClose = closingDate(parts.year, parts.month, day);
  const endParts = date <= thisClose
    ? { year: parts.year, month: parts.month }
    : shiftMonth(parts.year, parts.month, 1);
  const end = closingDate(endParts.year, endParts.month, day);
  const startMonth = shiftMonth(endParts.year, endParts.month, -1);
  const start = addDay(closingDate(startMonth.year, startMonth.month, day));
  return { start, end, id: `${start}_${end}` };
}

export function currentStatementPeriod(today, closingDay) {
  const parts = dateParts(today);
  const day = Number(closingDay);
  if (!parts || !Number.isInteger(day) || day < 1 || day > 31) return null;
  const thisClose = closingDate(parts.year, parts.month, day);
  const closeMonth = today >= thisClose ? { year: parts.year, month: parts.month } : shiftMonth(parts.year, parts.month, -1);
  const end = closingDate(closeMonth.year, closeMonth.month, day);
  const previous = shiftMonth(closeMonth.year, closeMonth.month, -1);
  const start = addDay(closingDate(previous.year, previous.month, day));
  return { start, end, id: `${start}_${end}` };
}

export function refundRemaining(expense, refunds = []) {
  const total = refunds.filter(refund => refund.originalExpenseId === expense.id)
    .reduce((sum, refund) => sum + Math.max(0, moneyToCents(refund.amount)), 0);
  return moneyFromCents(Math.max(0, moneyToCents(expense.amount) - total));
}

export function cardOutstanding(cardId, expenses = [], refunds = [], payments = []) {
  const purchases = expenses.filter(item => item.creditCardId === cardId)
    .reduce((sum, item) => sum + Math.max(0, moneyToCents(item.amount)), 0);
  const returned = refunds.filter(item => item.creditCardId === cardId)
    .reduce((sum, item) => sum + Math.max(0, moneyToCents(item.amount)), 0);
  const paid = payments.filter(item => item.creditCardId === cardId)
    .reduce((sum, item) => sum + Math.max(0, moneyToCents(item.amount)), 0);
  return moneyFromCents(Math.max(0, purchases - returned - paid));
}

export function statementAmount(cardId, period, expenses = [], refunds = [], payments = []) {
  if (!period) return 0;
  const purchases = expenses.filter(item => item.creditCardId === cardId && item.date >= period.start && item.date <= period.end)
    .reduce((sum, item) => sum + Math.max(0, moneyToCents(item.amount)), 0);
  const returned = refunds.filter(item => item.creditCardId === cardId && item.refundDate >= period.start && item.refundDate <= period.end)
    .reduce((sum, item) => sum + Math.max(0, moneyToCents(item.amount)), 0);
  const paid = payments.filter(item => item.creditCardId === cardId && item.statementId === period.id)
    .reduce((sum, item) => sum + Math.max(0, moneyToCents(item.amount)), 0);
  return moneyFromCents(Math.max(0, purchases - returned - paid));
}

export function cardPaymentId(cardId, statementId, transactions = []) {
  const source = transactions.map(item => `${item.id}:${item.amount}:${item.date || item.refundDate || ''}`)
    .sort().join('|');
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const safeCardId = String(cardId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
  return `ccpay_${safeCardId}_${statementId || 'outstanding'}_${(hash >>> 0).toString(36)}`;
}

export function cardRefundId(refund) {
  const source = `${refund.creditCardId}|${refund.originalExpenseId}|${refund.refundDate}|${Number(refund.amount).toFixed(2)}|${String(refund.description || '').trim()}`;
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `ccrefund_${(hash >>> 0).toString(36)}`;
}

export function refundExpenseRow(refund, expense) {
  return {
    id: `refund-${refund.id}`,
    transactionType: 'refund',
    originalExpenseId: refund.originalExpenseId,
    amount: -Math.abs(Number(refund.amount) || 0),
    category: expense?.category || 'Other',
    date: refund.refundDate,
    payment: 'Credit Card',
    creditCardId: refund.creditCardId,
    cardName: expense?.cardName || '',
    description: refund.description || `Refund: ${expense?.description || 'Credit card purchase'}`,
    notes: '',
    tags: [],
  };
}
