// insights-v2.js — Insights page.
// 1. "At a glance": numbers computed here from the user's data (no AI, so it always works).
// 2. AI coach: answers questions about those numbers (Workers AI via config/ai.js).
// Calculations live in insights-data.js (tested in tests/insights.test.mjs).

import { app } from '../config/firebase.js';
import { callAI } from '../config/ai.js';
import { todayStr } from '../utils/helpers.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, getDocs, query, where } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { periodRange, summarize, hasData, factsText, renderMarkdown, shortDate } from './insights-data.js';

const auth = getAuth(app);
const db = getFirestore(app);

const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const SAVED_KEY = 'spendwise_insights_chat_'; // + uid
const SAVED_MAX_AGE = 24 * 36e5;
const MAX_TURNS = 8;                          // recent messages sent with each question
const CONSENT_KEY = 'aiAdvisorConsentV3';

const TYPES = {
  overview: {
    title: 'Overview',
    focus: 'the 3 things that matter most in this period: one thing going well, one thing to watch, and one action for the coming week.',
    question: 'What are the 3 most important things in my numbers right now?',
    suggestions: ['What is going well?', 'Where can I save the most?', 'Am I spending more than before?'],
  },
  spending: {
    title: 'Spending',
    focus: 'where the money went and 2–3 realistic cuts, biggest first, with roughly how much each could save per month.',
    question: 'Where is my money going, and where could I realistically cut back?',
    suggestions: ['Which category grew the most?', 'How much could I save on food?', 'Is my biggest expense normal?'],
  },
  savings: {
    title: 'Savings',
    focus: 'the savings rate against a 20% guideline and concrete steps to raise it. If no income is recorded, say that income entries are needed for this and give spending-based tips instead.',
    question: 'How is my savings rate, and how can I improve it?',
    suggestions: ['How much should I save each month?', 'What if I cut my top category by 10%?', 'Where do small amounts add up?'],
  },
  trends: {
    title: 'Trends',
    focus: 'how this period compares with the previous one: total and per-category changes, the daily average and the month-end projection, and what is driving the change.',
    question: 'How does this period compare with before, and what is driving the change?',
    suggestions: ['Which category changed the most?', 'Will I spend more than last month?', 'What should I watch next month?'],
  },
  debt: {
    title: 'Debt',
    focus: 'the unsettled debts in the numbers: what to settle first, money others owe the user that is worth following up, and a simple plan. If there are no unsettled debts, say so in one sentence and give one tip.',
    question: 'What should I do about my debts?',
    suggestions: ['What should I pay back first?', 'How do I follow up on money owed to me?', 'Should I pay debts before saving?'],
  },
};

let currentUser = null;
let busy = false;
let selectedPeriod = 'month';
let selectedType = 'overview';
let chat = null; // { type, range, summary, facts, history: [{ role, content }] }

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');

function currency() {
  return window.getCurrencyInfo ? window.getCurrencyInfo(window.getCurrency()) : { symbol: '₹', code: 'INR', locale: 'en-IN' };
}
// Whole amounts in the user's currency, e.g. "₹ 19,200"
function money(n) {
  const c = currency();
  return `${c.symbol} ${Math.round(n).toLocaleString(c.locale)}`;
}

// ── Data ────────────────────────────────────────────────────────────────────
async function loadData() {
  const uid = currentUser.uid;
  const num = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
  const get = async (name, map) =>
    (await getDocs(query(collection(db, name), where('uid', '==', uid)))).docs.map(d => map(d.data()));
  const [expenses, income, debts] = await Promise.all([
    get('expenses', r => ({ amount: num(r.amount), category: r.category || 'Other', date: r.date || '' })),
    get('income', r => ({ amount: num(r.amount), date: r.date || '' })),
    get('debts', r => ({ amount: num(r.amount), type: r.type || 'they-owe', settled: !!r.settled, settledDate: r.settledDate || '', date: r.date || '' })),
  ]);
  return { expenses, income, debts };
}

