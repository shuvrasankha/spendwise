-- Daily reminder subscriptions. Apply with:
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
