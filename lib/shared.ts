/**
 * Shared helpers: DB client, signed cookies, HMAC, small utilities.
 * Runs in Node runtime on Vercel serverless functions.
 */
import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import * as crypto from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';

let _sql: NeonQueryFunction<false, false> | null = null;
export function db() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL not set');
    _sql = neon(url);
  }
  return _sql;
}

export const now = () => Date.now();

export function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function hmacHex(key: string, msg: string): string {
  return crypto.createHmac('sha256', key).update(msg).digest('hex');
}

export function sha256Hex(msg: string): string {
  return crypto.createHash('sha256').update(msg).digest('hex');
}

// ─── Cookies ────────────────────────────────────────────────────────────────

export function parseCookies(req: VercelRequest): Record<string, string> {
  const cookie = req.headers.cookie || '';
  const out: Record<string, string> = {};
  for (const part of cookie.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

/**
 * Stateless session cookie — no DB lookup.
 * Format: <user_id>.<expires_ms>.<hmac(user_id.expires)>
 */
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;

function sessionSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET not set');
  return s;
}

export function makeSession(userId: number): string {
  const exp = now() + SESSION_TTL;
  const payload = `${userId}.${exp}`;
  return `${payload}.${hmacHex(sessionSecret(), payload)}`;
}

export function verifySession(token: string | undefined): number | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [uid, exp, sig] = parts;
  const expected = hmacHex(sessionSecret(), `${uid}.${exp}`);
  if (expected.length !== sig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  if (Number(exp) < now()) return null;
  const userId = Number(uid);
  return Number.isFinite(userId) && userId > 0 ? userId : null;
}

export function setSessionCookie(res: VercelResponse, token: string) {
  res.setHeader('Set-Cookie',
    `ta_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL / 1000)}`);
}
export function clearSessionCookie(res: VercelResponse) {
  // Match the security attributes used at set time so browsers reliably
  // treat this as the same cookie. Plain `Path=/; Max-Age=0` works for
  // most modern browsers but is brittle.
  res.setHeader('Set-Cookie', 'ta_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
}

// OAuth state cookie (short-lived, signed)
export function makeState(): string {
  const nonce = randomHex(12);
  const exp = now() + 10 * 60 * 1000;
  const payload = `${nonce}.${exp}`;
  return `${payload}.${hmacHex(sessionSecret(), 'oauth:' + payload)}`;
}
export function verifyState(token: string | undefined): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [nonce, exp, sig] = parts;
  const expected = hmacHex(sessionSecret(), `oauth:${nonce}.${exp}`);
  if (expected.length !== sig.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return false;
  return Number(exp) >= now();
}

export async function getCurrentUser(req: VercelRequest) {
  const sid = parseCookies(req)['ta_session'];
  const userId = verifySession(sid);
  if (!userId) return null;
  const rows = await db()`SELECT * FROM users WHERE id = ${userId}`;
  return rows[0] as any || null;
}

// CSRF guard for state-changing endpoints. SameSite=Lax already blocks the
// common cross-site POST case, but defense-in-depth matters across browser
// quirks, embedding, and same-site sibling subdomains. Same-origin (Origin
// header matches publicUrl host) is required; in dev where Origin is
// missing on some flows we fall back to checking Referer.
//
// Returns null on success, or an HTTP-error tuple on failure that the
// caller should send back to the client.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export function checkCsrf(req: VercelRequest): { status: number; error: string } | null {
  const method = (req.method || 'GET').toUpperCase();
  if (SAFE_METHODS.has(method)) return null;
  const expectedHost = (() => {
    try { return new URL(publicUrl(req)).host; } catch { return ''; }
  })();
  const origin = String(req.headers.origin || '').trim();
  if (origin) {
    try {
      if (new URL(origin).host !== expectedHost) {
        return { status: 403, error: 'cross-origin request blocked' };
      }
      return null;
    } catch {
      return { status: 403, error: 'malformed origin' };
    }
  }
  // No Origin header (some browsers don't send it on same-origin POST).
  // Fall back to Referer; reject if neither is present so blind tools
  // can't trip CSRF endpoints.
  const referer = String(req.headers.referer || '').trim();
  if (!referer) return { status: 403, error: 'missing origin' };
  try {
    if (new URL(referer).host !== expectedHost) {
      return { status: 403, error: 'cross-origin request blocked' };
    }
  } catch {
    return { status: 403, error: 'malformed referer' };
  }
  return null;
}

/** What name to show publicly: the user's chosen pseudonym, or their GitHub login as fallback. */
export function publicHandle(u: { display_name?: string | null; login: string }): string {
  return (u.display_name && u.display_name.trim()) || u.login;
}

/** Validate a candidate display name. Returns a trimmed valid string or null. */
export function normalizeDisplayName(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Slug-ish: letters, digits, dashes, underscores, single internal dots.
  // Length 2-32. Avoids URL clashes (no slashes) and impersonation tactics.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,31}$/.test(s)) return null;
  return s;
}

// ─── Agent-token encryption-at-rest ────────────────────────────────────────
//
// Agent tokens are HMAC keys — the agent has the raw secret and signs every
// ingest payload with it. Storing the raw secret in the DB means a read-only
// DB leak hands the attacker every active credential. Cleanest fix without
// invalidating existing tokens: encrypt at rest with AES-256-GCM, key
// derived from SESSION_SECRET via HKDF. Reads decrypt; writes encrypt.
// Legacy plaintext rows (no `enc1:` prefix) still verify until a one-shot
// migration converts them in place.
const AGENT_ENC_PREFIX = 'enc1:';

function tokenKey(): Buffer {
  const ikm = Buffer.from(sessionSecret(), 'utf8');
  // HKDF-SHA256, 32 bytes for AES-256-GCM. The `info` parameter scopes
  // this purpose so future keys (e.g. install codes) derive from the
  // same SESSION_SECRET without colliding.
  return Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), 'tokendome-agent-token-v1', 32) as ArrayBuffer);
}

