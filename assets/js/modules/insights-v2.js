// insights-v2.js — Insights page.
// 1. "At a glance": numbers computed here from the user's data (no AI, so it always works).
//    Shown as soon as the page opens, and again whenever the period changes.
// 2. AI coach: answers questions about those numbers (Workers AI via config/ai.js).
// Calculations live in insights-data.js (tested in tests/insights.test.mjs).

import { app } from '../config/firebase.js';
import { callAI } from '../config/ai.js';
import { todayStr, normalizeCategory, countTo, forecast, isSkippedBill, addMonths } from '../utils/helpers.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, getDocs, query, where } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { periodRange, summarize, hasData, factsText, renderMarkdown, shortDate, pieSlices } from './insights-data.js';
import { askPrompt, readSpec, guessSpec, runQuery, answerFor, subjectText, dayText, searchWords } from './ask-data.js';

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
    get('expenses', r => ({ amount: num(r.amount), category: normalizeCategory(r.category), date: r.date || '',
      description: r.description || '', payment: r.payment || '', repeat: r.repeat || '', emiTotal: Number(r.emiTotal) || 0,
      notes: r.notes || '', cardName: r.cardName || '', tags: Array.isArray(r.tags) ? r.tags : [] })),
    get('income', r => ({ amount: num(r.amount), date: r.date || '', source: r.source || '', notes: r.notes || '', bank: r.bank || '' })),
    get('debts', r => ({ amount: num(r.amount), type: r.type || 'they-owe', settled: !!r.settled, settledDate: r.settledDate || '', date: r.date || '' })),
  ]);
  return { expenses, income, debts };
}

// ── Analysis ────────────────────────────────────────────────────────────────
// The Dashboard already shows this month's totals, income, savings, debts and categories. Insights
// shows only what it doesn't: how the period compares with the one before, what changed, the
// biggest expenses, when and how you spend, and what is fixed versus flexible.

function setGlanceLoading() {
  const el = $('insights-glance');
  if (!el) return;
  el.setAttribute('aria-busy', 'true');
  el.innerHTML = '<section class="home-hero ins-skeleton" aria-label="Adding up your numbers"><span></span><span></span><span></span></section>';
}

// "₹2,100 more" / "₹2,100 less" / "the same"
const moreLess = d => (Math.abs(d) < 1 ? 'the same' : `${money(Math.abs(d))} ${d > 0 ? 'more' : 'less'}`);

function compareCard(s, r) {
  const head = `<div class="home-section-head"><h3 id="ins-compare-title">Compared with ${esc(r.prevLabel)}</h3></div>`;
  if (!(s.prevSpent > 0)) {
    return `<section class="home-section ins-compare" aria-labelledby="ins-compare-title">${head}
      <p class="ins-compare-none">Nothing to compare yet: no expenses in ${esc(r.prevLabel)}.</p></section>`;
  }
  const diff = s.spent - s.prevSpent;
  const rows = [];
  if (s.incomeCount || s.prevIncomeCount) rows.push(['Income', moreLess(s.earned - s.prevEarned)]);
  if (s.incomeCount && s.prevIncomeCount) rows.push(['Saved', moreLess((s.earned - s.spent) - (s.prevEarned - s.prevSpent))]);
  return `<section class="home-section ins-compare" aria-labelledby="ins-compare-title">${head}
    <p class="ins-figure"><span class="ins-figure-amount">${Math.abs(diff) < 1 ? 'Same' : money(Math.abs(diff))}</span>
      <span class="ins-figure-unit">${Math.abs(diff) < 1 ? 'spending as before' : `${diff > 0 ? 'more' : 'less'} spent`}</span></p>
    ${s.spendChange !== null && Math.abs(diff) >= 1 ? `<p class="ins-compare-pct ${diff > 0 ? 'up' : 'down'}">${Math.abs(s.spendChange).toFixed(0)}% ${diff > 0 ? 'higher' : 'lower'} than ${esc(r.prevLabel)}</p>` : ''}
    ${rows.length ? `<ul class="ins-compare-rows">${rows.map(([k, v]) => `<li><span>${k}</span><strong>${esc(v)}</strong></li>`).join('')}</ul>` : ''}
  </section>`;
}

