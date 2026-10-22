// voice-command.js — SpendWise Voice Command Module
// Uses Web Speech API (speech→text) + Cloudflare Workers AI (text→structured data)

import { app } from '../config/firebase.js';
import { callAI } from '../config/ai.js';
import { parseSms } from './sms-parse.js';
import { EXPENSE_CATEGORIES, normalizeCategory } from '../utils/helpers.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, doc, writeBatch, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const auth = getAuth(app);
const db = getFirestore(app);

// Currency helpers from global scope (currency.js loads before this module)
const fmt = window.fmt;

// AI runs on Cloudflare Workers AI via our proxy (config/ai.js)
const AI_MODEL = '@cf/qwen/qwen2.5-coder-32b-instruct';


const PAYMENT_METHODS = ['UPI', 'Cash', 'Credit Card', 'Debit Card', 'Net Banking', 'Other'];

const DEBT_TYPES = ['they-owe', 'i-owe'];

const INCOME_PAYMENT_TYPES = ['Online', 'Cash'];

// Tapping one fills the box, so people see the phrasing that works (nothing is sent)
const EXAMPLE_COMMANDS = [
  'Spent 250 on groceries and 80 on an auto',
  'Got my salary of 50000 today',
  'Lent 500 to Ravi yesterday'
];

// ── Supported Languages ──────────────────────────────────────────────────────
const VOICE_LANGUAGES = [
  { code: 'en-IN', label: 'English', flag: '🇬🇧', name: 'English' },
  { code: 'hi-IN', label: 'हिन्दी', flag: '🇮🇳', name: 'Hindi' },
  { code: 'bn-IN', label: 'বাংলা', flag: '🇮🇳', name: 'Bengali' },
  { code: 'ta-IN', label: 'தமிழ்', flag: '🇮🇳', name: 'Tamil' },
  { code: 'te-IN', label: 'తెలుగు', flag: '🇮🇳', name: 'Telugu' },
  { code: 'kn-IN', label: 'ಕನ್ನಡ', flag: '🇮🇳', name: 'Kannada' },
  { code: 'ml-IN', label: 'മലയാളം', flag: '🇮🇳', name: 'Malayalam' },
  { code: 'mr-IN', label: 'मराठी', flag: '🇮🇳', name: 'Marathi' },
  { code: 'gu-IN', label: 'ગુજરાતી', flag: '🇮🇳', name: 'Gujarati' },
  { code: 'pa-IN', label: 'ਪੰਜਾਬੀ', flag: '🇮🇳', name: 'Punjabi' },
  { code: 'or-IN', label: 'ଓଡ଼ିଆ', flag: '🇮🇳', name: 'Odia' }
];

// ── Helpers ──────────────────────────────────────────────────────────────────
function pad(n) { return String(n).padStart(2, '0'); }
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
// fmt() is now provided by currency.js

// ── State ────────────────────────────────────────────────────────────────────
let currentUser = null;
let recognition = null;
let isListening = false;
let parsedData = null;   // null or Array of validated entries
let selectedLang = localStorage.getItem('voiceLang') || 'en-IN';
let silenceTimer = null;
const SILENCE_TIMEOUT = 5000; // 5 seconds of silence → auto-stop

// ── Auth listener ────────────────────────────────────────────────────────────
onAuthStateChanged(auth, user => {
  currentUser = user;
  const fab = document.getElementById('voice-fab');
  if (fab) {
    // On expense.html, income.html, debt.html — always show FAB when logged in.
    // On index.html, FAB visibility is controlled by showPage() in app.js.
    const path = window.location.pathname;
    const isStandalonePage = path.includes('expense') || path.includes('income') || path.includes('history') || path.includes('debt');
    if (!user) {
      fab.style.display = 'none';
    } else if (isStandalonePage) {
      fab.style.display = '';
    }
    // On index.html, FAB starts hidden; showPage('add') will reveal it.
  }
  if (user) openSharedSms();
});

// An SMS shared to SpendWise from the Messages app (manifest share_target) arrives as ?text=
function openSharedSms() {
  const params = new URLSearchParams(location.search);
  const shared = params.get('text') || params.get('title');
  if (!shared) return;
  history.replaceState(null, '', location.pathname); // a reload shouldn't add it again
  openVoiceModal();
  handleTextSubmit(shared);
}

