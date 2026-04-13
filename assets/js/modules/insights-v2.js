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

  const analysisPrompts = {
    overview: `Generate a comprehensive overview of my current financial health based on the provided data. Focus on summarizing the key metrics from 'Overview,' including total income, total spending, savings rate, and debt management status. Highlight any immediate areas requiring attention.`,

    spending: `Analyze the detailed 'Spending' data. Identify the top 5 expense categories by total amount spent in the ${periodLabel}. Calculate the average monthly spend for each category and pinpoint any spending that significantly exceeds the historical average.`,

    savings: `Analyze the 'Savings' data in relation to my defined financial goals. Determine the current progress toward each goal. Calculate the required monthly savings rate needed to meet all goals, and identify which goals are currently at risk.`,

    trends: `Analyze the spending and savings 'Trends' over the ${periodLabel}. Identify any significant upward or downward trends in overall expenditure, savings rate, and debt levels. Pinpoint the specific months or periods where these trends were most pronounced.`,

    goals: `Based on my current financial position ('Goals' section), create a prioritized action plan. Determine the most critical steps I need to take this month to ensure I stay on track for my long-term goals, focusing specifically on optimizing spending and increasing savings.`,

    debt: `Analyze the 'Debt Tracker' data. Calculate the total outstanding debt, the average interest rate across all debts, and determine the most efficient repayment strategy (e.g., Avalanche vs. Snowball method). Recommend a specific action plan to reduce the overall debt burden.`
  };

  const systemPrompt = `You are a professional financial advisor AI assistant. Your analysis type is: **${analysisType.toUpperCase()}**

IMPORTANT RULES:
1. Provide a detailed, natural language response - no JSON, no markdown formatting
2. Be specific — reference actual numbers, categories, and patterns from the data provided
3. Be actionable — give concrete suggestions with estimated savings when possible
4. Consider Indian spending context (UPI payments, typical Indian expenses, festivals, salary patterns)
5. Use "${sym}" prefix for all currency amounts
6. Be encouraging but honest about areas needing improvement
7. Format your response with clear sections using **headers** for readability
8. Keep your analysis focused on ${analysisType.toUpperCase()} topics only`;

  let userPrompt = `**${analysisType.toUpperCase()}** ANALYSIS REQUEST for ${periodLabel}

**ANALYSIS TASK:**
${analysisPrompts[analysisType] || analysisPrompts.overview}

---

**YOUR FINANCIAL DATA:**

**OVERVIEW:**
- Total Expenses: ${sym} ${data.totalExpenses.toFixed(2)} (${data.transactionCount} transactions)
- Total Income: ${sym} ${data.totalIncome.toFixed(2)} (${data.incomeCount} entries)
- Net Savings: ${sym} ${data.netSavings.toFixed(2)}
- Average Daily Spend: ${sym} ${data.avgDailySpend.toFixed(2)}

**CATEGORY BREAKDOWN:**
${categoryList || 'No expenses recorded.'}

**SPENDING BY DAY OF WEEK:**
${dayOfWeekList}

**PAYMENT METHODS:**
${paymentList || 'No payment data.'}

**TOP EXPENSES:**
${topExpenseList || 'No expenses recorded.'}

**DEBT STATUS:**
- Total Owed to You: ${sym} ${data.debt.totalOwedToYou.toFixed(2)}
- Total You Owe: ${sym} ${data.debt.totalYouOwe.toFixed(2)}
- Total Settled: ${sym} ${data.debt.totalSettled.toFixed(2)}`;

  if (analysisType === 'debt' || analysisType === 'overview') {
    if (data.debt.topDebtors.length > 0) {
      userPrompt += `\n\n**TOP DEBTORS:**
${data.debt.topDebtors.map(d => `  - ${d.person}: ${sym} ${d.amount.toFixed(2)}`).join('\n')}`;
    }
    if (data.debt.topCreditors.length > 0) {
      userPrompt += `\n\n**TOP CREDITORS:**
${data.debt.topCreditors.map(d => `  - ${d.person}: ${sym} ${d.amount.toFixed(2)}`).join('\n')}`;
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

  return content.trim();
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
    let errorTitle = 'Analysis Failed';
    let errorMsg = 'Unable to generate insights. Please try again.';
    let errorType = 'error';

    if (err.message === 'HF_TOKEN_NOT_SET') {
      errorTitle = 'API Token Not Set';
      errorMsg = 'Hugging Face API token is not configured. Please contact the app administrator or check your setup.';
      errorType = 'warning';
    } else if (err.message === 'RATE_LIMITED') {
      errorTitle = 'Rate Limit Exceeded';
      errorMsg = 'Too many requests. Please wait a moment (30-60 seconds) and try again.';
      errorType = 'warning';
    } else if (err.message === 'MODEL_LOADING') {
      errorTitle = 'AI Model Loading';
      errorMsg = 'The AI model is currently loading. Please wait 20-30 seconds and try again.';
      errorType = 'info';
    } else if (err.message === 'NOT_AUTHENTICATED') {
      errorTitle = 'Not Logged In';
      errorMsg = 'Please log in to your account to use AI Insights.';
      errorType = 'error';
    } else if (err.name === 'FirebaseError' || err.code) {
      const fbErrors = {
        'permission-denied': { title: 'Permission Denied', msg: 'You do not have permission to access this data. Please check your account settings.' },
        'not-found': { title: 'Data Not Found', msg: 'The requested data was not found. Please check your records.' },
        'network-error': { title: 'Network Error', msg: 'Unable to connect to the server. Please check your internet connection.' },
        'deadline-exceeded': { title: 'Request Timeout', msg: 'The request took too long. Please try again.' },
        'unavailable': { title: 'Service Unavailable', msg: 'The service is temporarily unavailable. Please try again later.' },
        'invalid-argument': { title: 'Invalid Data', msg: 'Some data is invalid. Please check your inputs.' }
      };
      const fbError = fbErrors[err.code] || fbErrors[err.code?.split('/')[1]];
      if (fbError) {
        errorTitle = fbError.title;
        errorMsg = fbError.msg;
      }
    } else if (err.message.includes('fetch') || err.message.includes('network')) {
      errorTitle = 'Network Error';
      errorMsg = 'Unable to connect to the AI service. Please check your internet connection and try again.';
      errorType = 'error';
    } else if (err.message.includes('timeout')) {
      errorTitle = 'Request Timeout';
      errorMsg = 'The request took too long. Please try again or check your connection.';
      errorType = 'warning';
    } else if (err.message === 'EMPTY_RESPONSE') {
      errorTitle = 'Empty Response';
      errorMsg = 'The AI service returned an empty response. Please try again.';
      errorType = 'warning';
    }

    console.error('Analysis error:', err);
    showError(`${errorTitle}: ${errorMsg}`, errorType);
  } finally {
    isAnalyzing = false;
  }
}

