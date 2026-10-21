# SpendWise Audit — 2026-10-21

**What this repo does:** SpendWise is a personal finance web app. It tracks expenses, income and debts. It is plain HTML/JS on GitHub Pages, stores data in Firebase Firestore, and calls Hugging Face AI models for voice entry, CSV import and "AI insights".

**Load assumed:** many independent users, each with their own data, from a few hundred to a few thousand entries per person. Most users are in India (IST, UTC+5:30), so time-zone bugs matter.

Tick a box when a finding is fixed. Findings are numbered so you can say "fix 3".

---

## Must fix

- [x] **1. The Hugging Face token is published to every visitor** (`.github/workflows/deploy.yml:29-40`, `assets/js/modules/voice-command.js:21`, `insights-v2.js:15`, `csv-upload.js:22`)
  - **What this is:** At deploy time, the workflow pastes the secret `HF_TOKEN` into three JS files. GitHub Pages then serves those files to everyone.
  - **Problem:** Anyone can open the live site, press F12, and copy the token from `voice-command.js`. Keeping it in GitHub Secrets only hides it from the repo, not from the website.
  - **Fix:** Revoke the current token on huggingface.co now. Then call Hugging Face through a small server-side proxy, such as a Firebase Cloud Function or a Cloudflare Worker. The proxy holds the token and checks the user's Firebase ID token (proof of who is logged in) before it forwards a request. Delete the `sed` step and the `HF_TOKEN` placeholders.
  - **If we skip it:** Strangers use up your Hugging Face quota or bill, or get your account rate-limited, and the AI features stop working for real users.
  - **Status (2026-10-21, branch `fix/hf-token-proxy`):** Fixed in code.
    - New Cloudflare Worker `worker/src/index.js` holds the token, checks the Firebase ID token, allows only the 3 models the app uses, and caps `max_tokens` at 4096.
    - New `assets/js/config/ai.js` (`callAI`) is used by `voice-command.js`, `csv-upload.js` and `insights-v2.js`.
    - Removed: the `sed` injection step in `deploy.yml`, `voice-config.example.js`, and all `HF_TOKEN` placeholders. CSP `connect-src` now allows only the Worker host instead of the Hugging Face hosts.
    - Test: `cd worker && npm test` (5 passing: requests with no token, a forged token, or GET are rejected; CORS only echoes the app origin).
    - **Still to do by hand:**
      1. Revoke the old token on huggingface.co.
      2. ~~`npx wrangler secret put HF_TOKEN` and `npx wrangler deploy`~~ Done 2026-10-21: the Worker is live at `https://spendwise-ai.spendwise-ai.workers.dev` with the `HF_TOKEN` secret set.
      3. ~~Put the Worker URL in `AI_PROXY_URL`~~ Done. CSP narrowed to the exact Worker host.
      4. Delete the unused `HF_TOKEN` GitHub secret.

- [ ] **2. Offline saves never sync and are silently deleted** (`assets/js/modules/offline-queue.js:150-188, 104-121`)
  - **What this is:** When the user is offline, expenses, income and debts go into a queue in `localStorage`. When the connection returns, `syncOfflineQueue` uploads them.
  - **Problem:** `offline-queue.js` is a plain script, not a module, but it uses `db` and `currentUser`. Those names exist only inside other modules, so every sync throws `ReferenceError: db is not defined`. After 3 tries (line 114) the item is thrown away. Two smaller issues: `createdAt: serverTimestamp()` does not survive `JSON.stringify` into `localStorage`, and the queue key is shared by every account on the device.
  - **Fix:** Have `dashboard.js`, `income.js` and `debt.js`, which already have `db`, set `window.firebaseSyncItem` to a function that uses their own `db` and `currentUser`. Set `createdAt: serverTimestamp()` at sync time, not when the item is queued. Name the queue key `spendwise_offline_queue_<uid>`. Never drop an item after max retries; keep it and show it as "failed".
  - **If we skip it:** Every expense saved offline vanishes after the user comes back online, even though the app said "Saved offline!".

