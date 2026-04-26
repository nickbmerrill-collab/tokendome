import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, now, publicUrl } from '../../lib/shared';

// /api/profile/[login] serves three response shapes off the same handler so
// we can stay under the Vercel 12-function cap:
//   - default              → JSON (used by the SPA's drawer)
//   - ?og=1                → SVG og:image (used in social-share unfurls)
//   - ?html=1              → tiny HTML shell with og meta + redirect to the
//                            SPA. The /u/<login> rewrite points here so
//                            crawlers see per-user metadata.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const login = String(req.query.login || '').trim();
  if (!login) return res.status(400).json({ error: 'login required' });

  const sql = db();
  const t = now();
  const monthAgo = t - 30 * 86400 * 1000;
  const weekAgo = t - 7 * 86400 * 1000;

  // Accept either the GitHub login OR the user's chosen display name.
  // Anonymized users are NOT discoverable by their real GitHub login.
  const userRows = await sql`
    SELECT u.id, u.login, u.display_name, u.avatar_url, u.created_at,
           t.total_input, t.total_output, t.local_tokens, t.total_cost_cents
    FROM users u LEFT JOIN totals t ON t.user_id = u.id
    WHERE NOT u.hidden
      AND ((u.display_name IS NOT NULL AND lower(u.display_name) = lower(${login}))
        OR (u.display_name IS NULL     AND lower(u.login)        = lower(${login})))
  `;
  if (userRows.length === 0) return res.status(404).json({ error: 'not found' });
  const u: any = userRows[0];
  const userId: number = u.id;
  const publicLogin: string = u.display_name || u.login;
  const publicAvatar: string | null = u.display_name ? null : u.avatar_url;

  const [series, byModel, byProvider, ranks] = await Promise.all([
    // 30-day series, grouped by UTC day, split by provider so the chart
    // can stack openai/anthropic/google/ollama bands.
    sql`
      SELECT (ts / 86400000)::bigint AS day_bucket,
             provider,
             SUM(input_tokens)::bigint AS input,
             SUM(output_tokens)::bigint AS output
      FROM token_events
      WHERE user_id = ${userId} AND ts > ${monthAgo}
      GROUP BY day_bucket, provider
      ORDER BY day_bucket
    `,
    sql`
      SELECT model, provider,
             SUM(input_tokens + output_tokens)::bigint AS total,
             COUNT(*)::int AS calls
      FROM token_events
      WHERE user_id = ${userId}
      GROUP BY model, provider
      ORDER BY total DESC
      LIMIT 20
    `,
    sql`
      SELECT provider,
             SUM(input_tokens + output_tokens)::bigint AS total,
             COUNT(*)::int AS calls
      FROM token_events
      WHERE user_id = ${userId}
      GROUP BY provider
      ORDER BY total DESC
    `,
    // Three rank lookups in one shot via window functions. Hidden users
    // are excluded so ghost-mode accounts don't influence public ranks
    // (rank gaps would otherwise hint at how many ghost users are above).
    sql`
      WITH at_rank AS (
        SELECT t.user_id, RANK() OVER (ORDER BY (t.total_input + t.total_output) DESC) AS r
        FROM totals t
        JOIN users u ON u.id = t.user_id AND NOT u.hidden
      ),
      wk_rank AS (
        SELECT e.user_id, RANK() OVER (ORDER BY SUM(e.input_tokens + e.output_tokens) DESC) AS r
        FROM token_events e
        JOIN users u ON u.id = e.user_id AND NOT u.hidden
        WHERE e.ts > ${weekAgo}
        GROUP BY e.user_id
      ),
      lh_rank AS (
        SELECT t.user_id, RANK() OVER (ORDER BY t.local_tokens DESC) AS r
        FROM totals t
        JOIN users u ON u.id = t.user_id AND NOT u.hidden
        WHERE t.local_tokens > 0
      )
      SELECT
        (SELECT r FROM at_rank WHERE user_id = ${userId})::int AS all_time,
        (SELECT r FROM wk_rank WHERE user_id = ${userId})::int AS this_week,
        (SELECT r FROM lh_rank WHERE user_id = ${userId})::int AS local_hero
    `,
  ]);

  const lifetime = {
    total_input: Number(u.total_input || 0),
    total_output: Number(u.total_output || 0),
    local_tokens: Number(u.local_tokens || 0),
    total_cost_cents: Number(u.total_cost_cents || 0),
    total: Number(u.total_input || 0) + Number(u.total_output || 0),
  };
  const rankObj = (ranks as any[])[0] || { all_time: null, this_week: null, local_hero: null };
  const topProvider = (byProvider as any[])[0]?.provider;

  // ─── ?og=1 → SVG image for social unfurls ─────────────────────────────────
  if (req.query.og === '1') {
    // For non-anonymized users, fetch+inline their GitHub avatar so the
    // OG renders consistently across crawlers (some don't fetch external
    // URLs from inside an SVG). 256-byte cap defeats accidental hugs.
    let avatarDataUrl: string | null = null;
    if (publicAvatar) {
      try {
        const resp = await fetch(publicAvatar + '&s=160');
        if (resp.ok) {
          const ct = resp.headers.get('content-type') || 'image/png';
          const buf = Buffer.from(await resp.arrayBuffer());
          if (buf.byteLength < 200_000) {
            avatarDataUrl = `data:${ct};base64,${buf.toString('base64')}`;
          }
        }
      } catch { /* avatar embedding is decorative — fail silent */ }
    }
    const svg = renderOgSvg({
      handle: publicLogin,
      total: lifetime.total,
      input: lifetime.total_input,
      output: lifetime.total_output,
      cost: lifetime.total_cost_cents,
      rank: rankObj.all_time,
      provider: topProvider || null,
      avatar: avatarDataUrl,
    });
    res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=120, stale-while-revalidate=600');
    res.send(svg);
    return;
  }

  // ─── ?html=1 → SPA shell with per-user OG meta tags ───────────────────────
  if (req.query.html === '1') {
    const base = publicUrl(req);
    const ogImage = `${base}/api/profile/${encodeURIComponent(publicLogin)}?og=1`;
    const title = `@${publicLogin} · THE TOKENDOME`;
    const desc = lifetime.total
      ? `${lifetime.total.toLocaleString()} tokens burned${rankObj.all_time ? ` · #${rankObj.all_time} all-time` : ''}`
      : `Combatant in THE TOKENDOME — competitive LLM token leaderboard.`;
    // Fetch the SPA shell and splice OG tags into <head>. The SPA boot code
    // already reads /u/<login> from the URL and opens the drawer.
    let shell: string;
    try {
      shell = await fetch(`${base}/index.html`).then(r => r.text());
    } catch {
      // Fallback: minimal redirect page
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.send(`<!doctype html><meta http-equiv="refresh" content="0; url=/"><title>${escapeHtml(title)}</title>`);
      return;
    }
    const ogTags = [
      `<meta property="og:title" content="${escapeHtml(title)}">`,
      `<meta property="og:description" content="${escapeHtml(desc)}">`,
      `<meta property="og:image" content="${escapeHtml(ogImage)}">`,
      `<meta property="og:url" content="${escapeHtml(base + '/u/' + publicLogin)}">`,
      `<meta property="og:type" content="profile">`,
      `<meta name="twitter:card" content="summary_large_image">`,
      `<meta name="twitter:title" content="${escapeHtml(title)}">`,
      `<meta name="twitter:description" content="${escapeHtml(desc)}">`,
      `<meta name="twitter:image" content="${escapeHtml(ogImage)}">`,
    ].join('\n');
    const out = shell.replace(/<head>/i, `<head>\n${ogTags}`);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=60, stale-while-revalidate=600');
    res.send(out);
    return;
  }

  res.setHeader('cache-control', 'public, max-age=5, stale-while-revalidate=30');
  res.json({
    login: publicLogin,
    avatar_url: publicAvatar,
    created_at: Number(u.created_at),
    lifetime,
    series_30d: series,
    by_model: byModel,
    by_provider: byProvider,
    ranks: rankObj,
    server_time: t,
  });
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
}

