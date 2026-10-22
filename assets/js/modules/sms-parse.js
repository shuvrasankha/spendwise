// sms-parse.js — Reads a bank or UPI SMS on the device (no AI, nothing sent anywhere).
// parseSms(text) returns an entry in voice-command.js's shape, or null when the text
// isn't a completed transaction (OTPs, due reminders, failed or requested payments).

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const SKIP = /\b(otp|one[- ]time password|verification code|will be (debited|credited)|is due|due (on|date|by)|min(imum)? amount|request(ed)?|collect request|mandate|failed|declined|unsuccessful)\b/i;
const ACCOUNT = /\b(a\/c|acct|account|card|upi|vpa|ref|txn|avl|bank|neft|imps|rtgs|wallet)\b|@/i;
const DEBIT = /\b(debited|spent|paid|sent|withdrawn|withdrawal|purchase|charged|deducted|debit)\b/i;
const CREDIT = /\b(credited|received|deposited|refunded|refund|cashback|credit(?!\s*card))\b/i;
const AMOUNT = /(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/gi;
const NOT_AMOUNT = /(bal(ance)?|lmt|limit|avl|available|due|outstanding)[\s.:a-z]*$/i; // text just before a balance, not the payment

const BANKS = [
  ['HDFC', /\bhdfc\b/i], ['ICICI', /\bicici\b/i], ['SBI', /\b(sbi|state bank)\b/i], ['Axis', /\baxis\b/i],
  ['Kotak', /\bkotak\b/i], ['Yes Bank', /\byes bank\b/i], ['IDFC First', /\bidfc\b/i], ['IndusInd', /\bindusind\b/i],
  ['Federal', /\bfederal bank\b/i], ['PNB', /\b(pnb|punjab national)\b/i], ['Bank of Baroda', /\b(bob|bank of baroda)\b/i],
  ['Canara', /\bcanara\b/i], ['Union Bank', /\bunion bank\b/i], ['AU', /\bau (small finance )?bank\b/i],
  ['RBL', /\brbl\b/i], ['Paytm', /\bpaytm\b/i], ['Airtel Payments', /\bairtel payments\b/i],
];

// First match wins, so more specific names come first (jiomart before jio)
const CATEGORIES = [
  ['Groceries', /bigbasket|blinkit|zepto|dmart|instamart|grofers|jiomart|reliance fresh|grocer|supermarket/],
  ['Food & Dining', /swiggy|zomato|domino|pizza|mcdonald|kfc|starbucks|cafe|restaurant|eatsure|burger/],
  ['Travel', /makemytrip|goibibo|indigo|air ?india|vistara|akasa|cleartrip|airbnb|\boyo\b|yatra/],
  ['Transport', /\buber\b|\bola\b|rapido|metro|irctc|redbus|fuel|petrol|hpcl|bpcl|iocl|indian ?oil|fastag|parking/],
  ['Bills & Utilities', /netflix|spotify|hotstar|prime ?video|youtube|apple\.com|google ?play|sonyliv|zee5/],
  ['Shopping', /amazon|flipkart|myntra|ajio|meesho|nykaa|croma|decathlon|ikea/],
  ['Bills & Utilities', /airtel|\bjio\b|vodafone|\bvi\b|bsnl|electricity|bescom|tata ?power|broadband|recharge|\bbill\b/],
  ['Health', /apollo|pharmeasy|netmeds|1mg|medplus|hospital|clinic|pharmacy|practo/],
  ['Entertainment', /bookmyshow|\bpvr\b|inox|steam|playstation/],
  ['Savings & Investments', /zerodha|groww|upstox|kuvera|mutual ?fund|\bsip\b|\bnps\b|\bppf\b/],
  ['Education', /udemy|coursera|byju|unacademy|school|college|tuition/],
  ['Home & Rent', /\brent\b|nobroker/],
];

function amountOf(text) {
  for (const m of text.matchAll(AMOUNT)) {
    if (NOT_AMOUNT.test(text.slice(Math.max(0, m.index - 25), m.index))) continue;
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (n > 0) return n;
  }
  return null;
}

// Indian SMS dates: 21-10-26, 21/10/2026, 21-Oct-26, 21 Oct 2026, 2026-10-21. Falls back to today.
function dateOf(text, today) {
  let d = null, m;
  if ((m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/))) d = [+m[1], +m[2], +m[3]];
  else if ((m = text.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/))) d = [+m[3], +m[2], +m[1]];
  else if ((m = text.match(/\b(\d{1,2})[- ]?([a-z]{3})[a-z]*[-, ]*(\d{2,4})\b/i)) && MONTHS.includes(m[2].toLowerCase())) {
    d = [+m[3], MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1]];
  }
  if (d) {
    if (d[0] < 100) d[0] += 2000;
    const date = new Date(d[0], d[1] - 1, d[2]);
    // a real date, not in the future
    if (date.getMonth() === d[1] - 1 && date.getDate() === d[2] && date <= today) return ymd(date);
  }
  return ymd(today);
}

