// ai-insights.js — SpendWise AI Spending Analysis Module
// Uses expense + income data + Hugging Face Inference API for smart financial insights

import { app } from '../config/firebase.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, getDocs, query, where } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const auth = getAuth(app);
const db = getFirestore(app);

// Currency helpers from global scope (currency.js loads before this module)
const fmt = window.fmt;
const getCurrency = window.getCurrency;
const getCurrencyInfo = window.getCurrencyInfo;

// ══════════════════════════════════════════════════════════════════════════════
//  🔑  HUGGING FACE API TOKEN
//  Same pattern as voice-command.js — placeholder replaced by GitHub Actions
// ══════════════════════════════════════════════════════════════════════════════
let HF_TOKEN = '__HF_TOKEN_PLACEHOLDER__';
try {
  const config = await import('../../voice-config.js');
  if (config.HF_TOKEN) HF_TOKEN = config.HF_TOKEN;
} catch (_) { /* voice-config.js not present — use embedded token */ }
const HF_MODEL = 'Qwen/Qwen2.5-Coder-32B-Instruct:fastest';
const HF_API_URL = 'https://router.huggingface.co/v1/chat/completions';

// ── Constants ────────────────────────────────────────────────────────────────
const CACHE_KEY_PREFIX = 'spendwise_insights_';
const CACHE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

const EXPENSE_CATEGORIES = [
  'Food & Dining', 'Transport', 'Shopping', 'Entertainment', 'Health',
  'Bills & Utilities', 'Education', 'Travel', 'Groceries', 'Subscription',
  'Rent', 'Investment', 'Personal Care', 'Gifts', 'Other'
];

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// ── State ────────────────────────────────────────────────────────────────────
let currentUser = null;
let isAnalyzing = false;

// ── Helpers ──────────────────────────────────────────────────────────────────
function pad(n) { return String(n).padStart(2, '0'); }
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
// fmt() is now provided by currency.js
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ── Auth Listener ────────────────────────────────────────────────────────────
onAuthStateChanged(auth, user => {
  currentUser = user;
});

