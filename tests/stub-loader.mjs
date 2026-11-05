// Node loader hook: swaps the browser-only Firebase imports (offline-queue.js, settings.js) for stubs
// that forward to globalThis.__firebase, which each test sets up.
const firestore = `
export const collection = (db, coll) => ({ coll });
// doc(collectionRef) makes an auto id; doc(db, coll, id) a fixed one
export const doc = (a, coll, id) => coll === undefined
  ? { coll: a.coll, id: globalThis.__firebase.autoId ? globalThis.__firebase.autoId() : 'AUTO' }
  : { coll, id };
export const setDoc = (ref, data, opts) => globalThis.__firebase.setDoc(ref, data, opts);
export const getDoc = ref => globalThis.__firebase.getDoc ? globalThis.__firebase.getDoc(ref) : Promise.resolve({ exists: () => false, data: () => undefined });
export const runTransaction = (db, callback) => globalThis.__firebase.runTransaction(db, callback);
export const writeBatch = () => globalThis.__firebase.writeBatch();
export const serverTimestamp = () => 'SERVER_TS';
export const getDocs = async ref => globalThis.__firebase.getDocs ? globalThis.__firebase.getDocs(ref) : ({ docs: [] });
export const query = ref => ref;
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
