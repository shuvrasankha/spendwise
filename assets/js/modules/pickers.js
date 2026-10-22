// pickers.js — In-app pickers for every <select> and <input type="date">.
// The phone's own option sheet and calendar can't be styled, so a tap on one of these
// controls opens a SpendWise sheet (phones) or popover (wider screens) instead.
// The native control stays in the page as the source of truth: picking sets its value
// and fires 'input' and 'change', so every existing listener keeps working, and
// controls added later (edit modals, voice review cards) are covered automatically.
(function () {
  'use strict';

  const doc = document;
  doc.documentElement.classList.add('sw-pickers'); // CSS: native controls stop taking taps

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = s => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? new Date(s + 'T00:00:00') : null);
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const sameDay = (a, b) => a && b && iso(a) === iso(b);
  const isPhone = () => window.matchMedia('(max-width: 767px)').matches;

  const ICON = {
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
    down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>'
  };

  function pickable(el) {
    if (!el || el.disabled || el.readOnly || el.hidden || el.closest('[data-native-picker]')) return false;
    if (el.tagName === 'SELECT') return !el.multiple && !(el.size > 1);
    return el.tagName === 'INPUT' && el.type === 'date';
  }

  // The control under a tap. Native controls don't take taps (CSS), so the tap lands on
  // their container; only count it when nothing else (a modal scrim, say) covers the control.
  function controlAt(x, y) {
    const hit = doc.elementFromPoint(x, y);
    if (!hit) return null;
    for (const el of doc.querySelectorAll('select, input[type="date"]')) {
      if (!pickable(el)) continue;
      // Content of a closed <details> can still report a size: skip what isn't shown
      if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      if (hit.contains(el) || (el.parentElement && el.parentElement.contains(hit))) return el;
    }
    return null;
  }

  // A label's own words, without the text of a control nested inside it (e.g. a select's options)
  function labelText(label) {
    if (!label) return '';
    const copy = label.cloneNode(true);
    copy.querySelectorAll('select, input, textarea, button').forEach(n => n.remove());
    return copy.textContent;
  }

  function labelFor(el) {
    const text = labelText(el.labels && el.labels[0]).trim() ||
      el.getAttribute('aria-label') || el.title ||
      (el.closest('.form-group') && el.closest('.form-group').querySelector('label') || {}).textContent || '';
    return text.replace(/\*/g, '').replace(/\s+/g, ' ').trim() || (el.type === 'date' ? 'Pick a date' : 'Choose one');
  }

  function commit(el, value) {
    if (el.value !== value) {
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    close();
  }

  // ── Layer: scrim + panel ─────────────────────────────────────────────────
  let layer = null, panel = null, current = null, byKeyboard = false;

  function open(el, viaKeyboard) {
    close(false);
    current = el;
    byKeyboard = viaKeyboard;
    layer = doc.createElement('div');
    // Opened by a tap: no focus ring until a key is pressed (browsers draw it for scripted focus)
    layer.className = 'sw-pick-layer' + (isPhone() ? ' is-sheet' : '') + (viaKeyboard ? '' : ' via-pointer');
    layer.innerHTML = '<div class="sw-pick-scrim"></div>';
    panel = doc.createElement('div');
    panel.className = 'sw-pick-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', labelFor(el));
    layer.appendChild(panel);
    layer.addEventListener('pointerdown', e => { if (!panel.contains(e.target)) { e.preventDefault(); close(); } });
    layer.addEventListener('keydown', onLayerKey);
    doc.body.appendChild(layer);
    if (el.tagName === 'SELECT') renderSelect(el); else renderDate(el, true);
    place();
  }

  function close(restore = true) {
    if (!layer) return;
    layer.remove();
    layer = panel = null;
    const el = current;
    current = null;
    // Give focus back after keyboard use; after a tap it would only show a stray focus ring
    if (restore && el && byKeyboard) el.focus({ preventScroll: true });
  }

  function place() {
    if (!panel || !current) return;
    if (layer.classList.contains('is-sheet')) return; // CSS docks it to the bottom
    const r = current.getBoundingClientRect();
    const w = Math.min(window.innerWidth - 16, Math.max(r.width, current.tagName === 'SELECT' ? 240 : 320));
    panel.style.width = w + 'px';
    const h = panel.offsetHeight;
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8 && r.top - h - 6 >= 8) top = r.top - h - 6;
    panel.style.top = Math.max(8, Math.min(top, window.innerHeight - h - 8)) + 'px';
    panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
  }

  function head(title, sub) {
    return `<div class="sw-pick-head">
      <div><p class="sw-pick-title">${escapeHtml(title)}</p>${sub ? `<p class="sw-pick-sub">${escapeHtml(sub)}</p>` : ''}</div>
      <button type="button" class="sw-pick-close" data-close aria-label="Close">${ICON.close}</button>
    </div>`;
  }

  function onLayerKey(e) {
    layer.classList.remove('via-pointer');
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Tab') { // keep focus inside the panel
      const f = [...panel.querySelectorAll('button:not([disabled])')].filter(b => b.tabIndex !== -1);
      if (!f.length) return;
      const i = f.indexOf(doc.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }
  }

  // ── Select ───────────────────────────────────────────────────────────────
  function renderSelect(el) {
    const opts = [...el.options].filter(o => !o.hidden);
    panel.classList.add('sw-pick-list-panel');
    panel.innerHTML = head(labelFor(el)) +
      `<div class="sw-pick-list" role="listbox" aria-label="${escapeHtml(labelFor(el))}">` +
      opts.map(o => `<button type="button" role="option" class="sw-pick-opt" data-value="${escapeHtml(o.value)}"
        aria-selected="${o.selected}" ${o.disabled ? 'disabled' : ''} tabindex="-1">
        <span>${escapeHtml(o.textContent.trim())}</span>${ICON.check}</button>`).join('') +
      '</div>';
    const list = panel.querySelector('.sw-pick-list');
    panel.addEventListener('click', e => {
      if (e.target.closest('[data-close]')) return close();
      const b = e.target.closest('.sw-pick-opt');
      if (b && !b.disabled) commit(el, b.dataset.value);
    });
    list.addEventListener('keydown', e => {
      const all = [...list.querySelectorAll('.sw-pick-opt:not([disabled])')];
      const i = all.indexOf(doc.activeElement);
      const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: all.length - 1 }[e.key];
      if (to !== undefined) { e.preventDefault(); (all[Math.max(0, Math.min(all.length - 1, to))] || all[0]).focus(); }
    });
    const sel = list.querySelector('[aria-selected="true"]:not([disabled])') || list.querySelector('.sw-pick-opt:not([disabled])');
    if (sel) {
      sel.tabIndex = 0;
      requestAnimationFrame(() => { sel.scrollIntoView({ block: 'center' }); sel.focus({ preventScroll: true }); });
    }
  }

  // ── Date ─────────────────────────────────────────────────────────────────
  let view = null; // { year, month, focus: Date, mode: 'days' | 'months' }

  function bounds(el) { return { min: parse(el.min), max: parse(el.max) }; }
  function allowed(el, d) {
    const { min, max } = bounds(el);
    return !(min && d < min) && !(max && d > max);
  }

  function renderDate(el, first) {
    const selected = parse(el.value);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (first) {
      const f = selected || today;
      view = { year: f.getFullYear(), month: f.getMonth(), focus: f, mode: 'days' };
    }
    const sub = selected
      ? `${WEEKDAY_NAMES[selected.getDay()]}, ${selected.getDate()} ${MONTHS[selected.getMonth()]} ${selected.getFullYear()}`
      : 'No date picked';
    let body;
    if (view.mode === 'months') {
      body = `<div class="sw-cal-nav">
          <button type="button" class="sw-cal-step" data-year="-1" aria-label="Previous year">${ICON.prev}</button>
          <span class="sw-cal-label">${view.year}</span>
          <button type="button" class="sw-cal-step" data-year="1" aria-label="Next year">${ICON.next}</button>
        </div>
        <div class="sw-cal-months">${MONTHS.map((m, i) => `<button type="button" class="sw-cal-month"
          data-month="${i}" aria-pressed="${i === view.month}">${m.slice(0, 3)}</button>`).join('')}</div>`;
    } else {
      const first = new Date(view.year, view.month, 1);
      const days = new Date(view.year, view.month + 1, 0).getDate();
      let cells = '';
      for (let i = 0; i < first.getDay(); i++) cells += '<span class="sw-cal-blank"></span>';
      for (let d = 1; d <= days; d++) {
        const date = new Date(view.year, view.month, d);
        const ok = allowed(el, date);
        cells += `<button type="button" class="sw-cal-day" data-date="${iso(date)}"
          aria-label="${WEEKDAY_NAMES[date.getDay()]} ${d} ${MONTHS[view.month]} ${view.year}"
          ${sameDay(date, selected) ? 'aria-pressed="true"' : ''} ${sameDay(date, today) ? 'aria-current="date"' : ''}
          tabindex="${sameDay(date, view.focus) ? 0 : -1}" ${ok ? '' : 'disabled'}>${d}</button>`;
      }
      body = `<div class="sw-cal-nav">
          <button type="button" class="sw-cal-label sw-cal-jump" data-mode="months" aria-label="Choose month and year">${MONTHS[view.month]} ${view.year} ${ICON.down}</button>
          <span class="sw-cal-steps">
            <button type="button" class="sw-cal-step" data-month-step="-1" aria-label="Previous month">${ICON.prev}</button>
            <button type="button" class="sw-cal-step" data-month-step="1" aria-label="Next month">${ICON.next}</button>
          </span>
        </div>
        <div class="sw-cal-week" aria-hidden="true">${WEEKDAYS.map(w => `<span>${w}</span>`).join('')}</div>
        <div class="sw-cal-grid" role="grid">${cells}</div>`;
    }
    const yesterday = addDays(today, -1);
    panel.classList.add('sw-cal-panel');
    panel.innerHTML = head(labelFor(el), sub) + body +
      `<div class="sw-cal-foot">
        <button type="button" class="sw-cal-quick" data-date="${iso(today)}" ${allowed(el, today) ? '' : 'disabled'}>Today</button>
        <button type="button" class="sw-cal-quick" data-date="${iso(yesterday)}" ${allowed(el, yesterday) ? '' : 'disabled'}>Yesterday</button>
      </div>`;
    if (!panel.dataset.wired) wireDate(el);
    const target = panel.querySelector('.sw-cal-day[tabindex="0"]:not([disabled])') ||
      panel.querySelector('.sw-cal-month[aria-pressed="true"]') || panel.querySelector('.sw-cal-day:not([disabled])');
    // Focus moves into the dialog either way (Escape and arrows work); browsers only draw the ring after keys
    if (target) target.focus({ preventScroll: true });
  }

  function wireDate(el) {
    panel.dataset.wired = '1';
    panel.addEventListener('click', e => {
      const t = e.target.closest('button');
      if (!t || t.disabled) return;
      if (t.hasAttribute('data-close')) return close();
      if (t.dataset.date) return commit(el, t.dataset.date);
      if (t.dataset.monthStep) shiftMonth(+t.dataset.monthStep);
      else if (t.dataset.year) view.year += +t.dataset.year;
      else if (t.dataset.mode) view.mode = 'months';
      else if (t.dataset.month !== undefined) { view.month = +t.dataset.month; view.mode = 'days'; view.focus = new Date(view.year, view.month, 1); }
      renderDate(el, false);
      place();
    });
    panel.addEventListener('keydown', e => {
      if (view.mode !== 'days' || !e.target.classList.contains('sw-cal-day')) return;
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
      let next = null;
      if (step) next = addDays(view.focus, step);
      else if (e.key === 'PageUp' || e.key === 'PageDown') next = new Date(view.focus.getFullYear(), view.focus.getMonth() + (e.key === 'PageUp' ? -1 : 1), view.focus.getDate());
      if (!next) return;
      e.preventDefault();
      view.focus = next; view.year = next.getFullYear(); view.month = next.getMonth();
      byKeyboard = true;
      renderDate(el, false);
    });
  }

  function shiftMonth(n) {
    const d = new Date(view.year, view.month + n, 1);
    view.year = d.getFullYear(); view.month = d.getMonth();
    view.focus = new Date(view.year, view.month, Math.min(view.focus.getDate(), new Date(view.year, view.month + 1, 0).getDate()));
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ── Triggers ─────────────────────────────────────────────────────────────
  doc.addEventListener('click', e => {
    if (layer || e.button !== 0) return;
    const el = controlAt(e.clientX, e.clientY);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    open(el, false);
  }, true);

  doc.addEventListener('keydown', e => {
    const el = e.target;
    if (layer || !pickable(el)) return;
    const opens = el.tagName === 'SELECT'
      ? (e.key === ' ' || e.key === 'Enter' || e.key === 'F4' || (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')))
      : (e.key === ' ' || e.key === 'Enter' || (e.altKey && e.key === 'ArrowDown'));
    if (!opens) return;
    e.preventDefault();
    open(el, true);
  }, true);

  // Popovers follow nothing on scroll or resize: close them (sheets stay put)
  window.addEventListener('resize', () => close(false));
  doc.addEventListener('scroll', e => {
    if (layer && !layer.classList.contains('is-sheet') && !(panel && panel.contains(e.target))) close(false);
  }, true);
})();
