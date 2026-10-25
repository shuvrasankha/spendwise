// notifications.js — The bell in the header of every signed-in page: what other people shared with
// you (a split bill or a debt added with your email, and when they mark it paid), and someone saying
// a debt you shared is settled, with an unread count. Built from the debts (split.js). Which items
// were seen or cleared is kept on the device and in the account (settings.js), so clearing one on the
// laptop clears it on the phone too; seeing or clearing one also takes its push off the phone's tray.
import { auth } from '../config/firebase.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { fetchSharedDebts, fetchClaimedDebts } from './split.js';
import { onSettings, saveSettings } from './settings.js';
import { notificationsFrom, escapeHtml, shortDay, pushTagsFor, mergeIds } from '../utils/helpers.js';

const SEEN_KEY = 'spendwise_notif_seen_'; // + uid: ids of items already shown
const CLEARED_KEY = 'spendwise_notif_cleared_'; // + uid: ids cleared from the list (the debts stay)
let user = null, all = [], items = [], seen = new Set(), cleared = new Set(), wrap, btn, panel, list, badge, clearAll;

function loadIds(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key + user.uid) || '[]')); } catch { return new Set(); }
}
function saveIds(key, ids) {
  try { localStorage.setItem(key + user.uid, JSON.stringify([...ids].slice(-200))); } catch { /* private mode */ }
}

// The account's copy, a moment after the last change (Clear all is one write, not one per item)
let syncTimer = null;
function syncIds() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    saveSettings({ notif: { seen: mergeIds([], [...seen]), cleared: mergeIds([], [...cleared]) } })
      .catch(e => console.warn('Notifications sync failed:', e));
  }, 800);
}

// Push notifications still in the phone's tray for these items: gone once seen here
async function closePushes(ids) {
  const tags = pushTagsFor(ids);
  if (!tags.size || !('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    (await reg?.getNotifications() || []).filter(n => tags.has(n.tag)).forEach(n => n.close());
  } catch { /* no service worker yet */ }
}
const visible = () => { items = all.filter(i => !cleared.has(i.id)); };

function build() {
  const theme = document.getElementById('theme-btn');
  if (!theme) return false;
  wrap = document.createElement('div');
  wrap.className = 'notif-menu';
  wrap.innerHTML = `
    <button type="button" class="theme-toggle notif-btn" id="notif-btn" aria-expanded="false" aria-controls="notif-panel" aria-label="Notifications">
      <i data-lucide="bell" aria-hidden="true"></i><span class="notif-badge hidden" id="notif-badge" aria-hidden="true"></span>
    </button>
    <section class="notif-panel hidden" id="notif-panel" aria-labelledby="notif-title">
      <div class="notif-head">
        <h2 class="notif-title" id="notif-title">Notifications</h2>
        <button type="button" class="notif-clear-all" id="notif-clear-all">Clear all</button>
      </div>
      <ul class="notif-list" id="notif-list"></ul>
    </section>`;
  theme.before(wrap);
  btn = wrap.querySelector('#notif-btn');
  panel = wrap.querySelector('#notif-panel');
  list = wrap.querySelector('#notif-list');
  badge = wrap.querySelector('#notif-badge');
  clearAll = wrap.querySelector('#notif-clear-all');
  clearAll.addEventListener('click', () => clear(items.map(i => i.id)));
  list.addEventListener('click', e => {
    const x = e.target.closest('[data-notif-clear]');
    if (!x) return;
    // keep focus in the panel: on the next item's clear button, else Clear all
    const next = x.closest('li').nextElementSibling?.querySelector('[data-notif-clear]')?.dataset.notifClear;
    clear([x.dataset.notifClear]);
    (next && list.querySelector(`[data-notif-clear="${CSS.escape(next)}"]`) || clearAll).focus();
  });
  if (window.lucide) lucide.createIcons();

  panel.addEventListener('click', e => e.stopPropagation()); // a removed row isn't "outside"
  btn.addEventListener('click', e => { e.stopPropagation(); panel.classList.contains('hidden') ? open() : close(); });
  document.addEventListener('click', e => { if (!wrap.contains(e.target)) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.classList.contains('hidden')) { close(); btn.focus(); } });
  return true;
}

function updateBadge() {
  const unread = items.filter(i => !seen.has(i.id)).length;
  badge.textContent = unread > 9 ? '9+' : String(unread);
  badge.classList.toggle('hidden', !unread);
  btn.setAttribute('aria-label', unread ? `Notifications, ${unread} new` : 'Notifications');
}

