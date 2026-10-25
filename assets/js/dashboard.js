// SpendWise app.js - Firebase Modular SDK

import { auth, gProvider, db } from './config/firebase.js';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, signInWithPopup, onAuthStateChanged, signOut, updateProfile, sendPasswordResetEmail, sendEmailVerification } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { collection, addDoc, getDocs, deleteDoc, doc, query, where, serverTimestamp, updateDoc, writeBatch } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// Currency helpers from global scope (currency.js loads before this module)
const fmt = window.fmt;
const fmtCompact = window.fmtCompact;
const getCurrency = window.getCurrency;
const getCurrencyInfo = window.getCurrencyInfo;
const buildCurrencyOptions = window.buildCurrencyOptions;
const updateCurrencyDisplay = window.updateCurrencyDisplay;
const setCurrency = window.setCurrency;

// Sanitize helper from utils
import { sanitize, friendlyErr, isSpending, normalizeCategory, budgetState, goalPace, financeScore, splitAmount, countTo, dueRecurring, upcomingBills, addMonths, shortDay, pad, todayStr, formatDate, getWeekStart, emiPlans, forecast, SKIP_KEY, isSkippedBill, debtLeft } from './utils/helpers.js';
import { showToast, dismissPageLoader, updateUserAvatar, initCurrencySelector, installMenus } from './modules/page-shell.js';
import { historyRange, filterHistory, historyDay, searchTag, totalsBy, tagsInUse } from './modules/history-data.js';
import { buildCsv, exportFileName } from './modules/csv-export.js';
import { getBudget } from './modules/budget.js';
import { getGoals } from './modules/goals.js';
import { portfolio, linkedToGoals, withLinked } from './modules/invest-data.js';
import { getSplit, resetSplit, splitDebts, fetchSharedDebts, announceDebts } from './modules/split.js';
import { setKnownPeople } from './modules/people.js';

// Firebase Web API keys are safe to be public — Firebase explicitly documents this.
// Security is enforced by Firebase Auth (only authenticated users can read/write)
// and Firestore Security Rules (uid-scoped data access).
// To further restrict this key: Firebase Console → Project Settings → API key restrictions
// → add shuvrasankha.github.io under "Application restrictions".


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

// ── sessionStorage cache helpers ──────────────────────────────────────────────
// Using sessionStorage instead of localStorage for financial data security.
// Session storage is cleared when the browser tab is closed, reducing the
// window of exposure if an XSS vulnerability is exploited.
const CACHE_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

// kind: 'expenses', 'income' or 'debts'
function getCacheKey(uid, kind = 'expenses') { return 'spendwise_' + kind + '_' + uid; }

function saveToCache(uid, list, kind = 'expenses') {
  try {
    const payload = JSON.stringify({ ts: Date.now(), data: list });
    sessionStorage.setItem(getCacheKey(uid, kind), payload);
  } catch (e) { /* quota exceeded or private mode — silently skip */ }
}

function loadFromCache(uid, kind = 'expenses') {
  try {
    const raw = sessionStorage.getItem(getCacheKey(uid, kind));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.ts > CACHE_MAX_AGE_MS) {
      sessionStorage.removeItem(getCacheKey(uid, kind));
      return null;
    }
    if (!Array.isArray(parsed.data)) return null;
    // A cache written before categories were merged still has the old names
    return kind === 'expenses' ? parsed.data.map(e => ({ ...e, category: normalizeCategory(e.category) })) : parsed.data;
  } catch { return null; }
}

function clearCache(uid) {
  try { ['expenses', 'income', 'debts', 'holdings'].forEach(kind => sessionStorage.removeItem(getCacheKey(uid, kind))); } catch { /* ignore */ }
}

let currentUser = null, allExpenses = [], allIncome = [], allDebts = [], allHoldings = [], activeTab = "weekly", deleteTarget = null, editingExpenseId = null;

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
    initCurrencySelector(refreshMoney);

    // ── Cache-first strategy ──
    // Income and debts first, so the home totals are complete on the first paint
    allIncome = loadFromCache(user.uid, 'income') || [];
    allDebts = loadFromCache(user.uid, 'debts') || [];
    allHoldings = loadFromCache(user.uid, 'holdings') || [];
    setKnownPeople(allDebts);
    const cached = loadFromCache(user.uid);
    if (cached && cached.length) {
      // Render from cache instantly — no skeleton delay
      allExpenses = cached;
      // Only update elements that exist on this page
      if (document.getElementById("home-spent")) {
        updateCards();
        renderDashboardTable();
        populateYearPicker();
        initPeriodPicker();
        updatePeriodSummary();
        requestAnimationFrame(() => { renderTrendChart(); });
      }
      if (document.getElementById("history-list")) {
        renderHistory();
      }
      // Silently sync with Firestore in the background
      setTimeout(() => loadExpenses(true), 0);
    } else {
      // No cache — show skeleton and fetch from Firestore
      if (document.getElementById("table-body")) showTableSkeleton("table-body", 5);
      setTimeout(() => loadExpenses(), 0);
    }
    // Refresh income and debts in the background
    setTimeout(() => loadIncome(), 0);
    setTimeout(() => loadDebts(), 0);
    if (document.getElementById("home-goals")) setTimeout(() => loadHoldings(), 0);

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

// Profile and mobile menus, page links and Logout; this page's sign-in screen takes over after logout
installMenus({ beforeLogout: () => { if (currentUser) clearCache(currentUser.uid); allExpenses = []; } });

function showAuthError(msg, isSuccess = false) {
  const el = document.getElementById("auth-error");
  el.textContent = msg;
  el.classList.remove("hidden");
  if (isSuccess) el.style.color = "#10b981";
  else el.style.removeProperty('color');
}

window.showPage = (page) => {
  const pageEl = document.getElementById("page-" + page);
  if (!pageEl) return; // Page doesn't exist on this HTML file
  document.querySelectorAll(".page").forEach(p => p.classList.add("hidden"));
  document.querySelectorAll(".sidebar-btn, .bottom-nav-btn").forEach(b => { b.classList.remove("active"); b.removeAttribute("aria-current"); });
  pageEl.classList.remove("hidden");
  const sBtn = document.getElementById("snav-" + page); if (sBtn) { sBtn.classList.add("active"); sBtn.setAttribute("aria-current", "page"); }
  const bBtn = document.getElementById("bnav-" + page); if (bBtn) { bBtn.classList.add("active"); bBtn.setAttribute("aria-current", "page"); }

  // Voice FAB: only visible on the "add expense" page
  const voiceFab = document.getElementById('voice-fab');
  if (voiceFab) voiceFab.style.display = (page === 'add') ? '' : 'none';

  if (page === "dashboard") {
    renderDashboardTable();
    // Defer chart rendering to avoid blocking UI interactions
    requestAnimationFrame(() => {
      renderTrendChart();
    });
  }
  if (page === "history") renderHistory();
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
      // Very old records hold base64 amounts, which parse as NaN and show as 0
      const amt = parseFloat(raw.amount);
      return {
        id: d.id, ...raw,
        amount: isNaN(amt) ? 0 : amt,
        category: normalizeCategory(raw.category), // older names show under the merged ones
        cardName: raw.cardName || "",
        description: raw.description || "",
        notes: raw.notes || ""
      };
    });
    // Sort client-side — no Firestore index required
    allExpenses.sort((a, b) => b.date.localeCompare(a.date));

    // Save to localStorage cache
    saveToCache(currentUser.uid, allExpenses);
    expensesFresh = true;

    // Render lightweight content immediately — only if elements exist
    if (document.getElementById("home-spent")) {
      updateCards();
      renderDashboardTable();
      populateYearPicker();
      initPeriodPicker();
      updatePeriodSummary();
    }
    if (document.getElementById("history-list")) {
      renderHistory();
    }
    // Update expense summary cards (expense page)
    if (document.getElementById("exp-monthly")) {
      updateExpenseCards();
    }

    // Defer chart rendering to next frame to avoid blocking
    requestAnimationFrame(() => {
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
    saveToCache(currentUser.uid, allIncome, 'income');
    updateIncomeCards();
    // If on history page, render income history
    if (document.getElementById("history-list")) {
      renderIncomeHistory();
    }
  } catch (e) { console.error("Income load error:", e); }
}

// ── Load holdings (Investments): a goal counts what its linked holdings are worth ──
async function loadHoldings() {
  if (!currentUser) return;
  try {
    const snap = await getDocs(query(collection(db, "holdings"), where("uid", "==", currentUser.uid)));
    allHoldings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    saveToCache(currentUser.uid, allHoldings, 'holdings');
    renderHome();
  } catch (e) { console.warn("Holdings unavailable:", e); } // e.g. before the updated rules are published
}

// Goals with what their linked holdings are worth counted in (invest-data.js)
function goalsWithHoldings() {
  const linked = linkedToGoals(portfolio(allHoldings, allExpenses, todayStr()).rows);
  return getGoals().map(g => withLinked(g, linked));
}

// ── Load Debts ───────────────────────────────────────────────────────────────
async function loadDebts() {
  if (!currentUser) return;
  try {
    const q = query(collection(db, "debts"), where("uid", "==", currentUser.uid));
    const [snap, shared] = await Promise.all([getDocs(q), fetchSharedDebts(currentUser)]);
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
    }).concat(shared);
    allDebts.sort((a, b) => b.date.localeCompare(a.date));
    saveToCache(currentUser.uid, allDebts, 'debts');
    setKnownPeople(allDebts);
    updateDebtCards();
  } catch (e) { console.error("Debt load error:", e); }
}

