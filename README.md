# ⚡ THE TOKENDOME

*Two devs enter. One leaderboard leaves.* Competitive leaderboard for LLM token usage. **Model-agnostic** — OpenAI, Anthropic, Gemini, Ollama, LM Studio, llama.cpp, anything with an OpenAI/Anthropic/Ollama-compatible API.

## How it works (why you can trust the numbers)

Most token trackers ask you to paste a number. That's a cheating engine. THE TOKENDOME uses a **local proxy agent**:

```
your app  ──►  localhost:4000 (agent)  ──►  upstream provider
                      │
                      └── reads `usage` from provider response
                      └── reports {model, input_tokens, output_tokens, ts} to cloud
                          (prompt/response bodies NEVER leave your machine)
```

- **Accurate:** we don't re-tokenize. We read the provider's own `usage` field (for local models: Ollama's `eval_count`).
- **Live:** agent streams events to the server over HTTPS; dashboard updates via WebSocket.
- **Safe:** your API keys and prompts stay local. We only see aggregate counts (+ model name).
- **Model-agnostic:** OpenAI-compat, Anthropic native, Ollama native — we speak all three.

## Quick start (player)

```bash
# 1. Sign in at https://tokendome.example.com (GitHub OAuth) — copy your agent token
# 2. Install the agent
curl -fsSL https://tokendome.example.com/install.sh | bash
export PATH="$HOME/.tokendome:$PATH"
tokendome login <your-agent-token> https://tokendome.example.com
tokendome start

# 3. Point your code at the proxy
export OPENAI_BASE_URL=http://localhost:4000/v1
export ANTHROPIC_BASE_URL=http://localhost:4000
export OLLAMA_HOST=http://localhost:4000
```

That's it. Use Claude / OpenAI / Ollama as normal. Your tokens show up on the leaderboard in real time.

## Quick start (you, the operator)

```bash
# 1. Build the agent so it ships with the deployment
cd agent && npm install && npm run build && cd ..

# 2. Provision Neon Postgres, run the schema
psql "$DATABASE_URL" -f schema.sql

# 3. Set env vars in Vercel:
#    DATABASE_URL          (Neon connection string)
#    SESSION_SECRET        (any 32+ random bytes)
#    GITHUB_CLIENT_ID      (from your GitHub OAuth app)
#    GITHUB_CLIENT_SECRET  (from your GitHub OAuth app)
vercel deploy --prod
```

Register a GitHub OAuth app with callback `https://<your-vercel-domain>/api/auth/callback`.

## Repo layout

- `api/`    — Vercel serverless functions (auth, ingest, leaderboard, install)
- `lib/`    — shared helpers (DB client, HMAC, sessions, pricing)
- `public/` — static frontend + the bundled `tokendome.js` agent
- `agent/`  — TypeScript source of the local proxy CLI
- `schema.sql` — Neon Postgres schema

## Categories

- 🔥 **Total burn** — all-time token count
- 📈 **This week** — rolling 7d
- ⚡ **Velocity** — tokens/hour when active
- 💸 **Efficiency** — output/input ratio (higher = model is doing more with less prompt)
- 🏠 **Local hero** — most tokens on local models
- 🤖 **Per-provider** — OpenAI, Anthropic, Ollama kings

## Anti-cheat

For an MVP this runs on the honor system, but:
- Agent binary is open source; we sign releases.
- Server rejects events > 1M tokens/request or > 500 events/minute per user.
- Each event is signed with the user's agent token (HMAC over body).
- Future: remote-attestation challenge — server pings agent with a nonce, agent must echo it back within 2s, otherwise the user's events decay.

