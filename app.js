// SpendWise app.js - Firebase Modular SDK

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut, updateProfile, sendPasswordResetEmail } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, addDoc, getDocs, deleteDoc, doc, query, where, serverTimestamp, updateDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// Firebase Web API keys are safe to be public — Firebase explicitly documents this.
// Security is enforced by Firebase Auth (only authenticated users can read/write)
// and Firestore Security Rules (uid-scoped data access).
// To further restrict this key: Firebase Console → Project Settings → API key restrictions
// → add your production domain (e.g. yourapp.netlify.app) under "Application restrictions".
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
const _LEGACY_KEY = "SpendWise_2024_K";
function dec(encoded) {
  if (typeof encoded !== "string") return encoded;  // plain number
  // Quick check: valid base64 strings match this pattern
  if (!/^[A-Za-z0-9+/]+=*$/.test(encoded) || encoded.length < 4) return encoded;
  try {
    const s = atob(encoded);
    let r = "";
    for (let i = 0; i < s.length; i++)
      r += String.fromCharCode(s.charCodeAt(i) ^ _LEGACY_KEY.charCodeAt(i % _LEGACY_KEY.length));
    // Verify decoded result is printable text (no control chars / high bytes)
    if (/^[\x20-\x7E]*$/.test(r) && r.length > 0) return r;
    // Decoded to garbage → input was plain text, not encoded
    return encoded;
  } catch {
    return encoded; // not base64 → already plain text
  }
}

let currentUser = null, allExpenses = [], activeTab = "daily", deleteTarget = null, filteredExpenses = null, chartInstance = null, editingExpenseId = null;

