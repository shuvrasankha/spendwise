// SpendWise app.js - Firebase Modular SDK

import { auth, gProvider, db } from './config/firebase.js';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, signInWithPopup, onAuthStateChanged, signOut, updateProfile, sendPasswordResetEmail, sendEmailVerification } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { collection, addDoc, getDocs, deleteDoc, doc, query, where, serverTimestamp, updateDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// Currency helpers from global scope (currency.js loads before this module)
const fmt = window.fmt;
const fmtCompact = window.fmtCompact;
const getCurrency = window.getCurrency;
const getCurrencyInfo = window.getCurrencyInfo;
const buildCurrencyOptions = window.buildCurrencyOptions;
const updateCurrencyDisplay = window.updateCurrencyDisplay;
const setCurrency = window.setCurrency;

// Sanitize helper from utils
import { sanitize } from './utils/helpers.js';

// Firebase Web API keys are safe to be public — Firebase explicitly documents this.
// Security is enforced by Firebase Auth (only authenticated users can read/write)
// and Firestore Security Rules (uid-scoped data access).
// To further restrict this key: Firebase Console → Project Settings → API key restrictions
// → add your production domain (e.g. yourapp.netlify.app) under "Application restrictions".


// ── Security helpers ────────────────────────────────────────────────────────

// escapeHtml: neutralises XSS — always call this before injecting any
// user-supplied text into innerHTML.
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// dec: legacy migration decoder only.
// Old Firestore records were stored with a XOR+base64 scheme.
// Numbers (new-format records) need no decoding — return them directly.
// NOTE: The XOR key has been removed for security. Legacy encoded data
// will be returned as-is (base64 string). Migrate any remaining legacy
// records to plain format via the Firebase console.
function dec(encoded) {
  if (typeof encoded !== "string") return encoded;  // plain number
  // No longer decode XOR — return as-is for migration purposes
  return encoded;
}

// ── sessionStorage cache helpers ──────────────────────────────────────────────
// Using sessionStorage instead of localStorage for financial data security.
// Session storage is cleared when the browser tab is closed, reducing the
// window of exposure if an XSS vulnerability is exploited.
const CACHE_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

function getCacheKey(uid) { return 'spendwise_expenses_' + uid; }

function saveToCache(uid, expenses) {
  try {
    const payload = JSON.stringify({ ts: Date.now(), data: expenses });
    sessionStorage.setItem(getCacheKey(uid), payload);
  } catch (e) { /* quota exceeded or private mode — silently skip */ }
}

function loadFromCache(uid) {
  try {
    const raw = sessionStorage.getItem(getCacheKey(uid));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.ts > CACHE_MAX_AGE_MS) {
      sessionStorage.removeItem(getCacheKey(uid));
      return null;
    }
    return parsed.data;
  } catch { return null; }
}

function clearCache(uid) {
  try { sessionStorage.removeItem(getCacheKey(uid)); } catch { /* ignore */ }
}

let currentUser = null, allExpenses = [], allIncome = [], allDebts = [], activeTab = "daily", deleteTarget = null, filteredExpenses = null, chartInstance = null, editingExpenseId = null;

// ── Page loader ─────────────────────────────────────────────────────────────
function dismissPageLoader() {
  const loader = document.getElementById('page-loader');
  if (!loader) return;
  loader.classList.add('fade-out');
  setTimeout(() => loader.remove(), 450);
}

// ── Avatar helper (XSS-safe) ────────────────────────────────────────────────
function updateUserAvatar(user) {
  const avatarEl = document.getElementById("user-avatar");
  if (!avatarEl) return;
  // Clear previous content
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

// ── Card shimmer ─────────────────────────────────────────────────────────────
function showLoader() {
  const cardsContainer = document.querySelector(".summary-cards");
  if (cardsContainer) cardsContainer.classList.add("loading");
}

function hideLoader() {
  const cardsContainer = document.querySelector(".summary-cards");
  if (cardsContainer) cardsContainer.classList.remove("loading");
}

// ── Table skeleton rows ───────────────────────────────────────────────────────
function showTableSkeleton(tbodyId, cols) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  const rows = Array.from({ length: 4 }, () =>
    `<tr class="skeleton-row">${Array.from({ length: cols }, (_, i) =>
      `<td><span class="skeleton-cell" style="width:${[70, 90, 110, 80, 60, 50, 40][i % 7]}px"></span></td>`
    ).join('')}</tr>`
  ).join('');
  tbody.innerHTML = rows;
}

onAuthStateChanged(auth, user => {
  dismissPageLoader();
  if (user) {
    if (!user.emailVerified) {
      signOut(auth);
      showAuthError("Please verify your email before logging in.");
      return;
    }
    currentUser = user;
    document.getElementById("auth-screen").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");
    updateUserAvatar(user);

    setGreeting();
    initCurrencySelector();

    // ── Cache-first strategy ──
    const cached = loadFromCache(user.uid);
    if (cached && cached.length) {
      // Render from cache instantly — no skeleton delay
      allExpenses = cached;
      // Only update elements that exist on this page
      if (document.getElementById("sum-monthly")) {
        updateCards();
        renderDashboardTable();
        populateYearPicker();
        initPeriodPicker();
        updatePeriodSummary();
        requestAnimationFrame(() => { renderPieChart(); renderTrendChart(); });
      }
      if (document.getElementById("history-body")) {
        renderHistory();
      }
      // Silently sync with Firestore in the background
      setTimeout(() => loadExpenses(true), 0);
    } else {
      // No cache — show skeleton and fetch from Firestore
      if (document.getElementById("table-body")) showTableSkeleton("table-body", 5);
      if (document.getElementById("history-body")) showTableSkeleton("history-body", 7);
      setTimeout(() => loadExpenses(), 0);
    }
    // Load income data for dashboard cards (always fresh)
    setTimeout(() => loadIncome(), 0);
    // Load debt data for dashboard cards
    setTimeout(() => loadDebts(), 0);

    // Handle hash-based routing (e.g. index.html#history)
    const pageHash = window.location.hash.replace('#', '');
    if (pageHash && ['dashboard', 'add', 'history', 'insights'].includes(pageHash)) {
      showPage(pageHash);
    }
  } else {
    currentUser = null;
    // If this page has an auth screen, show it. Otherwise redirect to index.html
    const authScreen = document.getElementById("auth-screen");
    if (authScreen) {
      authScreen.classList.remove("hidden");
      document.getElementById("app").classList.add("hidden");
    } else {
      window.location.href = "index.html";
    }
  }
});

window.switchTab = (tab) => {
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".auth-form").forEach(f => f.classList.add("hidden"));
  document.querySelectorAll(".tab-btn")[tab === "login" ? 0 : 1].classList.add("active");
  document.getElementById(tab + "-form").classList.remove("hidden");
  document.getElementById("auth-error").classList.add("hidden");
};

window.handleLogin = async () => {
  const email = document.getElementById("login-email").value.trim();
  const pass = document.getElementById("login-password").value;
  if (!email || !pass) { showAuthError("Please fill in all fields."); return; }
  try { await signInWithEmailAndPassword(auth, email, pass); }
  catch (e) { showAuthError(friendlyErr(e.code)); }
};

window.handleSignup = async () => {
  const name = document.getElementById("signup-name").value.trim();
  const email = document.getElementById("signup-email").value.trim();
  const pass = document.getElementById("signup-password").value;
  if (!name || !email || !pass) { showAuthError("Please fill in all fields."); return; }
  if (pass.length < 8) { showAuthError("Password must be at least 8 characters."); return; }
  if (!/[a-z]/.test(pass)) { showAuthError("Password must contain at least one lowercase letter."); return; }
  if (!/[A-Z]/.test(pass)) { showAuthError("Password must contain at least one uppercase letter."); return; }
  if (!/[0-9]/.test(pass)) { showAuthError("Password must contain at least one number."); return; }
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]+/.test(pass)) { showAuthError("Password must contain at least one special character."); return; }
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
    await updateProfile(cred.user, { displayName: name });
    await sendEmailVerification(cred.user);
    await signOut(auth);
    switchTab('login');
    showAuthError("Account created! Please check your email to verify.", true);
  }
  catch (e) { showAuthError(friendlyErr(e.code)); }
};

window.handleGoogleLogin = async () => {
  try { await signInWithPopup(auth, gProvider); }
  catch (e) { showAuthError(friendlyErr(e.code)); }
};

window.handleLogout = async () => { if (currentUser) clearCache(currentUser.uid); await signOut(auth); allExpenses = []; };

// ── Mobile Menu ──────────────────────────────────────────────────────────────
window.toggleMobileMenu = () => {
  const overlay = document.getElementById('mobile-menu-overlay');
  const panel = document.getElementById('mobile-menu-panel');
  if (overlay && panel) {
    overlay.classList.toggle('open');
    panel.classList.toggle('open');
  }
};

window.closeMobileMenu = () => {
  const overlay = document.getElementById('mobile-menu-overlay');
  const panel = document.getElementById('mobile-menu-panel');
  if (overlay) overlay.classList.remove('open');
  if (panel) panel.classList.remove('open');
};

window.navigateTo = (url) => {
  closeMobileMenu();
  // Only allow navigation to known internal pages
  const allowed = ['index.html', 'expense.html', 'income.html', 'history.html', 'debt.html', 'insights.html'];
  const clean = url.split('#')[0].split('?')[0];
  if (allowed.includes(clean)) {
    window.location.href = url;
  }
};

window.toggleProfileMenu = (e) => {
  if (e) e.stopPropagation();
  const dropdown = document.getElementById('profile-dropdown');
  if (dropdown) dropdown.classList.toggle('hidden');
};

document.addEventListener('click', (e) => {
  const menu = document.getElementById('profile-menu');
  const dropdown = document.getElementById('profile-dropdown');
  if (dropdown && !dropdown.classList.contains('hidden')) {
    if (!menu || !menu.contains(e.target)) {
      dropdown.classList.add('hidden');
    }
  }
});

function showAuthError(msg, isSuccess = false) {
  const el = document.getElementById("auth-error");
  el.textContent = msg;
  el.classList.remove("hidden");
  if (isSuccess) el.style.color = "#10b981";
  else el.style.removeProperty('color');
}

function friendlyErr(code) {
  const m = { "auth/user-not-found": "No account with this email.", "auth/wrong-password": "Incorrect password.", "auth/email-already-in-use": "Email already registered.", "auth/invalid-email": "Invalid email.", "auth/weak-password": "Password too short.", "auth/popup-closed-by-user": "Sign-in cancelled.", "auth/invalid-credential": "Invalid email or password." };
  return m[code] || "Something went wrong. Try again.";
}

