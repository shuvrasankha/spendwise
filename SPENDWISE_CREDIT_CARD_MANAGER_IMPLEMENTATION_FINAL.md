
Hey GPT now I want you to add one more feature here. So basically what I want to do, I want you to do a feature like user can manage their credits, manage in the sense, first in the settings they can add multiple credit card they have. For example ABC credit card plus then I have another XYZ credit card. Okay. And suppose today I purchase something from Amazon using XYZ card. And three, four products. Okay. But what it will happen? So when I try to pay, in the app database what I enter? That amount, suppose 500 rupees. And then today and the select as credit card or something like that. And it will spend it as today. Now I want you to add a feature here like when we added the credit card and select the credit card option as the payment method, then it will ask which credit card. Or if it is not added, then it will ask user to add the credit card name. Okay, that feature I want. And then like it will in the debt section, it will separately show the credit card details. I mean credit card spends in the month. So when in the next month billing cycle, when that credit card bill generated, so that time I see that  it's 2000 rupees. But I remember only that I paid 500 rupees. I don't know how it is checking, taking that much money. So in the history, it will show that using this credit card I actually bought two more times. That makes it 2000 rupees, something like that. So that feature I want to add here. Is it possible? If possible, please make the prompt properly that I can paste in MD file properly that I can paste in the VS Code Copilot to build this feature
…


Yes! This is absolutely possible, and I think this would be a very valuable feature for SpendWise.

What you're describing is essentially a Credit Card Management & Expense Tracking System.

The most important part is that SpendWise should not just record which credit card you used. It should maintain a history of purchases against each card, calculate outstanding dues, and help you understand exactly how your monthly credit card bill was generated.

I'd recommend building this as a proper financial module integrated with your existing Expense, Debt Tracker, History and Settings sections.

1. Proposed feature: Credit Card Manager
My Credit Cards

Proposed UI
HDFC
HDFC Millennia

₹8,450
Current outstanding
•••• 4521
ICICI
Amazon Pay

₹2,000
Current outstanding
•••• 8912
Total outstanding

₹10,450
Add another credit card

2. How the feature will work
2. How the purchase and bill calculation should work
Let's take your example.

Suppose you have two credit cards:

HDFC Credit Card

ICICI Amazon Pay Credit Card

You make these purchases:

Date

Purchase

Card

Amount

Nov 2

Amazon headphones

ICICI

₹500

Nov 4

Amazon keyboard

ICICI

₹900

Nov 6

Grocery shopping

ICICI

₹600

Nov 8

Restaurant

HDFC

₹350

Your SpendWise records should look like this:

ICICI Amazon Pay — November

₹2,000
3 recorded purchases
Purchase 1
₹500

Purchase 2
₹900

Purchase 3
₹600

Total card spending

₹2,000
When your credit card statement arrives, SpendWise can show:

Total purchases in the statement period.

Previous outstanding balance.

Refunds and adjustments.

Payments already made.

Remaining statement amount.

Payment due date.

Minimum due, if entered.

One important accounting rule: Paying your credit card bill must NOT create another expense. The purchases have already been counted as expenses. The bill payment reduces your credit card liability. Otherwise, SpendWise would double-count your spending.

Also, the calendar month and credit card billing cycle are different. For example, purchases made after the 15th might appear on the next statement if your billing cycle closes on the 15th.

3. How I would integrate it
Your existing repository already has:

A Settings page with its own settings.js.

Credit Card as an existing payment method in the expense form.

An optional card-name field in the add/edit expense forms.

A Debt Tracker with its own debt.js.

A History page for transaction records.

Firebase Firestore, authentication and offline queue support. 

GitHub
+3

We should extend these rather than build a separate application.

4. Implementation document created
CREDIT_CARD_MANAGER_IMPLEMENTATION.md

Markdown · 25.6 KB · Full technical specification
Ready for Copilot
Download Credit Card Manager MD

The document contains:

Section

Included

Card management

Multiple cards, add/edit/archive

Expense integration

Saved card selection

Debt Tracker

Per-card outstanding

Billing cycles

Statement and due dates

Payment management

Partial/full payments

History

Card-wise purchase history

Firestore

Data model and security

Offline

Queue and synchronization

Testing

Accounting and regression tests

Diagrams

Mermaid architecture flows

5. My recommended implementation order
Don't ask Copilot to implement everything blindly in one pass.

Phase 1: Add cards in Settings and link expenses to cards.

Phase 2: Show card-wise outstanding and purchase history.

Phase 3: Add billing cycles, statements and payment tracking.

Phase 4: Backup, offline support and final testing.

This will make debugging much easier.