// ── At a glance ─────────────────────────────────────────────────────────────
function changeText(change, against) {
  if (change === null) return '';
  const up = change > 0;
  return `<span class="glance-change ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(change).toFixed(0)}% ${up ? 'more' : 'less'} than ${esc(against)}</span>`;
}

function renderGlance(s, r) {
  const el = $('insights-glance');
  if (!el) return;
  $('insights-empty')?.classList.add('hidden');
  el.classList.remove('hidden');

  if (!hasData(s)) {
    el.innerHTML = `
      <h2 class="glance-title">${esc(r.label)}</h2>
      <p class="glance-none">No expenses or income recorded in this period. Try a longer period, or add an expense first.</p>`;
    return;
  }

  const monthName = r.monthDays ? new Date(r.end + 'T00:00:00').toLocaleDateString('en-US', { month: 'long' }) : '';
  const cats = s.categories.slice(0, 5).map(c => {
    const note = c.change === null ? (c.prevAmount === 0 && s.prevSpent > 0 ? 'new vs before' : '')
      : Math.abs(c.change) < 1 ? 'same as before'
      : `${c.change > 0 ? '+' : '−'}${Math.abs(c.change).toFixed(0)}% vs before`;
    return `
      <li class="glance-cat">
        <div class="glance-cat-row">
          <span class="glance-cat-name">${esc(c.category)}</span>
          <span class="glance-cat-amount">${money(c.amount)}</span>
        </div>
        <div class="glance-bar" aria-hidden="true"><span style="width:${Math.max(c.share, 2).toFixed(1)}%"></span></div>
        <div class="glance-cat-meta">${c.share.toFixed(0)}% of spending${note ? ` · ${note}` : ''}</div>
      </li>`;
  }).join('');
  const biggest = s.biggest.map(b => `<li><span>${esc(b.category)} · ${shortDate(b.date)}</span><span>${money(b.amount)}</span></li>`).join('');

  el.innerHTML = `
    <h2 class="glance-title">${esc(r.label)}</h2>
    <div class="glance-stats">
      <div class="glance-stat">
        <span class="glance-label">Spent</span>
        <span class="glance-value">${money(s.spent)}</span>
        ${changeText(s.spendChange, r.prevLabel)}
      </div>
      <div class="glance-stat">
        <span class="glance-label">Income</span>
        <span class="glance-value">${s.incomeCount ? money(s.earned) : '—'}</span>
        ${s.incomeCount ? '' : '<span class="glance-sub">None recorded</span>'}
      </div>
      <div class="glance-stat">
        <span class="glance-label">Saved</span>
        <span class="glance-value">${s.savingsRate !== null ? money(s.saved) : '—'}</span>
        <span class="glance-sub">${s.savingsRate !== null ? `${s.savingsRate.toFixed(0)}% of income` : 'Needs income entries'}</span>
      </div>
    </div>
    <p class="glance-pace">${money(s.dailyAvg)} a day${s.projection !== null ? ` · on track for <strong>${money(s.projection)}</strong> by the end of ${esc(monthName)}` : ''}</p>
    ${cats ? `<h3 class="glance-h">Where it went</h3><ul class="glance-cats">${cats}</ul>` : ''}
    ${biggest ? `<h3 class="glance-h">Biggest expenses</h3><ul class="glance-biggest">${biggest}</ul>` : ''}
    ${s.debts.activeCount ? `<p class="glance-debts">Debts now: you owe <strong>${money(s.debts.youOwe)}</strong> · owed to you <strong>${money(s.debts.owedToYou)}</strong></p>` : ''}`;
}

// ── AI coach ────────────────────────────────────────────────────────────────
function systemPrompt() {
  const c = currency();
  return `You are the money coach inside SpendWise, a personal expense tracker. Amounts are in ${c.code} (${c.symbol}).
Rules:
- Use only the numbers below. Never invent amounts, dates, income, goals or interest rates. If something isn't in the data, say so in one short sentence.
- Be specific: name categories and amounts from the data, and estimate savings in ${c.symbol}.
- Keep each answer under 150 words. Use a short numbered or bulleted list for steps.
- Plain, friendly English. Don't recommend specific financial products, funds or stocks.
Focus: ${TYPES[chat.type].focus}

USER'S NUMBERS
${chat.facts}`;
}

