# Design review: SpendWise (web app / PWA) — 2026-10-21

Reviewed against Apple's Human Interface Guidelines (pages cited as `file.md › Heading`). SpendWise is a web app, so Apple's principles and foundations (accessibility, colour, type, layout, writing) apply fully. iOS conventions apply as the expectations of the iPhone users who install it as a PWA.

**What was checked:** the source (6 HTML pages, `tokens.css`, `style.css`, `responsive.css`, `components/forms.css`, `accessibility.js`, page scripts). Contrast is computed from the hex values that actually apply. Nothing was viewed on a device; findings about look and feel come from the code.

Tick a box when fixed. Findings are numbered so you can say "fix 3".

## Summary

**Rating: Critical issues.**
- **Thesis:** "log a rupee in seconds, see where it went".
- **What works:** the bones are good. There are semantic colour tokens with dark variants, reduced-motion and increased-contrast support, 44 px touch targets on main controls, and a real accessibility layer (dialog roles, focus trap, skip link, chart descriptions).
- **What breaks:** the colours actually applied undo most of that. A second set of tokens in `style.css` overrides the accessible ones in `tokens.css`, so secondary text sits at 2:1 contrast and green income amounts at 2.2:1.
- **Navigation:** on phones it is hidden behind a hamburger menu, because the bottom tab bar is switched off at every common width.
- **Identity:** the app is remembered by nothing yet. It is an apple.com palette with Inter, and the two logos disagree.

---

## Critical

- [x] **1. Secondary text is unreadable: the accessible tokens are overridden** (`assets/css/style.css:11-79` vs `assets/css/tokens.css:10-118`)
  - **What:** `style.css` imports `tokens.css`, then redefines the same variables in its own `:root` and `[data-theme="dark"]`, and those later values win. The "improved" values in `tokens.css` never apply.
    - `--text3` (light): `#aeaeb2` on white is **2.21:1**, and on the `#f5f5f7` page background **2.03:1**. It is used in 72 rules, including summary labels, table headers, category tile labels, placeholders and period labels, mostly at 10–11 px.
    - `--text3` (dark): `#636366` on surface `#1c1c1e` is **2.84:1**.
    - The `tokens.css` comments are wrong too: `#86868b` is 3.62:1 on white, not the 4.6:1 it claims.
  - **Why:** `accessibility.md › Vision`: "Strive to meet color contrast minimum standards… Up to 17 pts: 4.5:1." `dark-mode.md › Dark Mode colors`: "At a minimum, make sure the contrast ratio between colors is no lower than 4.5:1."
  - **Fix:** delete the duplicate token blocks at the top of `style.css` (lines 11–79, keeping only what `tokens.css` lacks, such as `--radius*`, `--nav-h` and `--transition`) so there is one source of truth. Then set:
    - light `--text3: #6e6e73` (5.07:1 on white, 4.66:1 on `#f5f5f7`). This makes it the same as `--text2`. If you need a third tier, use weight or size, not lower contrast.
    - dark `--text3: #98989d` (≈6:1 on `#1c1c1e`).

  - **Status (2026-10-21, branch `fix/ui-critical-high`):** Fixed: duplicate token block removed from `style.css`; `--text3` is `#6e6e73` (light) and `#98989d` (dark).
- [x] **2. Income amounts and status colours fail contrast** (`assets/css/style.css:25-33`; `color: var(--success)` in 40 rules, `--warning` in 9)
  - **What:** green text `#34c759` on white is **2.22:1**, orange `#ff9500` **2.20:1**, red `#ff3b30` **3.55:1** and cyan `#5ac8fa` **1.90:1**. Income totals, "Today you have spend ₹…" and status chips are written in these. They are the numbers people open the app to read.
  - **Why:** `accessibility.md › Vision` (4.5:1 for text up to 17 pt, 3:1 only for bold or 18 pt+). `color.md › Inclusive color`: "Avoid using colors that make it hard to perceive content in your app."
  - **Fix:** keep the bright system hues for fills, icons and chart segments. Add text-safe variants for numbers and labels:
    - `--success-text: #1e7e34` (5.14:1 on white)
    - `--danger-text: #c62828` (5.62:1)
    - `--warning-text: #b25900` (4.86:1)
    - dark mode can keep `#30d158` (8.42:1), `#ff453a` (4.99:1) and `#ff9f0a` (8.28:1) on `#1c1c1e`.
    - The `tokens.css` values are mixed. `#dc3545` passes (4.53:1), but `#28a745` (3.13:1) and `#e67e22` (2.85:1) are still too light for text.

  - **Status (2026-10-21, branch `fix/ui-critical-high`):** Fixed: light `--success #1e7e34`, `--danger #c62828`, `--warning #b25900`, `--cyan #0b7285` (all ≥4.86:1). Dark values were already fine.
