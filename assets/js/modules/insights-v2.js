// insights-v2.js — SpendWise AI Insights Module (Redesigned)
// Uses Qwen2.5 for intelligent financial data analysis

import { app } from '../config/firebase.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, getDocs, query, where } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const auth = getAuth(app);
const db = getFirestore(app);

const fmt = window.fmt;
const getCurrency = window.getCurrency;
const getCurrencyInfo = window.getCurrencyInfo;

let HF_TOKEN = '__HF_TOKEN_PLACEHOLDER__';
try {
  const config = await import('../../voice-config.js');
  if (config.HF_TOKEN) HF_TOKEN = config.HF_TOKEN;
} catch (_) { /* voice-config.js not present */ }

const HF_MODEL = 'Qwen/Qwen2.5-72B-Instruct';
const HF_API_URL = 'https://router.huggingface.co/v1/chat/completions';

const CACHE_KEY_PREFIX = 'spendwise_insights_v2_';
const CACHE_MAX_AGE_MS = 30 * 60 * 1000;

const EXPENSE_CATEGORIES = [
  'Food & Dining', 'Transport', 'Shopping', 'Entertainment', 'Health',
  'Bills & Utilities', 'Education', 'Travel', 'Groceries', 'Subscription',
  'Rent', 'Investment', 'Personal Care', 'Gifts', 'Other'
];

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

let currentUser = null;
let isAnalyzing = false;
let selectedPeriod = 'month';
let selectedAnalysisType = 'overview';

onAuthStateChanged(auth, user => {
  currentUser = user;
});