window.showPage = (page) => {
  const pageEl = document.getElementById("page-" + page);
  if (!pageEl) return; // Page doesn't exist on this HTML file
  document.querySelectorAll(".page").forEach(p => p.classList.add("hidden"));
  document.querySelectorAll(".sidebar-btn, .bottom-nav-btn").forEach(b => b.classList.remove("active"));
  pageEl.classList.remove("hidden");
  const sBtn = document.getElementById("snav-" + page); if (sBtn) sBtn.classList.add("active");
  const bBtn = document.getElementById("bnav-" + page); if (bBtn) bBtn.classList.add("active");

  // Voice FAB: only visible on the "add expense" page
  const voiceFab = document.getElementById('voice-fab');
  if (voiceFab) voiceFab.style.display = (page === 'add') ? '' : 'none';

  if (page === "dashboard") {
    renderDashboardTable();
    // Defer chart rendering to avoid blocking UI interactions
    requestAnimationFrame(() => {
      renderPieChart();
      renderTrendChart();
    });
  }
  if (page === "history") {
    renderHistory();
    renderIncomeHistory();
  }
  if (page === "add") { const d = document.getElementById("exp-date"); if (!d.value) d.value = todayStr(); }
};

async function loadExpenses(isSilentSync = false) {
  if (!currentUser) return;
  if (!isSilentSync) showLoader();
  try {
    const q = query(collection(db, "expenses"), where("uid", "==", currentUser.uid));
    const snap = await getDocs(q);
    allExpenses = snap.docs.map(d => {
      const raw = d.data();
      // Detect plain-text records: if amount is a number or a numeric string,
      // the record was NEVER XOR-encoded (legacy amounts are base64 gibberish).
      const isPlain = raw.encoding === "plain"
        || typeof raw.amount === "number"
        || !isNaN(parseFloat(raw.amount));
      const amt = isPlain ? parseFloat(raw.amount) : parseFloat(dec(raw.amount));
      return {
        id: d.id, ...raw,
        amount: isNaN(amt) ? 0 : amt,
        cardName: raw.cardName || "",
        description: isPlain ? (raw.description || "") : dec(raw.description),
        notes: isPlain ? (raw.notes || "") : dec(raw.notes || "")
      };
    });
    // Sort client-side — no Firestore index required
    allExpenses.sort((a, b) => b.date.localeCompare(a.date));

    // Save to localStorage cache
    saveToCache(currentUser.uid, allExpenses);

    // Render lightweight content immediately — only if elements exist
    if (document.getElementById("sum-monthly")) {
      updateCards();
      renderDashboardTable();
      populateYearPicker();
      initPeriodPicker();
      updatePeriodSummary();
    }
    if (document.getElementById("history-body")) {
      renderHistory();
    }
    // Update expense summary cards (expense page)
    if (document.getElementById("exp-monthly")) {
      updateExpenseCards();
    }

    // Defer chart rendering to next frame to avoid blocking
    requestAnimationFrame(() => {
      renderPieChart();
      renderTrendChart();
      hideLoader();
    });
  } catch (e) { console.error(e); if (!isSilentSync) showToast("Error loading data.", "error"); hideLoader(); }
}

// ── Load Income (for dashboard cards) ────────────────────────────────────────
async function loadIncome() {
  if (!currentUser) return;
  try {
    const q = query(collection(db, "income"), where("uid", "==", currentUser.uid));
    const snap = await getDocs(q);
    allIncome = snap.docs.map(d => {
      const raw = d.data();
      const amt = parseFloat(raw.amount);
      return { id: d.id, ...raw, amount: isNaN(amt) ? 0 : amt };
    });
    allIncome.sort((a, b) => b.date.localeCompare(a.date));
    updateIncomeCards();
    // If on history page, render income history
    if (document.getElementById("inc-history-body")) {
      renderIncomeHistory();
    }
  } catch (e) { console.error("Income load error:", e); }
}

// ── Load Debts ───────────────────────────────────────────────────────────────
async function loadDebts() {
  if (!currentUser) return;
  try {
    const q = query(collection(db, "debts"), where("uid", "==", currentUser.uid));
    const snap = await getDocs(q);
    allDebts = snap.docs.map(d => {
      const raw = d.data();
      const amt = parseFloat(raw.amount);
      return {
        id: d.id,
        ...raw,
        amount: isNaN(amt) ? 0 : amt,
        settled: raw.settled === true || raw.settled === "true" || raw.settled === 1,
        settledDate: raw.settledDate || '',
      };
    });
    allDebts.sort((a, b) => b.date.localeCompare(a.date));
    updateDebtCards();
  } catch (e) { console.error("Debt load error:", e); }
}

// ── Update Debt Cards ────────────────────────────────────────────────────────
function updateDebtCards() {
  if (!document.getElementById("sum-debt")) {
    console.warn('sum-debt element not found');
    return;
  }

  const activeDebts = allDebts.filter(d => !d.settled);
  const totalDebt = activeDebts.reduce((s, d) => s + d.amount, 0);
  
  document.getElementById("sum-debt").textContent = fmt(totalDebt);
  document.getElementById("sum-debt-count").textContent = activeDebts.length + " active debt" + (activeDebts.length !== 1 ? "s" : "");
}

function updateIncomeCards() {
  if (!document.getElementById("sum-income")) return;
  const incomeEl = document.getElementById("sum-income");
  const savingsEl = document.getElementById("sum-savings");
  const savingsCard = document.getElementById("card-savings");
  if (!incomeEl || !savingsEl) return;

  const now = new Date();
  const ms = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-01";
  const today = todayStr();

  const monthlyIncome = allIncome
    .filter(i => i.date >= ms && i.date <= today)
    .reduce((s, i) => s + i.amount, 0);

  const monthlyExpenses = allExpenses
    .filter(e => e.date >= ms && e.date <= today)
    .reduce((s, e) => s + e.amount, 0);

  const netSavings = monthlyIncome - monthlyExpenses;

  incomeEl.textContent = fmt(monthlyIncome);
  document.getElementById("sum-income-sub").textContent = monthlyIncome > 0 
    ? allIncome.filter(i => i.date >= ms && i.date <= today).length + " entries this month"
    : "0 entries this month";

  savingsEl.textContent = fmt(Math.abs(netSavings));
  // Color the savings card based on positive/negative
  if (savingsCard) {
    savingsCard.classList.remove("savings-negative");
    if (netSavings < 0) savingsCard.classList.add("savings-negative");
  }
  const savingsSubEl = document.getElementById("sum-savings-sub");
  if (savingsSubEl) {
    savingsSubEl.textContent = netSavings < 0
      ? "Overspent this month"
      : "Income − Expenses (this month)";
  }
}

// ── Update Expense Summary Cards (expense page) ─────────────────────────────
function updateExpenseCards() {
  const monthlyEl = document.getElementById("exp-monthly");
  const yearlyEl = document.getElementById("exp-yearly");
  const totalEl = document.getElementById("exp-total");
  const dailyAvgEl = document.getElementById("exp-daily-avg");
  
  if (!monthlyEl && !yearlyEl && !totalEl && !dailyAvgEl) return;
  
  const now = new Date();
  const thisMonth = now.getMonth() + 1;
  const thisYear = now.getFullYear();
  const ms = thisYear + "-" + pad(thisMonth) + "-01";
  const yearStr = String(thisYear);
  
  // This month
  const monthlyExpenses = allExpenses.filter(e => e.date >= ms && e.date <= todayStr());
  const monthTotal = monthlyExpenses.reduce((s, e) => s + e.amount, 0);
  
  if (monthlyEl) monthlyEl.textContent = fmt(monthTotal);
  const monthCountEl = document.getElementById("exp-monthly-count");
  if (monthCountEl) monthCountEl.textContent = monthlyExpenses.length + ' entr' + (monthlyExpenses.length !== 1 ? 'ies' : 'y');
  
  // This year
  const yearlyExpenses = allExpenses.filter(e => e.date && e.date.startsWith(yearStr));
  const yearTotal = yearlyExpenses.reduce((s, e) => s + e.amount, 0);
  
  if (yearlyEl) yearlyEl.textContent = fmt(yearTotal);
  const yearCountEl = document.getElementById("exp-yearly-count");
  if (yearCountEl) yearCountEl.textContent = yearlyExpenses.length + ' entr' + (yearlyExpenses.length !== 1 ? 'ies' : 'y');
  
  // Total
  const totalAmount = allExpenses.reduce((s, e) => s + e.amount, 0);
  if (totalEl) totalEl.textContent = fmt(totalAmount);
  const totalCountEl = document.getElementById("exp-total-count");
  if (totalCountEl) totalCountEl.textContent = allExpenses.length + ' entr' + (allExpenses.length !== 1 ? 'ies' : 'y');
  
  // Daily average
  const today = new Date();
  const dayOfMonth = today.getDate();
  const dailyAvg = dayOfMonth > 0 ? monthTotal / dayOfMonth : 0;
  if (dailyAvgEl) dailyAvgEl.textContent = fmt(dailyAvg);
  const dailySubEl = document.getElementById("exp-daily-sub");
  if (dailySubEl) dailySubEl.textContent = `avg / day this month`;
}

window.addExpense = async () => {
  const amount = parseFloat(document.getElementById("exp-amount").value);
  const category = document.getElementById("exp-category").value;
  const date = document.getElementById("exp-date").value;
  const payment = document.getElementById("exp-payment").value;
  const description = sanitize(document.getElementById("exp-description").value.trim(), 300);
  const notes = sanitize(document.getElementById("exp-notes").value.trim(), 500);
  const tags = getExpenseTags("exp");
  if (!amount || amount <= 0) { showFormMsg("Enter a valid amount.", "error"); return; }
  if (!category) { showFormMsg("Select a category.", "error"); return; }
  if (!date) { showFormMsg("Select a date.", "error"); return; }
  try {
    showLoader();
    const cardName = sanitize(document.getElementById("exp-card-name") ? document.getElementById("exp-card-name").value.trim() : "", 100);
    const ref = await addDoc(collection(db, "expenses"), { uid: currentUser.uid, amount, category, date, payment, cardName: cardName || "", description: description || "-", notes, tags, encoding: "plain", createdAt: serverTimestamp() });
    allExpenses.unshift({ id: ref.id, amount, category, date, payment, cardName: cardName || "", description: description || "-", notes, tags });
    allExpenses.sort((a, b) => b.date.localeCompare(a.date));
    dashboardPage = 1;
    updateCards();
    renderDashboardTable();
    renderHistory();
    updateExpenseCards();
    // Defer chart rendering
    requestAnimationFrame(() => {
      renderPieChart();
      renderTrendChart();
      hideLoader();
    });
    // Update localStorage cache
    saveToCache(currentUser.uid, allExpenses);
    resetForm();
    showFormMsg("Expense added successfully!", "success");
    showToast("Expense added!", "success");
  } catch (e) { console.error(e); showFormMsg("Failed to save. Check Firebase config.", "error"); hideLoader(); }
};

window.resetForm = () => {
  ["exp-amount", "exp-description", "exp-notes", "exp-card-name", "exp-tags"].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = "";
  });
  document.getElementById("exp-category").value = "";
  document.getElementById("exp-payment").value = "UPI";
  const wrap = document.getElementById("exp-card-name-wrap");
  if (wrap) wrap.style.display = "none";
  document.getElementById("exp-date").value = todayStr();
  document.getElementById("form-msg").classList.add("hidden");
  renderTagsDisplay("exp", []);
};

// Show/hide the card name input based on payment method
window.toggleCardName = (wrapId, paymentValue) => {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  const show = paymentValue === 'Credit Card' || paymentValue === 'Debit Card';
  wrap.style.display = show ? '' : 'none';
  if (!show) {
    const input = wrap.querySelector('input');
    if (input) input.value = '';
  }
};

