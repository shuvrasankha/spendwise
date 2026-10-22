// Run: node --test tests/ — reading bank and UPI SMS on the device
process.env.TZ = 'Asia/Kolkata';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSms } from '../assets/js/modules/sms-parse.js';

const today = new Date(2026, 9, 22, 12); // 22 Oct 2026, noon
const read = text => parseSms(text, today);

test('UPI debit to a VPA', () => {
  const e = read('Rs.450.00 debited from A/c XX1234 on 21-10-26 to VPA swiggy@icici (UPI Ref No 629451234567). Not you? Call 18002586161 -HDFC Bank');
  assert.equal(e.type, 'expense');
  assert.equal(e.amount, 450);
  assert.equal(e.date, '2026-10-21');
  assert.equal(e.description, 'Swiggy');
  assert.equal(e.category, 'Food & Dining');
  assert.equal(e.payment, 'UPI');
});

test('credit card spend, ignoring the available limit', () => {
  const e = read('INR 1,250.00 spent on ICICI Bank Credit Card XX4321 at AMAZON on 2026-10-20. Avl Lmt: INR 98,750.00. To dispute, call 18001080');
  assert.equal(e.amount, 1250);
  assert.equal(e.date, '2026-10-20');
  assert.equal(e.description, 'Amazon');
  assert.equal(e.category, 'Shopping');
  assert.equal(e.payment, 'Credit Card');
  assert.equal(e.cardName, 'ICICI');
});

test('"Sent ... To" format with a slash date', () => {
  const e = read('Sent Rs.250.00 From HDFC Bank A/C x1234 To ZOMATO LTD On 19/10/26 Ref 629312345678 Not You? Call 18002586161');
  assert.equal(e.type, 'expense');
  assert.equal(e.amount, 250);
  assert.equal(e.date, '2026-10-19');
  assert.equal(e.description, 'Zomato Ltd');
  assert.equal(e.category, 'Food & Dining');
});

test('SBI debit with a month name and no merchant', () => {
  const e = read('Dear Customer, Your A/C XXXXX5678 has been debited by Rs. 2,000.00 on 18Oct26 for ATM withdrawal. Avl Bal Rs 12,345.67 -SBI');
  assert.equal(e.amount, 2000);
  assert.equal(e.date, '2026-10-18');
  assert.equal(e.payment, 'Debit Card');
  assert.equal(e.description, 'Bank payment');
  assert.equal(e.category, 'Other');
});

test('salary credit is income, ignoring the balance', () => {
  const i = read('Your A/c XX1234 is credited with Rs 52,000.00 on 01-Oct-26 by NEFT from ACME CORP towards SALARY OCT. Avl Bal Rs 60,100.00 -Axis Bank');
  assert.equal(i.type, 'income');
  assert.equal(i.amount, 52000);
  assert.equal(i.date, '2026-10-01');
  assert.equal(i.source, 'Salary');
  assert.equal(i.bank, 'Axis');
  assert.equal(i.paymentType, 'Online');
});

test('UPI money received from a person', () => {
  const i = read('You have received Rs.300.00 from ravi.kumar@okaxis in your Kotak Bank a/c XX9876 on 21/10/2026. UPI Ref 6291234');
  assert.equal(i.type, 'income');
  assert.equal(i.amount, 300);
  assert.equal(i.source, 'Ravi Kumar');
  assert.equal(i.bank, 'Kotak');
});

test('"debited ... credited to beneficiary" is a debit', () => {
  const e = read('Rs 1,000 debited from a/c XX1234 and credited to a/c XX9999 (IMPS Ref 1234) on 20-10-26');
  assert.equal(e.type, 'expense');
  assert.equal(e.payment, 'Net Banking');
});

test('refund is income with source Refund', () => {
  const i = read('Refund of Rs 799.00 from Flipkart has been credited to your A/c XX1234 on 15-10-26.');
  assert.equal(i.type, 'income');
  assert.equal(i.source, 'Refund');
});

test('a date in the future or not a real date falls back to today', () => {
  assert.equal(read('Rs 99 debited from A/c XX1 on 30-12-26 to VPA uber@axl').date, '2026-10-22');
  assert.equal(read('Rs 99 debited from A/c XX1 on 31-02-26 to VPA uber@axl').date, '2026-10-22');
});

test('QR codes are not used as names', () => {
  const e = read('Rs 60 paid to paytmqr2810050501011abcd@paytm via UPI from A/c XX12');
  assert.equal(e.description, 'Bank payment');
});

test('not a transaction: OTPs, reminders, requests, failures, plain sentences', () => {
  assert.equal(read('123456 is your OTP for a transaction of Rs 500 at Amazon. Do not share it.'), null);
  assert.equal(read('Your credit card bill of Rs 5,000 is due on 25-10-26. Min amount due Rs 250.'), null);
  assert.equal(read('Ravi has requested Rs 200 from you on UPI. Pay now.'), null);
  assert.equal(read('Transaction of Rs 300 at Swiggy using card XX12 has failed.'), null);
  assert.equal(read('Spent 200 on groceries today'), null); // a typed voice command goes to the AI
  assert.equal(read(''), null);
});

test('subscriptions, rent and investments use the merged categories', () => {
  assert.equal(read('Rs.649.00 debited from A/c XX1234 on 20-10-26 to VPA netflix@icici (UPI Ref No 629451234567) -HDFC Bank').category, 'Bills & Utilities');
  assert.equal(read('Rs.18000.00 debited from A/c XX1234 on 01-10-26 to VPA nobroker@icici (UPI Ref No 629451234568) -HDFC Bank').category, 'Home & Rent');
  assert.equal(read('Rs.5000.00 debited from A/c XX1234 on 05-10-26 to VPA zerodha@icici (UPI Ref No 629451234569) -HDFC Bank').category, 'Savings & Investments');
});
