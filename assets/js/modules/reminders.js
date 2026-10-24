// reminders.js — Daily "log today's spending" push reminder.
// The switch + time picker live on the Settings page (#settings-reminder); every page keeps this
// device's subscription current. The Worker stores the subscription and its cron sends the
// reminder (worker/src/push.js).

import { auth } from '../config/firebase.js';
import { callWorker, VAPID_PUBLIC_KEY } from '../config/ai.js';
import { todayStr } from '../utils/helpers.js';
import { onSettings, saveSettings } from './settings.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

const TIME_KEY = 'spendwise_reminder_time';
const LOGGED_KEY = 'spendwise_logged_ping_'; // + uid: last date we told the Worker
const SYNC_KEY = 'spendwise_push_sync:'; // + path:uid: the body the Worker last got
const DEFAULT_TIME = '21:00';

const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

let toggle, timeInput, note;

function storedTime() {
  try { return localStorage.getItem(TIME_KEY) || DEFAULT_TIME; } catch { return DEFAULT_TIME; }
}

function showNote(text) {
  note.textContent = text || '';
  note.classList.toggle('hidden', !text);
}

function urlBase64ToUint8Array(b64) {
  const s = atob((b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}

async function currentSubscription() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

// Store (or update) this device's subscription for the signed-in user
async function save(sub) {
  const res = await callWorker('/push/subscribe', {
    endpoint: sub.endpoint,
    remindAt: timeInput?.value || storedTime(),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    keys: sub.toJSON().keys, // lets this device receive "a bill was split with you" messages
  });
  if (res.status === 409) throw new Error('TOO_MANY_DEVICES'); // worker allows 10 devices per user
  if (!res.ok) throw new Error('SUBSCRIBE_FAILED');
}

async function enable() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    toggle.checked = false;
    showNote('Notifications are blocked for SpendWise. Allow them in your browser or phone settings, then turn this on again.');
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });
  await save(sub);
  if (auth.currentUser) resendSync(auth.currentUser.uid);
  showNote(`You'll get a reminder at ${timeInput.value} if you haven't added anything that day.`);
}

