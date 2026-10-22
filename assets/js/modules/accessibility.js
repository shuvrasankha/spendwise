/**
 * SpendWise — Accessibility Module
 * Provides keyboard navigation, focus management, ARIA support,
 * skip navigation, and screen reader compatibility
 * 
 * Features:
 * - Skip to main content link
 * - Focus trapping in modals
 * - ESC key handler
 * - Keyboard navigation for category picker
 * - aria-live region management
 * - Chart accessibility
 */

(function() {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════
  // SKIP NAVIGATION
  // ═══════════════════════════════════════════════════════════════════

  function createSkipLink() {
    // Check if already exists
    if (document.getElementById('skip-link')) return;

    const skipLink = document.createElement('a');
    skipLink.id = 'skip-link';
    skipLink.href = '#main-content';
    skipLink.className = 'skip-link';
    skipLink.textContent = 'Skip to main content';
    skipLink.setAttribute('aria-label', 'Skip to main content');

    // Insert as first element in body
    document.body.insertBefore(skipLink, document.body.firstChild);
  }

  // ═══════════════════════════════════════════════════════════════════
  // FOCUS MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════

  // Store last focused element before modal opens
  let lastFocusedElement = null;

  function storeLastFocus() {
    lastFocusedElement = document.activeElement;
  }

  function restoreFocus() {
    if (lastFocusedElement && document.contains(lastFocusedElement)) {
      // Check if element is still focusable
      if (lastFocusedElement.offsetParent !== null || lastFocusedElement.tagName === 'BODY') {
        lastFocusedElement.focus();
      }
    }
  }

  // Get all focusable elements within a container
  function getFocusableElements(container) {
    const focusableSelectors = [
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
      '[contenteditable]'
    ];

    return Array.from(container.querySelectorAll(focusableSelectors.join(', ')))
      .filter(el => !el.hasAttribute('disabled') && !el.getAttribute('aria-hidden'));
  }

  // ═══════════════════════════════════════════════════════════════════
  // FOCUS TRAP FOR MODALS
  // ═══════════════════════════════════════════════════════════════════

  function trapFocus(modal) {
    // Looked up on each Tab: dialogs show and hide fields while open (e.g. the bank field)
    const visible = () => getFocusableElements(modal).filter(el => el.offsetParent !== null);
    const first = visible()[0];
    if (first) setTimeout(() => first.focus(), 100);

    if (modal.dataset.focusTrap) return; // one listener per dialog, however often it opens
    modal.dataset.focusTrap = 'on';
    modal.addEventListener('keydown', function(e) {
      if (e.key !== 'Tab') return;
      const els = visible();
      if (!els.length) return;
      const firstEl = els[0], lastEl = els[els.length - 1];
      if (e.shiftKey && (document.activeElement === firstEl || !modal.contains(document.activeElement))) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && (document.activeElement === lastEl || !modal.contains(document.activeElement))) {
        e.preventDefault();
        firstEl.focus();
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // ESC KEY HANDLER
  // ═══════════════════════════════════════════════════════════════════

  function handleEscapeKey(e) {
    if (e.key !== 'Escape') return;

    // Close any open modal
    const openModal = document.querySelector('.modal-overlay:not(.hidden)');
    if (openModal) {
      e.preventDefault();
      e.stopPropagation();

      // Find and trigger close button
      const closeBtn = openModal.querySelector('.modal__close, .modal-close-btn, [data-action*="close"]');
      if (closeBtn) {
        closeBtn.click();
      } else {
        // Fallback: just close the modal
        openModal.classList.add('hidden');
        restoreFocus();
      }
      return;
    }

    // Close mobile menu if open
    const mobileMenu = document.querySelector('.mobile-menu-panel.open');
    if (mobileMenu) {
      e.preventDefault();
      const closeBtn = document.querySelector('[data-action="closeMobileMenu"]');
      if (closeBtn) closeBtn.click();
      return;
    }

    // Close profile dropdown
    const profileDropdown = document.querySelector('.profile-dropdown:not(.hidden)');
    if (profileDropdown) {
      e.preventDefault();
      profileDropdown.classList.add('hidden');
      return;
    }
  }

  // Global ESC handler
  document.addEventListener('keydown', handleEscapeKey);

  // ═══════════════════════════════════════════════════════════════════
  // KEYBOARD NAVIGATION FOR CATEGORY PICKER
  // ═══════════════════════════════════════════════════════════════════

  function initCategoryPickerKeyboard() {
    const categoryPicker = document.querySelector('.category-picker, .cat-tile-grid');
    if (!categoryPicker) return;

    // Ensure it has proper ARIA role
    if (!categoryPicker.getAttribute('role')) {
      categoryPicker.setAttribute('role', 'radiogroup');
      categoryPicker.setAttribute('aria-label', 'Expense category');
    }

    const tiles = categoryPicker.querySelectorAll('.cat-tile, [role="radio"]');
    if (tiles.length === 0) return;

    // Set up each tile
    tiles.forEach((tile) => {
      tile.setAttribute('tabindex', '0');
      tile.setAttribute('role', 'radio');
      tile.setAttribute('aria-checked', tile.classList.contains('active') ? 'true' : 'false');

      // Handle keyboard events (read the current order: dashboard.js puts frequent categories first)
      tile.addEventListener('keydown', function(e) {
        const tiles = [...categoryPicker.querySelectorAll('.cat-tile, [role="radio"]')];
        const index = tiles.indexOf(tile);
        let newIndex = index;

        switch (e.key) {
          case 'ArrowRight':
          case 'ArrowDown':
            e.preventDefault();
            newIndex = (index + 1) % tiles.length;
            break;
          
          case 'ArrowLeft':
          case 'ArrowUp':
            e.preventDefault();
            newIndex = (index - 1 + tiles.length) % tiles.length;
            break;
          
          case 'Home':
            e.preventDefault();
            newIndex = 0;
            break;
          
          case 'End':
            e.preventDefault();
            newIndex = tiles.length - 1;
            break;
          
          case 'Enter':
          case ' ':
            e.preventDefault();
            tile.click();
            return;
        }

        // Move focus to new tile
        if (newIndex !== index) {
          tiles[newIndex].focus();
          // Optional: auto-select on arrow key
          // tiles[newIndex].click();
        }
      });

      // Update aria-checked on click
      tile.addEventListener('click', function() {
        tiles.forEach(t => t.setAttribute('aria-checked', 'false'));
        tile.setAttribute('aria-checked', 'true');
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // ARIA-LIVE REGIONS
  // ═══════════════════════════════════════════════════════════════════

  function initAriaLiveRegions() {
    // Create toast live region if it doesn't exist
    // Error toasts (#toast.error) don't auto-hide; tapping one dismisses it
    document.addEventListener('click', (e) => {
      const toast = e.target.closest('#toast.error');
      if (toast) toast.classList.add('hidden');
    });

    let toastRegion = document.getElementById('toast-live-region');
    if (!toastRegion) {
      toastRegion = document.createElement('div');
      toastRegion.id = 'toast-live-region';
      toastRegion.className = 'sr-only';
      toastRegion.setAttribute('aria-live', 'polite');
      toastRegion.setAttribute('aria-atomic', 'true');
      document.body.appendChild(toastRegion);
    }

    // Create form message live region
    let formRegion = document.getElementById('form-message-live-region');
    if (!formRegion) {
      formRegion = document.createElement('div');
      formRegion.id = 'form-message-live-region';
      formRegion.className = 'sr-only';
      formRegion.setAttribute('aria-live', 'assertive');
      formRegion.setAttribute('aria-atomic', 'true');
      document.body.appendChild(formRegion);
    }

    // Observe toast changes
    const toast = document.getElementById('toast');
    if (toast) {
      const observer = new MutationObserver(function(mutations) {
        mutations.forEach(function(mutation) {
          if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
            if (!toast.classList.contains('hidden') && toast.textContent) {
              toastRegion.textContent = toast.textContent;
            }
          }
        });
      });
      observer.observe(toast, { attributes: true });
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // MOBILE MENU ACCESSIBILITY
  // ═══════════════════════════════════════════════════════════════════

  function initMobileMenuAccessibility() {
    const menuPanel = document.getElementById('mobile-menu-panel');
    const menuOverlay = document.getElementById('mobile-menu-overlay');
    const menuToggle = document.querySelector('[data-action="toggleMobileMenu"]');
    const menuClose = document.querySelector('[data-action="closeMobileMenu"]');

    if (!menuPanel || !menuToggle) return;

    // Set ARIA attributes
    menuPanel.setAttribute('role', 'dialog');
    menuPanel.setAttribute('aria-modal', 'true');
    menuPanel.setAttribute('aria-label', 'Navigation menu');

    // Toggle button
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.setAttribute('aria-controls', 'mobile-menu-panel');
    menuToggle.setAttribute('aria-label', 'Open navigation menu');

    // Close button
    if (menuClose) {
      menuClose.setAttribute('aria-label', 'Close navigation menu');
    }

    // Listen for open/close
    const observer = new MutationObserver(function(mutations) {
      mutations.forEach(function(mutation) {
        if (mutation.attributeName === 'class') {
          const isOpen = menuPanel.classList.contains('open');
          menuToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
          
          if (isOpen) {
            storeLastFocus();
            // Focus first menu item
            const firstBtn = menuPanel.querySelector('.mobile-menu-btn');
            if (firstBtn) setTimeout(() => firstBtn.focus(), 100);
            
            // Trap focus
            trapFocus(menuPanel);
          } else {
            restoreFocus();
          }
        }
      });
    });

    observer.observe(menuPanel, { attributes: true });
  }

  // ═══════════════════════════════════════════════════════════════════
  // PROFILE DROPDOWN ACCESSIBILITY
  // ═══════════════════════════════════════════════════════════════════

  function initProfileDropdownAccessibility() {
    const avatar = document.getElementById('user-avatar');
    const dropdown = document.getElementById('profile-dropdown');

    if (!avatar || !dropdown) return;

    // Set ARIA attributes
    avatar.setAttribute('role', 'button');
    avatar.setAttribute('aria-haspopup', 'true');
    avatar.setAttribute('aria-expanded', 'false');
    avatar.setAttribute('aria-controls', 'profile-dropdown');
    avatar.setAttribute('tabindex', '0');

    dropdown.setAttribute('role', 'menu');
    dropdown.setAttribute('aria-label', 'User menu');

    // Update aria-expanded on toggle
    const observer = new MutationObserver(function(mutations) {
      mutations.forEach(function(mutation) {
        if (mutation.attributeName === 'class') {
          const isHidden = dropdown.classList.contains('hidden');
          avatar.setAttribute('aria-expanded', isHidden ? 'false' : 'true');
          
          if (!isHidden) {
            // Focus first menu item
            const firstItem = dropdown.querySelector('button, [role="menuitem"]');
            if (firstItem) setTimeout(() => firstItem.focus(), 100);
          }
        }
      });
    });

    observer.observe(dropdown, { attributes: true });

    // Keyboard support for menu items
    const menuItems = dropdown.querySelectorAll('button, [role="menuitem"]');
    menuItems.forEach((item, index) => {
      item.setAttribute('role', 'menuitem');
      item.setAttribute('tabindex', '-1');

      item.addEventListener('keydown', function(e) {
        let newIndex = index;

        switch (e.key) {
          case 'ArrowDown':
            e.preventDefault();
            newIndex = (index + 1) % menuItems.length;
            break;
          case 'ArrowUp':
            e.preventDefault();
            newIndex = (index - 1 + menuItems.length) % menuItems.length;
            break;
          case 'Home':
            e.preventDefault();
            newIndex = 0;
            break;
          case 'End':
            e.preventDefault();
            newIndex = menuItems.length - 1;
            break;
          case 'Escape':
            e.preventDefault();
            dropdown.classList.add('hidden');
            avatar.focus();
            return;
        }

        if (newIndex !== index) {
          menuItems[newIndex].focus();
        }
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // MODAL ACCESSIBILITY
  // ═══════════════════════════════════════════════════════════════════

  function initModalAccessibility() {
    const modals = document.querySelectorAll('.modal-overlay');
    
    modals.forEach(modal => {
      const modalBox = modal.querySelector('.modal, .modal-box');
      if (!modalBox) return;

      // Set ARIA attributes
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');

      // Find title
      const title = modalBox.querySelector('h2, h3, .modal__title, .modal-title');
      if (title) {
        const titleId = title.id || 'modal-title-' + Math.random().toString(36).substr(2, 9);
        title.id = titleId;
        modal.setAttribute('aria-labelledby', titleId);
      }

      // Find description
      const description = modalBox.querySelector('p, .modal__content, .modal-content');
      if (description) {
        const descId = description.id || 'modal-desc-' + Math.random().toString(36).substr(2, 9);
        description.id = descId;
        modal.setAttribute('aria-describedby', descId);
      }

      // Observe for open/close
      const observer = new MutationObserver(function(mutations) {
        mutations.forEach(function(mutation) {
          if (mutation.attributeName === 'class') {
            // App dialogs open by losing .hidden (none of them ever get .open)
            const isOpen = !modal.classList.contains('hidden');
            
            if (isOpen && modalBox) {
              storeLastFocus();
              trapFocus(modalBox);
            } else if (!isOpen) {
              restoreFocus();
            }
          }
        });
      });

      observer.observe(modal, { attributes: true });
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // SCREEN READER ONLY UTILITY CLASS
  // ═══════════════════════════════════════════════════════════════════

  function createSrOnlyStyles() {
    if (document.getElementById('sr-only-styles')) return;

    const style = document.createElement('style');
    style.id = 'sr-only-styles';
    style.textContent = `
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
      .sr-only-focusable:active,
      .sr-only-focusable:focus {
        position: static;
        width: auto;
        height: auto;
        overflow: visible;
        clip: auto;
        white-space: normal;
      }
    `;
    document.head.appendChild(style);
  }

  // ═══════════════════════════════════════════════════════════════════
  // FORM ACCESSIBILITY
  // ═══════════════════════════════════════════════════════════════════

  function initFormAccessibility() {
    // Ensure all form inputs have associated labels
    const inputs = document.querySelectorAll('input, select, textarea');
    
    inputs.forEach(input => {
      // Skip hidden inputs
      if (input.type === 'hidden') return;

      // Check if input has an id
      const inputId = input.id;
      if (!inputId) return;

      // Look for associated label
      const label = document.querySelector(`label[for="${inputId}"]`);
      
      if (!label && input.type !== 'submit' && input.type !== 'button') {
        // Try to find a parent label
        const parentLabel = input.closest('label');
        if (!parentLabel) {
          // Create an aria-label from placeholder or name
          const labelText = input.placeholder || input.name || '';
          if (labelText && !input.getAttribute('aria-label')) {
            input.setAttribute('aria-label', labelText);
          }
        }
      }

      // Add required attribute indication
      if (input.hasAttribute('required')) {
        input.setAttribute('aria-required', 'true');
      }

      // Add error association if present
      const errorMsg = input.parentNode.querySelector('.error-message, .form-error');
      if (errorMsg) {
        const errorId = errorMsg.id || 'error-' + inputId;
        errorMsg.id = errorId;
        input.setAttribute('aria-describedby', errorId);
        input.setAttribute('aria-invalid', 'true');
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // INITIALIZE ALL ACCESSIBILITY FEATURES
  // ═══════════════════════════════════════════════════════════════════

  function initAccessibility() {
    createSkipLink();
    createSrOnlyStyles();
    initAriaLiveRegions();
    initMobileMenuAccessibility();
    initProfileDropdownAccessibility();
    initModalAccessibility();
    initFormAccessibility();
    
    // Initialize after a short delay to ensure DOM is ready
    setTimeout(() => {
      initCategoryPickerKeyboard();
    }, 100);
  }

  // Auto-initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAccessibility);
  } else {
    // DOM already ready
    initAccessibility();
  }

  // Expose functions for use by other modules
  window.a11y = {
    storeLastFocus,
    restoreFocus,
    trapFocus,
    getFocusableElements
  };

})();