function aiResetTime() {
  const now = new Date();
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)); // 00:00 UTC
  return reset.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function errorText(err) {
  if (err.message === 'RATE_LIMITED') return `Today's free AI limit is used up. It resets at ${aiResetTime()}. The numbers above are still up to date.`;
  if (err.message === 'NOT_AUTHENTICATED') return 'Please log in again to use the AI coach.';
  if (err instanceof TypeError) return "Couldn't reach the AI coach. Check your connection and try again.";
  return "The AI coach didn't answer. Try again.";
}

async function askAI() {
  setTyping(true);
  try {
    const res = await callAI({
      model: AI_MODEL,
      messages: [{ role: 'system', content: systemPrompt() }, ...chat.history.slice(-MAX_TURNS)],
      max_tokens: 700,
      temperature: 0.4,
    });
    if (res.status === 429) throw new Error('RATE_LIMITED');
    if (!res.ok) throw new Error('API_ERROR');
    const content = (await res.json()).choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('EMPTY_RESPONSE');
    chat.history.push({ role: 'assistant', content });
    setTyping(false);
    appendMessage('assistant', content);
    saveChat();
  } catch (err) {
    console.error('AI coach error:', err);
    setTyping(false);
    showChatError(errorText(err)); // the unanswered question stays in history so Retry can resend it
  }
}

async function ask(question) {
  if (busy || !chat || !question.trim()) return;
  if (chat.history.at(-1)?.role === 'user') chat.history.pop(); // drop an unanswered (failed) question
  document.querySelectorAll('.chat-error').forEach(e => e.remove());
  chat.history.push({ role: 'user', content: question.trim() });
  appendMessage('user', question.trim());
  setBusy(true);
  await askAI();
  setBusy(false);
}

async function retry() {
  if (busy || !chat) return;
  document.querySelectorAll('.chat-error').forEach(e => e.remove());
  setBusy(true);
  await askAI();
  setBusy(false);
}

// ── Chat UI ─────────────────────────────────────────────────────────────────
function renderChat() {
  const box = $('insights-results');
  if (!box || !chat) return;
  const t = TYPES[chat.type];
  box.innerHTML = `
    <div class="conversation-header">
      <div class="conversation-info">
        <div class="conversation-avatar"><i data-lucide="bot"></i></div>
        <div>
          <h3>AI coach</h3>
          <span class="conversation-type">${esc(t.title)} · ${esc(chat.range.label)}</span>
        </div>
      </div>
      <div class="conversation-actions">
        <button class="new-chat-btn" id="new-chat-btn" aria-label="Close conversation" title="Close conversation"><i data-lucide="x"></i></button>
      </div>
    </div>
    <div class="chat-messages" id="chat-messages" aria-live="polite"></div>
    <div class="suggested-questions">
      <span class="suggested-label">Try asking:</span>
      <div class="suggested-list">${t.suggestions.map(q => `<button type="button" class="suggested-btn">${esc(q)}</button>`).join('')}</div>
    </div>
    <form class="chat-input-container" id="chat-form">
      <label for="chat-input" class="sr-only">Ask the AI coach</label>
      <input type="text" id="chat-input" placeholder="Ask about your numbers…" class="chat-input" autocomplete="off" enterkeyhint="send" />
      <button type="submit" class="chat-send-btn" id="chat-send-btn" aria-label="Send"><i data-lucide="send"></i></button>
    </form>`;
  box.classList.remove('hidden');
  chat.history.forEach(m => appendMessage(m.role, m.content));

  $('chat-form').addEventListener('submit', e => {
    e.preventDefault();
    const input = $('chat-input');
    const q = input.value;
    input.value = '';
    ask(q);
  });
  box.querySelectorAll('.suggested-btn').forEach(b => b.addEventListener('click', () => ask(b.textContent)));
  $('new-chat-btn').addEventListener('click', closeChat);
  if (window.lucide) lucide.createIcons();
}