// ── Home: this month at a glance (expenses, income and debts together) ──────
// Every loader calls this, so the numbers agree whichever data arrives first.
function moneyWhole(n) {
  const c = getCurrencyInfo(getCurrency());
  return `${c.symbol} ${Math.round(n).toLocaleString(c.locale)}`;
}
// Bars and goal rings fill up on Home's first paint only; later redraws (sync, budget, goals) just update them
let growBars = true;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function renderHome() {
  const spentEl = document.getElementById("home-spent");
  if (!spentEl) return;
  const now = new Date();
  const today = todayStr();
  const ms = today.slice(0, 8) + "01";
  const monthAll = allExpenses.filter(e => e.date >= ms && e.date <= today);
  const monthExp = monthAll.filter(isSpending);
  const monthInc = allIncome.filter(i => i.date >= ms && i.date <= today);
  const spent = monthExp.reduce((sum, e) => sum + e.amount, 0);
  const invested = monthAll.reduce((sum, e) => sum + e.amount, 0) - spent;
  const income = monthInc.reduce((sum, i) => sum + i.amount, 0);
  const day = now.getDate();
  const monthDays = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const monthName = now.toLocaleDateString("en-US", { month: "long" });

  // Hero: spent so far, against the budget (or else income), and the pace
  document.getElementById("home-month-label").textContent = `${monthName} so far`;
  countTo(spentEl, spent, moneyWhole);
  const meter = document.getElementById("home-meter");
  const meterText = document.getElementById("home-meter-text");
  const budget = getBudget();
  const limit = budgetState(spent, budget.total);
  const budgetLink = document.getElementById("home-budget-label");
  if (budgetLink) budgetLink.textContent = budget.total ? "Change budget" : "Set a monthly budget";
  meter.classList.remove("near");
  if (limit) {
    meter.classList.remove("hidden");
    meter.classList.toggle("over", limit.state === "over");
    meter.classList.toggle("near", limit.state === "near");
    document.getElementById("home-meter-fill").style.width = `${Math.min(limit.ratio, 1) * 100}%`;
    meterText.textContent = limit.state === "over"
      ? `${moneyWhole(-limit.left)} over your ${moneyWhole(budget.total)} budget`
      : `${Math.round(limit.ratio * 100)}% of your ${moneyWhole(budget.total)} budget · ${moneyWhole(limit.left)} left`;
    meter.setAttribute("aria-label", meterText.textContent);
  } else if (income > 0) {
    const ratio = spent / income;
    meter.classList.remove("hidden");
    meter.classList.toggle("over", ratio > 1);
    document.getElementById("home-meter-fill").style.width = `${Math.min(ratio, 1) * 100}%`;
    meterText.textContent = ratio > 1
      ? `${moneyWhole(spent - income)} more than your ${moneyWhole(income)} income`
      : `${Math.round(ratio * 100)}% of your ${moneyWhole(income)} income · ${moneyWhole(income - spent)} left`;
    meter.setAttribute("aria-label", meterText.textContent);
  } else {
    meter.classList.add("hidden");
    meterText.textContent = "Add this month's income to see how much is left.";
  }
  document.getElementById("home-pace").textContent = spent > 0
    // forecast(): spent + bills still due + usual flexible pace (Insights shows the breakdown)
    ? `${moneyWhole(spent / day)} a day · on track for ${moneyWhole(forecast(allExpenses, today, isSkipped).total)} by the end of ${monthName}`
    : "";

  // Today: the day's spending as the card's figure, against the average of the month's earlier days
  const todays = allExpenses.filter(e => e.date === today);
  const todaySpent = todays.filter(isSpending).reduce((sum, e) => sum + e.amount, 0);
  document.getElementById("home-today-count").textContent = todays.length ? plural(todays.length, "entry", "entries") : "";
  document.getElementById("home-today-summary").classList.toggle("hidden", !todays.length);
  if (todays.length) countTo(document.getElementById("home-today-total"), todaySpent, moneyWhole);
  const average = day > 1 ? (spent - todaySpent) / (day - 1) : 0;
  const todayMeter = document.getElementById("home-today-meter");
  const compare = document.getElementById("home-today-compare");
  todayMeter.classList.toggle("hidden", !(todays.length && average > 0));
  if (todays.length && average > 0) {
    const scale = Math.max(todaySpent, average) * 1.1; // room past the larger, so the average tick never sits on the end
    const over = todaySpent > average;
    todayMeter.classList.toggle("over", over);
    document.getElementById("home-today-fill").style.width = `${(todaySpent / scale) * 100}%`;
    document.getElementById("home-today-avg").style.left = `${(average / scale) * 100}%`;
    const gap = Math.abs(todaySpent - average);
    compare.textContent = gap < 1 ? `Right on your daily average of ${moneyWhole(average)}`
      : `${moneyWhole(gap)} ${over ? "more" : "less"} than your daily average of ${moneyWhole(average)}`;
  } else {
    compare.textContent = todays.length ? "Your daily average shows here from tomorrow" : "";
  }
  const list = document.getElementById("home-today-list");
  // A new account (no expenses even after loading them) is pointed at its first entry
  const firstTime = expensesFresh && !allExpenses.length;
  list.parentElement.querySelector(".home-more")?.classList.toggle("hidden", firstTime); // nothing to list yet
  if (!todays.length) {
    const li = document.createElement("li");
    li.className = "home-empty";
    const add = document.createElement("a");
    add.href = "expense.html";
    add.textContent = firstTime ? "Add your first expense" : "Add an expense";
    if (firstTime) li.append(add, " to start tracking. It takes a few seconds.");
    else li.append("Nothing added today yet. ", add);
    list.replaceChildren(li);
  } else {
    // A row per entry: category icon, what it was, how it was paid, the amount. The category is left
    // out of the subtitle when it is already the title.
    list.replaceChildren(...todays.slice(0, 5).map(e => {
      const li = document.createElement("li");
      li.className = "today-row";
      const icon = document.createElement("span");
      icon.className = "today-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = `<i data-lucide="${CATEGORY_ICONS[normalizeCategory(e.category)] || "receipt"}"></i>`;
      const body = document.createElement("div");
      body.className = "today-row-body";
      const main = document.createElement("div");
      main.className = "home-row-main";
      const title = document.createElement("span");
      title.className = "home-row-title";
      const named = e.description && e.description !== "-" ? e.description : "";
      title.textContent = named || e.category;
      const meta = document.createElement("span");
      meta.className = "home-row-meta";
      meta.textContent = [named && named.toLowerCase() !== String(e.category).toLowerCase() ? e.category : "", e.payment, e.pending ? "waiting to sync" : ""].filter(Boolean).join(" · ");
      main.append(title, meta);
      const amount = document.createElement("span");
      amount.className = "home-row-amount";
      amount.textContent = fmt(e.amount);
      body.append(main, amount);
      li.append(icon, body);
      return li;
    }));
    window.lucide?.createIcons();
  }

  // Tiles: income, saved, debts (owe and owed are separate directions)
  const incomeEl = document.getElementById("home-income");
  if (income > 0) countTo(incomeEl, income, moneyWhole);
  else { incomeEl.textContent = "—"; delete incomeEl.dataset.value; }
  document.getElementById("home-income-sub").textContent = monthInc.length ? `${plural(monthInc.length, "entry", "entries")} this month` : "None this month";
  const savedEl = document.getElementById("home-saved");
  const savedSub = document.getElementById("home-saved-sub");
  if (income > 0) {
    const saved = income - spent;
    countTo(savedEl, saved, v => v < 0 ? `−${moneyWhole(-v)}` : moneyWhole(v));
    savedSub.textContent = saved < 0 ? "Overspent this month" : `${Math.round((saved / income) * 100)}% of income`;
  } else {
    savedEl.textContent = "—";
    delete savedEl.dataset.value;
    savedSub.textContent = "Needs income entries";
  }
  if (invested > 0) savedSub.textContent += ` · ${moneyWhole(invested)} invested`;
  renderGoals(income > 0 ? income - spent : null);
  const active = allDebts.filter(d => !d.settled);
  const owe = active.filter(d => d.type === "i-owe").reduce((sum, d) => sum + debtLeft(d), 0); // less part-payments
  countTo(document.getElementById("home-owe"), owe, moneyWhole);

  // Money score: savings, investing, budget pace, debt and goals rolled into one number
  const score = financeScore({ income, spent, invested, budget: budget.total, monthShare: day / monthDays, owe, goals: goalsWithHoldings().map(g => goalPace(g, today)) });
  const scoreEl = document.getElementById("home-score");
  const scoreTile = document.getElementById("home-score-tile");
  scoreTile.classList.remove("great", "good", "fair", "low");
  scoreTile.classList.toggle("empty", !score);
  document.getElementById("home-score-cta").classList.toggle("hidden", !!score);
  document.getElementById("home-score-why").classList.toggle("hidden", !score);
  if (score) {
    countTo(scoreEl, score.score, Math.round);
    document.getElementById("home-score-label").textContent = score.label;
    document.getElementById("home-score-sub").textContent = score.tip;
    scoreTile.classList.add(score.score >= 80 ? "great" : score.score >= 60 ? "good" : score.score >= 40 ? "fair" : "low");
    document.getElementById("home-score-parts").innerHTML = score.parts.map(({ name, value }) => {
      const pct = Math.round(value * 100);
      return `<li class="score-part${value < 0.5 ? " weak" : ""}">
        <span class="score-part-name">${name}</span>
        <span class="score-part-bar" role="progressbar" aria-label="${name}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${Math.max(pct, 2)}%"></span></span>
        <span class="score-part-pct">${pct}%</span>
      </li>`;
    }).join("");
  } else {
    scoreEl.textContent = "—";
    delete scoreEl.dataset.value;
    document.getElementById("home-score-label").textContent = "No score yet";
    document.getElementById("home-score-sub").textContent = "Add this month's income to see your score";
  }
  countTo(document.getElementById("home-owed"), active.filter(d => d.type === "they-owe").reduce((sum, d) => sum + debtLeft(d), 0), moneyWhole);

  // Where it went: this month's top categories, as labelled bars (readable without a chart)
  const byCat = {};
  monthExp.forEach(e => { byCat[e.category] = (byCat[e.category] || 0) + e.amount; });
  // Top five, plus any category close to or past its own limit so a warning is never cut off
  const sorted = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const cats = sorted.filter(([c, amount], i) => i < 5 || (budgetState(amount, budget.cats[c])?.state ?? "ok") !== "ok");
  document.getElementById("home-categories").innerHTML = cats.length ? cats.map(([category, amount]) => {
    const share = spent > 0 ? (amount / spent) * 100 : 0;
    const cap = budgetState(amount, budget.cats[category]);
    const width = cap ? Math.min(cap.ratio, 1) * 100 : share;
    const meta = cap
      ? (cap.state === "over" ? `${moneyWhole(-cap.left)} over the ${moneyWhole(budget.cats[category])} limit` : `${moneyWhole(amount)} of ${moneyWhole(budget.cats[category])} limit · ${moneyWhole(cap.left)} left`)
      : `${share.toFixed(0)}% of this month's spending`;
    return `<li class="glance-cat">
      <div class="glance-cat-row"><span class="glance-cat-name">${escapeHtml(category)}</span><span class="glance-cat-amount">${moneyWhole(amount)}</span></div>
      <div class="glance-bar${cap && cap.state !== "ok" ? " " + cap.state : ""}" aria-hidden="true"><span style="width:${Math.max(width, 2).toFixed(1)}%"></span></div>
      <div class="glance-cat-meta">${meta}</div>
    </li>`;
  }).join("") : `<li class="home-empty">${firstTime ? "Your top categories show here once you add expenses." : "No expenses this month yet."}</li>`;

  document.getElementById("home-categories").classList.toggle("grow", growBars);
  document.getElementById("home-goals")?.classList.toggle("grow", growBars);
  if (monthAll.length || getGoals().length) growBars = false; // keep it for the first paint that has something to show
  renderDue();
}