function render() {
  const money = n => (window.fmt ? window.fmt(n) : String(n));
  list.innerHTML = items.length ? items.map(i => {
    const added = `${i.person} ${i.note?.startsWith('Split:') ? 'split a bill' : 'added a debt'} with you`;
    const title = i.kind === 'split' ? added
      : i.kind === 'claim' ? `${i.person} says ${money(i.amount)} was paid${i.settles ? ', all of it' : ''}`
      : `${i.person} marked ${money(i.amount)} as paid`;
    const owed = i.type === 'i-owe' ? `You owe ${money(i.amount)}` : `${i.person} owes you ${money(i.amount)}`;
    const detail = [i.kind === 'split' ? owed : i.kind === 'claim' ? 'Confirm it on Debts' : '', i.note].filter(Boolean).join(' · ');
    return `<li class="notif-item${seen.has(i.id) ? '' : ' unread'}">
      <button type="button" class="notif-clear" data-notif-clear="${escapeHtml(i.id)}" aria-label="Clear: ${escapeHtml(title)}" title="Clear"><i data-lucide="x" aria-hidden="true"></i></button>
      <a href="debt.html">
        <span class="notif-icon ${i.kind}" aria-hidden="true"><i data-lucide="${i.kind === 'split' ? 'users' : 'check'}"></i></span>
        <span class="notif-text">
          <strong>${escapeHtml(title)}</strong>
          ${detail ? `<span>${escapeHtml(detail)}</span>` : ''}
          <span class="notif-time">${escapeHtml(i.day ? shortDay(i.day) : '')}${seen.has(i.id) ? '' : '<span class="sr-only"> · new</span>'}</span>
        </span>
      </a>
    </li>`;
  }).join('') : `<li class="notif-empty">${all.length ? "You're all caught up." : 'Nothing yet. When someone splits a bill or adds a debt with your email, it shows up here.'}</li>`;
  clearAll.classList.toggle('hidden', !items.length);
  if (window.lucide) lucide.createIcons();
}

function clear(ids) {
  ids.forEach(id => { cleared.add(id); seen.add(id); });
  saveIds(CLEARED_KEY, cleared);
  saveIds(SEEN_KEY, seen);
  syncIds();
  closePushes(ids);
  visible();
  updateBadge();
  render();
}

function open() {
  render(); // unread items keep their dot while the panel is open
  const top = btn.getBoundingClientRect().bottom + 8;
  panel.style.top = `${top}px`;
  panel.style.maxHeight = `calc(100vh - ${top + 16}px)`;
  panel.classList.remove('hidden');
  btn.setAttribute('aria-expanded', 'true');
  const fresh = items.filter(i => !seen.has(i.id));
  items.forEach(i => seen.add(i.id));
  saveIds(SEEN_KEY, seen);
  if (fresh.length) syncIds();
  closePushes(items.map(i => i.id));
  updateBadge();
}

function close() {
  if (!panel || panel.classList.contains('hidden')) return;
  panel.classList.add('hidden');
  btn.setAttribute('aria-expanded', 'false');
}

async function refresh() {
  if (!user) return;
  const [shared, claimed] = await Promise.all([fetchSharedDebts(user), fetchClaimedDebts(user)]);
  all = notificationsFrom(shared, claimed);
  visible();
  updateBadge();
  if (!panel.classList.contains('hidden')) render();
}

onAuthStateChanged(auth, u => {
  user = u;
  if (!u) { wrap?.remove(); wrap = null; return; }
  if (!wrap && !build()) return;
  seen = loadIds(SEEN_KEY);
  cleared = loadIds(CLEARED_KEY);
  refresh();
});

// What other devices saw or cleared joins this device's
onSettings(s => {
  if (!user || !wrap) return;
  const n = s.notif && typeof s.notif === 'object' ? s.notif : {};
  const before = seen.size + cleared.size;
  seen = new Set(mergeIds([...seen], Array.isArray(n.seen) ? n.seen : []));
  cleared = new Set(mergeIds([...cleared], Array.isArray(n.cleared) ? n.cleared : []));
  saveIds(SEEN_KEY, seen);
  saveIds(CLEARED_KEY, cleared);
  if (seen.size + cleared.size !== before) {
    visible();
    updateBadge();
    if (!panel.classList.contains('hidden')) render();
  }
  // This device had some the account didn't: send them up
  const has = id => n.seen?.includes(id) || n.cleared?.includes(id);
  if ([...seen, ...cleared].some(id => !has(id))) syncIds();
});
// Back to the app after a while (or from tapping a push): pick up anything new
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && wrap) refresh(); });
