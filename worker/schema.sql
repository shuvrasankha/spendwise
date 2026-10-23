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
