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
  res.setHeader('Set-Cookie', 'ta_session=; Path=/; Max-Age=0');
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
