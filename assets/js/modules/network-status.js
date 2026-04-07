// network-status.js — Offline/Online detection for SpendWise

(function() {
  'use strict';

  let isOffline = !navigator.onLine;
  let dismissTimer = null;
  let isSyncing = false;

  function initNetworkStatus() {
    updateNetworkStatus();
    
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    const dismissBtn = document.getElementById('offline-dismiss');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', hideOfflineIndicator);
    }

    const syncBtnOffline = document.getElementById('sync-btn');
    if (syncBtnOffline) {
      syncBtnOffline.addEventListener('click', triggerSync);
    }

    const syncBtnOnline = document.getElementById('sync-btn-online');
    if (syncBtnOnline) {
      syncBtnOnline.addEventListener('click', triggerSync);
    }

    const pendingBadge = document.getElementById('pending-badge');
    if (pendingBadge) {
      pendingBadge.addEventListener('click', () => {
        const count = window.getOfflineQueueCount ? window.getOfflineQueueCount() : 0;
        if (count > 0 && typeof showSyncQueueModal === 'function') {
          showSyncQueueModal();
        }
      });
    }
  }

  function updateNetworkStatus() {
    isOffline = !navigator.onLine;
    
    if (isOffline) {
      showOfflineIndicator();
    } else {
      hideOfflineIndicator();
    }
  }

  function showOfflineIndicator() {
    const indicator = document.getElementById('offline-indicator');
    if (!indicator) return;

    indicator.classList.remove('hidden');
    indicator.classList.add('show');
    
    if (window.lucide) {
      lucide.createIcons();
    }

    if (typeof showToast === 'function') {
      showToast('You are offline. Changes will be saved locally.');
    }
  }

  function hideOfflineIndicator() {
    const indicator = document.getElementById('offline-indicator');
    if (!indicator) return;

    indicator.classList.remove('show');
    setTimeout(() => {
      indicator.classList.add('hidden');
    }, 300);
  }

  function handleOnline() {
    hideOfflineIndicator();
    showOnlineIndicator();
    triggerSync();
  }

  function handleOffline() {
    showOfflineIndicator();
  }

  function triggerSync() {
    if (isSyncing) return;
    
    if (typeof window.syncOfflineQueue === 'function') {
      const queueCount = window.getOfflineQueueCount ? window.getOfflineQueueCount() : 0;
      
      if (queueCount > 0) {
        isSyncing = true;
        updateSyncButtonState(true);
        
        window.syncOfflineQueue().then(result => {
          isSyncing = false;
          updateSyncButtonState(false);
          
          if (typeof window.updatePendingBadge === 'function') {
            window.updatePendingBadge();
          }
        }).catch(err => {
          isSyncing = false;
          updateSyncButtonState(false);
          console.error('Sync failed:', err);
        });
      }
    }
  }

  function updateSyncButtonState(syncing) {
    const syncBtn = document.getElementById('sync-btn');
    if (syncBtn) {
      syncBtn.disabled = syncing;
      const icon = syncBtn.querySelector('svg, i');
      if (icon) {
        if (syncing) {
          syncBtn.classList.add('syncing');
        } else {
          syncBtn.classList.remove('syncing');
        }
      }
    }
  }

  window.updateSyncStatus = function(count) {
    const statusEl = document.getElementById('sync-status');
    if (statusEl) {
      if (count > 0) {
        statusEl.textContent = `${count} pending`;
        statusEl.classList.remove('hidden');
      } else {
        statusEl.classList.add('hidden');
      }
    }
  };

  function showOnlineIndicator() {
    const indicator = document.getElementById('online-indicator');
    if (!indicator) return;

    indicator.classList.remove('hidden');
    indicator.classList.add('show');

    if (window.lucide) {
      lucide.createIcons();
    }

    if (dismissTimer) {
      clearTimeout(dismissTimer);
    }

    dismissTimer = setTimeout(() => {
      hideOnlineIndicator();
    }, 3000);
  }

  function hideOnlineIndicator() {
    const indicator = document.getElementById('online-indicator');
    if (!indicator) return;

    indicator.classList.remove('show');
    setTimeout(() => {
      indicator.classList.add('hidden');
    }, 300);
  }

  window.isOffline = function() {
    return isOffline;
  };

  window.triggerSync = triggerSync;

  window.syncOfflineData = function() {
    triggerSync();
  };

  document.addEventListener('DOMContentLoaded', initNetworkStatus);

  if (document.readyState !== 'loading') {
    initNetworkStatus();
  }
})();
