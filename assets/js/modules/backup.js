// backup.js — SpendWise Data Backup & Restore Module

import { auth, db } from '../config/firebase.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { collection, getDocs, query, where, addDoc, writeBatch, doc, serverTimestamp, runTransaction } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { todayStr } from '../utils/helpers.js';
import { moneyFromCents, moneyToCents } from './credit-card-data.js';

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
  // Errors stay until tapped (accessibility.js); a slow reader must not lose them
  if (type !== 'error') setTimeout(() => t.classList.add('hidden'), 3000);
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
    btn.innerHTML = '<i data-lucide="loader-2" class="voice-spin"></i> Downloading…';
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
      debts: [],
      holdings: [],
      creditCards: [],
      cardPayments: [],
      cardRefunds: []
    };

    // Fetch expenses
    const expQuery = query(collection(db, 'expenses'), where('uid', '==', uid));
    const expSnap = await getDocs(expQuery);
    data.expenses = expSnap.docs.map(d => {
      const { refundedTotal, ...record } = d.data();
      return { id: d.id, ...record };
    });

    // Fetch income
    const incQuery = query(collection(db, 'income'), where('uid', '==', uid));
    const incSnap = await getDocs(incQuery);
    data.income = incSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Fetch debts
    const debtQuery = query(collection(db, 'debts'), where('uid', '==', uid));
    const debtSnap = await getDocs(debtQuery);
    data.debts = debtSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Fetch holdings (Investments); none before the updated rules are published
    try {
      const holdSnap = await getDocs(query(collection(db, 'holdings'), where('uid', '==', uid)));
      data.holdings = holdSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) { console.warn('Holdings not exported:', e); }

    const [cards, payments, refunds] = await Promise.all(
      ['creditCards', 'cardPayments', 'cardRefunds']
        .map(name => getDocs(query(collection(db, name), where('uid', '==', uid))))
    );
    data.creditCards = cards.docs.map(d => creditCardBackupRecord(d.id, d.data()));
    data.cardPayments = payments.docs.map(d => cardPaymentBackupRecord(d.id, d.data()));
    data.cardRefunds = refunds.docs.map(d => cardRefundBackupRecord(d.id, d.data()));

    // Create and download JSON file
    const jsonStr = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const date = todayStr();
    a.href = url;
    a.download = `spendwise-backup-${date}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    const totalItems = data.expenses.length + data.income.length + data.debts.length + data.holdings.length
      + data.creditCards.length + data.cardPayments.length + data.cardRefunds.length;
    showBackupStatus(`Exported ${totalItems} items successfully!`, 'success');
    showToast('Backup exported!', 'success');

  } catch (err) {
    console.error('Export error:', err);
    showBackupStatus('Export failed. Please try again.', 'error');
    showToast('Export failed.', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Download';
      if (window.lucide) lucide.createIcons();
    }
  }
}

// ── Import Data ──────────────────────────────────────────────────────────────

const BATCH_LIMIT = 500;
const DOC_ID = /^[A-Za-z0-9_-]{1,128}$/;

function pickFields(record, fields) {
  return Object.fromEntries(fields.filter(key => record[key] !== undefined).map(key => [key, record[key]]));
}

function creditCardBackupRecord(id, record) {
  return { id, ...pickFields(record, ['uid', 'name', 'issuer', 'network', 'last4', 'creditLimit', 'statementDay', 'dueDay', 'active', 'createdAt', 'updatedAt']) };
}

function cardPaymentBackupRecord(id, record) {
  return { id, ...pickFields(record, ['uid', 'creditCardId', 'statementId', 'amount', 'paymentDate', 'paymentType', 'idempotencyKey', 'createdAt']) };
}

function cardRefundBackupRecord(id, record) {
  return { id, ...pickFields(record, ['uid', 'creditCardId', 'originalExpenseId', 'amount', 'refundDate', 'description', 'createdAt']) };
}

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

// A holding (Investments) as firestore.rules accepts it; only those fields are restored
const HOLDING_KINDS = ['mf', 'stocks', 'fd', 'rd', 'ppf', 'nps', 'epf', 'gold', 'other'];
function holdingRecord(r) {
  if (!r || typeof r !== 'object' || typeof r.name !== 'string' || !r.name.trim() || r.name.length > 60) return null;
  if (!HOLDING_KINDS.includes(r.kind)) return null;
  const valued = typeof r.value === 'number' && r.value >= 0 && /^\d{4}-\d{2}-\d{2}$/.test(r.valueDate || '');
  return {
    id: r.id, uid: r.uid, name: r.name, kind: r.kind,
    ...(valued && { value: r.value, valueDate: r.valueDate }),
    ...(typeof r.goalId === 'string' && r.goalId && r.goalId.length <= 40 && { goalId: r.goalId }),
  };
}

function creditCardRecord(r) {
  if (!r || typeof r !== 'object' || !DOC_ID.test(r.id || '')
    || typeof r.name !== 'string' || !r.name.trim() || r.name.length > 60
    || typeof r.issuer !== 'string' || !r.issuer.trim() || r.issuer.length > 60
    || (r.last4 && !/^\d{4}$/.test(r.last4))
    || (r.creditLimit !== undefined && (!Number.isFinite(r.creditLimit) || r.creditLimit < 0))
    || (r.statementDay !== undefined && (!Number.isInteger(r.statementDay) || r.statementDay < 1 || r.statementDay > 31))
    || (r.dueDay !== undefined && (!Number.isInteger(r.dueDay) || r.dueDay < 1 || r.dueDay > 31))) return null;
  return {
    id: r.id, uid: r.uid, name: r.name.trim(), issuer: r.issuer.trim(),
    ...(r.network && ['Visa', 'Mastercard', 'RuPay', 'Amex', 'Other'].includes(r.network) && { network: r.network }),
    ...(r.last4 && { last4: r.last4 }),
    ...(r.creditLimit !== undefined && { creditLimit: r.creditLimit }),
    ...(r.statementDay !== undefined && { statementDay: r.statementDay }),
    ...(r.dueDay !== undefined && { dueDay: r.dueDay }),
    active: r.active !== false,
  };
}

function cardPaymentRecord(r) {
  if (!r || !DOC_ID.test(r.id || '') || r.id !== r.idempotencyKey
    || typeof r.creditCardId !== 'string' || !(r.amount > 0) || !Number.isFinite(r.amount)
    || !/^\d{4}-\d{2}-\d{2}$/.test(r.paymentDate || '')
    || !['full_statement', 'full_current_outstanding'].includes(r.paymentType)) return null;
  return {
    id: r.id, uid: r.uid, creditCardId: r.creditCardId, amount: r.amount,
    paymentDate: r.paymentDate, paymentType: r.paymentType,
    ...(typeof r.statementId === 'string' && { statementId: r.statementId }),
  };
}

function cardRefundRecord(r) {
  if (!r || !DOC_ID.test(r.id || '') || typeof r.creditCardId !== 'string'
    || typeof r.originalExpenseId !== 'string' || !(r.amount > 0) || !Number.isFinite(r.amount)
    || !/^\d{4}-\d{2}-\d{2}$/.test(r.refundDate || '')
    || typeof (r.description || '') !== 'string' || (r.description || '').length > 200) return null;
  return {
    id: r.id, uid: r.uid, creditCardId: r.creditCardId, originalExpenseId: r.originalExpenseId,
    amount: r.amount, refundDate: r.refundDate, description: r.description || '',
  };
}

async function importData(file) {
  if (!currentUser) {
    showToast('Please log in first.', 'error');
    return;
  }

  const btn = document.getElementById('btn-import');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-2" class="voice-spin"></i> Restoring…';
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
    const writes = [];
    const refundWrites = [];

    showBackupStatus('Preparing import…', 'loading');

    // Holdings keep their ids, so restored investment entries still point at them
    for (const record of Array.isArray(data.holdings) ? data.holdings : []) {
      const h = record?.uid === uid && holdingRecord(record);
      if (h) writes.push(['holdings', h]);
    }
    const backupCards = new Set();
    for (const record of Array.isArray(data.creditCards) ? data.creditCards : []) {
      if (record?.uid !== uid) continue;
      const card = creditCardRecord(record);
      if (card) { backupCards.add(card.id); writes.push(['creditCards', card]); }
    }
    for (const [type, coll, records] of [['expense', 'expenses', data.expenses], ['income', 'income', data.income], ['debt', 'debts', data.debts]]) {
      for (const record of records) {
        if (record.uid !== uid) continue;
        if (!validateRecord(record, type)) continue;
        if (type === 'expense' && record.creditCardId && !backupCards.has(record.creditCardId)) continue;
        writes.push([coll, record]);
      }
    }
    for (const record of Array.isArray(data.cardPayments) ? data.cardPayments : []) {
      if (record?.uid !== uid || !backupCards.has(record.creditCardId)) continue;
      const payment = cardPaymentRecord(record);
      if (payment) writes.push(['cardPayments', payment]);
    }
    const backupExpenses = new Set(writes.filter(([coll]) => coll === 'expenses').map(([, record]) => record.id));
    for (const record of Array.isArray(data.cardRefunds) ? data.cardRefunds : []) {
      if (record?.uid !== uid || !backupCards.has(record.creditCardId) || !backupExpenses.has(record.originalExpenseId)) continue;
      const refund = cardRefundRecord(record);
      if (refund) refundWrites.push(refund);
    }

    if (writes.length === 0 && refundWrites.length === 0) {
      showBackupStatus('No items found for your account in this backup.', 'warning');
      showToast('No items to import.', 'error');
      return;
    }

    // Firestore allows at most 500 writes per batch. Reusing the exported id means a
    // retry after a failed chunk (or restoring twice) overwrites instead of duplicating.
    const chunkLimit = writes.some(([coll]) => ['creditCards', 'cardPayments'].includes(coll)) ? 5 : BATCH_LIMIT;
    for (let i = 0; i < writes.length; i += chunkLimit) {
      const batch = writeBatch(db);
      for (const [coll, { id, ...rest }] of writes.slice(i, i + chunkLimit)) {
        const ref = typeof id === 'string' && DOC_ID.test(id) ? doc(db, coll, id) : doc(collection(db, coll));
        if (coll === 'expenses') delete rest.refundedTotal;
        batch.set(ref, { ...rest, createdAt: serverTimestamp() }, coll === 'expenses' ? { merge: true } : undefined);
      }
      showBackupStatus(`Importing ${Math.min(i + chunkLimit, writes.length)} of ${writes.length} items…`, 'loading');
      await batch.commit();
    }
    for (const { id, ...refund } of refundWrites) {
      await runTransaction(db, async transaction => {
        const refundRef = doc(db, 'cardRefunds', id);
        const purchaseRef = doc(db, 'expenses', refund.originalExpenseId);
        if ((await transaction.get(refundRef)).exists()) return;
        const purchase = await transaction.get(purchaseRef);
        if (!purchase.exists() || purchase.data().uid !== uid
          || purchase.data().creditCardId !== refund.creditCardId || purchase.data().payment !== 'Credit Card') {
          throw new Error('A refunded purchase is missing from this backup.');
        }
        const refundedTotal = moneyToCents(purchase.data().refundedTotal || 0);
        const refundAmount = moneyToCents(refund.amount);
        if (refundedTotal + refundAmount > moneyToCents(purchase.data().amount)) {
          throw new Error('The backup contains refunds greater than the original purchase.');
        }
        transaction.update(purchaseRef, { refundedTotal: moneyFromCents(refundedTotal + refundAmount) });
        transaction.set(refundRef, { ...refund, createdAt: serverTimestamp() });
      });
    }
    const importedCount = writes.length + refundWrites.length;

    showBackupStatus(`Imported ${importedCount} items successfully!`, 'success');
    showToast(`Backup restored! ${importedCount} items imported.`, 'success');

    // Reload page to refresh data
    setTimeout(() => window.location.reload(), 1500);

  } catch (err) {
    console.error('Import error:', err);
    const msg = err.message === 'Invalid backup file structure.'
      ? 'Invalid backup file. Please use a valid SpendWise backup.'
      : 'Import failed. Please try again.';
    showBackupStatus(msg, 'error');
    showToast('Import failed.', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Restore';
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
  showChosenFile(null);
  if (window.lucide) lucide.createIcons();
}

// The chosen file's name in the picker; Restore is only on once there is one
function showChosenFile(file) {
  const fileName = document.getElementById('backup-file-name');
  if (fileName) {
    fileName.textContent = file ? file.name : 'Choose a file, or drop it here';
    fileName.classList.toggle('has-file', !!file);
  }
  const restore = document.getElementById('btn-import');
  if (restore) restore.disabled = !file;
}

function closeBackupModal() {
  const modal = document.getElementById('backup-modal');
  if (modal) modal.classList.add('hidden');
}

function handleFileSelect(event) {
  showChosenFile(event.target.files[0]);
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
    showChosenFile(file);
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
    return importData(fileInput.files[0]);
  } else {
    showBackupStatus('Please select a backup file first.', 'warning');
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
