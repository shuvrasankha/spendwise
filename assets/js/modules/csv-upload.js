// csv-upload.js — SpendWise CSV Import via NVIDIA NIM API
// Reads a user-uploaded CSV, sends it to an LLM for structured extraction,
// previews the result, and batch-saves to Firestore.

import { app } from '../config/firebase.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, addDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const auth = getAuth(app);
const db = getFirestore(app);

// Currency helpers from global scope (currency.js loads before this module)
const fmt = window.fmt;

// ══════════════════════════════════════════════════════════════════════════════
//  🔑  HUGGING FACE API CONFIG
//  Since Netlify is removed, we use Hugging Face router which supports CORS natively.
// ══════════════════════════════════════════════════════════════════════════════
const HF_API_URL = 'https://router.huggingface.co/v1/chat/completions';
const HF_MODEL = 'Qwen/Qwen2.5-7B-Instruct'; // Lightweight, very fast model

let HF_TOKEN = '__HF_TOKEN_PLACEHOLDER__';
try {
  const cfg = await import('../../voice-config.js'); // Reuse HF token from voice-config if present
  if (cfg.HF_TOKEN) HF_TOKEN = cfg.HF_TOKEN;
} catch (_) { /* not present */ }

// ── Constants ────────────────────────────────────────────────────────────────
const VALID_CATEGORIES = [
  'Food & Dining', 'Transport', 'Shopping', 'Entertainment', 'Health',
  'Bills & Utilities', 'Education', 'Travel', 'Groceries', 'Subscription',
  'Rent', 'Investment', 'Personal Care', 'Gifts', 'Other'
];

const VALID_PAYMENTS = ['UPI', 'Cash', 'Credit Card', 'Debit Card', 'Net Banking', 'Other'];

// ── State ────────────────────────────────────────────────────────────────────
let currentUser = null;
let parsedTransactions = [];
let isProcessing = false;

// ── Auth Listener ────────────────────────────────────────────────────────────
onAuthStateChanged(auth, user => { currentUser = user; });

// ── Helpers ──────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// fmt() is now provided by currency.js

function showToast(msg, type) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast ' + (type || 'success');
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 3500);
}


// ══════════════════════════════════════════════════════════════════════════════
//  FILE READING
// ══════════════════════════════════════════════════════════════════════════════
function readCSVFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('No file selected.'));
    if (file.size > 512 * 1024) return reject(new Error('File is too large (max 512 KB).'));
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read the file.'));
    reader.readAsText(file);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  PROMPT ENGINEERING — CSV → structured JSON
// ══════════════════════════════════════════════════════════════════════════════
function buildCSVPrompt(csvText) {
  const system = `You are a data extraction assistant for SpendWise, an Indian expense tracker app.
The user will provide raw CSV data from their previous expense/income records.
Your job is to parse each row and map it into the SpendWise JSON format.

RULES:
1. Return ONLY a valid JSON array. No markdown, no explanation, no code fences.
2. Each object must have these exact keys:
   - "amount": number (positive, in Indian Rupees)
   - "category": one of ${JSON.stringify(VALID_CATEGORIES)}
   - "description": string (short description of the transaction)
   - "payment": one of ${JSON.stringify(VALID_PAYMENTS)}
   - "date": string in "YYYY-MM-DD" format
   - "notes": string (any extra info, or empty string)
   - "type": "expense" or "income"
3. If a column doesn't clearly map, use your best judgement.
4. If the category doesn't match any valid option, use "Other".
5. If payment method is unclear, default to "UPI".
6. If a date is in DD/MM/YYYY or MM/DD/YYYY or other format, convert to YYYY-MM-DD.
7. If you cannot determine "type", assume "expense".
8. Skip header rows if present. Skip any obviously empty/invalid rows.
9. Amounts should always be positive numbers (no currency symbols).
10. If the CSV appears to have income entries (salary, freelance, refund, etc.), set type to "income".

Example output:
[
  {"amount": 250, "category": "Food & Dining", "description": "Lunch at restaurant", "payment": "UPI", "date": "2025-03-15", "notes": "", "type": "expense"},
  {"amount": 50000, "category": "Other", "description": "March Salary", "payment": "Net Banking", "date": "2025-03-01", "notes": "Monthly salary", "type": "income"}
]`;

  const user = `Here is my CSV data. Parse every valid row into the SpendWise JSON format:\n\n${csvText}`;

  return { system, user };
}

