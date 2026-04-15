import type { VercelRequest, VercelResponse } from '@vercel/node';
import { publicUrl } from '../lib/shared';

/**
 * GET /install.sh
 *
 * One-liner installer for the local proxy agent. Reads two env vars from
 * the calling shell (so the user can paste a single self-contained line):
 *
 *   TOKENDOME_TOKEN     If set, auto-login the agent with this token.
 *   TOKENDOME_SERVICE   If "1", install + start as a launchd/systemd service.
 *
 * Examples (the dashboard composes these for the signed-in user):
 *   curl -fsSL https://tokendome.vercel.app/install.sh | bash
 *   curl -fsSL https://tokendome.vercel.app/install.sh | TOKENDOME_TOKEN=1.abc bash
 *   curl -fsSL https://tokendome.vercel.app/install.sh | TOKENDOME_TOKEN=1.abc TOKENDOME_SERVICE=1 bash
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const base = publicUrl(req);
  // Use shell-escaping-safe quoting throughout. The script body itself is a
  // template literal in Node — every `$` that should reach the *shell*
  // unevaluated needs to be `\\$` here.
  const script = `#!/usr/bin/env bash
set -euo pipefail
BASE="${base}"
DEST="$HOME/.tokendome"
TOKEN="\${TOKENDOME_TOKEN:-}"
WANT_SERVICE="\${TOKENDOME_SERVICE:-0}"

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

# Auto-login if a token was provided
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
