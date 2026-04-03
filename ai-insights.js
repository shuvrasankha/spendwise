// ai-insights.js — SpendWise AI Spending Analysis Module
// Uses expense + income data + Hugging Face Inference API for smart financial insights

import { getApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, getDocs, query, where } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// Currency helpers from global scope (currency.js loads before this module)
const fmt = window.fmt;
const getCurrency = window.getCurrency;
const getCurrencyInfo = window.getCurrencyInfo;

// ── Firebase (reuse the app already initialized by app.js) ───────────────────
const app = getApp();
const auth = getAuth(app);
const db = getFirestore(app);

// ══════════════════════════════════════════════════════════════════════════════
//  🔑  HUGGING FACE API TOKEN
//  Same pattern as voice-command.js — placeholder replaced by GitHub Actions
// ══════════════════════════════════════════════════════════════════════════════
let HF_TOKEN = '__HF_TOKEN_PLACEHOLDER__';
try {
  const config = await import('./voice-config.js');
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
//  DATA AGGREGATION — Collect expenses & income from Firestore
// ══════════════════════════════════════════════════════════════════════════════
async function gatherFinancialData(month, year) {
  if (!currentUser) throw new Error('NOT_AUTHENTICATED');

  // Fetch expenses
  const expQ = query(collection(db, 'expenses'), where('uid', '==', currentUser.uid));
  const expSnap = await getDocs(expQ);
  let expenses = expSnap.docs.map(d => {
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

  // Fetch income
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

  // Filter by selected month/year
  const yearStr = String(year);
  const monthStr = pad(month);
  const prefix = yearStr + '-' + monthStr;

  const selectedExpenses = expenses.filter(e => e.date && e.date.startsWith(prefix));
  const selectedIncome = income.filter(i => i.date && i.date.startsWith(prefix));

  // Previous month for comparison
  let prevMonth = month - 1;
  let prevYear = year;
  if (prevMonth < 1) { prevMonth = 12; prevYear -= 1; }
  const prevPrefix = String(prevYear) + '-' + pad(prevMonth);
  const prevExpenses = expenses.filter(e => e.date && e.date.startsWith(prevPrefix));
  const prevIncome = income.filter(i => i.date && i.date.startsWith(prevPrefix));

  // Aggregate category-wise spending
  const categoryBreakdown = {};
  selectedExpenses.forEach(e => {
    categoryBreakdown[e.category] = (categoryBreakdown[e.category] || 0) + e.amount;
  });

  // Daily spending for pattern analysis
  const dailySpending = {};
  selectedExpenses.forEach(e => {
    dailySpending[e.date] = (dailySpending[e.date] || 0) + e.amount;
  });

  // Payment method breakdown
  const paymentBreakdown = {};
  selectedExpenses.forEach(e => {
    paymentBreakdown[e.payment] = (paymentBreakdown[e.payment] || 0) + e.amount;
  });

  // Day of week analysis
  const dayOfWeekSpending = { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0, Sun: 0 };
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  selectedExpenses.forEach(e => {
    if (e.date) {
      const day = new Date(e.date + 'T00:00:00').getDay();
      dayOfWeekSpending[dayNames[day]] += e.amount;
    }
  });

  const totalExpenses = selectedExpenses.reduce((sum, e) => sum + e.amount, 0);
  const totalIncome = selectedIncome.reduce((sum, i) => sum + i.amount, 0);
  const prevTotalExpenses = prevExpenses.reduce((sum, e) => sum + e.amount, 0);
  const prevTotalIncome = prevIncome.reduce((sum, i) => sum + i.amount, 0);
  const daysInMonth = new Date(year, month, 0).getDate();
  const today = new Date();
  const daysElapsed = (year === today.getFullYear() && month === today.getMonth() + 1)
    ? today.getDate()
    : daysInMonth;

  return {
    month: MONTH_NAMES[month - 1],
    year,
    totalExpenses,
    totalIncome,
    netSavings: totalIncome - totalExpenses,
    transactionCount: selectedExpenses.length,
    incomeCount: selectedIncome.length,
    avgDailySpend: daysElapsed > 0 ? totalExpenses / daysElapsed : 0,
    daysElapsed,
    daysInMonth,
    categoryBreakdown,
    dailySpending,
    paymentBreakdown,
    dayOfWeekSpending,
    topExpenses: [...selectedExpenses].sort((a, b) => b.amount - a.amount).slice(0, 5),
    incomeSources: selectedIncome,
    prevMonth: {
      name: MONTH_NAMES[prevMonth - 1],
      totalExpenses: prevTotalExpenses,
      totalIncome: prevTotalIncome
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
    .map((e, i) => `  ${i + 1}. ${sym} ${e.amount.toFixed(2)} — ${e.category} (${e.description}) on ${e.date}`)
    .join('\n');

  const system = `You are a personal finance analyst for SpendWise, an Indian expense tracking app. Analyze the user's financial data for ${data.month} ${data.year} and provide personalized, actionable insights.

IMPORTANT RULES:
1. Be specific — reference actual numbers, categories, and patterns from the data.
2. Be actionable — give concrete suggestions (e.g., "You could save Rs X by reducing Y").
3. Compare with previous month (${data.prevMonth.name}) when data is available.
4. Consider Indian spending context (UPI payments, typical Indian expenses, etc.).
5. Return ONLY valid JSON, no markdown, no explanation.
6. Amounts should include "Rs" prefix.
7. Be encouraging but honest about overspending.

Return JSON in this EXACT format:
{
  "summary": {
    "headline": "<one-line summary of financial health>",
    "healthScore": <1-100 number based on spending patterns>,
    "highlights": ["<highlight 1>", "<highlight 2>", "<highlight 3>"]
  },
  "patterns": [
    {"title": "<pattern title>", "description": "<pattern detail>", "type": "info|warning|success"}
  ],
  "recommendations": [
    {"title": "<recommendation title>", "description": "<actionable detail>", "priority": "high|medium|low", "savingsEstimate": "<estimated savings or empty string>"}
  ],
  "alerts": [
    {"title": "<alert title>", "description": "<alert detail>", "severity": "critical|warning|info"}
  ],
  "categoryAnalysis": [
    {"category": "<category name>", "amount": <number>, "percentage": <number>, "trend": "up|down|stable", "comment": "<brief analysis>"}
  ]
}`;

  const user = `Here is my financial data for ${data.month} ${data.year}:

📊 OVERVIEW:
- Total Expenses: ${sym} ${data.totalExpenses.toFixed(2)} (${data.transactionCount} transactions)
- Total Income: ${sym} ${data.totalIncome.toFixed(2)} (${data.incomeCount} entries)
- Net Savings: ${sym} ${data.netSavings.toFixed(2)}
- Average Daily Spend: ${sym} ${data.avgDailySpend.toFixed(2)} (${data.daysElapsed} days elapsed of ${data.daysInMonth})

📁 CATEGORY BREAKDOWN:
${categoryList || '  No expenses recorded.'}

📅 SPENDING BY DAY OF WEEK:
${dayOfWeekList}

💳 PAYMENT METHODS:
${paymentList || '  No payment data.'}

🔝 TOP 5 EXPENSES:
${topExpenseList || '  No expenses recorded.'}

📈 PREVIOUS MONTH (${data.prevMonth.name}):
- Total Expenses: ${sym} ${data.prevMonth.totalExpenses.toFixed(2)}
- Total Income: ${sym} ${data.prevMonth.totalIncome.toFixed(2)}

Please analyze my spending and provide insights.`;

  return { system, user };
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
function getCacheKey(uid, month, year) {
  return CACHE_KEY_PREFIX + uid + '_' + year + '_' + month;
}

function saveInsightsCache(uid, month, year, insights) {
  try {
    const payload = JSON.stringify({ ts: Date.now(), data: insights });
    localStorage.setItem(getCacheKey(uid, month, year), payload);
  } catch (_) { /* quota exceeded */ }
}

function loadInsightsCache(uid, month, year) {
  try {
    const raw = localStorage.getItem(getCacheKey(uid, month, year));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.ts > CACHE_MAX_AGE_MS) {
      localStorage.removeItem(getCacheKey(uid, month, year));
      return null;
    }
    return parsed.data;
  } catch { return null; }
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

  const monthSelect = document.getElementById('insights-month');
  const yearSelect = document.getElementById('insights-year');
  if (!monthSelect || !yearSelect) return;

  const month = parseInt(monthSelect.value);
  const year = parseInt(yearSelect.value);

  // Check cache first
  const cached = loadInsightsCache(currentUser.uid, month, year);
  if (cached) {
    renderInsights(cached, month, year);
    showCachedBadge(true);
    return;
  }

  isAnalyzing = true;
  showCachedBadge(false);
  showAnalyzingState();

  try {
    // Step 1: Gather data
    updateAnalysisStep(1, 'Fetching your financial data…');
    const financialData = await gatherFinancialData(month, year);

    if (financialData.transactionCount === 0 && financialData.incomeCount === 0) {
      hideAnalyzingState();
      showEmptyDataState(month, year);
      isAnalyzing = false;
      return;
    }

    // Step 2: Send to AI
    updateAnalysisStep(2, 'AI is analyzing your spending patterns…');
    const insights = await callAnalysisAPI(financialData);

    // Step 3: Render
    updateAnalysisStep(3, 'Preparing your insights…');
    await new Promise(r => setTimeout(r, 400)); // brief pause for UX

    // Cache the result
    saveInsightsCache(currentUser.uid, month, year, insights);

    hideAnalyzingState();
    renderInsights(insights, month, year);
  } catch (err) {
    hideAnalyzingState();
    if (err.message === 'HF_TOKEN_NOT_SET') {
      showInsightError('⚠️ AI token not configured. Please set up your Hugging Face API token.');
    } else if (err.message === 'RATE_LIMITED') {
      showInsightError('⏳ Rate limited. Please wait a moment and try again.');
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

function showEmptyDataState(month, year) {
  const container = document.getElementById('insights-results');
  if (!container) return;
  container.innerHTML = `
    <div class="insights-empty-data">
      <div class="empty-data-icon">
        <i data-lucide="file-search"></i>
      </div>
      <h3>No data for ${MONTH_NAMES[month - 1]} ${year}</h3>
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

function renderInsights(insights, month, year) {
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
          <p class="insight-period">${MONTH_NAMES[month - 1]} ${year}</p>
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
  const monthSelect = document.getElementById('insights-month');
  const yearSelect = document.getElementById('insights-year');
  if (!monthSelect || !yearSelect) return;
  const month = parseInt(monthSelect.value);
  const year = parseInt(yearSelect.value);
  // Clear cache for this month
  try {
    localStorage.removeItem(getCacheKey(currentUser.uid, month, year));
  } catch (_) { }
  showCachedBadge(false);
  await runAnalysis();
}

// ══════════════════════════════════════════════════════════════════════════════
//  INIT — Wire up events
// ══════════════════════════════════════════════════════════════════════════════
function initInsightsUI() {
  // Populate month selector
  const monthSelect = document.getElementById('insights-month');
  if (monthSelect) {
    MONTH_NAMES.forEach((name, i) => {
      const opt = document.createElement('option');
      opt.value = i + 1;
      opt.textContent = name;
      monthSelect.appendChild(opt);
    });
    monthSelect.value = new Date().getMonth() + 1;
  }

  // Populate year selector
  const yearSelect = document.getElementById('insights-year');
  if (yearSelect) {
    const currentYear = new Date().getFullYear();
    for (let y = currentYear; y >= currentYear - 5; y--) {
      const opt = document.createElement('option');
      opt.value = y;
      opt.textContent = y;
      yearSelect.appendChild(opt);
    }
    yearSelect.value = currentYear;
  }

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
