// settings.js — Per-user settings (monthly budget, savings goals, reminder time and switch) in Firestore at
// settings/{uid}, so they follow the user to every device. A copy per user stays in localStorage
// so pages can read a setting at once and offline (getSetting).
import { auth, db } from '../config/firebase.js';
import { doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

const CACHE_KEY = 'spendwise_settings:'; // + uid
let loaded = null; // { uid, promise }: one read per sign-in, shared by every caller

function readCache(uid) {
  try { return (uid && JSON.parse(localStorage.getItem(CACHE_KEY + uid) || 'null')) || {}; } catch { return {}; }
}

function writeCache(uid, s) {
  try { localStorage.setItem(CACHE_KEY + uid, JSON.stringify(s)); } catch { /* storage blocked: Firestore still has it */ }
}

// The signed-in user's last known value for a field (undefined when signed out or never saved)
export function getSetting(field) {
  return readCache(auth.currentUser?.uid)[field];
}

// Calls fn(settings) after each sign-in with the stored fields ({} when none are saved yet).
// Not called when the read fails (offline), so callers keep the cached copy.
export function onSettings(fn) {
  onAuthStateChanged(auth, user => {
    if (!user) return;
    if (loaded?.uid !== user.uid) {
      loaded = { uid: user.uid, promise: getDoc(doc(db, 'settings', user.uid)).then(s => {
        const data = s.data() || {};
        writeCache(user.uid, data);
        return data;
      }) };
    }
    loaded.promise.then(fn, e => console.error('Settings load failed:', e));
  });
}

// Replaces just the given fields (mergeFields, so a smaller map or list drops removed entries).
// The cached copy changes at once; the returned promise settles when Firestore has it.
export function saveSettings(fields) {
  const user = auth.currentUser;
  if (!user) return Promise.resolve();
  writeCache(user.uid, { ...readCache(user.uid), ...fields });
  loaded = null;
  return setDoc(doc(db, 'settings', user.uid), fields, { mergeFields: Object.keys(fields) });
}
