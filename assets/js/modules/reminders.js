// reminders.js — Daily "log today's spending" push reminder.
// Adds a switch + time picker to the profile menu. The Worker stores the push
// subscription and its cron sends the reminder (worker/src/push.js).

import { auth } from '../config/firebase.js';
import { callWorker, VAPID_PUBLIC_KEY } from '../config/ai.js';
import { todayStr } from '../utils/helpers.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

const TIME_KEY = 'spendwise_reminder_time';
const LOGGED_KEY = 'spendwise_logged_ping_'; // + uid: last date we told the Worker
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
    remindAt: timeInput.value || DEFAULT_TIME,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
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
    showNote("Couldn't update the reminder. Check your connection and try again.");
  } finally {
    toggle.disabled = false;
  }
}

async function onTimeChange() {
  try { localStorage.setItem(TIME_KEY, timeInput.value); } catch { /* ignore */ }
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
  const dropdown = document.getElementById('profile-dropdown');
  if (!dropdown || document.getElementById('reminder-toggle')) return false;
  const wrap = document.createElement('div');
  wrap.className = 'profile-reminder-wrap';
  wrap.innerHTML = `
    <div class="profile-reminder-row">
      <label class="profile-reminder-label" for="reminder-toggle">Daily reminder</label>
      <input type="checkbox" role="switch" id="reminder-toggle" class="reminder-switch">
    </div>
    <input type="time" id="reminder-time" class="profile-reminder-time" aria-label="Reminder time">
    <p id="reminder-note" class="profile-reminder-note hidden" aria-live="polite"></p>`;
  const anchor = dropdown.querySelector('.profile-currency-wrap');
  if (anchor) anchor.after(wrap); else dropdown.prepend(wrap);

  toggle = wrap.querySelector('#reminder-toggle');
  timeInput = wrap.querySelector('#reminder-time');
  note = wrap.querySelector('#reminder-note');
  timeInput.value = storedTime();
  return true;
}

async function init() {
  if (!buildUI()) return;

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

// Entries saved offline count once they sync
window.addEventListener('spendwise:synced', () => window.markLoggedToday());

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
