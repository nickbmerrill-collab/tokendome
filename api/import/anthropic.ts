/**
 * POST /api/import/anthropic
 *
 * Backfills the signed-in user's leaderboard totals from Anthropic's Admin API.
 * Pulls daily token usage broken down by model, then writes synthetic events
 * into token_events with source='admin_import' (so we can re-run without
 * double-counting).
 *
 * Body:
 *   { admin_key: "sk-ant-admin01-…", days?: 90 }
 *
 * The admin key is used once for this request and never persisted anywhere.
 *
 * Requires the user to be signed in via GitHub (session cookie).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, now, getCurrentUser } from '../../lib/shared';
import { costCents } from '../../lib/pricing';

// Don't use Vercel's default body parser so we can be strict about size.
export const config = { api: { bodyParser: { sizeLimit: '8kb' } } };

type Bucket = {
  starting_at: string;
  ending_at: string;
  results: Array<{
    uncached_input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
    input_tokens?: number;
    model?: string;
    service_tier?: string;
    api_key_id?: string;
  }>;
};

type AnthropicUsageResponse = {
  data: Bucket[];
  has_more?: boolean;
  next_page?: string | null;
};

const MAX_PAGES = 50; // hard cap so a runaway pagination can't burn the function budget
const MAX_DAYS = 365;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'sign in first' });

  const body: any = typeof req.body === 'string' ? safeJSON(req.body) : (req.body || {});
  const adminKey = String(body.admin_key || '').trim();
  const days = Math.min(MAX_DAYS, Math.max(1, Math.floor(Number(body.days) || 90)));

  if (!adminKey.startsWith('sk-ant-admin01-')) {
    return res.status(400).json({
      error: 'expected an Anthropic Admin API key (sk-ant-admin01-…). ' +
             'Generate one at console.anthropic.com → Settings → API Keys → Create Admin Key.',
    });
  }

  const endingAt = new Date();
  const startingAt = new Date(endingAt.getTime() - days * 86400 * 1000);

  // Page through the Admin API
  const buckets: Bucket[] = [];
  let page: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const url = new URL('https://api.anthropic.com/v1/organizations/usage_report/messages');
    url.searchParams.set('starting_at', startingAt.toISOString());
    url.searchParams.set('ending_at', endingAt.toISOString());
    url.searchParams.set('bucket_width', '1d');
    if (page) url.searchParams.set('page', page);

    const r = await fetch(url, {
      headers: {
        'x-api-key': adminKey,
        'anthropic-version': '2023-06-01',
        'accept': 'application/json',
      },
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      return res.status(r.status === 401 ? 401 : 502).json({
        error: r.status === 401
          ? 'Anthropic rejected the admin key. Check the value at console.anthropic.com.'
          : 'Anthropic Admin API returned ' + r.status,
        upstream: errText.slice(0, 500),
      });
    }
    const j = await r.json() as AnthropicUsageResponse;
    if (Array.isArray(j.data)) buckets.push(...j.data);
    if (!j.has_more || !j.next_page) break;
    page = j.next_page;
  }

  // Flatten buckets → one event row per (day × model)
  type Row = {
    ts: number; provider: string; model: string;
    input: number; output: number; cacheR: number; cacheW: number;
    cost: number;
  };
  const rows: Row[] = [];
  for (const bucket of buckets) {
    // ts at the END of the bucket so it falls into the right rolling-window
    // ("last 7 days", etc.) without leaking into the next one.
    const ts = Date.parse(bucket.ending_at);
    if (!Number.isFinite(ts)) continue;
    for (const r of (bucket.results || [])) {
      const uncached = r.uncached_input_tokens || 0;
      const cacheR = r.cache_read_input_tokens || 0;
      const cacheW = r.cache_creation_input_tokens || 0;
      const out = r.output_tokens || 0;
      // Anthropic's `input_tokens` (when present) already excludes cached & creation.
      // Compose total input as uncached + cache writes (cache reads are billed
      // separately at a discount, accounted for in cost_cents).
      const input = (r.input_tokens != null ? r.input_tokens : uncached) + cacheW;
      if (input === 0 && out === 0) continue;
      const model = String(r.model || 'unknown').slice(0, 64);
      const cost = costCents('anthropic', model, input, out, cacheR, cacheW);
      rows.push({ ts, provider: 'anthropic', model, input, output: out, cacheR, cacheW, cost });
    }
  }

  const sql = db();
  // Idempotency: wipe prior Anthropic admin-imports for this user, then
  // re-insert. Provider-scoped so a previous OpenAI import isn't disturbed.
  await sql`DELETE FROM token_events WHERE user_id = ${user.id} AND source = 'admin_import' AND provider = 'anthropic'`;

  let totalIn = 0, totalOut = 0, totalCost = 0;
  if (rows.length > 0) {
    const userIds = rows.map(() => user.id);
    const tss = rows.map(r => r.ts);
    const provs = rows.map(r => r.provider);
    const models = rows.map(r => r.model);
    const ins = rows.map(r => r.input);
    const outs = rows.map(r => r.output);
    const crs = rows.map(r => r.cacheR);
    const cws = rows.map(r => r.cacheW);
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

  // Recompute totals from scratch — simpler than reconciling deltas across
  // mixed sources, and a single SUM query is fine at our scale.
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
