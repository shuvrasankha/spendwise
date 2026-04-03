// utils/helpers.js — Shared utility functions

export function pad(n) { return String(n).padStart(2, '0'); }

export function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
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

// Friendly error messages for Firebase auth codes
export function friendlyErr(code) {
  const m = {
    "auth/user-not-found": "No account with this email.",
    "auth/wrong-password": "Incorrect password.",
    "auth/email-already-in-use": "Email already registered.",
    "auth/invalid-email": "Invalid email.",
    "auth/weak-password": "Password too short.",
    "auth/popup-closed-by-user": "Sign-in cancelled.",
    "auth/invalid-credential": "Invalid email or password."
  };
  return m[code] || "Something went wrong. Try again.";
}
