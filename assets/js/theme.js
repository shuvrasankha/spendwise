// theme.js — Appearance: System (default) / Light / Dark.
// Loaded in <head> before the CSS so the right theme paints first (no dark flash).
(function () {
  'use strict';

  const KEY = 'theme'; // 'light' | 'dark'; absent = follow the system
  const MODES = ['system', 'light', 'dark'];
  const ICONS = { system: 'sun-moon', light: 'sun', dark: 'moon' };
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let lastDark;

  function mode() {
    try {
      const m = localStorage.getItem(KEY);
      return MODES.includes(m) ? m : 'system';
    } catch { return 'system'; }
  }

  function apply() {
    const m = mode();
    const dark = m === 'dark' || (m === 'system' && media.matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');

    const btn = document.getElementById('theme-btn');
    if (btn) {
      const label = 'Appearance: ' + m[0].toUpperCase() + m.slice(1);
      btn.title = label;
      btn.setAttribute('aria-label', label);
    }
    const icon = document.getElementById('theme-icon');
    if (icon && icon.getAttribute('data-lucide') !== ICONS[m]) {
      icon.setAttribute('data-lucide', ICONS[m]);
      if (window.lucide) window.lucide.createIcons();
    }
    // Only on a real change, so pages don't redraw (e.g. charts) on every load
    if (lastDark !== undefined && dark !== lastDark) {
      window.dispatchEvent(new CustomEvent('spendwise:themechange', { detail: { dark } }));
    }
    lastDark = dark;
  }

  window.toggleTheme = function () {
    const next = MODES[(MODES.indexOf(mode()) + 1) % MODES.length];
    try {
      if (next === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch { /* private mode: applies for this page only */ }
    apply();
  };

  media.addEventListener('change', apply); // follow the system live while in System mode
  document.addEventListener('DOMContentLoaded', apply); // label + icon once the header exists
  apply();
})();