function appendMessage(role, content) {
  const list = $('chat-messages');
  if (!list) return;
  const msg = document.createElement('div');
  msg.className = `message message-${role === 'user' ? 'user' : 'assistant'}`;
  msg.innerHTML = role === 'user'
    ? `<div class="message-content">${esc(content)}</div>`
    : `<div class="message-avatar"><i data-lucide="bot"></i></div><div class="message-content ai-answer">${renderMarkdown(content)}</div>`;
  list.appendChild(msg);
  if (window.lucide) lucide.createIcons();
  list.scrollTop = list.scrollHeight;
}

function setTyping(on) {
  const list = $('chat-messages');
  if (!list) return;
  $('ai-typing')?.remove();
  if (!on) return;
  const t = document.createElement('div');
  t.className = 'typing-indicator';
  t.id = 'ai-typing';
  t.innerHTML = '<div class="message-avatar"><i data-lucide="bot"></i></div><div class="typing-dots" role="status" aria-label="The AI coach is typing"><span></span><span></span><span></span></div>';
  list.appendChild(t);
  if (window.lucide) lucide.createIcons();
  list.scrollTop = list.scrollHeight;
}

function showChatError(text) {
  const list = $('chat-messages');
  if (!list) return;
  const el = document.createElement('div');
  el.className = 'chat-error';
  el.setAttribute('role', 'alert');
  el.innerHTML = `<span>${esc(text)}</span>`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chat-retry';
  btn.textContent = 'Try again';
  btn.addEventListener('click', retry);
  el.appendChild(btn);
  list.appendChild(el);
  list.scrollTop = list.scrollHeight;
}

function setBusy(on) {
  busy = on;
  const analyze = $('analyze-btn');
  if (analyze) {
    analyze.disabled = on;
    analyze.setAttribute('aria-busy', on ? 'true' : 'false');
  }
  ['chat-input', 'chat-send-btn'].forEach(id => { const el = $(id); if (el) el.disabled = on; });
  document.querySelectorAll('.suggested-btn').forEach(b => { b.disabled = on; });
}

function closeChat() {
  chat = null;
  try { if (currentUser) localStorage.removeItem(SAVED_KEY + currentUser.uid); } catch { /* ignore */ }
  const box = $('insights-results');
  if (box) { box.innerHTML = ''; box.classList.add('hidden'); }
}

// ── Saving the conversation (per user, for a day) ───────────────────────────
function saveChat() {
  if (!currentUser || !chat) return;
  try { localStorage.setItem(SAVED_KEY + currentUser.uid, JSON.stringify({ savedAt: Date.now(), chat })); } catch { /* ignore */ }
}

function restoreChat() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED_KEY + currentUser.uid) || 'null');
    if (!saved || Date.now() - saved.savedAt > SAVED_MAX_AGE || !TYPES[saved.chat?.type]) return;
    chat = saved.chat;
    renderGlance(chat.summary, chat.range);
    renderChat();
  } catch { /* ignore a corrupt save */ }
}

// ── Page states ─────────────────────────────────────────────────────────────
function showError(msg) {
  const el = $('insights-error');
  if (!el) return;
  $('error-title').textContent = "Couldn't show insights";
  $('error-message').textContent = msg;
  el.classList.remove('hidden');
}
function hideError() { $('insights-error')?.classList.add('hidden'); }
function showLoading(text) {
  const el = $('insights-loading');
  if (!el) return;
  const label = el.querySelector('.loading-text');
  if (label) label.textContent = text;
  el.classList.remove('hidden');
}
function hideLoading() { $('insights-loading')?.classList.add('hidden'); }

