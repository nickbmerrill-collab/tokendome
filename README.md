# ⚡ THE TOKENDOME

**Live at [tokendome.vercel.app](https://tokendome.vercel.app)** — *two devs enter, one leaderboard leaves.*

A competitive leaderboard for LLM token usage. Model-agnostic (OpenAI, Anthropic, Google, Ollama, anything OpenAI-compat), proxy- or SDK-verified, no manual input. Your prompts never leave your machine.

---

## Two ways in

Pick whichever your stack supports. Both report the same thing.

### A. Drop-in SDK shim (fastest if you're on Node + Anthropic or OpenAI)

Change one import line:

```ts
// before
import Anthropic from '@anthropic-ai/sdk';
// after
import Anthropic from '@tokendome/anthropic';
```

```bash
npm i https://tokendome.vercel.app/tokendome-anthropic.tgz
export TOKENDOME_TOKEN=<your-token>   # grab at https://tokendome.vercel.app
```

OpenAI symmetric:

```bash
npm i https://tokendome.vercel.app/tokendome-openai.tgz
```

```ts
import OpenAI from '@tokendome/openai';
```

The shim re-exports the official SDK and wraps `messages.create` / `chat.completions.create` / `responses.create` (incl. streaming) to tee `usage` to the leaderboard. Auto-injects `stream_options.include_usage: true` on OpenAI streams. If `TOKENDOME_TOKEN` isn't set, the shim is a silent no-op — your app behaves exactly as if you'd imported the official SDK.

### B. Local CLI proxy (any provider, any language, any local model)

```bash
curl -fsSL https://tokendome.vercel.app/install.sh | bash
export PATH="$HOME/.tokendome:$PATH"
tokendome login <your-token> https://tokendome.vercel.app
tokendome start

# point your tools at it
export OPENAI_BASE_URL=http://localhost:4000/v1
export ANTHROPIC_BASE_URL=http://localhost:4000
export OLLAMA_HOST=http://localhost:4000
```

The agent forwards requests verbatim, reads `usage` (or `eval_count` for Ollama) off the response, batches events every 3 seconds, and HMAC-signs each batch with your agent token. Works for any language because it's a transparent HTTP proxy.

---

## Why you can trust the numbers

```
your app  ──►  localhost or SDK shim  ──►  upstream provider
                       │
                       └── reads `usage` from provider response
                       └── reports {ts, model, input_tokens, output_tokens}
                           HMAC-signed with your agent token
                           (prompt/response bodies NEVER leave your machine)
```

- **Accurate at the source.** We never re-tokenize. The agent and SDK shims read the provider's own `usage` field — the same numbers you're billed on. The Anthropic/OpenAI Admin-API backfill goes one step further and pulls directly from the provider's billing record.
- **Safe.** API keys pass through directly to the upstream. Prompts and completions never reach the Tokendome server. Only counts.
- **Tamper-evident, not cheat-proof.** Every event is `HMAC-SHA256(agent_token, ts.sha256(body))`. Stale (> 60s drift), unsigned, replayed (same `ts.body_hash` reused), and oversized events are rejected. *But:* a user with their own valid agent token can still hand-craft `/api/ingest` payloads with whatever numbers they want — the leaderboard is honor-system at the user level. The Admin-API import path is the only one anchored to billing data the user can't fabricate.
- **Open source.** This repo. Read [`agent/src/tokendome.ts`](agent/src/tokendome.ts) — the function that builds the event payload is ~30 lines.

Full diagram + wire format at [tokendome.vercel.app/how-it-works.html](https://tokendome.vercel.app/how-it-works.html).

---

## Categories

- 🔥 **Scoreboard** — all-time token count
- 📈 **This Week** — rolling 7-day window
- ⚡ **Velocity** — tokens/hour during active hours (filters out idle scripts)
- 💸 **Efficiency** — output ÷ input ratio (1k input min, no cheap wins)
- 🏠 **Local Hero** — most tokens on local models (Ollama / llama.cpp)
- 🤖 **By Provider** — OpenAI / Anthropic / Google / Ollama leaderboards

Click any combatant to open a profile drawer with their lifetime number, per-category ranks, 30-day stacked-by-provider chart, top models, and a 140-char trash-talk box (30-min TTL).

## Privacy controls

In **Settings** (cog in the header):

- **Display name** — pick any pseudonym; your GitHub login + photo are then hidden everywhere publicly. Avatar swapped for a deterministic identicon.
- **Ghost mode** — usage still tracked privately, but you don't appear on any public surface.

## Domes — friend-group leaderboards

Public leaderboard not your style? Create a dome and share the invite link:

```
https://tokendome.vercel.app/?dome=<slug>&invite=<code>
```

Anyone who clicks it after signing in joins automatically. Your dome's leaderboard is scoped to its members; ingest is unaffected. Toggle between Global and your domes from the header dropdown.

## Anti-cheat

Honor-system at the user level, with a few real teeth:

- Open source agent + SDK; you can audit exactly what's sent
- HMAC-signed events, server rejects stale (> 60s drift), unsigned, or replayed (`(user, ts, body_hash)` is unique inside the drift window)
- Body size cap (512 KB) on raw ingest; per-batch cap of 500 events; per-event cap of 2M input + 2M output tokens — over the cap is rejected (HTTP 413), not clamped
- Per-(user, provider, source) lock on Admin-API and CSV imports — concurrent re-imports can't double-count
- Anthropic / OpenAI Admin-API backfill pulls from the provider's billing record and is provider-scoped + idempotent on (user, provider, source)
- *Planned:* remote-attestation challenge (server pings agent with nonce, agent must echo back in 2s) — until then, anyone with their own valid agent token can post arbitrary numbers, so treat ranks as competitive but not adversarial.

---

## Repo layout

```
api/                Vercel serverless functions
  auth/             GitHub OAuth flow
  ingest.ts         HMAC-verified event ingest
  leaderboard.ts    Categories, sparklines, trash-talk pivot, dome scope
  profile/[login]   Per-user drawer data
  domes/            Create + join + list
  import/           Anthropic + OpenAI Admin API backfill
  trash-talk.ts     140-char bubble write
  me.ts             Session + display_name + ghost mode
agent/              Local proxy CLI (TypeScript)
sdks/
  anthropic/        @tokendome/anthropic — drop-in for @anthropic-ai/sdk
  openai/           @tokendome/openai — drop-in for openai
public/             Static frontend
  index.html        SPA leaderboard
  how-it-works.html Diagram + claims + wire format
  tokendome.js      Bundled agent (built from agent/src/tokendome.ts)
  *.tgz             Bundled SDKs (built from sdks/)
lib/
  pricing.ts        Per-model USD prices, kept in sync with provider
  shared.ts         DB client, sessions, HMAC, identicon helpers
schema.sql          Neon Postgres schema
```

## Self-host (operator quick start)

```bash
# 1. Build the agent + SDK tarballs so they ship with the deployment
cd agent           && npm install && npm run build && cd ..
cd sdks/anthropic  && npm install && npm run build && npm pack && cp tokendome-anthropic-0.1.0.tgz ../../public/tokendome-anthropic.tgz && cd ../..
cd sdks/openai     && npm install && npm run build && npm pack && cp tokendome-openai-0.1.0.tgz ../../public/tokendome-openai.tgz && cd ../..

# 2. Provision Neon Postgres + apply the schema
psql "$DATABASE_URL" -f schema.sql

# 3. Set env vars in Vercel
#    DATABASE_URL          Neon connection string
#    SESSION_SECRET        any 32+ random bytes
#    GITHUB_CLIENT_ID      from your GitHub OAuth app
#    GITHUB_CLIENT_SECRET  from your GitHub OAuth app
vercel deploy --prod
```

GitHub OAuth callback: `https://<your-vercel-domain>/api/auth/callback`.

## License

Apache-2.0. See [LICENSE](LICENSE).
