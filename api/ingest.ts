import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, now, hmacHex, sha256Hex } from '../lib/shared';
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

async function readRawBody(req: VercelRequest): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as any) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).send('method');

  const uid = req.headers['x-ta-user'] as string | undefined;
  const ts = req.headers['x-ta-ts'] as string | undefined;
  const sig = req.headers['x-ta-sig'] as string | undefined;
  if (!uid || !ts || !sig) return res.status(400).send('missing headers');
  if (Math.abs(now() - Number(ts)) > 60_000) return res.status(400).send('stale');

  const sql = db();
  const users = await sql`SELECT * FROM users WHERE id = ${Number(uid)}`;
  if (users.length === 0) return res.status(401).send('no user');
  const user = users[0] as any;

  const rawBody = await readRawBody(req);

  const bodyHash = sha256Hex(rawBody);
  const expected = hmacHex(user.agent_token, `${ts}.${bodyHash}`);
  if (expected.length !== sig.length || expected !== sig) {
    return res.status(401).send('bad signature');
  }

  let payload: { events: IncomingEvent[] };
  try { payload = JSON.parse(rawBody); }
  catch { return res.status(400).send('bad json'); }
  if (!Array.isArray(payload.events)) return res.status(400).send('no events');
  if (payload.events.length === 0) return res.json({ ok: true, accepted: 0 });
  if (payload.events.length > 500) return res.status(413).send('batch too large');

  const MAX = 2_000_000;
  let totalIn = 0, totalOut = 0, totalLocal = 0, totalCost = 0;
  const clean: (IncomingEvent & { cost_cents: number })[] = [];
  for (const e of payload.events) {
    const inp = Math.max(0, Math.min(MAX, (e.input_tokens | 0)));
    const out = Math.max(0, Math.min(MAX, (e.output_tokens | 0)));
    if (inp === 0 && out === 0) continue;
    const cr = ((e.cache_read_tokens ?? 0) | 0);
    const cw = ((e.cache_write_tokens ?? 0) | 0);
    const rt = ((e.reasoning_tokens ?? 0) | 0);
    const provider = String(e.provider).slice(0, 32);
    const model = String(e.model).slice(0, 64);
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