// ══════════════════════════════════════════════════════════════════════════════
//  DATA AGGREGATION — Collect ALL expenses, income & debts from Firestore
// ══════════════════════════════════════════════════════════════════════════════
async function gatherFinancialData(period) {
  if (!currentUser) throw new Error('NOT_AUTHENTICATED');

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  // Fetch all expenses
  const expQ = query(collection(db, 'expenses'), where('uid', '==', currentUser.uid));
  const expSnap = await getDocs(expQ);
  let allExpenses = expSnap.docs.map(d => {
    const raw = d.data();
    const isPlain = raw.encoding === 'plain'
      || typeof raw.amount === 'number'
      || !isNaN(parseFloat(raw.amount));
    const amt = isPlain ? parseFloat(raw.amount) : parseFloat(raw.amount);
    return {
      amount: isNaN(amt) ? 0 : amt,
      category: raw.category || 'Other',
      date: raw.date || '',
      payment: raw.payment || 'UPI',
      description: raw.description || '-'
    };
  });

  // Fetch all income
  const incQ = query(collection(db, 'income'), where('uid', '==', currentUser.uid));
  const incSnap = await getDocs(incQ);
  let allIncome = incSnap.docs.map(d => {
    const raw = d.data();
    const amt = parseFloat(raw.amount);
    return {
      amount: isNaN(amt) ? 0 : amt,
      source: raw.source || 'Other',
      date: raw.date || '',
      paymentType: raw.paymentType || 'Online'
    };
  });

  // Fetch all debts
  const debtQ = query(collection(db, 'debts'), where('uid', '==', currentUser.uid));
  const debtSnap = await getDocs(debtQ);
  let allDebts = debtSnap.docs.map(d => {
    const raw = d.data();
    const amt = parseFloat(raw.amount);
    return {
      amount: isNaN(amt) ? 0 : amt,
      type: raw.type || 'they-owe',
      person: raw.person || 'Unknown',
      date: raw.date || '',
      notes: raw.notes || '',
      settled: raw.settled || false,
      settledDate: raw.settledDate || ''
    };
  });

  // Filter by period
  let filteredExpenses, filteredIncome, periodLabel, monthlyBreakdown, totalMonths;
  
  if (period === 'this-year') {
    // This Year: Jan 1 to Dec 31 of current year
    periodLabel = `${currentYear} - Full Year`;
    filteredExpenses = allExpenses.filter(e => e.date && e.date.startsWith(String(currentYear)));
    filteredIncome = allIncome.filter(i => i.date && i.date.startsWith(String(currentYear)));
    
    // Monthly breakdown for the year
    monthlyBreakdown = {};
    for (let m = 1; m <= 12; m++) {
      const prefix = `${currentYear}-${pad(m)}`;
      const monthExpenses = filteredExpenses.filter(e => e.date.startsWith(prefix));
      const monthIncome = filteredIncome.filter(i => i.date.startsWith(prefix));
      monthlyBreakdown[MONTH_NAMES[m - 1]] = {
        expenses: monthExpenses.reduce((s, e) => s + e.amount, 0),
        income: monthIncome.reduce((s, i) => s + i.amount, 0),
        count: monthExpenses.length
      };
    }
    totalMonths = 12;
  } else {
    // All Time: every single record
    periodLabel = 'All Time';
    filteredExpenses = allExpenses.filter(e => e.date);
    filteredIncome = allIncome.filter(i => i.date);
    
    // Monthly breakdown across all available months
    monthlyBreakdown = {};
    const yearMonths = new Set();
    filteredExpenses.forEach(e => yearMonths.add(e.date.substring(0, 7)));
    filteredIncome.forEach(i => yearMonths.add(i.date.substring(0, 7)));
    
    const sortedMonths = [...yearMonths].sort();
    sortedMonths.forEach(ym => {
      const [y, m] = ym.split('-');
      const monthName = MONTH_NAMES[parseInt(m) - 1] + ' ' + y;
      const prefix = ym;
      const monthExpenses = filteredExpenses.filter(e => e.date.startsWith(prefix));
      const monthIncome = filteredIncome.filter(i => i.date.startsWith(prefix));
      monthlyBreakdown[monthName] = {
        expenses: monthExpenses.reduce((s, e) => s + e.amount, 0),
        income: monthIncome.reduce((s, i) => s + i.amount, 0),
        count: monthExpenses.length
      };
    });
    totalMonths = sortedMonths.length;
  }

  // Aggregate category-wise spending
  const categoryBreakdown = {};
  filteredExpenses.forEach(e => {
    categoryBreakdown[e.category] = (categoryBreakdown[e.category] || 0) + e.amount;
  });

  // Payment method breakdown
  const paymentBreakdown = {};
  filteredExpenses.forEach(e => {
    paymentBreakdown[e.payment] = (paymentBreakdown[e.payment] || 0) + e.amount;
  });

  // Day of week analysis
  const dayOfWeekSpending = { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0, Sun: 0 };
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  filteredExpenses.forEach(e => {
    if (e.date) {
      const day = new Date(e.date + 'T00:00:00').getDay();
      dayOfWeekSpending[dayNames[day]] += e.amount;
    }
  });

  const totalExpenses = filteredExpenses.reduce((sum, e) => sum + e.amount, 0);
  const totalIncome = filteredIncome.reduce((sum, i) => sum + i.amount, 0);

  // Debt aggregations (all active debts + all settled)
  const activeDebts = allDebts.filter(d => !d.settled);
  const settledDebts = allDebts.filter(d => d.settled);

  const totalOwedToYou = activeDebts
    .filter(d => d.type === 'they-owe')
    .reduce((sum, d) => sum + d.amount, 0);

  const totalYouOwe = activeDebts
    .filter(d => d.type === 'i-owe')
    .reduce((sum, d) => sum + d.amount, 0);

  const totalSettled = settledDebts
    .reduce((sum, d) => sum + d.amount, 0);

  const settlementRate = allDebts.length > 0
    ? (settledDebts.length / allDebts.length) * 100
    : 0;

  const netDebtPosition = totalOwedToYou - totalYouOwe;

  // Top expenses
  const topExpenses = [...filteredExpenses].sort((a, b) => b.amount - a.amount).slice(0, 10);

  // Calculate days in period
  const daysInPeriod = filteredExpenses.length > 0
    ? new Set(filteredExpenses.map(e => e.date)).size
    : 1;
  const avgDailySpend = daysInPeriod > 0 ? totalExpenses / daysInPeriod : 0;

  return {
    period: periodLabel,
    periodType: period,
    totalExpenses,
    totalIncome,
    netSavings: totalIncome - totalExpenses,
    transactionCount: filteredExpenses.length,
    incomeCount: filteredIncome.length,
    avgDailySpend,
    daysInPeriod,
    totalMonths,
    categoryBreakdown,
    monthlyBreakdown,
    paymentBreakdown,
    dayOfWeekSpending,
    topExpenses,
    incomeSources: filteredIncome,
    debt: {
      totalOwedToYou,
      totalYouOwe,
      totalSettled,
      settlementRate,
      netDebtPosition,
      activeCount: activeDebts.length,
      settledCount: settledDebts.length,
      totalDebtCount: allDebts.length,
      activeDebts,
      settledDebts,
      topDebtors: activeDebts
        .filter(d => d.type === 'they-owe')
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 5),
      topCreditors: activeDebts
        .filter(d => d.type === 'i-owe')
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 5)
    }
  };
}