window.deleteExpense = (id) => { deleteTarget = id; document.getElementById("modal").classList.remove("hidden"); };
window.closeModal = () => { document.getElementById("modal").classList.add("hidden"); deleteTarget = null; };
window.confirmDelete = async () => {
  if (!deleteTarget) return;
  try {
    showLoader();
    await deleteDoc(doc(db, "expenses", deleteTarget));
    allExpenses = allExpenses.filter(e => e.id !== deleteTarget);
    dashboardPage = 1;
    updateCards();
    renderDashboardTable();
    renderHistory();
    // Defer chart rendering
    requestAnimationFrame(() => {
      renderPieChart();
      renderTrendChart();
      hideLoader();
    });
    // Update localStorage cache
    saveToCache(currentUser.uid, allExpenses);
    showToast("Deleted.", "success");
  } catch (e) { showToast("Delete failed.", "error"); hideLoader(); }
  closeModal();
};

// ============================================================
//  EDIT EXPENSE MODAL
// ============================================================
window.openEditExpense = (id) => {
  const expense = allExpenses.find(e => e.id === id);
  if (!expense) return;

  editingExpenseId = id;
  document.getElementById("edit-amount").value = expense.amount;
  updateCurrencyDisplay();
  document.getElementById("edit-date").value = expense.date;
  document.getElementById("edit-category").value = expense.category;
  document.getElementById("edit-payment").value = expense.payment;
  document.getElementById("edit-description").value = expense.description;
  document.getElementById("edit-notes").value = expense.notes || "";
  const editCardName = document.getElementById("edit-card-name");
  if (editCardName) editCardName.value = expense.cardName || "";
  toggleCardName('edit-card-name-wrap', expense.payment);

  // Set category tile selection
  document.querySelectorAll("#edit-category-picker .cat-tile").forEach(tile => {
    tile.classList.remove("selected");
    if (tile.dataset.value === expense.category) {
      tile.classList.add("selected");
    }
  });

  // Load tags
  setExpenseTags("edit", expense.tags || []);

  document.getElementById("edit-error").classList.add("hidden");
  document.getElementById("edit-modal").classList.remove("hidden");
};

window.closeEditModal = () => {
  document.getElementById("edit-modal").classList.add("hidden");
  editingExpenseId = null;
  setExpenseTags("edit", []);
};

window.saveEditExpense = async () => {
  if (!editingExpenseId) return;

  const amount = parseFloat(document.getElementById("edit-amount").value);
  const category = document.getElementById("edit-category").value;
  const date = document.getElementById("edit-date").value;
  const payment = document.getElementById("edit-payment").value;
  const description = sanitize(document.getElementById("edit-description").value.trim(), 300);
  const notes = sanitize(document.getElementById("edit-notes").value.trim(), 500);
  const tags = getExpenseTags("edit");

  const errEl = document.getElementById("edit-error");

  if (!amount || amount <= 0) {
    errEl.textContent = "Enter a valid amount.";
    errEl.classList.remove("hidden");
    return;
  }
  if (!category) {
    errEl.textContent = "Select a category.";
    errEl.classList.remove("hidden");
    return;
  }
  if (!date) {
    errEl.textContent = "Select a date.";
    errEl.classList.remove("hidden");
    return;
  }

  try {
    showLoader();
    const expenseRef = doc(db, "expenses", editingExpenseId);
    const editCardName = document.getElementById("edit-card-name");
    const cardName = sanitize(editCardName ? editCardName.value.trim() : "", 100);
    await updateDoc(expenseRef, {
      amount,
      category,
      date,
      payment,
      cardName: cardName || "",
      description: description || "-",
      notes: notes,
      tags,
      encoding: "plain"
    });

    // Update local array
    const idx = allExpenses.findIndex(e => e.id === editingExpenseId);
    if (idx >= 0) {
      allExpenses[idx] = {
        ...allExpenses[idx],
        amount,
        category,
        date,
        payment,
        cardName: document.getElementById("edit-card-name") ? document.getElementById("edit-card-name").value.trim() : "",
        description: description || "-",
        notes,
        tags
      };
      allExpenses.sort((a, b) => b.date.localeCompare(a.date));
    }

    dashboardPage = 1;
    updateCards();
    renderDashboardTable();
    renderHistory();
    // Defer chart rendering
    requestAnimationFrame(() => {
      renderPieChart();
      renderTrendChart();
      hideLoader();
    });
    // Update localStorage cache
    saveToCache(currentUser.uid, allExpenses);
    closeEditModal();
    showToast("Expense updated!", "success");
  } catch (e) {
    console.error(e);
    errEl.textContent = "Failed to update. Try again.";
    errEl.classList.remove("hidden");
    hideLoader();
  }
};

window.deleteFromEdit = async () => {
  if (!editingExpenseId) return;
  deleteTarget = editingExpenseId;
  closeEditModal();
  document.getElementById("modal").classList.remove("hidden");
};

function updateCards() {
  if (!document.getElementById("sum-monthly")) {
    console.warn('sum-monthly element not found');
    return;
  }
  const now = new Date();
  const today = todayStr();
  const ms = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-01";

  // Monthly expenses
  const monthlyExpenses = allExpenses.filter(e => e.date >= ms && e.date <= today);
  const monthTotal = monthlyExpenses.reduce((s, e) => s + e.amount, 0);
  
  document.getElementById("sum-monthly").textContent = fmt(monthTotal);
  document.getElementById("sum-monthly-count").textContent = monthlyExpenses.length + " transaction" + (monthlyExpenses.length !== 1 ? "s" : "") + " this month";
}

window.switchTableTab = (tab) => {
  activeTab = tab;
  dashboardPage = 1;
  document.querySelectorAll(".table-tab").forEach(t => t.classList.remove("active"));
  document.getElementById("ttab-" + tab).classList.add("active");
  renderDashboardTable();
  // Defer chart updates to avoid blocking
  requestAnimationFrame(() => {
    renderPieChart();
    renderTrendChart();
  });
};

function renderDashboardTable() {
  if (!document.getElementById("table-body")) {
    return;
  }

  const now = new Date(); const today = todayStr(); let from;
  if (activeTab === "daily") from = today;
  else if (activeTab === "weekly") from = getWeekStart();
  else if (activeTab === "monthly") from = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-01";
  else from = now.getFullYear() + "-01-01";

  const filteredData = allExpenses.filter(e => e.date >= from && e.date <= today);
  const totalPages = Math.max(1, Math.ceil(filteredData.length / DASHBOARD_PER_PAGE));
  if (dashboardPage > totalPages) dashboardPage = totalPages;

  const start = (dashboardPage - 1) * DASHBOARD_PER_PAGE;
  const end = start + DASHBOARD_PER_PAGE;
  const pageData = filteredData.slice(start, end);

  renderTable("table-body", pageData, false);
  renderDashboardPagination(filteredData.length, totalPages);
}

