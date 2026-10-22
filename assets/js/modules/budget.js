// budget.js — A monthly spending limit, overall and per category, kept on this device
// (like the currency and reminder time). Home reads it through getBudget() and redraws on
// the 'spendwise:budget' event. Opened from the profile menu or Home's "Set a budget" link.
import { EXPENSE_CATEGORIES } from '../utils/helpers.js';

const KEY = 'spendwise_budget';

export function getBudget() {
  try {
    const b = JSON.parse(localStorage.getItem(KEY) || 'null');
    return b && typeof b === 'object' ? { total: b.total > 0 ? b.total : null, cats: b.cats || {} } : { total: null, cats: {} };
  } catch { return { total: null, cats: {} }; }
}

function saveBudget(b) {
  try {
    if (!b.total && !Object.keys(b.cats).length) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(b));
  } catch { /* storage blocked: the budget just won't stick */ }
  window.dispatchEvent(new CustomEvent('spendwise:budget'));
}

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
      <p class="budget-note">Saved on this device. Home shows how much of it you've used.</p>
      <div class="form-group">
        <label for="budget-total">Monthly limit</label>
        <div class="budget-money"><span class="budget-sym"></span><input type="text" inputmode="decimal" id="budget-total" placeholder="e.g. 30000" autocomplete="off"></div>
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
    if (e.target.closest('[data-budget-clear]')) { saveBudget({ total: null, cats: {} }); return closeDialog(); }
    if (e.target.closest('[data-budget-save]')) save();
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
  overlay.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
  document.getElementById('profile-dropdown')?.classList.add('hidden');
  setTimeout(() => overlay.querySelector('#budget-total').focus(), 50);
}

function closeDialog() {
  overlay.classList.add('hidden');
  if (opener && opener.focus) opener.focus({ preventScroll: true });
}

// Profile menu row, next to the currency (same place as the daily reminder)
function addMenuRow() {
  const dropdown = document.getElementById('profile-dropdown');
  if (!dropdown || dropdown.querySelector('[data-open-budget]')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-profile-action';
  btn.dataset.openBudget = '';
  btn.innerHTML = '<i data-lucide="target"></i><span>Monthly budget</span>';
  const anchor = dropdown.querySelector('.profile-currency-wrap');
  if (anchor) anchor.after(btn); else dropdown.prepend(btn);
  if (window.lucide) lucide.createIcons();
}

document.addEventListener('click', e => {
  if (e.target.closest('[data-open-budget]')) { e.preventDefault(); openBudget(); }
});

window.getBudget = getBudget;
window.openBudget = openBudget;
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addMenuRow);
else addMenuRow();