// Each expense category's icon, as on the Add expense form
const CATEGORY_ICONS = {
  "Food & Dining": "utensils", "Groceries": "shopping-cart", "Transport": "car", "Travel": "plane",
  "Shopping": "shopping-bag", "Bills & Utilities": "zap", "Home & Rent": "home", "Health": "heart-pulse",
  "Entertainment": "clapperboard", "Education": "graduation-cap", "Savings & Investments": "piggy-bank", "Other": "more-horizontal",
};

// ── Savings goals: progress and the monthly pace, against what this month left over ──
function renderGoals(savedThisMonth) {
  const list = document.getElementById("home-goals");
  if (!list) return;
  const today = todayStr();
  const goals = goalsWithHoldings().map(g => ({ g, pace: goalPace(g, today) }));
  const need = goals.reduce((sum, { pace }) => sum + pace.monthly, 0);
  const total = document.getElementById("home-goals-total");
  total.textContent = need > 0 ? `${moneyWhole(need)} a month` : "";
  total.classList.toggle("hidden", !(need > 0));
  const covered = need > 0 && savedThisMonth !== null && savedThisMonth >= need;
  total.classList.toggle("covered", covered);
  if (need > 0 && savedThisMonth !== null) {
    total.textContent += covered ? " · covered" : ` · ${moneyWhole(Math.max(savedThisMonth, 0))} left this month`;
  }
  const monthName = by => new Date(by + "-01T00:00").toLocaleDateString("en-US", { month: "short", year: "numeric" });
  const celebrating = goals.find(({ g, pace }) => g.id === celebrateGoal && pace.state === "done");
  celebrateGoal = null;
  list.innerHTML = goals.length ? goals.map(({ g, pace }) => {
    const party = celebrating?.g === g;
    const pct = Math.round(Math.min(pace.ratio, 1) * 100);
    const meta = pace.state === "done" ? "Reached. Well done!"
      : pace.state === "late" ? `${moneyWhole(pace.left)} to go · ${monthName(g.by)} has passed`
      : `<strong>${moneyWhole(pace.monthly)}</strong> a month · by ${monthName(g.by)}`;
    return `<li class="goal-card ${pace.state}${party ? " celebrate" : ""}">
      <div class="goal-ring" style="--p:${pct}" role="progressbar" aria-label="${escapeHtml(g.name)} saved" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
        ${pace.state === "done" ? `<i data-lucide="check" aria-hidden="true"></i>` : `<span aria-hidden="true">${pct}%</span>`}
        ${party ? `<span class="goal-burst" aria-hidden="true">${Array.from({ length: 12 }, (_, i) => `<span style="--a:${i * 30}deg"></span>`).join("")}</span>` : ""}
      </div>
      <div class="goal-body">
        <span class="goal-name">${escapeHtml(g.name)}</span>
        <span class="goal-amounts"><strong>${moneyWhole(g.saved)}</strong> of ${moneyWhole(g.target)}${g.linked ? ` · <a href="invest.html">${moneyWhole(g.linked)} invested</a>` : ""}</span>
        <span class="goal-meta">${meta}</span>
      </div>
      <div class="due-actions goal-actions">
        ${pace.state === "done" ? "" : `<button type="button" class="due-add" data-goal-add="${escapeHtml(g.id)}" aria-label="Add money to ${escapeHtml(g.name)}"><i data-lucide="plus" aria-hidden="true"></i>Add money</button>`}
        <button type="button" class="due-more" data-goal-edit="${escapeHtml(g.id)}" aria-label="Edit ${escapeHtml(g.name)}">Edit</button>
      </div>
    </li>`;
  }).join("") : `<li class="goals-empty"><span class="goals-empty-icon" aria-hidden="true"><i data-lucide="target"></i></span><span>Saving for a trip, a phone or a rainy day? Add a goal to see how much to put aside each month.</span></li>`;
  if (window.lucide) lucide.createIcons();
  if (celebrating) showToast(`You reached ${celebrating.g.name}. Well done!`, "success");
}

// ── Due this month: repeating expenses waiting for one tap ───────────────────
const isSkipped = isSkippedBill; // "Skip month", shared with Insights (helpers.js)
let dueItems = [];

function renderDue() {
  const section = document.getElementById("home-due");
  if (!section) return;
  dueItems = dueRecurring(allExpenses, todayStr(), isSkipped);
  section.classList.toggle("hidden", !dueItems.length);
  if (!dueItems.length) return;
  document.getElementById("home-due-total").textContent = moneyWhole(dueItems.reduce((sum, d) => sum + d.template.amount, 0));
  document.getElementById("home-due-list").innerHTML = dueItems.map((d, i) => {
    const t = d.template;
    const title = t.description && t.description !== "-" ? t.description : t.category;
    return `<li class="home-row due-row">
      <div class="home-row-main">
        <span class="home-row-title">${escapeHtml(title)}</span>
        <span class="home-row-meta">${d.emi ? `EMI ${d.emi.paid + 1} of ${d.emi.total} · ` : ""}${escapeHtml(t.category)} · due ${escapeHtml(shortDay(d.due))}</span>
      </div>
      <span class="home-row-amount">${moneyWhole(t.amount)}</span>
      <div class="due-actions">
        <button type="button" class="due-add" data-due-add="${i}" aria-label="Add ${escapeHtml(title)}, ${moneyWhole(t.amount)}">Add</button>
        <button type="button" class="due-more" data-due-skip="${i}" aria-label="Skip ${escapeHtml(title)} this month">Skip month</button>
        <button type="button" class="due-more" data-due-stop="${i}" aria-label="Stop repeating ${escapeHtml(title)}">Stop repeating</button>
      </div>
    </li>`;
  }).join("");
}

async function addDue(item) {
  const t = item.template;
  const data = { uid: currentUser.uid, amount: t.amount, category: t.category, date: item.due, payment: t.payment || "UPI",
    cardName: t.cardName || "", description: t.description || "-", notes: "", tags: t.tags || [], repeat: "monthly", encoding: "plain",
    ...(t.holdingId && { holdingId: t.holdingId }), // a SIP stays in its holding (Investments)
    // The newest entry is the series' template, so it carries the EMI on
    ...(t.emiTotal && { emiTotal: t.emiTotal, ...(t.emiPaidBefore && { emiPaidBefore: t.emiPaidBefore }) }) };
  const local = { ...data, uid: undefined, encoding: undefined };
  if (window.isOffline?.() && window.addToOfflineQueue) {
    const queueId = window.addToOfflineQueue("expense", { ...data, createdAt: serverTimestamp() });
    const tempId = "offline-" + Date.now();
    allExpenses.unshift({ ...local, id: tempId, pending: true });
    allExpenses.sort((a, b) => b.date.localeCompare(a.date));
    refreshExpenseViews();
    showUndoToast("Saved offline.", () => { window.removeFromOfflineQueue(queueId); removeLocalExpense(tempId); });
    return;
  }
  const ref = await addDoc(collection(db, "expenses"), { ...data, createdAt: serverTimestamp() });
  allExpenses.unshift({ ...local, id: ref.id });
  allExpenses.sort((a, b) => b.date.localeCompare(a.date));
  refreshExpenseViews();
  showUndoToast(`${data.description !== "-" ? data.description : data.category} added.`, async () => {
    await deleteDoc(doc(db, "expenses", ref.id));
    removeLocalExpense(ref.id);
  });
  window.markLoggedToday?.();
}

