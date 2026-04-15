import type { VercelRequest, VercelResponse } from '@vercel/node';
import { publicUrl } from '../lib/shared';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const base = publicUrl(req);
  const script = `#!/usr/bin/env bash
set -euo pipefail
BASE="${base}"
DEST="$HOME/.tokendome"
mkdir -p "$DEST"
echo "Downloading agent from $BASE/tokendome.js ..."
curl -fsSL "$BASE/tokendome.js" -o "$DEST/tokendome.js"
cat > "$DEST/tokendome" <<EOF
#!/usr/bin/env bash
exec node "$DEST/tokendome.js" "\\$@"
EOF
chmod +x "$DEST/tokendome"
echo
echo "✓ Installed to $DEST/tokendome"
echo
echo "Add to your shell rc (~/.zshrc or ~/.bashrc):"
echo "    export PATH=\\"$DEST:\\$PATH\\""
echo
echo "Then sign in at $BASE to grab your agent token, and:"
echo "    tokendome login <your-agent-token> $BASE"
echo "    tokendome start"
`;
  res.setHeader('content-type', 'text/x-shellscript; charset=utf-8');
  res.send(script);
}