function pad(n) { return String(n).padStart(2, '0'); }

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getPeriodDates() {
  const today = new Date();
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1;
  const currentDay = today.getDate();

  let startDate, endDate, label;

  switch (selectedPeriod) {
    case 'month':
      startDate = `${currentYear}-${pad(currentMonth)}-01`;
      endDate = `${currentYear}-${pad(currentMonth)}-${pad(new Date(currentYear, currentMonth, 0).getDate())}`;
      label = `${MONTH_NAMES[currentMonth - 1]} ${currentYear}`;
      break;
    case 'lastMonth':
      let lm = currentMonth - 1;
      let ly = currentYear;
      if (lm < 1) { lm = 12; ly--; }
      startDate = `${ly}-${pad(lm)}-01`;
      endDate = `${ly}-${pad(lm)}-${pad(new Date(ly, lm, 0).getDate())}`;
      label = `${MONTH_NAMES[lm - 1]} ${ly}`;
      break;
    case 'quarter':
      const quarterMonths = Math.floor((currentMonth - 1) / 3);
      const startM = quarterMonths * 3;
      startDate = `${currentYear}-${pad(startM + 1)}-01`;
      const quarterEndMonth = startM + 3;
      endDate = `${currentYear}-${pad(quarterEndMonth)}-${pad(new Date(currentYear, quarterEndMonth, 0).getDate())}`;
      label = `Q${quarterMonths + 1} ${currentYear}`;
      break;
    case 'year':
      startDate = `${currentYear}-01-01`;
      endDate = `${currentYear}-12-31`;
      label = `${currentYear}`;
      break;
    case 'custom':
      startDate = document.getElementById('insights-start-date')?.value || '';
      endDate = document.getElementById('insights-end-date')?.value || '';
      const s = new Date(startDate);
      const e = new Date(endDate);
      label = `${s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${e.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
      break;
  }

  return { startDate, endDate, label };
}

async function gatherFinancialData(startDate, endDate) {
  if (!currentUser) throw new Error('NOT_AUTHENTICATED');

  const expQ = query(collection(db, 'expenses'), where('uid', '==', currentUser.uid));
  const expSnap = await getDocs(expQ);
  let expenses = expSnap.docs.map(d => {
    const raw = d.data();
    const amt = parseFloat(raw.amount);
    return {
      amount: isNaN(amt) ? 0 : amt,
      category: raw.category || 'Other',
      date: raw.date || '',
      payment: raw.payment || 'UPI',
      description: raw.description || '-'
    };
  });

  const incQ = query(collection(db, 'income'), where('uid', '==', currentUser.uid));
  const incSnap = await getDocs(incQ);
  let income = incSnap.docs.map(d => {
    const raw = d.data();
    const amt = parseFloat(raw.amount);
    return {
      amount: isNaN(amt) ? 0 : amt,
      source: raw.source || 'Other',
      date: raw.date || '',
      paymentType: raw.paymentType || 'Online'
    };
  });

  const debtQ = query(collection(db, 'debts'), where('uid', '==', currentUser.uid));
  const debtSnap = await getDocs(debtQ);
  let debts = debtSnap.docs.map(d => {
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

  const selectedExpenses = expenses.filter(e => 
    e.date && e.date >= startDate && e.date <= endDate
  );
  const selectedIncome = income.filter(i => 
    i.date && i.date >= startDate && i.date <= endDate
  );
  const selectedDebts = debts.filter(d => 
    (d.date && d.date >= startDate && d.date <= endDate) ||
    (d.settled && d.settledDate && d.settledDate >= startDate && d.settledDate <= endDate)
  );

  const categoryBreakdown = {};
  selectedExpenses.forEach(e => {
    categoryBreakdown[e.category] = (categoryBreakdown[e.category] || 0) + e.amount;
  });

  const dailySpending = {};
  selectedExpenses.forEach(e => {
    dailySpending[e.date] = (dailySpending[e.date] || 0) + e.amount;
  });

  const paymentBreakdown = {};
  selectedExpenses.forEach(e => {
    paymentBreakdown[e.payment] = (paymentBreakdown[e.payment] || 0) + e.amount;
  });

  const dayOfWeekSpending = { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0, Sun: 0 };
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  selectedExpenses.forEach(e => {
    if (e.date) {
      const day = new Date(e.date + 'T00:00:00').getDay();
      dayOfWeekSpending[dayNames[day]] += e.amount;
    }
  });

  const start = new Date(startDate);
  const end = new Date(endDate);
  const daysInRange = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;

  const totalExpenses = selectedExpenses.reduce((sum, e) => sum + e.amount, 0);
  const totalIncome = selectedIncome.reduce((sum, i) => sum + i.amount, 0);

  const activeDebts = selectedDebts.filter(d => !d.settled);
  const settledDebts = selectedDebts.filter(d => d.settled);

  const totalOwedToYou = activeDebts.filter(d => d.type === 'they-owe').reduce((sum, d) => sum + d.amount, 0);
  const totalYouOwe = activeDebts.filter(d => d.type === 'i-owe').reduce((sum, d) => sum + d.amount, 0);
  const totalSettled = settledDebts.reduce((sum, d) => sum + d.amount, 0);

  return {
    totalExpenses,
    totalIncome,
    netSavings: totalIncome - totalExpenses,
    transactionCount: selectedExpenses.length,
    incomeCount: selectedIncome.length,
    avgDailySpend: daysInRange > 0 ? totalExpenses / daysInRange : 0,
    daysInRange,
    categoryBreakdown,
    dailySpending,
    paymentBreakdown,
    dayOfWeekSpending,
    topExpenses: [...selectedExpenses].sort((a, b) => b.amount - a.amount).slice(0, 5),
    incomeSources: selectedIncome,
    debt: {
      totalOwedToYou,
      totalYouOwe,
      totalSettled,
      netDebtPosition: totalOwedToYou - totalYouOwe,
      activeCount: activeDebts.length,
      settledCount: settledDebts.length,
      activeDebts,
      settledDebts,
      topDebtors: activeDebts.filter(d => d.type === 'they-owe').sort((a, b) => b.amount - a.amount).slice(0, 5),
      topCreditors: activeDebts.filter(d => d.type === 'i-owe').sort((a, b) => b.amount - a.amount).slice(0, 5)
    }
  };
}

function buildAnalysisPrompt(data, analysisType, periodLabel) {
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
    .map((e, i) => `  ${i + 1}. ${sym} ${e.amount.toFixed(2)} — ${e.category} (${e.description}) on ${e.date}`)
    .join('\n');

  const typeSpecificInstructions = {
    overview: "Provide a comprehensive overview of financial health, spending habits, savings potential, and actionable recommendations. Include all sections.",
    spending: "FOCUS: Expense deep-dive ONLY. Identify biggest spending categories, unusual patterns, spending habits by day/time, impulse purchases, and specific ways to reduce expenses. Heavy emphasis on spending analysis.",
    savings: "FOCUS: Savings opportunities ONLY. Identify areas to cut costs, suggest concrete savings targets (monthly and yearly), and provide a practical savings plan with specific actionable steps.",
    trends: "FOCUS: Spending patterns ONLY. Analyze trends by day of week, time of month, recurring expenses, seasonal variations, and predict future spending behavior. Focus on patterns.",
    goals: "FOCUS: Financial goals ONLY. Help set SMART savings goals, track progress, suggest realistic targets based on income. Include milestone tracking.",
    debt: "FOCUS: Debt management ONLY. Track outstanding debts, suggest payoff strategies (avalanche/snowball), analyze debt sustainability, and prioritize which debts to pay first."
  };

  const systemPrompt = `You are a professional financial advisor AI. Your analysis type is: **${analysisType.toUpperCase()}**

CRITICAL: You MUST focus your ENTIRE response on ${analysisType.toUpperCase()} analysis. Do NOT provide equal weight to all topics.

User's Period: ${periodLabel}

IMPORTANT RULES:
1. Be specific — reference actual numbers, categories, and patterns from the data.
2. Be actionable — give concrete suggestions with estimated savings when possible.
3. Consider Indian spending context (UPI payments, typical Indian expenses, festivals).
4. Return ONLY valid JSON, no markdown, no explanation.
5. Use "${sym}" prefix for all amounts.
6. Be encouraging but honest about areas needing improvement.
7. Include emojis in title fields for better visual appeal.

${typeSpecificInstructions[analysisType] || typeSpecificInstructions.overview}

Return JSON in this EXACT format:
{
  "summary": {
    "headline": "<one-line summary>",
    "healthScore": <1-100>,
    "totalSpent": <number>,
    "totalEarned": <number>,
    "netSavings": <number>,
    "topCategory": "<category name>",
    "keyTakeaway": "<one key thing to remember>"
  },
  "highlights": [
    {"icon": "<emoji or icon name>", "text": "<highlight text>"}
  ],
  "categoryBreakdown": [
    {"category": "<name>", "amount": <number>, "percentage": <number>, "icon": "<emoji>", "insight": "<brief insight>"}
  ],
  "patterns": [
    {"type": "info|warning|success", "title": "<emoji> <title>", "description": "<detail>"}
  ],
  "recommendations": [
    {"priority": "high|medium|low", "title": "<emoji> <title>", "description": "<detail>", "potentialSavings": "<amount or null>"}
  ],
  "spendingByDay": [
    {"day": "<name>", "amount": <number>}
  ],
  "quickWins": [
    {"action": "<specific action>", "savings": "<estimated savings>"}
  ]
}`;

  let userPrompt = `ANALYSIS REQUEST: **${analysisType.toUpperCase()}** analysis for ${periodLabel}

FINANCIAL DATA:

OVERVIEW:
- Total Expenses: ${sym} ${data.totalExpenses.toFixed(2)} (${data.transactionCount} transactions)
- Total Income: ${sym} ${data.totalIncome.toFixed(2)} (${data.incomeCount} entries)
- Net Savings: ${sym} ${data.netSavings.toFixed(2)}
- Average Daily Spend: ${sym} ${data.avgDailySpend.toFixed(2)}

CATEGORY BREAKDOWN:
${categoryList || 'No expenses recorded.'}

SPENDING BY DAY OF WEEK:
${dayOfWeekList}

PAYMENT METHODS:
${paymentList || 'No payment data.'}

TOP EXPENSES:
${topExpenseList || 'No expenses recorded.'}

DEBT STATUS:
- Total Owed to You: ${sym} ${data.debt.totalOwedToYou.toFixed(2)}
- Total You Owe: ${sym} ${data.debt.totalYouOwe.toFixed(2)}
- Total Settled: ${sym} ${data.debt.totalSettled.toFixed(2)}

IMPORTANT: Provide ${analysisType.toUpperCase()} analysis based on the above data. Focus specifically on ${analysisType}-related insights and recommendations.`;

  if (analysisType === 'debt' || analysisType === 'overview') {
    if (data.debt.topDebtors.length > 0) {
      userPrompt += `\n\nTOP DEBTORS:\n${data.debt.topDebtors.map(d => `  - ${d.person}: ${sym} ${d.amount.toFixed(2)}`).join('\n')}`;
    }
    if (data.debt.topCreditors.length > 0) {
      userPrompt += `\n\nTOP CREDITORS:\n${data.debt.topCreditors.map(d => `  - ${d.person}: ${sym} ${d.amount.toFixed(2)}`).join('\n')}`;
    }
  }

  return { system: systemPrompt, user: userPrompt };
}

async function callAnalysisAPI(data, analysisType, periodLabel) {
  if (!HF_TOKEN || HF_TOKEN.length < 10 || HF_TOKEN.includes('PLACEHOLDER')) {
    throw new Error('HF_TOKEN_NOT_SET');
  }

  const prompt = buildAnalysisPrompt(data, analysisType, periodLabel);
  
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
      max_tokens: 2500,
      temperature: 0.4,
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

  let jsonStr = content.trim();
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonStr = jsonMatch[1].trim();
  const objMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (objMatch) jsonStr = objMatch[0];

  return JSON.parse(jsonStr);
}

function getCacheKey(uid, period, type, start, end) {
  return CACHE_KEY_PREFIX + uid + '_' + period + '_' + type + '_' + start + '_' + end;
}

function saveInsightsCache(key, insights) {
  try {
    const payload = JSON.stringify({ ts: Date.now(), data: insights });
    localStorage.setItem(key, payload);
  } catch (_) { }
}

function loadInsightsCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.ts > CACHE_MAX_AGE_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return parsed.data;
  } catch { return null; }
}

async function showConsentDialog() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);';

    const modal = document.createElement('div');
    modal.style.cssText = 'width:100%;max-width:420px;background:var(--surface);border-radius:16px;padding:24px;box-shadow:0 8px 32px rgba(0,0,0,0.2);';
    modal.innerHTML = `
      <div style="width:48px;height:48px;border-radius:12px;background:var(--accent-bg);color:var(--accent);display:flex;align-items:center;justify-content:center;margin-bottom:16px;">
        <i data-lucide="brain" style="width:24px;height:24px;"></i>
      </div>
      <h3 style="font-size:1.125rem;font-weight:600;margin:0 0 12px;color:var(--text);">AI Analysis Consent</h3>
      <p style="font-size:0.875rem;color:var(--text2);margin:0 0 16px;line-height:1.5;">
        To provide personalized insights, your financial data will be sent to an AI service for analysis.
      </p>
      <p style="font-size:0.8125rem;color:var(--text3);margin:0 0 20px;line-height:1.4;">
        <strong>Sent:</strong> Transaction amounts, categories, dates, payment methods.<br>
        <strong>Not sent:</strong> Your name, email, or any personal identifiers.
      </p>
      <div style="display:flex;gap:12px;">
        <button id="consent-decline" style="flex:1;padding:12px;border-radius:10px;border:1px solid var(--border);background:var(--bg2);color:var(--text2);font-weight:500;cursor:pointer;">Decline</button>
        <button id="consent-accept" style="flex:1;padding:12px;border-radius:10px;border:none;background:var(--accent);color:#fff;font-weight:600;cursor:pointer;">Continue</button>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    if (window.lucide) lucide.createIcons();

    const closeAndResolve = (result) => {
      overlay.style.opacity = '0';
      overlay.style.transition = 'opacity 0.2s';
      setTimeout(() => {
        document.body.removeChild(overlay);
        resolve(result);
      }, 200);
    };

    document.getElementById('consent-accept').addEventListener('click', () => closeAndResolve(true));
    document.getElementById('consent-decline').addEventListener('click', () => closeAndResolve(false));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeAndResolve(false);
    });
  });
}