// 1200×630 (Twitter / Facebook / LinkedIn standard) SVG. No external fonts —
// uses system-ui so it renders identically without network roundtrips.
function renderOgSvg(o: { handle: string; total: number; input: number; output: number; cost: number; rank: number | null; provider: string | null; avatar: string | null }): string {
  const fmt = (n: number) => n.toLocaleString('en-US');
  const compact = (n: number) => n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M' : n >= 1_000 ? (n / 1_000).toFixed(1) + 'K' : String(n);
  const cost = (o.cost / 100).toFixed(2);
  // Avatar is optional. When present we shrink the headline a touch and shift
  // it right to make room for the 160×160 image with a yellow border.
  const handleX = o.avatar ? 260 : 60;
  const avatarBlock = o.avatar
    ? `<defs><clipPath id="avc"><rect x="60" y="200" width="160" height="160"/></clipPath></defs>
       <image href="${o.avatar}" x="60" y="200" width="160" height="160" clip-path="url(#avc)" preserveAspectRatio="xMidYMid slice"/>
       <rect x="60" y="200" width="160" height="160" fill="none" stroke="#facc15" stroke-width="3"/>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <style>
      .display { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; font-weight: 900; font-style: italic; }
      .data    { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; }
      .label   { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; font-weight: 800; letter-spacing: 0.2em; }
    </style>
  </defs>
  <rect width="1200" height="630" fill="#0B0B10"/>
  <rect x="40" y="40" width="1120" height="6" fill="#facc15"/>

  <text x="60"   y="115" class="display" font-size="38" fill="#facc15">⚡ THE TOKENDOME</text>
  <text x="60"   y="150" class="label"   font-size="16" fill="#94A3B8" letter-spacing="0.3em">VERIFIED PROXY · LIVE LEADERBOARD</text>

  ${avatarBlock}
  <text x="${handleX}" y="295" class="display" font-size="${o.avatar ? 76 : 92}" fill="#F8FAFC">@${escapeXml(o.handle.toUpperCase()).slice(0, 20)}</text>
  ${o.rank ? `<text x="${handleX}" y="350" class="label" font-size="22" fill="#facc15" letter-spacing="0.25em">RANK #${o.rank} · ALL TIME</text>` : ''}

  <rect x="60" y="420" width="1080" height="2" fill="#facc15" opacity="0.4"/>

  <g>
    <text x="60"   y="490" class="data" font-size="120" fill="#facc15" font-weight="bold">${compact(o.total)}</text>
    <text x="60"   y="540" class="label" font-size="18" fill="#94A3B8" letter-spacing="0.25em">TOKENS BURNED</text>
  </g>
  <g>
    <text x="600"  y="490" class="data" font-size="40" fill="#F8FAFC">${fmt(o.input)} <tspan fill="#64748B" font-size="22" class="label">IN</tspan></text>
    <text x="600"  y="540" class="data" font-size="40" fill="#F8FAFC">${fmt(o.output)} <tspan fill="#64748B" font-size="22" class="label">OUT</tspan></text>
  </g>
  <g>
    <text x="940"  y="490" class="data" font-size="40" fill="#10B981">$${cost}</text>
    <text x="940"  y="540" class="label" font-size="18" fill="#94A3B8" letter-spacing="0.25em">SPENT</text>
  </g>

  <text x="60"   y="600" class="label" font-size="14" fill="#475569" letter-spacing="0.3em">TOKENDOME.VERCEL.APP/U/${escapeXml(o.handle.toUpperCase())}</text>
  ${o.provider ? `<text x="1140" y="600" class="label" font-size="14" fill="#94A3B8" text-anchor="end" letter-spacing="0.25em">${escapeXml(o.provider).toUpperCase()}</text>` : ''}
</svg>`;
}

function escapeXml(s: string): string {
  return String(s).replace(/[<>&"']/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;' }[c]!));
}