// ── Where it went: the period's spending by category as a pie (a ring, the total in the middle) ──
// Slices take the --pie-N colours in order, "Other" its neutral; each is named in the legend beside it.
const PIE_GAP = 0.6; // of 100: about 2px of surface between slices
function pieCard(s) {
  const slices = pieSlices(s.categories);
  if (!slices.length) return '';
  const colour = (x, i) => (x.other ? 'var(--pie-other)' : `var(--pie-${i + 1})`);
  const one = slices.length === 1;
  const arcs = slices.map((x, i) => {
    const len = one ? 100 : Math.max(x.share - PIE_GAP, 0.3);
    return `<circle class="ins-pie-slice" data-slice="${i}" cx="60" cy="60" r="48" pathLength="100" stroke="${colour(x, i)}"
      stroke-dasharray="${len.toFixed(2)} ${(100 - len).toFixed(2)}" stroke-dashoffset="${(-x.start - (one ? 0 : PIE_GAP / 2)).toFixed(2)}"><title>${esc(x.label)}: ${money(x.amount)} · ${x.share.toFixed(0)}%</title></circle>`;
  }).join('');
  const rows = slices.map((x, i) => `<li class="ins-pie-row" data-slice="${i}">
      <span class="ins-dot" style="background:${colour(x, i)}" aria-hidden="true"></span>
      <span class="ins-pie-name">${esc(x.label)}</span>
      <span class="ins-pie-value">${money(x.amount)}<small>${x.share < 1 ? '<1' : x.share.toFixed(0)}%</small></span>
    </li>`).join('');
  const summary = slices.map(x => `${x.label} ${x.share.toFixed(0)}%`).join(', ');
  return `<section class="home-section ins-pie" aria-labelledby="ins-pie-title">
    <div class="home-section-head"><h3 id="ins-pie-title">Where it went</h3><span class="home-section-total">by category</span></div>
    <div class="ins-pie-body">
      <figure class="ins-pie-chart" role="img" aria-label="Spending by category: ${esc(summary)}">
        <svg viewBox="0 0 120 120" aria-hidden="true"><g transform="rotate(-90 60 60)">${arcs}</g></svg>
        <figcaption class="ins-pie-centre" aria-hidden="true"><strong>${money(s.spent)}</strong><span>spent</span></figcaption>
      </figure>
      <ul class="ins-pie-legend">${rows}</ul>
    </div>
  </section>`;
}

// Pointing at a slice or its legend row picks out both and quiets the rest
function bindPie(root) {
  const card = root.querySelector('.ins-pie');
  if (!card) return;
  const pick = i => {
    card.classList.toggle('picking', i != null);
    card.querySelectorAll('[data-slice]').forEach(el => el.classList.toggle('picked', el.dataset.slice === i));
  };
  card.addEventListener('pointerover', e => pick(e.target.closest('[data-slice]')?.dataset.slice ?? null)); // a tap elsewhere in the card clears it
  card.addEventListener('pointerleave', () => pick(null));
}

function changedCard(s) {
  if (!s.movers.length) return '';
  const rows = s.movers.map(m => {
    const up = m.diff > 0;
    const sub = m.prevAmount === 0 ? `New · ${money(m.amount)}` : m.amount === 0 ? `None this time · was ${money(m.prevAmount)}` : `${money(m.prevAmount)} → ${money(m.amount)}`;
    return `<li class="ins-row">
      <span class="ins-icon ${up ? 'up' : 'down'}" aria-hidden="true"><i data-lucide="${up ? 'trending-up' : 'trending-down'}"></i></span>
      <div class="ins-row-body">
        <div class="home-row-main"><span class="home-row-title">${esc(m.category)}</span><span class="home-row-meta">${esc(sub)}</span></div>
        <span class="ins-row-value ${up ? 'up' : 'down'}">${up ? '+' : '−'}${money(Math.abs(m.diff))}</span>
      </div>
    </li>`;
  }).join('');
  return `<section class="home-section" aria-labelledby="ins-changed-title">
    <div class="home-section-head"><h3 id="ins-changed-title">What changed</h3><span class="home-section-total">by category</span></div>
    <ul class="ins-list">${rows}</ul></section>`;
}

function biggestCard(s) {
  if (!s.biggest.length) return '';
  const rows = s.biggest.map(b => `<li class="ins-row">
      <span class="ins-icon" aria-hidden="true"><i data-lucide="receipt"></i></span>
      <div class="ins-row-body">
        <div class="home-row-main"><span class="home-row-title">${esc(b.description || b.category)}</span><span class="home-row-meta">${esc([b.description ? b.category : '', shortDate(b.date)].filter(Boolean).join(' · '))}</span></div>
        <span class="home-row-amount">${money(b.amount)}</span>
      </div>
    </li>`).join('');
  return `<section class="home-section" aria-labelledby="ins-big-title">
    <div class="home-section-head"><h3 id="ins-big-title">Biggest expenses</h3></div>
    <ul class="ins-list">${rows}</ul></section>`;
}