// ══════════════════════════════════════════════════════════════════════════════
//  PROMPT ENGINEERING — Build the analysis prompt
// ══════════════════════════════════════════════════════════════════════════════
function buildAnalysisPrompt(data) {
  const cur = getCurrencyInfo(getCurrency());
  const sym = cur.symbol;
  const categoryList = Object.entries(data.categoryBreakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, amt]) => `  - ${cat}: ${sym} ${amt.toFixed(2)}`)
    .join('\n');

  const dayOfWeekList = Object.entries(data.dayOfWeekSpending)
    .map(([day, amt]) => `  - ${day}: ${sym} ${amt.toFixed(2)}`)
    .join('\n');

  const paymentList = Object.entries(data.paymentBreakdown)
    .map(([method, amt]) => `  - ${method}: ${sym} ${amt.toFixed(2)}`)
    .join('\n');

  const topExpenseList = data.topExpenses
    .slice(0, 10)
    .map((e, i) => `  ${i + 1}. ${sym} ${e.amount.toFixed(2)} — ${e.category} (${e.description}) on ${e.date}`)
    .join('\n');

  const monthlyText = Object.entries(data.monthlyBreakdown || {})
    .map(([month, info]) => {
      if (!info || (info.expenses === 0 && info.income === 0)) return null;
      return `  - ${month}: Expenses ${sym} ${info.expenses.toFixed(2)} (${info.count || 0} txns) | Income ${sym} ${info.income.toFixed(2)}`;
    })
    .filter(Boolean)
    .join('\n');

  const system = `You are a personal finance analyst for SpendWise, an Indian expense tracking app. Analyze the user's financial data for the period "${data.period}" and provide personalized, actionable insights.

IMPORTANT RULES:
1. Be specific — reference actual numbers, categories, and patterns from the data.
2. Be actionable — give concrete suggestions (e.g., "You could save Rs X by reducing Y").
3. Consider Indian spending context (UPI payments, typical Indian expenses, etc.).
4. Return ONLY valid JSON, no markdown, no explanation.
5. Amounts should include "Rs" prefix.
6. Be encouraging but honest about overspending.
7. Analyze debt patterns if debt data is present.
8. Identify trends across months if multi-month data is available.

Return JSON in this EXACT format:
{
  "summary": {
    "headline": "<one-line summary>",
    "healthScore": <1-100>,
    "highlights": ["<highlight 1>", "<highlight 2>", "<highlight 3>"]
  },
  "patterns": [
    {"title": "<pattern title>", "description": "<detail>", "type": "info|warning|success"}
  ],
  "recommendations": [
    {"title": "<title>", "description": "<detail>", "priority": "high|medium|low", "savingsEstimate": "<estimate or empty>"}
  ],
  "alerts": [
    {"title": "<title>", "description": "<detail>", "severity": "critical|warning|info"}
  ],
  "categoryAnalysis": [
    {"category": "<name>", "amount": <number>, "percentage": <number>, "trend": "up|down|stable", "comment": "<analysis>"}
  ],
  "debtAnalysis": {
    "summary": "<one-line summary>",
    "totalOwedToYou": <number>,
    "totalYouOwe": <number>,
    "netPosition": <number>,
    "settlementRate": <percentage 0-100>,
    "insights": [
      {"title": "<title>", "description": "<detail>", "type": "info|warning|success"}
    ],
    "topDebtors": ["<name>", ...],
    "topCreditors": ["<name>", ...]
  }
}`;

  const userPrompt = `Here is my financial data for the period: ${data.period}

📊 OVERVIEW:
- Total Expenses: ${sym} ${(data.totalExpenses || 0).toFixed(2)} (${data.transactionCount || 0} transactions)
- Total Income: ${sym} ${(data.totalIncome || 0).toFixed(2)} (${data.incomeCount || 0} entries)
- Net Savings: ${sym} ${(data.netSavings || 0).toFixed(2)}
- Average Daily Spend: ${sym} ${(data.avgDailySpend || 0).toFixed(2)} (${data.daysInPeriod || 0} active days)

📅 MONTHLY BREAKDOWN:
${monthlyText || '  No monthly data available.'}

📁 CATEGORY BREAKDOWN:
${categoryList || '  No expenses recorded.'}

📅 SPENDING BY DAY OF WEEK:
${dayOfWeekList || '  No spending data.'}

💳 PAYMENT METHODS:
${paymentList || '  No payment data.'}

🔝 TOP 10 EXPENSES:
${topExpenseList || '  No expenses recorded.'}

💰 DEBT OVERVIEW:
- Total Owed to You: ${sym} ${((data.debt && data.debt.totalOwedToYou) || 0).toFixed(2)} (${(data.debt && data.debt.activeCount) || 0} active debts)
- Total You Owe: ${sym} ${((data.debt && data.debt.totalYouOwe) || 0).toFixed(2)}
- Total Settled: ${sym} ${((data.debt && data.debt.totalSettled) || 0).toFixed(2)}
- Net Debt Position: ${sym} ${((data.debt && data.debt.netDebtPosition) || 0).toFixed(2)} (${(data.debt && data.debt.netDebtPosition) > 0 ? 'Others owe you more' : 'You owe more than others'})
- Settlement Rate: ${((data.debt && data.debt.settlementRate) || 0).toFixed(1)}%

Please analyze my financial data and provide insights.`;

  return { system, user: userPrompt };
}

