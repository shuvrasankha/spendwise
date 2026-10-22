// nav.js — The phone tab bar's extras: the More sheet (Income, Debts) and hold-+ for voice.
// Tabs themselves navigate through data-action (event-delegation.js); this adds the rest.
// The sheet reuses the picker sheet styles (.sw-pick-*), so it looks like every other sheet.
(function () {
  'use strict';

  const PAGES = [
    { href: 'income.html', icon: 'trending-up', title: 'Income', hint: 'Salary, freelance and other money in' },
    { href: 'debt.html', icon: 'hand-coins', title: 'Debts', hint: 'Money lent and borrowed' }
  ];
  const HOLD_MS = 500;

  const here = location.pathname.split('/').pop() || 'index.html';
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ── More sheet ───────────────────────────────────────────────────────────
  let layer = null, opener = null;

  function openMore(btn) {
    if (layer) return;
    opener = btn;
    layer = document.createElement('div');
    layer.className = 'sw-pick-layer is-sheet nav-more-layer';
    layer.innerHTML = `
      <div class="sw-pick-scrim"></div>
      <div class="sw-pick-panel" role="dialog" aria-modal="true" aria-labelledby="nav-more-title">
        <div class="sw-pick-head">
          <div><p class="sw-pick-title" id="nav-more-title">More</p></div>
          <button type="button" class="sw-pick-close" data-close aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
        </div>
        <div class="sw-pick-list nav-more-list">${PAGES.map(p => `
          <a class="sw-pick-opt nav-more-opt" href="${p.href}"${p.href === here ? ' aria-current="page"' : ''}>
            <span class="nav-more-icon"><i data-lucide="${p.icon}"></i></span>
            <span class="nav-more-text"><strong>${esc(p.title)}</strong><small>${esc(p.hint)}</small></span>
          </a>`).join('')}
        </div>
      </div>`;
    document.body.appendChild(layer);
    if (window.lucide) window.lucide.createIcons();
    btn.setAttribute('aria-expanded', 'true');
    layer.addEventListener('click', e => {
      if (e.target.classList.contains('sw-pick-scrim') || e.target.closest('[data-close]')) closeMore();
    });
    layer.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMore(); return; }
      if (e.key !== 'Tab') return;
      const f = [...layer.querySelectorAll('a, button')];
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    });
    (layer.querySelector('.nav-more-opt') || layer.querySelector('[data-close]')).focus({ preventScroll: true });
  }

  function closeMore() {
    if (!layer) return;
    layer.remove();
    layer = null;
    if (opener) {
      opener.setAttribute('aria-expanded', 'false');
      opener.focus({ preventScroll: true });
    }
  }

  document.addEventListener('click', e => {
    const more = e.target.closest('#bnav-more');
    if (more) { e.preventDefault(); openMore(more); }
  });

  // ── Hold + for voice ─────────────────────────────────────────────────────
  // A tap on + adds an expense; holding it opens the voice dialog (expense.html?voice=1,
  // picked up by voice-command.js). The hold's own click is swallowed so it doesn't also navigate.
  let timer = null, held = false, start = null;
  const cancel = () => { clearTimeout(timer); timer = null; };

  document.addEventListener('pointerdown', e => {
    const add = e.target.closest('#bnav-add');
    if (!add || e.button > 0) return;
    held = false;
    start = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      held = true;
      timer = null;
      try { navigator.vibrate?.(15); } catch { /* ignore */ }
      if (here === 'expense.html' && typeof window.openVoiceModal === 'function') window.openVoiceModal();
      else location.href = 'expense.html?voice=1';
    }, HOLD_MS);
  });
  document.addEventListener('pointermove', e => {
    if (timer && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
  });
  ['pointerup', 'pointercancel'].forEach(t => document.addEventListener(t, cancel));
  document.addEventListener('click', e => {
    if (held && e.target.closest('#bnav-add')) { e.preventDefault(); e.stopImmediatePropagation(); held = false; }
  }, true);
  document.addEventListener('contextmenu', e => { if (e.target.closest('#bnav-add')) e.preventDefault(); });
})();