function showError(msg, errorType = 'error') {
  const errorEl = document.getElementById('insights-error');
  const results = document.getElementById('insights-results');
  const empty = document.getElementById('insights-empty');
  const loading = document.getElementById('insights-loading');

  if (results) results.classList.add('hidden');
  if (empty) empty.classList.add('hidden');
  if (loading) loading.classList.add('hidden');

  if (!errorEl) return;
  
  const errorMessage = document.getElementById('error-message');
  const errorIcon = errorEl.querySelector('.error-icon');
  const errorTitle = errorEl.querySelector('h3');
  
  if (errorMessage) errorMessage.textContent = msg;
  if (errorTitle) {
    const titleMatch = msg.match(/^([^:]+):/);
    errorTitle.textContent = titleMatch ? titleMatch[1] : 'Error';
  }
  
  errorEl.classList.remove('hidden', 'error', 'warning', 'info');
  errorEl.classList.add(errorType);
  
  if (window.lucide) lucide.createIcons();
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

function renderInsights(responseText, periodLabel) {
  const container = document.getElementById('insights-results');
  const empty = document.getElementById('insights-empty');
  const error = document.getElementById('insights-error');

  if (empty) empty.classList.add('hidden');
  if (error) error.classList.add('hidden');
  if (!container) return;

  const analysisTypeTitle = selectedAnalysisType.charAt(0).toUpperCase() + selectedAnalysisType.slice(1);

  let html = `
    <div class="results-header">
      <div class="results-header-left">
        <div class="period-badge">
          <i data-lucide="calendar"></i>
          <span>${escapeHtml(periodLabel)}</span>
        </div>
        <div class="analysis-type-badge">
          <i data-lucide="${getAnalysisIcon(selectedAnalysisType)}"></i>
          <span>${analysisTypeTitle} Analysis</span>
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

    <div class="ai-response-container">
      <div class="ai-response-header">
        <div class="ai-avatar">
          <i data-lucide="bot"></i>
        </div>
        <div class="ai-header-info">
          <span class="ai-label">AI Financial Advisor</span>
          <span class="ai-analysis-type">${analysisTypeTitle} Analysis</span>
        </div>
      </div>
      <div class="ai-response-content">
        ${formatAIResponse(responseText)}
      </div>
    </div>
  `;

  container.innerHTML = html;
  container.classList.remove('hidden');

  requestAnimationFrame(() => {
    if (window.lucide) lucide.createIcons();
  });
}

function getAnalysisIcon(type) {
  const icons = {
    overview: 'layout-dashboard',
    spending: 'trending-down',
    savings: 'piggy-bank',
    trends: 'line-chart',
    goals: 'target',
    debt: 'hand-coins'
  };
  return icons[type] || 'sparkles';
}

function formatAIResponse(text) {
  if (!text) return '<p class="ai-empty">No response generated.</p>';

  let formatted = escapeHtml(text);

  formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  formatted = formatted.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  formatted = formatted.replace(/^### (.+)$/gm, '<h4 class="ai-section-title">$1</h4>');
  formatted = formatted.replace(/^## (.+)$/gm, '<h3 class="ai-section-header">$1</h3>');
  formatted = formatted.replace(/^# (.+)$/gm, '<h2 class="ai-section-main">$1</h2>');

  formatted = formatted.replace(/^(\d+\.\s.+)$/gm, '<li class="ai-list-item">$1</li>');
  formatted = formatted.replace(/^(\-\s.+)$/gm, '<li class="ai-list-item ai-list-bullet">$1</li>');

  formatted = formatted.replace(/\n\n/g, '</p><p class="ai-paragraph">');
  formatted = formatted.replace(/\n/g, '<br>');

  formatted = formatted.replace(/(<li class="ai-list-item">[^<]+<\/li>)(?=\n?(?!<))/g, '$1');

  const listPatterns = formatted.match(/(?:<li[^>]*>.*?<\/li>\s*)+/g);
  if (listPatterns) {
    listPatterns.forEach(list => {
      if (!list.startsWith('<ul') && !list.startsWith('<ol')) {
        formatted = formatted.replace(list, '<ul class="ai-list">' + list + '</ul>');
      }
    });
  }

  formatted = '<p class="ai-paragraph">' + formatted + '</p>';

  formatted = formatted.replace(/<p class="ai-paragraph"><(ul class="ai-list|li class="ai-list-item|h[234] class="ai-section)/g, '<$1');
  formatted = formatted.replace(/<\/(ul|li|h[234])><\/p>/g, '</$1>');
  formatted = formatted.replace(/<p class="ai-paragraph"><br><\/p>/g, '');

  return formatted;
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

      periodTabs.querySelectorAll('.period-tab').forEach(t => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
        t.setAttribute('tabindex', '-1');
      });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      tab.setAttribute('tabindex', '0');

      selectedPeriod = tab.dataset.period;

      if (customRange) {
        customRange.classList.toggle('hidden', selectedPeriod !== 'custom');
      }
    });

    periodTabs.addEventListener('keydown', (e) => {
      const tabs = Array.from(periodTabs.querySelectorAll('.period-tab'));
      const currentIndex = tabs.findIndex(t => t.getAttribute('aria-selected') === 'true');
      
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        const nextIndex = (currentIndex + 1) % tabs.length;
        tabs[nextIndex].click();
        tabs[nextIndex].focus();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        const prevIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        tabs[prevIndex].click();
        tabs[prevIndex].focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        tabs[0].click();
        tabs[0].focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        tabs[tabs.length - 1].click();
        tabs[tabs.length - 1].focus();
      }
    });
  }

  if (typeGrid) {
    typeGrid.addEventListener('click', (e) => {
      const card = e.target.closest('.analysis-type-card');
      if (!card) return;

      typeGrid.querySelectorAll('.analysis-type-card').forEach(c => {
        c.classList.remove('selected');
        c.setAttribute('aria-checked', 'false');
      });
      card.classList.add('selected');
      card.setAttribute('aria-checked', 'true');

      selectedAnalysisType = card.dataset.type;
    });

    typeGrid.addEventListener('keydown', (e) => {
      const cards = Array.from(typeGrid.querySelectorAll('.analysis-type-card'));
      const currentIndex = cards.findIndex(c => c.getAttribute('aria-checked') === 'true');
      
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        const nextIndex = (currentIndex + 1) % cards.length;
        cards[nextIndex].click();
        cards[nextIndex].focus();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        const prevIndex = (currentIndex - 1 + cards.length) % cards.length;
        cards[prevIndex].click();
        cards[prevIndex].focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        cards[0].click();
        cards[0].focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        cards[cards.length - 1].click();
        cards[cards.length - 1].focus();
      }
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