export function encryptAgentToken(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', tokenKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return AGENT_ENC_PREFIX + Buffer.concat([iv, tag, ct]).toString('base64url');
}

export function decryptAgentToken(stored: string): string {
  // Backward-compat: rows written before encryption-at-rest landed are
  // returned as-is. The migration task rewraps them on the next write.
  if (!stored || !stored.startsWith(AGENT_ENC_PREFIX)) return stored;
  const buf = Buffer.from(stored.slice(AGENT_ENC_PREFIX.length), 'base64url');
  if (buf.length < 12 + 16 + 1) throw new Error('agent token ciphertext too short');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', tokenKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ─── Durable rate limiter ──────────────────────────────────────────────────
//
// Fixed-window counter keyed by an arbitrary string (e.g. "ingest:user:42",
// "leaderboard:ip:1.2.3.4"). One DB roundtrip per check via UPSERT.
// Returns { ok: false, retry_after_ms } when the limit is exceeded.
export async function rateCheck(
  key: string, limit: number, windowMs: number,
): Promise<{ ok: boolean; retry_after_ms?: number }> {
  const t = now();
  const winFloor = t - windowMs;
  const sql = db();
  const rows = await sql`
    INSERT INTO rate_limits (key, count, window_start)
    VALUES (${key}, 1, ${t})
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN rate_limits.window_start < ${winFloor} THEN 1 ELSE rate_limits.count + 1 END,
      window_start = CASE WHEN rate_limits.window_start < ${winFloor} THEN ${t} ELSE rate_limits.window_start END
    RETURNING count, window_start
  `;
  const row = (rows as any[])[0];
  const cnt = Number(row.count);
  const wstart = Number(row.window_start);
  if (cnt > limit) return { ok: false, retry_after_ms: Math.max(0, windowMs - (t - wstart)) };
  return { ok: true };
}

export function clientIp(req: VercelRequest): string {
  // Vercel sets x-real-ip when available; x-forwarded-for is the chain.
  const real = String(req.headers['x-real-ip'] || '').trim();
  if (real) return real;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || 'unknown';
}

// Canonical origin used for OAuth redirect_uri, invite links, OG image URLs,
// and server-side fetches against our own public surfaces.
//
// PUBLIC_URL is preferred — Host headers are attacker-controlled in general,
// and feeding them into redirect_uri / SSRF targets is a vector
// (host-header poisoning). The request-derived fallback keeps local dev and
// preview deploys working when PUBLIC_URL isn't set, but in that path we
// only honor an x-forwarded-host that matches the configured allowlist if
// present, otherwise the raw Host header.
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

export function publicUrl(req: VercelRequest): string {
  const fromEnv = process.env.PUBLIC_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  const xfh = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = (xfh && (ALLOWED_HOSTS.length === 0 || ALLOWED_HOSTS.includes(xfh)))
    ? xfh
    : (req.headers.host || '');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}
