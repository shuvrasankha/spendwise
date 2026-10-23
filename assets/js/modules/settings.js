// settings.js — Per-user settings (monthly budget, reminder time) in Firestore at settings/{uid},
// so they follow the user to every device. Callers keep a localStorage copy for instant, offline reads.
import { auth, db } from '../config/firebase.js';
import { doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

let loaded = null; // { uid, promise }: one read per sign-in, shared by every caller

// Calls fn(settings) after each sign-in with the stored fields ({} when none are saved yet).
// Not called when the read fails (offline), so callers keep their local copy.
export function onSettings(fn) {
  onAuthStateChanged(auth, user => {
    if (!user) return;
    if (loaded?.uid !== user.uid) loaded = { uid: user.uid, promise: getDoc(doc(db, 'settings', user.uid)).then(s => s.data() || {}) };
    loaded.promise.then(fn, e => console.error('Settings load failed:', e));
  });
}

// Replaces just the given fields (mergeFields, so a smaller budget map drops removed categories)
export function saveSettings(fields) {
  const user = auth.currentUser;
  if (!user) return Promise.resolve();
  loaded = null;
  return setDoc(doc(db, 'settings', user.uid), fields, { mergeFields: Object.keys(fields) });
}
