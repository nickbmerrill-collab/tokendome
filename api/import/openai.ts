/**
 * POST /api/import/openai
 *
 * Backfills the signed-in user's leaderboard from OpenAI's organization
 * usage API (/v1/organization/usage/completions). Requires an admin key with
 * org-admin role. Same idempotency model as the Anthropic import:
 * source='admin_import', delete-then-reinsert.
 *
 * Body: { admin_key: "sk-…", days?: 90 }
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, now, getCurrentUser } from '../../lib/shared';
import { costCents } from '../../lib/pricing';

export const config = { api: { bodyParser: { sizeLimit: '8kb' } } };

type Bucket = {
  object: 'bucket';
  start_time: number; // unix seconds
  end_time: number;
  results: Array<{
    input_tokens?: number;
    output_tokens?: number;
    input_cached_tokens?: number;
    model?: string;
  }>;
};
type OpenAIUsageResponse = {
  data: Bucket[];
  has_more?: boolean;
  next_page?: string | null;
};

const MAX_PAGES = 50;
const MAX_DAYS = 365;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'sign in first' });

  const body: any = typeof req.body === 'string' ? safeJSON(req.body) : (req.body || {});
  const adminKey = String(body.admin_key || '').trim();
  const days = Math.min(MAX_DAYS, Math.max(1, Math.floor(Number(body.days) || 90)));

  // OpenAI admin keys don't have a recognizable prefix (just sk-…), so we
  // can't format-validate. Light sanity check then let the upstream tell us.
  if (!adminKey.startsWith('sk-')) {
    return res.status(400).json({
      error: 'expected an OpenAI admin key (sk-…) with org-admin scope. Generate at platform.openai.com → Settings → Admin keys.',
    });
  }

  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - days * 86400;

  // Page through the usage API
  const buckets: Bucket[] = [];
  let page: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const url = new URL('https://api.openai.com/v1/organization/usage/completions');
    url.searchParams.set('start_time', String(startTime));
    url.searchParams.set('end_time', String(endTime));
    url.searchParams.set('bucket_width', '1d');
    url.searchParams.set('group_by', 'model');
    if (page) url.searchParams.set('page', page);

    const r = await fetch(url, {
      headers: {
        'authorization': `Bearer ${adminKey}`,
        'accept': 'application/json',
      },
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      return res.status(r.status === 401 ? 401 : 502).json({
        error: r.status === 401
          ? 'OpenAI rejected the admin key. Make sure it has org-admin scope at platform.openai.com → Settings → Admin keys.'
          : 'OpenAI usage API returned ' + r.status,
        upstream: errText.slice(0, 500),
      });
    }
    const j = await r.json() as OpenAIUsageResponse;
    if (Array.isArray(j.data)) buckets.push(...j.data);
    if (!j.has_more || !j.next_page) break;
    page = j.next_page;
  }

  type Row = {
    ts: number; provider: string; model: string;
    input: number; output: number; cacheR: number;
    cost: number;
  };
  const rows: Row[] = [];
  for (const bucket of buckets) {
    // ts = end-of-bucket in ms
    const ts = (bucket.end_time || 0) * 1000;
    if (!Number.isFinite(ts) || ts <= 0) continue;
    for (const r of (bucket.results || [])) {
      const input = r.input_tokens || 0;
      const out = r.output_tokens || 0;
      const cacheR = r.input_cached_tokens || 0;
      if (input === 0 && out === 0) continue;
      const model = String(r.model || 'unknown').slice(0, 64);
      const cost = costCents('openai', model, input, out, cacheR, 0);
      rows.push({ ts, provider: 'openai', model, input, output: out, cacheR, cost });
    }
  }

  const sql = db();
  // Wipe previous import — same idempotent re-import as Anthropic. Provider-
  // scoped delete so a user can have BOTH anthropic and openai imports
  // coexisting cleanly.
  await sql`DELETE FROM token_events WHERE user_id = ${user.id} AND source = 'admin_import' AND provider = 'openai'`;

  let totalIn = 0, totalOut = 0, totalCost = 0;
  if (rows.length > 0) {
    const userIds = rows.map(() => user.id);
    const tss = rows.map(r => r.ts);
    const provs = rows.map(r => r.provider);
    const models = rows.map(r => r.model);
    const ins = rows.map(r => r.input);
    const outs = rows.map(r => r.output);
    const crs = rows.map(r => r.cacheR);
    const cws = rows.map(() => 0);
    const costs = rows.map(r => r.cost);
    const sources = rows.map(() => 'admin_import');

    await sql`
      INSERT INTO token_events
        (user_id, ts, provider, model, is_local, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_cents, source)
      SELECT user_id, ts, provider, model, false, input, output,
             cr, cw, 0, cost, source
      FROM UNNEST(
        ${userIds}::int[], ${tss}::bigint[], ${provs}::text[], ${models}::text[],
        ${ins}::int[], ${outs}::int[], ${crs}::int[], ${cws}::int[],
        ${costs}::int[], ${sources}::text[]
      ) AS t(user_id, ts, provider, model, input, output, cr, cw, cost, source)
    `;

    totalIn = rows.reduce((s, r) => s + r.input, 0);
    totalOut = rows.reduce((s, r) => s + r.output, 0);
    totalCost = rows.reduce((s, r) => s + r.cost, 0);
  }

  // Recompute totals from scratch from all events
  await sql`
    INSERT INTO totals (user_id, total_input, total_output, local_tokens, total_cost_cents, updated_at)
    SELECT
      ${user.id},
      COALESCE(SUM(input_tokens), 0),
      COALESCE(SUM(output_tokens), 0),
      COALESCE(SUM(CASE WHEN is_local THEN input_tokens + output_tokens ELSE 0 END), 0),
      COALESCE(SUM(cost_cents), 0),
      ${now()}
    FROM token_events
    WHERE user_id = ${user.id}
    ON CONFLICT (user_id) DO UPDATE SET
      total_input      = EXCLUDED.total_input,
      total_output     = EXCLUDED.total_output,
      local_tokens     = EXCLUDED.local_tokens,
      total_cost_cents = EXCLUDED.total_cost_cents,
      updated_at       = EXCLUDED.updated_at
  `;

  res.json({
    ok: true,
    days,
    buckets_seen: buckets.length,
    rows_imported: rows.length,
    totals: { input: totalIn, output: totalOut, cost_cents: totalCost },
  });
}

function safeJSON(s: string): any { try { return JSON.parse(s); } catch { return {}; } }