async function runAnalysis(forceRefresh = false) {
  if (isAnalyzing) return;
  if (!currentUser) {
    showError('Please log in to use AI Insights.');
    return;
  }

  const consentKey = 'aiInsightsConsentV2';
  if (!localStorage.getItem(consentKey)) {
    const agreed = await showConsentDialog();
    if (!agreed) return;
    localStorage.setItem(consentKey, 'true');
  }

  const { startDate, endDate, label } = getPeriodDates();
  if (!startDate || !endDate) {
    showError('Please select a valid date range.');
    return;
  }

  const cacheKey = getCacheKey(currentUser.uid, selectedPeriod, selectedAnalysisType, startDate, endDate);
  const cached = forceRefresh ? null : loadInsightsCache(cacheKey);

  if (cached) {
    renderInsights(cached, label);
    showCachedBadge(true);
    return;
  }

  isAnalyzing = true;
  showCachedBadge(false);
  showLoadingState();

  try {
    updateLoadingStep(1);
    const financialData = await gatherFinancialData(startDate, endDate);

    if (financialData.transactionCount === 0 && financialData.incomeCount === 0) {
      hideLoadingState();
      showEmptyState();
      isAnalyzing = false;
      return;
    }

    updateLoadingStep(2);
    const insights = await callAnalysisAPI(financialData, selectedAnalysisType, label);

    updateLoadingStep(3);
    await new Promise(r => setTimeout(r, 300));

    saveInsightsCache(cacheKey, insights);

    hideLoadingState();
    renderInsights(insights, label);
  } catch (err) {
    hideLoadingState();
    if (err.message === 'HF_TOKEN_NOT_SET') {
      showError('AI token not configured. Please set up your Hugging Face API token.');
    } else if (err.message === 'RATE_LIMITED') {
      showError('Rate limited. Please wait a moment and try again.');
    } else if (err.message === 'MODEL_LOADING') {
      showError('AI model is loading. Please try again in 20-30 seconds.');
    } else if (err.message === 'NOT_AUTHENTICATED') {
      showError('Please log in to use AI Insights.');
    } else {
      console.error('Analysis error:', err);
      showError('Analysis failed. Please try again.');
    }
  } finally {
    isAnalyzing = false;
  }
}