const DAY_NAMES = { Mon: 'Mondays', Tue: 'Tuesdays', Wed: 'Wednesdays', Thu: 'Thursdays', Fri: 'Fridays', Sat: 'Saturdays', Sun: 'Sundays' };
function weekdayCard(s) {
  if (s.txCount < 3) return '';
  const top = s.weekdays.reduce((a, b) => (b.amount > a.amount ? b : a));
  const max = top.amount || 1;
  const bars = s.weekdays.map(w => `<li class="ins-day${w === top ? ' top' : ''}">
      <span class="ins-day-bar"><span style="height:${Math.max((w.amount / max) * 100, w.amount ? 6 : 0).toFixed(0)}%"></span></span>
      <span class="ins-day-name">${w.day.slice(0, 1)}<span class="sr-only">${w.day.slice(1)}: ${money(w.amount)}</span></span>
    </li>`).join('');
  return `<section class="home-section" aria-labelledby="ins-days-title">
    <div class="home-section-head"><h3 id="ins-days-title">When you spend</h3></div>
    <p class="ins-lead">Most on <strong>${DAY_NAMES[top.day]}</strong>: ${money(top.amount)}, ${s.spent > 0 ? ((top.amount / s.spent) * 100).toFixed(0) : 0}% of this period's spending.</p>
    <ul class="ins-days">${bars}</ul></section>`;
}

function paymentCard(s) {
  if (s.payments.length < 1 || s.txCount < 2) return '';
  const rows = s.payments.slice(0, 5).map(p => `<li class="ins-pay">
      <div class="ins-pay-row"><span>${esc(p.name)}</span><span class="ins-pay-amount">${money(p.amount)} · ${p.share.toFixed(0)}%</span></div>
      <div class="ins-bar" aria-hidden="true"><span style="width:${Math.max(p.share, 2).toFixed(1)}%"></span></div>
    </li>`).join('');
  return `<section class="home-section" aria-labelledby="ins-pay-title">
    <div class="home-section-head"><h3 id="ins-pay-title">How you pay</h3></div>
    <ul class="ins-pays">${rows}</ul></section>`;
}

function fixedCard(s) {
  if (!(s.fixed > 0) || !(s.spent > 0)) return '';
  const share = (s.fixed / s.spent) * 100;
  return `<section class="home-section" aria-labelledby="ins-fixed-title">
    <div class="home-section-head"><h3 id="ins-fixed-title">Fixed and flexible</h3></div>
    <div class="ins-split" role="img" aria-label="${share.toFixed(0)}% fixed, ${(100 - share).toFixed(0)}% flexible"><span style="width:${share.toFixed(1)}%"></span></div>
    <ul class="ins-legend">
      <li><span class="ins-dot fixed"></span><div><strong>${money(s.fixed)} fixed</strong><span>Repeating bills and EMIs · ${share.toFixed(0)}%</span></div></li>
      <li><span class="ins-dot flex"></span><div><strong>${money(s.spent - s.fixed)} flexible</strong><span>Everything else, where cutting back is up to you · ${(100 - share).toFixed(0)}%</span></div></li>
    </ul></section>`;
}

