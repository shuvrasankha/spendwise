// budget.js — A monthly spending limit, overall and per category, saved to the user's
// settings in Firestore (settings.js). Home reads it through getBudget() and redraws on the
// 'spendwise:budget' event. Opened from the profile menu or Home's "Set a budget" link.
import { EXPENSE_CATEGORIES } from '../utils/helpers.js';
import { getSetting, onSettings, saveSettings } from './settings.js';
import { showToast } from './page-shell.js';
import { auth, db } from '../config/firebase.js';
import { callAI } from '../config/ai.js';
import { todayStr } from '../utils/helpers.js';
import { budgetFacts, budgetPrompt, checkSuggestion, suggestFromFacts, readReply } from './budget-data.js';
import { collection, getDocs, query, where } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const LEGACY_KEY = 'spendwise_budget'; // before the budget was synced: one per device
const EMPTY = () => ({ total: null, cats: {} });
const changed = () => window.dispatchEvent(new CustomEvent('spendwise:budget'));

function normalize(b) {
  return b && typeof b === 'object' ? { total: b.total > 0 ? b.total : null, cats: b.cats || {} } : EMPTY();
}

export function getBudget() {
  return normalize(getSetting('budget'));
}

function saveBudget(b) {
  saveSettings({ budget: b }).catch(e => {
    console.error('Budget save failed:', e);
    showToast("Couldn't save the budget to your account. Check your connection and try again.", 'error');
  });
  changed();
}

