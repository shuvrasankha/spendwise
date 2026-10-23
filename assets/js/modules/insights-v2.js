// insights-v2.js — Insights page.
// 1. "At a glance": numbers computed here from the user's data (no AI, so it always works).
//    Shown as soon as the page opens, and again whenever the period changes.
// 2. AI coach: answers questions about those numbers (Workers AI via config/ai.js).
// Calculations live in insights-data.js (tested in tests/insights.test.mjs).

import { app } from '../config/firebase.js';
import { callAI } from '../config/ai.js';
import { todayStr, normalizeCategory, countTo } from '../utils/helpers.js';
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
const COACH_NOTE = 'Ask about the numbers above. Answers are written by AI and can be wrong.';

const TYPES = {
  overview: {
    title: 'Overview',
    chip: 'What matters most?',
    focus: 'the 3 things that matter most in this period: one thing going well, one thing to watch, and one action for the coming week.',
    question: 'What are the 3 most important things in my numbers right now?',
    suggestions: ['What is going well?', 'Where can I save the most?', 'Am I spending more than before?'],
  },
  spending: {
    title: 'Spending',
    chip: 'Where can I cut back?',
    focus: 'where the money went and 2–3 realistic cuts, biggest first, with roughly how much each could save per month.',
    question: 'Where is my money going, and where could I realistically cut back?',
    suggestions: ['Which category grew the most?', 'How much could I save on food?', 'Is my biggest expense normal?'],
  },
  savings: {
    title: 'Savings',
    chip: 'How are my savings?',
    focus: 'the savings rate against a 20% guideline and concrete steps to raise it. If no income is recorded, say that income entries are needed for this and give spending-based tips instead.',
    question: 'How is my savings rate, and how can I improve it?',
    suggestions: ['How much should I save each month?', 'What if I cut my top category by 10%?', 'Where do small amounts add up?'],
  },
  trends: {
    title: 'Trends',
    chip: 'What changed?',
    focus: 'how this period compares with the previous one: total and per-category changes, the daily average and the month-end projection, and what is driving the change.',
    question: 'How does this period compare with before, and what is driving the change?',
    suggestions: ['Which category changed the most?', 'Will I spend more than last month?', 'What should I watch next month?'],
  },
  debt: {
    title: 'Debt',
    chip: 'What about my debts?',
    focus: 'the unsettled debts in the numbers: what to settle first, money others owe the user that is worth following up, and a simple plan. If there are no unsettled debts, say so in one sentence and give one tip.',
    question: 'What should I do about my debts?',
    suggestions: ['What should I pay back first?', 'How do I follow up on money owed to me?', 'Should I pay debts before saving?'],
  },
};

let currentUser = null;
let busy = false;
let selectedPeriod = 'month';
let dataPromise = null; // the user's records, loaded once per page view
let glance = null;      // { range, summary } on screen now
let loadSeq = 0;        // ignores a slow load when the period changed meanwhile
let chat = null;        // { type, range, summary, facts, history: [{ role, content }] }

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
    get('expenses', r => ({ amount: num(r.amount), category: normalizeCategory(r.category), date: r.date || '' })),
    get('income', r => ({ amount: num(r.amount), date: r.date || '' })),
    get('debts', r => ({ amount: num(r.amount), type: r.type || 'they-owe', settled: !!r.settled, settledDate: r.settledDate || '', date: r.date || '' })),
  ]);
  return { expenses, income, debts };
}

// ── At a glance ─────────────────────────────────────────────────────────────
function changeText(change, against) {
  if (change === null) return '';
  const up = change > 0;
  return `<p class="glance-change ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(change).toFixed(0)}% ${up ? 'more' : 'less'} than ${esc(against)}</p>`;
}

function setGlanceLoading() {
  const el = $('insights-glance');
  if (!el) return;
  el.setAttribute('aria-busy', 'true');
  el.innerHTML = '<section class="home-hero ins-skeleton" aria-label="Adding up your numbers"><span></span><span></span><span></span></section>';
}

