// currency.js — Multi-currency support for SpendWise

const CURRENCIES = [
  { code: 'INR', symbol: '₹', name: 'Indian Rupee', locale: 'en-IN' },
  { code: 'USD', symbol: '$', name: 'US Dollar', locale: 'en-US' },
  { code: 'EUR', symbol: '€', name: 'Euro', locale: 'de-DE' },
  { code: 'GBP', symbol: '£', name: 'British Pound', locale: 'en-GB' },
  { code: 'BDT', symbol: '৳', name: 'Bangladeshi Taka', locale: 'bn-BD' },
  { code: 'PKR', symbol: 'Rs', name: 'Pakistani Rupee', locale: 'en-PK' },
  { code: 'LKR', symbol: 'Rs', name: 'Sri Lankan Rupee', locale: 'si-LK' },
  { code: 'NPR', symbol: 'Rs', name: 'Nepalese Rupee', locale: 'ne-NP' },
  { code: 'AED', symbol: 'د.إ', name: 'UAE Dirham', locale: 'ar-AE' },
  { code: 'SAR', symbol: '﷼', name: 'Saudi Riyal', locale: 'ar-SA' },
  { code: 'JPY', symbol: '¥', name: 'Japanese Yen', locale: 'ja-JP' },
  { code: 'AUD', symbol: 'A$', name: 'Australian Dollar', locale: 'en-AU' },
  { code: 'CAD', symbol: 'C$', name: 'Canadian Dollar', locale: 'en-CA' },
  { code: 'SGD', symbol: 'S$', name: 'Singapore Dollar', locale: 'en-SG' },
  { code: 'MYR', symbol: 'RM', name: 'Malaysian Ringgit', locale: 'ms-MY' },
  { code: 'THB', symbol: '฿', name: 'Thai Baht', locale: 'th-TH' },
  { code: 'IDR', symbol: 'Rp', name: 'Indonesian Rupiah', locale: 'id-ID' },
  { code: 'PHP', symbol: '₱', name: 'Philippine Peso', locale: 'fil-PH' },
  { code: 'KRW', symbol: '₩', name: 'South Korean Won', locale: 'ko-KR' },
  { code: 'CNY', symbol: '¥', name: 'Chinese Yuan', locale: 'zh-CN' },
  { code: 'BRL', symbol: 'R$', name: 'Brazilian Real', locale: 'pt-BR' },
  { code: 'ZAR', symbol: 'R', name: 'South African Rand', locale: 'en-ZA' },
  { code: 'NGN', symbol: '₦', name: 'Nigerian Naira', locale: 'en-NG' },
  { code: 'KES', symbol: 'KSh', name: 'Kenyan Shilling', locale: 'en-KE' },
  { code: 'EGP', symbol: 'E£', name: 'Egyptian Pound', locale: 'ar-EG' },
  { code: 'TRY', symbol: '₺', name: 'Turkish Lira', locale: 'tr-TR' },
  { code: 'RUB', symbol: '₽', name: 'Russian Ruble', locale: 'ru-RU' },
  { code: 'CHF', symbol: 'CHF', name: 'Swiss Franc', locale: 'de-CH' },
  { code: 'SEK', symbol: 'kr', name: 'Swedish Krona', locale: 'sv-SE' },
  { code: 'NOK', symbol: 'kr', name: 'Norwegian Krone', locale: 'nb-NO' },
  { code: 'DKK', symbol: 'kr', name: 'Danish Krone', locale: 'da-DK' },
  { code: 'PLN', symbol: 'zł', name: 'Polish Zloty', locale: 'pl-PL' },
  { code: 'MXN', symbol: 'MX$', name: 'Mexican Peso', locale: 'es-MX' },
  { code: 'ARS', symbol: 'AR$', name: 'Argentine Peso', locale: 'es-AR' },
  { code: 'COP', symbol: 'CO$', name: 'Colombian Peso', locale: 'es-CO' },
];

const DEFAULT_CURRENCY = 'INR';
const STORAGE_KEY = 'spendwise_currency';

function getCurrency() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && CURRENCIES.find(c => c.code === stored)) return stored;
  } catch { /* ignore */ }
  return DEFAULT_CURRENCY;
}

function setCurrency(code) {
  if (!CURRENCIES.find(c => c.code === code)) return;
  try { localStorage.setItem(STORAGE_KEY, code); } catch { /* ignore */ }
}

function getCurrencyInfo(code) {
  return CURRENCIES.find(c => c.code === code) || CURRENCIES.find(c => c.code === DEFAULT_CURRENCY);
}

function fmt(n) {
  const cur = getCurrencyInfo(getCurrency());
  return cur.symbol + ' ' + Number(n).toLocaleString(cur.locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtCompact(n) {
  const cur = getCurrencyInfo(getCurrency());
  const v = Number(n);
  if (v === 0) return cur.symbol + ' 0';
  if (v >= 10000000) return cur.symbol + (v / 10000000).toFixed(1).replace(/\.0$/, '') + 'Cr';
  if (v >= 100000) return cur.symbol + (v / 100000).toFixed(1).replace(/\.0$/, '') + 'L';
  if (v >= 1000) return cur.symbol + (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return cur.symbol + ' ' + v;
}

function buildCurrencyOptions(selected) {
  return CURRENCIES.map(c =>
    `<option value="${c.code}" ${c.code === selected ? 'selected' : ''}>${c.symbol} ${c.code} — ${c.name}</option>`
  ).join('');
}

function updateCurrencyDisplay() {
  const cur = getCurrencyInfo(getCurrency());
  // Update all .currency-symbol spans in form labels
  document.querySelectorAll('.currency-symbol').forEach(el => {
    el.textContent = cur.symbol;
  });
  // Update all summary amounts that have data-currency attribute
  document.querySelectorAll('[data-currency]').forEach(el => {
    const val = parseFloat(el.dataset.currency);
    if (!isNaN(val)) el.textContent = fmt(val);
  });
}

// Expose to global scope for inline HTML handlers
window.getCurrency = getCurrency;
window.setCurrency = setCurrency;
window.getCurrencyInfo = getCurrencyInfo;
window.fmt = fmt;
window.fmtCompact = fmtCompact;
window.buildCurrencyOptions = buildCurrencyOptions;
window.updateCurrencyDisplay = updateCurrencyDisplay;
window.CURRENCIES = CURRENCIES;
