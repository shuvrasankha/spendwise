// voice-command.js — SpendWise Voice Command Module
// Uses Web Speech API (speech→text) + Hugging Face Inference API (text→structured data)

import { getApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, addDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// ── Firebase (reuse the app already initialized by app.js / income.js) ───────
// getApp() returns the default Firebase app that was initialized by the main script.
// This ensures we share the same auth state (so we can see the logged-in user).
const app = getApp();
const auth = getAuth(app);
const db = getFirestore(app);

// ══════════════════════════════════════════════════════════════════════════════
//  🔑  HUGGING FACE API TOKEN
//  On GitHub Pages: injected by GitHub Actions (sed replaces the placeholder
//  with the HF_TOKEN repository secret during deploy).
//  Locally: loaded from voice-config.js (gitignored).
//  Get one free at: https://huggingface.co/settings/tokens
// ══════════════════════════════════════════════════════════════════════════════
let HF_TOKEN = '__HF_TOKEN_PLACEHOLDER__';
try {
  const config = await import('./voice-config.js');
  if (config.HF_TOKEN) HF_TOKEN = config.HF_TOKEN;
} catch (_) { /* voice-config.js not present — use embedded token */ }
const HF_MODEL = 'Qwen/Qwen2.5-Coder-32B-Instruct:fastest';
const HF_API_URL = 'https://router.huggingface.co/v1/chat/completions';

// ── Categories (must match the app's category list) ──────────────────────────
const EXPENSE_CATEGORIES = [
  'Food & Dining', 'Transport', 'Shopping', 'Entertainment', 'Health',
  'Bills & Utilities', 'Education', 'Travel', 'Groceries', 'Subscription',
  'Rent', 'Investment', 'Personal Care', 'Gifts', 'Other'
];

const PAYMENT_METHODS = ['UPI', 'Cash', 'Credit Card', 'Debit Card', 'Net Banking', 'Other'];

// ── Supported Languages ──────────────────────────────────────────────────────
const VOICE_LANGUAGES = [
  { code: 'en-IN', label: 'English', flag: '🇬🇧' },
  { code: 'hi-IN', label: 'हिन्दी', flag: '🇮🇳' },
  { code: 'bn-IN', label: 'বাংলা', flag: '🇮🇳' },
  { code: 'ta-IN', label: 'தமிழ்', flag: '🇮🇳' },
  { code: 'te-IN', label: 'తెలుగు', flag: '🇮🇳' },
  { code: 'kn-IN', label: 'ಕನ್ನಡ', flag: '🇮🇳' },
  { code: 'ml-IN', label: 'മലയാളം', flag: '🇮🇳' },
  { code: 'mr-IN', label: 'मराठी', flag: '🇮🇳' },
  { code: 'gu-IN', label: 'ગુજરાતી', flag: '🇮🇳' },
  { code: 'pa-IN', label: 'ਪੰਜਾਬੀ', flag: '🇮🇳' },
  { code: 'or-IN', label: 'ଓଡ଼ିଆ', flag: '🇮🇳' }
];

// ── Helpers ──────────────────────────────────────────────────────────────────
function pad(n) { return String(n).padStart(2, '0'); }
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function fmt(n) {
  return 'Rs ' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

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
    // On income.html, always show FAB when logged in.
    // On index.html, FAB visibility is controlled by showPage() in app.js.
    const isIncomePage = window.location.pathname.includes('income');
    if (!user) {
      fab.style.display = 'none';
    } else if (isIncomePage) {
      fab.style.display = '';
    }
    // On index.html, FAB starts hidden; showPage('add') will reveal it.
  }
});

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
  rec.continuous = true;   // Keep listening until user stops or silence timeout
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

    // Accumulate ALL final results (continuous mode keeps them in e.results)
    let finalTranscript = '';
    let interimTranscript = '';
    for (let i = 0; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalTranscript += t + ' ';
      else interimTranscript += t;
    }

    const transcriptEl = document.getElementById('voice-transcript');
    if (transcriptEl) {
      const display = (finalTranscript + interimTranscript).trim();
      transcriptEl.textContent = display || 'Listening…';
      transcriptEl.classList.toggle('interim', !finalTranscript.trim() && !!interimTranscript);
    }
    if (finalTranscript.trim()) {
      document.getElementById('voice-text-input').value = finalTranscript.trim();
    }
  };

  rec.onerror = (e) => {
    console.error('Speech error:', e.error);
    clearTimeout(silenceTimer);
    isListening = false;
    updateRecordingUI(false);
    if (e.error === 'not-allowed') {
      showVoiceStatus('Microphone access denied. Please allow microphone permission.', 'error');
    } else if (e.error === 'no-speech') {
      showVoiceStatus('No speech detected. Tap the mic and try again.', 'error');
    } else {
      showVoiceStatus('Speech recognition error. Try again or type your command.', 'error');
    }
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

function startListening() {
  if (!recognition) recognition = initSpeechRecognition();
  if (!recognition) {
    showVoiceStatus('Speech recognition not supported in this browser. Use the text input below.', 'error');
    return;
  }
  // Reset UI
  document.getElementById('voice-transcript').textContent = 'Listening… (speak naturally, will auto-stop after pause)';
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
//  AI PARSING (Hugging Face Inference API)
// ══════════════════════════════════════════════════════════════════════════════
function buildPrompt(text) {
  const today = todayStr();
  const now = new Date();
  const dayOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()];
  const monthName = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][now.getMonth()];

  const langInfo = VOICE_LANGUAGES.find(l => l.code === selectedLang) || VOICE_LANGUAGES[0];

  return {
    system: `You are a financial assistant for SpendWise, an expense and income tracking app. Your job is to parse natural language into structured JSON.

Today is ${dayOfWeek}, ${today} (${monthName} ${now.getDate()}, ${now.getFullYear()}).

IMPORTANT: The user may speak in ANY language including ${langInfo.label} (${langInfo.code}). You MUST understand the input regardless of language and always return JSON with field values in English.
Common multilingual amount keywords: "Rs", "₹", "रुपये", "টাকা", "ரூபாய்", "రூபாயలు", etc.
Common date words: "आज/today", "कल/yesterday", "আজ", "இன்று", "నేడు", etc.

RULES:
1. The user may describe ONE or MULTIPLE transactions in a single sentence. You MUST extract ALL of them.
2. For each transaction, determine if it is an EXPENSE or INCOME.
3. Extract the amount, date, and other relevant fields for EACH transaction separately.
4. If no date is mentioned, use today's date: ${today}
5. If the user says "yesterday" (or its equivalent in any language), compute the correct date.
6. For expenses, pick the best matching category from: ${EXPENSE_CATEGORIES.join(', ')}
7. For expenses, pick payment method from: ${PAYMENT_METHODS.join(', ')}. Default to "UPI" if not mentioned.
8. For income, determine source (e.g. "Salary", "Freelance", "Business", etc.), paymentType ("Online" or "Cash"), and bank if mentioned.
9. Return ONLY valid JSON, no markdown, no explanation.
10. All JSON field values MUST be in English, regardless of input language.
11. ALWAYS return a JSON ARRAY (even for a single transaction).

For EXPENSE entries, each element:
{"type":"expense","amount":<number>,"category":"<category>","date":"YYYY-MM-DD","description":"<short description in English>","payment":"<payment method>","cardName":"","notes":""}

For INCOME entries, each element:
{"type":"income","amount":<number>,"source":"<source in English>","date":"YYYY-MM-DD","paymentType":"<Online|Cash>","bank":"<bank name or empty>","notes":""}

Example input: "today I spent 30 rs on breakfast and 100 on lunch. I also bought a fan from Amazon using credit card for 2000 rs"
Example output: [{"type":"expense","amount":30,"category":"Food & Dining","date":"${today}","description":"Breakfast","payment":"UPI","cardName":"","notes":""},{"type":"expense","amount":100,"category":"Food & Dining","date":"${today}","description":"Lunch","payment":"UPI","cardName":"","notes":""},{"type":"expense","amount":2000,"category":"Shopping","date":"${today}","description":"Fan from Amazon","payment":"Credit Card","cardName":"","notes":""}]`,
    user: text
  };
}

