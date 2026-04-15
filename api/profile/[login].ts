import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, now } from '../../lib/shared';

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
    // Three rank lookups in one shot via window functions
    sql`
      WITH at_rank AS (
        SELECT user_id, RANK() OVER (ORDER BY (total_input + total_output) DESC) AS r
        FROM totals
      ),
      wk_rank AS (
        SELECT user_id, RANK() OVER (ORDER BY SUM(input_tokens + output_tokens) DESC) AS r
        FROM token_events WHERE ts > ${weekAgo} GROUP BY user_id
      ),
      lh_rank AS (
        SELECT user_id, RANK() OVER (ORDER BY local_tokens DESC) AS r
        FROM totals WHERE local_tokens > 0
      )
      SELECT
        (SELECT r FROM at_rank WHERE user_id = ${userId})::int AS all_time,
        (SELECT r FROM wk_rank WHERE user_id = ${userId})::int AS this_week,
        (SELECT r FROM lh_rank WHERE user_id = ${userId})::int AS local_hero
    `,
  ]);

  res.setHeader('cache-control', 'public, max-age=5, stale-while-revalidate=30');
  res.json({
    login: publicLogin,
    avatar_url: publicAvatar,
    created_at: Number(u.created_at),
    lifetime: {
      total_input: Number(u.total_input || 0),
      total_output: Number(u.total_output || 0),
      local_tokens: Number(u.local_tokens || 0),
      total_cost_cents: Number(u.total_cost_cents || 0),
      total: Number(u.total_input || 0) + Number(u.total_output || 0),
    },
    series_30d: series,
    by_model: byModel,
    by_provider: byProvider,
    ranks: (ranks as any[])[0] || { all_time: null, this_week: null, local_hero: null },
    server_time: t,
  });
}