const STOP = '(?=\\s+(?:on|ref|via|using|upi|avl|from|for|with|txn|is|has|was|thru|through|dated|info)\\b|\\s*[.,;:(]|\\s+\\d|$)';
const NAME = "([A-Za-z][\\w&'.* -]{1,40}?)";

// Who was paid (debit) or who paid (credit)
function partyOf(text, debit) {
  const vpa = text.match(new RegExp(`\\b${debit ? '(?:to|at)' : '(?:from|by)'}\\s+(?:vpa\\s+)?([\\w.-]+)@[\\w.-]+`, 'i'));
  let name = vpa ? vpa[1] : null;
  if (!name) {
    const words = debit ? '(?:at|to|towards)' : '(?:from|by)';
    const m = text.match(new RegExp(`\\b${words}\\s+(?!a\\/c|ac\\b|acct|your|account|card|neft|imps|rtgs|upi|transfer|bank\\b)${NAME}${STOP}`, 'i'));
    name = m ? m[1] : null;
  }
  if (!name || /\d{5,}/.test(name)) return ''; // QR codes and account numbers aren't names
  name = name.replace(/[._-]+/g, ' ').trim();
  return name === name.toUpperCase() || name === name.toLowerCase()
    ? name.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
    : name;
}

function paymentOf(text) {
  if (/credit card/i.test(text)) return 'Credit Card';
  if (/debit card|\batm\b|\bcard\b/i.test(text)) return 'Debit Card';
  if (/\bupi\b|\bvpa\b|@/i.test(text)) return 'UPI';
  if (/\b(neft|imps|rtgs|net ?banking)\b/i.test(text)) return 'Net Banking';
  return 'Other';
}

export function parseSms(text, today = new Date()) {
  text = String(text || '').replace(/\s+/g, ' ').trim();
  if (!text || SKIP.test(text) || !ACCOUNT.test(text)) return null;
  const amount = amountOf(text);
  const d = text.search(DEBIT), c = text.search(CREDIT);
  if (!amount || (d < 0 && c < 0)) return null;
  const debit = d >= 0 && (c < 0 || d < c); // "debited ... credited to beneficiary" is still a debit
  const date = dateOf(text, today);
  const party = partyOf(text, debit);
  const bank = (BANKS.find(([, re]) => re.test(text)) || [''])[0];

  if (debit) {
    const payment = paymentOf(text);
    const category = (CATEGORIES.find(([, re]) => re.test(party.toLowerCase())) || ['Other'])[0];
    return {
      type: 'expense', amount, date, category, payment,
      cardName: payment.endsWith('Card') ? bank : '',
      description: party || 'Bank payment', notes: '',
    };
  }
  const source = /salary|sal cr/i.test(text) ? 'Salary'
    : /refund|reversed/i.test(text) ? 'Refund'
    : /interest/i.test(text) ? 'Interest'
    : /cashback/i.test(text) ? 'Cashback'
    : party || 'Bank credit';
  return { type: 'income', amount, date, source, paymentType: 'Online', bank, notes: '' };
}
