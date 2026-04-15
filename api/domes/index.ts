/**
 * Domes — private friend-group leaderboards.
 *
 *   GET  /api/domes               → list domes the signed-in user belongs to
 *   POST /api/domes               → create a new dome (creator becomes owner+member)
 *                                    body: { name }
 *   POST /api/domes?join=1        → join an existing dome via invite code
 *                                    body: { invite_code }
 *
 * Each dome gets a slug + a 12-char invite code. Sharing the URL
 *   https://tokendome.vercel.app/?dome=<slug>&invite=<code>
 * lets a friend one-click join after they sign in.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, now, getCurrentUser, randomHex } from '../../lib/shared';

export const config = { api: { bodyParser: { sizeLimit: '4kb' } } };

function slugify(s: string): string {
  return s.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const me = await getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'sign in first' });

  const sql = db();

  if (req.method === 'GET') {
    const rows = await sql`
      SELECT d.id, d.slug, d.name, d.owner_user_id, d.invite_code, d.created_at,
             (SELECT COUNT(*)::int FROM dome_members m WHERE m.dome_id = d.id) AS member_count,
             (d.owner_user_id = ${me.id}) AS owner
      FROM domes d
      JOIN dome_members dm ON dm.dome_id = d.id
      WHERE dm.user_id = ${me.id}
      ORDER BY d.created_at DESC
    `;
    // Hide invite_code from non-owners — only the creator should pass it around
    return res.json({
      domes: (rows as any[]).map(r => ({
        slug: r.slug,
        name: r.name,
        owner: !!r.owner,
        member_count: r.member_count,
        invite_code: r.owner ? r.invite_code : null,
        created_at: Number(r.created_at),
      })),
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const body: any = typeof req.body === 'string' ? safeJSON(req.body) : (req.body || {});
  const join = req.query.join === '1' || !!body.invite_code;

  if (join) {
    const code = String(body.invite_code || '').trim();
    if (!code) return res.status(400).json({ error: 'invite_code required' });
    const found = await sql`SELECT id, slug, name FROM domes WHERE invite_code = ${code} LIMIT 1`;
    if (found.length === 0) return res.status(404).json({ error: 'no dome with that invite code' });
    const d: any = found[0];
    await sql`
      INSERT INTO dome_members (dome_id, user_id, role, joined_at)
      VALUES (${d.id}, ${me.id}, 'member', ${now()})
      ON CONFLICT (dome_id, user_id) DO NOTHING
    `;
    return res.json({ ok: true, slug: d.slug, name: d.name });
  }

  // Create
  const name = String(body.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'name required' });
  const baseSlug = slugify(name) || 'dome';
  // Ensure unique slug by appending suffix on collision
  let slug = baseSlug;
  for (let i = 0; i < 8; i++) {
    const exists = await sql`SELECT 1 FROM domes WHERE slug = ${slug} LIMIT 1`;
    if (exists.length === 0) break;
    slug = `${baseSlug}-${randomHex(2)}`;
  }
  const inviteCode = randomHex(6); // 12 hex chars
  const ts = now();
  const inserted = await sql`
    INSERT INTO domes (slug, name, owner_user_id, invite_code, created_at)
    VALUES (${slug}, ${name}, ${me.id}, ${inviteCode}, ${ts})
    RETURNING id, slug, name, invite_code
  `;
  const d: any = inserted[0];
  await sql`
    INSERT INTO dome_members (dome_id, user_id, role, joined_at)
    VALUES (${d.id}, ${me.id}, 'owner', ${ts})
  `;
  return res.json({
    ok: true, slug: d.slug, name: d.name, invite_code: d.invite_code,
    invite_url: `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['x-forwarded-host'] || req.headers.host}/?dome=${d.slug}&invite=${d.invite_code}`,
  });
}

function safeJSON(s: string): any { try { return JSON.parse(s); } catch { return {}; } }