document.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-due-add], [data-due-skip], [data-due-stop]");
  if (!btn || !currentUser) return;
  const item = dueItems[+(btn.dataset.dueAdd ?? btn.dataset.dueSkip ?? btn.dataset.dueStop)];
  if (!item) return;
  btn.disabled = true;
  try {
    if (btn.dataset.dueAdd !== undefined) {
      await addDue(item);
    } else if (btn.dataset.dueSkip !== undefined) {
      try { localStorage.setItem(SKIP_KEY + item.key + ":" + item.due.slice(0, 7), "1"); } catch { /* ignore */ }
      renderDue();
    } else {
      const t = item.template;
      if (t.pending) { showToast("This one is still waiting to sync. Try again once you're online.", "error"); btn.disabled = false; return; }
      await updateDoc(doc(db, "expenses", t.id), { repeat: "stopped" });
      t.repeat = "stopped";
      saveToCache(currentUser.uid, allExpenses);
      renderDue();
      showToast("It won't be suggested again. Past entries stay.", "success");
    }
  } catch (e) {
    console.error(e);
    btn.disabled = false;
    showToast("Couldn't do that. Check your connection and try again.", "error");
  }
});

// A budget saved from the profile menu redraws Home right away
window.addEventListener("spendwise:budget", () => renderHome());
let celebrateGoal = null; // a goal just taken past its target: its card celebrates on the next draw
window.addEventListener("spendwise:goals", e => { celebrateGoal = e.detail?.completed || null; renderHome(); });

// The old card updaters (still called by loaders and save paths) now redraw the home summary
function updateDebtCards() { renderHome(); }
function updateIncomeCards() { renderHome(); }

// ── EMIs (expense page): progress, what is left, the next payment and the last ──
function renderEmis() {
  const card = document.getElementById("emi-card");
  if (!card) return;
  const plans = emiPlans(allExpenses, todayStr());
  card.classList.toggle("hidden", !plans.length);
  if (!plans.length) return;
  const running = plans.filter(p => !p.done);
  document.getElementById("emi-card-total").textContent = running.length
    ? `${moneyWhole(running.reduce((sum, p) => sum + p.monthly, 0))} a month` : "All paid off";
  const monthName = m => new Date(m + "-01T00:00").toLocaleDateString("en-US", { month: "short", year: "numeric" });
  document.getElementById("emi-list").innerHTML = plans.map(p => {
    const pct = Math.round((p.paid / p.total) * 100);
    const facts = p.done
      ? [`Paid off ${monthName(p.ends)}`]
      : [`${moneyWhole(p.left)} left`, p.next < todayStr() ? `Due ${shortDay(p.next)}` : `Next ${shortDay(p.next)}`, `Ends ${monthName(p.ends)}`];
    return `<li class="emi-item${p.done ? " done" : ""}">
      <div class="emi-row">
        <span class="emi-name">${escapeHtml(p.title)}</span>
        <span class="emi-amount">${moneyWhole(p.monthly)}<small>/mo</small></span>
      </div>
      <div class="emi-bar" role="progressbar" aria-label="${escapeHtml(p.title)}: ${p.paid} of ${p.total} payments" aria-valuemin="0" aria-valuemax="${p.total}" aria-valuenow="${p.paid}"><span style="width:${Math.max(pct, 2)}%"></span></div>
      <div class="emi-meta"><strong>${p.paid} of ${p.total} paid</strong> · ${facts.map(escapeHtml).join(" · ")}</div>
    </li>`;
  }).join("");
}

// ── Update Expense Summary Cards (expense page) ─────────────────────────────
function updateExpenseCards() {
  renderRecentExpenses();
  renderEmis();
  orderCategoryTiles();
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
  const spending = allExpenses.filter(isSpending);
  const monthlyExpenses = spending.filter(e => e.date >= ms && e.date <= todayStr());
  const monthTotal = monthlyExpenses.reduce((s, e) => s + e.amount, 0);
  
  if (monthlyEl) countTo(monthlyEl, monthTotal, fmt);
  const monthCountEl = document.getElementById("exp-monthly-count");
  if (monthCountEl) monthCountEl.textContent = monthlyExpenses.length + ' entr' + (monthlyExpenses.length !== 1 ? 'ies' : 'y');
  
  // This year
  const yearlyExpenses = spending.filter(e => e.date && e.date.startsWith(yearStr));
  const yearTotal = yearlyExpenses.reduce((s, e) => s + e.amount, 0);
  
  if (yearlyEl) countTo(yearlyEl, yearTotal, fmt);
  const yearCountEl = document.getElementById("exp-yearly-count");
  if (yearCountEl) yearCountEl.textContent = yearlyExpenses.length + ' entr' + (yearlyExpenses.length !== 1 ? 'ies' : 'y');
  
  // Total
  const totalAmount = spending.reduce((s, e) => s + e.amount, 0);
  if (totalEl) countTo(totalEl, totalAmount, fmt);
  const totalCountEl = document.getElementById("exp-total-count");
  if (totalCountEl) totalCountEl.textContent = spending.length + ' entr' + (spending.length !== 1 ? 'ies' : 'y');
  
  // Daily average
  const today = new Date();
  const dayOfMonth = today.getDate();
  const dailyAvg = dayOfMonth > 0 ? monthTotal / dayOfMonth : 0;
  if (dailyAvgEl) countTo(dailyAvgEl, dailyAvg, fmt);
  const dailySubEl = document.getElementById("exp-daily-sub");
  if (dailySubEl) dailySubEl.textContent = `avg / day this month`;
}

// ── Expense page: quick entry helpers ───────────────────────────────────────
const LAST_PAYMENT_KEY = "spendwise_last_payment";
let lastAdded = null;       // { key, at } of the last saved expense, for the double-tap check
let confirmedDupKey = null; // set when the user taps Add again after the duplicate warning
let categoriesOrdered = false;

function lastPayment() {
  try { return localStorage.getItem(LAST_PAYMENT_KEY) || "UPI"; } catch { return "UPI"; }
}

function updatePaymentHint() {
  const sel = document.getElementById("exp-payment");
  const hint = document.getElementById("exp-more-hint");
  if (sel && hint) hint.textContent = sel.value;
}

function applyLastPayment() {
  const sel = document.getElementById("exp-payment");
  if (!sel) return;
  sel.value = lastPayment();
  toggleCardName("exp-card-name-wrap", sel.value);
  updatePaymentHint();
}

function rememberAdd(key, payment) {
  lastAdded = { key, at: Date.now() };
  confirmedDupKey = null;
  try { localStorage.setItem(LAST_PAYMENT_KEY, payment); } catch { /* ignore */ }
}

