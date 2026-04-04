// modules/auth.js — Authentication: login, signup, Google, logout, profile

import { auth, gProvider } from '../config/firebase.js';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, signInWithPopup, onAuthStateChanged, signOut, updateProfile, sendPasswordResetEmail, sendEmailVerification } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { friendlyErr } from '../utils/helpers.js';

let currentUser = null;

export function getCurrentUser() { return currentUser; }

export function onAuthChange(callback) {
  onAuthStateChanged(auth, user => {
    currentUser = user;
    callback(user);
  });
}

export async function handleLogin(email, pass) {
  if (!email || !pass) throw new Error("Please fill in all fields.");
  await signInWithEmailAndPassword(auth, email, pass);
}

export async function handleSignup(name, email, pass) {
  if (!name || !email || !pass) throw new Error("Please fill in all fields.");
  if (pass.length < 8) throw new Error("Password must be at least 8 characters.");
  if (!/[a-z]/.test(pass)) throw new Error("Password must contain at least one lowercase letter.");
  if (!/[A-Z]/.test(pass)) throw new Error("Password must contain at least one uppercase letter.");
  if (!/[0-9]/.test(pass)) throw new Error("Password must contain at least one number.");
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]+/.test(pass)) throw new Error("Password must contain at least one special character.");
  const cred = await createUserWithEmailAndPassword(auth, email, pass);
  await updateProfile(cred.user, { displayName: name });
  await sendEmailVerification(cred.user);
  await signOut(auth);
}

export async function handleGoogleLogin() {
  await signInWithPopup(auth, gProvider);
}

export async function handleLogout() {
  if (currentUser) {
    try { localStorage.removeItem('spendwise_expenses_' + currentUser.uid); } catch { /* ignore */ }
  }
  await signOut(auth);
}

export async function sendPasswordReset(email) {
  if (!email) throw new Error("Please enter your email.");
  await sendPasswordResetEmail(auth, email);
}

export function switchTab(tab) {
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".auth-form").forEach(f => f.classList.add("hidden"));
  document.querySelectorAll(".tab-btn")[tab === "login" ? 0 : 1].classList.add("active");
  document.getElementById(tab + "-form").classList.remove("hidden");
  document.getElementById("auth-error").classList.add("hidden");
}

export function showAuthError(msg, isSuccess = false) {
  const el = document.getElementById("auth-error");
  el.textContent = msg;
  el.classList.remove("hidden");
  if (isSuccess) el.style.color = "#10b981";
  else el.style.removeProperty('color');
}

export function toggleProfileMenu(e) {
  if (e) e.stopPropagation();
  const dropdown = document.getElementById('profile-dropdown');
  if (dropdown) dropdown.classList.toggle('hidden');
}

export function setupProfileMenu() {
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('profile-menu');
    const dropdown = document.getElementById('profile-dropdown');
    if (dropdown && !dropdown.classList.contains('hidden')) {
      if (!menu || !menu.contains(e.target)) {
        dropdown.classList.add('hidden');
      }
    }
  });
}

export function updateUserAvatar(user) {
  const avatarEl = document.getElementById("user-avatar");
  if (!avatarEl) return;
  avatarEl.innerHTML = '';
  if (user.photoURL) {
    const img = document.createElement('img');
    img.src = user.photoURL;
    img.referrerPolicy = 'no-referrer';
    img.alt = 'Profile';
    img.addEventListener('error', () => {
      avatarEl.textContent = (user.displayName || user.email || 'U')[0].toUpperCase();
    });
    avatarEl.appendChild(img);
  } else {
    avatarEl.textContent = (user.displayName || user.email || 'U')[0].toUpperCase();
  }
}

export function setGreeting() {
  const h = new Date().getHours();
  const g = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  const n = currentUser && currentUser.displayName ? currentUser.displayName.split(" ")[0] : "";
  const el = document.getElementById("dashboard-greeting") || document.getElementById("income-greeting");
  if (el) el.textContent = g + (n ? ", " + n : "") + "!";
}
