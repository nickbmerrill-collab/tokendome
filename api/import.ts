/**
 * POST /api/import?p=anthropic|openai|csv
 *
 * Single dispatch endpoint for all backfill paths. Consolidated from the
 * previous per-provider files to stay under Vercel's 12-function Hobby cap.
 *
 * - p=anthropic | p=openai → body { admin_key, days? } → hit provider Admin API
 * - p=csv                  → body { csv, provider }    → parse pasted CSV
 *
 * All paths use the same idempotent write: delete prior import for
 * (user, source, provider), insert new rows, recompute totals.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, now, getCurrentUser } from '../lib/shared';
import { costCents } from '../lib/pricing';

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

const MAX_PAGES = 50;
const MAX_DAYS = 365;
const MAX_CSV_ROWS = 50_000;

type Row = {
  ts: number; provider: string; model: string;
  input: number; output: number; cacheR: number; cacheW: number; cost: number;
};

function safeJSON(s: string): any { try { return JSON.parse(s); } catch { return {}; } }

// Tiny CSV parser; quoted fields with "" escapes; ignores blank lines.
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let field = ''; let inQ = false;
  const eol = () => { row.push(field); rows.push(row); row = []; field = ''; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') eol();
      else field += c;
    }
  }
  if (field || row.length) eol();
  return rows.filter(r => r.length > 1 || (r[0] && r[0].trim()));
}

function findCol(headers: string[], pred: (h: string) => boolean): number {
  return headers.findIndex(h => pred(h.toLowerCase().trim()));
}

// ─── Provider fetchers ──────────────────────────────────────────────────────

async function fetchAnthropic(adminKey: string, days: number): Promise<{ rows: Row[]; meta: any }> {
  const endingAt = new Date();
  const startingAt = new Date(endingAt.getTime() - days * 86400 * 1000);
  const buckets: any[] = [];
  let page: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const url = new URL('https://api.anthropic.com/v1/organizations/usage_report/messages');
    url.searchParams.set('starting_at', startingAt.toISOString());
    url.searchParams.set('ending_at', endingAt.toISOString());
    url.searchParams.set('bucket_width', '1d');
    if (page) url.searchParams.set('page', page);
    const r = await fetch(url, {
      headers: { 'x-api-key': adminKey, 'anthropic-version': '2023-06-01', 'accept': 'application/json' },
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      const e: any = new Error(r.status === 401
        ? 'Anthropic rejected the admin key. Generate one at console.anthropic.com → Settings → API Keys → Create Admin Key.'
        : 'Anthropic Admin API returned ' + r.status);
      e.status = r.status === 401 ? 401 : 502;
      e.upstream = errText.slice(0, 500);
      throw e;
    }
    const j: any = await r.json();
    if (Array.isArray(j.data)) buckets.push(...j.data);
    if (!j.has_more || !j.next_page) break;
    page = j.next_page;
  }
  const rows: Row[] = [];
  for (const bucket of buckets) {
    const ts = Date.parse(bucket.ending_at);
    if (!Number.isFinite(ts)) continue;
    for (const r of (bucket.results || [])) {
      const uncached = r.uncached_input_tokens || 0;
      const cacheR = r.cache_read_input_tokens || 0;
      const cacheW = r.cache_creation_input_tokens || 0;
      const out = r.output_tokens || 0;
      const input = (r.input_tokens != null ? r.input_tokens : uncached) + cacheW;
      if (input === 0 && out === 0) continue;
      const model = String(r.model || 'unknown').slice(0, 64);
      rows.push({ ts, provider: 'anthropic', model, input, output: out, cacheR, cacheW, cost: costCents('anthropic', model, input, out, cacheR, cacheW) });
    }
  }
  return { rows, meta: { buckets_seen: buckets.length } };
}

async function fetchOpenAI(adminKey: string, days: number): Promise<{ rows: Row[]; meta: any }> {
  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - days * 86400;
  const buckets: any[] = [];
  let page: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const url = new URL('https://api.openai.com/v1/organization/usage/completions');
    url.searchParams.set('start_time', String(startTime));
    url.searchParams.set('end_time', String(endTime));
    url.searchParams.set('bucket_width', '1d');
    url.searchParams.set('group_by', 'model');
    if (page) url.searchParams.set('page', page);
    const r = await fetch(url, {
      headers: { 'authorization': `Bearer ${adminKey}`, 'accept': 'application/json' },
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      const e: any = new Error(r.status === 401
        ? 'OpenAI rejected the admin key. Make sure it has org-admin scope at platform.openai.com → Settings → Admin keys.'
        : 'OpenAI usage API returned ' + r.status);
      e.status = r.status === 401 ? 401 : 502;
      e.upstream = errText.slice(0, 500);
      throw e;
    }
    const j: any = await r.json();
    if (Array.isArray(j.data)) buckets.push(...j.data);
    if (!j.has_more || !j.next_page) break;
    page = j.next_page;
  }
  const rows: Row[] = [];
  for (const bucket of buckets) {
    const ts = (bucket.end_time || 0) * 1000;
    if (!Number.isFinite(ts) || ts <= 0) continue;
    for (const r of (bucket.results || [])) {
      const input = r.input_tokens || 0;
      const out = r.output_tokens || 0;
      const cacheR = r.input_cached_tokens || 0;
      if (input === 0 && out === 0) continue;
      const model = String(r.model || 'unknown').slice(0, 64);
      rows.push({ ts, provider: 'openai', model, input, output: out, cacheR, cacheW: 0, cost: costCents('openai', model, input, out, cacheR, 0) });
    }
  }
  return { rows, meta: { buckets_seen: buckets.length } };
}

function parseFromCSV(csv: string, provider: string): { rows: Row[]; headersSeen?: string[] } {
  const parsed = parseCSV(csv);
  if (parsed.length < 2) {
    const e: any = new Error('CSV needs a header row + at least one data row');
    e.status = 400;
    throw e;
  }
  const headers = parsed[0];
  const ixDate   = findCol(headers, h => /(^|\b)(date|day|timestamp|period|when)\b/.test(h));
  const ixModel  = findCol(headers, h => /\bmodel\b/.test(h));
  const ixIn     = findCol(headers, h => /input.*token|prompt.*token|tokens?\s*in\b|^input$/.test(h));
  const ixOut    = findCol(headers, h => /output.*token|completion.*token|tokens?\s*out\b|^output$/.test(h));
  const ixCacheR = findCol(headers, h => /cache.*read|cached/.test(h));
  const ixCacheW = findCol(headers, h => /cache.*(creation|write)/.test(h));
  if (ixDate < 0 || ixIn < 0 || ixOut < 0) {
    const e: any = new Error('Could not find required columns. Need date, input_tokens, output_tokens.');
    e.status = 400;
    e.headersSeen = headers;
    throw e;
  }
  const rows: Row[] = [];
  for (let r = 1; r < parsed.length; r++) {
    if (rows.length >= MAX_CSV_ROWS) break;
    const cells = parsed[r];
    const dateStr = (cells[ixDate] || '').trim();
    if (!dateStr) continue;
    const isoCandidate = /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? `${dateStr}T23:59:59Z` : dateStr;
    const ts = Date.parse(isoCandidate);
    if (!Number.isFinite(ts)) continue;
    const input = Math.max(0, Math.floor(Number((cells[ixIn] || '0').replace(/[,$ ]/g, '')) || 0));
    const out = Math.max(0, Math.floor(Number((cells[ixOut] || '0').replace(/[,$ ]/g, '')) || 0));
    if (input === 0 && out === 0) continue;
    const cacheR = ixCacheR >= 0 ? Math.max(0, Math.floor(Number((cells[ixCacheR] || '0').replace(/[,$ ]/g, '')) || 0)) : 0;
    const cacheW = ixCacheW >= 0 ? Math.max(0, Math.floor(Number((cells[ixCacheW] || '0').replace(/[,$ ]/g, '')) || 0)) : 0;
    const model = (ixModel >= 0 ? (cells[ixModel] || '').trim() : 'unknown').slice(0, 64) || 'unknown';
    const cost = costCents(provider, model, input, out, cacheR, cacheW);
    rows.push({ ts, provider, model, input, output: out, cacheR, cacheW, cost });
  }
  return { rows };
}

// ─── Shared write path ───────────────────────────────────────────────────────

// Stale-lock TTL. Imports that exceed this without releasing are treated
// as crashed and the lock can be reclaimed. Anthropic backfill of 365 days
// pages typically completes well under a minute; 5 minutes is generous.
const IMPORT_LOCK_TTL_MS = 5 * 60 * 1000;

async function acquireImportLock(userId: number, provider: string, source: string): Promise<boolean> {
  const sql = db();
  const t = now();
  // Reclaim stale locks first so a crashed import doesn't permanently
  // block the user. The PK on (user_id, provider, source) means we either
  // refresh the timestamp on a stale row or no-op on a live one.
  await sql`
    DELETE FROM import_locks
    WHERE user_id = ${userId} AND provider = ${provider} AND source = ${source}
      AND created_at < ${t - IMPORT_LOCK_TTL_MS}
  `;
  const acq = await sql`
    INSERT INTO import_locks (user_id, provider, source, created_at)
    VALUES (${userId}, ${provider}, ${source}, ${t})
    ON CONFLICT DO NOTHING
    RETURNING 1
  `;
  return (acq as any[]).length > 0;
}

async function releaseImportLock(userId: number, provider: string, source: string): Promise<void> {
  const sql = db();
  await sql`
    DELETE FROM import_locks
    WHERE user_id = ${userId} AND provider = ${provider} AND source = ${source}
  `;
}

async function applyImport(userId: number, provider: string, source: string, rows: Row[]): Promise<{ totalIn: number; totalOut: number; totalCost: number }> {
  const sql = db();
  await sql`DELETE FROM token_events WHERE user_id = ${userId} AND source = ${source} AND provider = ${provider}`;
  let totalIn = 0, totalOut = 0, totalCost = 0;
  if (rows.length > 0) {
    const userIds = rows.map(() => userId);
    const tss = rows.map(r => r.ts);
    const provs = rows.map(r => r.provider);
    const models = rows.map(r => r.model);
    const ins = rows.map(r => r.input);
    const outs = rows.map(r => r.output);
    const crs = rows.map(r => r.cacheR);
    const cws = rows.map(r => r.cacheW);
    const costs = rows.map(r => r.cost);
    const sources = rows.map(() => source);
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
  await sql`
    INSERT INTO totals (user_id, total_input, total_output, local_tokens, total_cost_cents, updated_at)
    SELECT ${userId},
           COALESCE(SUM(input_tokens), 0),
           COALESCE(SUM(output_tokens), 0),
           COALESCE(SUM(CASE WHEN is_local THEN input_tokens + output_tokens ELSE 0 END), 0),
           COALESCE(SUM(cost_cents), 0),
           ${now()}
    FROM token_events WHERE user_id = ${userId}
    ON CONFLICT (user_id) DO UPDATE SET
      total_input = EXCLUDED.total_input,
      total_output = EXCLUDED.total_output,
      local_tokens = EXCLUDED.local_tokens,
      total_cost_cents = EXCLUDED.total_cost_cents,
      updated_at = EXCLUDED.updated_at
  `;
  return { totalIn, totalOut, totalCost };
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

// Run an import path with a (user, provider, source) lock so concurrent
// callers can't race the delete/insert/recompute pattern in applyImport
// and end up double-counting. The lock is released in finally even when
// the upstream Admin API or DB throws.
async function withImportLock<T>(
  userId: number, provider: string, source: string,
  fn: () => Promise<T>,
): Promise<T> {
  const got = await acquireImportLock(userId, provider, source);
  if (!got) {
    const e: any = new Error('another import is already running for this provider — try again in a minute');
    e.status = 409;
    throw e;
  }
  try {
    return await fn();
  } finally {
    await releaseImportLock(userId, provider, source);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'sign in first' });

  const p = String(req.query.p || '').toLowerCase();
  const body: any = typeof req.body === 'string' ? safeJSON(req.body) : (req.body || {});

  try {
    if (p === 'anthropic') {
      const adminKey = String(body.admin_key || '').trim();
      const days = Math.min(MAX_DAYS, Math.max(1, Math.floor(Number(body.days) || 90)));
      if (!adminKey.startsWith('sk-ant-admin01-')) {
        return res.status(400).json({ error: 'expected an Anthropic Admin API key (sk-ant-admin01-…). Generate at console.anthropic.com → Settings → API Keys → Create Admin Key.' });
      }
      const result = await withImportLock(user.id, 'anthropic', 'admin_import', async () => {
        const { rows, meta } = await fetchAnthropic(adminKey, days);
        const totals = await applyImport(user.id, 'anthropic', 'admin_import', rows);
        return { rows, meta, totals };
      });
      return res.json({ ok: true, days, buckets_seen: result.meta.buckets_seen, rows_imported: result.rows.length, totals: { input: result.totals.totalIn, output: result.totals.totalOut, cost_cents: result.totals.totalCost } });
    }
    if (p === 'openai') {
      const adminKey = String(body.admin_key || '').trim();
      const days = Math.min(MAX_DAYS, Math.max(1, Math.floor(Number(body.days) || 90)));
      if (!adminKey.startsWith('sk-')) {
        return res.status(400).json({ error: 'expected an OpenAI admin key (sk-…) with org-admin scope. Generate at platform.openai.com → Settings → Admin keys.' });
      }
      const result = await withImportLock(user.id, 'openai', 'admin_import', async () => {
        const { rows, meta } = await fetchOpenAI(adminKey, days);
        const totals = await applyImport(user.id, 'openai', 'admin_import', rows);
        return { rows, meta, totals };
      });
      return res.json({ ok: true, days, buckets_seen: result.meta.buckets_seen, rows_imported: result.rows.length, totals: { input: result.totals.totalIn, output: result.totals.totalOut, cost_cents: result.totals.totalCost } });
    }
    if (p === 'csv') {
      const csv = String(body.csv || '');
      const csvProvider = String(body.provider || 'anthropic').toLowerCase();
      if (!csv.trim()) return res.status(400).json({ error: 'csv body required' });
      if (!['anthropic', 'openai', 'google', 'ollama'].includes(csvProvider)) {
        return res.status(400).json({ error: 'provider must be anthropic|openai|google|ollama' });
      }
      const { rows } = parseFromCSV(csv, csvProvider);
      if (rows.length === 0) return res.status(400).json({ error: 'No usable rows after parsing — check that token columns are numeric and date column parses.' });
      const totals = await withImportLock(user.id, csvProvider, 'csv_import', async () => {
        return await applyImport(user.id, csvProvider, 'csv_import', rows);
      });
      return res.json({ ok: true, provider: csvProvider, rows_imported: rows.length, totals: { input: totals.totalIn, output: totals.totalOut, cost_cents: totals.totalCost } });
    }
    return res.status(400).json({ error: 'unknown provider — use ?p=anthropic|openai|csv' });
  } catch (e: any) {
    // Don't leak upstream provider response bodies to the client. Audit
    // flagged the previous behavior (passing `e.upstream` through) as info-
    // disclosure when admin keys are wrong, expired, or rate-limited.
    return res.status(e.status || 500).json({
      error: e.message || 'failed',
      headers_seen: e.headersSeen,
    });
  }
}