function showError(msg) {
  const errorEl = document.getElementById('insights-error');
  const results = document.getElementById('insights-results');
  const empty = document.getElementById('insights-empty');
  const loading = document.getElementById('insights-loading');

  if (results) results.classList.add('hidden');
  if (empty) empty.classList.add('hidden');
  if (loading) loading.classList.add('hidden');

  if (!errorEl) return;
  document.getElementById('error-message').textContent = msg;
  errorEl.classList.remove('hidden');
}

function showLoadingState() {
  const results = document.getElementById('insights-results');
  const empty = document.getElementById('insights-empty');
  const error = document.getElementById('insights-error');
  const loading = document.getElementById('insights-loading');

  if (results) results.classList.add('hidden');
  if (empty) empty.classList.add('hidden');
  if (error) error.classList.add('hidden');
  if (loading) loading.classList.remove('hidden');

  document.querySelectorAll('.load-step').forEach((el, i) => {
    el.classList.remove('active', 'done');
    if (i === 0) el.classList.add('active');
  });
}

function updateLoadingStep(step) {
  document.querySelectorAll('.load-step').forEach(el => {
    const s = parseInt(el.dataset.step);
    if (s < step) el.classList.add('done');
    else if (s === step) el.classList.add('active');
    else el.classList.remove('active', 'done');
  });
}