6. One particularly important requirement
Suppose you buy something for ₹2,000 using your ICICI credit card.

Expense recorded: ₹2,000.

Credit-card outstanding: ₹2,000.

You pay ICICI ₹2,000 next month.

Credit-card outstanding becomes ₹0.

Your expense total remains ₹2,000, not ₹4,000.

I've explicitly included this accounting rule throughout the implementation document.

My recommendation: Give the downloaded MD file to VS Code Copilot in Agent mode and ask it to follow the phased implementation instructions.

This should turn SpendWise into a much more useful personal finance tracker.


CREDIT_CARD_MANAGER_IMPLEMENTATION.md
Document
Before implementing this, I want you to clarify all the things. If you have any doubts, then ask me and then redesign this credit card management MD file. Also I want you to say like when I add it as a credit card payment, so payment I mean the thing it should be this month spent, okay? Although I am paying it, maybe I am paying it in the next month, but it should be in my current month and current date. So it will be easier to track properly
Absolutely. Before redesigning the MD file, let's finalize the business logic. I don't want Copilot to implement something that later gives you incorrect expense totals or credit-card balances.

I understand your most important requirement now:

Confirmed requirement Credit-card purchases must count as spending on the date you purchase something, not on the date you repay the credit-card bill.

1. First, let's clarify the accounting logic
Suppose today is November 5.

You purchase three things:

Date

Purchase

Card

Amount

Nov 2

Amazon headphones

ICICI

₹500

Nov 3

Amazon keyboard

ICICI

₹900

Nov 5

Groceries

HDFC

₹600

Your SpendWise dashboard should show:

November spending

₹2,000
All purchases made during November, including credit-card purchases.
Credit-card outstanding

ICICI
₹1,400

HDFC
₹600

December 5 — Bill payment

ICICI payment
₹1,400

Outstanding becomes ₹0. November spending remains ₹2,000. December spending does not increase because of this repayment.
This is how I recommend building it.

Important distinction: When adding an expense, selecting Credit Card means the payment method used for the purchase. It does not mean you're recording a credit-card bill repayment.

2. I have some questions before finalizing the architecture
Let's settle these decisions so the implementation is accurate.

Question 1 — Credit card billing cycle
When adding a credit card, should the user be able to configure:

Statement generation date (e.g. 15th of every month).

Bill payment due date (e.g. 5th of the following month).

Credit limit (e.g. ₹80,000).

My recommendation is to support all three, with the option to leave credit limit blank.

Question 2 — What happens when you pay the bill?
Suppose your ICICI statement is ₹2,000 and you pay ₹1,500.

Should SpendWise:

Show ₹1,500 paid.

Show ₹500 remaining.

Update outstanding automatically.

Allow another payment later to settle the remaining ₹500.

I recommend this.

Question 3 — Should you enter the actual statement amount?
Banks sometimes have adjustments, interest, refunds or fees.

Would you like a feature where, when the actual bill is generated, you can enter:

Actual statement amount.

Minimum amount due.

Actual due date.

SpendWise can then compare the actual bank statement with the purchases recorded in the app and highlight any difference.

I strongly recommend this because it addresses your original problem of wondering why the bank bill is higher than the purchases you remember.

Question 4 — What if you purchase something and then receive a refund?
Example:

Amazon purchase: ₹1,000 using ICICI.

Amazon refund: ₹300.

Should SpendWise show:

Original purchase: ₹1,000.

Refund: ₹300.

Net expense: ₹700.

Card outstanding reduced by ₹300.

My recommendation: yes.

Question 5 — Should archived cards retain their history?
For example, you stop using your HDFC card but still have historical transactions and an outstanding balance.

I recommend:

Hide it from new expense selection.

Keep its entire transaction history.

Continue tracking outstanding payments until settled.

Never delete historical financial records when archiving a card.

3. One additional feature I strongly recommend
Credit Card Statement Reconciliation

ICICI Amazon Pay — November statement

Recorded purchases
₹2,000

Recorded refunds
₹0

Recorded fees
₹0

Expected statement amount
₹2,000

Actual bank statement
₹2,450

Difference

₹450
Needs investigation
Possible interest, fees, previous balance or missing transactions. The app should not assume the reason.
This would make SpendWise much more useful than a simple credit-card expense tracker.

Let's finalize these five decisions first. You can answer in normal language, and you can disagree with any of my recommendations.

After that, I'll redesign CREDIT_CARD_MANAGER_IMPLEMENTATION.md from scratch, incorporating your decisions and making the instructions precise enough for VS Code Copilot Agent to implement without ambiguity.

