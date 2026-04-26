import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, now, getCurrentUser, rateCheck, clientIp } from '../lib/shared';

// Anonymization rule: every public-facing query returns the user's chosen
// pseudonym (display_name) when set, falling back to their GitHub login.
// The avatar is suppressed when display_name is set so the GitHub photo
// never leaks identity.

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Per-IP throttle. The page polls every 3s, so a single tab generates
  // ~20/min on its own; 240/min comfortably allows several tabs and
  // legitimate bursts while capping scrapers.
  const rl = await rateCheck(`leaderboard:ip:${clientIp(req)}`, 240, 60_000);
  if (!rl.ok) {
    res.setHeader('Retry-After', String(Math.ceil((rl.retry_after_ms ?? 60_000) / 1000)));
    return res.status(429).json({ error: 'rate limited' });
  }
  const sql = db();
  const t = now();
  const dayAgo = t - 86400 * 1000;
  const weekAgo = t - 7 * 86400 * 1000;
  const minuteAgo = t - 60 * 1000;

  // Optional dome scoping. When ?dome=<slug> is passed, pre-resolve the
  // member-id set and intersect every query with it via ANY(int[]).
  // The flag `useDome` plus the (possibly-empty) member array lets every
  // query carry one branch-free predicate: when the flag is false the
  // filter is a tautology, when true it requires u.id to be in the set.
  const domeSlug = String(req.query.dome || '').trim();
  let useDome = false;
  let memberIds: number[] = [];
  if (domeSlug) {
    // Private domes are member-only. Require signed-in caller AND require
    // that the caller is a member. Indistinguishable 404s for non-existent
    // domes vs. domes the caller isn't in, so a slug never confirms its
    // own existence to outsiders.
    const me = await getCurrentUser(req);
    if (!me) return res.status(401).json({ error: 'sign in to view a dome' });
    const rows = await sql`
      SELECT m.user_id FROM dome_members m
      JOIN domes d ON d.id = m.dome_id
      WHERE d.slug = ${domeSlug}
    `;
    if (rows.length === 0) return res.status(404).json({ error: 'no such dome' });
    const memberSet = new Set((rows as any[]).map(r => r.user_id as number));
    if (!memberSet.has(me.id)) return res.status(404).json({ error: 'no such dome' });
    useDome = true;
    memberIds = [...memberSet];
  }

  // Fire all rollups in parallel — Neon serverless handles N tiny queries
  // faster than one mega-CTE in our case (cold-start latency dominates).
  const [
    allTime,
    thisWeek,
    localHero,
    byProvider,
    velocity,
    efficiency,
    sparklines,
    eventsPerMin,
    trashTalk,
  ] = await Promise.all([
    sql`
      SELECT COALESCE(u.display_name, u.login) AS login,
             CASE WHEN u.display_name IS NULL THEN u.avatar_url ELSE NULL END AS avatar_url,
             t.total_input, t.total_output, t.local_tokens,
             t.total_cost_cents,
             (t.total_input + t.total_output) AS total
      FROM totals t JOIN users u ON u.id = t.user_id AND NOT u.hidden AND (NOT ${useDome}::boolean OR u.id = ANY(${memberIds}::int[]))
      ORDER BY total DESC LIMIT 100
    `,
    sql`
      SELECT COALESCE(u.display_name, u.login) AS login,
             CASE WHEN u.display_name IS NULL THEN u.avatar_url ELSE NULL END AS avatar_url,
             SUM(e.input_tokens + e.output_tokens)::bigint AS total
      FROM token_events e JOIN users u ON u.id = e.user_id AND NOT u.hidden AND (NOT ${useDome}::boolean OR u.id = ANY(${memberIds}::int[]))
      WHERE e.ts > ${weekAgo}
      GROUP BY u.id, u.login, u.display_name, u.avatar_url
      ORDER BY total DESC LIMIT 50
    `,
    sql`
      SELECT COALESCE(u.display_name, u.login) AS login,
             CASE WHEN u.display_name IS NULL THEN u.avatar_url ELSE NULL END AS avatar_url,
             t.local_tokens AS total
      FROM totals t JOIN users u ON u.id = t.user_id AND NOT u.hidden AND (NOT ${useDome}::boolean OR u.id = ANY(${memberIds}::int[]))
      WHERE t.local_tokens > 0
      ORDER BY total DESC LIMIT 50
    `,
    sql`
      SELECT e.provider,
             COALESCE(u.display_name, u.login) AS login,
             SUM(e.input_tokens + e.output_tokens)::bigint AS total
      FROM token_events e JOIN users u ON u.id = e.user_id AND NOT u.hidden AND (NOT ${useDome}::boolean OR u.id = ANY(${memberIds}::int[]))
      GROUP BY e.provider, u.id, u.login, u.display_name
      ORDER BY e.provider, total DESC
    `,
    // Velocity: tokens/hour during hours the user was active (last 7d).
    sql`
      WITH hourly AS (
        SELECT u.id,
               COALESCE(u.display_name, u.login) AS login,
               CASE WHEN u.display_name IS NULL THEN u.avatar_url ELSE NULL END AS avatar_url,
               (e.ts / 3600000)::bigint AS hour_bucket,
               SUM(e.input_tokens + e.output_tokens) AS bucket_total
        FROM token_events e JOIN users u ON u.id = e.user_id AND NOT u.hidden AND (NOT ${useDome}::boolean OR u.id = ANY(${memberIds}::int[]))
        WHERE e.ts > ${weekAgo}
        GROUP BY u.id, u.login, u.display_name, u.avatar_url, hour_bucket
      )
      SELECT login, avatar_url,
             SUM(bucket_total)::bigint AS total_tokens,
             COUNT(*)::int AS active_hours,
             (SUM(bucket_total) / COUNT(*))::bigint AS tokens_per_hour
      FROM hourly
      GROUP BY login, avatar_url
      HAVING SUM(bucket_total) >= 100
      ORDER BY tokens_per_hour DESC LIMIT 50
    `,
    // Efficiency: output ÷ input. Floor of 1000 input tokens to filter out
    // someone who sent one 5-token request and "wins" with a 100x ratio.
    sql`
      SELECT COALESCE(u.display_name, u.login) AS login,
             CASE WHEN u.display_name IS NULL THEN u.avatar_url ELSE NULL END AS avatar_url,
             t.total_input::bigint AS input_tokens,
             t.total_output::bigint AS output_tokens,
             ROUND((t.total_output::numeric / NULLIF(t.total_input, 0)) * 100, 1) AS ratio_pct
      FROM totals t JOIN users u ON u.id = t.user_id AND NOT u.hidden AND (NOT ${useDome}::boolean OR u.id = ANY(${memberIds}::int[]))
      WHERE t.total_input >= 1000
      ORDER BY ratio_pct DESC NULLS LAST LIMIT 50
    `,
    // Per-user sparkline: 24 hourly buckets covering last 24h.
    sql`
      SELECT COALESCE(u.display_name, u.login) AS login,
             ((e.ts - ${dayAgo}) / 3600000)::int AS bucket,
             SUM(e.input_tokens + e.output_tokens)::bigint AS total
      FROM token_events e JOIN users u ON u.id = e.user_id AND NOT u.hidden AND (NOT ${useDome}::boolean OR u.id = ANY(${memberIds}::int[]))
      WHERE e.ts > ${dayAgo}
      GROUP BY u.login, u.display_name, bucket
      ORDER BY u.login, bucket
    `,
    sql`SELECT COUNT(*)::int AS c FROM token_events WHERE ts > ${minuteAgo}`,
    // Active trash-talk bubbles. Most-recent-per-target so a single row only
    // shows one bubble at a time even if N people are talking smack.
    sql`
      SELECT DISTINCT ON (target.id)
             COALESCE(target.display_name, target.login) AS to_login,
             COALESCE(sender.display_name, sender.login) AS from_login,
             tt.message,
             tt.expires_at
      FROM trash_talk tt
      JOIN users target ON target.id = tt.to_user_id AND NOT target.hidden
      JOIN users sender ON sender.id = tt.from_user_id AND NOT sender.hidden
      WHERE tt.expires_at > ${t}
      ORDER BY target.id, tt.created_at DESC
    `,
  ]);

  // Pivot sparkline rows into a {login: number[24]} map
  const spark: Record<string, number[]> = {};
  for (const row of sparklines as any[]) {
    const login = row.login as string;
    const bucket = Math.max(0, Math.min(23, Number(row.bucket)));
    (spark[login] ??= new Array(24).fill(0))[bucket] = Number(row.total) || 0;
  }

  // Pivot trash-talk into {to_login: {from, message, expires}} for the client
  const trash: Record<string, { from: string; message: string; expires_at: number }> = {};
  for (const row of trashTalk as any[]) {
    trash[row.to_login] = { from: row.from_login, message: row.message, expires_at: Number(row.expires_at) };
  }

  res.setHeader('cache-control', 'public, max-age=2, stale-while-revalidate=10');
  res.json({
    all_time: allTime,
    this_week: thisWeek,
    local_hero: localHero,
    by_provider: byProvider,
    velocity,
    efficiency,
    sparklines: spark,
    trash_talk: trash,
    events_per_min: (eventsPerMin as any[])[0]?.c || 0,
    server_time: t,
  });
}
