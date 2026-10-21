// Node loader hook: swaps the browser-only Firebase imports in offline-queue.js for stubs
// that forward to globalThis.__firebase, which each test sets up.
const firestore = `
export const collection = (db, coll) => ({ coll });
// doc(collectionRef) makes an auto id; doc(db, coll, id) a fixed one
export const doc = (a, coll, id) => coll === undefined ? { coll: a.coll, id: 'AUTO' } : { coll, id };
export const setDoc = (ref, data) => globalThis.__firebase.setDoc(ref, data);
export const writeBatch = () => globalThis.__firebase.writeBatch();
export const serverTimestamp = () => 'SERVER_TS';
export const getDocs = async () => ({ docs: [] });
export const query = () => ({});
export const where = () => ({});
export const addDoc = async () => ({});
`;
const authSdk = `
export const onAuthStateChanged = (auth, cb) => cb(globalThis.__firebase.user);
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
  if (specifier.endsWith('/firebase-auth.js')) {
    return { url: 'data:text/javascript,' + encodeURIComponent(authSdk), shortCircuit: true };
  }
  if (specifier.endsWith('config/firebase.js')) {
    return { url: 'data:text/javascript,' + encodeURIComponent(config), shortCircuit: true };
  }
  return next(specifier, context);
}