function hideLoadingState() {
  const loading = document.getElementById('insights-loading');
  if (loading) loading.classList.add('hidden');
}

function showEmptyState() {
  const empty = document.getElementById('insights-empty');
  if (empty) empty.classList.remove('hidden');
}

function showCachedBadge(show) {
  const badge = document.getElementById('cached-indicator');
  if (badge) badge.classList.toggle('hidden', !show);
}

function renderInsights(insights, periodLabel) {
  const container = document.getElementById('insights-results');
  const empty = document.getElementById('insights-empty');
  const error = document.getElementById('insights-error');

  if (empty) empty.classList.add('hidden');
  if (error) error.classList.add('hidden');
  if (!container) return;

  const s = insights.summary || {};
  const highlights = insights.highlights || [];
  const categoryBreakdown = insights.categoryBreakdown || [];
  const patterns = insights.patterns || [];
  const recommendations = insights.recommendations || [];
  const spendingByDay = insights.spendingByDay || [];
  const quickWins = insights.quickWins || [];

  const score = s.healthScore || 50;
  let scoreColor = '#10b981';
  let scoreLabel = 'Excellent';
  if (score < 40) { scoreColor = '#ef4444'; scoreLabel = 'Needs Work'; }
  else if (score < 60) { scoreColor = '#f59e0b'; scoreLabel = 'Fair'; }
  else if (score < 80) { scoreColor = '#06b6d4'; scoreLabel = 'Good'; }

  const cur = getCurrencyInfo(getCurrency());
  const sym = cur.symbol;

  let html = '';

  html += `
    <div class="results-header">
      <div class="results-header-left">
        <div class="period-badge">
          <i data-lucide="calendar"></i>
          <span>${escapeHtml(periodLabel)}</span>
        </div>
      </div>
      <div class="results-actions">
        <button class="refresh-btn" id="refresh-btn" title="Refresh Analysis">
          <i data-lucide="refresh-cw"></i>
        </button>
        <button class="download-pdf-btn" id="download-pdf-btn" title="Download as PDF">
          <i data-lucide="download"></i>
          <span>Download PDF</span>
        </button>
      </div>
    </div>

    <div class="summary-section">
      <div class="health-score-card">
        <div class="score-ring-wrap">
          <svg viewBox="0 0 120 120" class="score-ring">
            <circle cx="60" cy="60" r="52" fill="none" stroke="var(--border)" stroke-width="10"/>
            <circle cx="60" cy="60" r="52" fill="none" stroke="${scoreColor}" stroke-width="10"
              stroke-dasharray="${(score / 100) * 327} 327"
              stroke-linecap="round" transform="rotate(-90 60 60)"
              class="score-progress"/>
          </svg>
          <div class="score-center">
            <span class="score-value" style="color: ${scoreColor}">${score}</span>
            <span class="score-max">/100</span>
          </div>
        </div>
        <div class="score-info">
          <h3 class="headline">${escapeHtml(s.headline || 'Financial Health')}</h3>
          <span class="score-label-text" style="color: ${scoreColor}">${scoreLabel}</span>
        </div>
      </div>

      <div class="stats-grid">
        <div class="stat-card income">
          <div class="stat-icon"><i data-lucide="trending-up"></i></div>
          <div class="stat-content">
            <span class="stat-label">Income</span>
            <span class="stat-value">${sym} ${(s.totalEarned || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>
          </div>
        </div>
        <div class="stat-card expense">
          <div class="stat-icon"><i data-lucide="trending-down"></i></div>
          <div class="stat-content">
            <span class="stat-label">Expenses</span>
            <span class="stat-value">${sym} ${(s.totalSpent || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>
          </div>
        </div>
        <div class="stat-card savings ${(s.netSavings || 0) >= 0 ? 'positive' : 'negative'}">
          <div class="stat-icon"><i data-lucide="wallet"></i></div>
          <div class="stat-content">
            <span class="stat-label">Net Savings</span>
            <span class="stat-value">${sym} ${Math.abs(s.netSavings || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>
          </div>
        </div>
      </div>
    </div>`;

  if (highlights.length > 0) {
    html += `
      <div class="highlights-section">
        <div class="section-title">
          <i data-lucide="star"></i>
          <h3>Key Highlights</h3>
        </div>
        <div class="highlights-list">`;
    highlights.forEach((h, i) => {
      html += `
          <div class="highlight-item" style="animation-delay: ${i * 0.05}s">
            <span class="highlight-icon">${escapeHtml(h.icon || '✨')}</span>
            <span class="highlight-text">${escapeHtml(h.text)}</span>
          </div>`;
    });
    html += `</div></div>`;
  }

  if (categoryBreakdown.length > 0) {
    const maxAmount = Math.max(...categoryBreakdown.map(c => c.amount || 0), 1);
    html += `
      <div class="categories-section">
        <div class="section-title">
          <i data-lucide="pie-chart"></i>
          <h3>Spending by Category</h3>
        </div>
        <div class="categories-grid">`;
    categoryBreakdown.slice(0, 6).forEach((cat, i) => {
      const pct = cat.percentage || ((cat.amount / maxAmount) * 100);
      html += `
          <div class="category-card" style="animation-delay: ${i * 0.05}s">
            <div class="cat-header">
              <span class="cat-icon">${escapeHtml(cat.icon || '📊')}</span>
              <span class="cat-name">${escapeHtml(cat.category)}</span>
            </div>
            <div class="cat-amount">${sym} ${(cat.amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</div>
            <div class="cat-bar-bg">
              <div class="cat-bar-fill" style="width: ${Math.min(pct, 100)}%"></div>
            </div>
            <div class="cat-pct">${pct.toFixed(1)}% of total</div>
            ${cat.insight ? `<p class="cat-insight">${escapeHtml(cat.insight)}</p>` : ''}
          </div>`;
    });
    html += `</div></div>`;
  }

  if (patterns.length > 0) {
    html += `
      <div class="patterns-section">
        <div class="section-title">
          <i data-lucide="scan-search"></i>
          <h3>Patterns Detected</h3>
        </div>
        <div class="patterns-list">`;
    patterns.forEach((p, i) => {
      const typeClass = p.type || 'info';
      const typeIcon = p.type === 'warning' ? 'alert-triangle' : p.type === 'success' ? 'check-circle' : 'info';
      html += `
          <div class="pattern-card ${typeClass}" style="animation-delay: ${i * 0.05}s">
            <div class="pattern-icon"><i data-lucide="${typeIcon}"></i></div>
            <div class="pattern-content">
              <h4>${escapeHtml(p.title)}</h4>
              <p>${escapeHtml(p.description)}</p>
            </div>
          </div>`;
    });
    html += `</div></div>`;
  }

  if (spendingByDay.length > 0) {
    const maxDaySpend = Math.max(...spendingByDay.map(d => d.amount || 0), 1);
    html += `
      <div class="day-chart-section">
        <div class="section-title">
          <i data-lucide="bar-chart-2"></i>
          <h3>Spending by Day</h3>
        </div>
        <div class="day-bars">`;
    spendingByDay.forEach((d, i) => {
      const pct = ((d.amount || 0) / maxDaySpend) * 100;
      html += `
          <div class="day-bar-item" style="animation-delay: ${i * 0.03}s">
            <div class="day-bar-wrap">
              <div class="day-bar" style="height: ${Math.max(pct, 2)}%"></div>
            </div>
            <span class="day-label">${escapeHtml(d.day)}</span>
            <span class="day-amount">${sym} ${(d.amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>
          </div>`;
    });
    html += `</div></div>`;
  }

  if (quickWins.length > 0) {
    html += `
      <div class="quickwins-section">
        <div class="section-title">
          <i data-lucide="zap"></i>
          <h3>Quick Wins</h3>
        </div>
        <div class="quickwins-list">`;
    quickWins.forEach((qw, i) => {
      html += `
          <div class="quickwin-card" style="animation-delay: ${i * 0.05}s">
            <div class="qw-icon"><i data-lucide="arrow-right-circle"></i></div>
            <div class="qw-content">
              <span class="qw-action">${escapeHtml(qw.action)}</span>
              ${qw.savings ? `<span class="qw-savings">Save ${escapeHtml(qw.savings)}</span>` : ''}
            </div>
          </div>`;
    });
    html += `</div></div>`;
  }

  if (recommendations.length > 0) {
    html += `
      <div class="recommendations-section">
        <div class="section-title">
          <i data-lucide="lightbulb"></i>
          <h3>Recommendations</h3>
        </div>
        <div class="recommendations-list">`;
    recommendations.forEach((r, i) => {
      const prioClass = r.priority || 'medium';
      const prioColor = prioClass === 'high' ? 'var(--danger)' : prioClass === 'medium' ? 'var(--warning)' : 'var(--success)';
      html += `
          <div class="recommendation-card ${prioClass}" style="animation-delay: ${i * 0.05}s">
            <div class="rec-priority-indicator" style="background: ${prioColor}"></div>
            <div class="rec-content">
              <h4>${escapeHtml(r.title)}</h4>
              <p>${escapeHtml(r.description)}</p>
              ${r.potentialSavings ? `<span class="rec-savings-tag">💰 Potential savings: ${escapeHtml(r.potentialSavings)}</span>` : ''}
            </div>
          </div>`;
    });
    html += `</div></div>`;
  }

  if (s.keyTakeaway) {
    html += `
      <div class="takeaway-section">
        <div class="takeaway-card">
          <div class="takeaway-icon"><i data-lucide="message-circle"></i></div>
          <div class="takeaway-content">
            <h4>Key Takeaway</h4>
            <p>${escapeHtml(s.keyTakeaway)}</p>
          </div>
        </div>
      </div>`;
  }

  container.innerHTML = html;
  container.classList.remove('hidden');

  requestAnimationFrame(() => {
    if (window.lucide) lucide.createIcons();

    container.querySelectorAll('.cat-bar-fill').forEach((bar, i) => {
      const width = bar.style.width;
      bar.style.width = '0%';
      setTimeout(() => { bar.style.width = width; }, 100 + i * 60);
    });

    container.querySelectorAll('.day-bar').forEach((bar, i) => {
      const height = bar.style.height;
      bar.style.height = '0%';
      setTimeout(() => { bar.style.height = height; }, 100 + i * 40);
    });
  });
}

