// ask-data.js — "Ask about your spending" (Insights). A question in plain words becomes a search spec
// ({ type, text, tag, categories, from, to, measure }), the spec runs over the user's own entries on
// the device, and the answer is worked out here. The AI only turns the question into a spec (it is
// sent the question, today's date and the category names, never any entries); guessSpec does the
// same for common questions without the AI.
import { EXPENSE_CATEGORIES, normalizeCategory, isSpending } from '../utils/helpers.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TYPES = ['expense', 'income', 'both'];
const MEASURES = ['total', 'count', 'biggest', 'list'];
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "4 Sep", or "4 Sep 2025" outside the current year (the same as the app's other short dates)
export const dayText = (s, today) => {
  const [y, m, d] = s.split('-').map(Number);
  return `${d} ${SHORT[m - 1]}${String(y) !== today.slice(0, 4) ? ` ${y}` : ''}`;
};
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// The instructions for the AI: reply with one JSON object and nothing else
export function askPrompt(today) {
  const d = new Date(today + 'T00:00:00');
  return `Turn a question about the user's own spending or income into a search. Today is ${d.toLocaleDateString('en-US', { weekday: 'long' })}, ${today}.
Reply with one JSON object only, no other text:
{"type":"expense"|"income"|"both","text":string|null,"tag":string|null,"categories":[string],"from":"YYYY-MM-DD"|null,"to":"YYYY-MM-DD"|null,"measure":"total"|"count"|"biggest"|"list"}
- text: a shop, brand, person or word to look for in the entries (like "amazon", "swiggy", "netflix"), lowercase; null if none.
- tag: a #tag without the "#", if the question names one; else null.
- categories: only from this list, and only if the question names a kind of spending: ${EXPENSE_CATEGORIES.join(', ')}. Else [].
- from/to: the dates the question means, both inclusive ("last month" is the whole previous calendar month, "this month" runs to today, a month name means its most recent past occurrence). null for all time.
- measure: "count" for how many, "biggest" for the largest one, "list" to show them, else "total".
- type: "income" for money received (salary, freelance, refunds), "both" if it asks about both, else "expense".`;
}

// The AI's reply as a clean spec, or null when it isn't one. Anything unknown is dropped.
export function readSpec(raw) {
  let o;
  try { o = JSON.parse(String(raw).slice(String(raw).indexOf('{'), String(raw).lastIndexOf('}') + 1)); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const str = v => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase().slice(0, 60) : null);
  let from = DATE.test(o.from) ? o.from : null, to = DATE.test(o.to) ? o.to : null;
  if (from && to && from > to) [from, to] = [to, from];
  const known = new Set(EXPENSE_CATEGORIES);
  return {
    type: TYPES.includes(o.type) ? o.type : 'expense',
    text: str(o.text),
    tag: str(o.tag)?.replace(/^#/, '') || null,
    categories: Array.isArray(o.categories) ? [...new Set(o.categories.map(normalizeCategory).filter(c => known.has(c)))] : [],
    from, to,
    measure: MEASURES.includes(o.measure) ? o.measure : 'total',
  };
}

// Words that name a category ("food" → Food & Dining)
const CATEGORY_WORDS = [
  [/\b(food|dining|restaurants?|eating out|lunch|dinner|breakfast|swiggy|zomato)\b/, 'Food & Dining'],
  [/\b(groceries|grocery|vegetables|kirana|blinkit|zepto|bigbasket)\b/, 'Groceries'],
  [/\b(transport|petrol|fuel|diesel|cabs?|uber|ola|auto|metro|parking)\b/, 'Transport'],
  [/\b(travel|trips?|flights?|hotels?|trains?)\b/, 'Travel'],
  [/\b(shopping|clothes)\b/, 'Shopping'],
  [/\b(bills?|utilities|electricity|recharge|broadband|wifi)\b/, 'Bills & Utilities'],
  [/\b(rent|home)\b/, 'Home & Rent'],
  [/\b(health|medicines?|doctor|pharmacy|gym)\b/, 'Health'],
  [/\b(entertainment|movies?)\b/, 'Entertainment'],
  [/\b(education|courses?|books?|fees)\b/, 'Education'],
  [/\b(invest|investments?|invested|sips?|savings)\b/, 'Savings & Investments'],
];
// Brands that also name a category: searched as text, which is narrower
const BRANDS = /\b(swiggy|zomato|blinkit|zepto|bigbasket|uber|ola)\b/;
const STOP = new Set(('how much many what was were is are did do does i me my we our you on in at for from to of the a an all ' +
  'spend spent send sent spending pay paid cost costs total sum show list tell expense expenses money rupees rs ' +
  'this last past previous so far till until today yesterday week weeks month months year years day days ' +
  'biggest largest most expensive count number times income earn earned earning received get got salary ' +
  'order ordered orders buy bought purchase purchased purchases use used go went have had give gave put').split(' '));

// [from, to] for the time a question names, or [null, null]
function datesIn(q, today) {
  const t = new Date(today + 'T00:00:00');
  const y = t.getFullYear(), m = t.getMonth();
  const day = (yy, mm, dd) => ymd(new Date(yy, mm, dd));
  if (/\btoday\b/.test(q)) return [today, today];
  if (/\byesterday\b/.test(q)) { const d = day(y, m, t.getDate() - 1); return [d, d]; }
  const mon = new Date(y, m, t.getDate() - ((t.getDay() + 6) % 7)); // this Monday
  if (/\bthis week\b/.test(q)) return [ymd(mon), today];
  if (/\b(last|previous|past) week\b/.test(q)) return [day(mon.getFullYear(), mon.getMonth(), mon.getDate() - 7), day(mon.getFullYear(), mon.getMonth(), mon.getDate() - 1)];
  const lastN = q.match(/\b(?:last|past) (\d{1,3}) days\b/);
  if (lastN) return [day(y, m, t.getDate() - Number(lastN[1]) + 1), today];
  if (/\bthis month\b/.test(q)) return [day(y, m, 1), today];
  if (/\b(last|previous|past) month\b/.test(q)) return [day(y, m - 1, 1), day(y, m, 0)];
  if (/\bthis year\b/.test(q)) return [day(y, 0, 1), today];
  if (/\b(last|previous|past) year\b/.test(q)) return [day(y - 1, 0, 1), day(y - 1, 11, 31)];
  const year = q.match(/\b(20\d{2})\b/);
  const month = MONTHS.findIndex(name => new RegExp(`\\b(${name}|${name.slice(0, 3)})\\b`).test(q));
  if (month >= 0) {
    const yy = year ? Number(year[1]) : month <= m ? y : y - 1; // the most recent past one
    return [day(yy, month, 1), yy === y && month === m ? today : day(yy, month + 1, 0)];
  }
  if (year) return [`${year[1]}-01-01`, `${year[1]}-12-31`];
  return [null, null];
}

// A spec for common questions, worked out without the AI
export function guessSpec(question, today) {
  const q = ` ${String(question).toLowerCase()} `;
  const [from, to] = datesIn(q, today);
  const tag = (q.match(/#([\p{L}\p{N}_-]+)/u) || [])[1] || null;
  const type = /\b(income|earn|earned|earning|received|got paid|salary|freelanc\w*)\b/.test(q) ? 'income' : 'expense';
  const measure = /\b(how many|count|number of|times)\b/.test(q) ? 'count'
    : /\b(biggest|largest|most expensive|highest)\b/.test(q) ? 'biggest'
    : /\b(show|list)\b/.test(q) ? 'list' : 'total';
  const brand = (q.match(BRANDS) || [])[1] || null;
  const categories = type === 'expense' && !brand && !tag ? [...new Set(CATEGORY_WORDS.filter(([re]) => re.test(q)).map(([, c]) => c))] : [];
  // What's left after the known words: a shop or a word to look for
  let rest = q.replace(/#[\p{L}\p{N}_-]+/gu, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
    .filter(w => w && !STOP.has(w) && !/^\d+$/.test(w) && !MONTHS.some(n => w === n || w === n.slice(0, 3)));
  if (categories.length) rest = rest.filter(w => !CATEGORY_WORDS.some(([re]) => re.test(` ${w} `)));
  const text = brand || (rest.length ? rest.join(' ') : null);
  return { type, text: type === 'income' && !text && /\bsalary\b/.test(q) ? 'salary' : text, tag, categories, from, to, measure };
}

// The entries a spec picks, newest first, with the total, count and biggest
export function runQuery(spec, { expenses = [], income = [] }) {
  const inDates = r => (!spec.from || r.date >= spec.from) && (!spec.to || r.date <= spec.to);
  const has = (fields, needle) => fields.some(f => f && String(f).toLowerCase().includes(needle));
  const wantInvest = spec.categories.includes('Savings & Investments');
  const rows = [];
  if (spec.type !== 'income') {
    for (const e of expenses) {
      if (!inDates(e) || (!wantInvest && !isSpending(e))) continue;
      if (spec.categories.length && !spec.categories.includes(normalizeCategory(e.category))) continue;
      const tags = (e.tags || []).map(t => String(t).toLowerCase());
      if (spec.tag && !tags.includes(spec.tag)) continue;
      if (spec.text && !has([e.description, e.notes, e.cardName, ...tags], spec.text)) continue;
      rows.push({ kind: 'expense', ...e });
    }
  }
  if (spec.type !== 'expense' && !spec.categories.length && !spec.tag) {
    for (const i of income) {
      if (!inDates(i)) continue;
      if (spec.text && !has([i.source, i.notes, i.bank], spec.text)) continue;
      rows.push({ kind: 'income', ...i });
    }
  }
  rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const total = rows.reduce((s, r) => s + (r.kind === 'income' ? 1 : spec.type === 'both' ? -1 : 1) * r.amount, 0);
  const biggest = rows.reduce((a, r) => (!a || r.amount > a.amount ? r : a), null);
  return { rows, total, count: rows.length, biggest };
}

// "in September", "in October 2025", "on 24 Oct", "from 1 Sep to 15 Sep", or "in all"
export function periodText(from, to, today) {
  if (!from && !to) return 'in all your entries';
  const thisYear = today.slice(0, 4);
  const day = s => dayText(s, today);
  if (from && to && from === to) return `on ${day(from)}`;
  if (from && to && from.endsWith('-01-01') && to.endsWith('-12-31') && from.slice(0, 4) === to.slice(0, 4)) return `in ${from.slice(0, 4)}`;
  if (from && to && from.endsWith('-01') && from.slice(0, 7) === to.slice(0, 7)) {
    const [y, m] = from.split('-').map(Number);
    const last = ymd(new Date(y, m, 0));
    if (to === last || to === today) {
      const name = new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', ...(String(y) !== thisYear && { year: 'numeric' }) });
      return to === last ? `in ${name}` : `in ${name} so far`;
    }
  }
  if (from && !to) return `since ${day(from)}`;
  if (!from && to) return `up to ${day(to)}`;
  return `from ${day(from)} to ${day(to)}`;
}

const title = s => s.replace(/\b\p{L}/gu, c => c.toUpperCase());
// What was searched for, in a few words: "Amazon", "#goa2026", "Food & Dining"
export function subjectText(spec) {
  if (spec.tag) return `#${spec.tag}`;
  if (spec.text) return title(spec.text);
  if (spec.categories.length) return spec.categories.join(', ');
  return '';
}

// { headline, sentence } for the answer card
export function answerFor(spec, result, money, today) {
  const what = spec.type === 'income' ? ['income entry', 'income entries'] : spec.type === 'both' ? ['entry', 'entries'] : ['expense', 'expenses'];
  const count = `${result.count} ${result.count === 1 ? what[0] : what[1]}`;
  const subject = subjectText(spec);
  const on = subject ? (spec.type === 'income' ? ` from ${subject}` : ` on ${subject}`) : '';
  const when = periodText(spec.from, spec.to, today);
  if (!result.count) return { headline: spec.measure === 'count' ? '0' : money(0), sentence: `Nothing${on} ${when}.` };
  if (spec.measure === 'count') return { headline: String(result.count), sentence: `${count}${on} ${when}, ${money(Math.abs(result.total))} in all.` };
  if (spec.measure === 'biggest') {
    const b = result.biggest;
    const name = (b.kind === 'income' ? b.source : b.description && b.description !== '-' ? b.description : b.category) || 'Entry';
    return { headline: money(b.amount), sentence: `Biggest${on} ${when}: ${name}, ${dayText(b.date, today)}.` };
  }
  if (spec.type === 'both') return { headline: money(Math.abs(result.total)), sentence: `${result.total >= 0 ? 'More came in than went out' : 'More went out than came in'}${on} ${when} · ${count}.` };
  return { headline: money(result.total), sentence: `${spec.type === 'income' ? 'Received' : 'Spent'}${on} ${when} · ${count}.` };
}