function renderDashboardPagination(totalItems, totalPages) {
  const el = document.getElementById("dashboard-pagination");
  
  if (!el) {
    return;
  }

  if (totalPages <= 1) { 
    el.innerHTML = ""; 
    return; 
  }

  const MAX_VISIBLE = 7;
  let startP = Math.max(1, dashboardPage - Math.floor(MAX_VISIBLE / 2));
  let endP = Math.min(totalPages, startP + MAX_VISIBLE - 1);
  if (endP - startP + 1 < MAX_VISIBLE) startP = Math.max(1, endP - MAX_VISIBLE + 1);

  let html = `<button class="page-btn" data-dashboard-page="${dashboardPage - 1}" ${dashboardPage === 1 ? "disabled" : ""}><i data-lucide="chevron-left"></i></button>`;

  if (startP > 1) {
    html += `<button class="page-btn" data-dashboard-page="1">1</button>`;
    if (startP > 2) html += `<span class="pagination-dots">…</span>`;
  }
  for (let i = startP; i <= endP; i++) {
    html += `<button class="page-btn${i === dashboardPage ? " active" : ""}" data-dashboard-page="${i}">${i}</button>`;
  }
  if (endP < totalPages) {
    if (endP < totalPages - 1) html += `<span class="pagination-dots">…</span>`;
    html += `<button class="page-btn" data-dashboard-page="${totalPages}">${totalPages}</button>`;
  }

  const from = (dashboardPage - 1) * DASHBOARD_PER_PAGE + 1;
  const to = Math.min(dashboardPage * DASHBOARD_PER_PAGE, totalItems);
  html += `<span class="pagination-info">${from}–${to} of ${totalItems}</span>`;
  html += `<button class="page-btn" data-dashboard-page="${dashboardPage + 1}" ${dashboardPage === totalPages ? "disabled" : ""}><i data-lucide="chevron-right"></i></button>`;

  el.innerHTML = html;
  if (window.lucide) lucide.createIcons();

  // Add click handlers
  el.querySelectorAll(".page-btn:not([disabled])").forEach(btn => {
    btn.addEventListener("click", () => {
      const page = parseInt(btn.dataset.dashboardPage);
      if (page && page !== dashboardPage) {
        dashboardPage = page;
        renderDashboardTable();
        // Scroll to top of table
        const card = document.querySelector(".table-card");
        if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });
}

// ── Pagination & Sorting state ────────────────────────────────
const DASHBOARD_PER_PAGE = 10;
const HISTORY_PER_PAGE = 10;
let dashboardPage = 1;
let historyPage = 1;
let sortCol = "date";
let sortAsc = false;

window.sortHistory = (col) => {
  if (sortCol === col) {
    sortAsc = !sortAsc;
  } else {
    sortCol = col;
    // Default: Amount descending, others ascending
    sortAsc = col === "amount" ? false : true;
  }
  historyPage = 1;
  // Re-render with the current filtered set (not sorted — renderHistory will sort)
  renderHistory(filteredExpenses);
};

function renderHistory(data) {
  if (!document.getElementById("history-body")) return;
  // Always work on a copy so we never mutate allExpenses or the filter result
  const source = data !== undefined ? data : allExpenses;
  filteredExpenses = source.slice();   // ← key fix: copy, not reference

  // Apply sorting
  filteredExpenses.sort((a, b) => {
    let valA = a[sortCol];
    let valB = b[sortCol];
    if (typeof valA === "string") valA = valA.toLowerCase();
    if (typeof valB === "string") valB = valB.toLowerCase();
    if (valA < valB) return sortAsc ? -1 : 1;
    if (valA > valB) return sortAsc ? 1 : -1;
    return 0;
  });

  // Update header sort icons
  document.querySelectorAll(".sortable").forEach(th => {
    th.classList.remove("active", "asc", "desc");
    if (th.dataset.col === sortCol) {
      th.classList.add("active", sortAsc ? "asc" : "desc");
    }
  });

  const total = filteredExpenses.reduce((s, e) => s + e.amount, 0);
  document.getElementById("history-count").textContent =
    filteredExpenses.length + " entr" + (filteredExpenses.length !== 1 ? "ies" : "y");
  const totalEl = document.getElementById("history-total");
  if (totalEl) totalEl.textContent = filteredExpenses.length ? "Total: " + fmt(total) : "";

  // Pagination against filteredExpenses (already sorted copy)
  const totalPages = Math.max(1, Math.ceil(filteredExpenses.length / HISTORY_PER_PAGE));
  if (historyPage > totalPages) historyPage = totalPages;

  const start = (historyPage - 1) * HISTORY_PER_PAGE;
  renderTable("history-body", filteredExpenses.slice(start, start + HISTORY_PER_PAGE), true);
  renderPagination(filteredExpenses.length, totalPages);
}

window.goToHistoryPage = (p) => {
  historyPage = p;
  renderHistory(filteredExpenses || allExpenses);
  const card = document.querySelector("#expense-history-section .table-card");
  if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
};

function renderPagination(totalItems, totalPages) {
  const el = document.getElementById("history-pagination");
  if (!el) return;
  if (totalPages <= 1) { el.innerHTML = ""; return; }

  const MAX_VISIBLE = 7;
  let startP = Math.max(1, historyPage - Math.floor(MAX_VISIBLE / 2));
  let endP = Math.min(totalPages, startP + MAX_VISIBLE - 1);
  if (endP - startP + 1 < MAX_VISIBLE) startP = Math.max(1, endP - MAX_VISIBLE + 1);

  let html = `<button class="page-btn" data-page-action="expense" data-page="${historyPage - 1}" ${historyPage === 1 ? "disabled" : ""}><i data-lucide="chevron-left"></i></button>`;

  if (startP > 1) {
    html += `<button class="page-btn" data-page-action="expense" data-page="1">1</button>`;
    if (startP > 2) html += `<span class="pagination-dots">…</span>`;
  }
  for (let i = startP; i <= endP; i++) {
    html += `<button class="page-btn${i === historyPage ? " active" : ""}" data-page-action="expense" data-page="${i}">${i}</button>`;
  }
  if (endP < totalPages) {
    if (endP < totalPages - 1) html += `<span class="pagination-dots">…</span>`;
    html += `<button class="page-btn" data-page-action="expense" data-page="${totalPages}">${totalPages}</button>`;
  }

  const from = (historyPage - 1) * HISTORY_PER_PAGE + 1;
  const to = Math.min(historyPage * HISTORY_PER_PAGE, totalItems);
  html += `<span class="pagination-info">${from}–${to} of ${totalItems}</span>`;
  html += `<button class="page-btn" data-page-action="expense" data-page="${historyPage + 1}" ${historyPage === totalPages ? "disabled" : ""}><i data-lucide="chevron-right"></i></button>`;

  el.innerHTML = html;
  if (window.lucide) lucide.createIcons();
}

// ═══════════════════════════════════════════════════════════════════
// CATEGORY MULTI-SELECT
// ═══════════════════════════════════════════════════════════════════

let selectedCategories = [];

function initCategoryMultiSelect() {
  const trigger = document.getElementById('category-trigger');
  const dropdown = document.getElementById('category-dropdown');
  const options = document.getElementById('category-options');
  const selectAllBtn = document.getElementById('category-select-all-btn');
  
  if (!trigger || !dropdown || !options) return;
  
  // Toggle dropdown on trigger click
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isExpanded = trigger.getAttribute('aria-expanded') === 'true';
    toggleCategoryDropdown(!isExpanded);
  });
  
  // Keyboard support
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const isExpanded = trigger.getAttribute('aria-expanded') === 'true';
      toggleCategoryDropdown(!isExpanded);
    }
    if (e.key === 'Escape') {
      toggleCategoryDropdown(false);
    }
  });
  
  // Handle checkbox changes
  options.addEventListener('change', (e) => {
    if (e.target.type === 'checkbox') {
      updateSelectedCategories();
    }
  });
  
  // Select All button
  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const checkboxes = options.querySelectorAll('input[type="checkbox"]');
      const allSelected = Array.from(checkboxes).every(cb => cb.checked);
      
      checkboxes.forEach(cb => {
        cb.checked = !allSelected;
      });
      
      selectAllBtn.textContent = allSelected ? 'Select All' : 'Deselect All';
      updateSelectedCategories();
    });
  }
  
  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target) && e.target !== trigger) {
      toggleCategoryDropdown(false);
    }
  });
  
  // Close on scroll and reposition on resize
  let scrollTimeout;
  window.addEventListener('scroll', () => {
    if (trigger.getAttribute('aria-expanded') === 'true') {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => toggleCategoryDropdown(false), 150);
    }
  }, { passive: true });
  
  window.addEventListener('resize', () => {
    if (trigger.getAttribute('aria-expanded') === 'true') {
      toggleCategoryDropdown(false);
    }
  });
}

function toggleCategoryDropdown(open) {
  const trigger = document.getElementById('category-trigger');
  const dropdown = document.getElementById('category-dropdown');
  
  if (!trigger || !dropdown) return;
  
  if (open) {
    // Position dropdown below trigger
    const triggerRect = trigger.getBoundingClientRect();
    const dropdownHeight = 320; // approximate max-height
    const spaceBelow = window.innerHeight - triggerRect.bottom;
    const spaceAbove = triggerRect.top;
    
    // Determine if we should show below or above
    let topPosition;
    if (spaceBelow >= dropdownHeight || spaceBelow > spaceAbove) {
      // Show below
      topPosition = triggerRect.bottom + 8;
    } else {
      // Show above
      topPosition = triggerRect.top - dropdownHeight - 8;
    }
    
    dropdown.style.top = topPosition + 'px';
    dropdown.style.left = triggerRect.left + 'px';
    dropdown.style.width = Math.max(triggerRect.width, 280) + 'px';
    dropdown.style.maxHeight = '320px';
    
    // Adjust if it goes off-screen right
    requestAnimationFrame(() => {
      const dropdownRect = dropdown.getBoundingClientRect();
      if (dropdownRect.right > window.innerWidth - 16) {
        dropdown.style.left = (window.innerWidth - dropdownRect.width - 16) + 'px';
      }
      if (dropdownRect.left < 16) {
        dropdown.style.left = '16px';
      }
    });
    
    dropdown.classList.remove('hidden');
    trigger.setAttribute('aria-expanded', 'true');
  } else {
    dropdown.classList.add('hidden');
    trigger.setAttribute('aria-expanded', 'false');
  }
}

function updateSelectedCategories() {
  const options = document.getElementById('category-options');
  const chipsContainer = document.getElementById('category-chips');
  const placeholder = document.getElementById('category-placeholder');
  const selectAllBtn = document.getElementById('category-select-all-btn');
  
  if (!options) return;
  
  // Get selected values
  selectedCategories = Array.from(options.querySelectorAll('input[type="checkbox"]:checked'))
    .map(cb => cb.value);
  
  // Update chips
  if (chipsContainer) {
    chipsContainer.innerHTML = '';
    selectedCategories.forEach(cat => {
      const chip = document.createElement('div');
      chip.className = 'category-chip';
      chip.innerHTML = `
        <span>${escapeHtml(cat)}</span>
        <button type="button" aria-label="Remove ${cat}" data-category="${cat}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      `;
      chipsContainer.appendChild(chip);
    });
    
    // Add click handlers to remove buttons
    chipsContainer.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const category = btn.dataset.category;
        const checkbox = options.querySelector(`input[value="${CSS.escape(category)}"]`);
        if (checkbox) {
          checkbox.checked = false;
          updateSelectedCategories();
        }
      });
    });
  }
  
  // Update placeholder text
  if (placeholder) {
    if (selectedCategories.length === 0) {
      placeholder.textContent = 'All Categories';
    } else if (selectedCategories.length === 1) {
      placeholder.textContent = selectedCategories[0];
    } else if (selectedCategories.length <= 3) {
      placeholder.textContent = selectedCategories.join(', ');
    } else {
      placeholder.textContent = `${selectedCategories.length} categories selected`;
    }
  }
  
  // Update Select All button text
  if (selectAllBtn) {
    const checkboxes = options.querySelectorAll('input[type="checkbox"]');
    const allSelected = Array.from(checkboxes).every(cb => cb.checked);
    selectAllBtn.textContent = allSelected ? 'Deselect All' : 'Select All';
  }
  
  // Update field highlighting
  updateFieldHighlight('filter-category', selectedCategories.length > 0 ? 'selected' : '');
}

// Initialize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initCategoryMultiSelect);
} else {
  initCategoryMultiSelect();
}

window.applyFilters = () => {
  const from = document.getElementById("filter-from").value,
    to = document.getElementById("filter-to").value,
    q = document.getElementById("filter-search") ? document.getElementById("filter-search").value.toLowerCase().trim() : "";

  let data = allExpenses.slice();
  if (from) data = data.filter(e => e.date >= from);
  if (to) data = data.filter(e => e.date <= to);
  if (selectedCategories.length > 0) data = data.filter(e => selectedCategories.includes(e.category));
  if (q) {
    data = data.filter(e =>
      e.description.toLowerCase().includes(q) ||
      e.category.toLowerCase().includes(q) ||
      (e.notes && e.notes.toLowerCase().includes(q))
    );
  }

  historyPage = 1;
  renderHistory(data);
  updateFilterCount(from, to, selectedCategories, q);
};

