// goals.js — Savings goals ("Goa trip ₹30,000 by March 2027"), saved to the user's settings in
// Firestore (settings.js). Home lists them through getGoals() and redraws on 'spendwise:goals'.
// The user records what they put aside with "Add money"; the pace comes from goalPace (helpers.js).
import { todayStr } from '../utils/helpers.js';
import { getSetting, onSettings, saveSettings } from './settings.js';
import { showToast } from './page-shell.js';

const MAX_GOALS = 20; // the Firestore rule allows this many
// detail.completed: id of a goal this change just took past its target (Home celebrates it once)
const changed = completed => window.dispatchEvent(new CustomEvent('spendwise:goals', { detail: { completed } }));

export function getGoals() {
  const list = getSetting('goals');
  return Array.isArray(list)
    ? list.filter(g => g && g.id && g.name && g.target > 0 && /^\d{4}-\d{2}$/.test(g.by)).map(g => ({ ...g, saved: g.saved > 0 ? g.saved : 0 }))
    : [];
}

function saveGoals(list, completed = null) {
  saveSettings({ goals: list }).catch(e => {
    console.error('Goals save failed:', e);
    showToast("Couldn't save the goal to your account. Check your connection and try again.", 'error');
  });
  changed(completed);
}

onSettings(() => changed());

const symbol = () => (window.getCurrencyInfo?.(window.getCurrency?.())?.symbol) || '₹';
const num = v => { const n = parseFloat(String(v).replace(/[^\d.]/g, '')); return n > 0 ? Math.round(n * 100) / 100 : null; };

let overlay = null;
let editing = null; // { mode: 'edit' | 'add', goal: existing goal or null }
let opener = null;

function buildDialog() {
  overlay = document.createElement('div');
  overlay.className = 'modal-overlay budget-overlay hidden';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'goal-title');
  overlay.innerHTML = `
    <div class="modal-box budget-box">
      <div class="modal-header">
        <h3 id="goal-title"></h3>
        <button type="button" class="modal-close-btn" data-goal-close aria-label="Close"><i data-lucide="x"></i></button>
      </div>
      <div data-goal-mode="edit">
        <div class="form-group">
          <label for="goal-name">What it's for</label>
          <input type="text" id="goal-name" maxlength="40" placeholder="e.g. Goa trip" autocomplete="off">
        </div>
        <div class="form-group">
          <label for="goal-target">Amount</label>
          <div class="budget-money"><span class="budget-sym"></span><input type="text" inputmode="decimal" id="goal-target" placeholder="e.g. 30000" autocomplete="off"></div>
        </div>
        <div class="form-group">
          <label for="goal-by">By</label>
          <input type="month" id="goal-by">
        </div>
        <div class="form-group">
          <label for="goal-saved">Saved so far</label>
          <div class="budget-money"><span class="budget-sym"></span><input type="text" inputmode="decimal" id="goal-saved" placeholder="0" autocomplete="off"></div>
        </div>
      </div>
      <div data-goal-mode="add">
        <div class="form-group">
          <label for="goal-add">Amount put aside</label>
          <div class="budget-money"><span class="budget-sym"></span><input type="text" inputmode="decimal" id="goal-add" placeholder="e.g. 5000" autocomplete="off"></div>
        </div>
      </div>
      <p class="form-msg budget-msg hidden" aria-live="polite"></p>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" data-goal-delete>Delete goal</button>
        <button type="button" class="btn btn-primary btn-add" data-goal-save>Save</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => {
    if (e.target === overlay || e.target.closest('[data-goal-close]')) return closeDialog();
    if (e.target.closest('[data-goal-delete]')) return remove();
    if (e.target.closest('[data-goal-save]')) save();
  });
  overlay.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); closeDialog(); }
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); save(); }
  });
}

function fail(text) {
  const msg = overlay.querySelector('.budget-msg');
  msg.textContent = text;
  msg.className = 'form-msg budget-msg error';
}

function save() {
  const $ = id => overlay.querySelector('#' + id);
  const goals = getGoals();
  const { mode, goal } = editing;
  const wasDone = goal && goal.saved >= goal.target;
  if (mode === 'add') {
    const amount = num($('goal-add').value);
    if (!amount) return fail('Enter how much you put aside.');
    const saved = Math.round((goal.saved + amount) * 100) / 100;
    saveGoals(goals.map(g => g.id === goal.id ? { ...g, saved } : g), !wasDone && saved >= goal.target ? goal.id : null);
    return closeDialog();
  }
  const name = $('goal-name').value.trim();
  const target = num($('goal-target').value);
  const by = $('goal-by').value;
  const saved = num($('goal-saved').value) || 0;
  if (!name) return fail('Give the goal a name.');
  if (!target) return fail('Enter the amount as a number.');
  if (!/^\d{4}-\d{2}$/.test(by)) return fail('Pick the month you want to reach it by.');
  if ($('goal-saved').value.trim() && !saved) return fail('Enter what you have saved as a number, or leave it empty.');
  const next = { id: goal?.id || Date.now().toString(36), name, target, by, saved };
  saveGoals(goal ? goals.map(g => g.id === goal.id ? next : g) : [...goals, next], !wasDone && saved >= target ? next.id : null);
  closeDialog();
}

function remove() {
  if (!confirm(`Delete "${editing.goal.name}"?`)) return;
  saveGoals(getGoals().filter(g => g.id !== editing.goal.id));
  closeDialog();
}

function openDialog(mode, goal) {
  if (!overlay) buildDialog();
  if (mode === 'edit' && !goal && getGoals().length >= MAX_GOALS) {
    return showToast(`You can keep up to ${MAX_GOALS} goals. Delete one you've reached first.`, 'error');
  }
  editing = { mode, goal };
  opener = document.activeElement;
  const $ = id => overlay.querySelector('#' + id);
  overlay.querySelector('#goal-title').textContent = mode === 'add' ? `Add to ${goal.name}` : goal ? 'Edit goal' : 'New savings goal';
  overlay.querySelectorAll('[data-goal-mode]').forEach(el => el.classList.toggle('hidden', el.dataset.goalMode !== mode));
  overlay.querySelector('[data-goal-delete]').classList.toggle('hidden', mode !== 'edit' || !goal);
  overlay.querySelectorAll('.budget-sym').forEach(s => { s.textContent = symbol(); });
  $('goal-name').value = goal?.name || '';
  $('goal-target').value = goal?.target || '';
  $('goal-by').value = goal?.by || '';
  $('goal-by').min = todayStr().slice(0, 7);
  $('goal-saved').value = goal?.saved || '';
  $('goal-add').value = '';
  overlay.querySelector('.budget-msg').className = 'form-msg budget-msg hidden';
  overlay.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
  setTimeout(() => $(mode === 'add' ? 'goal-add' : 'goal-name').focus(), 50);
}

function closeDialog() {
  overlay.classList.add('hidden');
  if (opener && opener.focus) opener.focus({ preventScroll: true });
}

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-goal-new], [data-goal-add], [data-goal-edit]');
  if (!btn) return;
  e.preventDefault();
  if (btn.dataset.goalNew !== undefined) return openDialog('edit', null);
  const goal = getGoals().find(g => g.id === (btn.dataset.goalAdd ?? btn.dataset.goalEdit));
  if (goal) openDialog(btn.dataset.goalAdd !== undefined ? 'add' : 'edit', goal);
});
