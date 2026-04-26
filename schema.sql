-- Postgres schema for THE TOKENDOME
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  github_id BIGINT UNIQUE NOT NULL,
  login TEXT NOT NULL,        -- GitHub handle, kept for OAuth identity but never displayed if display_name is set
  display_name TEXT,          -- Optional pseudonym shown publicly. NULL → fall back to login.
  hidden BOOLEAN NOT NULL DEFAULT FALSE,  -- Ghost mode: still tracked, never displayed publicly.
  avatar_url TEXT,
  agent_token TEXT UNIQUE NOT NULL,
  created_at BIGINT NOT NULL
);
-- Pseudonym uniqueness, case-insensitive. Application code already checks for
-- collisions, but a race could let two concurrent PATCH /api/me requests both
-- pass the check. The unique index turns that into a clean DB error rather
-- than two users sharing a public handle.
CREATE UNIQUE INDEX IF NOT EXISTS users_display_name_lower_unique
  ON users (lower(display_name)) WHERE display_name IS NOT NULL;

CREATE TABLE IF NOT EXISTS token_events (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  ts BIGINT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  is_local BOOLEAN NOT NULL DEFAULT FALSE,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  -- Approximate USD cost in cents, computed at ingest time.
  cost_cents INTEGER NOT NULL DEFAULT 0,
  -- Provenance: 'agent' (proxy/SDK ingest) vs 'admin_import' (Anthropic Admin API
  -- backfill). Lets us delete-then-reimport without dupes, and lets the UI
  -- show a "verified-by-Anthropic-billing" badge on imported rows.
  source TEXT NOT NULL DEFAULT 'agent'
);
CREATE INDEX IF NOT EXISTS idx_events_user_ts ON token_events(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_ts ON token_events(ts);

-- Private "domes" — friend-group leaderboards. The global leaderboard is just
-- the absence of a dome filter. Membership controls visibility into a dome's
-- scoped scoreboard; ingest is unaffected (counts are still global per user).
CREATE TABLE IF NOT EXISTS domes (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  invite_code TEXT UNIQUE NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS dome_members (
  dome_id BIGINT NOT NULL REFERENCES domes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member',
  joined_at BIGINT NOT NULL,
  PRIMARY KEY (dome_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_dome_members_user ON dome_members(user_id);

-- Per-user email subscription for the weekly digest. Sparse — only users
-- who opted in have a row. The /api/digest cron POSTs to Resend for every
-- row where weekly=TRUE.
CREATE TABLE IF NOT EXISTS email_subscriptions (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  weekly BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL,
  last_sent_at BIGINT
);

-- 140-char trash-talk messages from one combatant to another. Auto-expires
-- after 30 minutes; rendered as a chat bubble on the target's leaderboard row.
CREATE TABLE IF NOT EXISTS trash_talk (
  id BIGSERIAL PRIMARY KEY,
  from_user_id INTEGER NOT NULL REFERENCES users(id),
  to_user_id INTEGER NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trash_talk_to_exp ON trash_talk(to_user_id, expires_at);

CREATE TABLE IF NOT EXISTS totals (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  total_input BIGINT NOT NULL DEFAULT 0,
  total_output BIGINT NOT NULL DEFAULT 0,
  local_tokens BIGINT NOT NULL DEFAULT 0,
  -- Approximate USD cost in cents, computed at ingest time from the
  -- price table in lib/pricing.ts. Historical accuracy is preserved
  -- even if prices later change.
  total_cost_cents BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL
);

-- Replay protection for /api/ingest. The HMAC + 60s drift window bounds the
-- attack surface; this table closes the hole inside the window. Insert-
-- before-accept: a signed (ts, body_hash) tuple per user can only succeed
-- once. Older rows can be GC'd by a sweep — the unique key only matters
-- inside the drift window.
CREATE TABLE IF NOT EXISTS ingest_requests (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts BIGINT NOT NULL,
  body_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, ts, body_hash)
);
CREATE INDEX IF NOT EXISTS idx_ingest_requests_created ON ingest_requests(created_at);

-- Per-(user, provider, source) lock so concurrent admin imports cannot race
-- the "delete prior + insert new + recompute totals" pattern and double-
-- count. Row inserted on import start, deleted on finally; ON CONFLICT DO
-- NOTHING means second concurrent caller bounces (HTTP 409). Stale rows
-- older than the import timeout can be GC'd.
CREATE TABLE IF NOT EXISTS import_locks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, provider, source)
);

-- Fixed-window rate counters keyed by an arbitrary string. Used by the
-- rateCheck helper in lib/shared.ts to throttle ingest, leaderboard,
-- OAuth start, and import endpoints. Old rows with stale window_start
-- can be GC'd; the upsert resets them on next access anyway.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start BIGINT NOT NULL
);

-- One-time install codes. The dashboard generates a code, the user pastes
-- it into a curl one-liner; install.sh exchanges it server-side for the
-- real agent token. Keeps the long-lived agent_token out of shell history,
-- terminal scrollback, and command-telemetry pipelines. Expires in 5 min,
-- single-use (used_at flips on first exchange).
CREATE TABLE IF NOT EXISTS install_codes (
  code TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  used_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_install_codes_user ON install_codes(user_id);