// ══════════════════════════════════════════════════════════════════════════════
//  SPEECH RECOGNITION (Web Speech API)
// ══════════════════════════════════════════════════════════════════════════════
function isSpeechSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function initSpeechRecognition() {
  if (!isSpeechSupported()) return null;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const rec = new SR();
  rec.lang = selectedLang;
  rec.interimResults = true;
  
  // Fix: continuous=true causes severe duplication bugs on Android Chrome 
  // and is poorly supported on iOS Safari. Use false on mobile devices.
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  rec.continuous = !isMobile;
  
  rec.maxAlternatives = 1;

  rec.onstart = () => {
    isListening = true;
    updateRecordingUI(true);
  };

  rec.onresult = (e) => {
    // Reset silence timer on every speech result
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      if (isListening) stopListening();
    }, SILENCE_TIMEOUT);

    // Merge logic that flawlessly handles BOTH Desktop (additive pieces) 
    // and Android (accumulative full strings in each result element)
    let display = '';
    for (let i = 0; i < e.results.length; i++) {
      const t = e.results[i][0].transcript.trim();
      if (!t) continue;

      const currentLower = display.toLowerCase().trim();
      const tLower = t.toLowerCase();

      // If 't' contains everything we have so far (Android bug), replace it
      if (tLower.startsWith(currentLower)) {
        display = t;
      } 
      // If what we have already contains 't' (duplicate/older result), ignore it
      else if (currentLower.startsWith(tLower)) {
        // do nothing
      } 
      // Standard Desktop additive mode
      else {
        display += (display ? ' ' : '') + t;
      }
    }

    // Check if the last result is still interim to style the text
    const isInterim = e.results.length > 0 && !e.results[e.results.length - 1].isFinal;

    const transcriptEl = document.getElementById('voice-transcript');
    if (transcriptEl) {
      transcriptEl.textContent = display || 'Listening…';
      transcriptEl.classList.toggle('interim', isInterim);
    }
    
    // Only set standard input value if we have a display generated to avoid overwriting with empty
    if (display) {
      document.getElementById('voice-text-input').value = display;
    }
  };

  rec.onerror = (e) => {
    console.error('Speech error:', e.error);
    clearTimeout(silenceTimer);
    isListening = false;
    updateRecordingUI(false);
    const messages = {
      'not-allowed': 'Microphone access is blocked. Allow it in your browser settings, or type below.',
      'service-not-allowed': 'Microphone access is blocked. Allow it in your browser settings, or type below.',
      'no-speech': 'Didn\'t hear anything. Tap the mic and try again.',
      'audio-capture': 'No microphone found. Type your command below instead.',
      'network': 'Speech needs an internet connection. Type below, or paste a bank SMS.',
      'language-not-supported': 'This language isn\'t available for speech here. Try English, or type below.',
      'aborted': ''
    };
    const msg = e.error in messages ? messages[e.error] : 'Speech recognition stopped. Try again or type your command.';
    if (msg) showVoiceStatus(msg, 'error');
  };

  rec.onend = () => {
    isListening = false;
    clearTimeout(silenceTimer);
    updateRecordingUI(false);
    // Auto-parse if we have transcript text
    const textInput = document.getElementById('voice-text-input');
    if (textInput && textInput.value.trim()) {
      parseVoiceCommand(textInput.value.trim());
    }
  };

  return rec;
}

const offline = () => (window.isOffline ? window.isOffline() : !navigator.onLine);
const OFFLINE_AI_MSG = 'You\'re offline. Spoken and typed commands need a connection, but a pasted bank SMS works offline.';

function startListening() {
  if (offline()) {
    showVoiceStatus(OFFLINE_AI_MSG, 'error');
    return;
  }
  if (!recognition) recognition = initSpeechRecognition();
  if (!recognition) {
    showVoiceStatus('Speech recognition not supported in this browser. Use the text input below.', 'error');
    return;
  }
  // Reset UI
  document.getElementById('voice-transcript').textContent = 'Listening… speak naturally, it stops when you pause';
  document.getElementById('voice-transcript').classList.remove('interim');
  document.getElementById('voice-text-input').value = '';
  hidePreview();
  hideVoiceStatus();
  try {
    recognition.start();
    // Start initial silence timer — if no speech at all, stop after timeout
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      if (isListening) stopListening();
    }, SILENCE_TIMEOUT + 2000); // Give a bit extra for initial silence
  } catch (e) {
    // Already started — stop and restart
    recognition.stop();
    setTimeout(() => recognition.start(), 200);
  }
}