// ══════════════════════════════════════════════════════════════════════════════
//  API CALL — Hugging Face Inference API
// ══════════════════════════════════════════════════════════════════════════════
async function callAnalysisAPI(data) {
  if (!HF_TOKEN || HF_TOKEN.length < 10 || HF_TOKEN.includes('PLACEHOLDER')) {
    throw new Error('HF_TOKEN_NOT_SET');
  }

  const prompt = buildAnalysisPrompt(data);
  const response = await fetch(HF_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HF_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: HF_MODEL,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user }
      ],
      max_tokens: 2000,
      temperature: 0.3,
      top_p: 0.95
    })
  });

  if (response.status === 429) throw new Error('RATE_LIMITED');
  if (response.status === 503) throw new Error('MODEL_LOADING');
  if (!response.ok) {
    const errBody = await response.text();
    console.error('HF API error:', response.status, errBody);
    throw new Error('API_ERROR');
  }

  const result = await response.json();
  const content = result.choices?.[0]?.message?.content;
  if (!content) throw new Error('EMPTY_RESPONSE');

  // Extract JSON from response
  let jsonStr = content.trim();
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonStr = jsonMatch[1].trim();
  const objMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (objMatch) jsonStr = objMatch[0];

  return JSON.parse(jsonStr);
}

// ── Cache helpers ────────────────────────────────────────────────────────────
function getCacheKey(uid, period) {
  return CACHE_KEY_PREFIX + uid + '_' + period;
}

function saveInsightsCache(uid, period, insights) {
  try {
    const payload = JSON.stringify({ ts: Date.now(), data: insights });
    localStorage.setItem(getCacheKey(uid, period), payload);
  } catch (_) { /* quota exceeded */ }
}

function loadInsightsCache(uid, period) {
  try {
    const raw = localStorage.getItem(getCacheKey(uid, period));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.ts > CACHE_MAX_AGE_MS) {
      localStorage.removeItem(getCacheKey(uid, period));
      return null;
    }
    return parsed.data;
  } catch { return null; }
}