// ── Forecast: this month's end figure, how it's made up, and next month ─────
// The Dashboard's "on track for" uses the same forecast(); this card shows how it adds up.
const monthLong = m => new Date(m + '-01T00:00:00').toLocaleDateString('en-US', { month: 'long' });
function renderForecast(data) {
  const el = $('insights-forecast');
  if (!el) return;
  const today = todayStr();
  const f = forecast(data.expenses, today, isSkippedBill);
  if (!(f.spent > 0) && !f.billsTotal && !(f.perDay > 0)) { el.innerHTML = ''; return; }
  const name = monthLong(f.month), lastName = monthLong(addMonths(f.month, -1));
  const diff = f.total - f.lastMonthSpent;
  const vs = f.lastMonthSpent > 0 && Math.abs(diff) >= 1
    ? `<p class="ins-compare-pct ${diff > 0 ? 'up' : 'down'}">${money(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than ${esc(lastName)} (${money(f.lastMonthSpent)})</p>` : '';
  const pct = v => (f.total > 0 ? (v / f.total) * 100 : 0).toFixed(1);
  const bills = f.billsDue.length
    ? `${f.billsDue.slice(0, 3).map(b => esc(b.title)).join(', ')}${f.billsDue.length > 3 ? ` and ${f.billsDue.length - 3} more` : ''}`
    : 'None left this month';
  el.innerHTML = `
    <section class="home-section ins-forecast" aria-labelledby="ins-forecast-title">
      <div class="home-section-head"><h3 id="ins-forecast-title">Forecast</h3></div>
      <p class="ins-figure"><span class="ins-figure-amount">${money(f.total)}</span><span class="ins-figure-unit">by the end of ${esc(name)}</span></p>
      ${vs}
      <div class="ins-stack" role="img" aria-label="Spent so far ${money(f.spent)}, bills still due ${money(f.billsTotal)}, at your usual pace ${money(f.usualLeft)}">
        <span class="s1" style="width:${pct(f.spent)}%"></span><span class="s2" style="width:${pct(f.billsTotal)}%"></span><span class="s3" style="width:${pct(f.usualLeft)}%"></span>
      </div>
      <ul class="ins-legend">
        <li><span class="ins-dot s1"></span><div><strong>${money(f.spent)} spent so far</strong><span>Up to today</span></div></li>
        <li><span class="ins-dot s2"></span><div><strong>${money(f.billsTotal)} in bills still due</strong><span>${bills}</span></div></li>
        <li><span class="ins-dot s3"></span><div><strong>${money(f.usualLeft)} at your usual pace</strong><span>${money(f.perDay)} a day for the ${f.daysLeft} ${f.daysLeft === 1 ? 'day' : 'days'} left, leaving out bills${f.oneOffs ? ` and ${f.oneOffs} one-off big ${f.oneOffs === 1 ? 'expense' : 'expenses'}` : ''}</span></div></li>
      </ul>
      <div class="ins-forecast-next">
        <span>${esc(monthLong(f.next.month))}</span>
        <strong>About ${money(f.next.total)}</strong>
        <small>${money(f.next.fixed)} in ${f.next.bills} ${f.next.bills === 1 ? 'bill' : 'bills'} and EMIs, ${money(f.next.usual)} at your usual pace</small>
      </div>
    </section>`;
}

function renderGlance(s, r) {
  const el = $('insights-glance');
  if (!el) return;
  el.setAttribute('aria-busy', 'false');
  if (!hasData(s)) {
    el.innerHTML = `
      <section class="home-section">
        <p class="ins-none">Nothing recorded in ${esc(r.label)}. Try a longer period, or <a href="expense.html">add an expense</a>.</p>
      </section>`;
    return;
  }
  el.innerHTML = [compareCard(s, r), pieCard(s), changedCard(s), biggestCard(s), weekdayCard(s), paymentCard(s), fixedCard(s)].join('');
  bindPie(el);
  if (window.lucide) lucide.createIcons();
}

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
  renderForecast(data);
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
        <h3 id="consent-title">Use the AI?</h3>
        <p>Your numbers are worked out on your device. To understand a question, SpendWise sends the AI only the question; for the coach's advice, only totals by category and dates.</p>
        <p class="insights-consent-note">Your entries, descriptions, notes and people's names are never sent. Without the AI, common questions are still answered on your device.</p>
        <div class="insights-consent-actions">
          <button type="button" id="consent-decline" class="btn-secondary">Not now</button>
          <button type="button" id="consent-accept" class="btn-primary">Continue</button>
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

// ── Ask about your spending (ask-data.js) ───────────────────────────────────
// The AI turns the question into a search: it is sent the question and today's date, never entries.
// The search runs here over the user's own entries. Declined, offline or over the limit, guessSpec
// reads common questions on the device instead.
let asking = false;

async function specFor(question, today) {
  if (await ensureConsent()) {
    try {
      const res = await callAI({
        model: AI_MODEL,
        messages: [{ role: 'system', content: askPrompt(today) }, { role: 'user', content: question }],
        max_tokens: 200,
        temperature: 0,
      });
      if (res.ok) {
        const spec = readSpec((await res.json()).choices?.[0]?.message?.content || '');
        if (spec) return spec;
      }
    } catch { /* offline: read it here */ }
  }
  return guessSpec(question, today);
}

// "Amazon · 1 Sep – 30 Sep · expenses": what was searched, so a misread question is easy to spot
function searchedText(spec) {
  const day = s => dayText(s, todayStr());
  const dates = spec.from || spec.to ? `${spec.from ? day(spec.from) : 'The start'} – ${spec.to ? day(spec.to) : 'today'}` : 'All time';
  const kind = spec.type === 'income' ? 'income' : spec.type === 'both' ? 'expenses and income' : 'expenses';
  return [subjectText(spec) || 'Everything', dates, kind].join(' · ');
}

// The same search, opened in History (one kind at a time)
function historyLink(spec) {
  if (spec.type === 'both') return '';
  const p = new URLSearchParams();
  if (spec.type === 'income') p.set('tab', 'income');
  const q = spec.tag ? '#' + spec.tag : searchWords(spec.text).join(' '); // the words that matched, filler dropped
  if (q) p.set('q', q);
  if (spec.from) p.set('from', spec.from);
  if (spec.to) p.set('to', spec.to);
  spec.categories.forEach(c => p.append('cat', c));
  return 'history.html?' + p.toString();
}

