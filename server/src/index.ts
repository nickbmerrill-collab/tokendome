/**
 * Token Arena — Cloudflare Worker
 *
 * Routes:
 *   GET  /                    leaderboard page (HTML)
 *   GET  /install.sh          shell installer for the agent
 *   GET  /auth/github         start GitHub OAuth
 *   GET  /auth/callback       finish GitHub OAuth
 *   POST /auth/logout
 *   GET  /me                  current user + agent token (JSON)
 *   POST /ingest              agent pushes a batch of events (HMAC-signed)
 *   GET  /api/leaderboard     JSON snapshot
 *   GET  /live                WebSocket (Durable Object) for push updates
 */
import { HTML } from './html';

export interface Env {
  DB: D1Database;
  LIVE: DurableObjectNamespace;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  PUBLIC_URL: string;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      if (path === '/' || path === '/index.html') return html(HTML);
      if (path === '/install.sh') return installScript(env);
      if (path === '/auth/github') return startOAuth(env);
      if (path === '/auth/callback') return finishOAuth(req, env);
      if (path === '/auth/logout') return logout(req, env);
      if (path === '/me') return me(req, env);
      if (path === '/ingest') return ingest(req, env, ctx);
      if (path === '/api/leaderboard') return leaderboard(req, env);
      if (path === '/live') return liveWS(req, env);
      return new Response('Not found', { status: 404 });
    } catch (err: any) {
      console.error(err);
      return new Response('Internal error: ' + err.message, { status: 500 });
    }
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

const now = () => Date.now();

