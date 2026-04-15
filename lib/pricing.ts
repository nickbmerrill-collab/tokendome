/**
 * Approximate USD pricing per 1M tokens. Snapshot as of April 2026.
 * Prefix-matched: longest matching prefix wins. Local providers are $0.
 *
 * This is intentionally a best-effort table — the leaderboard labels the
 * stat as "approximate $ burned" to set expectations. Add rows as new
 * models ship.
 */
export type PriceRow = { input: number; output: number; cache_read?: number; cache_write?: number };

// Map: "<provider>:<model-prefix>" → PriceRow (USD per 1M tokens)
export const PRICES: Record<string, PriceRow> = {
  // ── OpenAI ────────────────────────────────────────────────────
  'openai:gpt-4o-mini':       { input: 0.15,  output: 0.60 },
  'openai:gpt-4o':            { input: 2.50,  output: 10.00, cache_read: 1.25 },
  'openai:gpt-4.1-nano':      { input: 0.10,  output: 0.40 },
  'openai:gpt-4.1-mini':      { input: 0.40,  output: 1.60 },
  'openai:gpt-4.1':           { input: 2.00,  output: 8.00,  cache_read: 0.50 },
  'openai:o3-mini':           { input: 1.10,  output: 4.40 },
  'openai:o3':                { input: 10.00, output: 40.00 },
  'openai:o1-mini':           { input: 1.10,  output: 4.40 },
  'openai:o1':                { input: 15.00, output: 60.00 },
  'openai:text-embedding-3':  { input: 0.02,  output: 0 },
  // fallback: any other OpenAI model
  'openai:':                  { input: 2.50,  output: 10.00 },

  // ── Anthropic ─────────────────────────────────────────────────
  'anthropic:claude-opus':    { input: 15.00, output: 75.00, cache_read: 1.50, cache_write: 18.75 },
  'anthropic:claude-sonnet':  { input: 3.00,  output: 15.00, cache_read: 0.30, cache_write: 3.75 },
  'anthropic:claude-haiku':   { input: 0.80,  output: 4.00,  cache_read: 0.08, cache_write: 1.00 },
  'anthropic:claude-3-5-son': { input: 3.00,  output: 15.00 },
  'anthropic:claude-3-5-hai': { input: 0.80,  output: 4.00 },
  'anthropic:claude-3-opus':  { input: 15.00, output: 75.00 },
  'anthropic:':               { input: 3.00,  output: 15.00 },

  // ── Google ────────────────────────────────────────────────────
  'google:gemini-2.5-flash':  { input: 0.30,  output: 2.50 },
  'google:gemini-2.5-pro':    { input: 2.50,  output: 15.00 },
  'google:gemini-1.5-flash':  { input: 0.075, output: 0.30 },
  'google:gemini-1.5-pro':    { input: 1.25,  output: 5.00 },
  'google:':                  { input: 1.25,  output: 5.00 },

  // ── Local (Ollama, LM Studio, etc.) ───────────────────────────
  'ollama:':                  { input: 0, output: 0 },
};

function lookup(provider: string, model: string): PriceRow {
  const key = `${provider}:${model.toLowerCase()}`;
  // longest-prefix match
  let best: [string, PriceRow] | null = null;
  for (const [k, v] of Object.entries(PRICES)) {
    if (key.startsWith(k) && (!best || k.length > best[0].length)) best = [k, v];
  }
  return best?.[1] ?? { input: 0, output: 0 };
}

/**
 * Cost in cents (integer) for a single event. We round up so we never
 * under-report. Cache-read tokens are billed at the discounted rate when
 * the provider exposes one.
 */
export function costCents(
  provider: string,
  model: string,
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0,
): number {
  const p = lookup(provider, model);
  // effective input = fresh input + cache-write (same price as input for Anthropic; close enough elsewhere)
  const freshInput = Math.max(0, input - cacheRead);
  const usd =
      (freshInput   * p.input)               / 1_000_000
    + (output       * p.output)              / 1_000_000
    + (cacheRead    * (p.cache_read  ?? 0))  / 1_000_000
    + (cacheWrite   * (p.cache_write ?? p.input)) / 1_000_000;
  return Math.ceil(usd * 100);
}
