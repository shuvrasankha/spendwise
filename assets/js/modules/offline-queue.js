// offline-queue.js — Offline transaction queue for SpendWise

(function() {
  'use strict';

  const QUEUE_KEY = 'spendwise_offline_queue';
  const COLLECTIONS = { expense: 'expenses', income: 'income', debt: 'debts' };

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

  // Writes each queued item for the signed-in user. Items are never dropped:
  // a failed write stays queued and retries on the next sync.
  window.syncOfflineQueue = async function() {
    if (getQueue().length === 0) return { synced: 0, failed: 0 };

    // This is a classic script, so load Firebase the same way the pages do
    const { db, auth } = await import('../config/firebase.js');
    const { doc, setDoc, serverTimestamp } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    await auth.authStateReady();
    const uid = auth.currentUser?.uid;
    if (!uid) return { synced: 0, failed: 0 }; // keep everything until someone signs in

    const synced = new Set();
    const failed = new Set();
    for (const item of getQueue()) {
      if (item.data?.uid !== uid) continue; // another account's item: leave it for them
      try {
        const coll = COLLECTIONS[item.type];
        if (!coll) throw new Error(`Unknown transaction type: ${item.type}`);
        // Doc id = queue id, so a retry after a lost response overwrites instead of duplicating.
        // createdAt is set here: serverTimestamp() does not survive JSON in localStorage.
        await setDoc(doc(db, coll, item.id), { ...item.data, createdAt: serverTimestamp() });
        synced.add(item.id);
      } catch (e) {
        console.error(`Failed to sync ${item.type} (${item.id}):`, e);
        failed.add(item.id);
      }
    }

    // Re-read so items queued while we were syncing are kept
    saveQueue(getQueue()
      .filter(item => !synced.has(item.id))
      .map(item => failed.has(item.id) ? { ...item, retries: (item.retries || 0) + 1 } : item));

    if (synced.size > 0) {
      showToast(`${synced.size} offline transaction${synced.size > 1 ? 's' : ''} synced!`);
      window.dispatchEvent(new CustomEvent('spendwise:synced'));
    }
    if (failed.size > 0) {
      showToast(`${failed.size} transaction${failed.size > 1 ? 's' : ''} could not sync. Kept and will retry.`, 'error');
    }
    return { synced: synced.size, failed: failed.size };
  };

  function showToast(message, type = 'success') {
    if (typeof window.showToast === 'function') {
      window.showToast(message, type);
    } else {
      const toast = document.getElementById('toast');
      if (toast) {
        toast.textContent = message;
        toast.className = 'toast ' + type;
        toast.classList.remove('hidden');
        // Errors stay until tapped (accessibility.js)
        if (type !== 'error') setTimeout(() => toast.classList.add('hidden'), 3000);
      }
    }
  }

  // Also sync on page load: the 'online' event never fires if the app was closed while offline
  function init() {
    updatePendingBadge();
    if (navigator.onLine && getQueueCount() > 0 && window.triggerSync) window.triggerSync();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