window.clearFilters = () => {
  ["filter-from", "filter-to", "filter-search"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  
  // Clear category checkboxes
  const options = document.getElementById('category-options');
  if (options) {
    options.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
  }
  selectedCategories = [];
  updateSelectedCategories();
  
  historyPage = 1;
  renderHistory(allExpenses);
  updateFilterCount("", "", [], "");
};

function updateFilterCount(from, to, cats, q) {
  const badge = document.getElementById('filter-count');
  if (!badge) return;
  
  // Handle both array and string for backward compatibility
  const catArray = Array.isArray(cats) ? cats : (cats ? [cats] : []);
  
  let activeCount = 0;
  if (from) activeCount++;
  if (to) activeCount++;
  if (catArray.length > 0) activeCount++;
  if (q) activeCount++;
  
  badge.textContent = `${activeCount} active`;
  badge.style.opacity = activeCount > 0 ? '1' : '0.6';
  
  // Update field highlighting
  updateFieldHighlight('filter-from', from);
  updateFieldHighlight('filter-to', to);
  updateFieldHighlight('filter-category', catArray.length > 0 ? 'selected' : '');
  updateFieldHighlight('filter-search', q);
}

function updateFieldHighlight(inputId, value) {
  const input = document.getElementById(inputId);
  if (!input) return;
  
  const field = input.closest('.filter-card__field');
  if (!field) return;
  
  if (value && value.trim()) {
    field.classList.add('has-value');
  } else {
    field.classList.remove('has-value');
  }
}

function renderTable(tbodyId, rows, del) {
  const tbody = document.getElementById(tbodyId);
  const cols = del ? 9 : 5;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan='${cols}' class='empty-row'>No expenses found.</td></tr>`;
    return;
  }

  // Build rows using DOM APIs for user-supplied text fields so that:
  //  - emojis render correctly (no escaping needed for textContent)
  //  - XSS is impossible (textContent never interprets HTML)
  tbody.innerHTML = '';
  rows.forEach(e => {
    const tr = document.createElement('tr');

    // Date (safe — generated internally)
    const tdDate = document.createElement('td');
    tdDate.dataset.label = 'Date';
    tdDate.textContent = formatDate(e.date);
    tr.appendChild(tdDate);

    // Category (safe — from predefined list, but use textContent anyway)
    const tdCat = document.createElement('td');
    tdCat.dataset.label = 'Category';
    const badge = document.createElement('span');
    badge.className = 'category-badge';
    badge.textContent = e.category;
    tdCat.appendChild(badge);
    tr.appendChild(tdCat);

    // Description (user-supplied — emoji-safe via textContent)
    const tdDesc = document.createElement('td');
    tdDesc.dataset.label = 'Description';
    tdDesc.textContent = e.description || '-';
    tr.appendChild(tdDesc);

    // Payment (may include card name suffix — user-supplied)
    const tdPay = document.createElement('td');
    tdPay.dataset.label = 'Payment';
    const payText = e.cardName ? `${e.payment} (${e.cardName})` : e.payment;
    tdPay.textContent = payText;
    tr.appendChild(tdPay);

    // Notes — only in history view (del=true)
    if (del) {
      const tdNotes = document.createElement('td');
      tdNotes.dataset.label = 'Notes';
      tdNotes.textContent = e.notes || '-';
      tr.appendChild(tdNotes);

      // Tags — only in history view
      const tdTags = document.createElement('td');
      tdTags.dataset.label = 'Tags';
      if (e.tags && e.tags.length) {
        e.tags.forEach(tag => {
          const badge = document.createElement('span');
          badge.className = 'tag-badge-inline';
          badge.textContent = '#' + tag;
          tdTags.appendChild(badge);
        });
      } else {
        tdTags.textContent = '-';
      }
      tr.appendChild(tdTags);
    }

    // Amount (safe — formatted number)
    const tdAmt = document.createElement('td');
    tdAmt.dataset.label = 'Amount';
    tdAmt.className = 'text-right';
    tdAmt.textContent = fmt(e.amount);
    tr.appendChild(tdAmt);

    // Actions — only in history view (del=true)
    if (del) {
      const tdAct = document.createElement('td');
      tdAct.className = 'text-center';
      tdAct.innerHTML = `<div class='action-buttons'><button class='btn-action edit' data-edit-expense='${e.id}' title='Edit'><i class='lucide' data-lucide='pencil'></i></button><button class='btn-action delete' data-delete-expense='${e.id}' title='Delete'><i class='lucide' data-lucide='trash-2'></i></button></div>`;
      tr.appendChild(tdAct);
    }

    tbody.appendChild(tr);
  });
  if (window.lucide) lucide.createIcons();
}


window.downloadCSV = () => {
  const pm = document.getElementById('picker-month');
  const selectedMonth = pm ? pm.value : '';
  const selectedYear = document.getElementById('picker-year') ? document.getElementById('picker-year').value : '';

  // If period picker is active, use filtered data
  if (selectedMonth || selectedYear) {
    const periodData = getPeriodExpenses();
    let label = 'Export';
    if (selectedMonth && selectedYear) {
      const months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      label = months[parseInt(selectedMonth)] + '_' + selectedYear;
    } else if (selectedMonth) {
      const months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      label = months[parseInt(selectedMonth)];
    } else if (selectedYear) {
      label = 'Year_' + selectedYear;
    }
    exportCSV(periodData, "SpendWise_" + label);
    return;
  }

  // Otherwise, use the current date logic
  const now = new Date(); const today = todayStr(); let from, label;
  if (activeTab === "daily") { from = today; label = "Today"; }
  else if (activeTab === "weekly") { from = getWeekStart(); label = "This_Week"; }
  else if (activeTab === "monthly") { from = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-01"; label = "This_Month"; }
  else { from = now.getFullYear() + "-01-01"; label = "This_Year"; }
  exportCSV(allExpenses.filter(e => e.date >= from && e.date <= today), "SpendWise_" + label);
};

window.downloadHistoryCSV = () => exportCSV(filteredExpenses || allExpenses, "SpendWise_History");

function exportCSV(rows, name) {
  if (!rows.length) { showToast("No data to export.", "error"); return; }
  const hdr = ["Date", "Category", "Description", "Payment Method", "Card Name", "Notes", "Amount (Rs)"];
  const csv = [hdr.join(","), ...rows.map(e => [
    e.date,
    '"' + e.category + '"',
    '"' + (e.description || "").replace(/"/g, '""') + '"',
    '"' + e.payment + '"',
    '"' + (e.cardName || "").replace(/"/g, '""') + '"',
    '"' + (e.notes || "").replace(/"/g, '""') + '"',
    e.amount.toFixed(2)
  ].join(","))].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = name + "_" + todayStr() + ".csv";
  a.click(); showToast("CSV downloaded!", "success");
}

window.toggleTheme = () => {
  const html = document.documentElement;
  const dark = html.getAttribute("data-theme") === "dark";
  html.setAttribute("data-theme", dark ? "light" : "dark");
  localStorage.setItem("theme", dark ? "light" : "dark");
  updateThemeIcon();
  renderPieChart();
  renderTrendChart();
};

// Auto-detect OS theme on first visit; honour saved preference on return visits
const saved = localStorage.getItem("theme") ||
  (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
document.documentElement.setAttribute("data-theme", saved);

function showToast(msg, type) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.className = "toast " + (type || "success");
  t.classList.remove("hidden");
  setTimeout(() => t.classList.add("hidden"), 3000);
}

// fmt() is now provided by currency.js — removed local override
function pad(n) { return String(n).padStart(2, "0"); }
function todayStr() { const d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function getWeekStart() { const d = new Date(); const day = d.getDay(); const diff = d.getDate() - day + (day === 0 ? -6 : 1); const m = new Date(d.setDate(diff)); return m.getFullYear() + "-" + pad(m.getMonth() + 1) + "-" + pad(m.getDate()); }
function formatDate(ds) { return new Date(ds + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }); }
function setGreeting() { const h = new Date().getHours(); const g = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; const n = (currentUser && currentUser.displayName) ? currentUser.displayName.split(" ")[0] : ""; const el = document.getElementById("dashboard-greeting") || document.getElementById("income-greeting") || document.getElementById("expense-greeting"); if (el) el.textContent = g + (n ? ", " + n : "") + "!"; }

// ── Currency ────────────────────────────────────────────────────────────────
function initCurrencySelector() {
  const sel = document.getElementById('currency-select');
  if (!sel) return;
  sel.innerHTML = buildCurrencyOptions(getCurrency());
  // Wait for lucide to render icons, then update currency symbols
  requestAnimationFrame(() => {
    updateCurrencyDisplay();
  });
}

window.handleCurrencyChange = (code) => {
  setCurrency(code);
  updateCurrencyDisplay();
  // Re-render all currency-dependent UI
  if (currentUser) {
    updateCards();
    renderDashboardTable();
    renderHistory();
    updatePeriodSummary();
    updateIncomeCards();
    updateExpenseCards();
    requestAnimationFrame(() => { renderPieChart(); renderTrendChart(); });
  }
};
function showFormMsg(msg, type) { const el = document.getElementById("form-msg"); el.textContent = msg; el.className = "form-msg " + type; el.classList.remove("hidden"); if (type === "success") setTimeout(() => el.classList.add("hidden"), 3000); }

// ============================================================
//  PIE CHART - SPENDING BY CATEGORY
// ============================================================
function getCategoryBreakdown() {
  // Get current displayed expenses based on both period picker AND active tab
  const m = document.getElementById('picker-month') ? document.getElementById('picker-month').value : '';
  const y = document.getElementById('picker-year') ? document.getElementById('picker-year').value : '';

  let periodExpenses = allExpenses.filter(e => {
    if (!e.date) return false;
    if (y && e.date.substring(0, 4) !== String(y)) return false;
    if (m && e.date.substring(5, 7) !== String(m)) return false;
    return true;
  });

  // Now filter by active tab
  const now = new Date();
  const today = todayStr();
  let displayExpenses = [];

  if (activeTab === 'daily') {
    displayExpenses = periodExpenses.filter(e => e.date === today);
  } else if (activeTab === 'weekly') {
    // Use allExpenses for weekly to avoid period picker clipping across month boundaries
    const ws = getWeekStart();
    displayExpenses = allExpenses.filter(e => e.date >= ws && e.date <= today);
  } else if (activeTab === 'monthly') {
    let displayYear = y || now.getFullYear();
    let displayMonth = m || pad(now.getMonth() + 1);
    const ms = displayYear + '-' + displayMonth + '-01';
    const lastDay = new Date(displayYear, parseInt(displayMonth), 0).getDate();
    const me = displayYear + '-' + displayMonth + '-' + pad(lastDay);
    displayExpenses = periodExpenses.filter(e => e.date >= ms && e.date <= me);
  } else {
    displayExpenses = periodExpenses;
  }

  // Aggregate by category
  const categoryTotals = {};
  displayExpenses.forEach(e => {
    if (!categoryTotals[e.category]) {
      categoryTotals[e.category] = 0;
    }
    categoryTotals[e.category] += e.amount;
  });

  return categoryTotals;
}

function renderPieChart() {
  if (!document.getElementById("categoryPieChart")) return;
  const categoryData = getCategoryBreakdown();
  const labels = Object.keys(categoryData);
  const data = Object.values(categoryData);

  // Colors for different categories
  const colors = [
    '#4a9eff', '#ec4899', '#10b981', '#f59e0b', '#ef4444',
    '#8b5cf6', '#06b6d4', '#f97316', '#06b6d4', '#14b8a6'
  ];

  const chartCanvas = document.getElementById('categoryPieChart');
  if (!chartCanvas) return;

  // Destroy existing chart if it exists
  if (chartInstance) {
    chartInstance.destroy();
  }

  const ctx = chartCanvas.getContext('2d');

  // Use lighter colors for dark mode, darker for light mode
  const isDarkMode = document.documentElement.getAttribute('data-theme') === 'dark';
  const adjustedColors = colors.slice(0, labels.length);

  chartInstance = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: labels,
      datasets: [{
        data: data,
        backgroundColor: adjustedColors,
        borderColor: isDarkMode ? '#262626' : '#ffffff',
        borderWidth: 2,
        hoverOffset: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            padding: 16,
            font: { size: 12, weight: '500' },
            color: isDarkMode ? '#b0b0b0' : '#666666',
            usePointStyle: true,
            pointStyle: 'circle'
          }
        },
        tooltip: {
          backgroundColor: isDarkMode ? 'rgba(38, 38, 38, 0.95)' : 'rgba(255, 255, 255, 0.95)',
          titleColor: isDarkMode ? '#e8e8e8' : '#1a1a1a',
          bodyColor: isDarkMode ? '#b0b0b0' : '#666666',
          borderColor: isDarkMode ? '#3a3a3a' : '#e5e5e5',
          borderWidth: 1,
          padding: 12,
          titleFont: { size: 13, weight: '600' },
          bodyFont: { size: 12 },
          callbacks: {
            label: function (context) {
              const value = context.parsed;
              const total = context.dataset.data.reduce((a, b) => a + b, 0);
              const percentage = ((value / total) * 100).toFixed(1);
              return fmt(value) + ' (' + percentage + '%)';
            }
          }
        }
      }
    }
  });
}

// ============================================================
//  LINE CHART - SPENDING TRENDS
// ============================================================
let trendChartInstance = null;

function getTrendData() {
  // Get current displayed expenses based on period picker
  const m = document.getElementById('picker-month') ? document.getElementById('picker-month').value : '';
  const y = document.getElementById('picker-year') ? document.getElementById('picker-year').value : '';

  let periodExpenses = allExpenses.filter(e => {
    if (!e.date) return false;
    if (y && e.date.substring(0, 4) !== String(y)) return false;
    if (m && e.date.substring(5, 7) !== String(m)) return false;
    return true;
  });

  const now = new Date();
  const today = todayStr();
  let labels = [];
  let dateGroups = {};

  // Helper: short date like "26 Mar"
  function shortDate(ds) {
    const d = new Date(ds + 'T00:00:00');
    return d.getDate() + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  }

  // Helper: short day name like "Mon"
  function shortDay(ds) {
    const d = new Date(ds + 'T00:00:00');
    return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
  }

  if (activeTab === 'daily') {
    // For daily view, show last 7 days — label: "Mon 26"
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 6);
    for (let i = 0; i < 7; i++) {
      const date = new Date(startDate);
      date.setDate(date.getDate() + i);
      const dateStr = date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
      const label = shortDay(dateStr) + ' ' + date.getDate();
      labels.push(label);
      const dayExpenses = allExpenses.filter(e => e.date === dateStr);
      dateGroups[label] = dayExpenses.reduce((s, e) => s + e.amount, 0);
    }
  } else if (activeTab === 'weekly') {
    // Show last 4 weeks — label: "9–15 Mar"
    labels = [];
    for (let i = 3; i >= 0; i--) {
      const weekDate = new Date();
      weekDate.setDate(weekDate.getDate() - (i * 7));
      const weekStart = new Date(weekDate);
      weekStart.setDate(weekStart.getDate() - weekDate.getDay() + (weekDate.getDay() === 0 ? -6 : 1));
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);

      const wStartStr = weekStart.toISOString().split('T')[0];
      const wEndStr   = weekEnd.toISOString().split('T')[0];
      // Compact label e.g. "9–15 Mar" or "28 Mar–3 Apr" for cross-month
      const startMonth = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][weekStart.getMonth()];
      const endMonth   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][weekEnd.getMonth()];
      const label = weekStart.getMonth() === weekEnd.getMonth()
        ? weekStart.getDate() + '–' + weekEnd.getDate() + ' ' + startMonth
        : weekStart.getDate() + ' ' + startMonth + '–' + weekEnd.getDate() + ' ' + endMonth;
      labels.push(label);

      const weekExpenses = allExpenses.filter(e => {
        return e.date >= wStartStr && e.date <= wEndStr;
      });
      dateGroups[label] = weekExpenses.reduce((s, e) => s + e.amount, 0);
    }
  } else if (activeTab === 'monthly') {
    // Show all months in the year (use allExpenses filtered by year only, not month)
    let displayYear = y || now.getFullYear();
    for (let month = 1; month <= 12; month++) {
      const monthStr = pad(month);
      const monthLabel = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1];
      labels.push(monthLabel);

      const monthExpenses = allExpenses.filter(e => {
        return e.date && e.date.substring(0, 4) === String(displayYear) && e.date.substring(5, 7) === monthStr;
      });
      dateGroups[monthLabel] = monthExpenses.reduce((s, e) => s + e.amount, 0);
    }
  } else {
    // Yearly view - show all years from all expenses
    const years = new Set();
    allExpenses.forEach(e => {
      if (e.date) years.add(e.date.substring(0, 4));
    });
    const sortedYears = Array.from(years).sort();
    sortedYears.forEach(year => {
      labels.push(year);
      const yearExpenses = allExpenses.filter(e => e.date.substring(0, 4) === year);
      dateGroups[year] = yearExpenses.reduce((s, e) => s + e.amount, 0);
    });
  }

  // Update data-tab attribute for CSS min-width rules
  const trendInner = document.getElementById('trend-chart-inner');
  if (trendInner) trendInner.setAttribute('data-tab', activeTab);

  const data = labels.map(label => dateGroups[label] || 0);

  return { labels, data };
}

function renderTrendChart() {
  if (!document.getElementById("trendLineChart")) return;
  const { labels, data } = getTrendData();

  const chartCanvas = document.getElementById('trendLineChart');
  if (!chartCanvas) return;

  // Destroy existing chart
  if (trendChartInstance) {
    trendChartInstance.destroy();
  }

  const ctx = chartCanvas.getContext('2d');
  const isDarkMode = document.documentElement.getAttribute('data-theme') === 'dark';
  const isMobile = window.innerWidth < 600;

  // Abbreviated Y-axis: uses fmtCompact from currency.js
  function fmtTick(value) {
    return fmtCompact(value);
  }

  trendChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Spending',
        data: data,
        borderColor: '#4a9eff',
        backgroundColor: 'rgba(74, 158, 255, 0.08)',
        borderWidth: isMobile ? 2.5 : 3,
        fill: true,
        tension: 0.4,
        pointRadius: isMobile ? 4 : 5,
        pointHoverRadius: isMobile ? 6 : 7,
        pointBackgroundColor: '#4a9eff',
        pointBorderColor: isDarkMode ? '#262626' : '#ffffff',
        pointBorderWidth: 2,
        pointHoverBackgroundColor: '#0066cc'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          // Hide legend on mobile to save space; show on desktop
          display: !isMobile,
          labels: {
            color: isDarkMode ? '#b0b0b0' : '#666666',
            font: { size: 12, weight: '500' },
            padding: 16,
            usePointStyle: false
          }
        },
        tooltip: {
          backgroundColor: isDarkMode ? 'rgba(38, 38, 38, 0.97)' : 'rgba(255, 255, 255, 0.97)',
          titleColor: isDarkMode ? '#e8e8e8' : '#1a1a1a',
          bodyColor: isDarkMode ? '#b0b0b0' : '#666666',
          borderColor: isDarkMode ? '#3a3a3a' : '#e5e5e5',
          borderWidth: 1,
          padding: isMobile ? 10 : 12,
          titleFont: { size: isMobile ? 12 : 13, weight: '600' },
          bodyFont: { size: isMobile ? 11 : 12 },
          callbacks: {
            label: function (context) {
              return 'Spent: ' + fmt(context.parsed.y);
            }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            maxTicksLimit: isMobile ? 5 : 7,
            color: isDarkMode ? '#b0b0b0' : '#888888',
            font: { size: isMobile ? 10 : 11 },
            // Compact format: Rs 5k instead of Rs 5,000.00
            callback: fmtTick
          },
          grid: {
            color: isDarkMode ? 'rgba(58, 58, 58, 0.5)' : 'rgba(229, 229, 229, 0.5)',
            drawBorder: false
          }
        },
        x: {
          ticks: {
            color: isDarkMode ? '#b0b0b0' : '#888888',
            font: { size: isMobile ? 10 : 11 },
            maxRotation: isMobile ? 30 : 0,
            minRotation: 0,
            autoSkip: false
          },
          grid: {
            display: false,
            drawBorder: false
          }
        }
      }
    }
  });
}

function updateThemeIcon() {
  const icon = document.getElementById("theme-icon");
  if (!icon) return;
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  icon.setAttribute("data-lucide", isDark ? "moon" : "sun");
  if (window.lucide) lucide.createIcons();
}

document.addEventListener("DOMContentLoaded", () => {
  updateThemeIcon();
  const d = document.getElementById("exp-date"); if (d) d.value = todayStr();
  initTagInput("exp");
  initTagInput("edit");
});

// ══════════════════════════════════════════════════════════════════════════════
//  TAGS
// ══════════════════════════════════════════════════════════════════════════════
const _tagState = { exp: [], edit: [] };

function initTagInput(prefix) {
  const input = document.getElementById(`${prefix}-tags`);
  if (!input) return;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(prefix);
    }
    if (e.key === 'Backspace' && !input.value && _tagState[prefix].length) {
      _tagState[prefix].pop();
      renderTagsDisplay(prefix, _tagState[prefix]);
    }
  });
  input.addEventListener('blur', () => {
    if (input.value.trim()) addTag(prefix);
  });
}

function addTag(prefix) {
  const input = document.getElementById(`${prefix}-tags`);
  if (!input) return;
  const raw = input.value.replace(/,/g, ' ').trim();
  if (!raw) return;
  const tags = raw.split(/\s+/).map(t => t.replace(/^#/, '').trim()).filter(Boolean);
  tags.forEach(tag => {
    if (!_tagState[prefix].includes(tag)) {
      _tagState[prefix].push(tag);
    }
  });
  input.value = '';
  renderTagsDisplay(prefix, _tagState[prefix]);
}

function removeTag(prefix, tag) {
  _tagState[prefix] = _tagState[prefix].filter(t => t !== tag);
  renderTagsDisplay(prefix, _tagState[prefix]);
}

function renderTagsDisplay(prefix, tags) {
  const container = document.getElementById(`${prefix}-tags-display`);
  if (!container) return;
  container.innerHTML = tags.map(tag =>
    `<span class="tag-badge">#${escapeHtml(tag)}<span class="tag-remove" data-remove-tag="${escapeHtml(tag)}" data-tag-prefix="${prefix}">&times;</span></span>`
  ).join('');
}