function syncDateChips() {
  const value = document.getElementById("exp-date")?.value;
  document.querySelectorAll("[data-date-offset]").forEach(chip => {
    const d = new Date(); d.setDate(d.getDate() - Number(chip.dataset.dateOffset));
    const on = value === todayStr(d);
    chip.classList.toggle("active", on);
    chip.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

// Most-used categories (last 60 days) first; done once per visit so tiles don't move under a finger
function orderCategoryTiles() {
  const picker = document.getElementById("category-picker");
  if (!picker || categoriesOrdered || !allExpenses.length) return;
  categoriesOrdered = true;
  const since = todayStr(new Date(Date.now() - 60 * 864e5));
  const counts = {};
  allExpenses.forEach(e => { if (e.date >= since) counts[e.category] = (counts[e.category] || 0) + 1; });
  [...picker.querySelectorAll(".cat-tile")]
    .map((tile, i) => ({ tile, i, n: counts[tile.dataset.value] || 0 }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .forEach(({ tile }) => picker.appendChild(tile));
}

// Today's entries under the form: confirms a save and lets mistakes be fixed without leaving the page
function renderRecentExpenses() {
  const list = document.getElementById("recent-expenses-list");
  if (!list) return;
  const today = todayStr();
  const items = allExpenses.filter(e => e.date === today);
  const totalEl = document.getElementById("recent-expenses-total");
  if (totalEl) totalEl.textContent = items.length ? fmt(items.reduce((sum, e) => sum + e.amount, 0)) : "";
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "recent-empty";
    li.textContent = "Nothing added today yet.";
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(...items.map(e => {
    const li = document.createElement("li");
    li.className = "recent-item";
    const main = document.createElement("div");
    main.className = "recent-main";
    const title = document.createElement("span");
    title.className = "recent-title";
    title.textContent = e.description && e.description !== "-" ? e.description : e.category;
    const meta = document.createElement("span");
    meta.className = "recent-meta";
    meta.textContent = [e.category, e.payment].filter(Boolean).join(" · ") + (e.pending ? " · waiting to sync" : "");
    main.append(title, meta);
    const amount = document.createElement("span");
    amount.className = "recent-amount";
    amount.textContent = fmt(e.amount);
    li.append(main, amount);
    if (!e.pending) { // queued offline entries have no document to edit yet
      const actions = document.createElement("div");
      actions.className = "action-buttons";
      actions.innerHTML = `<button class="btn-action edit" data-edit-expense="${e.id}" aria-label="Edit"><i data-lucide="pencil"></i></button><button class="btn-action delete" data-delete-expense="${e.id}" aria-label="Delete"><i data-lucide="trash-2"></i></button>`;
      li.append(actions);
    }
    return li;
  }));
  if (window.lucide) lucide.createIcons();
}

function refreshExpenseViews() {
  dashboardPage = 1; dashboardShown = DASHBOARD_PER_PAGE;
  updateCards();
  renderDashboardTable();
  renderHistory();
  updateExpenseCards();
  requestAnimationFrame(() => { renderTrendChart(); });
  saveToCache(currentUser.uid, allExpenses);
}

// "Expense added. Undo" for a few seconds after saving (undo beats a confirmation dialog)
let undoTimer = null;
function showUndoToast(msg, onUndo) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.className = "toast success";
  t.replaceChildren(document.createTextNode(msg));
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "toast-undo";
  btn.textContent = "Undo";
  btn.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    clearTimeout(undoTimer);
    t.classList.add("hidden");
    try { await onUndo(); showToast("Expense removed.", "success"); }
    catch { showToast("Couldn't undo. Delete it from Today's list instead.", "error"); }
  });
  t.append(btn);
  t.classList.remove("hidden");
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => t.classList.add("hidden"), 6000);
}

function removeLocalExpense(id) {
  allExpenses = allExpenses.filter(e => e.id !== id);
  refreshExpenseViews();
}

window.addExpense = async () => {
  let amount = parseFloat(document.getElementById("exp-amount").value);
  const category = document.getElementById("exp-category").value;
  const date = document.getElementById("exp-date").value;
  const payment = document.getElementById("exp-payment").value;
  const description = sanitize(document.getElementById("exp-description").value.trim(), 300);
  const notes = sanitize(document.getElementById("exp-notes").value.trim(), 500);
  const tags = getExpenseTags("exp");
  const repeat = document.getElementById("exp-repeat")?.checked ? "monthly" : null; // "Repeats every month"
  // An EMI: how many payments in all, and how many were made before SpendWise (this one not counted)
  const emiTotalRaw = repeat ? document.getElementById("exp-emi-total")?.value.trim() : "";
  const emiBeforeRaw = repeat ? document.getElementById("exp-emi-before")?.value.trim() : "";
  const emiTotal = emiTotalRaw ? Number(emiTotalRaw) : 0;
  const emiPaidBefore = emiBeforeRaw ? Number(emiBeforeRaw) : 0;
  if (!amount || amount <= 0) { showFormMsg("Enter a valid amount.", "error"); return; }
  if (emiTotalRaw && !(Number.isInteger(emiTotal) && emiTotal >= 2 && emiTotal <= 600)) { showFormMsg("Total payments should be a whole number from 2 to 600.", "error"); return; }
  if (emiBeforeRaw && !(Number.isInteger(emiPaidBefore) && emiPaidBefore >= 0 && (!emiTotal || emiPaidBefore < emiTotal))) {
    showFormMsg(emiTotal ? `Already paid should be a whole number below ${emiTotal}, counting this payment out.` : "Already paid needs Total payments too.", "error"); return;
  }
  if (emiBeforeRaw && emiPaidBefore > 0 && !emiTotal) { showFormMsg("Add Total payments for this EMI.", "error"); return; }
  const emi = emiTotal ? { emiTotal, ...(emiPaidBefore && { emiPaidBefore }) } : {};
  if (!category) { showFormMsg("Select a category.", "error"); return; }
  if (!date) { showFormMsg("Select a date.", "error"); return; }
  // Split: your share becomes the expense, and each person owes you theirs (modules/split.js)
  const split = getSplit();
  if (split?.error) { showFormMsg(split.error, "error"); return; }
  let debts = [];
  if (split) {
    const { each, mine } = splitAmount(amount, split.people.length);
    debts = splitDebts(split.people, each, { date, label: description || category });
    amount = mine;
  }
  const queueDebts = () => debts.map(d => window.addToOfflineQueue('debt', d));
  // The same amount + category + date again within 2 minutes is usually a double tap: ask once
  const dupKey = `${amount}|${category}|${date}`;
  if (lastAdded && lastAdded.key === dupKey && Date.now() - lastAdded.at < 120000 && confirmedDupKey !== dupKey) {
    confirmedDupKey = dupKey;
    showFormMsg(`You added ${fmt(amount)} for ${category} a moment ago. Tap Add Expense again to save it twice.`, "error");
    return;
  }
  try {
    const cardName = sanitize(document.getElementById("exp-card-name") ? document.getElementById("exp-card-name").value.trim() : "", 100);
    const expenseData = { uid: currentUser.uid, amount, category, date, payment, cardName: cardName || "", description: description || "-", notes, tags, encoding: "plain", createdAt: serverTimestamp() };
    if (repeat) Object.assign(expenseData, { repeat, ...emi });
    
    if (window.isOffline && window.isOffline()) {
      if (typeof window.addToOfflineQueue === 'function') {
        const queueId = window.addToOfflineQueue('expense', expenseData);
        const debtQueueIds = queueDebts();
        const tempId = 'offline-' + Date.now();
        allExpenses.unshift({ id: tempId, amount, category, date, payment, cardName: cardName || "", description: description || "-", notes, tags, pending: true, ...(repeat && { repeat, ...emi }) });
        allExpenses.sort((a, b) => b.date.localeCompare(a.date));
        dashboardPage = 1; dashboardShown = DASHBOARD_PER_PAGE;
        updateCards();
        renderDashboardTable();
        renderHistory();
        updateExpenseCards();
        requestAnimationFrame(() => {
          renderTrendChart();
        });
        saveToCache(currentUser.uid, allExpenses);
        resetForm();
        showFormMsg("Expense saved offline. Will sync when online.", "success");
        rememberAdd(dupKey, payment);
        showUndoToast("Saved offline.", () => { [queueId, ...debtQueueIds].forEach(window.removeFromOfflineQueue); removeLocalExpense(tempId); });
      } else {
        showFormMsg("Cannot save offline. Please check your connection.", "error");
      }
      return;
    }

    showLoader();
    // One batch, so an expense is never saved without its split debts or the other way round
    const batch = writeBatch(db);
    const ref = doc(collection(db, "expenses"));
    batch.set(ref, expenseData);
    const debtRefs = debts.map(d => { const r = doc(collection(db, "debts")); batch.set(r, d); return r; });
    await batch.commit();
    announceDebts(debtRefs, debts);
    allExpenses.unshift({ id: ref.id, amount, category, date, payment, cardName: cardName || "", description: description || "-", notes, tags, ...(repeat && { repeat, ...emi }) });
    allExpenses.sort((a, b) => b.date.localeCompare(a.date));
    dashboardPage = 1; dashboardShown = DASHBOARD_PER_PAGE;
    updateCards();
    renderDashboardTable();
    renderHistory();
    updateExpenseCards();
    requestAnimationFrame(() => {
      renderTrendChart();
      hideLoader();
    });
    saveToCache(currentUser.uid, allExpenses);
    resetForm();
    showFormMsg(debts.length ? `Your share added. ${debts.length === 1 ? "1 person owes" : `${debts.length} people owe`} you ${fmt(debts[0].amount)}${debts.length > 1 ? " each" : ""}, see Debts.` : "Expense added successfully!", "success");
    rememberAdd(dupKey, payment);
    showUndoToast(debts.length ? "Split saved." : "Expense added.", async () => {
      await Promise.all([ref, ...debtRefs].map(r => deleteDoc(r)));
      removeLocalExpense(ref.id);
    });
    window.markLoggedToday?.(); // skips today's reminder (reminders.js)
  } catch (e) { 
    console.error(e);
    if (window.addToOfflineQueue && navigator.onLine === false) {
      const cardName = sanitize(document.getElementById("exp-card-name") ? document.getElementById("exp-card-name").value.trim() : "", 100);
      const expenseData = { uid: currentUser.uid, amount, category, date, payment, cardName: cardName || "", description: description || "-", notes, tags, encoding: "plain", createdAt: serverTimestamp() };
    if (repeat) Object.assign(expenseData, { repeat, ...emi });
      const queueId = window.addToOfflineQueue('expense', expenseData);
      const debtQueueIds = queueDebts();
      const tempId = 'offline-' + Date.now();
      allExpenses.unshift({ id: tempId, amount, category, date, payment, cardName: cardName || "", description: description || "-", notes, tags, pending: true, ...(repeat && { repeat, ...emi }) });
      allExpenses.sort((a, b) => b.date.localeCompare(a.date));
      dashboardPage = 1; dashboardShown = DASHBOARD_PER_PAGE;
      updateCards();
      renderDashboardTable();
      renderHistory();
      updateExpenseCards();
      requestAnimationFrame(() => {
        renderTrendChart();
      });
      saveToCache(currentUser.uid, allExpenses);
      resetForm();
      showFormMsg("Saved offline due to error. Will sync when online.", "success");
      rememberAdd(dupKey, payment);
      showUndoToast("Saved offline.", () => { [queueId, ...debtQueueIds].forEach(window.removeFromOfflineQueue); removeLocalExpense(tempId); });
    } else {
      showFormMsg("Couldn't save the expense. Check your connection and try again.", "error"); 
    }
    hideLoader(); 
  }
};

window.resetForm = () => {
  resetSplit();
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
    dashboardPage = 1; dashboardShown = DASHBOARD_PER_PAGE;
    updateCards();
    renderDashboardTable();
    renderHistory();
    updateExpenseCards();
    // Defer chart rendering
    requestAnimationFrame(() => {
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
  if (!expense || expense.pending) return; // queued offline: no record to edit or delete until it syncs

  editingExpenseId = id;
  const editRepeat = document.getElementById("edit-repeat");
  if (editRepeat) editRepeat.checked = expense.repeat === "monthly";
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
    // Repeating: tick to start; unticking a repeating entry stops the series (it stays in the list)
    const before = allExpenses.find(e => e.id === editingExpenseId);
    const repeatOn = document.getElementById("edit-repeat")?.checked;
    const repeat = repeatOn ? "monthly" : before?.repeat === "monthly" ? "stopped" : before?.repeat;
    await updateDoc(expenseRef, {
      amount,
      category,
      date,
      payment,
      cardName: cardName || "",
      description: description || "-",
      notes: notes,
      tags,
      ...(repeat && { repeat }),
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
        tags,
        ...(repeat && { repeat })
      };
      allExpenses.sort((a, b) => b.date.localeCompare(a.date));
    }

    dashboardPage = 1; dashboardShown = DASHBOARD_PER_PAGE;
    updateCards();
    renderDashboardTable();
    renderHistory();
    updateExpenseCards();
    // Defer chart rendering
    requestAnimationFrame(() => {
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

function updateCards() { if (expensesFresh) syncPush(); renderHome(); }

// What the Worker needs for bill-due alerts and the month-end summary (reminders.js). Only from
// expenses read from Firestore, never the cached copy, which can be days old on this device.
let expensesFresh = false;
function syncPush() {
  window.syncBills?.(upcomingBills(allExpenses, todayStr(), isSkipped));
  const month = todayStr().slice(0, 7), prev = addMonths(month, -1);
  const spentIn = m => Math.round(allExpenses.filter(e => isSpending(e) && e.date.startsWith(m)).reduce((sum, e) => sum + e.amount, 0));
  window.syncMonthTotals?.({ [month]: spentIn(month), [prev]: spentIn(prev) });
}

window.switchTableTab = (tab) => {
  activeTab = tab;
  dashboardPage = 1; dashboardShown = DASHBOARD_PER_PAGE;
  document.querySelectorAll(".table-tab").forEach(t => t.classList.remove("active"));
  document.getElementById("ttab-" + tab).classList.add("active");
  renderDashboardTable();
  // Defer chart updates to avoid blocking
  requestAnimationFrame(() => {
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

  showTableRows(allExpenses.filter(e => e.date >= from && e.date <= today));
}

// The table's rows: phones get one growing list with "Show more", wider screens page numbers
function showTableRows(rows) {
  if (phoneTable.matches) {
    renderTable("table-body", rows.slice(0, dashboardShown), false);
    renderDashboardShowMore(rows.length);
    return;
  }
  const totalPages = Math.max(1, Math.ceil(rows.length / DASHBOARD_PER_PAGE));
  if (dashboardPage > totalPages) dashboardPage = totalPages;
  const start = (dashboardPage - 1) * DASHBOARD_PER_PAGE;
  renderTable("table-body", rows.slice(start, start + DASHBOARD_PER_PAGE), false);
  renderDashboardPagination(rows.length, totalPages);
}

function renderDashboardShowMore(totalItems) {
  const el = document.getElementById("dashboard-pagination");
  if (!el) return;
  const shown = Math.min(dashboardShown, totalItems);
  if (shown >= totalItems) { el.innerHTML = ""; return; }
  const next = Math.min(DASHBOARD_PER_PAGE, totalItems - shown);
  el.innerHTML = `<button type="button" class="table-show-more" id="dashboard-show-more">Show ${next} more</button>
    <span class="table-show-count">${shown} of ${totalItems}</span>`;
  document.getElementById("dashboard-show-more").addEventListener("click", () => {
    dashboardShown += DASHBOARD_PER_PAGE;
    renderDashboardTable();
    // Keep focus on the button (or the last row once everything is shown)
    const more = document.getElementById("dashboard-show-more");
    if (more) more.focus({ preventScroll: true });
  });
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
        // Scroll to the top of the list (under the chart, in the same card)
        const card = document.querySelector(".table-card .table-wrapper");
        if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });
}

// ── Pagination & Sorting state ────────────────────────────────
const DASHBOARD_PER_PAGE = 10;
let dashboardPage = 1;
let dashboardShown = DASHBOARD_PER_PAGE; // phones: rows shown so far
const phoneTable = window.matchMedia("(max-width: 767px)");
phoneTable.addEventListener("change", () => { dashboardPage = 1; dashboardShown = DASHBOARD_PER_PAGE; renderDashboardTable(); });

// ═══════════════════════════════════════════════════════════════════
// HISTORY PAGE: one searchable list for expenses or income
// ═══════════════════════════════════════════════════════════════════
// Filters live in `hist` and the controls, so a list redrawn after an edit or delete keeps them.
const HISTORY_STEP = 50;
const hist = { tab: "expenses", kinds: new Set(), shown: HISTORY_STEP, openRows: new Set() };

// With a mouse (no sideways swipe), a chip row wraps instead of scrolling, and shows two lines until
// "Show all". Chips past the second line are inert while folded, so Tab can't reach hidden ones; the
// button says when a selected chip is among them.
const mouseChips = window.matchMedia("(hover: hover) and (pointer: fine)");
function fitChips(row) {
  const btn = document.getElementById(row.id + "-toggle");
  if (!btn) return;
  const chips = [...row.children];
  row.classList.remove("is-folded");
  chips.forEach(c => { c.inert = false; });
  const lines = mouseChips.matches && !row.classList.contains("hidden") ? [...new Set(chips.map(c => c.offsetTop))].sort((a, b) => a - b) : [];
  if (lines.length <= 2) { btn.classList.add("hidden"); return; }
  const folded = chips.filter(c => c.offsetTop >= lines[2]);
  const open = hist.openRows.has(row.id);
  const hiddenPicks = open ? 0 : folded.filter(c => c.getAttribute("aria-pressed") === "true").length;
  row.style.setProperty("--two-lines", `${lines[2] - lines[0] - 8}px`); // up to the third line, less the gap
  row.classList.toggle("is-folded", !open);
  folded.forEach(c => { c.inert = !open; });
  btn.classList.remove("hidden");
  btn.textContent = open ? "Show less" : `Show all ${chips.length}${hiddenPicks ? ` · ${hiddenPicks} selected` : ""}`;
  btn.setAttribute("aria-expanded", String(open));
}
const HISTORY_TABS = {
  expenses: {
    rows: () => allExpenses,
    kind: e => e.category,
    title: e => e.description || e.category,
    meta: e => [e.category, e.cardName ? `${e.payment} (${e.cardName})` : e.payment, ...(e.tags || []).map(t => "#" + t)],
    text: e => [e.description, e.category, e.notes, e.payment, e.cardName, ...(e.tags || [])],
    tags: e => e.tags || [],
    attr: "data-edit-expense", kindsLabel: "Categories", one: "expense", many: "expenses",
    empty: 'No expenses yet. <a href="expense.html">Add an expense</a>',
  },
  income: {
    rows: () => allIncome,
    kind: i => i.source || "Other",
    title: i => i.source || "Income",
    meta: i => [i.paymentType, i.bank],
    text: i => [i.source, i.bank, i.notes, i.paymentType],
    attr: "data-edit-income", kindsLabel: "Sources", one: "income entry", many: "income entries",
    empty: 'No income recorded yet. <a href="income.html">Add income</a>',
  },
};

// [from, to] of the chosen date range
function historyDates() {
  const $id = id => document.getElementById(id);
  return historyRange($id("hist-range")?.value, new Date(), { from: $id("hist-from")?.value, to: $id("hist-to")?.value });
}

// The rows on screen: tab, dates, chips, search and sort applied (also what Download exports)
// dates: [from, to], History's own range unless Export picked another
function historyRows(dates = historyDates()) {
  const t = HISTORY_TABS[hist.tab];
  const $id = id => document.getElementById(id);
  const [from, to] = dates;
  return filterHistory(t.rows(), { from, to, kinds: hist.kinds, kindOf: t.kind, q: $id("hist-search")?.value || "", textOf: t.text, tagsOf: t.tags, sort: $id("hist-sort")?.value });
}

function renderHistory() {
  const list = document.getElementById("history-list");
  if (!list) return;
  const t = HISTORY_TABS[hist.tab];
  const all = t.rows();

  // Chips: the categories (or sources) in the data, most used first
  const counts = {};
  all.forEach(r => { const k = t.kind(r); counts[k] = (counts[k] || 0) + 1; });
  hist.kinds.forEach(k => { if (!counts[k]) hist.kinds.delete(k); });
  const kinds = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  const chips = document.getElementById("hist-kinds");
  chips.setAttribute("aria-label", t.kindsLabel);
  chips.classList.toggle("hidden", kinds.length < 2);
  chips.innerHTML = kinds.map(k => `<button type="button" class="chip" data-hist-kind="${escapeHtml(k)}" aria-pressed="${hist.kinds.has(k)}">${escapeHtml(k)}</button>`).join("");

  // Tags (#goa2026) used in the chosen dates, plus the one searched for: one tap shows that trip's
  // or event's entries
  const tag = searchTag(document.getElementById("hist-search").value);
  const [from, to] = historyDates();
  const inDates = r => (!from || r.date >= from) && (!to || r.date <= to);
  const tags = t.tags
    ? tagsInUse(all.filter(r => inDates(r) || t.tags(r).some(g => String(g).toLowerCase() === tag)), t.tags) : [];
  const tagChips = document.getElementById("hist-tags");
  tagChips.classList.toggle("hidden", !tags.length);
  tagChips.innerHTML = tags.map(g => `<button type="button" class="chip" data-hist-tag="${escapeHtml(g)}" aria-pressed="${g.toLowerCase() === tag}">#${escapeHtml(g)}</button>`).join("");
  fitChips(chips);
  fitChips(tagChips);

  const rows = historyRows();
  const clear = rows.length !== all.length ? ' <button type="button" class="hist-clear" id="hist-clear">Clear filters</button>' : "";
  // For a tag, where its money went across categories
  const split = tag && t.tags && rows.length
    ? `<span class="hist-split">${totalsBy(rows, t.kind).map(([k, v]) => `${escapeHtml(k)} ${fmt(v)}`).join(" · ")}</span>` : "";
  document.getElementById("hist-summary").innerHTML = rows.length
    ? `${rows.length} ${rows.length === 1 ? t.one : t.many} · <strong>${fmt(rows.reduce((s, r) => s + r.amount, 0))}</strong>${clear}${split}`
    : "";
  list.setAttribute("aria-busy", "false");
  const more = document.getElementById("hist-more");
  if (!rows.length) {
    list.innerHTML = `<p class="hist-empty">${all.length ? `Nothing matches.${clear}` : t.empty}</p>`;
    more.classList.add("hidden");
    return;
  }

  // Grouped by day with each day's total, unless sorted by amount
  const byDate = document.getElementById("hist-sort").value !== "largest";
  const dayTotals = {};
  if (byDate) rows.forEach(r => { dayTotals[r.date] = (dayTotals[r.date] || 0) + r.amount; });
  const groups = [];
  rows.slice(0, hist.shown).forEach(r => {
    const key = byDate ? r.date : "";
    if (groups.at(-1)?.key === key) groups.at(-1).rows.push(r);
    else groups.push({ key, rows: [r] });
  });
  const income = hist.tab === "income";
  const row = r => {
    const meta = t.meta(r).filter(Boolean);
    if (!byDate) meta.unshift(formatDate(r.date));
    // An offline entry has no record yet: deleting it here would let the queue re-add it later
    if (r.pending) meta.push("Waiting to sync");
    if (r.repeat === "monthly") meta.push(r.emiTotal ? `EMI · ${r.emiTotal} payments` : "Repeats monthly");
    return `<li><button type="button" class="hist-row" ${t.attr}="${escapeHtml(r.id)}"${r.pending ? " disabled" : ""}>
      <span class="hist-row-main">
        <span class="hist-row-title">${escapeHtml(t.title(r))}</span>
        <span class="hist-row-meta">${escapeHtml(meta.join(" · "))}</span>
        ${r.notes ? `<span class="hist-row-note">${escapeHtml(r.notes)}</span>` : ""}
      </span>
      <span class="hist-row-amount${income ? " income" : ""}">${income ? "+" : ""}${fmt(r.amount)}</span>
    </button></li>`;
  };
  list.innerHTML = groups.map(g => `
    <section class="hist-day">
      ${g.key ? `<h2 class="hist-day-head"><span>${historyDay(g.key)}</span><span>${fmt(dayTotals[g.key])}</span></h2>` : ""}
      <ul class="hist-rows">${g.rows.map(row).join("")}</ul>
    </section>`).join("");

  const left = rows.length - hist.shown;
  more.classList.toggle("hidden", left <= 0);
  more.textContent = `Show ${Math.min(left, HISTORY_STEP)} more`;
}
function renderIncomeHistory() { renderHistory(); }

function clearHistoryFilters() {
  document.getElementById("hist-search").value = "";
  document.getElementById("hist-range").value = "all";
  document.getElementById("hist-custom").classList.add("hidden");
  hist.kinds.clear();
  hist.shown = HISTORY_STEP;
  renderHistory();
  document.getElementById("hist-search").focus();
}

function initHistory() {
  if (!document.getElementById("history-list")) return;
  const $id = id => document.getElementById(id);
  const rerender = () => { hist.shown = HISTORY_STEP; renderHistory(); };
  const now = new Date();
  $id("hist-from").value = todayStr(new Date(now.getFullYear(), now.getMonth(), 1));
  $id("hist-to").value = todayStr(now);

  $id("hist-tabs").addEventListener("click", e => {
    const btn = e.target.closest("[data-hist-tab]");
    if (!btn || btn.dataset.histTab === hist.tab) return;
    hist.tab = btn.dataset.histTab;
    hist.kinds.clear(); // categories and sources differ
    document.querySelectorAll("[data-hist-tab]").forEach(b => b.setAttribute("aria-pressed", String(b === btn)));
    rerender();
  });
  let searchTimer;
  $id("hist-search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(rerender, 150); });
  $id("hist-range").addEventListener("change", e => { $id("hist-custom").classList.toggle("hidden", e.target.value !== "custom"); rerender(); });
  ["hist-sort", "hist-from", "hist-to"].forEach(id => $id(id).addEventListener("change", rerender));
  $id("hist-kinds").addEventListener("click", e => {
    const btn = e.target.closest("[data-hist-kind]");
    if (!btn) return;
    const k = btn.dataset.histKind;
    hist.kinds.has(k) ? hist.kinds.delete(k) : hist.kinds.add(k);
    rerender();
    $id("hist-kinds").querySelector(`[data-hist-kind="${CSS.escape(k)}"]`)?.focus(); // the chips were rebuilt
  });
  $id("hist-tags").addEventListener("click", e => {
    const btn = e.target.closest("[data-hist-tag]");
    if (!btn) return;
    const g = btn.dataset.histTag;
    $id("hist-search").value = btn.getAttribute("aria-pressed") === "true" ? "" : "#" + g;
    rerender();
    $id("hist-tags").querySelector(`[data-hist-tag="${CSS.escape(g)}"]`)?.focus();
  });
  $id("hist-more").addEventListener("click", () => { hist.shown += HISTORY_STEP; renderHistory(); });
  $id("export-go")?.addEventListener("click", downloadHistoryExport);
  ["hist-kinds", "hist-tags"].forEach(id => $id(id + "-toggle")?.addEventListener("click", () => {
    if (hist.openRows.has(id)) hist.openRows.delete(id); else hist.openRows.add(id);
    fitChips($id(id));
  }));
  let refit;
  const fitAll = () => { cancelAnimationFrame(refit); refit = requestAnimationFrame(() => ["hist-kinds", "hist-tags"].forEach(id => fitChips($id(id)))); };
  window.addEventListener("resize", fitAll);
  mouseChips.addEventListener("change", fitAll);
  ["export-range", "export-from", "export-to"].forEach(id => $id(id)?.addEventListener("change", updateExportDialog));
  document.querySelector(".hist-page").addEventListener("click", e => { if (e.target.id === "hist-clear") clearHistoryFilters(); });
  if (location.hash === "#income") $id("hist-tabs").querySelector('[data-hist-tab="income"]').click(); // "All income" link
  // Opened from Insights › Ask (?tab=income&q=amazon&from=…&to=…&cat=…): show exactly what was asked
  const asked = new URLSearchParams(location.search);
  if (["q", "from", "to", "cat", "tab"].some(k => asked.has(k))) {
    if (asked.get("tab") === "income") $id("hist-tabs").querySelector('[data-hist-tab="income"]').click();
    if (asked.has("q")) $id("hist-search").value = asked.get("q");
    const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v || "");
    if (isDate(asked.get("from")) || isDate(asked.get("to"))) {
      $id("hist-range").value = "custom";
      $id("hist-custom").classList.remove("hidden");
      $id("hist-from").value = isDate(asked.get("from")) ? asked.get("from") : "";
      $id("hist-to").value = isDate(asked.get("to")) ? asked.get("to") : "";
    }
    asked.getAll("cat").forEach(c => hist.kinds.add(c));
    rerender();
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initHistory);
else initHistory();

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


// ── History: Export (modules/csv-export.js) ──────────────────────────────────
// [from, to] picked in the Export dialog (its own time frame, which starts as History's). Custom
// dates entered backwards are swapped.
function exportDates() {
  const $id = id => document.getElementById(id);
  if (!$id("export-range")) return historyDates(); // a page cached from before the dialog
  const [from, to] = historyRange($id("export-range").value, new Date(), { from: $id("export-from").value, to: $id("export-to").value });
  return from && to && from > to ? [to, from] : [from, to];
}

// What a download would hold, in the Export dialog's dates: the rows History shows (tab, chips,
// search), or every expense and income entry (ignoring search and chips), newest first
function exportEntries(what) {
  if (what === "both") {
    const [from, to] = exportDates();
    const inDates = r => (!from || r.date >= from) && (!to || r.date <= to);
    return [...allExpenses.filter(inDates).map(row => ({ kind: "expense", row })), ...allIncome.filter(inDates).map(row => ({ kind: "income", row }))]
      .sort((a, b) => (b.row.date || "").localeCompare(a.row.date || ""));
  }
  const kind = hist.tab === "income" ? "income" : "expense";
  return historyRows(exportDates()).map(row => ({ kind, row }));
}

// Counts and totals for the dialog's time frame; an option with nothing in it can't be picked
function updateExportDialog() {
  const $id = id => document.getElementById(id);
  const t = HISTORY_TABS[hist.tab];
  $id("export-custom").classList.toggle("hidden", $id("export-range").value !== "custom");
  const shown = exportEntries("shown"), both = exportEntries("both");
  const q = $id("hist-search").value.trim();
  const filters = [...hist.kinds, q && `“${q}”`].filter(Boolean);
  $id("export-shown-title").textContent = filters.length ? `What's shown · ${plural(shown.length, t.one, t.many)}` : `All ${t.many} · ${shown.length}`;
  $id("export-shown-sub").textContent = [fmt(shown.reduce((sum, e) => sum + e.row.amount, 0)), ...filters].join(" · ");
  $id("export-both-sub").textContent = `${plural(both.length, "entry", "entries")}, without search or chips`;
  const pick = value => document.querySelector(`input[name="export-what"][value="${value}"]`);
  pick("shown").disabled = !shown.length;
  pick("both").disabled = !both.length;
  if (pick("shown").checked && !shown.length && both.length) pick("both").checked = true;
  if (pick("both").checked && !both.length && shown.length) pick("shown").checked = true;
  $id("export-go").disabled = !shown.length && !both.length;
  $id("export-empty").classList.toggle("hidden", !!(shown.length || both.length));
}

window.openHistoryExport = () => {
  const $id = id => document.getElementById(id);
  if (!$id("export-modal")) { downloadHistoryExport(); return; } // a page cached from before the dialog
  // The dialog's time frame starts as History's own
  $id("export-range").innerHTML = $id("hist-range").innerHTML;
  $id("export-range").value = $id("hist-range").value;
  const [from, to] = historyDates();
  $id("export-from").value = $id("hist-from").value || from || todayStr(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  $id("export-to").value = $id("hist-to").value || to || todayStr();
  document.querySelector('input[name="export-what"][value="shown"]').checked = true;
  updateExportDialog();
  $id("export-modal").classList.remove("hidden");
  if (window.lucide) lucide.createIcons();
};

window.closeHistoryExport = () => document.getElementById("export-modal").classList.add("hidden");

function downloadHistoryExport() {
  const what = document.querySelector('input[name="export-what"]:checked')?.value || "shown";
  const entries = exportEntries(what);
  if (!entries.length) { showToast("Nothing to export.", "error"); return; }
  const csv = buildCsv(entries, { currency: window.getCurrency?.() || "INR", total: document.getElementById("export-total")?.checked ?? true });
  const [from, to] = exportDates();
  const name = exportFileName(what === "both" ? "Expenses-and-income" : hist.tab === "income" ? "Income" : "Expenses", from, to, todayStr());
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  document.getElementById("export-modal")?.classList.add("hidden");
  showToast(`Downloaded ${name}`, "success");
}

// Charts read theme colours when drawn, so redraw when theme.js switches appearance
window.addEventListener("spendwise:themechange", () => {
  if (!document.getElementById("home-spent")) return;
  renderTrendChart();
});


function setGreeting() { const h = new Date().getHours(); const g = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; const n = (currentUser && currentUser.displayName) ? currentUser.displayName.split(" ")[0] : ""; const el = document.getElementById("dashboard-greeting") || document.getElementById("income-greeting") || document.getElementById("expense-greeting"); if (el) el.textContent = g + (n ? ", " + n : "") + "!"; }

// ── Currency: everything shown in money is redrawn ──────────────────────────
function refreshMoney() {
  if (!currentUser) return;
  updateCards();
  renderDashboardTable();
  renderHistory();
  updatePeriodSummary();
  updateIncomeCards();
  updateExpenseCards();
  requestAnimationFrame(() => { renderTrendChart(); });
}
function showFormMsg(msg, type) { const el = document.getElementById("form-msg"); el.textContent = msg; el.className = "form-msg " + type; el.classList.remove("hidden"); if (type === "success") setTimeout(() => el.classList.add("hidden"), 3000); }

// ============================================================
//  LINE CHART - SPENDING TRENDS
// ============================================================
let trendChartInstance = null;

function getTrendData() {
  const spending = allExpenses.filter(isSpending);
  // Get current displayed expenses based on period picker
  const m = document.getElementById('picker-month') ? document.getElementById('picker-month').value : '';
  const y = document.getElementById('picker-year') ? document.getElementById('picker-year').value : '';

  let periodExpenses = spending.filter(e => {
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
      const dayExpenses = spending.filter(e => e.date === dateStr);
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

      const wStartStr = todayStr(weekStart);
      const wEndStr   = todayStr(weekEnd);
      // Compact label e.g. "9–15 Mar" or "28 Mar–3 Apr" for cross-month
      const startMonth = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][weekStart.getMonth()];
      const endMonth   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][weekEnd.getMonth()];
      const label = weekStart.getMonth() === weekEnd.getMonth()
        ? weekStart.getDate() + '–' + weekEnd.getDate() + ' ' + startMonth
        : weekStart.getDate() + ' ' + startMonth + '–' + weekEnd.getDate() + ' ' + endMonth;
      labels.push(label);

      const weekExpenses = spending.filter(e => {
        return e.date >= wStartStr && e.date <= wEndStr;
      });
      dateGroups[label] = weekExpenses.reduce((s, e) => s + e.amount, 0);
    }
  } else if (activeTab === 'monthly') {
    // Show all months in the year (use spending filtered by year only, not month)
    let displayYear = y || now.getFullYear();
    for (let month = 1; month <= 12; month++) {
      const monthStr = pad(month);
      const monthLabel = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1];
      labels.push(monthLabel);

      const monthExpenses = spending.filter(e => {
        return e.date && e.date.substring(0, 4) === String(displayYear) && e.date.substring(5, 7) === monthStr;
      });
      dateGroups[monthLabel] = monthExpenses.reduce((s, e) => s + e.amount, 0);
    }
  } else {
    // Yearly view - show all years from all expenses
    const years = new Set();
    spending.forEach(e => {
      if (e.date) years.add(e.date.substring(0, 4));
    });
    const sortedYears = Array.from(years).sort();
    sortedYears.forEach(year => {
      labels.push(year);
      const yearExpenses = spending.filter(e => e.date.substring(0, 4) === year);
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
  // Bar, grid and tick colours come from the theme tokens (tokens.css)
  const css = getComputedStyle(document.documentElement);
  const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  const barColor = token('--chart-bar', '#4a9eff');
  const gridColor = token('--chart-grid', isDarkMode ? 'rgba(58, 58, 58, 0.5)' : 'rgba(229, 229, 229, 0.5)');
  const tickColor = token('--chart-tick', isDarkMode ? '#b0b0b0' : '#888888');

  // Abbreviated Y-axis: uses fmtCompact from currency.js
  function fmtTick(value) {
    return fmtCompact(value);
  }

  trendChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: 'Spending',
        data: data,
        borderColor: barColor,
        backgroundColor: barColor,
        borderRadius: 8,
        maxBarThickness: 48,
        borderWidth: 0,
        pointRadius: isMobile ? 4 : 5,
        pointHoverRadius: isMobile ? 6 : 7,
        pointBackgroundColor: barColor,
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
            color: tickColor,
            font: { size: isMobile ? 10 : 11 },
            // Compact format: Rs 5k instead of Rs 5,000.00
            callback: fmtTick
          },
          grid: {
            color: gridColor,
            drawBorder: false
          }
        },
        x: {
          ticks: {
            color: tickColor,
            font: { size: isMobile ? 10 : 11 },
            maxRotation: 0,
            minRotation: 0,
            autoSkip: false,
            // Phones fit the whole range on screen: day over date, month initials (the tooltip has it in full)
            callback: function (value) {
              const label = this.getLabelForValue(value);
              if (!isMobile) return label;
              if (activeTab === 'daily') return label.split(' ');
              if (activeTab === 'monthly') return label.charAt(0);
              return label;
            }
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

document.addEventListener("DOMContentLoaded", () => {
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

  // Expense page: Today/Yesterday, Enter to save, remembered payment method
  document.querySelectorAll("[data-date-offset]").forEach(chip => chip.addEventListener("click", () => {
    const d = new Date(); d.setDate(d.getDate() - Number(chip.dataset.dateOffset));
    document.getElementById("exp-date").value = todayStr(d);
    syncDateChips();
  }));
  document.getElementById("exp-date")?.addEventListener("change", syncDateChips);
  ["exp-amount", "exp-description"].forEach(id => document.getElementById(id)?.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); window.addExpense(); }
  }));
  document.getElementById("exp-payment")?.addEventListener("change", updatePaymentHint);
  document.getElementById("exp-repeat")?.addEventListener("change", syncEmiFields);
  applyLastPayment();
  syncDateChips();

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
// The EMI boxes show while "Repeats every month" is on
function syncEmiFields() {
  const box = document.getElementById("exp-emi");
  if (box) box.classList.toggle("hidden", !document.getElementById("exp-repeat")?.checked);
}

const _baseReset = window.resetForm;
window.resetForm = () => {
  _baseReset();
  document.querySelectorAll('#category-picker .cat-tile').forEach(t => { t.classList.remove('selected'); t.setAttribute('aria-checked', 'false'); });
  document.getElementById('exp-category').value = '';
  const repeatSwitch = document.getElementById('exp-repeat');
  if (repeatSwitch) repeatSwitch.checked = false;
  ["exp-emi-total", "exp-emi-before"].forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
  syncEmiFields();
  applyLastPayment();
  syncDateChips();
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
  dashboardPage = 1; dashboardShown = DASHBOARD_PER_PAGE;
  updatePeriodLabel();
  renderDashboardTable();
  // Defer chart updates
  requestAnimationFrame(() => {
    renderTrendChart();
  });
}

window.resetPeriodPicker = function () {
  const now = new Date();
  document.getElementById('picker-month').value = String(now.getMonth() + 1).padStart(2, '0');
  document.getElementById('picker-year').value = now.getFullYear();
  dashboardPage = 1; dashboardShown = DASHBOARD_PER_PAGE;
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
  const rows = getPeriodExpenses().filter(isSpending); // the table below still lists investments
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

  showTableRows(rows);
  updatePeriodSummary();
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
    errEl.textContent = msgs[e2.code] || "Couldn't send the reset email. Check your connection and try again.";
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

  // Expense delete modal cleanup
  const expenseDelOverlay = document.getElementById('modal');
  if (expenseDelOverlay) expenseDelOverlay.addEventListener('click', e => { if (e.target === expenseDelOverlay) closeModal(); });

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
let incDeleteTarget = null;
let editingIncId = null;

// ── Edit Income (from history page) ──────────────────────────
window.openIncEdit = (id) => {
  const entry = allIncome.find(i => i.id === id);
  if (!entry || entry.pending) return; // queued offline: no record to edit or delete until it syncs
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
    saveToCache(currentUser.uid, allIncome, 'income');

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
    saveToCache(currentUser.uid, allIncome, 'income');
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

// Refresh after offline-queue.js writes queued items (replaces the "pending" placeholders)
window.addEventListener('spendwise:synced', () => { loadExpenses(true); loadIncome(); loadDebts(); });
