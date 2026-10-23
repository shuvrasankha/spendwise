-- Daily reminder subscriptions and per-user AI usage. "npm run deploy" applies this first;
-- every statement is IF NOT EXISTS, so it only creates what is missing. By hand:
--   npx wrangler d1 execute spendwise-push --remote --file schema.sql
CREATE TABLE IF NOT EXISTS subscriptions (
  endpoint    TEXT PRIMARY KEY,   -- browser push endpoint (unique per device/browser)
  uid         TEXT NOT NULL,      -- Firebase user id
  remind_at   TEXT NOT NULL,      -- local time 'HH:MM'
  tz          TEXT NOT NULL,      -- IANA time zone, e.g. 'Asia/Kolkata'
  last_logged TEXT,               -- local date 'YYYY-MM-DD' the user last added an entry
  last_sent   TEXT,               -- local date the reminder was last sent
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS subscriptions_uid ON subscriptions (uid);

-- AI requests per user per UTC day (worker/src/index.js takeAiQuota); the cron deletes old days
CREATE TABLE IF NOT EXISTS ai_usage (
  uid TEXT NOT NULL,
  day TEXT NOT NULL,                -- UTC date 'YYYY-MM-DD'
  n   INTEGER NOT NULL,
  PRIMARY KEY (uid, day)
);

-- Message pushes (a bill split with you): a device's encryption keys and the verified email it
-- signed in with, saved alongside its subscription. Deleted with the subscription.
CREATE TABLE IF NOT EXISTS push_keys (
  endpoint TEXT PRIMARY KEY,
  email    TEXT NOT NULL,         -- lowercase, from the verified Firebase token
  p256dh   TEXT NOT NULL,
  auth     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS push_keys_email ON push_keys (email);

-- Each shared debt is pushed at most once; also caps how many one sender can push a day
CREATE TABLE IF NOT EXISTS debt_pushes (
  debt_id TEXT PRIMARY KEY,
  uid     TEXT NOT NULL,          -- sender
  sent_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS debt_pushes_uid ON debt_pushes (uid, sent_at);

-- Bill-due alerts: each repeating expense's next due date, as the app last sent it (/push/bills).
-- The cron pushes "<title> due tomorrow" once per due date, at the user's reminder time.
CREATE TABLE IF NOT EXISTS bills (
  uid         TEXT NOT NULL,
  key         TEXT NOT NULL,      -- series key: category|description
  title       TEXT NOT NULL,
  amount      REAL NOT NULL,
  symbol      TEXT NOT NULL,      -- currency sign, or ''
  due         TEXT NOT NULL,      -- local date 'YYYY-MM-DD'
  alerted_due TEXT,               -- the due date last alerted
  PRIMARY KEY (uid, key)
);

-- Month-end summary: spending per month as the app last sent it (/push/months). On the 1st, at the
-- reminder time, the cron pushes last month's total against the month before.
CREATE TABLE IF NOT EXISTS month_totals (
  uid     TEXT NOT NULL,
  month   TEXT NOT NULL,          -- 'YYYY-MM'
  spent   REAL NOT NULL,
  symbol  TEXT NOT NULL,          -- currency sign, or ''
  alerted INTEGER,                -- 1 once its summary was pushed
  PRIMARY KEY (uid, month)
);
