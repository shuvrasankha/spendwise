// network-status.js — Offline/Online detection for SpendWise

(function() {
  'use strict';

  let isOffline = !navigator.onLine;
  let dismissTimer = null;

  function initNetworkStatus() {
    updateNetworkStatus();
    
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    const dismissBtn = document.getElementById('offline-dismiss');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', hideOfflineIndicator);
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
    
    if (typeof syncOfflineData === 'function') {
      syncOfflineData();
    }
  }

  function handleOffline() {
    showOfflineIndicator();
  }

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

  window.syncOfflineData = function() {
    console.log('Syncing offline data...');
  };

  document.addEventListener('DOMContentLoaded', initNetworkStatus);

  if (document.readyState !== 'loading') {
    initNetworkStatus();
  }
})();