- [ ] **3. The service worker never installs on the live site, and if it did it would serve old code forever** (`index.html:931`, `expense.html:854`, `income.html:474`, `history.html:789`, `insights.html:442`, `sw.js:3, 79-93`)
  - **What this is:** The service worker (a background script that caches files so the app works offline) is registered with `navigator.serviceWorker.register('/sw.js')`.
  - **Problem:** The site lives at `shuvrasankha.github.io/spendwise/`, so `/sw.js` points at `shuvrasankha.github.io/sw.js`, which does not exist. Offline mode and the PWA cache never start. `debt.html` does not register it at all. Once the path is fixed there is a second problem: JS and CSS are served "cache-first" under a fixed name, `spendwise-v2`. After each deploy, users get new HTML with old JS until someone edits that name by hand.
  - **Fix:** Use `register('./sw.js')` on every page, including `debt.html`. In the deploy workflow, add a step like `sed -i "s/spendwise-v2/spendwise-${GITHUB_SHA::7}/" sw.js` so each deploy gets a new cache name.
  - **If we skip it:** No offline support today. After you fix the path, every deploy can break the app for returning users until they clear their cache.

- [ ] **4. Dates shift by a day because local time is converted to UTC** (`assets/js/modules/insights-v2.js:962-963`, `assets/js/dashboard.js:1671-1672`, `assets/js/modules/csv-upload.js:176`)
  - **What this is:** These places turn a date into `YYYY-MM-DD` with `toISOString()`, which always uses UTC.
  - **Problem:** In India, midnight on 1 October local time is 18:30 on 30 September in UTC. So the Insights "this month" start date always shows the last day of the previous month. Between 00:00 and 05:30 IST the "end" date is yesterday, and the dashboard's weekly chart puts each week one day early.
  - **Fix:** Use the local-date formatter that `helpers.js` already has. Change `todayStr()` to `todayStr(d = new Date())` and call `todayStr(monthStart)`, `todayStr(weekStart)` and so on instead of `toISOString().split('T')[0]`.
  - **If we skip it:** Insights include an extra day from last month, and weekly totals are wrong for late-night users.

- [ ] **5. Restoring a backup with more than 500 items always fails** (`assets/js/modules/backup.js:162-204`)
  - **What this is:** Import puts every expense, income and debt into one Firestore `writeBatch` (a group of writes applied together).
  - **Problem:** Firestore allows at most 500 writes per batch. A user with 600 entries, about 1–2 years of daily use, gets "Import failed" and nothing is restored.
  - **Fix:** Commit in chunks: when the count reaches 500, `await batch.commit()` and start a new `writeBatch(db)`.
  - **If we skip it:** The backup feature fails for exactly the users who need it most, those with lots of data.

---

## Should fix

- [ ] **6. Firestore security rules are not in the repo, so nobody can check them** (repo root: there is no `firestore.rules` or `firebase.json`)
  - **What this is:** The Firebase config, including the API key, is public by design (`assets/js/config/firebase.js`). The only thing that keeps users' data private is the Firestore rules.
  - **Problem:** The app filters with `where('uid', '==', uid)` in the browser, but that protects nothing; anyone can send their own query. If the rules in the Firebase console are loose (for example, left in "test mode"), anyone can read or delete every user's finances. I could not verify the rules from here.
  - **Fix:** Add `firestore.rules` with `allow read, update, delete: if request.auth.uid == resource.data.uid; allow create: if request.auth.uid == request.resource.data.uid;` for `expenses`, `income` and `debts`, and deploy it with `firebase deploy --only firestore:rules`.
  - **If we skip it:** One wrong click in the console exposes everyone's money data, and nobody would notice.

- [ ] **7. A failed CSV import leaves half the rows saved, and retrying duplicates them** (`assets/js/modules/csv-upload.js:186+` `saveToFirestore`)
  - **What this is:** After the AI parses a CSV, each row is saved with its own `addDoc` call, one after another.
  - **Problem:** If row 40 of 100 fails (network drop, rate limit), rows 1–39 are already saved. The user sees an error, tries again, and rows 1–39 are saved twice.
  - **Fix:** Use a chunked `writeBatch`, the same as the fix for #5, so all rows land or none do.
  - **If we skip it:** Duplicate expenses that the user has to delete one by one.

- [ ] **8. Shared helpers are copied into every file, and `modules/auth.js` is dead code** (`assets/js/modules/auth.js`, `assets/js/utils/helpers.js`)
  - **What this is:** `helpers.js` exports `pad`, `todayStr`, `formatDate`, `escapeHtml` and `friendlyErr`, but the pages import only `sanitize`.
  - **Problem:** Every page keeps its own copy instead: `pad` in 5 files, `escapeHtml` in 4, `showToast` in 7, `formatDate`, `toggleTheme` and `initCurrencySelector` in 3. `modules/auth.js` (110 lines) is imported by nothing; only `sw.js` lists it. A fix to one copy, like #4, has to be repeated everywhere or the pages disagree.
  - **Fix:** Import these from `utils/helpers.js` and delete the local copies. Delete `modules/auth.js` and remove it from `sw.js`.
  - **If we skip it:** Bugs get fixed in one page and stay in the others.