// ══════════════════════════════════════════════════════════════════════════════
//  HUGGING FACE API CALL
// ══════════════════════════════════════════════════════════════════════════════
async function callHuggingFaceAPI(csvText) {
  if (!HF_TOKEN || HF_TOKEN.includes('PLACEHOLDER') || HF_TOKEN.length < 10) {
    throw new Error('HF_TOKEN_NOT_SET');
  }

  const prompt = buildCSVPrompt(csvText);

  const response = await fetch(HF_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${HF_TOKEN}`
    },
    body: JSON.stringify({
      model: HF_MODEL,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user }
      ],
      max_tokens: 4096,
      temperature: 0.1,
      top_p: 0.9
    })
  });

  if (response.status === 429) throw new Error('RATE_LIMITED');
  if (response.status === 503) throw new Error('MODEL_LOADING');
  if (!response.ok) {
    console.error('API error:', response.status, await response.text().catch(() => ''));
    throw new Error('API_ERROR');
  }

  const result = await response.json();
  const content = result.choices?.[0]?.message?.content;
  if (!content) throw new Error('EMPTY_RESPONSE');

  // Extract JSON from response
  let jsonStr = content.trim();
  // Strip markdown fences if present
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonStr = jsonMatch[1].trim();
  // Find the array
  const arrMatch = jsonStr.match(/\[[\s\S]*\]/);
  if (arrMatch) jsonStr = arrMatch[0];

  const parsed = JSON.parse(jsonStr);
  if (!Array.isArray(parsed)) throw new Error('INVALID_FORMAT');

  // Validate & sanitise each entry
  return parsed.map(entry => ({
    amount: Math.abs(parseFloat(entry.amount)) || 0,
    category: VALID_CATEGORIES.includes(entry.category) ? entry.category : 'Other',
    description: String(entry.description || '-').slice(0, 200),
    payment: VALID_PAYMENTS.includes(entry.payment) ? entry.payment : 'UPI',
    date: /^\d{4}-\d{2}-\d{2}$/.test(entry.date) ? entry.date : new Date().toISOString().slice(0, 10),
    notes: String(entry.notes || '').slice(0, 500),
    type: entry.type === 'income' ? 'income' : 'expense'
  })).filter(e => e.amount > 0);
}

// ══════════════════════════════════════════════════════════════════════════════
//  FIRESTORE BATCH SAVE
// ══════════════════════════════════════════════════════════════════════════════
async function saveToFirestore(transactions) {
  if (!currentUser) throw new Error('NOT_AUTHENTICATED');

  let savedExpenses = 0;
  let savedIncome = 0;

  for (const tx of transactions) {
    if (tx.type === 'income') {
      await addDoc(collection(db, 'income'), {
        uid: currentUser.uid,
        amount: tx.amount,
        source: tx.description,
        date: tx.date,
        paymentType: tx.payment === 'Cash' ? 'Cash' : 'Online',
        bank: '',
        notes: tx.notes,
        createdAt: serverTimestamp()
      });
      savedIncome++;
    } else {
      await addDoc(collection(db, 'expenses'), {
        uid: currentUser.uid,
        amount: tx.amount,
        category: tx.category,
        date: tx.date,
        payment: tx.payment,
        cardName: '',
        description: tx.description,
        notes: tx.notes,
        encoding: 'plain',
        createdAt: serverTimestamp()
      });
      savedExpenses++;
    }
  }

  return { savedExpenses, savedIncome };
}

// ══════════════════════════════════════════════════════════════════════════════
//  UI — MODAL RENDERING
// ══════════════════════════════════════════════════════════════════════════════
function getModal() { return document.getElementById('csv-import-modal'); }
function getOverlay() { return document.getElementById('csv-import-overlay'); }

function openModal() {
  const overlay = getOverlay();
  if (overlay) {
    overlay.classList.remove('hidden');
    requestAnimationFrame(() => overlay.classList.add('visible'));
  }
  resetModalState();
}

function closeModal() {
  const overlay = getOverlay();
  if (overlay) {
    overlay.classList.remove('visible');
    setTimeout(() => overlay.classList.add('hidden'), 300);
  }
  parsedTransactions = [];
  isProcessing = false;
}

function resetModalState() {
  const fileInput = document.getElementById('csv-file-input');
  if (fileInput) fileInput.value = '';

  showModalPhase('upload'); // upload → processing → preview → saving → done
}

function showModalPhase(phase) {
  ['upload', 'processing', 'preview', 'saving', 'done', 'error'].forEach(p => {
    const el = document.getElementById('csv-phase-' + p);
    if (el) el.classList.toggle('hidden', p !== phase);
  });
}

function renderPreviewTable(transactions) {
  parsedTransactions = transactions;
  const tbody = document.getElementById('csv-preview-body');
  const countEl = document.getElementById('csv-preview-count');
  if (!tbody) return;

  const expenses = transactions.filter(t => t.type === 'expense');
  const incomes = transactions.filter(t => t.type === 'income');
  const totalExpense = expenses.reduce((s, t) => s + t.amount, 0);
  const totalIncome = incomes.reduce((s, t) => s + t.amount, 0);

  if (countEl) {
    countEl.innerHTML = `
      <span class="csv-stat"><i data-lucide="trending-down"></i> ${expenses.length} expense${expenses.length !== 1 ? 's' : ''} (${fmt(totalExpense)})</span>
      <span class="csv-stat csv-stat-income"><i data-lucide="trending-up"></i> ${incomes.length} income (${fmt(totalIncome)})</span>
    `;
  }

  tbody.innerHTML = '';
  transactions.forEach((tx, idx) => {
    const tr = document.createElement('tr');
    tr.className = tx.type === 'income' ? 'csv-row-income' : '';

    const tdCheck = document.createElement('td');
    tdCheck.innerHTML = `<input type="checkbox" class="csv-row-check" data-idx="${idx}" checked />`;
    tr.appendChild(tdCheck);

    const tdDate = document.createElement('td');
    tdDate.textContent = tx.date;
    tr.appendChild(tdDate);

    const tdType = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'csv-type-badge csv-type-' + tx.type;
    badge.textContent = tx.type === 'income' ? 'Income' : 'Expense';
    tdType.appendChild(badge);
    tr.appendChild(tdType);

    const tdCat = document.createElement('td');
    tdCat.textContent = tx.type === 'income' ? '-' : tx.category;
    tr.appendChild(tdCat);

    const tdDesc = document.createElement('td');
    tdDesc.textContent = tx.description;
    tdDesc.className = 'csv-desc-cell';
    tr.appendChild(tdDesc);

    const tdPay = document.createElement('td');
    tdPay.textContent = tx.payment;
    tr.appendChild(tdPay);

    const tdAmt = document.createElement('td');
    tdAmt.className = 'text-right';
    tdAmt.textContent = fmt(tx.amount);
    tr.appendChild(tdAmt);

    tbody.appendChild(tr);
  });

  if (window.lucide) lucide.createIcons();
}

function getSelectedTransactions() {
  const checks = document.querySelectorAll('.csv-row-check');
  const selected = [];
  checks.forEach(cb => {
    if (cb.checked) {
      const idx = parseInt(cb.dataset.idx);
      if (parsedTransactions[idx]) selected.push(parsedTransactions[idx]);
    }
  });
  return selected;
}

// ══════════════════════════════════════════════════════════════════════════════
//  MAIN FLOW — Upload → Parse → Preview → Save
// ══════════════════════════════════════════════════════════════════════════════
async function handleFileUpload() {
  if (isProcessing) return;
  if (!currentUser) {
    showToast('Please log in first.', 'error');
    return;
  }

  const fileInput = document.getElementById('csv-file-input');
  const file = fileInput?.files?.[0];
  if (!file) {
    showToast('Please select a CSV file.', 'error');
    return;
  }

  isProcessing = true;
  showModalPhase('processing');

  try {
    // Step 1: Read CSV
    updateProcessingStep(1, 'Reading your CSV file…');
    const csvText = await readCSVFile(file);

    // Check for reasonable content
    const lineCount = csvText.split('\n').filter(l => l.trim()).length;
    if (lineCount < 2) {
      throw new Error('CSV_TOO_SHORT');
    }
    if (lineCount > 200) {
      throw new Error('CSV_TOO_MANY_ROWS');
    }

    // Step 2: AI parsing
    updateProcessingStep(2, 'AI is analyzing your data…');
    const transactions = await callHuggingFaceAPI(csvText);

    if (!transactions.length) {
      throw new Error('NO_DATA_EXTRACTED');
    }

    // Step 3: Show preview
    updateProcessingStep(3, 'Preparing preview…');
    await new Promise(r => setTimeout(r, 400));

    showModalPhase('preview');
    renderPreviewTable(transactions);
  } catch (err) {
    showModalPhase('error');
    const errorText = document.getElementById('csv-error-text');
    if (errorText) {
      const messages = {
        'HF_TOKEN_NOT_SET': '⚠️ Hugging Face Token not configured. Please set up your token.',
        'RATE_LIMITED': '⏳ Rate limited by AI Provider. Please wait and try again.',
        'MODEL_LOADING': '⏳ AI model is loading. Please try again in 20-30 seconds.',
        'CSV_TOO_SHORT': '📄 CSV file is too short. Need at least 2 rows (header + data).',
        'CSV_TOO_MANY_ROWS': '📄 CSV is too large. Please limit to 200 rows at a time.',
        'NO_DATA_EXTRACTED': '🔍 Could not extract any valid transactions from this CSV.',
        'EMPTY_RESPONSE': '🤖 AI returned an empty response. Please try again.',
        'INVALID_FORMAT': '🤖 AI returned data in unexpected format. Please try again.'
      };
      errorText.textContent = messages[err.message] || `Error: ${err.message}`;
    }
  } finally {
    isProcessing = false;
  }
}

function updateProcessingStep(step, text) {
  for (let i = 1; i <= 3; i++) {
    const el = document.getElementById('csv-step-' + i);
    if (!el) continue;
    el.classList.remove('active', 'done');
    if (i < step) el.classList.add('done');
    if (i === step) el.classList.add('active');
    const span = el.querySelector('span');
    if (span && i === step) span.textContent = text;
  }
}

async function handleConfirmImport() {
  if (isProcessing) return;
  const selected = getSelectedTransactions();
  if (!selected.length) {
    showToast('No transactions selected.', 'error');
    return;
  }

  isProcessing = true;
  showModalPhase('saving');

  try {
    const result = await saveToFirestore(selected);
    showModalPhase('done');
    const doneText = document.getElementById('csv-done-text');
    if (doneText) {
      let msg = '';
      if (result.savedExpenses > 0) msg += `${result.savedExpenses} expense${result.savedExpenses !== 1 ? 's' : ''}`;
      if (result.savedIncome > 0) {
        if (msg) msg += ' and ';
        msg += `${result.savedIncome} income entr${result.savedIncome !== 1 ? 'ies' : 'y'}`;
      }
      doneText.textContent = `Successfully imported ${msg}!`;
    }
  } catch (err) {
    console.error('Save error:', err);
    showModalPhase('error');
    const errorText = document.getElementById('csv-error-text');
    if (errorText) errorText.textContent = 'Failed to save transactions. Please try again.';
  } finally {
    isProcessing = false;
  }
}

function handleDoneClose() {
  closeModal();
  // Reload page to refresh data from Firestore
  window.location.reload();
}

// ══════════════════════════════════════════════════════════════════════════════
//  SELECT ALL / DESELECT ALL
// ══════════════════════════════════════════════════════════════════════════════
function toggleSelectAll() {
  const masterCb = document.getElementById('csv-select-all');
  const checks = document.querySelectorAll('.csv-row-check');
  checks.forEach(cb => { cb.checked = masterCb.checked; });
}

// ══════════════════════════════════════════════════════════════════════════════
//  DRAG & DROP SUPPORT
// ══════════════════════════════════════════════════════════════════════════════
function setupDragDrop() {
  const dropZone = document.getElementById('csv-drop-zone');
  const fileInput = document.getElementById('csv-file-input');
  if (!dropZone || !fileInput) return;

  ['dragenter', 'dragover'].forEach(evt => {
    dropZone.addEventListener(evt, e => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add('drag-over');
    });
  });

  ['dragleave', 'drop'].forEach(evt => {
    dropZone.addEventListener(evt, e => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('drag-over');
    });
  });

  dropZone.addEventListener('drop', e => {
    const file = e.dataTransfer?.files?.[0];
    if (file && (file.name.endsWith('.csv') || file.type === 'text/csv')) {
      // Assign dropped file to the input
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      updateFileName(file.name);
    } else {
      showToast('Please drop a .csv file.', 'error');
    }
  });

  fileInput.addEventListener('change', () => {
    const name = fileInput.files?.[0]?.name;
    if (name) updateFileName(name);
  });
}

function updateFileName(name) {
  const nameEl = document.getElementById('csv-file-name');
  if (nameEl) {
    nameEl.textContent = name;
    nameEl.classList.add('has-file');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  INIT — Wire up events
// ══════════════════════════════════════════════════════════════════════════════
function initCSVUpload() {
  // Open modal button
  const openBtn = document.getElementById('csv-import-btn');
  if (openBtn) openBtn.addEventListener('click', openModal);

  // Close modal (X button + overlay click)
  const closeBtn = document.getElementById('csv-close-btn');
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  const overlay = getOverlay();
  if (overlay) overlay.addEventListener('click', e => {
    if (e.target === overlay) closeModal();
  });

  // Upload / Parse
  const parseBtn = document.getElementById('csv-parse-btn');
  if (parseBtn) parseBtn.addEventListener('click', handleFileUpload);

  // Confirm import
  const confirmBtn = document.getElementById('csv-confirm-btn');
  if (confirmBtn) confirmBtn.addEventListener('click', handleConfirmImport);

  // Done close
  const doneBtn = document.getElementById('csv-done-btn');
  if (doneBtn) doneBtn.addEventListener('click', handleDoneClose);

  // Retry from error
  const retryBtn = document.getElementById('csv-retry-btn');
  if (retryBtn) retryBtn.addEventListener('click', () => {
    resetModalState();
  });

  // Back to upload from preview
  const backBtn = document.getElementById('csv-back-btn');
  if (backBtn) backBtn.addEventListener('click', () => {
    resetModalState();
  });

  // Select all checkbox
  const selectAll = document.getElementById('csv-select-all');
  if (selectAll) selectAll.addEventListener('change', toggleSelectAll);

  // Drag & drop
  setupDragDrop();
}

// ── DOM-ready dispatcher ─────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initCSVUpload);
} else {
  initCSVUpload();
}
