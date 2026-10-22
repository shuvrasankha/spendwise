# SpendWise — Feature ideas

Ranked by value for effort. Already shipped: budgets (overall and per category), repeating expenses, bank SMS, voice, CSV import, AI coach, debts, daily reminders, backup, offline, app lock.

## Top picks

- [ ] **1. Budget that syncs across devices** — Small
  - Budgets live in `localStorage` (`assets/js/modules/budget.js`), so a phone budget never reaches the laptop and is lost when site data is cleared.
  - Store it in Firestore with the rest of the user's data.
- [ ] **2. Split an expense** — Medium
  - On the expense form: "Split with Ravi, Asha". Save your share as the expense and a "they owe me" debt for each person.
  - Today a dinner bill has to be entered twice (Expense, then Debts).
- [ ] **3. Bill-due alerts** — Small
  - "Netflix ₹649 due tomorrow" for repeating expenses.
  - The worker (`worker/src/push.js`) only sends the daily "log your spending" reminder; reuse its push and cron.

## Next

- [x] **4. Scan a receipt** — Medium
  - Photo → AI fills amount, date, shop and category, through the existing AI proxy (same path as CSV import).
- [ ] **5. Savings goals** — Medium
  - "Goa trip ₹30,000 by March", with a progress bar and the monthly pace needed. Build on Home's Saved tile.
- [ ] **6. Accounts and balances** — Large
  - Payment methods are recorded (UPI, cash, card) but have no balances. Show "HDFC ₹12,400 · Cash ₹800". Touches every form.

## Smaller extras

- [ ] **Month-end summary notification:** "You spent ₹24k, 8% less than last month". Reuses the insights code.
- [ ] **Tags for trips or events** (#goa2026), to see a trip's total across categories.
