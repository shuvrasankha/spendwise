// backup.js — SpendWise Data Backup & Restore Module

import { auth, db } from '../config/firebase.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { collection, getDocs, query, where, addDoc, writeBatch, doc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// ── State ────────────────────────────────────────────────────────────────────
let currentUser = null;

// ── Auth listener ────────────────────────────────────────────────────────────
onAuthStateChanged(auth, user => {
  currentUser = user;
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function showToast(msg, type) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast ' + (type || 'success');
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 3000);
}

function showBackupStatus(msg, type) {
  const el = document.getElementById('backup-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'backup-status backup-status-' + type;
  el.classList.remove('hidden');
}

function hideBackupStatus() {
  const el = document.getElementById('backup-status');
  if (el) el.classList.add('hidden');
}

// ── Export Data ──────────────────────────────────────────────────────────────
async function exportData() {
  if (!currentUser) {
    showToast('Please log in first.', 'error');
    return;
  }

  const btn = document.getElementById('btn-export');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-2" class="voice-spin"></i> Exporting…';
    if (window.lucide) lucide.createIcons();
  }

  showBackupStatus('Fetching your data…', 'loading');

  try {
    const uid = currentUser.uid;
    const data = {
      version: '1.0',
      exportDate: new Date().toISOString(),
      expenses: [],
      income: [],
      debts: []
    };

    // Fetch expenses
    const expQuery = query(collection(db, 'expenses'), where('uid', '==', uid));
    const expSnap = await getDocs(expQuery);
    data.expenses = expSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Fetch income
    const incQuery = query(collection(db, 'income'), where('uid', '==', uid));
    const incSnap = await getDocs(incQuery);
    data.income = incSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Fetch debts
    const debtQuery = query(collection(db, 'debts'), where('uid', '==', uid));
    const debtSnap = await getDocs(debtQuery);
    data.debts = debtSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Create and download JSON file
    const jsonStr = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const date = new Date().toISOString().split('T')[0];
    a.href = url;
    a.download = `spendwise-backup-${date}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    const totalItems = data.expenses.length + data.income.length + data.debts.length;
    showBackupStatus(`✅ Exported ${totalItems} items successfully!`, 'success');
    showToast('Backup exported!', 'success');

  } catch (err) {
    console.error('Export error:', err);
    showBackupStatus('❌ Export failed. Please try again.', 'error');
    showToast('Export failed.', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="download"></i> Export Backup';
      if (window.lucide) lucide.createIcons();
    }
  }
}

// ── Import Data ──────────────────────────────────────────────────────────────

// Validate a single record before importing
function validateRecord(record, type) {
  if (!record || typeof record !== 'object') return false;
  if (typeof record.amount !== 'number' || record.amount <= 0) return false;
  if (record.date && !/^\d{4}-\d{2}-\d{2}$/.test(record.date)) return false;
  if (record.notes && typeof record.notes !== 'string') return false;
  // Enforce max string lengths to prevent abuse
  const maxStr = 500;
  if (record.description && (typeof record.description !== 'string' || record.description.length > maxStr)) return false;
  if (record.category && (typeof record.category !== 'string' || record.category.length > 50)) return false;
  if (record.person && (typeof record.person !== 'string' || record.person.length > 100)) return false;
  if (record.source && (typeof record.source !== 'string' || record.source.length > 100)) return false;

  if (type === 'expense') {
    if (!record.category) return false;
    if (record.payment && typeof record.payment !== 'string') return false;
  } else if (type === 'income') {
    if (!record.source) return false;
    if (record.paymentType && !['Online', 'Cash'].includes(record.paymentType)) return false;
  } else if (type === 'debt') {
    if (!record.person) return false;
    if (record.type && !['they-owe', 'i-owe'].includes(record.type)) return false;
  }
  return true;
}

async function importData(file) {
  if (!currentUser) {
    showToast('Please log in first.', 'error');
    return;
  }

  const btn = document.getElementById('btn-import');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-2" class="voice-spin"></i> Importing…';
    if (window.lucide) lucide.createIcons();
  }

  showBackupStatus('Reading file…', 'loading');

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    // Validate structure
    if (!data.version || !data.expenses || !data.income || !data.debts) {
      throw new Error('Invalid backup file structure.');
    }

    const uid = currentUser.uid;
    const batch = writeBatch(db);
    let importedCount = 0;

    showBackupStatus('Preparing import…', 'loading');

    // Import expenses
    for (const exp of data.expenses) {
      if (exp.uid !== uid) continue;
      if (!validateRecord(exp, 'expense')) continue;
      const ref = doc(collection(db, 'expenses'));
      const { id, ...rest } = exp;
      batch.set(ref, { ...rest, createdAt: serverTimestamp() });
      importedCount++;
    }

    // Import income
    for (const inc of data.income) {
      if (inc.uid !== uid) continue;
      if (!validateRecord(inc, 'income')) continue;
      const ref = doc(collection(db, 'income'));
      const { id, ...rest } = inc;
      batch.set(ref, { ...rest, createdAt: serverTimestamp() });
      importedCount++;
    }

    // Import debts
    for (const debt of data.debts) {
      if (debt.uid !== uid) continue;
      if (!validateRecord(debt, 'debt')) continue;
      const ref = doc(collection(db, 'debts'));
      const { id, ...rest } = debt;
      batch.set(ref, { ...rest, createdAt: serverTimestamp() });
      importedCount++;
    }

    if (importedCount === 0) {
      showBackupStatus('⚠️ No items found for your account in this backup.', 'warning');
      showToast('No items to import.', 'error');
      return;
    }

    showBackupStatus(`Importing ${importedCount} items…`, 'loading');
    await batch.commit();

    showBackupStatus(`✅ Imported ${importedCount} items successfully!`, 'success');
    showToast(`Backup restored! ${importedCount} items imported.`, 'success');

    // Reload page to refresh data
    setTimeout(() => window.location.reload(), 1500);

  } catch (err) {
    console.error('Import error:', err);
    const msg = err.message === 'Invalid backup file structure.'
      ? '❌ Invalid backup file. Please use a valid SpendWise backup.'
      : '❌ Import failed. Please try again.';
    showBackupStatus(msg, 'error');
    showToast('Import failed.', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="upload"></i> Import Backup';
      if (window.lucide) lucide.createIcons();
    }
  }
}

// ── UI Controller ────────────────────────────────────────────────────────────
function openBackupModal() {
  const modal = document.getElementById('backup-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  hideBackupStatus();
  // Reset file input
  const fileInput = document.getElementById('backup-file-input');
  if (fileInput) fileInput.value = '';
  const fileName = document.getElementById('backup-file-name');
  if (fileName) fileName.textContent = 'No file selected';
  if (window.lucide) lucide.createIcons();
}

function closeBackupModal() {
  const modal = document.getElementById('backup-modal');
  if (modal) modal.classList.add('hidden');
}

function handleFileSelect(event) {
  const file = event.target.files[0];
  const fileName = document.getElementById('backup-file-name');
  if (fileName) {
    fileName.textContent = file ? file.name : 'No file selected';
    fileName.classList.toggle('has-file', !!file);
  }
}

function handleDrop(event) {
  event.preventDefault();
  const dropZone = document.getElementById('backup-file-drop');
  if (dropZone) dropZone.classList.remove('drag-over');
  
  const file = event.dataTransfer.files[0];
  if (file && file.type === 'application/json') {
    const fileInput = document.getElementById('backup-file-input');
    if (fileInput) {
      // Create a new FileList-like object
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
    }
    const fileName = document.getElementById('backup-file-name');
    if (fileName) {
      fileName.textContent = file.name;
      fileName.classList.add('has-file');
    }
  }
}

function handleDragOver(event) {
  event.preventDefault();
  const dropZone = document.getElementById('backup-file-drop');
  if (dropZone) dropZone.classList.add('drag-over');
}

function handleDragLeave(event) {
  event.preventDefault();
  const dropZone = document.getElementById('backup-file-drop');
  if (dropZone) dropZone.classList.remove('drag-over');
}

function handleImportClick() {
  const fileInput = document.getElementById('backup-file-input');
  if (fileInput && fileInput.files[0]) {
    importData(fileInput.files[0]);
  } else {
    showBackupStatus('⚠️ Please select a backup file first.', 'warning');
  }
}

// ── Drag & Drop Setup ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const dropZone = document.getElementById('backup-file-drop');
  if (dropZone) {
    dropZone.addEventListener('dragover', handleDragOver);
    dropZone.addEventListener('dragleave', handleDragLeave);
    dropZone.addEventListener('drop', handleDrop);
  }
});

// ── Expose to global ─────────────────────────────────────────────────────────
window.openBackupModal = openBackupModal;
window.closeBackupModal = closeBackupModal;
window.exportData = exportData;
window.handleFileSelect = handleFileSelect;
window.handleImportClick = handleImportClick;