async function disable() {
  const sub = await currentSubscription();
  if (sub) {
    await callWorker('/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe();
  }
  showNote('');
}

async function onToggle() {
  toggle.disabled = true;
  try {
    if (toggle.checked) await enable();
    else await disable();
  } catch (e) {
    console.error('Reminder setup failed:', e);
    toggle.checked = !toggle.checked;
    showNote(e.message === 'TOO_MANY_DEVICES'
      ? 'Reminders are already on for 10 devices. Turn them off on one you no longer use, then try again.'
      : "Couldn't update the reminder. Check your connection and try again.");
  } finally {
    toggle.disabled = false;
  }
}

async function onTimeChange() {
  try { localStorage.setItem(TIME_KEY, timeInput.value); } catch { /* ignore */ }
  saveSettings({ remindAt: timeInput.value }).catch(e => console.error('Reminder time save failed:', e));
  if (!toggle.checked) return;
  try {
    const sub = await currentSubscription();
    if (sub) await save(sub);
    showNote(`You'll get a reminder at ${timeInput.value} if you haven't added anything that day.`);
  } catch {
    showNote("Couldn't change the time. Check your connection and try again.");
  }
}

function buildUI() {
  const host = document.getElementById('settings-reminder');
  if (!host || document.getElementById('reminder-toggle')) return false;
  const wrap = document.createElement('div');
  wrap.className = 'profile-reminder-wrap';
  wrap.innerHTML = `
    <div class="profile-reminder-row">
      <label class="profile-reminder-label" for="reminder-toggle">Daily reminder</label>
      <input type="checkbox" role="switch" id="reminder-toggle" class="reminder-switch">
    </div>
    <input type="time" id="reminder-time" class="profile-reminder-time" aria-label="Reminder time">
    <p id="reminder-note" class="profile-reminder-note hidden" aria-live="polite"></p>`;
  host.append(wrap);

  toggle = wrap.querySelector('#reminder-toggle');
  timeInput = wrap.querySelector('#reminder-time');
  note = wrap.querySelector('#reminder-note');
  timeInput.value = storedTime();
  return true;
}

// Reminders are on for this device: notifications allowed and a push subscription
const pushOn = async () => supported && Notification.permission === 'granted' && !!await currentSubscription();

// The account's reminder time wins over this device's; a time picked before syncing existed is uploaded once
async function syncTime(s) {
  if (!/^\d{2}:\d{2}$/.test(s.remindAt || '')) {
    let local = null;
    try { local = localStorage.getItem(TIME_KEY); } catch { /* ignore */ }
    if (local) saveSettings({ remindAt: local }).catch(() => {});
    return;
  }
  if (s.remindAt === (timeInput ? timeInput.value : storedTime())) return;
  if (timeInput) timeInput.value = s.remindAt;
  try { localStorage.setItem(TIME_KEY, s.remindAt); } catch { /* ignore */ }
  const on = toggle ? toggle.checked : await pushOn();
  const sub = on && await currentSubscription();
  if (sub) save(sub).catch(() => {});
}

async function init() {
  const ui = buildUI();
  onSettings(syncTime);
  if (!ui) {
    // Not the Settings page: just re-save on sign-in, so the device's reminders follow whoever is
    // signed in and the time zone stays current
    if (!await pushOn()) return;
    const sub = await currentSubscription();
    onAuthStateChanged(auth, user => { if (user) save(sub).catch(() => {}); });
    return;
  }

  if (isIOS && !standalone) {
    toggle.disabled = true;
    timeInput.disabled = true;
    showNote('To get reminders on iPhone, add SpendWise to your Home Screen (Share → Add to Home Screen) and open it from there.');
    return;
  }
  if (!supported) {
    toggle.disabled = true;
    timeInput.disabled = true;
    showNote("This browser doesn't support reminders.");
    return;
  }

  toggle.addEventListener('change', onToggle);
  timeInput.addEventListener('change', onTimeChange);

  const sub = await currentSubscription();
  toggle.checked = Notification.permission === 'granted' && !!sub;
  if (Notification.permission === 'denied') {
    showNote('Notifications are blocked for SpendWise. Allow them in your browser or phone settings to use reminders.');
  }

  // Re-save on sign-in: the device's reminders follow whoever is signed in, and the time zone stays current
  onAuthStateChanged(auth, user => {
    if (user && toggle.checked && sub) save(sub).catch(() => {});
  });
}

// Pages call this after saving an entry, so today's reminder is skipped on every device
window.markLoggedToday = async function () {
  const user = auth.currentUser;
  if (!user) return;
  const today = todayStr();
  const key = LOGGED_KEY + user.uid;
  try { if (localStorage.getItem(key) === today) return; } catch { /* ignore */ }
  try {
    const res = await callWorker('/push/logged', { date: today });
    if (res.ok) localStorage.setItem(key, today);
  } catch { /* offline: the sync below tries again */ }
};

// Data the Worker's crons need but can't read from Firestore. Every signed-in device sends it, so
// spending logged on a laptop without notifications still reaches the phone's alerts (the Worker
// keeps it only if some device has reminders on). Sent when the body changed since last time, one
// at a time so an older body never lands after a newer one; offline, the next redraw tries again.
let syncing = Promise.resolve();
function pushSync(path, body) {
  const user = auth.currentUser;
  if (!user) return;
  const payload = JSON.stringify(body);
  const key = SYNC_KEY + path + ':' + user.uid;
  syncing = syncing.then(async () => {
    try { if (localStorage.getItem(key) === payload) return; } catch { /* ignore */ }
    try {
      const res = await callWorker(path, body);
      if (res.ok) localStorage.setItem(key, payload);
    } catch { /* offline */ }
  });
}

// What this device sent before reminders were on may not have been kept: send it again
function resendSync(uid) {
  try {
    Object.keys(localStorage).filter(k => k.startsWith(SYNC_KEY) && k.endsWith(':' + uid)).forEach(k => localStorage.removeItem(k));
  } catch { /* ignore */ }
}
const currencySymbol = () => window.getCurrencyInfo?.(window.getCurrency?.())?.symbol;

// upcomingBills(): the Worker pushes "Netflix due tomorrow" at the reminder time
window.syncBills = bills => pushSync('/push/bills', { bills: bills.slice(0, 50), symbol: currencySymbol() });
// { 'YYYY-MM': spent } for this month and last: on the 1st the Worker pushes last month's summary
window.syncMonthTotals = totals => pushSync('/push/months', { totals, symbol: currencySymbol() });

// Entries saved offline count once they sync
window.addEventListener('spendwise:synced', () => window.markLoggedToday());

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