A for credit card billing cycle, I want to add those feature but it should not be mandatory. Like it should be all the optional things should be optional kind of thing. And when user pay bill then in that case like it will show the paid and it will remove from the chart. And in some other place like in query or something like that, I can see how much I spent through credit card, particularly this credit card and all. So it can be shown as the when I added that card and tagged that based on that, I can get those data in a proper tabular format in separate thing. That is another idea. So like when I paid, I will get, if I paid less amount, I would not mention because it might be the cashback or something like that. So I don't want to do that. That's kind of extra money you can ignore it. Okay
Got it. I understand your preferred approach now. You want SpendWise to be a simple but powerful credit-card expense tracker, not a complicated accounting application.

Let me lock in what you've decided.

1. Confirmed requirements
Confirmed
A. Credit card configuration

When adding a card, all these fields should be optional except the card name and issuer.

Field

Requirement

Card name

Required

Bank / issuer

Required

Last 4 digits

Optional

Credit limit

Optional

Statement generation date

Optional

Payment due date

Optional

Card network

Optional

B. Credit-card purchases

Whenever you add an expense:

Select payment method: Credit Card.

Select the saved card.

Enter the purchase amount and date.

Save the expense.

The amount immediately counts towards the current month's spending and the daily spending calendar.

C. When you pay the credit-card bill

You want a simple payment action.

Mark the bill as paid.

Remove the settled amount from outstanding dues.

Do not add the repayment to monthly expenses.

Retain all original purchase records.

Retain the card-wise purchase history.

You don't want to complicate this with cashback or small payment differences.

D. Separate credit-card spending report

I also understand that you want a separate tabular report.

For example:

Credit Card Transaction Report

Card

ICICI Amazon Pay

Month

November 2026

Date

Description

Amount

Nov 02

Headphones

₹500

Nov 03

Keyboard

₹900

Nov 05

Grocery

₹600

Total

3 purchases

₹2,000

Total card spending

₹2,000
Filter by card, month, date range and export the report if supported by the existing application.
This report will remain available even after you've paid the bill.

2. Just four things I want to clarify
1. How should bill payment work?


One-click "Mark bill as paid" — settle the full outstanding statement.

Allow entering a payment amount, including partial payments.
2. Do you want to enter the actual bank statement amount?


No. Just calculate spending from my recorded transactions.

Yes. Allow optional entry of actual statement amount for comparison.
3. What about refunds?


Track refunds and reduce the card outstanding accordingly.

Ignore refunds in this feature for now.
4. What happens when a card is no longer used?


Archive it but retain all historical purchases and payments.

Allow deleting it and its associated records.
One important point: I want to make sure the meaning of Mark as paid is correct. If you choose the one-click option, we'll treat it as settling the full tracked statement balance, without requiring you to enter a smaller actual bank debit or cashback adjustment.

Once these are settled, I'll produce the revised Markdown specification for Copilot.

My credit card feature decisions:
1. Bill payment: full
2. Actual statement reconciliation: no
3. Refunds: yes
4. Old card handling: keep
Please use these decisions and clarify any remaining ambiguity before redesigning the MD.
Perfect. I've locked in your four decisions. We'll design this as a lightweight Credit Card Expense & Payment Management System within SpendWise.

1. Confirmed decisions
Feature

Your decision

Bill payment

Full payment – one-click

Actual bank statement reconciliation

Not required

Refund tracking

Yes

Old/unused cards

Archive, retain history

Billing cycle configuration

Optional

Credit limit

Optional

Statement date

Optional

Due date

Optional

Card-wise spending report

Required

Purchase date in expense analytics

Original purchase date

Bill repayment in expense analytics

Never count as a new expense

2. Three remaining clarifications
These are important because they affect the database structure and calculation logic.

Question 1. What exactly should "Mark as Paid" settle?
Suppose:

November 2: ICICI purchase ₹500.

November 10: ICICI purchase ₹1,000.

November 20: ICICI purchase ₹700.

Statement closing date: November 15.

Your November statement contains ₹1,500, but your current outstanding is ₹2,200.

Which behavior do you prefer?


Option A — Pay statement only (recommended)

Mark as paid settles ₹1,500. The November 20 purchase of ₹700 remains outstanding for the next statement.


Option B — Pay everything outstanding

Mark as paid settles ₹2,200, including purchases made after statement generation.

Question 2. How should refunds affect monthly spending?
Example:

November 2: Amazon purchase ₹1,000.

November 8: Amazon refunds ₹300.


Option A — Net spending (recommended)

November spending becomes ₹700. The refund appears as a separate transaction.


Option B — Keep purchases and refunds separate

Spending remains ₹1,000, while ₹300 appears separately as a refund.