- [x] **3. Text below the 11 pt minimum** (`style.css:1870` `.period-summary-label` 10 px; `style.css:2289` `.score-label` 10 px; `style.css:1675` edit-modal category labels 10 px; `responsive.css:41` bottom-nav labels 10 px)
  - **What:** four kinds of label are set at 0.625rem (10 px). Most are also in `--text3` grey, so the 2:1 contrast from #1 makes them worse.
  - **Why:** `typography.md › Ensuring legibility`: "iOS, iPadOS: Default size 17 pt, Minimum size 11 pt."
  - **Fix:** raise all four to at least `0.75rem` (12 px), the same as `--text-sm`. For the category tiles in the edit modal, let the label wrap to two lines instead of shrinking it.

  - **Status (2026-10-21, branch `fix/ui-critical-high`):** Fixed: every sub-11px size raised to 12px, including 5 the original pass missed (`.rec-priority-badge`, `.csv-type-badge`, mobile `.summary-label`, insights bottom-nav, `.day-amount` at the 11px minimum; it is hidden on phones).
- [x] **4. Keyboard focus is invisible on most controls** (`style.css:93` `button { … outline: none; }`; inputs `style.css:122`, `:1843`, `:2091`, `:2106`)
  - **What:** every button and most inputs remove the focus outline. A visible replacement exists only for `.btn` (`style.css:162`), and for everything else only inside `@media (prefers-contrast: high)` (`responsive.css:573`). With a keyboard on desktop or iPad, or with Full Keyboard Access, you can't see what is focused in the sidebar, the icon buttons, the tabs or the category tiles.
  - **Why:** `accessibility.md › Speech`: "Let people use the keyboard alone to navigate and interact with your app."
  - **Fix:** move the high-contrast rule out of the media query so it applies everywhere: `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }`. Keep `outline: none` only on `:focus:not(:focus-visible)`, so taps and clicks still show no ring.

  - **Status (2026-10-21, branch `fix/ui-critical-high`):** Fixed: global `:focus-visible` ring (2px accent) at the end of `responsive.css`.
---

## Improvements

- [x] **5. On phones, top-level navigation is hidden behind a hamburger menu** — High (`style.css:4159-4170`, `responsive.css:397-455`)
  - **What:** every page contains a 6-item bottom tab bar (`.bottom-nav`), but it is `display: none` at ≤767 px and at ≥768 px. It only appears on foldables through the non-standard `@media (spanning: …)` query. iPhone users get a menu button in the top corner, the hardest place to reach one-handed, and nothing on screen shows which section they are in.
  - **Why:** `tab-bars.md › Best practices`: "Make sure the tab bar is visible when people navigate to different sections of your app. If you hide the tab bar, people can forget which area of the app they're in." `designing-for-ios.md › Best practices`: "it tends to be easier and more comfortable for people to reach a control when it's located in the middle or bottom area of the display."
  - **Fix:** show `.bottom-nav` at `max-width: 767px` and drop the hamburger there. Cut it to 5 tabs or fewer (`tab-bars.md › Best practices`: "it's generally easier to navigate among fewer tabs"). For example: Home · Expenses · Income · Debts · Insights, with History merged into the Expenses and Income lists as a filter. Rename "AI" to "Insights". Use `<a href>` with `aria-current="page"` instead of `<button data-action>` so the active tab is announced. Add bottom padding equal to `--bottom-nav-h` + safe area so content and the voice button clear the bar.

  - **Status (2026-10-21, branch `fix/ui-critical-high`):** Fixed: the bottom tab bar shows at ≤767px, with no hamburger. Labels "Home" and "Insights". `aria-current="page"` is on the active tab, and the Debt tab is now active on its own page. Kept 6 tabs rather than merging History, to avoid removing a feature; they fit at 320px.
