/**
 * POST /api/trash-talk
 *
 * Post a 140-char trash-talk bubble that displays on a target user's row
 * for 30 minutes. Requires the poster to be signed in. Cannot trash-talk
 * yourself (would be sad).
 *
 * Body: { to_login: string, message: string }
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, now, getCurrentUser, checkCsrf } from '../lib/shared';

export const config = { api: { bodyParser: { sizeLimit: '4kb' } } };

const MAX_LEN = 140;
const TTL_MS = 30 * 60 * 1000;

// Light per-user rate limit — naive in-memory, sufficient at our scale.
const lastPost = new Map<number, number>();
const COOLDOWN_MS = 5_000;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const csrf = checkCsrf(req); if (csrf) return res.status(csrf.status).json(csrf);

  const me = await getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'sign in to trash-talk' });

  const body: any = typeof req.body === 'string' ? safeJSON(req.body) : (req.body || {});
  const toLogin = String(body.to_login || '').trim().slice(0, 64);
  const message = String(body.message || '').trim().slice(0, MAX_LEN);
  if (!toLogin || !message) return res.status(400).json({ error: 'to_login and message required' });

  // Rate limit per poster
  const t = now();
  const last = lastPost.get(me.id) || 0;
  if (t - last < COOLDOWN_MS) {
    return res.status(429).json({ error: `slow down — ${Math.ceil((COOLDOWN_MS - (t - last)) / 1000)}s cooldown` });
  }

  const sql = db();
  // Match either display_name (when set) or GitHub login (when not).
  const targets = await sql`
    SELECT id, login FROM users
    WHERE (display_name IS NOT NULL AND lower(display_name) = lower(${toLogin}))
       OR (display_name IS NULL     AND lower(login)        = lower(${toLogin}))
    LIMIT 1
  `;
  if (targets.length === 0) return res.status(404).json({ error: 'no such combatant' });
  const to = targets[0] as any;
  if (to.id === me.id) return res.status(400).json({ error: "can't trash-talk yourself" });

  lastPost.set(me.id, t);

  // Replace any prior bubble from this poster to this target — they only get
  // one active line at a time. Keeps the bubble fresh and prevents spamming.
  await sql`DELETE FROM trash_talk WHERE from_user_id = ${me.id} AND to_user_id = ${to.id}`;
  await sql`
    INSERT INTO trash_talk (from_user_id, to_user_id, message, created_at, expires_at)
    VALUES (${me.id}, ${to.id}, ${message}, ${t}, ${t + TTL_MS})
  `;

  res.json({ ok: true, expires_at: t + TTL_MS });
}

function safeJSON(s: string): any { try { return JSON.parse(s); } catch { return {}; } }