async function ensureConsent() {
  try { if (localStorage.getItem(CONSENT_KEY)) return true; } catch { /* ignore */ }
  const ok = await showConsentDialog();
  if (ok) { try { localStorage.setItem(CONSENT_KEY, 'true'); } catch { /* ignore */ } }
  return ok;
}

function showConsentDialog() {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open insights-consent';
    overlay.innerHTML = `
      <div class="insights-consent-box" role="dialog" aria-modal="true" aria-labelledby="consent-title">
        <h3 id="consent-title">Ask the AI coach?</h3>
        <p>Your numbers above are worked out on your device. To get advice, SpendWise sends the AI only totals by category and dates.</p>
        <p class="insights-consent-note">Descriptions, notes and people's names are never sent.</p>
        <div class="insights-consent-actions">
          <button type="button" id="consent-decline" class="btn-secondary">Not now</button>
          <button type="button" id="consent-accept" class="btn-primary">Ask the coach</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const done = ok => { overlay.remove(); resolve(ok); };
    overlay.querySelector('#consent-accept').addEventListener('click', () => done(true));
    overlay.querySelector('#consent-decline').addEventListener('click', () => done(false));
    overlay.addEventListener('click', e => { if (e.target === overlay) done(false); });
    overlay.addEventListener('keydown', e => { if (e.key === 'Escape') done(false); });
    overlay.querySelector('#consent-accept').focus();
  });
}

// ── Generate ────────────────────────────────────────────────────────────────
async function generate() {
  if (busy) return;
  if (!currentUser) { showError('Please log in to see insights.'); return; }
  const r = periodRange(selectedPeriod, new Date(), { start: $('insights-start-date')?.value, end: $('insights-end-date')?.value });
  if (r.error) { showError(r.error); return; }

  hideError();
  setBusy(true);
  showLoading('Adding up your numbers…');
  let s;
  try {
    s = summarize(await loadData(), r);
  } catch (err) {
    console.error('Insights data error:', err);
    hideLoading();
    setBusy(false);
    showError("Couldn't load your data. Check your connection and try again.");
    return;
  }
  hideLoading();
  renderGlance(s, r);
  closeChat();

  if (!hasData(s) || !(await ensureConsent())) { setBusy(false); return; }

  chat = { type: selectedType, range: r, summary: s, facts: factsText(s, r, money), history: [] };
  chat.history.push({ role: 'user', content: TYPES[selectedType].question });
  renderChat();
  setBusy(true); // renderChat rebuilt the inputs
  await askAI();
  setBusy(false);
}

// ── Setup ───────────────────────────────────────────────────────────────────
function initUI() {
  const periodTabs = $('period-tabs');
  periodTabs?.addEventListener('click', e => {
    const tab = e.target.closest('.period-tab');
    if (!tab) return;
    periodTabs.querySelectorAll('.period-tab').forEach(t => {
      const on = t === tab;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.setAttribute('tabindex', on ? '0' : '-1');
    });
    selectedPeriod = tab.dataset.period;
    $('custom-date-range')?.classList.toggle('hidden', selectedPeriod !== 'custom');
  });

  const typeGrid = $('analysis-type-grid');
  typeGrid?.addEventListener('click', e => {
    const card = e.target.closest('.analysis-type-card');
    if (!card) return;
    typeGrid.querySelectorAll('.analysis-type-card').forEach(c => {
      const on = c === card;
      c.classList.toggle('selected', on);
      c.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    selectedType = card.dataset.type;
  });

  $('analyze-btn')?.addEventListener('click', generate);

  const start = $('insights-start-date');
  const end = $('insights-end-date');
  if (start && end) {
    const today = new Date();
    start.value = todayStr(new Date(today.getFullYear(), today.getMonth(), 1));
    end.value = todayStr(today);
  }

  document.addEventListener('click', e => {
    if (e.target.closest('[data-action="dismissInsightError"]')) hideError();
  });
}

onAuthStateChanged(auth, user => {
  currentUser = user;
  if (user) restoreChat();
});

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI);
else initUI();
