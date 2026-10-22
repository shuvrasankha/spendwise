// utils/helpers.js — Shared utility functions

export function pad(n) { return String(n).padStart(2, '0'); }

// Local-calendar YYYY-MM-DD. Never use toISOString() for this: it is UTC,
// so in India (UTC+5:30) local midnight becomes the previous day.
export function todayStr(d = new Date()) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// Money put into Investment is saved, not spent: every spending total, chart and projection leaves it out
export const isSpending = e => e.category !== 'Investment';

// "21 Oct", or "21 Oct 2025" outside the current year: short enough for a list row
export function shortDay(ds) {
  const d = new Date(ds + 'T00:00:00');
  const opts = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-IN', opts);
}

// Today / Yesterday buttons ([data-date-offset] inside `scope`) that set and mirror a date input
export function bindDateChips(input, scope = document) {
  const chips = [...scope.querySelectorAll('[data-date-offset]')];
  const sync = () => chips.forEach(chip => {
    const d = new Date(); d.setDate(d.getDate() - Number(chip.dataset.dateOffset));
    const on = input.value === todayStr(d);
    chip.classList.toggle('active', on);
    chip.setAttribute('aria-pressed', String(on));
  });
  chips.forEach(chip => chip.addEventListener('click', () => {
    const d = new Date(); d.setDate(d.getDate() - Number(chip.dataset.dateOffset));
    input.value = todayStr(d);
    sync();
  }));
  input.addEventListener('change', sync);
  sync();
  return sync; // call after setting the date in code
}

export function getWeekStart() {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const m = new Date(d.setDate(diff));
  return m.getFullYear() + '-' + pad(m.getMonth() + 1) + '-' + pad(m.getDate());
}

export function formatDate(ds) {
  return new Date(ds + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// escapeHtml: neutralises XSS — always call before injecting user text into innerHTML
export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// dec: legacy migration decoder only
// NOTE: XOR key removed for security. Legacy encoded data returned as-is.
export function dec(encoded) {
  if (typeof encoded !== "string") return encoded;
  // No longer decode XOR — return as-is for migration purposes
  return encoded;
}

// Abbreviated currency for chart Y-axis
export function fmtTick(value) {
  return window.fmtCompact ? window.fmtCompact(value) : value;
}

// Sanitize user input before storing in Firestore
// Strips control characters, enforces max length
export function sanitize(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  // Remove control characters except newlines and tabs
  let clean = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  // Truncate to max length
  if (clean.length > maxLen) clean = clean.substring(0, maxLen);
  return clean.trim();
}

// Friendly error messages for Firebase auth codes: say what happened and what to do next
export function friendlyErr(code) {
  const m = {
    "auth/user-not-found": "No account uses this email. Check it, or sign up.",
    "auth/wrong-password": "That password isn't right. Try again, or reset it.",
    "auth/invalid-credential": "Email or password isn't right. Try again, or reset your password.",
    "auth/email-already-in-use": "This email already has an account. Log in instead.",
    "auth/invalid-email": "Enter an email like name@example.com.",
    "auth/weak-password": "Choose a password with at least 8 characters.",
    "auth/popup-closed-by-user": "Google sign-in was closed before it finished.",
    "auth/network-request-failed": "No connection. Check your internet and try again.",
    "auth/too-many-requests": "Too many attempts. Wait a minute, then try again.",
    "auth/user-disabled": "This account has been disabled."
  };
  return m[code] || "That didn't work. Check your connection and try again.";
}