- [ ] **9. Income edit and delete are written twice, with different checks** (`assets/js/dashboard.js:2420-2480`, `assets/js/income.js:370-425`)
  - **What this is:** The history page edits income through `dashboard.js`; the income page edits it through `income.js`.
  - **Problem:** The two copies are near-identical and must change together. Edit paths also skip `sanitize()` (for example, `inc-edit-notes` is only `.trim()`-ed), while the add paths do sanitize. So the same field gets different rules depending on which button you used.
  - **Fix:** Keep one `saveIncomeEdit` / `deleteIncome` in a shared module, use `sanitize()` there, and import it from both pages.
  - **If we skip it:** The next change to income fields is made in one copy only.

- [ ] **10. No tests at all for date and money logic**
  - **What this is:** The repo has no test files.
  - **Problem:** #4 shows how easy date math is to get wrong, and amounts, backup validation (`validateRecord`) and the AI-output cleaning in `csv-upload.js` all decide what gets saved as money data.
  - **Fix:** Add one `tests/helpers.test.js` run with `node --test`. It should check `todayStr(new Date(2026, 9, 1))` → `"2026-10-01"` and `getWeekStart` on a Sunday, run with `TZ=Asia/Kolkata`. Add `validateRecord` cases once it is exported.
  - **If we skip it:** Date bugs come back unnoticed.

- [ ] **11. The README and code comments make security claims that are false** (`README.md:37, 60, 115`, `assets/js/utils/helpers.js:32-38`)
  - **What this is:** The README says fields are "encrypted client-side (XOR encryption)" and that the app is deployed on Netlify. A CSP comment says Netlify headers do the main enforcement.
  - **Problem:** `dec()` is now a no-op, so there is no encryption, and the app deploys to GitHub Pages, so there are no Netlify headers. The only CSP is a `<meta>` tag that allows `'unsafe-inline'` scripts.
  - **Fix:** Remove the encryption claim, change "Netlify" to "GitHub Pages", and fix the CSP comment.
  - **If we skip it:** Users and contributors trust protections that don't exist.

---

## Nice to have

- [ ] **12. AI agent settings are committed** (`.qwen/settings.json`, `.qwen/settings.json.orig`)
  - **What this is:** A local Qwen agent's permission list, which includes `git push *` and `python3 *`.
  - **Problem:** It is personal tool config with no use to the app, and it gets deployed to GitHub Pages too, because the workflow uploads `.`.
  - **Fix:** `git rm -r --cached .qwen` and add `.qwen/` to `.gitignore`.
  - **If we skip it:** Clutter, and anyone can read your local tool setup.

- [ ] **13. AI modules create their own Firebase handles** (`voice-command.js:8-9`, `csv-upload.js:9-10`, `insights-v2.js:8-9`)
  - **What this is:** Each one calls `getAuth(app)` and `getFirestore(app)` itself.
  - **Problem:** `config/firebase.js` already exports `auth` and `db`. These are duplicate lines, not a bug.
  - **Fix:** `import { auth, db } from '../config/firebase.js'` and delete the local lines.
  - **If we skip it:** Six extra lines.

- [ ] **14. `insights.html` loads all of `dashboard.js` (2,514 lines)** (`insights.html:437`)
  - **What this is:** The insights page loads the dashboard script for the login check and page shell.
  - **Problem:** That script also fetches every expense, income and debt again, while `insights-v2.js` fetches its own data. The same data is downloaded twice on every visit.
  - **Fix:** After #8, move the shared auth/shell code into a small module and load only that on `insights.html`.
  - **If we skip it:** Slower Insights page and extra Firestore reads, which count against your free quota.

---

**Verdict:** #1 is fixed in code (deploy the Worker and revoke the old token to finish it). Fix #2 (offline saves are being lost) first, then #3–#5.

**Lean:** about -350 lines possible (#8, #9, #13: dead `auth.js`, duplicate helpers, duplicate income edit), -0 dependencies.

**Not checked:** the actual Firestore rules in the Firebase console; `voice-command.js` and `insights-v2.js` beyond their headers, the API call and response formatting; most of `dashboard.js` (2,514 lines, only the auth, load, save, edit and chart paths were read); `accessibility.js`; the CSS. Nothing was run in a browser.