function renderAnswer(spec, result, today) {
  const box = $('ask-result');
  const { headline, sentence } = answerFor(spec, result, money, today);
  // newest first, or largest first when the question asks for the biggest
  const shown = spec.measure === 'biggest' ? [...result.rows].sort((a, b) => b.amount - a.amount) : result.rows;
  const rows = shown.slice(0, 5).map(r => {
    const name = r.kind === 'income' ? (r.source || 'Income') : (r.description && r.description !== '-' ? r.description : r.category);
    const sub = [r.kind === 'income' ? 'Income' : r.category, shortDate(r.date)].filter(Boolean).join(' · ');
    return `<li class="ins-row">
      <span class="ins-icon" aria-hidden="true"><i data-lucide="${r.kind === 'income' ? 'arrow-down-left' : 'receipt'}"></i></span>
      <div class="ins-row-body">
        <div class="home-row-main"><span class="home-row-title">${esc(name)}</span><span class="home-row-meta">${esc(sub)}</span></div>
        <span class="home-row-amount">${money(r.amount)}</span>
      </div>
    </li>`;
  }).join('');
  const link = historyLink(spec);
  // The figure counts up from zero (countTo); a count is a plain number, everything else money
  const value = !result.count ? 0 : spec.measure === 'count' ? result.count : spec.measure === 'biggest' ? result.biggest.amount : Math.abs(result.total);
  box.innerHTML = `
    <p class="ins-ask-headline" id="ask-figure">${esc(headline)}</p>
    <p class="ins-ask-sentence">${esc(sentence)}</p>
    <p class="ins-ask-searched">Searched: ${esc(searchedText(spec))}</p>
    ${rows ? `<ul class="ins-list">${rows}</ul>` : ''}
    ${link && result.count ? `<a class="home-more" href="${esc(link)}">${result.count > 5 ? `See all ${result.count} in History` : 'Open in History'} <i data-lucide="chevron-right"></i></a>` : ''}`;
  box.classList.remove('hidden');
  box.classList.add('is-answer');
  if (window.lucide) lucide.createIcons();
  const figure = $('ask-figure');
  figure.dataset.value = 0;
  countTo(figure, value, spec.measure === 'count' ? n => String(Math.round(n)) : money);
}

// While asking: the send arrow spins, and the answer's place shimmers
function setAsking(on) {
  const btn = $('ask-go');
  btn.disabled = on;
  btn.classList.toggle('is-busy', on);
  btn.innerHTML = `<i data-lucide="${on ? 'loader-2' : 'arrow-up'}" aria-hidden="true"></i>`;
  btn.setAttribute('aria-label', on ? 'Working it out' : 'Ask');
  if (on) {
    const box = $('ask-result');
    box.classList.remove('hidden', 'is-answer');
    box.innerHTML = `<div class="ins-ask-loading" aria-label="Looking through your entries"><span></span><span></span><span></span></div>`;
  }
  if (window.lucide) lucide.createIcons();
}

async function askQuestion(question) {
  question = question.trim().slice(0, 200);
  if (!question || asking || !currentUser) return;
  asking = true;
  setAsking(true);
  const box = $('ask-result');
  try {
    const today = todayStr();
    const [spec, data] = await Promise.all([specFor(question, today), dataPromise ??= loadData()]);
    renderAnswer(spec, runQuery(spec, data), today);
  } catch (err) {
    console.error('Ask error:', err);
    dataPromise = null;
    box.innerHTML = `<p class="ins-ask-sentence">Couldn't load your entries. Check your connection and try again.</p>`;
  } finally {
    asking = false;
    setAsking(false);
  }
}

const ASK_EXAMPLES = ['Amazon last month', 'Food this week', 'Biggest expense this year', 'Salary this month'];

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
  $('ask-form')?.addEventListener('submit', e => { e.preventDefault(); askQuestion($('ask-input').value); });
  const examples = $('ask-examples');
  if (examples) {
    examples.innerHTML = ASK_EXAMPLES.map(q => `<button type="button" class="chip">${esc(q)}</button>`).join('');
    examples.addEventListener('click', e => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      $('ask-input').value = chip.textContent;
      askQuestion(chip.textContent);
    });
  }
  updateCoach();
}

onAuthStateChanged(auth, user => {
  currentUser = user;
  if (user && !restoreChat()) showPeriod();
});

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI);
else initUI();
