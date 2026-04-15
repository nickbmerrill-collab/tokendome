/**
 * /api/domes — single dispatcher for private-leaderboard CRUD.
 * Consolidated from /api/domes/index.ts + /api/domes/[slug].ts to fit the
 * Vercel Hobby 12-function cap.
 *
 *   GET    /api/domes                     → list domes the user belongs to
 *   POST   /api/domes                     → create a new dome (creator becomes owner+member)
 *                                            body: { name }
 *   POST   /api/domes?join=1              → join an existing dome via invite code
 *                                            body: { invite_code }
 *   PATCH  /api/domes?slug=foo            → owner-only: rename or rotate invite code
 *                                            body: { name?, rotate_invite? }
 *   DELETE /api/domes?slug=foo            → owner: delete the dome
 *   DELETE /api/domes?slug=foo&leave=1    → member: leave the dome
 *
 * vercel.json rewrites /api/domes/<slug> → /api/domes?slug=<slug> so the
 * REST-shaped URLs from the frontend keep working.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, now, getCurrentUser, randomHex } from '../lib/shared';

export const config = { api: { bodyParser: { sizeLimit: '4kb' } } };

function safeJSON(s: string): any { try { return JSON.parse(s); } catch { return {}; } }
function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const me = await getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'sign in first' });

  const sql = db();
  const slug = String(req.query.slug || '').trim();
  const body: any = typeof req.body === 'string' ? safeJSON(req.body) : (req.body || {});

  // ─── /api/domes (no slug): list / create / join ──────────────────────────
  if (!slug) {
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
      return res.json({
        domes: (rows as any[]).map(r => ({
          slug: r.slug, name: r.name, owner: !!r.owner, member_count: r.member_count,
          invite_code: r.owner ? r.invite_code : null, created_at: Number(r.created_at),
        })),
      });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

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

    const name = String(body.name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'name required' });
    const baseSlug = slugify(name) || 'dome';
    let newSlug = baseSlug;
    for (let i = 0; i < 8; i++) {
      const exists = await sql`SELECT 1 FROM domes WHERE slug = ${newSlug} LIMIT 1`;
      if (exists.length === 0) break;
      newSlug = `${baseSlug}-${randomHex(2)}`;
    }
    const inviteCode = randomHex(6);
    const ts = now();
    const inserted = await sql`
      INSERT INTO domes (slug, name, owner_user_id, invite_code, created_at)
      VALUES (${newSlug}, ${name}, ${me.id}, ${inviteCode}, ${ts})
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

  // ─── /api/domes/<slug>: rename / rotate / leave / delete ─────────────────
  const found = await sql`SELECT id, owner_user_id, slug, name FROM domes WHERE slug = ${slug} LIMIT 1`;
  if (found.length === 0) return res.status(404).json({ error: 'no such dome' });
  const d: any = found[0];
  const isOwner = d.owner_user_id === me.id;

  if (req.method === 'DELETE') {
    if (req.query.leave === '1') {
      if (isOwner) return res.status(400).json({ error: 'owner cannot leave — delete the dome instead' });
      await sql`DELETE FROM dome_members WHERE dome_id = ${d.id} AND user_id = ${me.id}`;
      return res.json({ ok: true, left: slug });
    }
    if (!isOwner) return res.status(403).json({ error: 'only the owner can delete the dome' });
    await sql`DELETE FROM domes WHERE id = ${d.id}`;
    return res.json({ ok: true, deleted: slug });
  }

  if (req.method === 'PATCH') {
    if (!isOwner) return res.status(403).json({ error: 'only the owner can modify the dome' });
    const updates: { name?: string; invite_code?: string } = {};
    if (typeof body.name === 'string') {
      const name = body.name.trim().slice(0, 60);
      if (!name) return res.status(400).json({ error: 'name cannot be empty' });
      updates.name = name;
    }
    if (body.rotate_invite) updates.invite_code = randomHex(6);
    if (!('name' in updates) && !('invite_code' in updates)) {
      return res.status(400).json({ error: 'nothing to update' });
    }
    if (updates.name) await sql`UPDATE domes SET name = ${updates.name} WHERE id = ${d.id}`;
    if (updates.invite_code) await sql`UPDATE domes SET invite_code = ${updates.invite_code} WHERE id = ${d.id}`;
    const after = await sql`SELECT slug, name, invite_code FROM domes WHERE id = ${d.id}`;
    return res.json({ ok: true, ...after[0] });
  }

  return res.status(405).json({ error: 'method' });
}
