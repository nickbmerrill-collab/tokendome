#!/usr/bin/env bash
# Diagnostic: tests just the tokendome ingest pipeline using your token.
# No SDK in the loop. If this works, your token + network are fine and the
# problem is in how your app is using @tokendome/anthropic.
#
#   curl -fsSL https://tokendome.vercel.app/diag.sh | bash
#
# Reads TOKENDOME_TOKEN from env. Override the server with TOKENDOME_SERVER.
set -euo pipefail
SERVER="${TOKENDOME_SERVER:-https://tokendome.vercel.app}"
TOK="${TOKENDOME_TOKEN:-}"

if [[ -z "$TOK" ]]; then
  echo "✘ TOKENDOME_TOKEN not set in env."
  echo "  Get yours from $SERVER (sign in, copy from setup card),"
  echo "  then re-run as:  TOKENDOME_TOKEN=<your-token> bash <(curl -fsSL $SERVER/diag.sh)"
  exit 1
fi
echo "✓ TOKENDOME_TOKEN is set (${#TOK} chars)"

if [[ "$TOK" != *.* ]]; then
  echo "✘ TOKENDOME_TOKEN is malformed — expected '<id>.<secret>'"
  exit 1
fi
UID_PART="${TOK%%.*}"
SECRET="${TOK#*.}"
echo "  user_id = $UID_PART"
echo "  secret  = ${SECRET:0:8}…(${#SECRET} chars total)"

echo "→ POSTing one synthetic event to $SERVER/api/ingest …"

node -e "
const c = require('crypto');
const tok = process.env.TOKENDOME_TOKEN;
const dot = tok.indexOf('.');
const uid = tok.slice(0, dot);
const secret = tok.slice(dot + 1);
const body = JSON.stringify({events:[{ts:Date.now(),provider:'anthropic',model:'diag-test',is_local:false,input_tokens:1,output_tokens:1}]});
const ts = String(Date.now());
const bh = c.createHash('sha256').update(body).digest('hex');
const sig = c.createHmac('sha256', secret).update(ts+'.'+bh).digest('hex');
fetch('${SERVER}/api/ingest', {method:'POST', headers:{'content-type':'application/json','x-ta-user':uid,'x-ta-ts':ts,'x-ta-sig':sig}, body})
  .then(r => r.text().then(t => { console.log(r.status === 200 ? '✓' : '✘', 'status:', r.status, 'response:', t); process.exit(r.status === 200 ? 0 : 2); }))
  .catch(e => { console.log('✘ network error:', e.message); process.exit(3); });
" TOKENDOME_TOKEN="$TOK"

echo "→ Verifying the synthetic event landed in your totals …"
RESP=$(curl -fsSL "$SERVER/api/leaderboard")
MINE=$(node -e "const r = JSON.parse(process.argv[1]); const me = (r.all_time||[]).find(x => x.login && x.login); console.log(JSON.stringify(r.all_time||[]));" "$RESP")
echo "  leaderboard.all_time: $MINE"
echo
echo "If the POST returned 200 and you see your row in all_time, the ingest pipeline is good."
echo "If your app still doesn't appear after using the SDK, run with TOKENDOME_DEBUG=1 and look for [tokendome] log lines."
