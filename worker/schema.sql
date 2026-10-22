-- Daily reminder subscriptions and per-user AI usage. Apply with:
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
