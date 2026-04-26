import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  db, now, publicUrl, getCurrentUser, checkCsrf,
  randomHex, decryptAgentToken, rateCheck, clientIp,
} from '../lib/shared';

/**
 * /api/install — three roles in one endpoint to stay under the Vercel
 * Hobby 12-function cap.
 *
 *   GET  /install.sh                 → bash one-liner installer
 *   POST /api/install (auth + CSRF) → mint a single-use install code (5m TTL)
 *                                     so the long-lived agent_token never
 *                                     hits the user's shell history.
 *   GET  /api/install?exchange=CODE  → consume the code, return
 *                                     { user_id, agent_token } for install.sh
 *                                     to write into ~/.tokendome/config.json.
 *
 * One-liner shell flow with the new code-exchange path:
 *   curl -fsSL https://tokendome.vercel.app/install.sh \\
 *     | TOKENDOME_INSTALL_CODE=ab12...ef bash
 *
 * Existing TOKENDOME_TOKEN env var path still works for backward compatibility.
 */
const INSTALL_CODE_TTL_MS = 5 * 60 * 1000;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // ─── POST: mint a fresh install code for the signed-in user ─────────────
  if (req.method === 'POST') {
    const csrf = checkCsrf(req); if (csrf) return res.status(csrf.status).json(csrf);
    const me = await getCurrentUser(req);
    if (!me) return res.status(401).json({ error: 'sign in first' });
    const code = randomHex(16);
    await db()`
      INSERT INTO install_codes (code, user_id, created_at)
      VALUES (${code}, ${me.id}, ${now()})
    `;
    return res.json({ code, expires_in_ms: INSTALL_CODE_TTL_MS });
  }

  // ─── GET ?exchange=CODE: redeem an install code for the agent token ─────
  // No auth — possession of the code IS the auth. Single-use, time-limited.
  // Per-IP rate limit so a stolen code can't be exhaustively retried.
  const exchange = String(req.query.exchange || '').trim();
  if (exchange) {
    const rl = await rateCheck(`install-exchange:ip:${clientIp(req)}`, 30, 60_000);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(Math.ceil((rl.retry_after_ms ?? 60_000) / 1000)));
      return res.status(429).json({ error: 'rate limited' });
    }
    if (!/^[0-9a-f]{32}$/.test(exchange)) {
      return res.status(400).json({ error: 'malformed code' });
    }
    const t = now();
    // Atomic claim: only the first caller flips used_at and gets the row.
    // Subsequent attempts see used_at NOT NULL and are rejected.
    const claimed = await db()`
      UPDATE install_codes
      SET used_at = ${t}
      WHERE code = ${exchange}
        AND used_at IS NULL
        AND created_at > ${t - INSTALL_CODE_TTL_MS}
      RETURNING user_id
    `;
    if ((claimed as any[]).length === 0) {
      return res.status(404).json({ error: 'invalid, expired, or already used code' });
    }
    const userId = (claimed as any[])[0].user_id as number;
    const userRow = await db()`SELECT agent_token FROM users WHERE id = ${userId}`;
    if ((userRow as any[]).length === 0) return res.status(404).json({ error: 'user gone' });
    const secret = decryptAgentToken((userRow as any[])[0].agent_token);
    return res.json({ user_id: userId, agent_token: secret });
  }

  // ─── GET (default): serve the bash one-liner installer ──────────────────
  const base = publicUrl(req);
  const script = `#!/usr/bin/env bash
set -euo pipefail
BASE="${base}"
DEST="$HOME/.tokendome"
TOKEN="\${TOKENDOME_TOKEN:-}"
INSTALL_CODE="\${TOKENDOME_INSTALL_CODE:-}"
WANT_SERVICE="\${TOKENDOME_SERVICE:-0}"

# Prefer the short-lived install code over a raw token. The long-lived
# agent token then never appears in shell history or terminal scrollback.
if [ -n "\$INSTALL_CODE" ] && [ -z "\$TOKEN" ]; then
  echo "↻ Exchanging install code for agent token …"
  RESP=\$(curl -fsSL "\$BASE/api/install?exchange=\$INSTALL_CODE") || {
    echo "✘ Install code exchange failed (expired, used, or wrong)" >&2
    exit 1
  }
  TOKEN=\$(printf '%s' "\$RESP" | sed -n 's/.*"user_id":\\([0-9]*\\).*"agent_token":"\\([^"]*\\)".*/\\1.\\2/p')
  if [ -z "\$TOKEN" ]; then
    echo "✘ Could not parse install-code exchange response" >&2
    exit 1
  fi
fi

mkdir -p "$DEST"
echo "↓ Downloading agent from $BASE/tokendome.js …"
curl -fsSL "$BASE/tokendome.js" -o "$DEST/tokendome.js"

cat > "$DEST/tokendome" <<EOF
#!/usr/bin/env bash
exec node "$DEST/tokendome.js" "\\$@"
EOF
chmod +x "$DEST/tokendome"

# Add to PATH in the user's shell rc, idempotently.
add_to_rc() {
  local rc="\$1"
  [ -f "\$rc" ] || return 0
  if ! grep -q '\\.tokendome' "\$rc" 2>/dev/null; then
    {
      echo ''
      echo '# THE TOKENDOME — agent path'
      echo 'export PATH="$HOME/.tokendome:$PATH"'
    } >> "\$rc"
    echo "✓ Added $HOME/.tokendome to PATH in \$rc"
  fi
}
add_to_rc "$HOME/.zshrc"
add_to_rc "$HOME/.bashrc"

export PATH="$DEST:$PATH"

# Auto-login if a token was provided (or just exchanged from an install code)
if [ -n "\$TOKEN" ]; then
  "$DEST/tokendome" login "\$TOKEN" "$BASE" >/dev/null
  echo "✓ Logged in"
fi

# Optionally install as a user service so it auto-starts on login
if [ "\$WANT_SERVICE" = "1" ]; then
  "$DEST/tokendome" service install
else
  echo ""
  echo "Run the proxy in foreground:   $DEST/tokendome start"
  echo "Or install it as a service:    $DEST/tokendome service install"
fi

echo ""
echo "Point your tools at the proxy:"
echo "  export OPENAI_BASE_URL=\\"http://localhost:4000/v1\\""
echo "  export ANTHROPIC_BASE_URL=\\"http://localhost:4000\\""
echo "  export OLLAMA_HOST=\\"http://localhost:4000\\""
echo ""
echo "✓ Done. Open a new shell or \\"source\\" your rc to pick up the PATH update."
`;
  res.setHeader('content-type', 'text/x-shellscript; charset=utf-8');
  res.send(script);
}
