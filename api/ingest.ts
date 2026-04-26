import type { VercelRequest, VercelResponse } from '@vercel/node';
import * as crypto from 'node:crypto';
import { db, now, hmacHex, sha256Hex, decryptAgentToken, rateCheck } from '../lib/shared';
import { costCents } from '../lib/pricing';

type IncomingEvent = {
  ts: number;
  provider: string;
  model: string;
  is_local?: boolean;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
};

// Disable the default body parser so we can verify the HMAC against the exact
// bytes the agent signed. JSON-parse-then-restringify isn't byte-stable
// (whitespace, escape sequences, non-ASCII), and a single mismatched byte
// fails the signature check.
export const config = { api: { bodyParser: false } };

const BODY_LIMIT = 512 * 1024; // 512 KB; ~ample for 500 compact events
const DRIFT_MS = 60_000;
const MAX_BATCH = 500;
const MAX_TOKENS_PER_FIELD = 2_000_000;

async function readRawBody(req: VercelRequest, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as any) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += b.length;
    if (total > limit) {
      const e: any = new Error('body too large');
      e.status = 413;
      throw e;
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).send('method');

  const uid = req.headers['x-ta-user'] as string | undefined;
  const ts = req.headers['x-ta-ts'] as string | undefined;
  const sig = req.headers['x-ta-sig'] as string | undefined;
  if (!uid || !ts || !sig) return res.status(400).send('missing headers');
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(now() - tsNum) > DRIFT_MS) {
    return res.status(400).send('stale');
  }

  const sql = db();
  const users = await sql`SELECT * FROM users WHERE id = ${Number(uid)}`;
  if (users.length === 0) return res.status(401).send('no user');
  const user = users[0] as any;

  // Per-user durable rate limit. Burst-tolerant: 600 ingest calls per minute
  // is well above what an honest agent (3s flush cadence × N processes) hits.
  // Replay protection still applies on top of this.
  const rl = await rateCheck(`ingest:user:${user.id}`, 600, 60_000);
  if (!rl.ok) {
    res.setHeader('Retry-After', String(Math.ceil((rl.retry_after_ms ?? 60_000) / 1000)));
    return res.status(429).send('rate limited');
  }

  let rawBody: string;
  try {
    rawBody = await readRawBody(req, BODY_LIMIT);
  } catch (e: any) {
    return res.status(e.status || 500).send(e.message || 'read failed');
  }

  const bodyHash = sha256Hex(rawBody);
  // Decrypt the stored agent token before recomputing the HMAC. Legacy
  // (pre-encryption) rows pass through unchanged via decryptAgentToken.
  const userSecret = decryptAgentToken(user.agent_token);
  const expected = hmacHex(userSecret, `${ts}.${bodyHash}`);
  if (!timingSafeEqualHex(expected, sig)) {
    return res.status(401).send('bad signature');
  }

  // Replay protection. Within the 60s drift window, the same (user, ts,
  // body_hash) tuple must only be accepted once. We swallow the dupe at
  // the unique-key level so concurrent retries from a flaky network don't
  // get double-counted, and a captured/replayed signed body is rejected.
  const seen = await sql`
    INSERT INTO ingest_requests (user_id, ts, body_hash, created_at)
    VALUES (${user.id}, ${tsNum}, ${bodyHash}, ${now()})
    ON CONFLICT DO NOTHING
    RETURNING 1
  `;
  if ((seen as any[]).length === 0) return res.status(409).send('replay');

  let payload: { events: IncomingEvent[] };
  try { payload = JSON.parse(rawBody); }
  catch { return res.status(400).send('bad json'); }
  if (!Array.isArray(payload.events)) return res.status(400).send('no events');
  if (payload.events.length === 0) return res.json({ ok: true, accepted: 0 });
  if (payload.events.length > MAX_BATCH) return res.status(413).send('batch too large');

  // Pre-validate the entire batch before any DB write — a single bad event
  // rejects the whole batch rather than silently dropping it. Caps are hard
  // rejects (413), not clamps; matches the public claim.
  const clean: (IncomingEvent & { cost_cents: number })[] = [];
  let totalIn = 0, totalOut = 0, totalLocal = 0, totalCost = 0;
  for (const e of payload.events) {
    const inp = Number(e.input_tokens);
    const out = Number(e.output_tokens);
    if (!Number.isInteger(inp) || !Number.isInteger(out) || inp < 0 || out < 0) {
      return res.status(400).send('non-integer or negative token field');
    }
    if (inp > MAX_TOKENS_PER_FIELD || out > MAX_TOKENS_PER_FIELD) {
      return res.status(413).send('event too large');
    }
    if (inp === 0 && out === 0) continue;
    const cr = Math.max(0, Number(e.cache_read_tokens) | 0);
    const cw = Math.max(0, Number(e.cache_write_tokens) | 0);
    const rt = Math.max(0, Number(e.reasoning_tokens) | 0);
    const provider = String(e.provider || '').slice(0, 32);
    const model = String(e.model || '').slice(0, 64);
    const cost = e.is_local ? 0 : costCents(provider, model, inp, out, cr, cw);
    // CAREFUL: don't use `| 0` on ts — Date.now() doesn't fit in int32 and
    // gets truncated to a negative number, which silently breaks all
    // time-windowed queries (this_week, velocity, etc.).
    clean.push({
      ts: Math.max(0, Math.floor(Number(e.ts) || 0)),
      provider, model, is_local: !!e.is_local,
      input_tokens: inp, output_tokens: out,
      cache_read_tokens: cr, cache_write_tokens: cw, reasoning_tokens: rt,
      cost_cents: cost,
    });
    totalIn += inp; totalOut += out; totalCost += cost;
    if (e.is_local) totalLocal += inp + out;
  }
  if (clean.length === 0) return res.json({ ok: true, accepted: 0 });

  // Batch insert with UNNEST — single round trip
  const userIds = clean.map(() => user.id);
  const tss = clean.map(e => e.ts);
  const providers = clean.map(e => e.provider);
  const models = clean.map(e => e.model);
  const locals = clean.map(e => e.is_local);
  const ins = clean.map(e => e.input_tokens);
  const outs = clean.map(e => e.output_tokens);
  const crs = clean.map(e => e.cache_read_tokens || 0);
  const cws = clean.map(e => e.cache_write_tokens || 0);
  const rts = clean.map(e => e.reasoning_tokens || 0);
  const costs = clean.map(e => e.cost_cents);

  await sql`
    INSERT INTO token_events
      (user_id, ts, provider, model, is_local, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_cents)
    SELECT * FROM UNNEST(
      ${userIds}::int[], ${tss}::bigint[], ${providers}::text[], ${models}::text[],
      ${locals}::boolean[], ${ins}::int[], ${outs}::int[],
      ${crs}::int[], ${cws}::int[], ${rts}::int[], ${costs}::int[]
    )
  `;

  await sql`
    INSERT INTO totals (user_id, total_input, total_output, local_tokens, total_cost_cents, updated_at)
    VALUES (${user.id}, ${totalIn}, ${totalOut}, ${totalLocal}, ${totalCost}, ${now()})
    ON CONFLICT (user_id) DO UPDATE SET
      total_input       = totals.total_input + EXCLUDED.total_input,
      total_output      = totals.total_output + EXCLUDED.total_output,
      local_tokens      = totals.local_tokens + EXCLUDED.local_tokens,
      total_cost_cents  = totals.total_cost_cents + EXCLUDED.total_cost_cents,
      updated_at        = EXCLUDED.updated_at
  `;

  res.json({ ok: true, accepted: clean.length });
}