function html(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
}
function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function parseCookies(req: Request): Record<string, string> {
  const cookie = req.headers.get('cookie') || '';
  const out: Record<string, string> = {};
  for (const part of cookie.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

async function getSessionUser(req: Request, env: Env): Promise<UserRow | null> {
  const sid = parseCookies(req)['ta_session'];
  if (!sid) return null;
  const row = await env.DB.prepare(
    `SELECT users.* FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.id = ? AND sessions.expires_at > ?`
  ).bind(sid, now()).first<UserRow>();
  return row ?? null;
}

type UserRow = {
  id: number; github_id: number; login: string; avatar_url: string;
  agent_token: string; created_at: number;
};

// ────────────────────────────────────────────────────────────────────────────
// OAuth
// ────────────────────────────────────────────────────────────────────────────

async function startOAuth(env: Env): Promise<Response> {
  const state = randomHex(16);
  await env.DB.prepare('INSERT INTO oauth_states (state, created_at) VALUES (?, ?)')
    .bind(state, now()).run();
  const redirect = `${env.PUBLIC_URL}/auth/callback`;
  const url = `https://github.com/login/oauth/authorize?client_id=${env.GITHUB_CLIENT_ID}`
    + `&redirect_uri=${encodeURIComponent(redirect)}&scope=read:user&state=${state}`;
  return Response.redirect(url, 302);
}

async function finishOAuth(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return new Response('missing code/state', { status: 400 });

  // verify state (single use)
  const st = await env.DB.prepare('SELECT state FROM oauth_states WHERE state = ?')
    .bind(state).first();
  if (!st) return new Response('bad state', { status: 400 });
  await env.DB.prepare('DELETE FROM oauth_states WHERE state = ?').bind(state).run();

  // exchange code for token
  const tokRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${env.PUBLIC_URL}/auth/callback`,
    }),
  });
  const tok = await tokRes.json<{ access_token?: string }>();
  if (!tok.access_token) return new Response('oauth failed', { status: 400 });

  // fetch profile
  const meRes = await fetch('https://api.github.com/user', {
    headers: {
      authorization: `Bearer ${tok.access_token}`,
      'user-agent': 'tokenarena',
      accept: 'application/vnd.github+json',
    },
  });
  const gh = await meRes.json<{ id: number; login: string; avatar_url: string }>();

  // upsert user
  let user = await env.DB.prepare('SELECT * FROM users WHERE github_id = ?')
    .bind(gh.id).first<UserRow>();
  if (!user) {
    const agent_token = randomHex(32);
    await env.DB.prepare(
      `INSERT INTO users (github_id, login, avatar_url, agent_token, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(gh.id, gh.login, gh.avatar_url, agent_token, now()).run();
    user = await env.DB.prepare('SELECT * FROM users WHERE github_id = ?')
      .bind(gh.id).first<UserRow>();
  } else {
    await env.DB.prepare('UPDATE users SET login = ?, avatar_url = ? WHERE id = ?')
      .bind(gh.login, gh.avatar_url, user.id).run();
  }
  if (!user) return new Response('user upsert failed', { status: 500 });

  // create session
  const sid = randomHex(24);
  const expires = now() + 30 * 24 * 60 * 60 * 1000;
  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(sid, user.id, now(), expires).run();

  return new Response(null, {
    status: 302,
    headers: {
      location: '/',
      'set-cookie': `ta_session=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 86400}`,
    },
  });
}

async function logout(req: Request, env: Env): Promise<Response> {
  const sid = parseCookies(req)['ta_session'];
  if (sid) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run();
  return new Response(null, {
    status: 302,
    headers: { location: '/', 'set-cookie': 'ta_session=; Path=/; Max-Age=0' },
  });
}

async function me(req: Request, env: Env): Promise<Response> {
  const u = await getSessionUser(req, env);
  if (!u) return json({ authenticated: false });
  return json({
    authenticated: true,
    login: u.login,
    avatar_url: u.avatar_url,
    // agent_token the user pastes is "<user_id>.<secret>"; the DB holds just the secret.
    agent_token: `${u.id}.${u.agent_token}`,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Ingest: the agent POSTs here
//
// Body: { events: TokenEvent[] }
// Headers:
//   x-ta-user: <user.id>
//   x-ta-ts:   <unix ms, request time>
//   x-ta-sig:  HMAC-SHA256( agent_token, ts + "." + sha256(body) )
// Replay window: 60s.
// ────────────────────────────────────────────────────────────────────────────

type IncomingEvent = {
  ts: number;
  provider: string;
  model: string;
  is_local?: boolean;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
};

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function ingest(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (req.method !== 'POST') return new Response('method', { status: 405 });

  const uid = req.headers.get('x-ta-user');
  const ts = req.headers.get('x-ta-ts');
  const sig = req.headers.get('x-ta-sig');
  if (!uid || !ts || !sig) return new Response('missing headers', { status: 400 });
  if (Math.abs(now() - Number(ts)) > 60_000) return new Response('stale', { status: 400 });

  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?')
    .bind(Number(uid)).first<UserRow>();
  if (!user) return new Response('no user', { status: 401 });

  const body = await req.text();
  const bodyHash = await sha256Hex(body);
  const expected = await hmacSha256Hex(user.agent_token, `${ts}.${bodyHash}`);
  // constant-time-ish compare
  if (expected.length !== sig.length || expected !== sig) {
    return new Response('bad signature', { status: 401 });
  }

  let payload: { events: IncomingEvent[] };
  try { payload = JSON.parse(body); } catch { return new Response('bad json', { status: 400 }); }
  if (!Array.isArray(payload.events)) return new Response('no events', { status: 400 });
  if (payload.events.length === 0) return json({ ok: true, accepted: 0 });
  if (payload.events.length > 500) return new Response('batch too large', { status: 413 });

  // Basic sanity / anti-cheat: cap any single event.
  const MAX_PER_EVENT = 2_000_000; // 2M tokens in one call = probably bogus
  let totalIn = 0, totalOut = 0, totalLocal = 0;
  const rows: any[][] = [];
  for (const e of payload.events) {
    const inp = Math.max(0, Math.min(MAX_PER_EVENT, e.input_tokens | 0));
    const out = Math.max(0, Math.min(MAX_PER_EVENT, e.output_tokens | 0));
    if (inp === 0 && out === 0) continue;
    const isLocal = e.is_local ? 1 : 0;
    rows.push([
      user.id, e.ts | 0, String(e.provider).slice(0, 32), String(e.model).slice(0, 64),
      isLocal, inp, out,
      (e.cache_read_tokens | 0), (e.cache_write_tokens | 0), (e.reasoning_tokens | 0),
    ]);
    totalIn += inp; totalOut += out;
    if (isLocal) totalLocal += inp + out;
  }

  if (rows.length === 0) return json({ ok: true, accepted: 0 });

  // D1 batch insert
  const stmt = env.DB.prepare(
    `INSERT INTO token_events
     (user_id, ts, provider, model, is_local, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, reasoning_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  await env.DB.batch(rows.map(r => stmt.bind(...r)));

  // Update totals (upsert)
  await env.DB.prepare(
    `INSERT INTO totals (user_id, total_input, total_output, local_tokens, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       total_input = total_input + excluded.total_input,
       total_output = total_output + excluded.total_output,
       local_tokens = local_tokens + excluded.local_tokens,
       updated_at = excluded.updated_at`
  ).bind(user.id, totalIn, totalOut, totalLocal, now()).run();

  // Fan-out to live room (don't block the response on this)
  ctx.waitUntil(broadcastDelta(env, {
    user: { id: user.id, login: user.login, avatar_url: user.avatar_url },
    delta: { input: totalIn, output: totalOut, local: totalLocal },
    accepted: rows.length,
    ts: now(),
  }));

  return json({ ok: true, accepted: rows.length });
}

// ────────────────────────────────────────────────────────────────────────────
// Leaderboard
// ────────────────────────────────────────────────────────────────────────────

async function leaderboard(_req: Request, env: Env): Promise<Response> {
  const all = await env.DB.prepare(
    `SELECT u.login, u.avatar_url, t.total_input, t.total_output, t.local_tokens,
            (t.total_input + t.total_output) AS total
     FROM totals t JOIN users u ON u.id = t.user_id
     ORDER BY total DESC LIMIT 100`
  ).all();

  const weekAgo = now() - 7 * 86400 * 1000;
  const week = await env.DB.prepare(
    `SELECT u.login, u.avatar_url,
            SUM(e.input_tokens + e.output_tokens) AS total
     FROM token_events e JOIN users u ON u.id = e.user_id
     WHERE e.ts > ?
     GROUP BY u.id ORDER BY total DESC LIMIT 50`
  ).bind(weekAgo).all();

  const local = await env.DB.prepare(
    `SELECT u.login, u.avatar_url, t.local_tokens AS total
     FROM totals t JOIN users u ON u.id = t.user_id
     WHERE t.local_tokens > 0
     ORDER BY total DESC LIMIT 50`
  ).all();

  const byProvider = await env.DB.prepare(
    `SELECT e.provider, u.login,
            SUM(e.input_tokens + e.output_tokens) AS total
     FROM token_events e JOIN users u ON u.id = e.user_id
     GROUP BY e.provider, u.id
     ORDER BY e.provider, total DESC`
  ).all();

  return json({
    all_time: all.results,
    this_week: week.results,
    local_hero: local.results,
    by_provider: byProvider.results,
    server_time: now(),
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Live updates via a single Durable Object
// ────────────────────────────────────────────────────────────────────────────

async function liveWS(req: Request, env: Env): Promise<Response> {
  const id = env.LIVE.idFromName('global');
  return env.LIVE.get(id).fetch(req);
}

async function broadcastDelta(env: Env, msg: unknown): Promise<void> {
  const id = env.LIVE.idFromName('global');
  await env.LIVE.get(id).fetch('https://live/broadcast', {
    method: 'POST', body: JSON.stringify(msg),
  });
}

export class LiveRoom implements DurableObject {
  private sockets = new Set<WebSocket>();
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/broadcast') {
      const msg = await req.text();
      for (const ws of this.sockets) {
        try { ws.send(msg); } catch { this.sockets.delete(ws); }
      }
      return new Response('ok');
    }
    // websocket upgrade
    if (req.headers.get('upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 400 });
    }
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.accept();
    this.sockets.add(server);
    server.addEventListener('close', () => this.sockets.delete(server));
    server.addEventListener('error', () => this.sockets.delete(server));
    return new Response(null, { status: 101, webSocket: client });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Installer
// ────────────────────────────────────────────────────────────────────────────

function installScript(env: Env): Response {
  const script = `#!/usr/bin/env bash
set -euo pipefail
BASE="${env.PUBLIC_URL}"
DEST="$HOME/.tokenarena"
mkdir -p "$DEST"
echo "↓ downloading agent..."
curl -fsSL "$BASE/agent/tokenarena.js" -o "$DEST/tokenarena.js"
cat > "$DEST/tokenarena" <<EOF
#!/usr/bin/env bash
exec node "$DEST/tokenarena.js" "\\$@"
EOF
chmod +x "$DEST/tokenarena"
echo "✓ installed to $DEST/tokenarena"
echo "→ add this to your shell rc:"
echo "    export PATH=\\"$DEST:\\$PATH\\""
echo "→ then: tokenarena login <your-agent-token>"
`;
  return new Response(script, { headers: { 'content-type': 'text/x-shellscript' } });
}
