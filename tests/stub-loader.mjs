// Node loader hook: swaps the browser-only Firebase imports in offline-queue.js for stubs
// that forward to globalThis.__firebase, which each test sets up.
const firestore = `
export const doc = (db, coll, id) => ({ coll, id });
export const setDoc = (ref, data) => globalThis.__firebase.setDoc(ref, data);
export const serverTimestamp = () => 'SERVER_TS';
`;
const config = `
export const db = {};
export const auth = {
  authStateReady: async () => {},
  get currentUser() { return globalThis.__firebase.user; },
};
`;

export async function resolve(specifier, context, next) {
  if (specifier.endsWith('/firebase-firestore.js')) {
    return { url: 'data:text/javascript,' + encodeURIComponent(firestore), shortCircuit: true };
  }
  if (specifier.endsWith('config/firebase.js')) {
    return { url: 'data:text/javascript,' + encodeURIComponent(config), shortCircuit: true };
  }
  return next(specifier, context);
}