function getExpenseTags(prefix) {
  return _tagState[prefix] ? _tagState[prefix].slice() : [];
}

function setExpenseTags(prefix, tags) {
  _tagState[prefix] = tags ? tags.slice() : [];
  renderTagsDisplay(prefix, _tagState[prefix]);
}

// ============================================================
//  CATEGORY TILE PICKER
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  // Re-init Lucide icons after module loads
  if (window.lucide) lucide.createIcons();

  document.querySelectorAll('.cat-tile').forEach(tile => {
    tile.addEventListener('click', () => {
      // Determine which picker this tile belongs to
      const editPicker = tile.closest('#edit-category-picker');
      const addPicker = tile.closest('#category-picker');

      if (editPicker) {
        // Edit modal
        document.querySelectorAll('#edit-category-picker .cat-tile').forEach(t => t.classList.remove('selected'));
        tile.classList.add('selected');
        document.getElementById('edit-category').value = tile.dataset.value;
      } else if (addPicker) {
        // Add modal
        document.querySelectorAll('#category-picker .cat-tile').forEach(t => t.classList.remove('selected'));
        tile.classList.add('selected');
        document.getElementById('exp-category').value = tile.dataset.value;
      }
    });
  });
});

// Patch resetForm to also clear category tiles
const _baseReset = window.resetForm;
window.resetForm = () => {
  _baseReset();
  document.querySelectorAll('#category-picker .cat-tile').forEach(t => t.classList.remove('selected'));
  document.getElementById('exp-category').value = '';
};

// PERIOD PICKER
function populateYearPicker() {
  if (!document.getElementById("picker-year")) return;
  const yearSelect = document.getElementById('picker-year');
  const currentYear = new Date().getFullYear();
  const years = new Set([currentYear]);
  allExpenses.forEach(e => { if (e.date) years.add(parseInt(e.date.substring(0, 4))); });
  const sorted = Array.from(years).sort((a, b) => b - a);
  yearSelect.innerHTML = '<option value="">All Years</option>';
  sorted.forEach(y => {
    const opt = document.createElement('option');
    opt.value = y; opt.textContent = y;
    yearSelect.appendChild(opt);
  });
}

