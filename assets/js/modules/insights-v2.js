// insights-v2.js — SpendWise AI Financial Advisor
// Conversational AI that provides personalized financial advice

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
const CONVERSATION_KEY = 'spendwise_ai_conversation_';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

let currentUser = null;
let isAnalyzing = false;
let selectedPeriod = 'month';
let selectedAnalysisType = 'overview';
let conversationHistory = [];
let currentFinancialData = null;
let currentPeriodLabel = '';

onAuthStateChanged(auth, user => {
  currentUser = user;
  if (user) {
    loadConversation();
  }
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

  const monthlySpending = {};
  selectedExpenses.forEach(e => {
    if (e.date) {
      const monthKey = e.date.substring(0, 7);
      monthlySpending[monthKey] = (monthlySpending[monthKey] || 0) + e.amount;
    }
  });

  const start = new Date(startDate);
  const end = new Date(endDate);
  const daysInRange = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;

  const totalExpenses = selectedExpenses.reduce((sum, e) => sum + e.amount, 0);
  const totalIncome = selectedIncome.reduce((sum, i) => sum + i.amount, 0);
  const savingsRate = totalIncome > 0 ? ((totalIncome - totalExpenses) / totalIncome) * 100 : 0;

  const activeDebts = selectedDebts.filter(d => !d.settled);
  const settledDebts = selectedDebts.filter(d => d.settled);

  const totalOwedToYou = activeDebts.filter(d => d.type === 'they-owe').reduce((sum, d) => sum + d.amount, 0);
  const totalYouOwe = activeDebts.filter(d => d.type === 'i-owe').reduce((sum, d) => sum + d.amount, 0);
  const totalSettled = settledDebts.reduce((sum, d) => sum + d.amount, 0);

  return {
    totalExpenses,
    totalIncome,
    netSavings: totalIncome - totalExpenses,
    savingsRate,
    transactionCount: selectedExpenses.length,
    incomeCount: selectedIncome.length,
    avgDailySpend: daysInRange > 0 ? totalExpenses / daysInRange : 0,
    avgMonthlySpend: totalExpenses / Math.max(Object.keys(monthlySpending).length || 1, 1),
    daysInRange,
    categoryBreakdown,
    dailySpending,
    paymentBreakdown,
    dayOfWeekSpending,
    monthlySpending,
    topExpenses: [...selectedExpenses].sort((a, b) => b.amount - a.amount).slice(0, 10),
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

function buildFinancialSummary(data, periodLabel) {
  const cur = getCurrencyInfo(getCurrency());
  const sym = cur.symbol;

  const categoryList = Object.entries(data.categoryBreakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, amt]) => `${cat}: ${sym} ${amt.toFixed(2)}`)
    .join(', ');

  const topExpenseList = data.topExpenses
    .map((e, i) => `${i + 1}. ${sym} ${e.amount.toFixed(2)} for ${e.category} (${e.description}) on ${e.date}`)
    .join('\n');

  return `
PERIOD: ${periodLabel}

FINANCIAL OVERVIEW:
- Total Income: ${sym} ${data.totalIncome.toFixed(2)}
- Total Expenses: ${sym} ${data.totalExpenses.toFixed(2)}
- Net Savings: ${sym} ${data.netSavings.toFixed(2)}
- Savings Rate: ${data.savingsRate.toFixed(1)}%
- Average Daily Spend: ${sym} ${data.avgDailySpend.toFixed(2)}
- Average Monthly Spend: ${sym} ${data.avgMonthlySpend.toFixed(2)}

TOP EXPENSES:
${topExpenseList || 'None recorded'}

CATEGORY BREAKDOWN: ${categoryList || 'No data'}

DEBT STATUS:
- Total Owed to You: ${sym} ${data.debt.totalOwedToYou.toFixed(2)}
- Total You Owe: ${sym} ${data.debt.totalYouOwe.toFixed(2)}
`;
}

function buildAnalysisSystemPrompt(analysisType, periodLabel) {
  const prompts = {
    overview: `You are a thoughtful financial advisor having a conversation with your client about their overall financial health for ${periodLabel}.

Your role:
- Explain what the numbers mean in simple terms
- Identify the most important things to address first
- Provide specific, actionable advice with estimated impact
- Be encouraging but honest about concerns
- Ask clarifying questions when helpful

Remember: The user already sees charts and data in their dashboard. Your job is to INTERPRET that data and provide wisdom, not repeat it.`,

    spending: `You are a spending optimization expert having a conversation with your client.

Focus on:
- WHY certain spending patterns exist
- Specific categories where cutting back would have the most impact
- Easy wins vs. hard changes
- Hidden opportunities to save
- Behavioral tips based on their specific patterns
- Be concrete: "Instead of X, try Y" type advice

IMPORTANT: Do NOT just list categories. Explain the STORY behind the spending and give specific, actionable recommendations.`,

    savings: `You are a savings coach helping your client build wealth.

Focus on:
- How their current savings rate compares to recommended levels
- Specific strategies to increase savings based on their income/expenses
- Quick wins they can implement immediately
- Medium-term adjustments
- Motivation and mindset tips
- Goal-based advice if goals are mentioned

IMPORTANT: Give specific numbers and timelines, not generic advice.`,

    trends: `You are a financial trend analyst helping your client understand their financial journey.

Focus on:
- What the trends mean for their future
- Seasonal patterns they should anticipate
- Is their financial health improving or declining?
- Early warning signs to watch
- Predictions based on patterns

IMPORTANT: Help them understand WHERE they're heading, not just where they've been.`,

    goals: `You are a financial planner helping your client achieve their goals.

Focus on:
- Are their goals realistic given their current finances?
- How much do they need to save monthly to reach each goal?
- What's the priority order of goals?
- Obstacles that might prevent goal achievement
- Celebration of progress on track goals
- Recovery plans for at-risk goals

IMPORTANT: Be specific about numbers, timelines, and action steps.`,

    debt: `You are a debt management expert helping your client become debt-free.

Focus on:
- Which debts to pay off first (Avalanche vs Snowball vs Custom)
- How long until they're debt-free
- Interest savings from different strategies
- When to prioritize debt vs savings
- Warning signs of debt problems
- Motivation for staying on track

IMPORTANT: Give them a clear action plan with specific steps.`
  };

  return prompts[analysisType] || prompts.overview;
}

function buildInitialQuestion(analysisType, data, periodLabel) {
  const sym = getCurrencyInfo(getCurrency()).symbol;
  
  const questions = {
    overview: `Based on my financial data for ${periodLabel} (Income: ${sym}${data.totalIncome.toFixed(0)}, Expenses: ${sym}${data.totalExpenses.toFixed(0)}, Savings Rate: ${data.savingsRate.toFixed(1)}%), what are the 3 most important things I should focus on to improve my financial health?`,

    spending: `Looking at my spending in ${periodLabel}, what are the biggest opportunities for me to reduce expenses without significantly impacting my quality of life?`,

    savings: `With a monthly income of ${sym}${data.totalIncome.toFixed(0)} and current savings of ${sym}${data.netSavings.toFixed(0)} in ${periodLabel}, how can I optimize my savings rate?`,

    trends: `How does my financial health in ${periodLabel} compare to where I should be? What patterns should I be concerned about or happy about?`,

    goals: `Based on my current financial situation in ${periodLabel}, what specific steps should I take this month to make meaningful progress toward financial success?`,

    debt: `With ${sym}${data.debt.totalYouOwe.toFixed(0)} in outstanding debts, what strategy would you recommend for becoming debt-free as quickly as possible?`
  };

  return questions[analysisType] || questions.overview;
}

async function sendToAI(messages) {
  if (!HF_TOKEN || HF_TOKEN.length < 10 || HF_TOKEN.includes('PLACEHOLDER')) {
    throw new Error('HF_TOKEN_NOT_SET');
  }

  const response = await fetch(HF_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HF_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: HF_MODEL,
      messages: messages,
      max_tokens: 2000,
      temperature: 0.7,
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

function loadConversation() {
  if (!currentUser) return;
  try {
    const saved = localStorage.getItem(CONVERSATION_KEY + currentUser.uid);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Date.now() - parsed.ts < CACHE_MAX_AGE_MS * 2) {
        conversationHistory = parsed.history || [];
      }
    }
  } catch (_) { }
}

function saveConversation() {
  if (!currentUser) return;
  try {
    localStorage.setItem(CONVERSATION_KEY + currentUser.uid, JSON.stringify({
      ts: Date.now(),
      history: conversationHistory
    }));
  } catch (_) { }
}

function clearConversation() {
  conversationHistory = [];
  if (currentUser) {
    localStorage.removeItem(CONVERSATION_KEY + currentUser.uid);
  }
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
      <h3 style="font-size:1.125rem;font-weight:600;margin:0 0 12px;color:var(--text);">AI Financial Advisor</h3>
      <p style="font-size:0.875rem;color:var(--text2);margin:0 0 16px;line-height:1.5;">
        Get personalized financial advice powered by AI. Ask questions, get explanations, and receive actionable recommendations.
      </p>
      <p style="font-size:0.8125rem;color:var(--text3);margin:0 0 20px;line-height:1.4;">
        <strong>Your data stays private:</strong> We only send transaction summaries (no personal identifiers) to generate insights.
      </p>
      <div style="display:flex;gap:12px;">
        <button id="consent-decline" style="flex:1;padding:12px;border-radius:10px;border:1px solid var(--border);background:var(--bg2);color:var(--text2);font-weight:500;cursor:pointer;">Maybe Later</button>
        <button id="consent-accept" style="flex:1;padding:12px;border-radius:10px;border:none;background:var(--accent);color:#fff;font-weight:600;cursor:pointer;">Start Chatting</button>
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

async function startConversation() {
  if (isAnalyzing) return;
  if (!currentUser) {
    showError('Please log in to use AI Advisor.');
    return;
  }

  const consentKey = 'aiAdvisorConsentV3';
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

  isAnalyzing = true;
  showLoadingState('Starting conversation...');

  try {
    currentFinancialData = await gatherFinancialData(startDate, endDate);
    currentPeriodLabel = label;

    if (currentFinancialData.transactionCount === 0 && currentFinancialData.incomeCount === 0) {
      hideLoadingState();
      showEmptyState();
      isAnalyzing = false;
      return;
    }

    const financialSummary = buildFinancialSummary(currentFinancialData, label);
    const systemPrompt = buildAnalysisSystemPrompt(selectedAnalysisType, label);
    const initialQuestion = buildInitialQuestion(selectedAnalysisType, currentFinancialData, label);

    clearConversation();

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Here is my financial summary:\n${financialSummary}\n\n${initialQuestion}` }
    ];

    showTypingIndicator();

    const response = await sendToAI(messages);

    hideLoadingState();

    conversationHistory = [...messages, { role: 'assistant', content: response }];
    saveConversation();

    renderConversation(label);
    scrollToMessages();

  } catch (err) {
    hideLoadingState();
    handleError(err);
  } finally {
    isAnalyzing = false;
  }
}

async function sendFollowUp(question) {
  if (isAnalyzing || !question.trim()) return;
  if (!currentFinancialData) {
    showError('Please start a conversation first.');
    return;
  }

  isAnalyzing = true;

  const userMessage = { role: 'user', content: question };
  conversationHistory.push(userMessage);
  renderUserMessage(question);
  scrollToMessages();

  showTypingIndicator();

  try {
    const systemPrompt = buildAnalysisSystemPrompt(selectedAnalysisType, currentPeriodLabel);
    const financialSummary = buildFinancialSummary(currentFinancialData, currentPeriodLabel);

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `My financial summary:\n${financialSummary}` },
      ...conversationHistory
    ];

    const response = await sendToAI(messages);

    conversationHistory.push({ role: 'assistant', content: response });
    saveConversation();

    hideTypingIndicator();
    renderAssistantMessage(response);

  } catch (err) {
    hideTypingIndicator();
    conversationHistory.pop();
    handleError(err);
  } finally {
    isAnalyzing = false;
  }
}

function handleError(err) {
  let errorTitle = 'Something went wrong';
  let errorMsg = 'Unable to get response. Please try again.';
  let errorType = 'error';

  if (err.message === 'HF_TOKEN_NOT_SET') {
    errorTitle = 'API Not Configured';
    errorMsg = 'Hugging Face API token is not set up. Please check your voice-config.js file.';
    errorType = 'warning';
  } else if (err.message === 'RATE_LIMITED') {
    errorTitle = 'Too Many Requests';
    errorMsg = 'Please wait a moment before sending another message.';
    errorType = 'warning';
  } else if (err.message === 'MODEL_LOADING') {
    errorTitle = 'AI Loading';
    errorMsg = 'The AI is starting up. Please wait and try again.';
    errorType = 'info';
  } else if (err.message === 'NOT_AUTHENTICATED') {
    errorTitle = 'Not Logged In';
    errorMsg = 'Please log in to use the AI Advisor.';
    errorType = 'error';
  } else if (err.message.includes('network') || err.message.includes('fetch')) {
    errorTitle = 'Connection Error';
    errorMsg = 'Unable to connect. Please check your internet connection.';
    errorType = 'error';
  }

  showError(`${errorTitle}: ${errorMsg}`, errorType);
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

function showLoadingState(message = 'Preparing your insights...') {
  const results = document.getElementById('insights-results');
  const empty = document.getElementById('insights-empty');
  const error = document.getElementById('insights-error');
  const loading = document.getElementById('insights-loading');

  if (results) results.classList.add('hidden');
  if (empty) empty.classList.add('hidden');
  if (error) error.classList.add('hidden');
  if (loading) loading.classList.remove('hidden');

  const loadingText = loading?.querySelector('.loading-text');
  if (loadingText) loadingText.textContent = message;
}

function hideLoadingState() {
  const loading = document.getElementById('insights-loading');
  if (loading) loading.classList.add('hidden');
}

function showEmptyState() {
  const empty = document.getElementById('insights-empty');
  if (empty) empty.classList.remove('hidden');
}

function showTypingIndicator() {
  const typingEl = document.getElementById('ai-typing');
  if (typingEl) {
    typingEl.classList.remove('hidden');
    scrollToMessages();
  }
}

function hideTypingIndicator() {
  const typingEl = document.getElementById('ai-typing');
  if (typingEl) typingEl.classList.add('hidden');
}

function scrollToMessages() {
  const messagesContainer = document.getElementById('chat-messages');
  if (messagesContainer) {
    setTimeout(() => {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }, 50);
  }
}

function renderConversation(periodLabel) {
  const container = document.getElementById('insights-results');
  const empty = document.getElementById('insights-empty');
  const error = document.getElementById('insights-error');

  if (empty) empty.classList.add('hidden');
  if (error) error.classList.add('hidden');
  if (!container) return;

  const analysisTypeTitle = selectedAnalysisType.charAt(0).toUpperCase() + selectedAnalysisType.slice(1);
  const suggestedQuestions = getSuggestedQuestions();

  let html = `
    <div class="conversation-header">
      <div class="conversation-info">
        <div class="conversation-avatar">
          <i data-lucide="bot"></i>
        </div>
        <div>
          <h3>AI Financial Advisor</h3>
          <span class="conversation-type">${analysisTypeTitle} • ${escapeHtml(periodLabel)}</span>
        </div>
      </div>
      <div class="conversation-actions">
        <button class="new-chat-btn" id="new-chat-btn" title="Start New Conversation">
          <i data-lucide="plus"></i>
        </button>
      </div>
    </div>

    <div class="chat-messages" id="chat-messages">
      ${conversationHistory.map(msg => {
        if (msg.role === 'user') {
          return `<div class="message message-user"><div class="message-content">${escapeHtml(msg.content)}</div></div>`;
        } else {
          return `<div class="message message-assistant"><div class="message-avatar"><i data-lucide="bot"></i></div><div class="message-content">${formatAIResponse(msg.content)}</div></div>`;
        }
      }).join('')}
      
      <div class="typing-indicator hidden" id="ai-typing">
        <div class="message-avatar"><i data-lucide="bot"></i></div>
        <div class="typing-dots">
          <span></span><span></span><span></span>
        </div>
      </div>
    </div>

    <div class="suggested-questions" id="suggested-questions">
      <span class="suggested-label">Try asking:</span>
      <div class="suggested-list">
        ${suggestedQuestions.map(q => `<button class="suggested-btn">${escapeHtml(q)}</button>`).join('')}
      </div>
    </div>

    <div class="chat-input-container">
      <input type="text" id="chat-input" placeholder="Ask a follow-up question..." class="chat-input" />
      <button class="chat-send-btn" id="chat-send-btn">
        <i data-lucide="send"></i>
      </button>
    </div>
  `;

  container.innerHTML = html;
  container.classList.remove('hidden');

  requestAnimationFrame(() => {
    if (window.lucide) lucide.createIcons();
    setupChatListeners();
    scrollToMessages();
  });
}

function getSuggestedQuestions() {
  const questions = {
    overview: [
      'What should I prioritize first?',
      'How can I increase my savings rate?',
      'Any red flags in my spending?'
    ],
    spending: [
      'How can I reduce my biggest expense?',
      'Where am I overspending?',
      'Any subscriptions I should cancel?'
    ],
    savings: [
      'How much should I save monthly?',
      'Best way to automate savings?',
      'Emergency fund - how much is enough?'
    ],
    trends: [
      'Is my spending increasing?',
      'What expenses are growing fastest?',
      'How do I compare to last month?'
    ],
    goals: [
      'Am I on track for my goals?',
      'How much more do I need to save?',
      'Which goal should I focus on?'
    ],
    debt: [
      'Should I use savings to pay debt?',
      'Avalanche or Snowball method?',
      'How long until debt-free?'
    ]
  };

  return questions[selectedAnalysisType] || questions.overview;
}

function setupChatListeners() {
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send-btn');
  const newChatBtn = document.getElementById('new-chat-btn');

  if (sendBtn) {
    sendBtn.addEventListener('click', () => {
      const question = input?.value.trim();
      if (question) {
        input.value = '';
        sendFollowUp(question);
      }
    });
  }

  if (input) {
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const question = input.value.trim();
        if (question) {
          input.value = '';
          sendFollowUp(question);
        }
      }
    });
  }

  if (newChatBtn) {
    newChatBtn.addEventListener('click', () => {
      startConversation();
    });
  }

  document.querySelectorAll('.suggested-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const question = btn.textContent;
      sendFollowUp(question);
    });
  });
}

function renderUserMessage(text) {
  const messagesContainer = document.getElementById('chat-messages');
  if (!messagesContainer) return;

  const typingEl = document.getElementById('ai-typing');
  
  const userMsg = document.createElement('div');
  userMsg.className = 'message message-user';
  userMsg.innerHTML = `<div class="message-content">${escapeHtml(text)}</div>`;
  
  messagesContainer.insertBefore(userMsg, typingEl);
  scrollToMessages();
}

function renderAssistantMessage(text) {
  const messagesContainer = document.getElementById('chat-messages');
  const typingEl = document.getElementById('ai-typing');
  if (!messagesContainer) return;

  const assistantMsg = document.createElement('div');
  assistantMsg.className = 'message message-assistant';
  assistantMsg.innerHTML = `
    <div class="message-avatar"><i data-lucide="bot"></i></div>
    <div class="message-content">${formatAIResponse(text)}</div>
  `;

  messagesContainer.insertBefore(assistantMsg, typingEl);
  
  if (window.lucide) lucide.createIcons();
  scrollToMessages();
}

function formatAIResponse(text) {
  if (!text) return '<p>No response.</p>';

  let formatted = escapeHtml(text);

  formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  formatted = formatted.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  formatted = formatted.replace(/\n\n/g, '</p><p class="ai-para">');
  formatted = formatted.replace(/\n/g, '<br>');

  formatted = '<p class="ai-para">' + formatted + '</p>';

  formatted = formatted.replace(/<p class="ai-para"><br><\/p>/g, '');

  return formatted;
}

function showCachedBadge(show) {
  const badge = document.getElementById('cached-indicator');
  if (badge) badge.classList.toggle('hidden', !show);
}

function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 3000);
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
  }

  if (analyzeBtn) {
    analyzeBtn.addEventListener('click', () => startConversation());
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
  const dismissBtn = e.target.closest('[data-action="dismissInsightError"]');
  if (dismissBtn) {
    const errorEl = document.getElementById('insights-error');
    if (errorEl) errorEl.classList.add('hidden');
  }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initUI);
} else {
  initUI();
}
