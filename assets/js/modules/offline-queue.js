// offline-queue.js — Offline transaction queue for SpendWise

(function() {
  'use strict';

  const QUEUE_KEY = 'spendwise_offline_queue';
  const MAX_RETRIES = 3;

  function getQueue() {
    try {
      const raw = localStorage.getItem(QUEUE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function saveQueue(queue) {
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
      updatePendingBadge();
    } catch (e) {
      console.error('Failed to save offline queue:', e);
    }
  }

  function addToQueue(type, data) {
    const queue = getQueue();
    const item = {
      id: generateId(),
      type: type,
      data: data,
      timestamp: Date.now(),
      retries: 0
    };
    queue.push(item);
    saveQueue(queue);
    return item.id;
  }

  function removeFromQueue(id) {
    const queue = getQueue();
    const filtered = queue.filter(item => item.id !== id);
    saveQueue(filtered);
  }

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  }

  function getQueueCount() {
    return getQueue().length;
  }

  function updatePendingBadge() {
    const count = getQueueCount();
    const badges = document.querySelectorAll('.offline-queue-badge');
    
    badges.forEach(badge => {
      if (count > 0) {
        badge.textContent = count > 99 ? '99+' : count;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    });

    if (window.updateSyncStatus) {
      window.updateSyncStatus(count);
    }
  }

  window.addToOfflineQueue = function(type, data) {
    return addToQueue(type, data);
  };

  window.getOfflineQueueCount = function() {
    return getQueueCount();
  };

  window.getOfflineQueue = function() {
    return getQueue();
  };

  window.removeFromOfflineQueue = function(id) {
    removeFromQueue(id);
  };

  window.updatePendingBadge = updatePendingBadge;

  window.syncOfflineQueue = async function() {
    const queue = getQueue();
    if (queue.length === 0) {
      console.log('Offline queue is empty, nothing to sync');
      return { synced: 0, failed: 0 };
    }

    console.log(`Syncing ${queue.length} offline transactions...`);
    
    let synced = 0;
    let failed = 0;
    const remaining = [];

    for (const item of queue) {
      try {
        await syncItem(item);
        removeFromQueue(item.id);
        synced++;
        console.log(`Synced: ${item.type} (${item.id})`);
      } catch (e) {
        console.error(`Failed to sync ${item.type} (${item.id}):`, e);
        item.retries++;
        
        if (item.retries >= MAX_RETRIES) {
          console.error(`Max retries reached for ${item.id}, removing from queue`);
          failed++;
        } else {
          remaining.push(item);
        }
      }
    }

    if (remaining.length > 0) {
      saveQueue(remaining);
    }

    if (synced > 0) {
      const queue2 = getQueue();
      if (queue2.length === 0) {
        showToast(`All ${synced} offline transactions synced successfully!`);
      } else {
        showToast(`Synced ${synced} transactions. ${queue2.length} failed.`);
      }
    }

    if (failed > 0) {
      showToast(`${failed} transactions failed to sync. Please try again later.`, 'error');
    }

    return { synced, failed };
  };

  async function syncItem(item) {
    if (typeof window.firebaseSyncItem === 'function') {
      return window.firebaseSyncItem(item);
    }
    throw new Error('Firebase sync not available');
  }

  window.firebaseSyncItem = async function(item) {
    const { doc, addDoc, collection } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    
    switch (item.type) {
      case 'expense':
        const expRef = await addDoc(collection(db, 'expenses'), item.data);
        if (window.allExpenses && item.data.uid === currentUser?.uid) {
          window.allExpenses.unshift({ id: expRef.id, ...item.data });
          window.allExpenses.sort((a, b) => b.date.localeCompare(a.date));
          if (typeof updateCards === 'function') updateCards();
          if (typeof renderDashboardTable === 'function') renderDashboardTable();
          if (typeof renderPieChart === 'function') renderPieChart();
          if (typeof renderTrendChart === 'function') renderTrendChart();
        }
        break;

      case 'income':
        const incRef = await addDoc(collection(db, 'income'), item.data);
        if (window.allIncome && item.data.uid === currentUser?.uid) {
          window.allIncome.unshift({ id: incRef.id, ...item.data });
          window.allIncome.sort((a, b) => b.date.localeCompare(a.date));
          if (typeof updateIncomeSummaryCards === 'function') updateIncomeSummaryCards();
        }
        break;

      case 'debt':
        const debtRef = await addDoc(collection(db, 'debts'), item.data);
        if (window.allDebts && item.data.uid === currentUser?.uid) {
          window.allDebts.unshift({ id: debtRef.id, ...item.data });
          window.allDebts.sort((a, b) => b.date.localeCompare(a.date));
          if (typeof updateDebtSummary === 'function') updateDebtSummary();
          if (typeof renderDebts === 'function') renderDebts();
        }
        break;

      default:
        throw new Error(`Unknown transaction type: ${item.type}`);
    }
  };

  function showToast(message, type = 'success') {
    if (typeof window.showToast === 'function') {
      window.showToast(message, type);
    } else {
      const toast = document.getElementById('toast');
      if (toast) {
        toast.textContent = message;
        toast.className = 'toast';
        if (type === 'error') toast.classList.add('toast-error');
        toast.classList.remove('hidden');
        setTimeout(() => toast.classList.add('hidden'), 3000);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updatePendingBadge);
  } else {
    updatePendingBadge();
  }
})();
