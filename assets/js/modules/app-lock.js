// app-lock.js — Optional lock screen opened with the phone's fingerprint, face or screen lock (WebAuthn).
// A privacy screen for this device: the phone checks who you are, nothing is sent anywhere, and
// Firebase sign-in is still what protects the data. Loaded in <head>, before anything is painted,
// so a locked app never flashes its numbers.
(function () {
  'use strict';

  const KEY = 'spendwise_lock';              // { id } of the credential made on this device
  const UNLOCKED = 'spendwise_unlocked';     // sessionStorage: unlocked in this app session
  const AWAY = 'spendwise_away_at';          // sessionStorage: when the app was last hidden
  const AWAY_MS = 5 * 60 * 1000;             // back after 5 minutes away: lock again

  const supported = !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);
  const root = document.documentElement;

  const store = {
    get: (s, k) => { try { return s.getItem(k); } catch { return null; } },
    set: (s, k, v) => { try { s.setItem(k, v); } catch { /* ignore */ } },
    del: (s, k) => { try { s.removeItem(k); } catch { /* ignore */ } }
  };
  const credential = () => { try { return JSON.parse(store.get(localStorage, KEY) || 'null'); } catch { return null; } };

  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const random = n => crypto.getRandomValues(new Uint8Array(n));

  function shouldLock() {
    if (!supported || !credential()) return false;
    if (store.get(sessionStorage, UNLOCKED) !== '1') return true;
    const away = Number(store.get(sessionStorage, AWAY) || 0);
    return away > 0 && Date.now() - away > AWAY_MS;
  }

  // Hide the page from the first paint (CSS: .sw-locked)
  if (shouldLock()) root.classList.add('sw-locked');

  // The phone asks for fingerprint, face or screen lock; resolves true when it says yes
  async function verify() {
    const cred = credential();
    if (!cred) return true;
    try {
      await navigator.credentials.get({ publicKey: {
        challenge: random(32), timeout: 60000, userVerification: 'required',
        allowCredentials: [{ type: 'public-key', id: unb64(cred.id) }]
      } });
      return true;
    } catch { return false; }
  }

  function markUnlocked() {
    store.set(sessionStorage, UNLOCKED, '1');
    store.del(sessionStorage, AWAY);
  }

  // ── Lock screen ──────────────────────────────────────────────────────────
  let layer = null;
  function showLock() {
    root.classList.add('sw-locked');
    if (layer || !document.body) return;
    layer = document.createElement('div');
    layer.className = 'sw-lock-layer';
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-modal', 'true');
    layer.setAttribute('aria-labelledby', 'sw-lock-title');
    layer.innerHTML = `
      <div class="sw-lock-card">
        <img src="assets/images/logo-192.png" alt="" class="sw-lock-coin" width="72" height="72">
        <h1 id="sw-lock-title">SpendWise is locked</h1>
        <p>Use your fingerprint, face or screen lock to open it.</p>
        <button type="button" class="btn-primary btn-add sw-lock-unlock">Unlock</button>
        <p class="sw-lock-msg" aria-live="polite"></p>
        <button type="button" class="sw-lock-signout">Can't unlock? Sign out</button>
      </div>`;
    document.body.appendChild(layer);
    layer.querySelector('.sw-lock-unlock').addEventListener('click', tryUnlock);
    layer.querySelector('.sw-lock-signout').addEventListener('click', signOutInstead);
    layer.querySelector('.sw-lock-unlock').focus();
    tryUnlock(); // some browsers need the tap above; others open the prompt straight away
  }

  let busy = false;
  async function tryUnlock() {
    if (busy || !layer) return;
    busy = true;
    const ok = await verify();
    busy = false;
    if (ok) {
      markUnlocked();
      root.classList.remove('sw-locked');
      layer?.remove();
      layer = null;
    } else if (layer) {
      layer.querySelector('.sw-lock-msg').textContent = 'Not unlocked. Tap Unlock to try again.';
    }
  }

  // Signing out needs your password again, so it is a safe way past a lock you can't open
  async function signOutInstead() {
    store.del(localStorage, KEY);
    if (typeof window.handleLogout !== 'function') return;
    try { await window.handleLogout(); } catch { /* the auth screen or redirect still follows */ }
    root.classList.remove('sw-locked');
    layer?.remove();
    layer = null;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') store.set(sessionStorage, AWAY, String(Date.now()));
    else if (shouldLock()) showLock();
    else store.del(sessionStorage, AWAY);
  });

  // ── Switch on the Settings page (#settings-lock) ─────────────────────────
  async function addSwitch() {
    const host = document.getElementById('settings-lock');
    if (!host || document.getElementById('lock-toggle')) return;
    let available = supported;
    try { available = available && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch { available = false; }
    if (!available) {
      host.innerHTML = '<p class="profile-reminder-note">App lock needs a fingerprint, face or screen lock, which this device or browser doesn\'t offer.</p>';
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'profile-reminder-wrap';
    wrap.innerHTML = `
      <div class="profile-reminder-row">
        <label class="profile-reminder-label" for="lock-toggle">App lock</label>
        <input type="checkbox" role="switch" id="lock-toggle" class="reminder-switch">
      </div>
      <p class="profile-reminder-note">Asks for your fingerprint, face or screen lock when SpendWise opens. This device only.</p>`;
    host.append(wrap);
    const toggle = wrap.querySelector('#lock-toggle');
    const note = wrap.querySelector('.profile-reminder-note');
    toggle.checked = !!credential();
    toggle.addEventListener('change', async () => {
      toggle.disabled = true;
      if (toggle.checked) {
        try {
          const made = await navigator.credentials.create({ publicKey: {
            challenge: random(32), timeout: 60000, attestation: 'none',
            rp: { name: 'SpendWise', id: location.hostname },
            user: { id: random(16), name: 'SpendWise', displayName: 'SpendWise' },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
            authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' }
          } });
          store.set(localStorage, KEY, JSON.stringify({ id: b64(made.rawId) }));
          markUnlocked();
          note.textContent = 'On. SpendWise will ask when it opens, and after 5 minutes away.';
        } catch {
          toggle.checked = false;
          note.textContent = "App lock wasn't turned on. Try again, or check your phone's screen lock is set.";
        }
      } else if (await verify()) {
        store.del(localStorage, KEY);
        note.textContent = 'Off. SpendWise opens without asking.';
      } else {
        toggle.checked = true; // turning it off needs the same check as opening the app
      }
      toggle.disabled = false;
    });
  }

  function init() {
    // Moving between pages takes milliseconds, well under AWAY_MS, so it never locks
    if (root.classList.contains('sw-locked')) showLock();
    else store.del(sessionStorage, AWAY);
    addSwitch();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
