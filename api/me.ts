import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getCurrentUser, db, publicHandle, normalizeDisplayName } from '../lib/shared';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const u = await getCurrentUser(req);

  // PATCH /api/me — update profile (currently just display_name)
  if (req.method === 'PATCH' || req.method === 'POST') {
    if (!u) return res.status(401).json({ error: 'sign in first' });
    const body: any = typeof req.body === 'string' ? safeJSON(req.body) : (req.body || {});
    let displayName: string | null = null;
    if ('display_name' in body) {
      const raw = body.display_name;
      if (raw === null || raw === '') {
        displayName = null; // explicit clear
      } else {
        const norm = normalizeDisplayName(raw);
        if (!norm) return res.status(400).json({ error: 'display_name must be 2-32 chars: letters, digits, . _ -' });
        displayName = norm;
      }
      // Uniqueness: don't let two users pick the same pseudonym, and don't
      // collide with someone else's GitHub login (would let an anon user
      // impersonate a real one).
      if (displayName !== null) {
        const collision = await db()`
          SELECT id FROM users
          WHERE id <> ${u.id}
            AND (lower(login) = lower(${displayName}) OR lower(display_name) = lower(${displayName}))
          LIMIT 1
        `;
        if (collision.length > 0) return res.status(409).json({ error: 'name already taken' });
      }
      await db()`UPDATE users SET display_name = ${displayName} WHERE id = ${u.id}`;
      u.display_name = displayName;
    }
    if ('hidden' in body) {
      const h = !!body.hidden;
      await db()`UPDATE users SET hidden = ${h} WHERE id = ${u.id}`;
      u.hidden = h;
    }
  }

  if (!u) return res.json({ authenticated: false });
  res.json({
    authenticated: true,
    login: publicHandle(u),     // public-facing handle (display_name OR login)
    real_login: u.login,        // original GitHub handle — useful for the user's own settings UI
    display_name: u.display_name || null,
    is_anonymized: !!u.display_name,
    hidden: !!u.hidden,
    avatar_url: u.display_name ? null : u.avatar_url, // hide GitHub avatar when anonymized
    // "<user_id>.<secret>" — the agent splits on the dot so it knows who it is
    agent_token: `${u.id}.${u.agent_token}`,
  });
}

function safeJSON(s: string): any { try { return JSON.parse(s); } catch { return {}; } }