// ── Page loader ─────────────────────────────────────────────────────────────
function dismissPageLoader() {
  const loader = document.getElementById('page-loader');
  if (!loader) return;
  loader.classList.add('fade-out');
  setTimeout(() => loader.remove(), 450);
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
      `<td><span class="skeleton-cell" style="width:${[70,90,110,80,60,50,40][i % 7]}px"></span></td>`
    ).join('')}</tr>`
  ).join('');
  tbody.innerHTML = rows;
}

onAuthStateChanged(auth, user => {
  dismissPageLoader();
  if (user) {
    currentUser = user;
    document.getElementById("auth-screen").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");
    const avatarEl = document.getElementById("user-avatar");
    if (user.photoURL) {
      avatarEl.innerHTML = `<img src="${user.photoURL}" alt="Profile" onerror="this.parentElement.textContent='${(user.displayName||user.email||'U')[0].toUpperCase()}'"/>`;
    } else {
      avatarEl.textContent = (user.displayName || user.email || "U")[0].toUpperCase();
    }
    setGreeting();
    // Show skeleton while data loads
    showTableSkeleton("table-body", 5);
    showTableSkeleton("history-body", 7);
    // Load expenses asynchronously to avoid blocking UI
    setTimeout(() => loadExpenses(), 0);
  } else {
    currentUser = null;
    document.getElementById("auth-screen").classList.remove("hidden");
    document.getElementById("app").classList.add("hidden");
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
  if (pass.length < 6) { showAuthError("Password must be at least 6 characters."); return; }
  try { const cred = await createUserWithEmailAndPassword(auth, email, pass); await updateProfile(cred.user, { displayName: name }); }
  catch (e) { showAuthError(friendlyErr(e.code)); }
};

window.handleGoogleLogin = async () => {
  try { await signInWithPopup(auth, gProvider); }
  catch (e) { showAuthError(friendlyErr(e.code)); }
};

window.handleLogout = async () => { await signOut(auth); allExpenses = []; };

function showAuthError(msg) { const el = document.getElementById("auth-error"); el.textContent = msg; el.classList.remove("hidden"); }

function friendlyErr(code) {
  const m = { "auth/user-not-found": "No account with this email.", "auth/wrong-password": "Incorrect password.", "auth/email-already-in-use": "Email already registered.", "auth/invalid-email": "Invalid email.", "auth/weak-password": "Password too short.", "auth/popup-closed-by-user": "Sign-in cancelled.", "auth/invalid-credential": "Invalid email or password." };
  return m[code] || "Something went wrong. Try again.";
}

window.showPage = (page) => {
  document.querySelectorAll(".page").forEach(p => p.classList.add("hidden"));
  document.querySelectorAll(".sidebar-btn, .bottom-nav-btn").forEach(b => b.classList.remove("active"));
  document.getElementById("page-" + page).classList.remove("hidden");
  const sBtn = document.getElementById("snav-" + page); if (sBtn) sBtn.classList.add("active");
  const bBtn = document.getElementById("bnav-" + page); if (bBtn) bBtn.classList.add("active");
  if (page === "dashboard") {
    renderDashboardTable();
    // Defer chart rendering to avoid blocking UI interactions
    requestAnimationFrame(() => {
      renderPieChart();
      renderTrendChart();
    });
  }
  if (page === "history") renderHistory();
  if (page === "add") { const d = document.getElementById("exp-date"); if (!d.value) d.value = todayStr(); }
};

async function loadExpenses() {
  if (!currentUser) return;
  showLoader();
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
        amount:      isNaN(amt) ? 0 : amt,
        cardName:    raw.cardName || "",
        description: isPlain ? (raw.description || "") : dec(raw.description),
        notes:       isPlain ? (raw.notes || "")       : dec(raw.notes || "")
      };
    });
    // Sort client-side — no Firestore index required
    allExpenses.sort((a, b) => b.date.localeCompare(a.date));
    
    // Render lightweight content immediately
    updateCards();
    renderDashboardTable();
    renderHistory();
    populateYearPicker();
    initPeriodPicker();
    updatePeriodSummary();
    
    // Defer chart rendering to next frame to avoid blocking
    requestAnimationFrame(() => {
      renderPieChart();
      renderTrendChart();
      hideLoader();
    });
  } catch (e) { console.error(e); showToast("Error loading data.", "error"); hideLoader(); }
}

window.addExpense = async () => {
  const amount = parseFloat(document.getElementById("exp-amount").value);
  const category = document.getElementById("exp-category").value;
  const date = document.getElementById("exp-date").value;
  const payment = document.getElementById("exp-payment").value;
  const description = document.getElementById("exp-description").value.trim();
  const notes = document.getElementById("exp-notes").value.trim();
  if (!amount || amount <= 0) { showFormMsg("Enter a valid amount.", "error"); return; }
  if (!category) { showFormMsg("Select a category.", "error"); return; }
  if (!date) { showFormMsg("Select a date.", "error"); return; }
  try {
    showLoader();
    const cardName = document.getElementById("exp-card-name") ? document.getElementById("exp-card-name").value.trim() : "";
    const ref = await addDoc(collection(db, "expenses"), { uid: currentUser.uid, amount, category, date, payment, cardName: cardName || "", description: description || "-", notes: notes, encoding: "plain", createdAt: serverTimestamp() });
    allExpenses.unshift({ id: ref.id, amount, category, date, payment, cardName: cardName || "", description: description || "-", notes });
    allExpenses.sort((a, b) => b.date.localeCompare(a.date));
    updateCards();
    renderDashboardTable();
    renderHistory();
    // Defer chart rendering
    requestAnimationFrame(() => {
      renderPieChart();
      renderTrendChart();
      hideLoader();
    });
    resetForm();
    showFormMsg("Expense added successfully!", "success");
    showToast("Expense added!", "success");
  } catch (e) { console.error(e); showFormMsg("Failed to save. Check Firebase config.", "error"); hideLoader(); }
};

window.resetForm = () => {
  ["exp-amount","exp-description","exp-notes","exp-card-name"].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = "";
  });
  document.getElementById("exp-category").value = "";
  document.getElementById("exp-payment").value = "UPI";
  const wrap = document.getElementById("exp-card-name-wrap");
  if (wrap) wrap.style.display = "none";
  document.getElementById("exp-date").value = todayStr();
  document.getElementById("form-msg").classList.add("hidden");
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
    updateCards();
    renderDashboardTable();
    renderHistory();
    // Defer chart rendering
    requestAnimationFrame(() => {
      renderPieChart();
      renderTrendChart();
      hideLoader();
    });
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
  
  document.getElementById("edit-error").classList.add("hidden");
  document.getElementById("edit-modal").classList.remove("hidden");
};

window.closeEditModal = () => {
  document.getElementById("edit-modal").classList.add("hidden");
  editingExpenseId = null;
};

window.saveEditExpense = async () => {
  if (!editingExpenseId) return;
  
  const amount = parseFloat(document.getElementById("edit-amount").value);
  const category = document.getElementById("edit-category").value;
  const date = document.getElementById("edit-date").value;
  const payment = document.getElementById("edit-payment").value;
  const description = document.getElementById("edit-description").value.trim();
  const notes = document.getElementById("edit-notes").value.trim();
  
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
    const cardName = editCardName ? editCardName.value.trim() : "";
    await updateDoc(expenseRef, {
      amount,
      category,
      date,
      payment,
      cardName: cardName || "",
      description: description || "-",
      notes: notes,
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
        notes
      };
      allExpenses.sort((a, b) => b.date.localeCompare(a.date));
    }
    
    updateCards();
    renderDashboardTable();
    renderHistory();
    // Defer chart rendering
    requestAnimationFrame(() => {
      renderPieChart();
      renderTrendChart();
      hideLoader();
    });
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
  const now = new Date(); const today = todayStr();
  const ws = getWeekStart();
  const ms = now.getFullYear() + "-" + pad(now.getMonth()+1) + "-01";
  const ys = now.getFullYear() + "-01-01";
  function calc(f, t) { const r = allExpenses.filter(e => e.date >= f && e.date <= t); return { total: r.reduce((s,e) => s+e.amount, 0), count: r.length }; }
  const d=calc(today,today), w=calc(ws,today), m=calc(ms,today), y=calc(ys,today);
  document.getElementById("sum-daily").textContent = fmt(d.total);
  document.getElementById("sum-weekly").textContent = fmt(w.total);
  document.getElementById("sum-monthly").textContent = fmt(m.total);
  document.getElementById("sum-yearly").textContent = fmt(y.total);
  document.getElementById("sum-daily-count").textContent = d.count + " transaction" + (d.count!==1?"s":"");
  document.getElementById("sum-weekly-count").textContent = w.count + " transaction" + (w.count!==1?"s":"");
  document.getElementById("sum-monthly-count").textContent = m.count + " transaction" + (m.count!==1?"s":"");
  document.getElementById("sum-yearly-count").textContent = y.count + " transaction" + (y.count!==1?"s":"");

}

window.switchTableTab = (tab) => {
  activeTab = tab;
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
  const now = new Date(); const today = todayStr(); let from;
  if (activeTab==="daily") from=today;
  else if (activeTab==="weekly") from=getWeekStart();
  else if (activeTab==="monthly") from=now.getFullYear()+"-"+pad(now.getMonth()+1)+"-01";
  else from=now.getFullYear()+"-01-01";
  renderTable("table-body", allExpenses.filter(e => e.date >= from && e.date <= today), false);
}

// ── Pagination & Sorting state ────────────────────────────────
const HISTORY_PER_PAGE = 10;
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
  const card = document.querySelector("#page-history .table-card");
  if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
};

function renderPagination(totalItems, totalPages) {
  const el = document.getElementById("history-pagination");
  if (!el) return;
  if (totalPages <= 1) { el.innerHTML = ""; return; }

  const MAX_VISIBLE = 7;
  let startP = Math.max(1, historyPage - Math.floor(MAX_VISIBLE / 2));
  let endP   = Math.min(totalPages, startP + MAX_VISIBLE - 1);
  if (endP - startP + 1 < MAX_VISIBLE) startP = Math.max(1, endP - MAX_VISIBLE + 1);

  let html = `<button class="page-btn" onclick="goToHistoryPage(${historyPage - 1})" ${historyPage === 1 ? "disabled" : ""}><i data-lucide="chevron-left"></i></button>`;

  if (startP > 1) {
    html += `<button class="page-btn" onclick="goToHistoryPage(1)">1</button>`;
    if (startP > 2) html += `<span class="pagination-dots">…</span>`;
  }
  for (let i = startP; i <= endP; i++) {
    html += `<button class="page-btn${i === historyPage ? " active" : ""}" onclick="goToHistoryPage(${i})">${i}</button>`;
  }
  if (endP < totalPages) {
    if (endP < totalPages - 1) html += `<span class="pagination-dots">…</span>`;
    html += `<button class="page-btn" onclick="goToHistoryPage(${totalPages})">${totalPages}</button>`;
  }

  const from = (historyPage - 1) * HISTORY_PER_PAGE + 1;
  const to   = Math.min(historyPage * HISTORY_PER_PAGE, totalItems);
  html += `<span class="pagination-info">${from}–${to} of ${totalItems}</span>`;
  html += `<button class="page-btn" onclick="goToHistoryPage(${historyPage + 1})" ${historyPage === totalPages ? "disabled" : ""}><i data-lucide="chevron-right"></i></button>`;

  el.innerHTML = html;
  if (window.lucide) lucide.createIcons();
}

window.applyFilters = () => {
  const from = document.getElementById("filter-from").value,
        to   = document.getElementById("filter-to").value,
        cat  = document.getElementById("filter-category").value,
        q    = document.getElementById("filter-search") ? document.getElementById("filter-search").value.toLowerCase().trim() : "";
        
  let data = allExpenses.slice();
  if (from) data = data.filter(e => e.date >= from);
  if (to)   data = data.filter(e => e.date <= to);
  if (cat)  data = data.filter(e => e.category === cat);
  if (q) {
    data = data.filter(e => 
      e.description.toLowerCase().includes(q) || 
      e.category.toLowerCase().includes(q) || 
      (e.notes && e.notes.toLowerCase().includes(q))
    );
  }
  
  historyPage = 1;
  renderHistory(data);
};

window.clearFilters = () => {
  ["filter-from","filter-to","filter-category","filter-search"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  historyPage = 1;
  renderHistory(allExpenses);
};

function renderTable(tbodyId, rows, del) {
  const tbody = document.getElementById(tbodyId);
  const cols = del ? 8 : 5;
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
      tdAct.innerHTML = `<div class='action-buttons'><button class='btn-action edit' onclick="openEditExpense('${e.id}')" title='Edit'><i class='lucide' data-lucide='pencil'></i></button><button class='btn-action delete' onclick="deleteExpense('${e.id}')" title='Delete'><i class='lucide' data-lucide='trash-2'></i></button></div>`;
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
      const months = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      label = months[parseInt(selectedMonth)] + '_' + selectedYear;
    } else if (selectedMonth) {
      const months = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      label = months[parseInt(selectedMonth)];
    } else if (selectedYear) {
      label = 'Year_' + selectedYear;
    }
    exportCSV(periodData, "SpendWise_" + label);
    return;
  }
  
  // Otherwise, use the current date logic
  const now=new Date(); const today=todayStr(); let from, label;
  if (activeTab==="daily"){from=today;label="Today";}
  else if (activeTab==="weekly"){from=getWeekStart();label="This_Week";}
  else if (activeTab==="monthly"){from=now.getFullYear()+"-"+pad(now.getMonth()+1)+"-01";label="This_Month";}
  else{from=now.getFullYear()+"-01-01";label="This_Year";}
  exportCSV(allExpenses.filter(e=>e.date>=from&&e.date<=today), "SpendWise_"+label);
};

window.downloadHistoryCSV = () => exportCSV(filteredExpenses||allExpenses, "SpendWise_History");

function exportCSV(rows, name) {
  if (!rows.length) { showToast("No data to export.", "error"); return; }
  const hdr = ["Date","Category","Description","Payment Method","Card Name","Notes","Amount (Rs)"];
  const csv = [hdr.join(","), ...rows.map(e => [
    e.date,
    '"'+e.category+'"',
    '"'+(e.description||"").replace(/"/g,'""')+'"',
    '"'+e.payment+'"',
    '"'+(e.cardName||"").replace(/"/g,'""')+'"',
    '"'+(e.notes||"").replace(/"/g,'""')+'"',
    e.amount.toFixed(2)
  ].join(","))].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], {type:"text/csv"}));
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
  t.textContent = msg; t.className = "toast " + (type||"success");
  t.classList.remove("hidden");
  setTimeout(() => t.classList.add("hidden"), 3000);
}

function fmt(n) { return "Rs " + Number(n).toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2}); }
function pad(n) { return String(n).padStart(2,"0"); }
function todayStr() { const d=new Date(); return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate()); }
function getWeekStart() { const d=new Date(); const day=d.getDay(); const diff=d.getDate()-day+(day===0?-6:1); const m=new Date(d.setDate(diff)); return m.getFullYear()+"-"+pad(m.getMonth()+1)+"-"+pad(m.getDate()); }
function formatDate(ds) { return new Date(ds+"T00:00:00").toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"}); }
function setGreeting() { const h=new Date().getHours(); const g=h<12?"Good morning":h<17?"Good afternoon":"Good evening"; const n=(currentUser&&currentUser.displayName)?currentUser.displayName.split(" ")[0]:""; document.getElementById("dashboard-greeting").textContent=g+(n?", "+n:"")+"!"; }
function showFormMsg(msg,type) { const el=document.getElementById("form-msg"); el.textContent=msg; el.className="form-msg "+type; el.classList.remove("hidden"); if(type==="success") setTimeout(()=>el.classList.add("hidden"),3000); }

// ============================================================
//  PIE CHART - SPENDING BY CATEGORY
// ============================================================
function getCategoryBreakdown() {
  // Get current displayed expenses based on both period picker AND active tab
  const m = document.getElementById('picker-month') ? document.getElementById('picker-month').value : '';
  const y = document.getElementById('picker-year')  ? document.getElementById('picker-year').value  : '';
  
  let periodExpenses = allExpenses.filter(e => {
    if (!e.date) return false;
    if (y && e.date.substring(0,4) !== String(y)) return false;
    if (m && e.date.substring(5,7) !== String(m)) return false;
    return true;
  });
  
  // Now filter by active tab
  const now = new Date();
  const today = todayStr();
  let displayExpenses = [];
  
  if (activeTab === 'daily') {
    displayExpenses = periodExpenses.filter(e => e.date === today);
  } else if (activeTab === 'weekly') {
    const ws = getWeekStart();
    displayExpenses = periodExpenses.filter(e => e.date >= ws && e.date <= today);
  } else if (activeTab === 'monthly') {
    let displayYear = y || now.getFullYear();
    let displayMonth = m || pad(now.getMonth()+1);
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
            label: function(context) {
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
  const y = document.getElementById('picker-year')  ? document.getElementById('picker-year').value  : '';
  
  let periodExpenses = allExpenses.filter(e => {
    if (!e.date) return false;
    if (y && e.date.substring(0,4) !== String(y)) return false;
    if (m && e.date.substring(5,7) !== String(m)) return false;
    return true;
  });
  
  const now = new Date();
  const today = todayStr();
  let displayExpenses = [];
  let labels = [];
  let dateGroups = {};
  
  if (activeTab === 'daily') {
    // For daily view, show last 7 days with hourly or by individual transactions
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 6);
    for (let i = 0; i < 7; i++) {
      const date = new Date(startDate);
      date.setDate(date.getDate() + i);
      const dateStr = date.getFullYear() + '-' + pad(date.getMonth()+1) + '-' + pad(date.getDate());
      labels.push(formatDate(dateStr));
      const dayExpenses = periodExpenses.filter(e => e.date === dateStr);
      dateGroups[dateStr] = dayExpenses.reduce((s, e) => s + e.amount, 0);
    }
  } else if (activeTab === 'weekly') {
    // Show last 4 weeks
    labels = [];
    for (let i = 3; i >= 0; i--) {
      const weekDate = new Date();
      weekDate.setDate(weekDate.getDate() - (i * 7));
      const weekStart = new Date(weekDate);
      weekStart.setDate(weekStart.getDate() - weekDate.getDay() + (weekDate.getDay() === 0 ? -6 : 1));
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);
      
      const weekLabel = 'Week of ' + formatDate(weekStart.toISOString().split('T')[0]);
      labels.push(weekLabel);
      
      const weekExpenses = periodExpenses.filter(e => {
        return e.date >= weekStart.toISOString().split('T')[0] && e.date <= weekEnd.toISOString().split('T')[0];
      });
      dateGroups[weekLabel] = weekExpenses.reduce((s, e) => s + e.amount, 0);
    }
  } else if (activeTab === 'monthly') {
    // Show all months in the year with data
    let displayYear = y || now.getFullYear();
    for (let month = 1; month <= 12; month++) {
      const monthStr = pad(month);
      const monthLabel = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][month-1];
      labels.push(monthLabel);
      
      const monthExpenses = periodExpenses.filter(e => {
        return e.date.substring(0,4) === String(displayYear) && e.date.substring(5,7) === monthStr;
      });
      dateGroups[monthLabel] = monthExpenses.reduce((s, e) => s + e.amount, 0);
    }
  } else {
    // Yearly view - show all years
    const years = new Set();
    periodExpenses.forEach(e => {
      if (e.date) years.add(e.date.substring(0,4));
    });
    const sortedYears = Array.from(years).sort();
    sortedYears.forEach(year => {
      labels.push(year);
      const yearExpenses = periodExpenses.filter(e => e.date.substring(0,4) === year);
      dateGroups[year] = yearExpenses.reduce((s, e) => s + e.amount, 0);
    });
  }
  
  const data = labels.map(label => dateGroups[label] || 0);
  
  return { labels, data };
}

function renderTrendChart() {
  const { labels, data } = getTrendData();
  
  const chartCanvas = document.getElementById('trendLineChart');
  if (!chartCanvas) return;
  
  // Destroy existing chart
  if (trendChartInstance) {
    trendChartInstance.destroy();
  }
  
  const ctx = chartCanvas.getContext('2d');
  const isDarkMode = document.documentElement.getAttribute('data-theme') === 'dark';
  
  trendChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Spending',
        data: data,
        borderColor: '#4a9eff',
        backgroundColor: 'rgba(74, 158, 255, 0.1)',
        borderWidth: 3,
        fill: true,
        tension: 0.4,
        pointRadius: 5,
        pointBackgroundColor: '#4a9eff',
        pointBorderColor: isDarkMode ? '#262626' : '#ffffff',
        pointBorderWidth: 2,
        pointHoverRadius: 7,
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
          display: true,
          labels: {
            color: isDarkMode ? '#b0b0b0' : '#666666',
            font: { size: 12, weight: '500' },
            padding: 16,
            usePointStyle: false
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
            label: function(context) {
              return 'Spent: ' + fmt(context.parsed.y);
            }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          grid: {
            color: isDarkMode ? 'rgba(58, 58, 58, 0.5)' : 'rgba(229, 229, 229, 0.5)',
            drawBorder: false
          },
          ticks: {
            color: isDarkMode ? '#b0b0b0' : '#666666',
            font: { size: 11 },
            callback: function(value) {
              return fmt(value);
            }
          }
        },
        x: {
          grid: {
            display: false,
            drawBorder: false
          },
          ticks: {
            color: isDarkMode ? '#b0b0b0' : '#666666',
            font: { size: 11 }
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
});

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
  const yearSelect = document.getElementById('picker-year');
  const currentYear = new Date().getFullYear();
  const years = new Set([currentYear]);
  allExpenses.forEach(e => { if (e.date) years.add(parseInt(e.date.substring(0,4))); });
  const sorted = Array.from(years).sort((a,b) => b-a);
  yearSelect.innerHTML = '<option value="">All Years</option>';
  sorted.forEach(y => {
    const opt = document.createElement('option');
    opt.value = y; opt.textContent = y;
    yearSelect.appendChild(opt);
  });
}

function initPeriodPicker() {
  const now = new Date();
  document.getElementById('picker-month').value = String(now.getMonth()+1).padStart(2,'0');
  document.getElementById('picker-year').value  = now.getFullYear();
  updatePeriodLabel();
  updatePeriodSummary();
}

window.onPeriodChange = function() {
  updatePeriodLabel();
  renderDashboardTable();
  // Defer chart updates
  requestAnimationFrame(() => {
    renderPieChart();
    renderTrendChart();
  });
}

window.resetPeriodPicker = function() {
  const now = new Date();
  document.getElementById('picker-month').value = String(now.getMonth()+1).padStart(2,'0');
  document.getElementById('picker-year').value  = now.getFullYear();
  updatePeriodLabel(); renderDashboardTable();
}

function updatePeriodLabel() {
  const m = document.getElementById('picker-month').value;
  const y = document.getElementById('picker-year').value;
  const months = ['','January','February','March','April','May','June','July','August','September','October','November','December'];
  let label = 'Showing all time';
  if (m && y) label = 'Showing ' + months[parseInt(m)] + ' ' + y;
  else if (m) label = 'Showing ' + months[parseInt(m)] + ' (all years)';
  else if (y) label = 'Showing all of ' + y;
  document.getElementById('period-picker-sub').textContent = label;
}

function getPeriodExpenses() {
  const m = document.getElementById('picker-month') ? document.getElementById('picker-month').value : '';
  const y = document.getElementById('picker-year')  ? document.getElementById('picker-year').value  : '';
  return allExpenses.filter(e => {
    if (!e.date) return false;
    if (y && e.date.substring(0,4) !== String(y)) return false;
    if (m && e.date.substring(5,7) !== String(m)) return false;
    return true;
  });
}

function updatePeriodSummary() {
  const rows = getPeriodExpenses();
  const total = rows.reduce((s,e) => s+e.amount, 0);
  const max   = rows.length ? Math.max(...rows.map(e => e.amount)) : 0;
  const uniqueDays = new Set(rows.map(e => e.date)).size;
  const avg = uniqueDays > 0 ? total / uniqueDays : 0;
  document.getElementById('period-total').textContent = fmt(total);
  document.getElementById('period-count').textContent = rows.length;
  document.getElementById('period-avg').textContent   = fmt(avg);
  document.getElementById('period-max').textContent   = fmt(max);
}

// Override renderDashboardTable to respect period picker
const _baseRenderDashboard = renderDashboardTable;
renderDashboardTable = function() {
  const pm = document.getElementById('picker-month');
  if (!pm) { _baseRenderDashboard(); return; }
  const periodRows = getPeriodExpenses();
  const now = new Date(); const today = todayStr();
  const selectedMonth = document.getElementById('picker-month').value;
  const selectedYear = document.getElementById('picker-year').value;
  let rows;
  if (activeTab === 'daily') {
    rows = periodRows.filter(e => e.date === today);
  } else if (activeTab === 'weekly') {
    const ws = getWeekStart();
    rows = periodRows.filter(e => e.date >= ws && e.date <= today);
  } else if (activeTab === 'monthly') {
    // Use selected month/year if available, otherwise use current
    let displayYear = selectedYear || now.getFullYear();
    let displayMonth = selectedMonth || pad(now.getMonth()+1);
    const ms = displayYear + '-' + displayMonth + '-01';
    // Calculate the last day of the selected month
    const lastDay = new Date(displayYear, parseInt(displayMonth), 0).getDate();
    const me = displayYear + '-' + displayMonth + '-' + pad(lastDay);
    rows = periodRows.filter(e => e.date >= ms && e.date <= me);
  } else {
    rows = periodRows;
  }
  renderTable('table-body', rows, false);
  updatePeriodSummary();
};

// After data loads, init the picker (removed duplicate - using main optimization)
const _baseSwitchTab = window.switchTableTab;

document.addEventListener('DOMContentLoaded', () => {
  const pm = document.getElementById('picker-month');
  const py = document.getElementById('picker-year');
  if (pm) pm.addEventListener('change', window.onPeriodChange);
  if (py) py.addEventListener('change', window.onPeriodChange);
});

// FORGOT PASSWORD
window.showForgotPassword = function() {
  const loginEmail = document.getElementById('login-email').value.trim();
  if (loginEmail) document.getElementById('forgot-email').value = loginEmail;
  resetForgotModal();
  document.getElementById('forgot-modal').classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
  setTimeout(() => document.getElementById('forgot-email').focus(), 100);
};
window.closeForgotModal = function() {
  document.getElementById('forgot-modal').classList.add('hidden');
};
window.resetForgotModal = function() {
  document.getElementById('forgot-step-1').classList.remove('hidden');
  document.getElementById('forgot-step-2').classList.add('hidden');
  const e = document.getElementById('forgot-error');
  e.classList.add('hidden'); e.textContent = '';
};
window.handleForgotPassword = async function() {
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
  } catch(e2) {
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
});