// After sign-in: show the account's budget, or move a budget saved on this device before syncing existed
onSettings(s => {
  if (s.budget === undefined) {
    let legacy = EMPTY();
    try { legacy = normalize(JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null')); } catch { /* ignore */ }
    if (legacy.total || Object.keys(legacy.cats).length) {
      saveSettings({ budget: legacy }).then(() => { try { localStorage.removeItem(LEGACY_KEY); } catch { /* ignore */ } }, () => {});
    }
  }
  changed();
});

const symbol = () => (window.getCurrencyInfo?.(window.getCurrency?.())?.symbol) || '₹';
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => { const n = parseFloat(String(v).replace(/[^\d.]/g, '')); return n > 0 ? Math.round(n * 100) / 100 : null; };

let overlay = null;

function buildDialog() {
  overlay = document.createElement('div');
  overlay.className = 'modal-overlay budget-overlay hidden';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'budget-title');
  overlay.innerHTML = `
    <div class="modal-box budget-box">
      <div class="modal-header">
        <h3 id="budget-title">Monthly budget</h3>
        <button type="button" class="modal-close-btn" data-budget-close aria-label="Close"><i data-lucide="x"></i></button>
      </div>
      <p class="budget-note">Saved to your account. Home shows how much of it you've used.</p>
      <div class="budget-ai">
        <button type="button" class="budget-ai-btn" data-budget-suggest><i data-lucide="sparkles" aria-hidden="true"></i><span>Suggest from my income</span></button>
        <p class="budget-ai-note">From your last 3 months of income and spending. Only monthly totals go to the AI, never your entries.</p>
        <p class="budget-ai-result hidden" aria-live="polite"></p>
      </div>
      <div class="form-group">
        <label for="budget-total">Monthly limit</label>
        <div class="budget-money"><span class="budget-sym"></span><input type="text" inputmode="decimal" id="budget-total" autocomplete="off"></div>
      </div>
      <details class="budget-cats">
        <summary>Limits by category <span>optional</span></summary>
        <div class="budget-cat-list">${EXPENSE_CATEGORIES.map(c => `
          <label class="budget-cat"><span>${esc(c)}</span>
            <span class="budget-money"><span class="budget-sym"></span><input type="text" inputmode="decimal" data-cat="${esc(c)}" placeholder="—" autocomplete="off" aria-label="${esc(c)} limit"></span>
          </label>`).join('')}
        </div>
      </details>
      <p class="form-msg budget-msg hidden" aria-live="polite"></p>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" data-budget-clear>Remove budget</button>
        <button type="button" class="btn btn-primary btn-add" data-budget-save>Save</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => {
    if (e.target === overlay || e.target.closest('[data-budget-close]')) return closeDialog();
    if (e.target.closest('[data-budget-clear]')) { saveBudget(EMPTY()); return closeDialog(); }
    if (e.target.closest('[data-budget-save]')) save();
    if (e.target.closest('[data-budget-suggest]')) suggest();
  });
  overlay.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); closeDialog(); }
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); save(); }
  });
}

function save() {
  const total = num(overlay.querySelector('#budget-total').value);
  const cats = {};
  overlay.querySelectorAll('[data-cat]').forEach(i => { const n = num(i.value); if (n) cats[i.dataset.cat] = n; });
  const msg = overlay.querySelector('.budget-msg');
  if (overlay.querySelector('#budget-total').value.trim() && !total) {
    msg.textContent = 'Enter the monthly limit as a number, or leave it empty.';
    msg.className = 'form-msg budget-msg error';
    return;
  }
  saveBudget({ total, cats });
  closeDialog();
}

// ── Suggest from my income ──────────────────────────────────────────────────
const moneyText = n => {
  const c = window.getCurrencyInfo?.(window.getCurrency?.());
  return `${c?.symbol || '₹'} ${Math.round(n).toLocaleString(c?.locale || 'en-IN')}`;
};

async function loadRecords() {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('NOT_AUTHENTICATED');
  const get = async name => (await getDocs(query(collection(db, name), where('uid', '==', uid)))).docs.map(d => {
    const r = d.data();
    return { date: r.date || '', amount: parseFloat(r.amount) || 0, category: r.category, repeat: r.repeat || '', emiTotal: Number(r.emiTotal) || 0 };
  });
  const [expenses, income] = await Promise.all([get('expenses'), get('income')]);
  return { expenses, income, goals: getSetting('goals') || [] };
}

// Asks the AI for a plan from the facts; null when it can't be asked or its answer doesn't hold up
async function askAI(facts) {
  if (window.isOffline?.() || navigator.onLine === false) return null;
  try {
    const p = budgetPrompt(facts, window.getCurrencyInfo?.(window.getCurrency?.()) || { code: 'INR', symbol: '₹' });
    const res = await callAI({ model: AI_MODEL, messages: [{ role: 'system', content: p.system }, { role: 'user', content: p.user }], max_tokens: 400, temperature: 0.2 });
    if (!res.ok) return null;
    return checkSuggestion(readReply((await res.json()).choices?.[0]?.message?.content), facts);
  } catch (e) {
    console.warn('Budget suggestion: AI unavailable', e);
    return null;
  }
}

async function suggest() {
  const btn = overlay.querySelector('[data-budget-suggest]');
  const out = overlay.querySelector('.budget-ai-result');
  const say = (html, error = false) => { out.innerHTML = html; out.className = 'budget-ai-result' + (error ? ' error' : ''); };
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Working it out…';
  try {
    let facts;
    try { facts = budgetFacts(await loadRecords(), todayStr()); } catch (e) {
      console.error('Budget suggestion: records', e);
      return say("Couldn't read your entries. Check your connection and try again.", true);
    }
    if (!facts) return say('Add your income first: the suggestion is based on the last 3 months of it. <a href="income.html">Add income</a>', true);
    const ai = await askAI(facts);
    const s = ai || suggestFromFacts(facts);
    if (!s) return say('Not enough spending yet to suggest limits. Try again after a month of entries.', true);
    // Into the form for a look before saving
    overlay.querySelector('#budget-total').value = s.total;
    overlay.querySelectorAll('[data-cat]').forEach(i => { i.value = s.cats[i.dataset.cat] || ''; i.removeAttribute('aria-invalid'); });
    overlay.querySelector('.budget-cats').open = Object.keys(s.cats).length > 0;
    const pct = facts.income > 0 ? Math.round((s.saves / facts.income) * 100) : 0;
    const keeps = s.saves > 0
      ? `Keeps ${moneyText(s.saves)} a month (${pct}%) of your ${moneyText(facts.income)} average income.`
      : `Your bills take all of your ${moneyText(facts.income)} average income, so this only covers them.`;
    const tip = ai?.tip ? ` ${esc(ai.tip)}` : '';
    const how = ai ? '' : ' Worked out on your device.';
    say(`<strong>${esc(keeps)}</strong>${tip}${how} Change anything, then save.`);
    out.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); // the explanation, then the limits under it
  } finally {
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Suggest from my income';
  }
}

let opener = null;
export function openBudget() {
  if (!overlay) buildDialog();
  opener = document.activeElement;
  const b = getBudget();
  overlay.querySelectorAll('.budget-sym').forEach(s => { s.textContent = symbol(); });
  overlay.querySelector('#budget-total').value = b.total || '';
  overlay.querySelectorAll('[data-cat]').forEach(i => { i.value = b.cats[i.dataset.cat] || ''; });
  overlay.querySelector('.budget-cats').open = Object.keys(b.cats).length > 0;
  overlay.querySelector('.budget-msg').className = 'form-msg budget-msg hidden';
  overlay.querySelector('.budget-ai-result').className = 'budget-ai-result hidden';
  overlay.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
  document.getElementById('profile-dropdown')?.classList.add('hidden');
  setTimeout(() => overlay.querySelector('#budget-total').focus(), 50);
}

function closeDialog() {
  overlay.classList.add('hidden');
  if (opener && opener.focus) opener.focus({ preventScroll: true });
}

// Opened from Home's budget button and the Settings page
document.addEventListener('click', e => {
  if (e.target.closest('[data-open-budget]')) { e.preventDefault(); openBudget(); }
});

window.getBudget = getBudget;
window.openBudget = openBudget;
