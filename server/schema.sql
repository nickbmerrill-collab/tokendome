-- Users are identified via GitHub OAuth
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  github_id INTEGER UNIQUE NOT NULL,
  login TEXT NOT NULL,
  avatar_url TEXT,
  -- HMAC key the agent uses to sign events. Random 32-byte hex.
  agent_token TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);

-- One row per API call that flowed through the proxy. We store counts only —
-- never prompts, never responses, never tool outputs.
CREATE TABLE IF NOT EXISTS token_events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  ts INTEGER NOT NULL,              -- unix ms
  provider TEXT NOT NULL,           -- 'openai' | 'anthropic' | 'ollama' | 'google' | ...
  model TEXT NOT NULL,              -- 'gpt-4o', 'claude-opus-4-6', 'llama3:70b', ...
  is_local INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  -- optional reasoning/cache tokens where the provider exposes them
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_events_user_ts ON token_events(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_ts ON token_events(ts);

-- OAuth state (CSRF tokens). 10-minute TTL, cleaned on read.
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- Web sessions (cookie-based). 30-day TTL.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Materialized leaderboard totals. Refreshed lazily on ingest.
-- (Small-scale trick: we just recompute top-N on demand and cache in-memory in
-- the Durable Object. This table exists for auditing.)
CREATE TABLE IF NOT EXISTS totals (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  total_input INTEGER NOT NULL DEFAULT 0,
  total_output INTEGER NOT NULL DEFAULT 0,
  local_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