function stopListening() {
  clearTimeout(silenceTimer);
  if (recognition && isListening) {
    recognition.stop();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  AI PARSING (Cloudflare Workers AI)
// ══════════════════════════════════════════════════════════════════════════════
function buildPrompt(text) {
  const today = todayStr();
  const now = new Date();
  const dayOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()];
  const monthName = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][now.getMonth()];

  const langInfo = VOICE_LANGUAGES.find(l => l.code === selectedLang) || VOICE_LANGUAGES[0];

  return {
    system: `You are a financial assistant for SpendWise, an expense, income, and debt tracking app. Your job is to parse natural language into structured JSON.

Today is ${dayOfWeek}, ${today} (${monthName} ${now.getDate()}, ${now.getFullYear()}).

IMPORTANT: The user may speak in ANY language including ${langInfo.label} (${langInfo.code}). You MUST understand the input regardless of language and always return JSON with field values in English.
Common multilingual amount keywords: "Rs", "₹", "रुपये", "টাকা", "ரூபாய்", "రூபாயలు", etc.
Common date words: "आज/today", "कल/yesterday", "আজ", "இன்று", "నేడు", etc.

RULES:
1. The user may describe ONE or MULTIPLE transactions in a single sentence. You MUST extract ALL of them.
2. For each transaction, determine if it is an EXPENSE, INCOME, or DEBT.
3. Extract the amount, date, and other relevant fields for EACH transaction separately.
4. If no date is mentioned, use today's date: ${today}
5. If the user says "yesterday" (or its equivalent in any language), compute the correct date.
6. For expenses, pick the best matching category from: ${EXPENSE_CATEGORIES.join(', ')}
7. For expenses, pick payment method from: ${PAYMENT_METHODS.join(', ')}. Default to "UPI" if not mentioned.
8. For income, determine source (e.g. "Salary", "Freelance", "Business", etc.), paymentType ("Online" or "Cash"), and bank if mentioned.
9. For debts, determining the type is CRITICAL. You MUST carefully distinguish between:
   
   ➤ "they-owe" (someone OWES the user / user LENT or GAVE money):
     - English: "I lent", "I gave", "they owe me", "I loaned", "I paid for them", "advanced"
     - Hindi: "मैंने दिया", "उसने माँगा", "उसे देना है", "मैंने उधार दिया"
     - Bengali: "আমি দিয়েছি", "ওকে ধার দিয়েছি"
     - Tamil: "நான் கொடுத்தேன்", "அவன் வாங்கினான்"
     - Keywords: LENT, GAVE, LOANED, PAID FOR, ADVANCED, OWES ME
   
   ➤ "i-owe" (user OWES someone / user BORROWED or TOOK money):
     - English: "I borrowed", "I took", "I owe them", "I need to pay back", "got from"
     - Hindi: "मैंने उधार लिया", "मुझे देना है", "मैंने माँगा"
     - Bengali: "আমি ধার নিয়েছি", "আমাকে দিতে হবে"
     - Tamil: "நான் வாங்கினேன்", "எனக்கு தரனும்"
     - Keywords: BORROWED, TOOK, OWE THEM, NEED TO PAY, GOT FROM
   
   IMPORTANT RULES for debt type:
   - "I gave 5000 to John" → they-owe (you gave money, John owes you)
   - "I took 5000 from John" → i-owe (you took money, you owe John)
   - "I lent 5000 to John" → they-owe (you lent money, John owes you)
   - "I borrowed 5000 from John" → i-owe (you borrowed, you owe John)
   - "Paid 500 for friend's ticket" → they-owe (you paid for someone, they owe you)
   - "Got 1000 from mom" → i-owe (you received money, you owe mom)
10. Return ONLY valid JSON, no markdown, no explanation.
11. All JSON field values MUST be in English, regardless of input language.
12. ALWAYS return a JSON ARRAY (even for a single transaction).

For EXPENSE entries, each element:
{"type":"expense","amount":<number>,"category":"<category>","date":"YYYY-MM-DD","description":"<short description in English>","payment":"<payment method>","cardName":"","notes":""}

For INCOME entries, each element:
{"type":"income","amount":<number>,"source":"<source in English>","date":"YYYY-MM-DD","paymentType":"<Online|Cash>","bank":"<bank name or empty>","notes":""}

For DEBT entries, each element:
{"type":"debt","amount":<number>,"debtType":"<they-owe|i-owe>","person":"<person name>","date":"YYYY-MM-DD","notes":"<optional notes>"}

Example input: "today I spent 30 rs on breakfast and 100 on lunch. I also bought a fan from Amazon using credit card for 2000 rs"
Example output: [{"type":"expense","amount":30,"category":"Food & Dining","date":"${today}","description":"Breakfast","payment":"UPI","cardName":"","notes":""},{"type":"expense","amount":100,"category":"Food & Dining","date":"${today}","description":"Lunch","payment":"UPI","cardName":"","notes":""},{"type":"expense","amount":2000,"category":"Shopping","date":"${today}","description":"Fan from Amazon","payment":"Credit Card","cardName":"","notes":""}]

Example input: "I lent 5000 to John yesterday"
Example output: [{"type":"debt","amount":5000,"debtType":"they-owe","person":"John","date":"<yesterday's date>","notes":""}]

Example input: "I borrowed 2000 from Mom"
Example output: [{"type":"debt","amount":2000,"debtType":"i-owe","person":"Mom","date":"${today}","notes":""}]

Example input: "I gave 3000 rupees to Ravi for dinner"
Example output: [{"type":"debt","amount":3000,"debtType":"they-owe","person":"Ravi","date":"${today}","notes":"For dinner"}]

Example input: "I took 10000 from my brother"
Example output: [{"type":"debt","amount":10000,"debtType":"i-owe","person":"Brother","date":"${today}","notes":""}]

Example input: "Paid 500 for my friend's movie ticket"
Example output: [{"type":"debt","amount":500,"debtType":"they-owe","person":"Friend","date":"${today}","notes":"Movie ticket"}]`,
    user: text
  };
}

