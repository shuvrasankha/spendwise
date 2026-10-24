# SpendWise — notes for Claude

Personal finance PWA for India-first users: expenses, income, debts (shared by email), EMIs, budgets,
goals, AI insights. Plain HTML + ES modules, no build step. Firebase Auth + Firestore for data, a
Cloudflare Worker (`worker/`) for AI and push. Deployed to GitHub Pages.

## Working on it

- Run: `python3 -m http.server 8000`, open `http://localhost:8000/index.html`. The service worker
  ignores `localhost`, but Chrome's own cache can mix old and new files: hard reload (Cmd+Shift+R).
- Tests: `node --test tests/*.test.mjs` (app) and `cd worker && npm test`. Pure logic lives in
  `assets/js/utils/helpers.js` and `assets/js/modules/*-data.js` / `csv-export.js` so it can be
  tested; put new logic there with a test, not inside `dashboard.js`.
- `firestore.rules` is the source of truth but is **published by hand** in the Firebase console.
  A feature that writes a new field or lets someone else write needs the rules updated and the user
  told to publish them. Test rule changes in the Firestore emulator.
- Worker changes need `cd worker && npm run deploy` by the user.
- New page or module: add it to `STATIC_ASSETS` in `sw.js`.
- **Privacy rule for AI features:** entries (descriptions, notes, names) never go to the AI. The
  coach gets number-only facts (`factsText`); Ask sends only the question and today's date, and the
  answer is computed on the device (`ask-data.js`). Keep new AI features to the same rule.
- Check UI changes in a real browser (Playwright, Chromium at `/opt/pw-browsers/chromium`) at phone
  (390×844, touch) and desktop (1280+) sizes, light and dark, and look at the screenshots.

## Design principles

The look is **Apple-inspired**: when the user asks for "Apple design", follow the iOS/macOS Human
Interface Guidelines — calm surfaces, one clear figure per card, inset grouped lists, quiet controls,
nothing that shouts.

### Where styles go
- CSS loads in this order on every page: `tokens.css` → `style.css` → `responsive.css` →
  `reimagine.css`. **New and changed styles go at the end of `reimagine.css`**, in a block with a
  `/* ===== SECTION: what and why ===== */` header. Don't edit old `style.css` rules to restyle;
  override them in `reimagine.css`.
- Use the tokens in `tokens.css`; never hard-code a colour. Every token has a light value and a
  `[data-theme="dark"]` value, and their contrast ratios are noted beside them.

### Colour
- **Gold (`--gold`) means money and "selected"**: money totals, the selected tab, progress bars.
  Don't use it to decorate inactive things (an unselected tab stays grey).
- **Indigo (`--accent`)** is for links and primary buttons (`.btn-primary`) and checked options in
  dialogs.
- `--success` green for money in / done, `--danger` red for money owed / over budget. Colour never
  carries meaning alone: the words beside it say the same ("Owes you", "over budget").
- Text on a filled colour uses its "on" token (`--gold-on`, `--on-danger`). Body text ≥ 4.5:1.
- The **hero** card (ink `--hero-bg`, `--gold-bright` figure) is Home's only dark-on-light surface.

### Type
- `--font-ui` (Plus Jakarta Sans) for everything; `--font-display` (Fraunces) only for page titles
  and the wordmark.
- Money figures use tabular digits. Whole rupees (`moneyWhole`) for summaries, two decimals (`fmt`)
  in lists and tables. Never print a currency symbol by hand; amounts follow the user's currency.

### Layout
- One card language: `var(--surface)`, 1px `var(--border)`, `var(--radius)` (18px),
  `var(--shadow-xs)`. 16px between cards, ~20px padding inside. **No boxes inside boxes**: group
  related things in one card with hairline (`--border-light`) dividers instead of nesting cards.
- Lists are inset grouped: leading icon (36px rounded tile), title over a short subtitle, value on
  the right, dividers that start after the icon. Don't repeat information between title and subtitle.
- Each card has one clear headline (the big number), then context in one line.
- Breakpoints: phones `max-width: 767px`, desktop grid `min-width: 1024px`. Desktop pages are
  two-column (form left, cards right) or centred single column (`.settings-page`, 640px).
- Pin a card's footer link to the bottom (`margin-top: auto`) so short content still fills it.
- **No page repeats another.** The Dashboard shows the month's status (spent, income, saved,
  debts, score, categories, goals). Insights shows only analysis: comparison with the previous
  period, what changed, biggest expenses, weekdays, payment methods, fixed vs flexible. Before
  adding a figure to either page, check the other doesn't already show it.
  The month-end forecast is the one shared figure: both pages use `forecast()` (helpers.js) so they
  agree; the Dashboard shows only "on track for", Insights shows how it adds up and next month.

### Touch and input
- Touch targets ≥ 44px tall.
- Phones: the **tab bar** is a floating glass capsule of five equal, **icon-only** tabs (labels are
  visually hidden but kept for screen readers). The selected tab is a gold icon on a soft highlight.
  No raised/oversized buttons in it.
- Distinguish mouse from touch with `(hover: hover) and (pointer: fine)`, not width alone. Rows that
  swipe sideways on phones must wrap (or fold behind "Show all") with a mouse.
- Dialogs use `.modal-overlay` > `.modal-box` (bottom sheet on phones). `accessibility.js` gives
  them focus trapping and Escape for free if the close button's `data-action` contains `close`.
- Hover on a card that is a link: lift and border, no underline, no fade.

### Motion
- Small and quick (≈200–500ms, `--ease-smooth`). Cards rise in, numbers count up (`countTo`),
  presses scale to ~0.96. `prefers-reduced-motion` turns it all off — respect that in new motion.

### Icons
- Lucide 0.378 (`<i data-lucide="name">`), outline style, ~1.8–2px stroke, 16–26px. Same style
  everywhere; no filled/coloured icon mixed into a row of outline ones. No emoji in the UI.

### Words
- Plain, short, sentence case. Say what happened and what to do next ("Nothing in these dates. Pick
  another time frame."), never blame the network for a permission problem.
- Empty states point to the next step with a link ("Add your first expense").
- Where it's a screen's own name, call Home the **Dashboard**.

### Accessibility
- Every control has a name (visible text, `aria-label`, or visually hidden text). Progress bars get
  `role="progressbar"` with values. Content hidden behind "Show all" is made `inert` while folded.

## The user's preferences (learned)
- Wants Apple-style polish and asks for redesigns with screenshots; show before/after images.
- Prefers fewer, calmer elements: icons-only phone nav, no gold on inactive items, no underline on
  card hover.
- Commits go to the session's `claude/...` branch; don't open a PR unless asked.
