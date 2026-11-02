import { isSpending } from '../utils/helpers.js';

export function makeCalendarDateKey(year, monthIndex, day) {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function aggregateDailySpending(expenses, year, monthIndex, { throughDate = null } = {}) {
  const totals = new Map();
  const transactionsByDate = new Map();
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();

  for (const expense of expenses) {
    if (!expense || typeof expense.date !== 'string' || !isSpending(expense)) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expense.date)) continue;

    const [expenseYear, expenseMonth, expenseDay] = expense.date.split('-').map(Number);
    if (expenseYear !== year || expenseMonth !== monthIndex + 1 || expenseDay < 1 || expenseDay > daysInMonth) continue;
    if (throughDate && expense.date > throughDate) continue;

    const amount = Number(expense.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    const total = (totals.get(expense.date) || 0) + amount;
    if (!Number.isFinite(total)) continue;
    totals.set(expense.date, total);

    if (!transactionsByDate.has(expense.date)) transactionsByDate.set(expense.date, []);
    transactionsByDate.get(expense.date).push(expense);
  }

  return { totals, transactionsByDate };
}

export function buildCalendarMonth(year, monthIndex) {
  const firstDay = new Date(year, monthIndex, 1);
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const leadingBlanks = (firstDay.getDay() + 6) % 7;
  const totalCells = Math.ceil((leadingBlanks + daysInMonth) / 7) * 7;
  const cells = Array(totalCells).fill(null);

  for (let day = 1; day <= daysInMonth; day++) {
    cells[leadingBlanks + day - 1] = {
      day,
      dateKey: makeCalendarDateKey(year, monthIndex, day),
    };
  }

  return { year, monthIndex, daysInMonth, leadingBlanks, cells };
}

export function shiftCalendarMonth(year, monthIndex, amount) {
  const shifted = new Date(year, monthIndex + amount, 1);
  return { year: shifted.getFullYear(), monthIndex: shifted.getMonth() };
}

export function scaleDailySpending(totals, minDiameter = 18, maxDiameter = 36) {
  const positiveEntries = [...totals].filter(([, amount]) => Number.isFinite(amount) && amount > 0);
  const distinctAmounts = [...new Set(positiveEntries.map(([, amount]) => amount))].sort((a, b) => a - b);
  const intensityByAmount = new Map(distinctAmounts.map((amount, index) => [
    amount,
    distinctAmounts.length === 1 ? 2 : 1 + Math.round(index * 3 / (distinctAmounts.length - 1)),
  ]));
  const maxAmount = distinctAmounts[distinctAmounts.length - 1] || 0;

  return new Map(positiveEntries.map(([dateKey, amount]) => {
    const ratio = Math.sqrt(amount / maxAmount);
    const diameter = Math.min(maxDiameter, Math.max(minDiameter,
      Math.round(minDiameter + ratio * (maxDiameter - minDiameter))));
    return [dateKey, { amount, diameter, intensity: intensityByAmount.get(amount) }];
  }));
}
