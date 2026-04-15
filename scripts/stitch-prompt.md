# Google Stitch prompt for Token Arena

Paste this into a new project at https://stitch.withgoogle.com.
Pick **Web** as the target. After generation, export code and drop it into
`server/src/html.ts` replacing the existing HTML template.

---

## App name
Token Arena

## One-liner
A competitive live leaderboard for LLM token usage — model-agnostic (OpenAI,
Anthropic, Google Gemini, Ollama, LM Studio, local models), powered by a local
proxy agent so users can't fake numbers.

## Visual direction
- Arcade-meets-stadium energy. Confident, playful, not cutesy.
- Primary palette: deep arena black (#0B0B10) as canvas, electric yellow
  (#FACC15) for accents and gold-medal glow, emerald (#10B981) for the
  "LIVE" pulse dot, soft off-white (#F8FAFC) for surfaces.
- Type: a bold display face (e.g. Space Grotesk, Satoshi) for headlines and
  leaderboard ranks; a tabular monospace (JetBrains Mono) for token counts so
  numbers align rank-to-rank.
- Density: generous. Scoreboard rows breathe. Big numbers, small labels.
- Motion: rows ease into position when ranks change; the freshly-updated row
  pulses yellow for ~1s. A subtle confetti burst when a user overtakes the
  person above them.

## Screens to generate

### 1. Home / Leaderboard (primary screen, desktop + mobile)

Header
  - Left: "🏟️ Token Arena" wordmark + subtitle "Live leaderboard for LLM
    token burners. Model-agnostic. Proxy-verified."
  - Right: either a "Sign in with GitHub" CTA (dark pill, GitHub logo) OR,
    when signed in, an avatar + username + small "sign out" link.

Live status strip
  - Small pill: green pulsing dot + "LIVE" + latency readout
    ("12 events / min").

Tab bar (pills)
  - 🔥 All time    (default active)
  - 📈 This week
  - 🏠 Local hero
  - ⚡ Velocity (tokens/hour)
  - 💸 Efficiency (output ÷ input)
  - 🤖 By provider

Leaderboard table
  - Columns: rank medal, avatar, username, total tokens (big mono),
    tiny secondary line with "X in · Y out · Z cached".
  - Top 3 rows get gold / silver / bronze borders and a subtle glow.
  - Row hover reveals a "sparkline" of last-24h activity on the right.
  - Current-user row is sticky-highlighted in yellow if signed in.
  - Provider chips next to each row: openai, anthropic, google, ollama,
    with the top-2 providers for that user shown as colored pills.

Empty state
  - Illustration of an empty stadium with a single bored referee; copy:
    "No challengers yet. Be first — install the agent and start burning."

### 2. First-time setup card (shown to newly-signed-in users)

A dismissible card above the leaderboard, yellow-tinted, with three steps:

  1. Install:  `curl -fsSL {ORIGIN}/install.sh | bash`
  2. Login:    `tokenarena login {TOKEN}`  — with a copy button on the token
  3. Point your tools at `http://localhost:4000` — three env-var lines shown
     in a code block with copy buttons (OPENAI_BASE_URL, ANTHROPIC_BASE_URL,
     OLLAMA_HOST).

Show an inline terminal mockup on the right of the card (green prompt,
monospace), with the commands typed out.

### 3. Profile / detail drawer (slides in from right when you click a player)

  - Big number: lifetime tokens.
  - Rank across each category (all-time, this-week, local-hero, etc.).
  - Time-series area chart of last 30 days (stacked by provider).
  - Model breakdown: donut or horizontal bars — what fraction is
    gpt-4o vs. claude-opus vs. llama3:70b etc.
  - "Trash talk" input if it's another player — a small 140-char emote you
    can post that shows as a chat bubble on their row for 30 min.
    (Style the bubble; backend not wired yet.)

### 4. How it works (full page, link from footer)

Three-panel explainer with a diagram:
  - Panel 1 "Your machine" — your app → localhost:4000 (agent)
  - Panel 2 "Provider" — agent → OpenAI / Anthropic / Ollama — arrow labelled
    "forwarded verbatim"
  - Panel 3 "Token Arena" — agent → cloud — arrow labelled "counts only,
    HMAC-signed"
  - Below: three short cards titled "Accurate" (we read the provider's own
    usage field), "Safe" (prompts never leave your machine), "Live"
    (WebSocket push, <1s dashboard update).

### 5. Sign-in screen
  - Huge Token Arena wordmark, single "Sign in with GitHub" button, a line
    of flavor copy: "no email, no password, just your commits and your
    token count."

## Interactions (spec for the generated code)
- Fetch `GET /me` on load → populate header + setup card.
- Fetch `GET /api/leaderboard` → populate active tab.
- Open WebSocket to `/live`. Each message is
    `{ user: {id, login, avatar_url}, delta: {input, output, local}, ts }`.
  On receipt: optimistically bump the user's row, re-sort the active tab,
  add the `flash` class to their row for 1.2s, then debounce a refetch of
  `/api/leaderboard` 1.5s later for authoritative state.
- Tabs change the active dataset but don't re-fetch unless data is stale
  (>30s old).
- Sign in → hit `/auth/github` (redirect).
- Sign out → POST to `/auth/logout`.

## Accessibility
- Color contrast AA in both light and dark mode.
- Leaderboard is a semantic `<ol>`, rows are `<li>` with proper `aria-label`
  combining rank + name + token count.
- The LIVE pulse respects `prefers-reduced-motion`.
- All copy buttons announce "Copied" via `aria-live`.

## Out of scope for v1 (don't design these)
- Admin panel
- Paid tier
- Email notifications

---

After Stitch generates, **export the code as plain HTML/CSS/JS** (not React)
so we can drop it straight into the Worker. Single-file is fine.