async function callAIModel(text) {
  const prompt = buildPrompt(text);
  const response = await callAI({
    model: AI_MODEL,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user }
    ],
    max_tokens: 1500,
    temperature: 0.1,
    top_p: 0.95
  });

  if (response.status === 429) {
    throw new Error('RATE_LIMITED');
  }
  if (response.status === 503) {
    throw new Error('MODEL_LOADING');
  }
  if (!response.ok) {
    const errBody = await response.text();
    console.error('AI API error:', response.status, errBody);
    throw new Error('API_ERROR');
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('EMPTY_RESPONSE');

  // Extract JSON from the response (model might wrap it in ```json blocks)
  let jsonStr = content.trim();
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonStr = jsonMatch[1].trim();
  // Try to find a JSON array first, then fall back to object
  const arrMatch = jsonStr.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    jsonStr = arrMatch[0];
  } else {
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objMatch) jsonStr = objMatch[0];
  }

  const parsed = JSON.parse(jsonStr);
  // Normalize: always return an array
  return Array.isArray(parsed) ? parsed : [parsed];
}

// AI output is untrusted text: keep it a string and within the form fields' limits
const clip = (v, max) => String(v ?? '').trim().slice(0, max);

function validateSingleEntry(data) {
  if (!data || typeof data !== 'object') return null;
  if (!data.type || !['expense', 'income', 'debt'].includes(data.type)) return null;
  if (!data.amount || isNaN(parseFloat(data.amount)) || parseFloat(data.amount) <= 0) return null;

  // Normalize amount
  data.amount = parseFloat(data.amount);

  // Validate date
  if (!data.date || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
    data.date = todayStr();
  }

  if (data.type === 'expense') {
    // Validate category (the AI may still use an older name such as "Rent" or "Subscription")
    data.category = normalizeCategory(data.category);
    if (!EXPENSE_CATEGORIES.includes(data.category)) {
      // Try fuzzy match
      const lower = (data.category || '').toLowerCase();
      const match = EXPENSE_CATEGORIES.find(c => c.toLowerCase().includes(lower) || lower.includes(c.toLowerCase()));
      data.category = match || 'Other';
    }
    // Validate payment
    if (!PAYMENT_METHODS.includes(data.payment)) {
      data.payment = 'UPI';
    }
    data.description = clip(data.description, 100) || '-';
    data.cardName = clip(data.cardName, 100);
    data.notes = clip(data.notes, 500);
  } else if (data.type === 'income') {
    // Income
    data.source = clip(data.source, 100) || 'Other';
    data.paymentType = INCOME_PAYMENT_TYPES.includes(data.paymentType) ? data.paymentType : 'Online';
    data.bank = clip(data.bank, 100);
    data.notes = clip(data.notes, 500);
  } else {
    // Debt
    data.debtType = DEBT_TYPES.includes(data.debtType) ? data.debtType : 'they-owe';
    data.person = clip(data.person, 100);
    data.notes = clip(data.notes, 500);
  }

  return data;
}

function validateEntries(dataArray) {
  if (!Array.isArray(dataArray)) dataArray = [dataArray];
  return dataArray.map(d => validateSingleEntry(d)).filter(Boolean);
}