function initUI() {
  const periodTabs = document.getElementById('period-tabs');
  const typeGrid = document.getElementById('analysis-type-grid');
  const analyzeBtn = document.getElementById('analyze-btn');
  const customRange = document.getElementById('custom-date-range');

  if (periodTabs) {
    periodTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.period-tab');
      if (!tab) return;

      periodTabs.querySelectorAll('.period-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      selectedPeriod = tab.dataset.period;

      if (customRange) {
        customRange.classList.toggle('hidden', selectedPeriod !== 'custom');
      }
    });
  }

  if (typeGrid) {
    typeGrid.addEventListener('click', (e) => {
      const card = e.target.closest('.analysis-type-card');
      if (!card) return;

      typeGrid.querySelectorAll('.analysis-type-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');

      selectedAnalysisType = card.dataset.type;
    });
  }

  if (analyzeBtn) {
    analyzeBtn.addEventListener('click', () => runAnalysis(false));
  }

  const startDateInput = document.getElementById('insights-start-date');
  const endDateInput = document.getElementById('insights-end-date');
  if (startDateInput) {
    const today = new Date();
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    startDateInput.value = monthStart.toISOString().split('T')[0];
    endDateInput.value = today.toISOString().split('T')[0];
  }
}

document.addEventListener('click', (e) => {
  const refreshBtn = e.target.closest('#refresh-btn');
  if (refreshBtn) {
    e.preventDefault();
    runAnalysis(true);
  }
});

