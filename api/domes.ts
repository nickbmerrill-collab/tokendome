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
import { db, now, getCurrentUser, randomHex, publicUrl } from '../lib/shared';

export const config = { api: { bodyParser: { sizeLimit: '4kb' } } };

function safeJSON(s: string): any { try { return JSON.parse(s); } catch { return {}; } }
function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
}
function escapeXml(s: string): string {
  return String(s).replace(/[<>&"']/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;' }[c]!));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const sql = db();
  const slug = String(req.query.slug || '').trim();

  // ─── PUBLIC paths: ?og=1 / ?html=1 for sharable dome URLs ──────────────
  // Don't require auth so unfurl crawlers + cold visitors can render the
  // page. The dome is treated as public-readable for these surfaces.
  if (slug && (req.query.og === '1' || req.query.html === '1')) {
    return publicDomeView(req, res, slug);
  }

  const me = await getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'sign in first' });
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

// ─── Public dome view: ?og=1 (SVG) and ?html=1 (SPA shell with og meta) ─────
async function publicDomeView(req: VercelRequest, res: VercelResponse, slug: string) {
  const sql = db();
  const found = await sql`
    SELECT d.id, d.name, d.slug,
           (SELECT COUNT(*)::int FROM dome_members m WHERE m.dome_id = d.id) AS member_count
    FROM domes d
    WHERE d.slug = ${slug}
    LIMIT 1
  `;
  if (found.length === 0) return res.status(404).json({ error: 'no such dome' });
  const d: any = found[0];

  // Pull the top combatants in this dome, scoped through dome_members.
  const top = await sql`
    SELECT COALESCE(u.display_name, u.login) AS handle,
           (t.total_input + t.total_output)::bigint AS total
    FROM totals t
    JOIN users u ON u.id = t.user_id AND NOT u.hidden
    JOIN dome_members m ON m.user_id = u.id AND m.dome_id = ${d.id}
    ORDER BY total DESC
    LIMIT 5
  `;
  const totalAll = (top as any[]).reduce((s, r) => s + Number(r.total || 0), 0);

  if (req.query.og === '1') {
    res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=120, stale-while-revalidate=600');
    res.send(renderDomeOg({ name: d.name, slug: d.slug, members: d.member_count, total: totalAll, top: top as any[] }));
    return;
  }

  // ?html=1: SPA shell with per-dome og tags + auto-set scope on load
  const base = publicUrl(req);
  const ogImage = `${base}/api/domes?slug=${encodeURIComponent(d.slug)}&og=1`;
  const title = `${d.name} · THE TOKENDOME`;
  const desc = totalAll
    ? `${totalAll.toLocaleString()} tokens · ${d.member_count} combatant${d.member_count === 1 ? '' : 's'}`
    : `Private dome on THE TOKENDOME — competitive LLM token leaderboard.`;
  let shell: string;
  try {
    shell = await fetch(`${base}/index.html`).then(r => r.text());
  } catch {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><meta http-equiv="refresh" content="0; url=/?dome=${encodeURIComponent(d.slug)}"><title>${escapeHtml(title)}</title>`);
    return;
  }
  const ogTags = [
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(desc)}">`,
    `<meta property="og:image" content="${escapeHtml(ogImage)}">`,
    `<meta property="og:url" content="${escapeHtml(base + '/dome/' + d.slug)}">`,
    `<meta property="og:type" content="website">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(desc)}">`,
    `<meta name="twitter:image" content="${escapeHtml(ogImage)}">`,
  ].join('\n');
  // Inject a tiny boot snippet so the SPA scopes to this dome on load.
  const bootHook = `<script>(()=>{try{localStorage.setItem('tokendome_scope',${JSON.stringify(d.slug)});const u=new URL(location.href);u.searchParams.set('dome',${JSON.stringify(d.slug)});history.replaceState({},'',u);}catch{}})();</script>`;
  let out = shell.replace(/<head>/i, `<head>\n${ogTags}`);
  out = out.replace(/<\/head>/i, `${bootHook}\n</head>`);
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'public, max-age=60, stale-while-revalidate=600');
  res.send(out);
}

function renderDomeOg(o: { name: string; slug: string; members: number; total: number; top: Array<{ handle: string; total: number }> }): string {
  const compact = (n: number) => n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M' : n >= 1_000 ? (n / 1_000).toFixed(1) + 'K' : String(n);
  const rows = o.top.slice(0, 5).map((r, i) => {
    const y = 360 + i * 50;
    const handle = escapeXml(String(r.handle).toUpperCase()).slice(0, 22);
    return `
    <text x="60"   y="${y}" class="display" font-size="32" fill="#94A3B8">${String(i + 1).padStart(2, '0')}</text>
    <text x="130"  y="${y}" class="display" font-size="32" fill="#F8FAFC">@${handle}</text>
    <text x="1140" y="${y}" class="data"    font-size="32" fill="#facc15" text-anchor="end">${compact(Number(r.total) || 0)}</text>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs><style>
    .display { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; font-weight: 900; font-style: italic; }
    .data    { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; font-weight: bold; }
    .label   { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; font-weight: 800; letter-spacing: 0.2em; }
  </style></defs>
  <rect width="1200" height="630" fill="#0B0B10"/>
  <rect x="40" y="40" width="1120" height="6" fill="#facc15"/>

  <text x="60"   y="115" class="display" font-size="38" fill="#facc15">⚡ THE TOKENDOME</text>
  <text x="60"   y="155" class="label"   font-size="16" fill="#94A3B8" letter-spacing="0.3em">PRIVATE DOME · ${o.members} COMBATANT${o.members === 1 ? '' : 'S'}</text>

  <text x="60"   y="240" class="display" font-size="78" fill="#F8FAFC">${escapeXml(o.name).slice(0, 36)}</text>
  <text x="60"   y="285" class="data"    font-size="36" fill="#facc15">${o.total.toLocaleString()} <tspan class="label" font-size="20" fill="#94A3B8" letter-spacing="0.25em">TOK BURNED COLLECTIVELY</tspan></text>

  <rect x="60" y="320" width="1080" height="2" fill="#facc15" opacity="0.4"/>
  ${rows || `<text x="60" y="430" class="label" font-size="20" fill="#475569">FIRST COMBATANT TAKES THE CROWN UNCONTESTED</text>`}

  <text x="60"   y="600" class="label" font-size="14" fill="#475569" letter-spacing="0.3em">TOKENDOME.VERCEL.APP/DOME/${escapeXml(o.slug.toUpperCase())}</text>
</svg>`;
}
