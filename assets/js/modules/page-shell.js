// page-shell.js — What every signed-in page shares: toast, page loader, avatar, profile and
// mobile menus, sign-out and the currency picker. Used by dashboard.js, income.js and debt.js.

import { auth } from '../config/firebase.js';
import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';


export function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + (type || 'success');
  t.classList.remove('hidden');
  // Errors stay until tapped (accessibility.js); a slow reader must not lose them
  if (type !== 'error') setTimeout(() => t.classList.add('hidden'), 3000);
}

export function dismissPageLoader() {
  const loader = document.getElementById('page-loader');
  if (!loader) return;
  loader.classList.add('fade-out');
  setTimeout(() => loader.remove(), 450);
}

// Photo when the account has one, else the first letter (text only, never HTML)
export function updateUserAvatar(user) {
  const avatarEl = document.getElementById('user-avatar');
  if (!avatarEl) return;
  avatarEl.innerHTML = '';
  const initial = () => { avatarEl.textContent = (user.displayName || user.email || 'U')[0].toUpperCase(); };
  if (!user.photoURL) return initial();
  const img = document.createElement('img');
  img.src = user.photoURL;
  img.referrerPolicy = 'no-referrer';
  img.alt = 'Profile';
  img.addEventListener('error', initial);
  avatarEl.appendChild(img);
}

// Fills the currency menu; onChange redraws whatever the page shows in money
export function initCurrencySelector(onChange) {
  window.handleCurrencyChange = (code) => {
    window.setCurrency(code);
    window.updateCurrencyDisplay();
    onChange();
  };
  const sel = document.getElementById('currency-select');
  if (!sel) return;
  sel.innerHTML = window.buildCurrencyOptions(window.getCurrency());
  requestAnimationFrame(() => window.updateCurrencyDisplay()); // after lucide has drawn the icons
}

// Profile dropdown, mobile menu, page links and Logout (event-delegation.js calls these by name).
// beforeLogout clears page state; afterLogout runs once signed out.
export function installMenus({ beforeLogout = () => {}, afterLogout = () => {} } = {}) {
  window.toggleProfileMenu = (e) => {
    if (e) e.stopPropagation();
    document.getElementById('profile-dropdown')?.classList.toggle('hidden');
  };
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('profile-menu');
    const dropdown = document.getElementById('profile-dropdown');
    if (dropdown && !dropdown.classList.contains('hidden') && !menu?.contains(e.target)) dropdown.classList.add('hidden');
  });
  window.handleLogout = async () => {
    beforeLogout();
    await signOut(auth);
    afterLogout();
  };
  window.toggleMobileMenu = () => {
    const overlay = document.getElementById('mobile-menu-overlay');
    const panel = document.getElementById('mobile-menu-panel');
    if (overlay && panel) {
      overlay.classList.toggle('open');
      panel.classList.toggle('open');
    }
  };
  window.closeMobileMenu = () => {
    document.getElementById('mobile-menu-overlay')?.classList.remove('open');
    document.getElementById('mobile-menu-panel')?.classList.remove('open');
  };
}

// Pages without their own sign-in screen: show the app for a signed-in user, else go to sign-in
export function requireUser(onUser) {
  installMenus({ afterLogout: () => { window.location.href = 'index.html'; } });
  onAuthStateChanged(auth, user => {
    dismissPageLoader();
    if (!user) { window.location.href = 'index.html'; return; }
    if (!user.emailVerified && user.providerData[0]?.providerId === 'password') {
      signOut(auth);
      window.location.href = 'index.html';
      return;
    }
    document.getElementById('app').classList.remove('hidden');
    updateUserAvatar(user);
    onUser(user);
  });
}
