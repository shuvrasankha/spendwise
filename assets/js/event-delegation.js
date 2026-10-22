// event-delegation.js — Centralized event handler system (CSP-compliant)
// Replaces all inline onclick/onchange/onkeyup handlers with data-* attributes

(function() {
  'use strict';

  // Map of action names to their handler functions
  const actionHandlers = {
    // Auth handlers
    'handleLogin': function() { if (window.handleLogin) window.handleLogin(); },
    'handleSignup': function() { if (window.handleSignup) window.handleSignup(); },
    'handleGoogleLogin': function() { if (window.handleGoogleLogin) window.handleGoogleLogin(); },
    'handleLogout': function() { if (window.handleLogout) window.handleLogout(); },
    'showForgotPassword': function() { if (window.showForgotPassword) window.showForgotPassword(); },
    'handleForgotPassword': function() { if (window.handleForgotPassword) window.handleForgotPassword(); },
    'closeForgotModal': function() { if (window.closeForgotModal) window.closeForgotModal(); },
    'resetForgotModal': function() { if (window.resetForgotModal) window.resetForgotModal(); },

    // Tab switching
    'switchTabLogin': function() { if (window.switchTab) window.switchTab('login'); },
    'switchTabSignup': function() { if (window.switchTab) window.switchTab('signup'); },

    // Theme
    'toggleTheme': function() { if (window.toggleTheme) window.toggleTheme(); },

    // Profile
    'toggleProfileMenu': function(e) { if (window.toggleProfileMenu) window.toggleProfileMenu(e); },

    // Navigation
    'navigateToDashboard': function() { window.location.href = 'index.html'; },
    'navigateToExpense': function() { window.location.href = 'expense.html'; },
    'navigateToIncome': function() { window.location.href = 'income.html'; },
    'navigateToHistory': function() { window.location.href = 'history.html'; },
    'navigateToDebt': function() { window.location.href = 'debt.html'; },
    'navigateToInsights': function() { window.location.href = 'insights.html'; },

    // Mobile menu
    'toggleMobileMenu': function() { if (window.toggleMobileMenu) window.toggleMobileMenu(); },
    'closeMobileMenu': function() { if (window.closeMobileMenu) window.closeMobileMenu(); },

    // Dashboard
    'showPageDashboard': function() { if (window.showPage) window.showPage('dashboard'); },
    'showPageAdd': function() { if (window.showPage) window.showPage('add'); },
    'showPageHistory': function() { if (window.showPage) window.showPage('history'); },
    'showPageInsights': function() { if (window.showPage) window.showPage('insights'); },
    'switchTableTabDaily': function() { if (window.switchTableTab) window.switchTableTab('daily'); },
    'switchTableTabWeekly': function() { if (window.switchTableTab) window.switchTableTab('weekly'); },
    'switchTableTabMonthly': function() { if (window.switchTableTab) window.switchTableTab('monthly'); },
    'switchTableTabYearly': function() { if (window.switchTableTab) window.switchTableTab('yearly'); },
    'downloadCSV': function() { if (window.downloadCSV) window.downloadCSV(); },
    'resetPeriodPicker': function() { if (window.resetPeriodPicker) window.resetPeriodPicker(); },

    // Expense form
    'addExpense': function() { if (window.addExpense) window.addExpense(); },
    'resetForm': function() { if (window.resetForm) window.resetForm(); },
    'toggleCardNameUPI': function() { if (window.toggleCardName) window.toggleCardName('exp-card-name-wrap', 'UPI'); },
    'toggleCardNameCash': function() { if (window.toggleCardName) window.toggleCardName('exp-card-name-wrap', 'Cash'); },
    'toggleCardNameCredit': function() { if (window.toggleCardName) window.toggleCardName('exp-card-name-wrap', 'Credit Card'); },
    'toggleCardNameDebit': function() { if (window.toggleCardName) window.toggleCardName('exp-card-name-wrap', 'Debit Card'); },
    'toggleCardNameNet': function() { if (window.toggleCardName) window.toggleCardName('exp-card-name-wrap', 'Net Banking'); },
    'toggleCardNameOther': function() { if (window.toggleCardName) window.toggleCardName('exp-card-name-wrap', 'Other'); },

    // Edit modal
    'closeEditModal': function() { if (window.closeEditModal) window.closeEditModal(); },
    'saveEditExpense': function() { if (window.saveEditExpense) window.saveEditExpense(); },
    'deleteFromEdit': function() { if (window.deleteFromEdit) window.deleteFromEdit(); },
    'toggleEditCardNameUPI': function() { if (window.toggleCardName) window.toggleCardName('edit-card-name-wrap', 'UPI'); },
    'toggleEditCardNameCash': function() { if (window.toggleCardName) window.toggleCardName('edit-card-name-wrap', 'Cash'); },
    'toggleEditCardNameCredit': function() { if (window.toggleCardName) window.toggleCardName('edit-card-name-wrap', 'Credit Card'); },
    'toggleEditCardNameDebit': function() { if (window.toggleCardName) window.toggleCardName('edit-card-name-wrap', 'Debit Card'); },
    'toggleEditCardNameNet': function() { if (window.toggleCardName) window.toggleCardName('edit-card-name-wrap', 'Net Banking'); },
    'toggleEditCardNameOther': function() { if (window.toggleCardName) window.toggleCardName('edit-card-name-wrap', 'Other'); },

    // Delete modal
    'closeModal': function() { if (window.closeModal) window.closeModal(); },
    'confirmDelete': function() { if (window.confirmDelete) window.confirmDelete(); },

    // History
    'downloadHistoryCSV': function() { if (window.downloadHistoryCSV) window.downloadHistoryCSV(); },

    // Income
    'addIncome': function() { if (window.addIncome) window.addIncome(); },
    'resetIncomeForm': function() { if (window.resetIncomeForm) window.resetIncomeForm(); },
    'toggleIncEditBankOnline': function() { if (window.toggleIncEditBank) window.toggleIncEditBank('Online'); },
    'toggleIncEditBankCash': function() { if (window.toggleIncEditBank) window.toggleIncEditBank('Cash'); },
    'closeIncEditModal': function() { if (window.closeIncEditModal) window.closeIncEditModal(); },
    'saveEditIncome': function() { if (window.saveEditIncome) window.saveEditIncome(); },
    'deleteFromIncomeEdit': function() { if (window.deleteFromIncomeEdit) window.deleteFromIncomeEdit(); },
    'closeIncomeEditModal': function() { if (window.closeIncomeEditModal) window.closeIncomeEditModal(); },
    'closeIncomeDeleteModal': function() { if (window.closeIncomeDeleteModal) window.closeIncomeDeleteModal(); },
    'confirmIncomeDelete': function() { if (window.confirmIncomeDelete) window.confirmIncomeDelete(); },
    // History page's income dialog (dashboard.js); income.html uses the names above (income.js)
    'saveIncEdit': function() { if (window.saveIncEdit) window.saveIncEdit(); },
    'deleteFromIncEdit': function() { if (window.deleteFromIncEdit) window.deleteFromIncEdit(); },
    'closeIncDeleteModal': function() { if (window.closeIncDeleteModal) window.closeIncDeleteModal(); },
    'confirmIncDelete': function() { if (window.confirmIncDelete) window.confirmIncDelete(); },

    // Debt
    'addDebt': function() { if (window.addDebt) window.addDebt(); },
    'resetDebtForm': function() { if (window.resetDebtForm) window.resetDebtForm(); },
    'setDebtTypeTheyOwe': function() { if (window.setDebtType) window.setDebtType('they-owe'); },
    'setDebtTypeIOwe': function() { if (window.setDebtType) window.setDebtType('i-owe'); },
    'openDebtDeleteModal': function(id) {
      if (window.openDebtDeleteModal) window.openDebtDeleteModal(id);
    },
    'closeDebtDeleteModal': function() { if (window.closeDebtDeleteModal) window.closeDebtDeleteModal(); },
    'confirmDebtDelete': function() { if (window.confirmDebtDelete) window.confirmDebtDelete(); },
    'openDebtSettleModal': function(id) {
      if (window.openDebtSettleModal) window.openDebtSettleModal(id);
    },
    'closeDebtSettleModal': function() { if (window.closeDebtSettleModal) window.closeDebtSettleModal(); },
    'confirmDebtSettle': function() { if (window.confirmDebtSettle) window.confirmDebtSettle(); },
    'openDebtReactivateModal': function(id) {
      if (window.openDebtReactivateModal) window.openDebtReactivateModal(id);
    },
    'closeDebtReactivateModal': function() { if (window.closeDebtReactivateModal) window.closeDebtReactivateModal(); },
    'confirmDebtReactivate': function() { if (window.confirmDebtReactivate) window.confirmDebtReactivate(); },

    // Insights
    'runAnalysis': function() { if (window.runAnalysis) window.runAnalysis(); },
    'refreshAnalysis': function() { if (window.refreshAnalysis) window.refreshAnalysis(); },
    'dismissInsightsError': function() {
      const el = document.getElementById('insights-error');
      if (el) el.classList.add('hidden');
    },
    'dismissInsightError': function() {
      const el = document.getElementById('insights-error');
      if (el) el.classList.add('hidden');
    },

    // Backup
    'openBackupModal': function() { if (window.openBackupModal) window.openBackupModal(); },
    'closeBackupModal': function() { if (window.closeBackupModal) window.closeBackupModal(); },
    'exportData': function() { if (window.exportData) window.exportData(); },
    'handleImportClick': function() { if (window.handleImportClick) window.handleImportClick(); },

    // CSV Import
    'openCSVImport': function() { if (window.openCSVImport) window.openCSVImport(); },
    'closeCSVImport': function() { if (window.closeCSVImport) window.closeCSVImport(); },
    'parseCSV': function() { if (window.parseCSV) window.parseCSV(); },
    'backToCSVUpload': function() { if (window.backToCSVUpload) window.backToCSVUpload(); },
    'confirmCSVImport': function() { if (window.confirmCSVImport) window.confirmCSVImport(); },
    'reloadAfterCSV': function() { if (window.reloadAfterCSV) window.reloadAfterCSV(); },
    'retryCSVUpload': function() { if (window.retryCSVUpload) window.retryCSVUpload(); },

    // Voice
    'openVoiceModal': function() { if (window.openVoiceModal) window.openVoiceModal(); },
    'closeVoiceModal': function() { if (window.closeVoiceModal) window.closeVoiceModal(); },
    'startVoiceRecording': function() { if (window.startVoiceRecording) window.startVoiceRecording(); },
    'sendVoiceCommand': function() { if (window.sendVoiceCommand) window.sendVoiceCommand(); },
    'cancelVoice': function() { if (window.cancelVoice) window.cancelVoice(); },
    'confirmVoice': function() { if (window.confirmVoice) window.confirmVoice(); },
  };

  // Initialize event delegation
  function initEventDelegation() {
    document.addEventListener('click', function(e) {
      // Handle expense edit/delete buttons
      const editExpBtn = e.target.closest('[data-edit-expense]');
      if (editExpBtn) {
        e.preventDefault();
        if (window.openEditExpense) window.openEditExpense(editExpBtn.dataset.editExpense);
        return;
      }
      const delExpBtn = e.target.closest('[data-delete-expense]');
      if (delExpBtn) {
        e.preventDefault();
        if (window.deleteExpense) window.deleteExpense(delExpBtn.dataset.deleteExpense);
        return;
      }

      // Handle income edit/delete buttons
      const editIncBtn = e.target.closest('[data-edit-income]');
      if (editIncBtn) {
        e.preventDefault();
        if (window.openIncEdit) window.openIncEdit(editIncBtn.dataset.editIncome);
        return;
      }
      const delIncBtn = e.target.closest('[data-delete-income]');
      if (delIncBtn) {
        e.preventDefault();
        if (window.deleteIncEntry) window.deleteIncEntry(delIncBtn.dataset.deleteIncome);
        return;
      }

      // Handle tag removal
      const tagRemoveBtn = e.target.closest('[data-remove-tag]');
      if (tagRemoveBtn) {
        e.preventDefault();
        const tag = tagRemoveBtn.dataset.removeTag;
        const prefix = tagRemoveBtn.dataset.tagPrefix;
        if (window.removeTag) window.removeTag(prefix, tag);
        return;
      }

      const target = e.target.closest('[data-action]');
      if (!target) return;

      const action = target.dataset.action;
      const handler = actionHandlers[action];
      if (handler) {
        e.preventDefault();
        // Pass debt ID for debt modal actions
        if (action === 'openDebtDeleteModal' || action === 'openDebtSettleModal' || action === 'openDebtReactivateModal') {
          handler(target.dataset.debtId);
        } else {
          handler(e);
        }
      }
    });

    document.addEventListener('change', function(e) {
      const target = e.target.closest('[data-change]');
      if (!target) return;

      const action = target.dataset.change;
      
      // Special handling for payment method toggles
      if (action === 'toggleCardNameExp' && window.toggleCardName) {
        window.toggleCardName('exp-card-name-wrap', target.value);
        return;
      }
      if (action === 'toggleCardNameEdit' && window.toggleCardName) {
        window.toggleCardName('edit-card-name-wrap', target.value);
        return;
      }
      if (action === 'toggleIncEditBank' && window.toggleIncEditBank) {
        window.toggleIncEditBank(target.value);
        return;
      }
      // Currency selector
      if (action === 'handleCurrencyChange' && window.handleCurrencyChange) {
        window.handleCurrencyChange(target.value);
        return;
      }
      // Backup file select
      if (action === 'handleFileSelect' && window.handleFileSelect) {
        window.handleFileSelect(e);
        return;
      }
      // Income payment toggles
      if (action === 'toggleBankField' && window.toggleBankField) {
        window.toggleBankField(target.value);
        return;
      }
      if (action === 'toggleEditBankField' && window.toggleEditBankField) {
        window.toggleEditBankField(target.value);
        return;
      }
      
      const handler = actionHandlers[action];
      if (handler) {
        handler(e);
      }
    });

    document.addEventListener('keyup', function(e) {
      const target = e.target.closest('[data-keyup]');
      if (!target) return;

      const action = target.dataset.keyup;
      const handler = actionHandlers[action];
      if (handler) {
        handler(e);
      }
    });
  }

  // Run on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initEventDelegation);
  } else {
    initEventDelegation();
  }

  // Expose for manual re-initialization if needed
  window.initEventDelegation = initEventDelegation;
})();