Question 3. What happens to the spending calendar after bill payment?
I recommend keeping these two things completely separate:

Spending calendar: Never changes when you pay a bill. It continues showing purchases on their original dates.

Credit card outstanding chart: Decreases to reflect the payment.


Yes, keep spending and outstanding separate.

Show card payments and purchases together in one chart.
3. What I'll build after these decisions
The final architecture will have three connected areas:

Settings → Credit Cards: Add, edit and archive cards.

Debt Tracker → Credit Cards: Outstanding, bill status, payment action and payment history.

Credit Card Reports: Card-wise monthly spending, transaction table, refunds and historical reports.

I'll also ensure that the full payment action is idempotent, so accidentally clicking it twice cannot create duplicate payments.

Reply with your three choices. Then I'll redesign the Markdown specification with all your confirmed requirements, without leaving accounting behavior ambiguous for Copilot.

I have given my choice and now just create the proper MD file explaining all the things I want to build. Also mention do not use extra tokens and all to build this feature properly, test it properly and do not use extra token. Also use in the response, do not explain anything at all anymore. Just create the MD file properly based on my choices and discussion.

CREDIT_CARD_MANAGER_IMPLEMENTATION_FINAL.md

Complete implementation specification · Markdown
Created
Download the final MD file


CREDIT_CARD_MANAGER_IMPLEMENTATION_FINAL.md
Document
SpendWise Credit Card Manager
Final Product Requirements, Architecture and Implementation Plan
Repository: https://github.com/shuvrasankha/spendwise
Target: Existing SpendWise application; inspect the current branch before editing.
Purpose: Implement multi-card management, credit-card purchase tracking, full-statement payment tracking, refunds, and card-wise reports.

1. Instructions to the coding agent
You are modifying an existing application, not building a new one.

Inspect the current repository, current branch, git status, source code, tests and existing UI before making changes.
Preserve uncommitted user work. Do not overwrite unrelated changes.
Read this entire specification before coding.
Use the existing Vanilla JavaScript / HTML / CSS / Firebase architecture and established coding patterns.
Reuse existing components, CSS tokens, date and currency utilities, Firestore helpers, authentication, modal patterns and notification components.
Do not introduce a new frontend framework, large dependency, backend service or abstraction unless the current code genuinely requires it.
Keep implementation focused. Do not refactor unrelated features.
Use as few tokens and as little tool/agent effort as reasonably possible. Avoid repeatedly rereading unchanged files, broad repository exploration after the relevant files are identified, unnecessary explanations, verbose progress reports, redundant code, speculative features and multiple agents doing overlapping work. Use targeted inspection, concise plans and small changes. Do not sacrifice correctness, security or tests to save tokens.
Implement in small phases. Run targeted tests after each phase and the full test suite at the end.
Do not claim a test, build, deployment or feature is successful unless it was actually run and verified.
If an ambiguity or a conflict with existing application behavior is discovered, inspect the code and choose the least disruptive behavior consistent with this specification. Do not invent financial behavior.
At completion, report only a concise summary: files changed, tests actually run and results, and any unfinished work.
2. Feature overview
Build a Credit Card Manager inside SpendWise.

The user can:

Add and manage multiple credit cards in Settings.
Select the specific card used when recording an expense with payment method Credit Card.
Add a card inline if no saved card exists, without losing the partially completed expense form.
See each card's purchases, refunds, outstanding amount, billing information and payment status.
Mark a statement as fully paid with one action.
Keep historical card purchases and payments after a card is archived.
View a separate card-wise transaction report in a table, filterable by card and month/date range.
This is a manual expense tracker. Do not connect to banks, payment networks, payment gateways or external financial APIs. Do not imply that SpendWise knows the actual bank statement unless the user enters the relevant optional settings.

3. Confirmed product decisions
Implement these decisions as requirements:

Area	Decision
Multiple cards	Supported
Card name/nickname	Required
Issuer/bank	Required
Last four digits	Optional
Card network	Optional
Credit limit	Optional
Statement closing day	Optional
Payment due day	Optional
Card configuration fields other than name and issuer	Optional
Purchase date	Original expense date; counts in that month's spending
Bill payment	Full payment action; no partial-payment workflow in this version
Actual bank statement reconciliation	Not required
Refund tracking	Required
Old cards	Archive and retain all historical data
Card-wise report	Required, separate from ordinary transaction list if needed
Bank integration	Not required
Important: Do not add features that the user explicitly declined, such as actual bank statement reconciliation or manual partial bill payment. Do not require optional billing settings to create or use a card.

4. Core financial rules — highest priority
4.1 Purchases count on purchase date
When a user records an expense:

Payment method is Credit Card.
User selects a saved card.
The expense date is the actual purchase date.
The purchase counts immediately in the normal monthly spending total for that purchase date.
It appears on that date in the daily spending calendar.
It contributes to the selected card's tracked outstanding.
Example:

Purchase date	Description	Card	Amount
Nov 2	Headphones	ICICI	₹500
Nov 3	Keyboard	ICICI	₹900
Nov 5	Groceries	HDFC	₹600
November expense total is ₹2,000. ICICI purchase total is ₹1,400. HDFC purchase total is ₹600.

Do not defer expense recognition until the card bill is paid.

4.2 Bill payment is not an expense
When the user pays a credit-card bill:

Record a separate credit-card payment/settlement event.
Reduce the relevant card's outstanding liability.
Mark the corresponding tracked statement as paid.
Do not create an ordinary expense record.
Do not increase monthly spending, category totals, budgets, daily calendar totals, analytics, AI insights or expense exports.
Do not change the original purchase dates or delete purchase history.
Example:

November purchases = ₹1,400 on ICICI.
User pays the November statement in December.
December expense total does not increase by ₹1,400.
The card liability/statement status is updated to paid.
November purchase history remains unchanged.

4.3 Full payment only
The user selected a full-payment action, not manual partial payments.

Provide a clear action such as Mark statement as paid or Pay full statement.

The action settles the full tracked statement amount for that statement.
It creates one separate payment record.
It marks that statement paid.
It must be idempotent: repeated taps/clicks cannot create duplicate payments or settle the same statement twice.
Disable or change the action once paid.
Keep a payment history entry with date and amount.
Do not add a partial-payment entry form in this version.
If a statement closing day is not configured, do not fabricate a bank billing cycle. Provide a simple current outstanding summary and a clearly labelled Mark current outstanding as paid action. If the app cannot determine a statement period, use the explicit current outstanding amount and make the scope of the action clear.

If statement closing day is configured, distinguish:

Statement balance for the latest closed cycle.
Purchases after the statement close.
Total current outstanding.
Important implementation safeguard: A full payment action must not silently pay post-statement purchases if the selected action says it pays only the closed statement. Conversely, a current-outstanding payment action must settle the current outstanding in full. Label the action and amount clearly before confirmation. This is not a partial-payment workflow.

4.4 Do not conflate purchase spending and liability
Keep two independent views:

Spending view: Purchases and refunds on their original transaction dates. Bill payments never appear as spending.
Card liability view: Purchases, refunds and card payments affect the tracked card outstanding.
Never use the card payment date as the expense date.

4.5 Refunds
Refund tracking is required.

When a refund is recorded:

Associate it with the relevant card.
Prefer linking it to the original purchase.
Store refund date and amount.
Display it as a distinct refund transaction.
Reduce card outstanding by the refund amount.
Do not create a new ordinary positive expense for the refund.
Apply the user's confirmed net-spending preference: refund reduces net spending for the relevant reporting period, while the original purchase and refund remain separately visible in the transaction table.
Example:

Nov 2 purchase: ₹1,000.
Nov 8 refund: ₹300.
Net November spending: ₹700.
Report shows purchase ₹1,000 and refund −₹300.
Card liability is reduced by ₹300.
If a refund arrives in a later month than the purchase, record it on the actual refund date and show it separately in that month; preserve the original purchase record. Avoid silently rewriting the purchase date. The monthly net report should use a consistent, documented refund-date convention.

Prevent refund duplication and prevent refunds exceeding the refundable amount unless the app has an explicit adjustment use case.

5. Settings — credit card management
Add a Credit Cards / My Credit Cards section to the existing Settings page.

Users can:

Add a card.
Edit card metadata.
Archive a card.
Reactivate an archived card if appropriate.
See active and archived cards separately.
See masked card details and optional billing settings.
Required:

Card nickname/name.
Issuer/bank.
Optional:

Last four digits.
Network (Visa, Mastercard, RuPay, Amex, Other).
Credit limit.
Statement closing day (1–31).
Payment due day (1–31).
Notes or color, only if consistent with existing design.
No full card number, PAN, CVV/CVC, PIN, OTP, password or card authentication secret may be requested or stored. This is not a payment vault.

Validation:

Name and issuer must be non-empty.
If last four digits are supplied, exactly four numeric digits.
Credit limit, if supplied, must be a finite non-negative amount.
Statement/due days, if supplied, must be integers from 1 to 31.
Optional fields may be left blank.
Archived cards must not appear in the selector for new purchases.
Archived cards remain visible in historical transactions and card reports.
Do not delete associated purchases or payment history when archiving.
6. Expense entry and editing
Inspect the existing expense form. The repository currently has a Credit Card payment option and legacy free-text card-name fields. Reuse and migrate this UI carefully.