function initPeriodPicker() {
  if (!document.getElementById("picker-month")) return;
  const now = new Date();
  document.getElementById('picker-month').value = String(now.getMonth() + 1).padStart(2, '0');
  document.getElementById('picker-year').value = now.getFullYear();
  updatePeriodLabel();
  updatePeriodSummary();
}

window.onPeriodChange = function () {
  dashboardPage = 1;
  updatePeriodLabel();
  renderDashboardTable();
  // Defer chart updates
  requestAnimationFrame(() => {
    renderPieChart();
    renderTrendChart();
  });
}

window.resetPeriodPicker = function () {
  const now = new Date();
  document.getElementById('picker-month').value = String(now.getMonth() + 1).padStart(2, '0');
  document.getElementById('picker-year').value = now.getFullYear();
  dashboardPage = 1;
  updatePeriodLabel(); renderDashboardTable();
}

function updatePeriodLabel() {
  const m = document.getElementById('picker-month').value;
  const y = document.getElementById('picker-year').value;
  const months = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  let label = 'Showing all time';
  if (m && y) label = 'Showing ' + months[parseInt(m)] + ' ' + y;
  else if (m) label = 'Showing ' + months[parseInt(m)] + ' (all years)';
  else if (y) label = 'Showing all of ' + y;
  document.getElementById('period-picker-sub').textContent = label;
}

function getPeriodExpenses() {
  const m = document.getElementById('picker-month') ? document.getElementById('picker-month').value : '';
  const y = document.getElementById('picker-year') ? document.getElementById('picker-year').value : '';
  return allExpenses.filter(e => {
    if (!e.date) return false;
    if (y && e.date.substring(0, 4) !== String(y)) return false;
    if (m && e.date.substring(5, 7) !== String(m)) return false;
    return true;
  });
}

function updatePeriodSummary() {
  if (!document.getElementById("period-total")) return;
  const rows = getPeriodExpenses();
  const total = rows.reduce((s, e) => s + e.amount, 0);
  const max = rows.length ? Math.max(...rows.map(e => e.amount)) : 0;
  const uniqueDays = new Set(rows.map(e => e.date)).size;
  const avg = uniqueDays > 0 ? total / uniqueDays : 0;
  document.getElementById('period-total').textContent = fmt(total);
  document.getElementById('period-count').textContent = rows.length;
  document.getElementById('period-avg').textContent = fmt(avg);
  document.getElementById('period-max').textContent = fmt(max);
}

// Override renderDashboardTable to respect period picker
const _baseRenderDashboard = renderDashboardTable;
renderDashboardTable = function () {
  const pm = document.getElementById('picker-month');
  if (!pm) { 
    _baseRenderDashboard(); 
    return; 
  }
  
  const selectedMonth = document.getElementById('picker-month').value;
  const selectedYear = document.getElementById('picker-year').value;
  
  // For yearly tab, don't filter by month
  let periodRows;
  if (activeTab === 'yearly') {
    // Only filter by year, ignore month
    periodRows = allExpenses.filter(e => {
      if (!e.date) return false;
      if (selectedYear && e.date.substring(0, 4) !== String(selectedYear)) return false;
      return true;
    });
  } else {
    // For other tabs, use the period picker
    periodRows = getPeriodExpenses();
  }
  
  const now = new Date(); const today = todayStr();
  let rows;
  if (activeTab === 'daily') {
    rows = periodRows.filter(e => e.date === today);
  } else if (activeTab === 'weekly') {
    const ws = getWeekStart();
    rows = periodRows.filter(e => e.date >= ws && e.date <= today);
  } else if (activeTab === 'monthly') {
    // Use selected month/year if available, otherwise use current
    let displayYear = selectedYear || now.getFullYear();
    let displayMonth = selectedMonth || pad(now.getMonth() + 1);
    const ms = displayYear + '-' + displayMonth + '-01';
    // Calculate the last day of the selected month
    const lastDay = new Date(displayYear, parseInt(displayMonth), 0).getDate();
    const me = displayYear + '-' + displayMonth + '-' + pad(lastDay);
    rows = periodRows.filter(e => e.date >= ms && e.date <= me);
  } else if (activeTab === 'yearly') {
    // Yearly tab: show all expenses for selected year
    rows = periodRows;
  } else {
    rows = periodRows;
  }

  // Apply pagination
  const totalPages = Math.max(1, Math.ceil(rows.length / DASHBOARD_PER_PAGE));
  if (dashboardPage > totalPages) dashboardPage = totalPages;

  const start = (dashboardPage - 1) * DASHBOARD_PER_PAGE;
  const end = start + DASHBOARD_PER_PAGE;
  const pageData = rows.slice(start, end);

  renderTable('table-body', pageData, false);
  updatePeriodSummary();
  renderDashboardPagination(rows.length, totalPages);
};

// After data loads, init the picker
document.addEventListener('DOMContentLoaded', () => {
  const pm = document.getElementById('picker-month');
  const py = document.getElementById('picker-year');
  if (pm) pm.addEventListener('change', window.onPeriodChange);
  if (py) py.addEventListener('change', window.onPeriodChange);
});

// FORGOT PASSWORD
window.showForgotPassword = function () {
  const loginEmail = document.getElementById('login-email').value.trim();
  if (loginEmail) document.getElementById('forgot-email').value = loginEmail;
  resetForgotModal();
  document.getElementById('forgot-modal').classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
  setTimeout(() => document.getElementById('forgot-email').focus(), 100);
};
window.closeForgotModal = function () {
  document.getElementById('forgot-modal').classList.add('hidden');
};
window.resetForgotModal = function () {
  document.getElementById('forgot-step-1').classList.remove('hidden');
  document.getElementById('forgot-step-2').classList.add('hidden');
  const e = document.getElementById('forgot-error');
  e.classList.add('hidden'); e.textContent = '';
};
window.handleForgotPassword = async function () {
  const email = document.getElementById('forgot-email').value.trim();
  const errEl = document.getElementById('forgot-error');
  if (!email) { errEl.textContent = 'Please enter your email address.'; errEl.classList.remove('hidden'); return; }
  const emailOk = /^[^@]+@[^@]+[.][^@]+/.test(email);
  if (!emailOk) { errEl.textContent = 'Please enter a valid email address.'; errEl.classList.remove('hidden'); return; }
  const btn = document.querySelector('#forgot-step-1 .btn-primary');
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Sending...';
  try {
    await sendPasswordResetEmail(auth, email);
    document.getElementById('forgot-step-1').classList.add('hidden');
    document.getElementById('forgot-step-2').classList.remove('hidden');
    document.getElementById('forgot-success-msg').textContent = 'We sent a password reset link to ' + email + '. Check your inbox and follow the instructions.';
    if (window.lucide) lucide.createIcons();
  } catch (e2) {
    const msgs = { 'auth/user-not-found': 'No account found with this email.', 'auth/invalid-email': 'Invalid email address.', 'auth/too-many-requests': 'Too many attempts. Try again later.' };
    errEl.textContent = msgs[e2.code] || 'Something went wrong. Try again.';
    errEl.classList.remove('hidden');
    btn.disabled = false; btn.innerHTML = orig;
    if (window.lucide) lucide.createIcons();
  }
};
document.addEventListener('DOMContentLoaded', () => {
  const overlay = document.getElementById('forgot-modal');
  if (overlay) overlay.addEventListener('click', e => { if (e.target === overlay) closeForgotModal(); });
  const inp = document.getElementById('forgot-email');
  if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') handleForgotPassword(); });

  // Edit modal cleanup
  const editOverlay = document.getElementById('edit-modal');
  if (editOverlay) editOverlay.addEventListener('click', e => { if (e.target === editOverlay) closeEditModal(); });

  // Income modal cleanup
  const incEditOverlay = document.getElementById('inc-edit-modal');
  if (incEditOverlay) incEditOverlay.addEventListener('click', e => { if (e.target === incEditOverlay) closeIncEditModal(); });
  const incDelOverlay = document.getElementById('inc-delete-modal');
  if (incDelOverlay) incDelOverlay.addEventListener('click', e => { if (e.target === incDelOverlay) closeIncDeleteModal(); });
});

// ============================================================
//  INCOME HISTORY (in History page)
// ============================================================
let incHistoryPage = 1;
let incSortCol = 'date';
let incSortAsc = false;
let filteredIncome = null;
let incDeleteTarget = null;
let editingIncId = null;
const INC_HISTORY_PER_PAGE = 10;

// ── Tab Switcher ─────────────────────────────────────────────
window.switchHistoryTab = (tab) => {
  document.querySelectorAll('.history-tab').forEach(b => b.classList.remove('active'));
  document.getElementById('htab-' + tab).classList.add('active');

  const expSection = document.getElementById('expense-history-section');
  const incSection = document.getElementById('income-history-section');

  if (tab === 'expenses') {
    expSection.classList.remove('hidden');
    incSection.classList.add('hidden');
    renderHistory();
  } else {
    expSection.classList.add('hidden');
    incSection.classList.remove('hidden');
    renderIncomeHistory();
  }
};

// ── Render Income History ────────────────────────────────────
function renderIncomeHistory(data) {
  const source = data !== undefined ? data : allIncome;
  filteredIncome = source.slice();

  // Apply sorting
  filteredIncome.sort((a, b) => {
    let valA = a[incSortCol];
    let valB = b[incSortCol];
    if (typeof valA === 'string') valA = valA.toLowerCase();
    if (typeof valB === 'string') valB = valB.toLowerCase();
    if (valA < valB) return incSortAsc ? -1 : 1;
    if (valA > valB) return incSortAsc ? 1 : -1;
    return 0;
  });

  // Update header sort icons (only income-specific ones)
  document.querySelectorAll('.inc-sortable').forEach(th => {
    th.classList.remove('active', 'asc', 'desc');
    if (th.dataset.col === incSortCol) {
      th.classList.add('active', incSortAsc ? 'asc' : 'desc');
    }
  });

  const total = filteredIncome.reduce((s, i) => s + i.amount, 0);
  const countEl = document.getElementById('inc-history-count');
  if (countEl) countEl.textContent = filteredIncome.length + ' entr' + (filteredIncome.length !== 1 ? 'ies' : 'y');
  const totalEl = document.getElementById('inc-history-total');
  if (totalEl) totalEl.textContent = filteredIncome.length ? 'Total: ' + fmt(total) : '';

  const totalPages = Math.max(1, Math.ceil(filteredIncome.length / INC_HISTORY_PER_PAGE));
  if (incHistoryPage > totalPages) incHistoryPage = totalPages;

  const start = (incHistoryPage - 1) * INC_HISTORY_PER_PAGE;
  renderIncomeTableRows(filteredIncome.slice(start, start + INC_HISTORY_PER_PAGE));
  renderIncPagination(filteredIncome.length, totalPages);
}