// Same building blocks as the home page, for any period
function renderGlance(s, r) {
  const el = $('insights-glance');
  if (!el) return;
  el.setAttribute('aria-busy', 'false');

  if (!hasData(s)) {
    el.innerHTML = `
      <section class="home-hero">
        <h2 class="home-month">${esc(r.label)}</h2>
        <p class="ins-none">Nothing recorded in this period. Try a longer period, or <a href="expense.html">add an expense</a>.</p>
      </section>`;
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
  const biggest = s.biggest.map(b => `
    <li class="home-row">
      <div class="home-row-main"><span class="home-row-title">${esc(b.category)}</span><span class="home-row-meta">${shortDate(b.date)}</span></div>
      <span class="home-row-amount">${money(b.amount)}</span>
    </li>`).join('');

  el.innerHTML = `
    <section class="home-hero" aria-labelledby="glance-title">
      <h2 class="home-month" id="glance-title">${esc(r.label)}</h2>
      <p class="home-spent"><span class="home-spent-amount" data-count="spent">${money(s.spent)}</span> <span class="home-spent-label">spent</span></p>
      ${changeText(s.spendChange, r.prevLabel)}
      <p class="home-pace">${money(s.dailyAvg)} a day${s.projection !== null ? ` · on track for ${money(s.projection)} by the end of ${esc(monthName)}` : ''}</p>
    </section>
    <div class="home-tiles">
      <div class="home-tile">
        <span class="home-tile-label">Income</span>
        <span class="home-tile-value"${s.incomeCount ? ' data-count="earned"' : ''}>${s.incomeCount ? money(s.earned) : '—'}</span>
        ${s.incomeCount ? '' : '<span class="home-tile-sub">None recorded</span>'}
      </div>
      <div class="home-tile">
        <span class="home-tile-label">Saved</span>
        <span class="home-tile-value"${s.savingsRate !== null ? ' data-count="saved"' : ''}>${s.savingsRate !== null ? money(s.saved) : '—'}</span>
        <span class="home-tile-sub">${s.savingsRate !== null ? `${s.savingsRate.toFixed(0)}% of income` : 'Needs income entries'}${s.invested > 0 ? ` · ${money(s.invested)} invested` : ''}</span>
      </div>
      ${s.debts.activeCount ? `
      <a class="home-tile home-tile-wide" href="debt.html">
        <span class="home-tile-label">Debts now</span>
        <span class="home-tile-debts">
          <span>You owe <strong>${money(s.debts.youOwe)}</strong></span>
          <span>Owed to you <strong>${money(s.debts.owedToYou)}</strong></span>
        </span>
      </a>` : ''}
    </div>
    ${cats ? `
    <section class="home-section" aria-labelledby="glance-cats-title">
      <div class="home-section-head"><h3 id="glance-cats-title">Where it went</h3></div>
      <ul class="glance-cats">${cats}</ul>
    </section>` : ''}
    ${biggest ? `
    <section class="home-section" aria-labelledby="glance-big-title">
      <div class="home-section-head"><h3 id="glance-big-title">Biggest expenses</h3></div>
      <ul class="home-list">${biggest}</ul>
    </section>` : ''}`;
  // Switching periods counts each figure from the last period's value to this one's
  el.querySelectorAll('[data-count]').forEach(n => {
    const key = n.dataset.count;
    n.dataset.value = shownTotals[key] ?? 0;
    countTo(n, s[key], money);
    shownTotals[key] = s[key];
  });
}
const shownTotals = {}; // last value shown per figure (spent, earned, saved)

async function showPeriod() {
  if (!currentUser) return;
  const r = periodRange(selectedPeriod, new Date(), { start: $('insights-start-date')?.value, end: $('insights-end-date')?.value });
  if (r.error) { showError(r.error); return; }
  hideError();
  const seq = ++loadSeq;
  if (!dataPromise) setGlanceLoading(); // later periods reuse the loaded data, so they show instantly
  let data;
  try {
    data = await (dataPromise ??= loadData());
  } catch (err) {
    console.error('Insights data error:', err);
    dataPromise = null; // let the next try fetch again
    if (seq === loadSeq) showError("Couldn't load your data. Check your connection and try again.");
    return;
  }
  if (seq !== loadSeq) return;
  glance = { range: r, summary: summarize(data, r) };
  renderGlance(glance.summary, r);
  updateCoach();
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

async function startChat(type) {
  if (busy || !glance || !hasData(glance.summary) || !(await ensureConsent())) return;
  const { range, summary } = glance;
  chat = { type, range, summary, facts: factsText(summary, range, money), history: [{ role: 'user', content: TYPES[type].question }] };
  renderChat();
  setBusy(true);
  await askAI();
  setBusy(false);
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

// ── Coach UI ────────────────────────────────────────────────────────────────
// Topic chips when no conversation is open; the conversation replaces them
function updateCoach() {
  const topics = $('coach-topics');
  const note = $('coach-note');
  $('new-chat-btn')?.classList.toggle('hidden', !chat);
  if (chat) {
    topics?.classList.add('hidden');
    if (note) note.textContent = `${TYPES[chat.type].title} · ${chat.range.label}. Answers are written by AI and can be wrong.`;
    return;
  }
  const ready = glance && hasData(glance.summary);
  topics?.classList.toggle('hidden', !ready);
  if (note) note.textContent = !glance ? COACH_NOTE : ready ? COACH_NOTE : 'Add some expenses or income for this period, then ask the coach about them.';
}

function renderChat() {
  const box = $('insights-results');
  if (!box || !chat) return;
  const t = TYPES[chat.type];
  box.innerHTML = `
    <div class="chat-messages" id="chat-messages" aria-live="polite"></div>
    <div class="suggested-list" role="group" aria-label="Suggested questions">${t.suggestions.map(q => `<button type="button" class="suggested-btn">${esc(q)}</button>`).join('')}</div>
    <form class="chat-form" id="chat-form">
      <label for="chat-input" class="sr-only">Ask the AI coach</label>
      <input type="text" id="chat-input" placeholder="Ask about your numbers" class="chat-input" autocomplete="off" enterkeyhint="send" />
      <button type="submit" class="chat-send-btn" id="chat-send-btn" aria-label="Send"><i data-lucide="arrow-up"></i></button>
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
  updateCoach();
  if (window.lucide) lucide.createIcons();
}

function appendMessage(role, content) {
  const list = $('chat-messages');
  if (!list) return;
  const msg = document.createElement('div');
  msg.className = `message message-${role === 'user' ? 'user' : 'assistant'}`;
  msg.innerHTML = role === 'user'
    ? `<div class="message-content">${esc(content)}</div>`
    : `<div class="message-content ai-answer">${renderMarkdown(content)}</div>`;
  list.appendChild(msg);
  msg.scrollIntoView({ block: 'nearest' });
}

function setTyping(on) {
  const list = $('chat-messages');
  if (!list) return;
  $('ai-typing')?.remove();
  if (!on) return;
  const t = document.createElement('div');
  t.className = 'message message-assistant';
  t.id = 'ai-typing';
  t.innerHTML = '<div class="message-content typing-dots" role="status" aria-label="The AI coach is typing"><span></span><span></span><span></span></div>';
  list.appendChild(t);
  t.scrollIntoView({ block: 'nearest' });
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
  el.scrollIntoView({ block: 'nearest' });
}

function setBusy(on) {
  busy = on;
  ['chat-input', 'chat-send-btn'].forEach(id => { const el = $(id); if (el) el.disabled = on; });
  document.querySelectorAll('.suggested-btn, .chip').forEach(b => { b.disabled = on; });
}

function closeChat() {
  chat = null;
  try { if (currentUser) localStorage.removeItem(SAVED_KEY + currentUser.uid); } catch { /* ignore */ }
  const box = $('insights-results');
  if (box) { box.innerHTML = ''; box.classList.add('hidden'); }
  updateCoach();
}

// ── Saving the conversation (per user, for a day) ───────────────────────────
function saveChat() {
  if (!currentUser || !chat) return;
  try { localStorage.setItem(SAVED_KEY + currentUser.uid, JSON.stringify({ savedAt: Date.now(), chat })); } catch { /* ignore */ }
}

// Reopens today's conversation with the numbers it was about; false if there is none
function restoreChat() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED_KEY + currentUser.uid) || 'null');
    if (!saved || Date.now() - saved.savedAt > SAVED_MAX_AGE || !TYPES[saved.chat?.type]) return false;
    chat = saved.chat;
    const { range } = chat;
    selectPeriod(range.period || 'custom');
    if (selectedPeriod === 'custom') { $('insights-start-date').value = range.start; $('insights-end-date').value = range.end; }
    glance = { range, summary: chat.summary };
    renderGlance(chat.summary, range);
    renderChat();
    return true;
  } catch { return false; } // a corrupt save
}

// ── Page states ─────────────────────────────────────────────────────────────
function showError(msg) {
  const el = $('insights-error');
  if (!el) return;
  $('error-message').textContent = msg;
  el.classList.remove('hidden');
}
function hideError() { $('insights-error')?.classList.add('hidden'); }

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

// ── Setup ───────────────────────────────────────────────────────────────────
function selectPeriod(period) {
  selectedPeriod = period;
  document.querySelectorAll('.seg-btn').forEach(b => b.setAttribute('aria-pressed', b.dataset.period === period ? 'true' : 'false'));
  $('custom-date-range')?.classList.toggle('hidden', period !== 'custom');
}

function initUI() {
  $('period-tabs')?.addEventListener('click', e => {
    const btn = e.target.closest('.seg-btn');
    if (!btn || btn.dataset.period === selectedPeriod) return;
    selectPeriod(btn.dataset.period);
    closeChat(); // a conversation is about one period's numbers
    showPeriod();
  });

  const start = $('insights-start-date');
  const end = $('insights-end-date');
  if (start && end) {
    const today = new Date();
    start.value = todayStr(new Date(today.getFullYear(), today.getMonth(), 1));
    end.value = todayStr(today);
    [start, end].forEach(input => input.addEventListener('change', () => { closeChat(); showPeriod(); }));
  }

  const topics = $('coach-topics');
  if (topics) {
    topics.innerHTML = Object.entries(TYPES).map(([type, t]) => `<button type="button" class="chip" data-type="${type}">${esc(t.chip)}</button>`).join('');
    topics.addEventListener('click', e => {
      const btn = e.target.closest('.chip');
      if (btn) startChat(btn.dataset.type);
    });
  }
  $('new-chat-btn')?.addEventListener('click', closeChat);
  updateCoach();
}

onAuthStateChanged(auth, user => {
  currentUser = user;
  if (user && !restoreChat()) showPeriod();
});

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI);
else initUI();