When payment method is Credit Card:

Show a required saved-card selector.
List the signed-in user's active cards.
Display card nickname and optional masked last four digits.
Save the existing expense with payment: "Credit Card" and creditCardId.
Keep all other expense fields and existing validation intact.
If no saved cards exist:

Show a clear empty state.
Offer Add Credit Card.
Open an inline/modal card form.
Preserve all already-entered expense values.
On successful card save, refresh the selector and select the new card.
Edit:

Preselect by creditCardId.
Keep legacy cardName visible if no ID exists.
Let the user associate a legacy expense with a saved card; do not guess ambiguous matches.
If payment method changes away from Credit Card, clear creditCardId.
Changing the card updates the existing expense, not a duplicate.
Archived cards may be displayed for historical records but should not be selectable for new purchases.
Inspect all expense entry paths (normal form, edit, voice, CSV import, quick add, recurring expense, offline queue). Do not invent a card ID in any path. Preserve legacy/unassigned records visibly and allow later association if needed.

7. Card-wise spending report
Create a separate Credit Card Report or Card Transactions tab/section, integrated into an existing sensible location (e.g. Debt Tracker or a dedicated report view). Inspect the current navigation and avoid duplicating an existing report page unnecessarily.

Required filters:

Card.
Month.
Optional date range if straightforward within current UI patterns.
Table columns:

Date.
Description.
Category.
Card.
Transaction type (Purchase / Refund / Card Payment).
Amount.
Report behavior:

Purchase rows show positive expense amounts.
Refund rows are clearly labelled and reduce net spending.
Card payment rows are visible in card payment history but excluded from expense spending totals.
Show purchase total, refund total and net spending separately.
Retain historical report data after a card is archived.
Reuse existing currency and date formatters.
Use existing CSV export conventions if easy; do not build a new export framework.
Example:

CREDIT CARD REPORT
Card: ICICI Amazon Pay
Period: November 2026

Date       Description       Type       Amount
Nov 02     Headphones        Purchase   ₹500
Nov 03     Keyboard          Purchase   ₹900
Nov 08     Amazon refund     Refund    -₹300

Purchases total: ₹1,400
Refunds total:     ₹300
Net spending:    ₹1,100
The report must also allow the user to see all purchases for a particular card across months, so they can understand where the card bill amount came from.

8. Debt Tracker integration
The existing Debt Tracker tracks interpersonal debts. Do not mix credit-card liabilities into They owe me / I owe them records or alter existing people-debt calculations.

Add a separate Credit Cards area/tab within the Debt Tracker.

Per card, show:

Card nickname and issuer.
Optional masked last four digits.
Current tracked outstanding.
Optional credit limit and utilization.
Optional statement closing date and payment due date.
Latest statement amount/status if a cycle can be calculated.
Purchases after latest statement, if applicable.
Full-payment action and payment history.
Link to card-wise report/details.
If no billing settings are supplied:

Do not block card usage.
Show current tracked outstanding.
Use a clearly labelled current-outstanding full-payment action.
Do not fabricate a statement date, due date or billing period.
If statement closing day is configured:

Calculate the statement period using local date-only values.
Document the closing-day inclusion convention.
A purchase on the closing day belongs to that statement; a purchase the next day belongs to the next cycle.
Handle 28/29/30/31-day months, leap years and year boundaries.
Clamp configured days to the last valid day of shorter months.
A due day is optional and should only be shown when configured.
Allow the user to override a particular due date only if this can be added without overcomplicating the first version.
9. Full payment record and idempotency
Create a distinct logical card-payment record, not an expense.

Suggested logical shape:

{
  uid: "authenticated-user-id",
  creditCardId: "card-document-id",
  statementId: "optional-statement-id",
  amount: 1400,
  paymentDate: "2026-12-05",
  paymentType: "full_statement", // or full_current_outstanding
  idempotencyKey: "stable-unique-operation-id",
  createdAt: serverTimestamp()
}
Use the repository's established Firestore collection/path conventions rather than blindly adopting a new path.

Payment action:

Determine the exact statement/current outstanding amount to settle.
Show confirmation including card, amount and scope.
On confirmation, create one payment record with a stable idempotency key.
Mark the relevant statement/current balance as settled.
Update the UI.
Ensure retry/double-click/offline sync cannot create duplicate payment records.
Do not rely only on a disabled button for duplicate prevention. Enforce idempotency in the data operation and sync path.