async function callHuggingFaceAPI(text) {
  if (!HF_TOKEN || HF_TOKEN.length < 10 || HF_TOKEN.includes('PLACEHOLDER')) {
    throw new Error('HF_TOKEN_NOT_SET');
  }

  const prompt = buildPrompt(text);
  const response = await fetch(HF_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HF_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: HF_MODEL,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user }
      ],
      max_tokens: 1500,
      temperature: 0.1,
      top_p: 0.95
    })
  });

  if (response.status === 429) {
    throw new Error('RATE_LIMITED');
  }
  if (response.status === 503) {
    throw new Error('MODEL_LOADING');
  }
  if (!response.ok) {
    const errBody = await response.text();
    console.error('HF API error:', response.status, errBody);
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

function validateSingleEntry(data) {
  if (!data || typeof data !== 'object') return null;
  if (!data.type || !['expense', 'income'].includes(data.type)) return null;
  if (!data.amount || isNaN(parseFloat(data.amount)) || parseFloat(data.amount) <= 0) return null;

  // Normalize amount
  data.amount = parseFloat(data.amount);

  // Validate date
  if (!data.date || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
    data.date = todayStr();
  }

  if (data.type === 'expense') {
    // Validate category
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
    data.description = data.description || '-';
    data.cardName = data.cardName || '';
    data.notes = data.notes || '';
  } else {
    // Income
    data.source = data.source || 'Other';
    data.paymentType = ['Online', 'Cash'].includes(data.paymentType) ? data.paymentType : 'Online';
    data.bank = data.bank || '';
    data.notes = data.notes || '';
  }

  return data;
}

function validateEntries(dataArray) {
  if (!Array.isArray(dataArray)) dataArray = [dataArray];
  return dataArray.map(d => validateSingleEntry(d)).filter(Boolean);
}

async function parseVoiceCommand(text) {
  if (!text.trim()) return;

  showVoiceStatus('🤖 AI is analyzing your command…', 'loading');
  showParsingSpinner(true);

  try {
    const rawEntries = await callHuggingFaceAPI(text);
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
        ? '✅ Parsed successfully! Review and confirm below.'
        : `✅ ${count} entries parsed! Review and confirm below.`,
      'success'
    );
    showParsingSpinner(false);
  } catch (err) {
    showParsingSpinner(false);
    if (err.message === 'HF_TOKEN_NOT_SET') {
      showVoiceStatus('⚠️ Hugging Face API token not configured. Please set HF_TOKEN in voice-command.js', 'error');
    } else if (err.message === 'RATE_LIMITED') {
      showVoiceStatus('⏳ Rate limited by Hugging Face. Please wait a moment and try again.', 'error');
    } else if (err.message === 'MODEL_LOADING') {
      showVoiceStatus('⏳ AI model is loading. Please try again in 20-30 seconds.', 'error');
    } else {
      console.error('Parse error:', err);
      showVoiceStatus('Failed to parse command. Please try again or rephrase.', 'error');
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  SAVE TO FIRESTORE
// ══════════════════════════════════════════════════════════════════════════════
async function saveEntry() {
  if (!parsedData || !parsedData.length || !currentUser) return;

  const btn = document.getElementById('voice-confirm-btn');
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="loader-2" class="voice-spin"></i> Saving…';
  if (window.lucide) lucide.createIcons();

  try {
    let savedCount = 0;
    for (const entry of parsedData) {
      if (entry.type === 'expense') {
        await addDoc(collection(db, 'expenses'), {
          uid: currentUser.uid,
          amount: entry.amount,
          category: entry.category,
          date: entry.date,
          payment: entry.payment,
          cardName: entry.cardName || '',
          description: entry.description || '-',
          notes: entry.notes || '',
          encoding: 'plain',
          createdAt: serverTimestamp()
        });
      } else {
        await addDoc(collection(db, 'income'), {
          uid: currentUser.uid,
          amount: entry.amount,
          date: entry.date,
          source: entry.source,
          paymentType: entry.paymentType,
          bank: entry.bank || '',
          notes: entry.notes || '',
          encoding: 'plain',
          createdAt: serverTimestamp()
        });
      }
      savedCount++;
    }

    const totalAmount = parsedData.reduce((sum, e) => sum + e.amount, 0);
    const label = savedCount === 1
      ? `🎉 ${parsedData[0].type === 'expense' ? 'Expense' : 'Income'} of ${fmt(totalAmount)} saved!`
      : `🎉 ${savedCount} entries saved! Total: ${fmt(totalAmount)}`;
    showVoiceStatus(label, 'success');

    // Show toast on the page
    showPageToast(
      savedCount === 1 ? 'Entry added via voice!' : `${savedCount} entries added via voice!`,
      'success'
    );

    // Reset after short delay
    setTimeout(() => {
      closeVoiceModal();
      window.location.reload();
    }, 1200);

  } catch (err) {
    console.error('Save error:', err);
    showVoiceStatus('Failed to save. Please try again.', 'error');
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="check-circle"></i> Confirm & Save';
    if (window.lucide) lucide.createIcons();
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

function showPreview(entries) {
  const preview = document.getElementById('voice-preview');
  if (!preview) return;

  let html = '';

  // Show entry count badge for multiple entries
  if (entries.length > 1) {
    const totalAmt = entries.reduce((s, e) => s + e.amount, 0);
    html += `<div class="voice-preview-count">
      <i data-lucide="layers"></i>
      <span>${entries.length} entries detected</span>
      <span class="voice-preview-total">Total: ${fmt(totalAmt)}</span>
    </div>`;
  }

  entries.forEach((data, idx) => {
    if (data.type === 'expense') {
      html += `
        <div class="voice-preview-card">
          <div class="voice-preview-header expense">
            <i data-lucide="trending-down"></i>
            <span>Expense${entries.length > 1 ? ' #' + (idx + 1) : ''}</span>
          </div>
          <div class="voice-preview-grid">
            <div class="voice-preview-field">
              <span class="voice-preview-label">Amount</span>
              <span class="voice-preview-value amount">${fmt(data.amount)}</span>
            </div>
            <div class="voice-preview-field">
              <span class="voice-preview-label">Date</span>
              <span class="voice-preview-value">${formatDateShort(data.date)}</span>
            </div>
            <div class="voice-preview-field">
              <span class="voice-preview-label">Category</span>
              <span class="voice-preview-value">${escapeHtml(data.category)}</span>
            </div>
            <div class="voice-preview-field">
              <span class="voice-preview-label">Payment</span>
              <span class="voice-preview-value">${escapeHtml(data.payment)}</span>
            </div>
            <div class="voice-preview-field full">
              <span class="voice-preview-label">Description</span>
              <span class="voice-preview-value">${escapeHtml(data.description)}</span>
            </div>
          </div>
        </div>`;
    } else {
      html += `
        <div class="voice-preview-card">
          <div class="voice-preview-header income">
            <i data-lucide="trending-up"></i>
            <span>Income${entries.length > 1 ? ' #' + (idx + 1) : ''}</span>
          </div>
          <div class="voice-preview-grid">
            <div class="voice-preview-field">
              <span class="voice-preview-label">Amount</span>
              <span class="voice-preview-value amount income-green">${fmt(data.amount)}</span>
            </div>
            <div class="voice-preview-field">
              <span class="voice-preview-label">Date</span>
              <span class="voice-preview-value">${formatDateShort(data.date)}</span>
            </div>
            <div class="voice-preview-field">
              <span class="voice-preview-label">Source</span>
              <span class="voice-preview-value">${escapeHtml(data.source)}</span>
            </div>
            <div class="voice-preview-field">
              <span class="voice-preview-label">Payment</span>
              <span class="voice-preview-value">${escapeHtml(data.paymentType)}</span>
            </div>
            ${data.bank ? `<div class="voice-preview-field">
              <span class="voice-preview-label">Bank</span>
              <span class="voice-preview-value">${escapeHtml(data.bank)}</span>
            </div>` : ''}
          </div>
        </div>`;
    }
  });

  preview.innerHTML = html;
  preview.classList.remove('hidden');
  document.getElementById('voice-actions').classList.remove('hidden');

  // Update button text for multiple entries
  const btn = document.getElementById('voice-confirm-btn');
  if (btn && entries.length > 1) {
    btn.innerHTML = `<i data-lucide="check-circle"></i> Confirm & Save All (${entries.length})`;
  }

  if (window.lucide) lucide.createIcons();
}

function hidePreview() {
  const preview = document.getElementById('voice-preview');
  const actions = document.getElementById('voice-actions');
  if (preview) preview.classList.add('hidden');
  if (actions) actions.classList.add('hidden');
  // Reset confirm button
  const btn = document.getElementById('voice-confirm-btn');
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="check-circle"></i> Confirm & Save';
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
function handleTextSubmit() {
  const input = document.getElementById('voice-text-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) {
    showVoiceStatus('Please type or speak a command first.', 'error');
    return;
  }
  document.getElementById('voice-transcript').textContent = text;
  parseVoiceCommand(text);
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
  if (sendBtn) sendBtn.addEventListener('click', handleTextSubmit);

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
  }

  // Hide FAB initially (shown when auth resolves)
  if (fab) fab.style.display = 'none';
}

// ── DOM-ready dispatcher ─────────────────────────────────────────────────────
// Module scripts with top-level await can miss DOMContentLoaded. Handle both cases.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initVoiceUI);
} else {
  // DOM already parsed — run immediately
  initVoiceUI();
}