function renderIncomeTableRows(rows) {
  const tbody = document.getElementById('inc-history-body');
  if (!tbody) return;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan='7' class='empty-row'>No income entries found.</td></tr>`;
    return;
  }

  tbody.innerHTML = '';
  rows.forEach(entry => {
    const tr = document.createElement('tr');

    const tdDate = document.createElement('td');
    tdDate.dataset.label = 'Date';
    tdDate.textContent = formatDate(entry.date);
    tr.appendChild(tdDate);

    const tdSrc = document.createElement('td');
    tdSrc.dataset.label = 'Source';
    const badge = document.createElement('span');
    badge.className = 'category-badge income-source-badge';
    badge.textContent = entry.source || '-';
    tdSrc.appendChild(badge);
    tr.appendChild(tdSrc);

    const tdPay = document.createElement('td');
    tdPay.dataset.label = 'Payment';
    tdPay.textContent = entry.paymentType || '-';
    tr.appendChild(tdPay);

    const tdBank = document.createElement('td');
    tdBank.dataset.label = 'Bank';
    tdBank.textContent = entry.bank || '-';
    tr.appendChild(tdBank);

    const tdNotes = document.createElement('td');
    tdNotes.dataset.label = 'Notes';
    tdNotes.textContent = entry.notes || '-';
    tr.appendChild(tdNotes);

    const tdAmt = document.createElement('td');
    tdAmt.dataset.label = 'Amount';
    tdAmt.className = 'text-right income-amount-cell';
    tdAmt.textContent = fmt(entry.amount);
    tr.appendChild(tdAmt);

    const tdAct = document.createElement('td');
    tdAct.className = 'text-center';
    tdAct.innerHTML = `<div class='action-buttons'><button class='btn-action edit' data-edit-income='${entry.id}' title='Edit'><i class='lucide' data-lucide='pencil'></i></button><button class='btn-action delete' data-delete-income='${entry.id}' title='Delete'><i class='lucide' data-lucide='trash-2'></i></button></div>`;
    tr.appendChild(tdAct);

    tbody.appendChild(tr);
  });
  if (window.lucide) lucide.createIcons();
}

// ── Sorting ──────────────────────────────────────────────────
window.sortIncomeHistory = (col) => {
  if (incSortCol === col) {
    incSortAsc = !incSortAsc;
  } else {
    incSortCol = col;
    incSortAsc = col === 'amount' ? false : true;
  }
  incHistoryPage = 1;
  renderIncomeHistory(filteredIncome);
};

// ── Pagination ───────────────────────────────────────────────
window.goToIncHistoryPage = (p) => {
  incHistoryPage = p;
  renderIncomeHistory(filteredIncome || allIncome);
  const card = document.querySelector('#income-history-section .table-card');
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

function renderIncPagination(totalItems, totalPages) {
  const el = document.getElementById('inc-history-pagination');
  if (!el) return;
  if (totalPages <= 1) { el.innerHTML = ''; return; }

  const MAX_VISIBLE = 7;
  let startP = Math.max(1, incHistoryPage - Math.floor(MAX_VISIBLE / 2));
  let endP = Math.min(totalPages, startP + MAX_VISIBLE - 1);
  if (endP - startP + 1 < MAX_VISIBLE) startP = Math.max(1, endP - MAX_VISIBLE + 1);

  let html = `<button class="page-btn" data-page-action="income" data-page="${incHistoryPage - 1}" ${incHistoryPage === 1 ? 'disabled' : ''}><i data-lucide="chevron-left"></i></button>`;
  if (startP > 1) {
    html += `<button class="page-btn" data-page-action="income" data-page="1">1</button>`;
    if (startP > 2) html += `<span class="pagination-dots">…</span>`;
  }
  for (let i = startP; i <= endP; i++) {
    html += `<button class="page-btn${i === incHistoryPage ? ' active' : ''}" data-page-action="income" data-page="${i}">${i}</button>`;
  }
  if (endP < totalPages) {
    if (endP < totalPages - 1) html += `<span class="pagination-dots">…</span>`;
    html += `<button class="page-btn" data-page-action="income" data-page="${totalPages}">${totalPages}</button>`;
  }
  const from = (incHistoryPage - 1) * INC_HISTORY_PER_PAGE + 1;
  const to = Math.min(incHistoryPage * INC_HISTORY_PER_PAGE, totalItems);
  html += `<span class="pagination-info">${from}–${to} of ${totalItems}</span>`;
  html += `<button class="page-btn" data-page-action="income" data-page="${incHistoryPage + 1}" ${incHistoryPage === totalPages ? 'disabled' : ''}><i data-lucide="chevron-right"></i></button>`;

  el.innerHTML = html;
  if (window.lucide) lucide.createIcons();
}

// ── Filters ──────────────────────────────────────────────────
window.applyIncomeFilters = () => {
  const from = document.getElementById('inc-filter-from').value;
  const to = document.getElementById('inc-filter-to').value;
  const pay = document.getElementById('inc-filter-payment').value;
  const q = document.getElementById('inc-filter-search') ? document.getElementById('inc-filter-search').value.toLowerCase().trim() : '';

  let data = allIncome.slice();
  if (from) data = data.filter(i => i.date >= from);
  if (to) data = data.filter(i => i.date <= to);
  if (pay) data = data.filter(i => i.paymentType === pay);
  if (q) {
    data = data.filter(i =>
      (i.source || '').toLowerCase().includes(q) ||
      (i.bank || '').toLowerCase().includes(q) ||
      (i.notes || '').toLowerCase().includes(q)
    );
  }

  incHistoryPage = 1;
  renderIncomeHistory(data);
  updateIncomeFilterCount(from, to, pay, q);
};

window.clearIncomeFilters = () => {
  ['inc-filter-from', 'inc-filter-to', 'inc-filter-payment', 'inc-filter-search'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  incHistoryPage = 1;
  renderIncomeHistory(allIncome);
  updateIncomeFilterCount('', '', '', '');
};

function updateIncomeFilterCount(from, to, pay, q) {
  const badge = document.getElementById('inc-filter-count');
  if (!badge) return;
  
  let activeCount = 0;
  if (from) activeCount++;
  if (to) activeCount++;
  if (pay) activeCount++;
  if (q) activeCount++;
  
  badge.textContent = `${activeCount} active`;
  badge.style.opacity = activeCount > 0 ? '1' : '0.6';
  
  // Update field highlighting
  updateFieldHighlight('inc-filter-from', from);
  updateFieldHighlight('inc-filter-to', to);
  updateFieldHighlight('inc-filter-payment', pay);
  updateFieldHighlight('inc-filter-search', q);
}

// ── Edit Income (from history page) ──────────────────────────
window.openIncEdit = (id) => {
  const entry = allIncome.find(i => i.id === id);
  if (!entry) return;
  editingIncId = id;

  document.getElementById('inc-edit-amount').value = entry.amount;
  document.getElementById('inc-edit-date').value = entry.date;
  document.getElementById('inc-edit-source').value = entry.source || '';
  document.getElementById('inc-edit-payment').value = entry.paymentType || 'Online';
  document.getElementById('inc-edit-bank').value = entry.bank || '';
  document.getElementById('inc-edit-notes').value = entry.notes || '';
  toggleIncEditBank(entry.paymentType || 'Online');

  document.getElementById('inc-edit-error').classList.add('hidden');
  document.getElementById('inc-edit-modal').classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
};

window.closeIncEditModal = () => {
  document.getElementById('inc-edit-modal').classList.add('hidden');
  editingIncId = null;
};

window.toggleIncEditBank = (val) => {
  const wrap = document.getElementById('inc-edit-bank-wrap');
  if (!wrap) return;
  wrap.style.display = val === 'Online' ? '' : 'none';
  if (val === 'Cash') {
    const inp = document.getElementById('inc-edit-bank');
    if (inp) inp.value = '';
  }
};

window.saveIncEdit = async () => {
  if (!editingIncId) return;

  const amount = parseFloat(document.getElementById('inc-edit-amount').value);
  const date = document.getElementById('inc-edit-date').value;
  const source = document.getElementById('inc-edit-source').value.trim();
  const paymentType = document.getElementById('inc-edit-payment').value;
  const bank = paymentType === 'Online' ? document.getElementById('inc-edit-bank').value.trim() : '';
  const notes = document.getElementById('inc-edit-notes').value.trim();

  const errEl = document.getElementById('inc-edit-error');

  if (!amount || amount <= 0) { errEl.textContent = 'Enter a valid amount.'; errEl.classList.remove('hidden'); return; }
  if (!date) { errEl.textContent = 'Select a date.'; errEl.classList.remove('hidden'); return; }
  if (!source) { errEl.textContent = 'Enter income source.'; errEl.classList.remove('hidden'); return; }
  if (paymentType === 'Online' && !bank) { errEl.textContent = 'Enter bank/wallet name.'; errEl.classList.remove('hidden'); return; }

  try {
    showLoader();
    await updateDoc(doc(db, 'income', editingIncId), {
      amount, date, source, paymentType, bank: bank || '', notes: notes || '', encoding: 'plain'
    });

    const idx = allIncome.findIndex(i => i.id === editingIncId);
    if (idx >= 0) {
      allIncome[idx] = { ...allIncome[idx], amount, date, source, paymentType, bank: bank || '', notes: notes || '' };
      allIncome.sort((a, b) => b.date.localeCompare(a.date));
    }

    renderIncomeHistory();
    updateIncomeCards();
    closeIncEditModal();
    hideLoader();
    showToast('Income updated!', 'success');
  } catch (e) {
    console.error(e);
    errEl.textContent = 'Failed to update. Try again.';
    errEl.classList.remove('hidden');
    hideLoader();
  }
};

// ── Delete Income (from history page) ────────────────────────
window.deleteIncEntry = (id) => {
  incDeleteTarget = id;
  document.getElementById('inc-delete-modal').classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
};

window.closeIncDeleteModal = () => {
  document.getElementById('inc-delete-modal').classList.add('hidden');
  incDeleteTarget = null;
};

window.confirmIncDelete = async () => {
  if (!incDeleteTarget) return;
  try {
    showLoader();
    await deleteDoc(doc(db, 'income', incDeleteTarget));
    allIncome = allIncome.filter(i => i.id !== incDeleteTarget);
    renderIncomeHistory();
    updateIncomeCards();
    hideLoader();
    showToast('Income entry deleted.', 'success');
  } catch (e) {
    showToast('Delete failed.', 'error');
    hideLoader();
  }
  closeIncDeleteModal();
};

window.deleteFromIncEdit = () => {
  if (!editingIncId) return;
  incDeleteTarget = editingIncId;
  closeIncEditModal();
  document.getElementById('inc-delete-modal').classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
};

// ── CSV Download ─────────────────────────────────────────────
window.downloadIncomeHistoryCSV = () => {
  const rows = filteredIncome || allIncome;
  if (!rows.length) { showToast('No data to export.', 'error'); return; }
  const hdr = ['Date', 'Source', 'Payment Type', 'Bank/Wallet', 'Notes', 'Amount (Rs)'];
  const csv = [hdr.join(','), ...rows.map(i => [
    i.date,
    '"' + (i.source || '').replace(/"/g, '""') + '"',
    '"' + (i.paymentType || '') + '"',
    '"' + (i.bank || '').replace(/"/g, '""') + '"',
    '"' + (i.notes || '').replace(/"/g, '""') + '"',
    i.amount.toFixed(2)
  ].join(','))].join('\n');

  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'SpendWise_Income_History_' + todayStr() + '.csv';
  a.click();
  showToast('CSV downloaded!', 'success');
};