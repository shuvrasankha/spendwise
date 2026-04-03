// config/firebase.js — Single Firebase config for all pages
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, GoogleAuthProvider } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const firebaseConfig = {
  apiKey: "AIzaSyBKOgU4yeEhwGedRfVZfp8p0LGibfPO2hI",
  authDomain: "spendwise-app-f7227.firebaseapp.com",
  projectId: "spendwise-app-f7227",
  storageBucket: "spendwise-app-f7227.firebasestorage.app",
  messagingSenderId: "243303574314",
  appId: "1:243303574314:web:e1c66c625f814559c38c53",
  measurementId: "G-W8LZXEF75G"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const gProvider = new GoogleAuthProvider();

export { app, auth, db, gProvider };