A payment record is excluded from all ordinary expense aggregations.

10. Suggested logical data model
Inspect current Firestore patterns and choose a compatible collection path. The following are logical fields, not mandatory collection names.

Credit card
{
  uid: "authenticated-user-id",
  name: "ICICI Amazon Pay",
  issuer: "ICICI",
  network: "Visa",          // optional
  last4: "8912",            // optional
  creditLimit: 80000,       // optional
  statementDay: 15,         // optional
  dueDay: 5,                // optional
  active: true,
  createdAt: serverTimestamp(),
  updatedAt: serverTimestamp()
}
Expense association
{
  payment: "Credit Card",
  creditCardId: "card-document-id",
  // Existing amount/date/category/description/etc. remain unchanged.
  // Retain legacy cardName fallback where required.
}
Refund
Prefer a distinct refund record or the app's existing transaction adjustment mechanism, whichever avoids double-counting and fits existing code.

{
  uid: "authenticated-user-id",
  creditCardId: "card-document-id",
  originalExpenseId: "expense-document-id",
  amount: 300,
  refundDate: "2026-11-08",
  description: "Amazon refund",
  createdAt: serverTimestamp()
}
Card payment
{
  uid: "authenticated-user-id",
  creditCardId: "card-document-id",
  statementId: "optional-statement-id",
  amount: 1400,
  paymentDate: "2026-12-05",
  paymentType: "full_statement",
  idempotencyKey: "stable-operation-id",
  createdAt: serverTimestamp()
}
Avoid persisting derived balances unless there is a robust transactional update/reconciliation strategy. Prefer deriving outstanding from purchases, refunds and payment records. If caching a balance, treat it as a cache, not the source of truth.

11. Offline, backup and security
Offline
Preserve the existing offline queue.
Card-linked expenses retain creditCardId.
Card payments require stable idempotency keys.
Sync retries must not create duplicate payments.
If a card has not synced yet, ensure dependent records resolve safely.
Preserve pending/sync status.
Never queue a card payment as an expense.
Backup/restore
Include:

Card metadata.
Card payment records.
Refund records.
Statement records if persisted.
Expense card IDs.
Support old backups without these fields. Preserve relationships. Never export sensitive card credentials.

Firestore security
Inspect and update firestore.rules:

Require authentication.
Enforce ownership using the existing uid convention.
Prevent cross-user card references.
Prevent changing ownership.
Validate basic types/ranges.
Do not weaken existing rules or collaboration behavior.
Do not rely only on frontend filtering.
12. Likely existing files to inspect
The repository has previously exposed these relevant paths; verify current names and current code before changing:

File	Likely role
settings.html	Settings UI
assets/js/settings.js	Settings behavior
expense.html	Add/edit expense forms
assets/js/dashboard.js	Expense form/dashboard behavior
debt.html	Debt Tracker UI
assets/js/debt.js	Debt Tracker behavior
history.html	History UI
History JS module(s)	History rendering/filtering
assets/js/modules/offline-queue.js	Offline queue/sync
assets/js/modules/backup.js	Backup/restore
firestore.rules	Firestore authorization
assets/css/tokens.css, style.css, responsive.css, reimagine.css	Theme and responsive styles
tests/	Node test suite
Do not assume these are the only relevant files. Search narrowly for existing Firestore CRUD, expense aggregation, payment-method handling, date helpers, modal helpers, backup and queue logic.

13. Test requirements
Use existing test style and add focused tests.

Card CRUD/validation
Add/edit/archive/reactivate.
Required name and issuer.
Optional fields can be blank.
Last4 validation.
Credit limit validation.
Statement/due day validation.
Archived card excluded from new purchase selection but retained in history.
Expense association
Credit-card expense saves creditCardId.
Edit preselects the correct card.
Switching away from Credit Card clears the association.
Inline card add preserves the expense form.
Legacy cardName remains readable.
No ambiguous automatic mapping.
Spending and accounting
Purchases count on original purchase date.
Credit-card purchases count in monthly expenses and daily spending calendar.
Card payments never count as expenses.
Card payments never appear in daily spending calendar.
Full payment reduces the correct liability.
Repeated payment action creates only one payment.
Refund reduces net spending and card outstanding.
Refund remains separately visible.
Refund in a later month is recorded on its actual refund date.
Archived cards retain all transactions.
Existing non-credit-card methods remain unchanged.
Billing cycle
Statement closing day inclusion convention.
Purchase next day goes into next cycle.
January/December rollover.
February 28/29.
Closing days 29/30/31 clamp correctly.
Optional dates missing do not block card use.
Due date not displayed when unset.
Date-only calculations do not shift by timezone.
Offline/security/regression
Offline card expense sync preserves card ID.
Retried payment is idempotent.
Old backup restores.
New backup includes card relationships.
User A cannot access User B cards/payments/refunds.
Existing people Debt Tracker is unchanged.
Existing dashboard, expense, history, calendar, CSV, insights and backup flows still work.
Run the repository's documented suite:

node --test tests/*.test.mjs
Also inspect package.json and run applicable existing lint/build commands. Do not invent scripts. Report actual command output/results.

14. Implementation phases
Keep changes focused and complete each phase with tests before moving on.

Phase 1 — Card settings and expense linking
Inspect current architecture and data flows.
Add card CRUD in Settings.
Add saved-card selector to Add/Edit Expense.
Save creditCardId.
Preserve legacy cardName.
Test.
Phase 2 — Card report and Debt Tracker
Add separate card section in Debt Tracker.
Add card-wise report/table and filters.
Show card purchases and refunds.
Keep payment history distinct.
Test.
Phase 3 — Billing cycle and full payment
Add optional statement/due day configuration.
Implement pure billing-cycle helpers.
Add full-statement/current-outstanding payment action with clear scope.
Add separate idempotent payment record.
Ensure statement payment does not accidentally settle post-statement purchases.
Test.
Phase 4 — Refund, offline, backup, security and polish
Add refund flow and net spending behavior.
Extend offline queue and idempotent sync.
Extend backup/restore.
Update Firestore rules.
Verify themes, responsive layout and full regression.
Test.
Do not attempt a risky one-shot rewrite. Do not add optional features outside this specification.

15. Required diagrams
Expense and payment flow
Refund flow
Logical data relationship
16. Copy/paste prompt for VS Code Copilot Agent
Implement the Credit Card Manager in my existing SpendWise repository.

First read CREDIT_CARD_MANAGER_IMPLEMENTATION.md completely.

Repository:
https://github.com/shuvrasankha/spendwise

Use the specification as the source of truth.

EFFICIENCY:
- Use minimal tokens and tool calls.
- Inspect only relevant files and dependencies.
- Do not repeatedly reread unchanged files.
- Do not provide long progress narration.
- Avoid unnecessary agents, dependencies, abstractions and refactors.
- Do not sacrifice correctness, security or tests to save tokens.

SAFETY:
- Check git status and preserve user changes.
- Inspect the current branch and actual source before editing.
- Never store full card number, CVV, PIN or OTP.
- Do not weaken Firestore security.
- Never count card bill payments as expenses.
- Never double-count purchases, refunds or payments.
- Preserve old cardName records and all existing features.

IMPLEMENTATION:
1. Follow the four implementation phases in the MD.
2. Use existing Vanilla JS, HTML, CSS, Firebase and Firestore patterns.
3. Reuse existing helpers and UI.
4. Add multiple cards in Settings.
5. Link Credit Card expenses to a saved card ID.
6. Add card-wise reports and a separate Debt Tracker section.
7. Add optional billing settings.
8. Add full statement/current-outstanding payment action with clear scope and idempotency.
9. Add refunds with net spending behavior.
10. Preserve offline queue, backup/restore and user-owned Firestore rules.
11. Add tests and run them after each phase.

Do not add bank integrations, actual statement reconciliation, partial payment workflows or unrelated features.

Run:
node --test tests/*.test.mjs

Inspect package.json for other real test/build/lint scripts and run relevant ones.

At the end, give a concise report listing:
- Files changed.
- Features completed.
- Tests actually run and their results.
- Anything incomplete.
- Any important deployment or Firestore rules steps still required.

Do not claim success without verification.
17. Final acceptance checklist
Multiple cards can be added in Settings.
Only card name and issuer are mandatory.
Optional card and billing fields can remain blank.
Cards can be edited and archived.
Archived cards retain all history.
Credit Card expense requires selecting a saved card.
Inline card creation preserves entered expense data.
Expense stores card ID and original purchase date.
Credit-card purchases count in normal monthly spending and calendar.
Card-wise report shows purchases, refunds and net spending.
Bill payment is a separate liability settlement.
Full payment action is idempotent.
Bill payment never increases expense totals.
Statement payment does not accidentally settle later purchases.
If billing settings are absent, card use still works and no fake cycle is shown.
Refunds reduce net spending and card outstanding, and remain separately visible.
Old cards retain transaction/payment/refund history.
Debt Tracker people-debt calculations remain unchanged.
Offline sync and backup/restore preserve relationships.
Firestore rules enforce user ownership.
Existing application tests pass.
Mobile, desktop, dark and light themes work.
End of final implementation specification.