// ── Consent Dialog ───────────────────────────────────────────────────────────
function showConsentDialog() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.zIndex = '9999';

    const modal = document.createElement('div');
    modal.className = 'modal-box';
    modal.style.maxWidth = '480px';
    modal.innerHTML = `
      <div class="modal-icon" style="background: var(--accent-bg); color: var(--accent);"><i data-lucide="brain"></i></div>
      <h3>AI Analysis Consent</h3>
      <p style="font-size: 0.875rem; color: var(--text2); margin-bottom: 16px; line-height: 1.5;">
        To provide personalized insights, your financial data (expenses, income, categories, and spending patterns) will be sent to an AI service (Hugging Face) for analysis.
      </p>
      <p style="font-size: 0.8125rem; color: var(--text3); margin-bottom: 16px; line-height: 1.4;">
        <strong>What is sent:</strong> Transaction amounts, categories, dates, payment methods, and aggregated spending patterns.<br>
        <strong>What is NOT sent:</strong> Your name, email, or any personally identifiable information.
      </p>
      <p style="font-size: 0.8125rem; color: var(--text3); margin-bottom: 20px; line-height: 1.4;">
        Your data is processed securely and is not stored by the AI service. You can revoke consent at any time by clearing your browser data.
      </p>
      <div class="modal-actions">
        <button class="btn-secondary" id="consent-decline">Decline</button>
        <button class="btn-primary" id="consent-accept">I Understand &amp; Continue</button>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    if (window.lucide) lucide.createIcons();

    document.getElementById('consent-accept').addEventListener('click', () => {
      document.body.removeChild(overlay);
      resolve(true);
    });

    document.getElementById('consent-decline').addEventListener('click', () => {
      document.body.removeChild(overlay);
      resolve(false);
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        document.body.removeChild(overlay);
        resolve(false);
      }
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  MAIN ANALYSIS ORCHESTRATOR
// ══════════════════════════════════════════════════════════════════════════════
async function runAnalysis() {
  if (isAnalyzing) return;
  if (!currentUser) {
    showInsightError('Please log in to use AI Insights.');
    return;
  }

  // Check consent
  const consentKey = 'aiInsightsConsent';
  const hasConsented = localStorage.getItem(consentKey);
  if (!hasConsented) {
    const agreed = await showConsentDialog();
    if (!agreed) return;
    localStorage.setItem(consentKey, 'true');
  }

  const periodSelect = document.getElementById('insights-period');
  if (!periodSelect) return;
  const period = periodSelect.value; // 'this-year' or 'all-time'

  // Check cache
  const cached = loadInsightsCache(currentUser.uid, period);
  if (cached) {
    const financialData = await gatherFinancialData(period);
    renderInsights(cached, period, financialData);
    showCachedBadge(true);
    return;
  }

  isAnalyzing = true;
  showCachedBadge(false);
  showAnalyzingState();

  try {
    updateAnalysisStep(1, 'Fetching your financial data…');
    const financialData = await gatherFinancialData(period);

    if (financialData.transactionCount === 0 && financialData.incomeCount === 0) {
      hideAnalyzingState();
      showEmptyDataState(period);
      isAnalyzing = false;
      return;
    }

    updateAnalysisStep(2, 'AI is analyzing your data…');
    const insights = await callAnalysisAPI(financialData);

    updateAnalysisStep(3, 'Preparing your insights…');
    await new Promise(r => setTimeout(r, 400));

    saveInsightsCache(currentUser.uid, period, insights);
    hideAnalyzingState();
    renderInsights(insights, period, financialData);
  } catch (err) {
    hideAnalyzingState();
    if (err.message === 'HF_TOKEN_NOT_SET') {
      showInsightError('⚠️ AI token not configured.');
    } else if (err.message === 'RATE_LIMITED') {
      showInsightError('⏳ Rate limited. Please wait and try again.');
    } else if (err.message === 'MODEL_LOADING') {
      showInsightError('⏳ AI model is loading. Please try again in 20-30 seconds.');
    } else if (err.message === 'NOT_AUTHENTICATED') {
      showInsightError('Please log in to use AI Insights.');
    } else {
      console.error('Analysis error:', err);
      showInsightError('Analysis failed. Please try again.');
    }
  } finally {
    isAnalyzing = false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  UI RENDERING
// ══════════════════════════════════════════════════════════════════════════════

function showAnalyzingState() {
  const container = document.getElementById('insights-results');
  const emptyState = document.getElementById('insights-empty');
  const errorState = document.getElementById('insights-error');
  if (emptyState) emptyState.classList.add('hidden');
  if (errorState) errorState.classList.add('hidden');

  if (!container) return;
  container.innerHTML = `
    <div class="insights-analyzing">
      <div class="insights-analyzing-orb">
        <div class="orb-ring"></div>
        <div class="orb-ring"></div>
        <div class="orb-ring"></div>
        <div class="orb-core">
          <i data-lucide="brain" class="orb-icon"></i>
        </div>
      </div>
      <div class="insights-analyzing-steps">
        <div class="analysis-step active" id="analysis-step-1">
          <div class="step-dot"></div>
          <span>Fetching your financial data…</span>
        </div>
        <div class="analysis-step" id="analysis-step-2">
          <div class="step-dot"></div>
          <span>AI is analyzing your spending patterns…</span>
        </div>
        <div class="analysis-step" id="analysis-step-3">
          <div class="step-dot"></div>
          <span>Preparing your insights…</span>
        </div>
      </div>
    </div>`;
  container.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function updateAnalysisStep(step, text) {
  // Mark previous steps as done
  for (let i = 1; i < step; i++) {
    const el = document.getElementById('analysis-step-' + i);
    if (el) {
      el.classList.remove('active');
      el.classList.add('done');
    }
  }
  const currentStep = document.getElementById('analysis-step-' + step);
  if (currentStep) {
    currentStep.classList.add('active');
    const span = currentStep.querySelector('span');
    if (span) span.textContent = text;
  }
}

function hideAnalyzingState() {
  // Will be replaced by renderInsights or error
}

function showEmptyDataState(period) {
  const container = document.getElementById('insights-results');
  if (!container) return;
  container.innerHTML = `
    <div class="insights-empty-data">
      <div class="empty-data-icon">
        <i data-lucide="file-search"></i>
      </div>
      <h3>No data for ${period}</h3>
      <p>Add some expenses or income entries first, then come back for AI analysis.</p>
    </div>`;
  container.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function showInsightError(msg) {
  const errorEl = document.getElementById('insights-error');
  const results = document.getElementById('insights-results');
  if (results) results.classList.add('hidden');
  if (!errorEl) return;
  errorEl.querySelector('.insights-error-text').textContent = msg;
  errorEl.classList.remove('hidden');
}

function showCachedBadge(show) {
  const badge = document.getElementById('insights-cached-badge');
  if (badge) badge.classList.toggle('hidden', !show);
}

function renderInsights(insights, period, data) {
  const container = document.getElementById('insights-results');
  const emptyState = document.getElementById('insights-empty');
  const errorState = document.getElementById('insights-error');
  if (emptyState) emptyState.classList.add('hidden');
  if (errorState) errorState.classList.add('hidden');
  if (!container) return;

  const s = insights.summary || {};
  const patterns = insights.patterns || [];
  const recommendations = insights.recommendations || [];
  const alerts = insights.alerts || [];
  const categoryAnalysis = insights.categoryAnalysis || [];

  // Health score color
  const score = s.healthScore || 50;
  let scoreColor = '#10b981'; // green
  let scoreLabel = 'Excellent';
  if (score < 40) { scoreColor = '#ef4444'; scoreLabel = 'Needs Attention'; }
  else if (score < 60) { scoreColor = '#f59e0b'; scoreLabel = 'Fair'; }
  else if (score < 80) { scoreColor = '#06b6d4'; scoreLabel = 'Good'; }

  let html = '';

  // ── Summary Card ──
  html += `
    <div class="insight-card insight-summary-card" style="animation-delay: 0.05s">
      <div class="insight-summary-top">
        <div class="insight-score-ring">
          <svg viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="42" fill="none" stroke="var(--border)" stroke-width="8" />
            <circle cx="50" cy="50" r="42" fill="none" stroke="${scoreColor}" stroke-width="8"
              stroke-dasharray="${(score / 100) * 264} 264"
              stroke-linecap="round" transform="rotate(-90 50 50)"
              style="transition: stroke-dasharray 1s ease" />
          </svg>
          <div class="score-text">
            <span class="score-number" style="color:${scoreColor}">${score}</span>
            <span class="score-label">${escapeHtml(scoreLabel)}</span>
          </div>
        </div>
        <div class="insight-summary-info">
          <h3>${escapeHtml(s.headline || 'Your Financial Summary')}</h3>
          <p class="insight-period">${escapeHtml(data.period || period)}</p>
          <div class="insight-highlights">
            ${(s.highlights || []).map(h => `<div class="highlight-item"><i data-lucide="sparkles"></i><span>${escapeHtml(h)}</span></div>`).join('')}
          </div>
        </div>
      </div>
    </div>`;

  // ── Alerts ──
  if (alerts.length > 0) {
    html += `<div class="insight-section" style="animation-delay: 0.1s">
      <div class="insight-section-header">
        <i data-lucide="alert-triangle"></i>
        <h3>Alerts</h3>
      </div>
      <div class="insight-alerts-grid">`;
    alerts.forEach(a => {
      const sevClass = a.severity === 'critical' ? 'critical' : a.severity === 'warning' ? 'warning' : 'info';
      const sevIcon = a.severity === 'critical' ? 'alert-octagon' : a.severity === 'warning' ? 'alert-triangle' : 'info';
      html += `
        <div class="insight-alert alert-${sevClass}">
          <div class="alert-icon-wrap"><i data-lucide="${sevIcon}"></i></div>
          <div class="alert-content">
            <strong>${escapeHtml(a.title)}</strong>
            <p>${escapeHtml(a.description)}</p>
          </div>
        </div>`;
    });
    html += `</div></div>`;
  }

  // ── Category Analysis ──
  if (categoryAnalysis.length > 0) {
    html += `<div class="insight-section" style="animation-delay: 0.15s">
      <div class="insight-section-header">
        <i data-lucide="pie-chart"></i>
        <h3>Category Breakdown</h3>
      </div>
      <div class="insight-categories">`;
    const maxAmt = Math.max(...categoryAnalysis.map(c => c.amount || 0), 1);
    categoryAnalysis.forEach(c => {
      const pct = c.percentage || ((c.amount / maxAmt) * 100);
      const trendIcon = c.trend === 'up' ? 'trending-up' : c.trend === 'down' ? 'trending-down' : 'minus';
      const trendClass = c.trend === 'up' ? 'trend-up' : c.trend === 'down' ? 'trend-down' : 'trend-stable';
      html += `
        <div class="insight-category-row">
          <div class="cat-row-header">
            <span class="cat-row-name">${escapeHtml(c.category)}</span>
            <div class="cat-row-meta">
              <span class="cat-row-amount">${fmt(c.amount || 0)}</span>
              <span class="cat-row-trend ${trendClass}"><i data-lucide="${trendIcon}"></i></span>
            </div>
          </div>
          <div class="cat-row-bar-bg">
            <div class="cat-row-bar-fill" style="width: ${Math.min(pct, 100)}%"></div>
          </div>
          <p class="cat-row-comment">${escapeHtml(c.comment || '')}</p>
        </div>`;
    });
    html += `</div></div>`;
  }

  // ── Patterns ──
  if (patterns.length > 0) {
    html += `<div class="insight-section" style="animation-delay: 0.2s">
      <div class="insight-section-header">
        <i data-lucide="scan-search"></i>
        <h3>Spending Patterns</h3>
      </div>
      <div class="insight-patterns-grid">`;
    patterns.forEach(p => {
      const typeIcon = p.type === 'warning' ? 'alert-triangle' : p.type === 'success' ? 'check-circle' : 'info';
      const typeClass = p.type || 'info';
      html += `
        <div class="insight-pattern pattern-${typeClass}">
          <div class="pattern-icon"><i data-lucide="${typeIcon}"></i></div>
          <div class="pattern-content">
            <strong>${escapeHtml(p.title)}</strong>
            <p>${escapeHtml(p.description)}</p>
          </div>
        </div>`;
    });
    html += `</div></div>`;
  }

  // ── Recommendations ──
  if (recommendations.length > 0) {
    html += `<div class="insight-section" style="animation-delay: 0.25s">
      <div class="insight-section-header">
        <i data-lucide="lightbulb"></i>
        <h3>Smart Recommendations</h3>
      </div>
      <div class="insight-recommendations">`;
    recommendations.forEach(r => {
      const prioClass = r.priority || 'medium';
      const prioLabel = r.priority === 'high' ? 'High Priority' : r.priority === 'low' ? 'Nice to Have' : 'Recommended';
      html += `
        <div class="insight-recommendation rec-${prioClass}">
          <div class="rec-header">
            <span class="rec-priority-badge ${prioClass}">${prioLabel}</span>
            ${r.savingsEstimate ? `<span class="rec-savings">💰 Save ${escapeHtml(r.savingsEstimate)}</span>` : ''}
          </div>
          <strong>${escapeHtml(r.title)}</strong>
          <p>${escapeHtml(r.description)}</p>
        </div>`;
    });
    html += `</div></div>`;
  }

  // ── Debt Analysis ──
  const debtAnalysis = insights.debtAnalysis;
  if (debtAnalysis && (data.debt.totalDebtCount > 0 || (debtAnalysis.insights && debtAnalysis.insights.length > 0))) {
    const debt = data.debt;
    const netPositionClass = debt.netDebtPosition >= 0 ? 'positive' : 'negative';
    const netPositionIcon = debt.netDebtPosition >= 0 ? 'trending-up' : 'trending-down';
    const netPositionLabel = debt.netDebtPosition >= 0 ? 'In Your Favor' : 'Needs Attention';
    const settlementRateColor = debt.settlementRate >= 70 ? '#10b981' : debt.settlementRate >= 40 ? '#f59e0b' : '#ef4444';
    
    html += `<div class="insight-section" style="animation-delay: 0.3s">
      <div class="insight-section-header">
        <i data-lucide="hand-coins"></i>
        <h3>Debt Analysis</h3>
      </div>
      
      <div class="debt-summary-cards">
        <div class="debt-summary-card">
          <div class="debt-card-icon"><i data-lucide="arrow-down-left"></i></div>
          <div class="debt-card-info">
            <span class="debt-label">Owed to You</span>
            <span class="debt-amount">${fmt(debt.totalOwedToYou)}</span>
            <span class="debt-sub">${debt.activeCount} active debt${debt.activeCount !== 1 ? 's' : ''}</span>
          </div>
        </div>
        
        <div class="debt-summary-card">
          <div class="debt-card-icon" style="background: var(--danger-bg); color: var(--danger);"><i data-lucide="arrow-up-right"></i></div>
          <div class="debt-card-info">
            <span class="debt-label">You Owe</span>
            <span class="debt-amount" style="color: var(--danger);">${fmt(debt.totalYouOwe)}</span>
            <span class="debt-sub">Outstanding</span>
          </div>
        </div>
        
        <div class="debt-summary-card">
          <div class="debt-card-icon" style="background: var(--success-bg); color: var(--success);"><i data-lucide="check-circle"></i></div>
          <div class="debt-card-info">
            <span class="debt-label">Settled</span>
            <span class="debt-amount" style="color: var(--success);">${fmt(debt.totalSettled)}</span>
            <span class="debt-sub">${debt.settledCount} debt${debt.settledCount !== 1 ? 's' : ''} cleared</span>
          </div>
        </div>
      </div>
      
      <div class="debt-net-position">
        <div class="net-position-header">
          <i data-lucide="${netPositionIcon}"></i>
          <span>Net Position</span>
        </div>
        <div class="net-position-value ${netPositionClass}">
          ${fmt(Math.abs(debt.netDebtPosition))}
          <span class="net-position-badge ${netPositionClass}">${netPositionLabel}</span>
        </div>
        <p class="net-position-desc">${debt.netDebtPosition > 0 ? 'Others owe you more than you owe them' : 'You owe more than others owe you'}</p>
      </div>
      
      ${debt.settlementRate > 0 ? `
      <div class="debt-settlement-rate">
        <div class="settlement-rate-header">
          <span>Settlement Rate</span>
          <span class="settlement-rate-value">${debt.settlementRate.toFixed(1)}%</span>
        </div>
        <div class="settlement-rate-bar">
          <div class="settlement-rate-fill" style="width: ${debt.settlementRate}%; background: ${settlementRateColor};"></div>
        </div>
      </div>` : ''}
      
      ${debtAnalysis.insights && debtAnalysis.insights.length > 0 ? `
      <div class="debt-insights-list">
        <h4 class="debt-insights-title">AI Debt Insights</h4>`;
      
      debtAnalysis.insights.forEach(insight => {
        const typeIcon = insight.type === 'warning' ? 'alert-triangle' : insight.type === 'success' ? 'check-circle' : 'info';
        const typeClass = insight.type || 'info';
        html += `
        <div class="debt-insight-item insight-${typeClass}">
          <div class="insight-icon"><i data-lucide="${typeIcon}"></i></div>
          <div class="insight-content">
            <strong>${escapeHtml(insight.title)}</strong>
            <p>${escapeHtml(insight.description)}</p>
          </div>
        </div>`;
      });
      
      html += `</div>` : ''}
      
      ${debtAnalysis.topDebtors && debtAnalysis.topDebtors.length > 0 ? `
      <div class="debt-people">
        <h4 class="debt-people-title"><i data-lucide="users"></i> Top Debtors</h4>
        <div class="people-list">`;
      
      debtAnalysis.topDebtors.forEach(person => {
        html += `<div class="person-item"><span>${escapeHtml(person)}</span></div>`;
      });
      
      html += `</div></div>` : ''}
      
      ${debtAnalysis.topCreditors && debtAnalysis.topCreditors.length > 0 ? `
      <div class="debt-people">
        <h4 class="debt-people-title creditors"><i data-lucide="users"></i> Top Creditors</h4>
        <div class="people-list">`;
      
      debtAnalysis.topCreditors.forEach(person => {
        html += `<div class="person-item"><span>${escapeHtml(person)}</span></div>`;
      });
      
      html += `</div></div>` : ''}
    </div>`;
  }

  container.innerHTML = html;
  container.classList.remove('hidden');

  // Animate elements in
  requestAnimationFrame(() => {
    if (window.lucide) lucide.createIcons();
    // Trigger bar animations
    container.querySelectorAll('.cat-row-bar-fill').forEach((bar, i) => {
      const width = bar.style.width;
      bar.style.width = '0%';
      setTimeout(() => { bar.style.width = width; }, 100 + i * 60);
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  REFRESH (bypass cache)
// ══════════════════════════════════════════════════════════════════════════════
async function refreshAnalysis() {
  if (!currentUser) return;
  const periodSelect = document.getElementById('insights-period');
  if (!periodSelect) return;
  const period = periodSelect.value;
  try {
    localStorage.removeItem(getCacheKey(currentUser.uid, period));
  } catch (_) { }
  showCachedBadge(false);
  await runAnalysis();
}

// ══════════════════════════════════════════════════════════════════════════════
//  INIT — Wire up events
// ══════════════════════════════════════════════════════════════════════════════
function initInsightsUI() {
  // Analyze button
  const analyzeBtn = document.getElementById('insights-analyze-btn');
  if (analyzeBtn) analyzeBtn.addEventListener('click', runAnalysis);

  // Refresh button
  const refreshBtn = document.getElementById('insights-refresh-btn');
  if (refreshBtn) refreshBtn.addEventListener('click', refreshAnalysis);
}

// ── DOM-ready dispatcher ─────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initInsightsUI);
} else {
  initInsightsUI();
}