- [x] **6. Every form field zooms the page on iPhone** — High (`style.css:92, 120-124`: inputs at `0.9375rem` = 15 px)
  - **What:** iOS Safari zooms in on any focused field under 16 px and doesn't zoom back. Adding an expense, the app's core task, shifts the whole layout every time.
  - **Why:** `layout.md › Adaptability`: people expect the experience "to remain familiar". `entering-data.md` (intro): "design ways that make it easy for them to provide it without making mistakes." The 16 px threshold is Safari's behaviour, not an Apple guideline.
  - **Fix:** `input, select, textarea { font-size: max(1rem, 16px); }` at `max-width: 767px`. Don't use `maximum-scale=1` (it blocks pinch-zoom, which people with low vision need).

  - **Status (2026-10-21, branch `fix/ui-critical-high`):** Fixed: inputs, selects and textareas are 16px at ≤767px.
- [x] **7. Body text is 14 px and ignores the reader's text-size setting** — Medium (`style.css:85` `html { font-size: 16px; }`; `tokens.css:152` `--text-base: 0.875rem`)
  - **What:** body and table text is 14 px, against a 17 pt default. Fixing the root size in px also overrides the browser's default font-size setting, and on iOS nothing follows Dynamic Type.
  - **Why:** `typography.md › Supporting Dynamic Type`: "Make sure your app's layout adapts to all font sizes." `accessibility.md › Vision`: "give people the option to enlarge text by at least 200 percent."
  - **Fix:** remove `font-size: 16px` from `html` (or set `100%`). On iOS, opt in with `html { font: -apple-system-body; }` and keep sizes in `rem` so text follows Settings › Display & Text Size. Raise `--text-base` to `1rem`. Test at 200 %; summary cards and table rows must wrap, not clip.

  - **Status (2026-10-21, branch `fix/ui-remaining`):** Fixed: root `font-size: 100%`, with Dynamic Type on iOS only (`font: -apple-system-body`, gated by `-webkit-touch-callout` because Mac Safari's value is 13px). Also removed two more fixed roots the audit missed: phones forced to 15px (`responsive.css`) and 17px at ≥1920px (now 106.25%). `--text-base` is 1rem. At 200% text no page scrolls sideways: summary, period, form and category grids use `minmax(0, 1fr)`, and the CSV card title and toasts wrap. The header wordmark and tab labels stay fixed px, since `typography.md` says tab titles needn't grow.
- [x] **8. Row edit and delete buttons are small and 6 px apart** — Medium (`style.css:1535-1544`; touch rule at `responsive.css:597` targets `.table-actions .btn-action`, a class no markup uses)
  - **What:** the rows render `.action-buttons`, so the 44 px touch rule never applies. Edit and delete are about 30×30 px with a 6 px gap, so a mis-tap on Delete is easy. The confirmation modal limits the damage.
  - **Why:** `accessibility.md › Mobility`: "iOS 44x44 pt default… it works well to add about 12 points of padding around elements that include a bezel."
  - **Fix:** change the selector to `.action-buttons .btn-action` and set `gap: 12px`. On phones, consider putting both actions in a swipe or a single row menu (`designing-for-ios.md › Best practices`: "let people swipe to navigate back or initiate actions in a list row").

  - **Status (2026-10-21, branch `fix/ui-remaining`):** Fixed: the touch rule now targets `.action-buttons .btn-action` (44px), and the gap is 12px.
- [x] **9. The app has its own light/dark switch, starts dark, and doesn't follow the system** — Medium (`index.html:2` `data-theme="dark"`; `dashboard.js:1444`, `income.js:82`, `debt.js:81`; `<meta name="theme-color" content="#121212">` on all pages)
  - **What:**
    - Every page loads dark, then JS may switch it to light, which causes a dark flash for light-mode users.
    - The system preference is read once and never watched, and after one tap on the sun/moon button the system setting is ignored forever.
    - The status-bar colour stays `#121212` in light mode.
  - **Why:** `dark-mode.md › Best practices`: "Avoid offering an app-specific appearance setting… they may think your app is broken because it doesn't respond to their systemwide appearance choice."
  - **Fix:** remove the toggle (or make it "System / Light / Dark" with System as default). Drive colours with `@media (prefers-color-scheme: dark)` in CSS, so there is no JS and no flash. Use two theme-color metas: `<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f5f5f7">` and the dark one.

  - **Status (2026-10-21, branch `fix/ui-remaining`):** Fixed, as System / Light / Dark (your choice). New `assets/js/theme.js` loads in `<head>`, so there is no flash. System is the default and follows OS changes live. The button cycles System → Light → Dark with an aria-label. It replaces 3 copies of the theme code, so the dashboard and income pages no longer disagree about the icon. The hard-coded `data-theme="dark"` is gone, and there are two `theme-color` metas.
- [x] **10. Dashboard headline has a grammar error and ignores the currency setting** — Medium (`assets/js/dashboard.js:819-821`)
  - **What:** "Today you have spend …", and the zero state hard-codes "Rs 0" even when the user picked USD or EUR.
  - **Why:** `writing.md › Getting started`: "Be clear. Choose words that are easily understood." `branding.md`: use your voice "in all the written communication you display".
  - **Fix:** "Spent today: {fmt(total)}" and use `fmt(0)` for the zero state. If you want warmth, try "Nothing spent yet today" for zero.

  - **Status (2026-10-21, branch `fix/ui-remaining`):** Fixed: "Spent today ₹…" / "Nothing spent yet today". The static "Rs 0.00" placeholders use `.currency-symbol`, so they show the chosen currency.
- [x] **11. Error messages talk about the system, not the person** — Medium (`dashboard.js:602` "Failed to save. Check Firebase config."; generic "Something went wrong. Try again." in 3 places)
  - **Why:** `writing.md › Best practices`: "be clear about what someone can do to fix it… Avoid robotic error messages with no helpful information."
  - **Fix:** "Couldn't save. Check your connection — it'll be saved offline if you're not connected." Map Firebase codes to specific advice.

  - **Status (2026-10-21, branch `fix/ui-remaining`):** Fixed: one `friendlyErr` in `helpers.js` (was 3 copies) with actionable messages, plus network and too-many-requests codes. "Check Firebase config" became "Couldn't save the expense. Check your connection and try again."
- [x] **12. Errors in toasts disappear after 3 seconds** — Low (`backup.js:22`, `offline-queue.js` showToast, `dashboard.js` showToast)
  - **Why:** `accessibility.md › Cognitive`: "Minimize use of time-boxed interface elements… Prefer dismissing views with an explicit action."
  - **Fix:** keep success toasts at 3 s. Make error toasts stay until dismissed (add a close button), or show them inline next to the field, as `showFormMsg` already does.

  - **Status (2026-10-21, branch `fix/ui-remaining`):** Fixed: error toasts stay until tapped (✕ shown; the handler is in `accessibility.js`). Success toasts still hide after 3s. The offline-queue fallback toast used an unstyled `toast-error` class; it now uses `toast error`.
- [x] **13. Mixed capitalisation and emoji in status text** — Low
  - **What:**
    - Badges use title case ("They Owe Me", "I Owe Them"); most buttons and messages use sentence case.
    - Status lines start with emoji ("✅ Imported…", "❌ Import failed", "⏳ …"), which VoiceOver reads aloud as "check mark button" and so on.
  - **Why:** `writing.md › Best practices`: "Choose a style for each UI element type and use it consistently."
  - **Fix:** sentence case everywhere ("They owe me"). Put the status meaning in an icon with `aria-hidden="true"` plus text, not an emoji inside the string.

  - **Status (2026-10-21, branch `fix/ui-remaining`):** Fixed: sentence case "They owe me / I owe them" (debt page, badges, voice preview). 23 leading emoji removed from status strings in `backup.js`, `csv-upload.js` and `voice-command.js`.
- [x] **14. Insights error close button has no name** — Low (`insights.html:366` `.error-dismiss`)
  - **Fix:** `aria-label="Dismiss"`. All other icon buttons have a `title` or get an `aria-label` from `accessibility.js`.

  - **Status (2026-10-21, branch `fix/ui-remaining`):** Fixed: `aria-label="Dismiss error"`.
---

## Craft notes

- [x] **15. No point of view yet: it reads as apple.com, not SpendWise** — High
  - **What:** the palette is Apple's marketing site, copied directly (`#f5f5f7`, `#1d1d1f`, `#0071e3`). Add Inter, Lucide icons, and a blue→violet→pink gradient border on the AI card (`style.css:2283`) and you have the generic "AI app" look. Nothing on screen is specific to tracking money in India.
  - **Why:** `branding.md › Best practices`: "Apply your app's accent color judiciously… use it intentionally for primary actions or status indicators." `design-principles.md` Craft and Delight: delight is not decoration.
  - **Fix:** pick one signature element and keep everything else quiet. The obvious candidate already exists: the gold Indus-seal coin (`logo2.png`). Possible directions:
    - A warm gold accent used only for the daily total and primary actions. Use `#8a6508` for gold text (5.32:1 on white, 4.89:1 on `#f5f5f7`). A brighter `#b8860b` is only 3.25:1, so keep it for fills and icons.
    - The ₹ figures set in a tabular-number display face as the one place type gets personality.
    - Remove the rainbow gradient.

  - **Status (2026-10-21, branch `fix/ui-critical-high`):** Fixed: gold `--gold` (#8a6508 light, 5.32:1 / #e8b84a dark, 9.23:1) on the daily total and the three Add buttons (`.btn-add`). Rainbow and violet gradients replaced with solid colours.
- [x] **16. Two different logos** — Medium
  - **What:** the home-screen icon and favicon use `logo2.png` (gold Indus coin, 12 references). The app header uses `logo.png` (blue shield with arrow and coin, 11 references). A person installs one brand and opens another.
  - **Fix:** choose one mark and use it in both places. Also drop the logo from page headers after the first screen (`branding.md › Best practices`: "Resist the temptation to display your logo throughout your app").

  - **Status (2026-10-21, branch `fix/ui-remaining`):** Fixed: the gold coin (`logo2.png`) is used everywhere, with "SpendWise" as live text in the header and on the sign-in card. `logo.png` was deleted.
- **Remove one accessory (done, branch `fix/ui-remaining`):** the hamburger button and slide-out panel markup were removed from all 6 pages (the JS helpers are null-guarded). Originally: the hidden bottom nav plus hamburger plus sidebar is three navigation systems in the markup. After #5, delete the mobile hamburger panel entirely.

---

## What works

- **Semantic tokens with real dark variants:** dark mode uses brighter foregrounds rather than inversion (`tokens.css:66-118`). Once #1 removes the duplicate, this is a solid base.
- **Reduced motion and increased contrast are both handled** (`style.css:2975`, `responsive.css:520, 561`). That's more than most apps do.
- **The accessibility layer in `accessibility.js`:**
  - dialog roles with `aria-modal` and focus trapping on every modal;
  - a skip link;
  - an `aria-live` region for toasts;
  - category tiles exposed as a radiogroup;
  - charts given `role="img"` with a generated description (`charting-data.md › Best practices`: "Make every chart in your app accessible").
- **Choices instead of typing:** the category tiles and payment selects follow `entering-data.md › Best practices`: "offer choices instead of requiring text entry."
- **Debt type is shown with text, not just colour:** "They owe me / I owe them" badges (`color.md › Inclusive color`).
- **Destructive actions confirm first:** delete opens a confirmation modal with Cancel.
- **Safe-area insets are used** for the bottom bar and voice sheet, and coarse-pointer devices get 44 px targets on the main controls.
- **Fast first paint:** cached data renders instantly and skeleton rows show while Firestore loads.

## Platform notes

- **Safe areas need `viewport-fit=cover`:** the viewport meta lacks it (`<meta name="viewport" content="width=device-width, initial-scale=1.0">`), so `env(safe-area-inset-*)` is 0 in the browser. Add it together with #5 so the restored tab bar sits above the home indicator. Then test in standalone (installed) mode on an iPhone with a Dynamic Island.
- **Desktop (≥768 px):** the sidebar is the right pattern. Make sure it shows the current page (`aria-current`) and that #4's focus ring is visible on it.
- **Foldables:** `@media (spanning: …)` was never standardised. Use the viewport-segments API (`@media (horizontal-viewport-segments: 2)`) or drop it.

**Verified 2026-10-21** by rendering with headless Chrome at 390×844 and 1280px: bottom nav visible / hamburger hidden on phones, inputs 16px, Add buttons gold in light and dark, focus ring drawn. Not yet checked on a real iPhone.

**Still open:** `viewport-fit=cover` and the foldable `spanning` query (platform notes). Both need a real-device check.

**Suggested order:** #1 → #2 → #3 → #4 (accessibility), then #5 and #6 (navigation and input friction on phones), then #7–#11, then craft #15–#16.