async function parseVoiceCommand(text) {
  if (!text.trim()) return;
  if (offline()) {
    showVoiceStatus(OFFLINE_AI_MSG, 'error');
    return;
  }

  showVoiceStatus('AI is analyzing your command…', 'loading');
  showParsingSpinner(true);

  try {
    const rawEntries = await callAIModel(text);
    const validEntries = validateEntries(rawEntries);

    if (!validEntries.length) {
      showVoiceStatus('Could not understand the command. Please try rephrasing.', 'error');
      showParsingSpinner(false);
      return;
    }

    parsedData = validEntries;
    showPreview(validEntries);
    const count = validEntries.length;
    showVoiceStatus(
      count === 1
        ? 'Check it and fix anything that\'s off, then save.'
        : `Found ${count} entries. Check them and fix anything that's off, then save.`,
      'success'
    );
    showParsingSpinner(false);
  } catch (err) {
    showParsingSpinner(false);
    if (err.message === 'RATE_LIMITED') {
      showVoiceStatus('Daily AI limit reached. Please try again later.', 'error');
    } else if (err.message === 'MODEL_LOADING') {
      showVoiceStatus('AI model is loading. Please try again in 20-30 seconds.', 'error');
    } else {
      console.error('Parse error:', err);
      showVoiceStatus('Failed to parse command. Please try again or rephrase.', 'error');
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  SAVE TO FIRESTORE
// ══════════════════════════════════════════════════════════════════════════════
// The Firestore document for one reviewed entry (same fields as the Add forms)
function toDocData(entry) {
  const base = { uid: currentUser.uid, amount: entry.amount, date: entry.date, encoding: 'plain', createdAt: serverTimestamp() };
  if (entry.type === 'expense') {
    return ['expenses', 'expense', { ...base, category: entry.category, payment: entry.payment, cardName: entry.cardName || '',
      description: entry.description || '-', notes: entry.notes || '' }];
  }
  if (entry.type === 'income') {
    return ['income', 'income', { ...base, source: entry.source, paymentType: entry.paymentType, bank: entry.bank || '', notes: entry.notes || '' }];
  }
  return ['debts', 'debt', { ...base, type: entry.debtType, person: entry.person, notes: entry.notes || '', settled: false, settledDate: '' }];
}

// Checks the reviewed entries; marks the first bad field and returns a message, or '' when all are fine
function reviewProblem() {
  for (let i = 0; i < parsedData.length; i++) {
    const e = parsedData[i];
    let field = null, msg = '';
    if (!(e.amount > 0)) { field = 'amount'; msg = 'Enter an amount above zero.'; }
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) { field = 'date'; msg = 'Pick a date.'; }
    else if (e.type === 'debt' && !e.person) { field = 'person'; msg = 'Add who the debt is with.'; }
    if (field) {
      const input = document.querySelector(`.vp-card[data-idx="${i}"] [data-field="${field}"]`);
      if (input) { input.setAttribute('aria-invalid', 'true'); input.focus(); }
      return parsedData.length > 1 ? `Entry ${i + 1}: ${msg}` : msg;
    }
  }
  return '';
}

async function saveEntry() {
  if (!parsedData || !parsedData.length || !currentUser) return;
  const problem = reviewProblem();
  if (problem) { showVoiceStatus(problem, 'error'); return; }

  const btn = document.getElementById('voice-confirm-btn');
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="loader-2" class="voice-spin"></i> Saving…';
  if (window.lucide) lucide.createIcons();

  const docs = parsedData.map(toDocData);
  const count = docs.length;
  const total = parsedData.reduce((sum, e) => sum + e.amount, 0);
  const what = count === 1 ? `${fmt(total)} saved` : `${count} entries saved · ${fmt(total)}`;

  // Offline: hand them to the app's queue, which writes them when the connection is back
  const queueAll = () => {
    if (typeof window.addToOfflineQueue !== 'function') return false;
    docs.forEach(([, type, data]) => window.addToOfflineQueue(type, data));
    return true;
  };
  const finish = (statusMsg, toastMsg, reload) => {
    showVoiceStatus(statusMsg, 'success');
    window.markLoggedToday?.(); // skips today's reminder (reminders.js)
    showPageToast(toastMsg, 'success');
    setTimeout(() => {
      closeVoiceModal();
      if (reload) window.location.reload();
    }, 1200);
  };

  if (offline() && queueAll()) {
    finish(`You're offline: ${what} on this device. They sync when you're back online.`, 'Saved offline. Will sync when online.', false);
    return;
  }

  try {
    // One batch: all entries save or none do, so a retry after a failure can't make duplicates
    const batch = writeBatch(db);
    docs.forEach(([coll, , data]) => batch.set(doc(collection(db, coll)), data));
    await batch.commit();
    finish(`${what}!`, count === 1 ? 'Entry added by voice.' : `${count} entries added by voice.`, true);
  } catch (err) {
    console.error('Save error:', err);
    if (!navigator.onLine && queueAll()) {
      finish(`Connection lost: ${what} on this device. They sync when you're back online.`, 'Saved offline. Will sync when online.', false);
      return;
    }
    showVoiceStatus('Couldn\'t save. Nothing was saved, so it\'s safe to try again.', 'error');
    btn.disabled = false;
    updateSaveButton();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  UI CONTROLLER
// ══════════════════════════════════════════════════════════════════════════════
function openVoiceModal() {
  const modal = document.getElementById('voice-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  // Reset state
  document.getElementById('voice-transcript').textContent = 'Tap the mic or type your command';
  document.getElementById('voice-transcript').classList.remove('interim');
  document.getElementById('voice-text-input').value = '';
  hidePreview();
  hideVoiceStatus();
  parsedData = null;

  // Slight delay for animation
  requestAnimationFrame(() => {
    modal.classList.add('open');
    if (window.lucide) lucide.createIcons();
  });
}

function closeVoiceModal() {
  stopListening();
  const modal = document.getElementById('voice-modal');
  if (!modal) return;
  modal.classList.remove('open');
  setTimeout(() => modal.classList.add('hidden'), 300);
}

function updateRecordingUI(recording) {
  const micBtn = document.getElementById('voice-mic-btn');
  const micIcon = document.getElementById('voice-mic-icon');
  const pulseRings = document.getElementById('voice-pulse-rings');
  if (!micBtn) return;

  const label = document.querySelector('.voice-mic-label');
  if (label && isSpeechSupported()) label.textContent = recording ? 'Listening… tap to stop' : 'Tap to speak';
  micBtn.setAttribute('aria-label', recording ? 'Stop listening' : 'Start speaking');
  micBtn.setAttribute('aria-pressed', String(recording));

  if (recording) {
    micBtn.classList.add('recording');
    if (pulseRings) pulseRings.classList.add('active');
    if (micIcon) micIcon.setAttribute('data-lucide', 'mic-off');
  } else {
    micBtn.classList.remove('recording');
    if (pulseRings) pulseRings.classList.remove('active');
    if (micIcon) micIcon.setAttribute('data-lucide', 'mic');
  }
  if (window.lucide) lucide.createIcons();
}

function showVoiceStatus(msg, type) {
  const el = document.getElementById('voice-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'voice-status voice-status-' + type;
  el.classList.remove('hidden');
}

function hideVoiceStatus() {
  const el = document.getElementById('voice-status');
  if (el) el.classList.add('hidden');
}

function showParsingSpinner(show) {
  const el = document.getElementById('voice-parsing-spinner');
  if (el) el.classList.toggle('hidden', !show);
}

// ── Review: every parsed entry is an editable card ───────────────────────────
const options = (list, current) => list.map(v => `<option value="${escapeHtml(v)}"${v === current ? ' selected' : ''}>${escapeHtml(v)}</option>`).join('');

function entryFields(e) {
  if (e.type === 'expense') {
    return `
      <label class="vp-field"><span>Category</span><select data-field="category">${options(EXPENSE_CATEGORIES, e.category)}</select></label>
      <label class="vp-field"><span>Paid by</span><select data-field="payment">${options(PAYMENT_METHODS, e.payment)}</select></label>
      <label class="vp-field vp-wide"><span>Description</span><input type="text" data-field="description" maxlength="100" value="${escapeHtml(e.description === '-' ? '' : e.description)}" placeholder="What was it for?"></label>`;
  }
  if (e.type === 'income') {
    return `
      <label class="vp-field"><span>Source</span><input type="text" data-field="source" maxlength="100" value="${escapeHtml(e.source)}"></label>
      <label class="vp-field"><span>Received as</span><select data-field="paymentType">${options(INCOME_PAYMENT_TYPES, e.paymentType)}</select></label>`;
  }
  return `
    <label class="vp-field"><span>Person</span><input type="text" data-field="person" maxlength="100" value="${escapeHtml(e.person)}" placeholder="Who?"></label>
    <label class="vp-field"><span>Direction</span><select data-field="debtType">
      <option value="they-owe"${e.debtType === 'they-owe' ? ' selected' : ''}>They owe me</option>
      <option value="i-owe"${e.debtType === 'i-owe' ? ' selected' : ''}>I owe them</option>
    </select></label>
    <label class="vp-field vp-wide"><span>Notes</span><input type="text" data-field="notes" maxlength="500" value="${escapeHtml(e.notes)}" placeholder="Optional"></label>`;
}

const CHECK_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const TYPE_LABEL = { expense: 'Expense', income: 'Income', debt: 'Debt' };
const TYPE_ICON = { expense: 'trending-down', income: 'trending-up', debt: 'hand-coins' };

function showPreview(entries) {
  const preview = document.getElementById('voice-preview');
  if (!preview) return;
  const symbol = escapeHtml(window.getCurrencyInfo?.(window.getCurrency?.())?.symbol || '₹');

  preview.innerHTML = entries.map((e, i) => `
    <div class="vp-card" data-idx="${i}">
      <div class="vp-head">
        <span class="vp-type vp-type-${e.type}"><i data-lucide="${TYPE_ICON[e.type]}"></i>${TYPE_LABEL[e.type]}${entries.length > 1 ? ` ${i + 1}` : ''}</span>
        <button type="button" class="vp-remove" data-remove="${i}" aria-label="Remove ${TYPE_LABEL[e.type].toLowerCase()} ${entries.length > 1 ? i + 1 : ''}" title="Remove"><i data-lucide="x"></i></button>
      </div>
      <div class="vp-grid">
        <label class="vp-field vp-amount"><span>Amount</span><span class="vp-money"><b>${symbol}</b><input type="text" inputmode="decimal" data-field="amount" value="${e.amount}" autocomplete="off"></span></label>
        <label class="vp-field"><span>Date</span><input type="date" data-field="date" value="${escapeHtml(e.date)}"></label>
        ${entryFields(e)}
      </div>
    </div>`).join('');

  preview.classList.remove('hidden');
  document.getElementById('voice-actions').classList.remove('hidden');
  document.querySelector('.voice-examples')?.classList.add('hidden');
  updateSaveButton();
  if (window.lucide) lucide.createIcons();
}

// Edits go straight into parsedData, so Save writes what is on screen
function onPreviewInput(ev) {
  const input = ev.target.closest('[data-field]');
  const card = ev.target.closest('.vp-card');
  if (!input || !card || !parsedData) return;
  const entry = parsedData[+card.dataset.idx];
  if (!entry) return;
  const field = input.dataset.field;
  input.removeAttribute('aria-invalid');
  if (field === 'amount') {
    entry.amount = parseFloat(input.value.replace(/[^\d.]/g, '')) || 0;
    updateSaveButton();
  } else if (field === 'description') {
    entry.description = input.value.trim() || '-';
  } else {
    entry[field] = input.value.trim();
  }
}

function onPreviewClick(ev) {
  const btn = ev.target.closest('[data-remove]');
  if (!btn || !parsedData) return;
  parsedData.splice(+btn.dataset.remove, 1);
  if (!parsedData.length) {
    parsedData = null;
    hidePreview();
    showVoiceStatus('Nothing left to save. Speak or type another command.', 'loading');
    return;
  }
  showPreview(parsedData);
}

function updateSaveButton() {
  const btn = document.getElementById('voice-confirm-btn');
  if (!btn || !parsedData) return;
  const total = parsedData.reduce((s, e) => s + (e.amount > 0 ? e.amount : 0), 0);
  const label = parsedData.length === 1 ? `Save · ${fmt(total)}` : `Save ${parsedData.length} · ${fmt(total)}`;
  // Inline icon: lucide.createIcons() here would redraw every icon on the page, including the
  // one under a finger tapping Remove (the amount's change event fires first), and drop that tap
  btn.innerHTML = `${CHECK_SVG} ${escapeHtml(label)}`;
}

function hidePreview() {
  const preview = document.getElementById('voice-preview');
  const actions = document.getElementById('voice-actions');
  if (preview) { preview.classList.add('hidden'); preview.innerHTML = ''; }
  if (actions) actions.classList.add('hidden');
  document.querySelector('.voice-examples')?.classList.remove('hidden');
  // Reset confirm button
  const btn = document.getElementById('voice-confirm-btn');
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = `${CHECK_SVG} Save`;
  }
}

function formatDateShort(ds) {
  return new Date(ds + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function showPageToast(msg, type) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast ' + (type || 'success');
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 3000);
}

// ── Toggle mic (start/stop) ──────────────────────────────────────────────────
function toggleMic() {
  if (isListening) {
    stopListening();
  } else {
    startListening();
  }
}

// ── Manual text submit ───────────────────────────────────────────────────────
// A bank SMS is read on this device (instant, offline, nothing sent); anything else goes to the AI
function handleTextSubmit(text = document.getElementById('voice-text-input')?.value || '') {
  text = text.trim();
  if (!text) {
    showVoiceStatus('Please type or speak a command first.', 'error');
    return;
  }
  document.getElementById('voice-transcript').textContent = text;
  const sms = parseSms(text);
  if (sms) {
    parsedData = validateEntries([sms]);
    showPreview(parsedData);
    showVoiceStatus('Read from your SMS on this device. Check it, fix anything that\'s off, then save.', 'success');
    return;
  }
  parseVoiceCommand(text);
}

// Reads the clipboard directly: a text box would drop the SMS's line breaks
async function pasteSms() {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch { /* blocked or unsupported */ }
  if (!text.trim()) {
    document.getElementById('voice-text-input')?.focus();
    showVoiceStatus('Copy a bank SMS first, or paste it into the box below.', 'loading');
    return;
  }
  handleTextSubmit(text);
}

// ── Language picker ──────────────────────────────────────────────────────────
// The phone's own <select> sheet can't be styled, so a button opens an in-app
// list instead. The hidden <select> stays the source of truth: picking a
// language sets its value and fires 'change', which the handler above uses.
function initLangPicker(select) {
  const wrap = select.closest('.voice-lang-picker');
  if (!wrap) return;
  select.hidden = true;

  const current = () => VOICE_LANGUAGES.find(l => l.code === select.value) || VOICE_LANGUAGES[0];

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'voice-lang-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');

  const panel = document.createElement('div');
  panel.className = 'voice-lang-panel';
  panel.hidden = true;
  panel.innerHTML = '<p class="voice-lang-panel-title" id="voice-lang-title">Speech language</p>';
  const list = document.createElement('ul');
  list.className = 'voice-lang-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-labelledby', 'voice-lang-title');
  list.tabIndex = -1;

  VOICE_LANGUAGES.forEach(lang => {
    const li = document.createElement('li');
    li.className = 'voice-lang-option';
    li.setAttribute('role', 'option');
    li.dataset.code = lang.code;
    li.tabIndex = -1;
    li.lang = lang.code;
    li.innerHTML = `<span class="voice-lang-native"></span><span class="voice-lang-name"></span>`;
    li.querySelector('.voice-lang-native').textContent = lang.label;
    li.querySelector('.voice-lang-name').textContent = lang.name === lang.label ? '' : lang.name;
    list.appendChild(li);
  });
  panel.appendChild(list);
  wrap.append(trigger, panel);

  const options = () => [...list.children];
  function render() {
    const lang = current();
    trigger.innerHTML = '<span class="voice-lang-trigger-text"></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
    trigger.querySelector('.voice-lang-trigger-text').textContent = lang.label;
    trigger.setAttribute('aria-label', `Speech language: ${lang.name}`);
    options().forEach(o => o.setAttribute('aria-selected', String(o.dataset.code === lang.code)));
  }
  function open() {
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    (list.querySelector('[aria-selected="true"]') || options()[0]).focus();
  }
  function close(refocus) {
    if (panel.hidden) return;
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (refocus) trigger.focus();
  }
  function choose(code) {
    if (select.value !== code) {
      select.value = code;
      select.dispatchEvent(new Event('change'));
    }
    render();
    close(true);
  }

  trigger.addEventListener('click', () => (panel.hidden ? open() : close(true)));
  list.addEventListener('click', (e) => {
    const opt = e.target.closest('.voice-lang-option');
    if (opt) choose(opt.dataset.code);
  });
  list.addEventListener('keydown', (e) => {
    const all = options();
    const i = all.indexOf(document.activeElement);
    const cols = getComputedStyle(list).gridTemplateColumns.split(' ').length || 1;
    const move = { ArrowDown: cols, ArrowUp: -cols, ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (move) {
      e.preventDefault();
      all[Math.min(all.length - 1, Math.max(0, i + move))].focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      all[e.key === 'Home' ? 0 : all.length - 1].focus();
    } else if ((e.key === 'Enter' || e.key === ' ') && i >= 0) {
      e.preventDefault();
      choose(all[i].dataset.code);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  });
  // Tap or focus anywhere else closes it
  document.addEventListener('pointerdown', (e) => { if (!wrap.contains(e.target)) close(false); });
  wrap.addEventListener('focusout', (e) => { if (e.relatedTarget && !wrap.contains(e.relatedTarget)) close(false); });
  document.getElementById('voice-close-btn')?.addEventListener('click', () => close(false));

  render();
}

// ══════════════════════════════════════════════════════════════════════════════
//  INIT — Wire up events
// ══════════════════════════════════════════════════════════════════════════════
function initVoiceUI() {
  // FAB click
  const fab = document.getElementById('voice-fab');
  if (fab) fab.addEventListener('click', openVoiceModal);

  // Mic button
  const micBtn = document.getElementById('voice-mic-btn');
  if (micBtn) micBtn.addEventListener('click', toggleMic);

  // Close button
  const closeBtn = document.getElementById('voice-close-btn');
  if (closeBtn) closeBtn.addEventListener('click', closeVoiceModal);

  // Overlay close
  const modal = document.getElementById('voice-modal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeVoiceModal();
    });
  }

  // Send text button
  const sendBtn = document.getElementById('voice-send-btn');
  if (sendBtn) sendBtn.addEventListener('click', () => handleTextSubmit());
  document.getElementById('voice-paste-btn')?.addEventListener('click', pasteSms);

  // Enter key on text input
  const textInput = document.getElementById('voice-text-input');
  if (textInput) {
    textInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleTextSubmit();
      }
    });
  }

  // Review cards: edits and removals
  const preview = document.getElementById('voice-preview');
  if (preview) {
    preview.addEventListener('input', onPreviewInput);
    preview.addEventListener('change', onPreviewInput);
    preview.addEventListener('click', onPreviewClick);
  }

  // Example phrases under the transcript
  const transcript = document.getElementById('voice-transcript');
  if (transcript && textInput) {
    const ex = document.createElement('div');
    ex.className = 'voice-examples';
    ex.innerHTML = '<span class="voice-examples-label">Try saying</span>' +
      EXAMPLE_COMMANDS.map(c => `<button type="button" class="voice-example">${escapeHtml(c)}</button>`).join('');
    ex.addEventListener('click', (e) => {
      const b = e.target.closest('.voice-example');
      if (!b) return;
      textInput.value = b.textContent;
      textInput.focus();
    });
    transcript.after(ex);
  }

  // No speech engine (e.g. Firefox): say so up front instead of failing on tap
  if (!isSpeechSupported() && micBtn) {
    micBtn.disabled = true;
    micBtn.setAttribute('aria-label', 'Voice input is not available in this browser');
    const label = document.querySelector('.voice-mic-label');
    if (label) label.textContent = 'Voice isn\'t available in this browser. Type below.';
  }

  // Confirm save
  const confirmBtn = document.getElementById('voice-confirm-btn');
  if (confirmBtn) confirmBtn.addEventListener('click', saveEntry);

  // Cancel
  const cancelBtn = document.getElementById('voice-cancel-btn');
  if (cancelBtn) cancelBtn.addEventListener('click', () => {
    hidePreview();
    hideVoiceStatus();
    parsedData = null;
  });

  // ── Language selector ──────────────────────────────────────────────────────
  const langSelect = document.getElementById('voice-lang-select');
  if (langSelect) {
    // Populate options
    VOICE_LANGUAGES.forEach(lang => {
      const opt = document.createElement('option');
      opt.value = lang.code;
      opt.textContent = `${lang.flag} ${lang.label}`;
      langSelect.appendChild(opt);
    });
    // Set saved value
    langSelect.value = selectedLang;
    // Listen for changes
    langSelect.addEventListener('change', (e) => {
      selectedLang = e.target.value;
      localStorage.setItem('voiceLang', selectedLang);
      // Re-create recognition with new language
      if (recognition) {
        recognition.abort();
        recognition = null;
      }
      recognition = initSpeechRecognition();
    });
    initLangPicker(langSelect);
  }

  // Hide FAB initially (shown when auth resolves)
  if (fab) fab.style.display = 'none';
}

// ══════════════════════════════════════════════════════════════════════════════
//  EXPOSE FUNCTIONS TO WINDOW (for event-delegation.js)
// ══════════════════════════════════════════════════════════════════════════════
window.openVoiceModal = openVoiceModal;
window.closeVoiceModal = closeVoiceModal;
window.startVoiceRecording = startListening;
window.sendVoiceCommand = handleTextSubmit;
window.cancelVoice = () => {
  hidePreview();
  hideVoiceStatus();
  parsedData = null;
};
window.confirmVoice = saveEntry;

// ── DOM-ready dispatcher ─────────────────────────────────────────────────────
// Module scripts with top-level await can miss DOMContentLoaded. Handle both cases.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initVoiceUI);
} else {
  // DOM already parsed — run immediately
  initVoiceUI();
}