function downloadPDF() {
  const resultsEl = document.getElementById('insights-results');
  if (!resultsEl) return;

  const downloadBtn = document.getElementById('download-pdf-btn');
  if (downloadBtn) {
    downloadBtn.disabled = true;
    downloadBtn.innerHTML = '<span class="spinner"></span> Generating...';
  }

  const cur = getCurrencyInfo(getCurrency());
  const sym = cur.symbol;

  const { label } = getPeriodDates();

  const pdfContent = document.createElement('div');
  pdfContent.style.cssText = `
    font-family: 'Inter', Arial, sans-serif;
    padding: 20px;
    max-width: 800px;
    margin: 0 auto;
    color: #1d1d1f;
    background: #fff;
  `;

  const headerHTML = `
    <div style="text-align: center; margin-bottom: 30px; padding-bottom: 20px; border-bottom: 2px solid #0071e3;">
      <div style="display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 8px;">
        <img src="assets/images/logo.png" width="40" height="40" style="border-radius: 8px;" onerror="this.style.display='none'" />
        <h1 style="margin: 0; font-size: 24px; color: #1d1d1f;">SpendWise AI Insights</h1>
      </div>
      <p style="margin: 0; color: #6e6e73; font-size: 14px;">Financial Analysis Report - ${escapeHtml(label)}</p>
      <p style="margin: 8px 0 0; color: #6e6e73; font-size: 12px;">Generated on ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
    </div>
  `;

  const resultsHTML = resultsEl.innerHTML;
  pdfContent.innerHTML = headerHTML + '<div id="pdf-results">' + resultsHTML + '</div>';

  const opt = {
    margin: 10,
    filename: `spendwise-insights-${label.replace(/\s+/g, '-').toLowerCase()}.pdf`,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { 
      scale: 2, 
      useCORS: true,
      logging: false,
      backgroundColor: '#ffffff'
    },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
    pagebreak: { mode: ['avoid-all', 'css', 'legacy'] }
  };

  if (typeof html2pdf !== 'undefined') {
    html2pdf().set(opt).from(pdfContent).save().then(() => {
      if (downloadBtn) {
        downloadBtn.disabled = false;
        downloadBtn.innerHTML = '<i data-lucide="download"></i><span>Download PDF</span>';
        if (window.lucide) lucide.createIcons();
      }
      showToast('PDF downloaded successfully!');
    }).catch(err => {
      console.error('PDF generation error:', err);
      if (downloadBtn) {
        downloadBtn.disabled = false;
        downloadBtn.innerHTML = '<i data-lucide="download"></i><span>Download PDF</span>';
        if (window.lucide) lucide.createIcons();
      }
      showToast('Failed to generate PDF. Please try again.');
    });
  } else {
    if (downloadBtn) {
      downloadBtn.disabled = false;
      downloadBtn.innerHTML = '<i data-lucide="download"></i><span>Download PDF</span>';
      if (window.lucide) lucide.createIcons();
    }
    showToast('PDF library not loaded. Please refresh and try again.');
  }
}

function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 3000);
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('#download-pdf-btn');
  if (btn && !btn.disabled) {
    e.preventDefault();
    downloadPDF();
  }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initUI);
} else {
  initUI();
}
