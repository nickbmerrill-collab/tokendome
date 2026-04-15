/**
 * @tokendome/anthropic
 *
 * Drop-in replacement for the official Anthropic SDK that tees token usage
 * to THE TOKENDOME leaderboard. Change one import line and you're on the board.
 *
 *   - import Anthropic from '@anthropic-ai/sdk';
 *   + import Anthropic from '@tokendome/anthropic';
 *
 * Your prompts and completions never leave your process. Only the
 * provider-reported `usage` numbers (input_tokens, output_tokens, cache fields)
 * are sent — the same data you'd see in your Anthropic billing dashboard.
 *
 * Token discovery, in priority order:
 *   1. constructor option   { tokendomeToken: '<id>.<secret>' }
 *   2. env var              TOKENDOME_TOKEN=<id>.<secret>
 *   3. CLI config file      ~/.tokendome/config.json (if you also installed the agent)
 * If none are found, the SDK is a silent no-op and your app behaves exactly
 * as if you'd imported @anthropic-ai/sdk directly.
 */

import Anthropic from '@anthropic-ai/sdk';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const SERVER = process.env.TOKENDOME_SERVER || 'https://tokendome.vercel.app';
const DEBUG = !!process.env.TOKENDOME_DEBUG;
function dlog(...a: unknown[]): void { if (DEBUG) console.error('[tokendome]', ...a); }

type Event = {
  ts: number;
  provider: string;
  model: string;
  is_local: boolean;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
};

type Creds = { user_id: number; agent_token: string };

const queue: Event[] = [];
let creds: Creds | null = null;
let started = false;

function parseToken(raw: string | undefined): Creds | null {
  if (!raw) return null;
  const dot = raw.indexOf('.');
  if (dot < 1) return null;
  const uid = Number(raw.slice(0, dot));
  const secret = raw.slice(dot + 1);
  if (!uid || !secret) return null;
  return { user_id: uid, agent_token: secret };
}

function loadCreds(opt?: string): Creds | null {
  // 1. explicit option
  let c = parseToken(opt);
  if (c) return c;
  // 2. env var
  c = parseToken(process.env.TOKENDOME_TOKEN);
  if (c) return c;
  // 3. CLI config file
  try {
    const cfgPath = path.join(os.homedir(), '.tokendome', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg.user_id && cfg.agent_token) {
      return { user_id: cfg.user_id, agent_token: cfg.agent_token };
    }
  } catch {
    /* file missing or unreadable — fine, just means no credential here */
  }
  return null;
}

async function flush(): Promise<void> {
  if (queue.length === 0) { dlog('flush: queue empty'); return; }
  if (!creds) { dlog('flush: no creds, dropping', queue.length, 'events'); return; }
  const batch = queue.splice(0, queue.length);
  const body = JSON.stringify({ events: batch });
  const ts = String(Date.now());
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const sig = crypto.createHmac('sha256', creds.agent_token).update(`${ts}.${bodyHash}`).digest('hex');
  dlog('flush: POST', SERVER + '/api/ingest', `(${batch.length} events)`);
  try {
    const r = await fetch(SERVER + '/api/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ta-user': String(creds.user_id),
        'x-ta-ts': ts,
        'x-ta-sig': sig,
      },
      body,
    });
    const text = await r.text().catch(() => '');
    dlog('flush: response', r.status, text);
    if (!r.ok) {
      // Surface once so devs notice during testing, then go quiet.
      if (!(globalThis as any).__tokendome_warned_ingest) {
        (globalThis as any).__tokendome_warned_ingest = true;
        // eslint-disable-next-line no-console
        console.warn(`[tokendome] ingest rejected (${r.status}): ${text}`);
      }
    }
  } catch (err: any) {
    dlog('flush: network error', err?.message);
    // transient network error — re-queue head of line and try again next tick
    queue.unshift(...batch);
  }
}

function startReporter(): void {
  if (started) return;
  started = true;
  const interval = setInterval(flush, 3000);
  // Don't keep the event loop alive just for the timer
  (interval as any).unref?.();
  // Best-effort flush on process exit so short-lived scripts still report
  process.once('beforeExit', () => { void flush(); });
}

function pushFromMessage(m: any): void {
  if (!m?.usage) return;
  queue.push({
    ts: Date.now(),
    provider: 'anthropic',
    model: m.model || 'unknown',
    is_local: false,
    input_tokens: m.usage.input_tokens || 0,
    output_tokens: m.usage.output_tokens || 0,
    cache_read_tokens: m.usage.cache_read_input_tokens || 0,
    cache_write_tokens: m.usage.cache_creation_input_tokens || 0,
  });
}

/**
 * Wrap a Messages call so usage is teed without touching the response the
 * user sees. Covers three Anthropic SDK shapes:
 *   - messages.create({ stream: false })  → Promise<Message>
 *   - messages.create({ stream: true })   → Stream<RawMessageStreamEvent>
 *   - messages.stream({ ... })            → MessageStream helper class
 */
function instrument(client: any): void {
  if (client.__tokendome_instrumented) return;
  client.__tokendome_instrumented = true;
  const messages = client.messages;

  // create()
  const origCreate = messages.create.bind(messages);
  messages.create = async function (...args: unknown[]) {
    const result: any = await origCreate(...(args as [any]));
    if (result && result.usage && !result[Symbol.asyncIterator]) {
      pushFromMessage(result);
      return result;
    }
    if (result && result[Symbol.asyncIterator]) {
      tapStreamEvents(result);
    }
    return result;
  };

  // stream() helper — returns a MessageStream which both emits events AND
  // exposes .on('finalMessage'). We listen for the final message rather than
  // rewrapping the iterator: works regardless of whether the user iterates,
  // awaits .finalMessage(), or just attaches their own .on() listeners.
  if (typeof messages.stream === 'function') {
    const origStream = messages.stream.bind(messages);
    messages.stream = function (...args: unknown[]) {
      const stream: any = origStream(...(args as [any]));
      try {
        if (typeof stream?.on === 'function') {
          stream.on('finalMessage', (m: any) => pushFromMessage(m));
        } else if (stream && stream[Symbol.asyncIterator]) {
          // Fallback for SDK versions that returned a raw async iterable
          tapStreamEvents(stream);
        }
      } catch (e: any) { dlog('stream() tap failed:', e?.message); }
      return stream;
    };
  }
}

// Tap an async-iterable stream of RawMessageStreamEvent for the final usage.
function tapStreamEvents(result: any): void {
  const origIterFactory = result[Symbol.asyncIterator].bind(result);
  let model = '';
  let input_tokens = 0, output_tokens = 0;
  let cacheR = 0, cacheW = 0;
  let extracted = false;
  result[Symbol.asyncIterator] = async function* () {
    for await (const ev of origIterFactory()) {
      try {
        if (ev?.type === 'message_start' && ev.message) {
          model = ev.message.model || model;
          input_tokens = ev.message.usage?.input_tokens || input_tokens;
          cacheR = ev.message.usage?.cache_read_input_tokens || cacheR;
          cacheW = ev.message.usage?.cache_creation_input_tokens || cacheW;
          output_tokens = ev.message.usage?.output_tokens || output_tokens;
        } else if (ev?.type === 'message_delta' && ev.usage) {
          if (typeof ev.usage.output_tokens === 'number') output_tokens = ev.usage.output_tokens;
          if (typeof ev.usage.input_tokens === 'number') input_tokens = ev.usage.input_tokens;
        }
      } catch { /* never break the user's stream */ }
      yield ev;
    }
    if (!extracted && (input_tokens || output_tokens)) {
      extracted = true;
      queue.push({
        ts: Date.now(), provider: 'anthropic',
        model: model || 'unknown', is_local: false,
        input_tokens, output_tokens,
        cache_read_tokens: cacheR, cache_write_tokens: cacheW,
      });
    }
  };
}

type ClientOpts = ConstructorParameters<typeof Anthropic>[0] & {
  /** Token from https://tokendome.vercel.app/api/me — overrides env / CLI config */
  tokendomeToken?: string;
};

export default class TokendomeAnthropic extends Anthropic {
  constructor(opts?: ClientOpts) {
    super(opts as any);
    if (!creds) {
      creds = loadCreds(opts?.tokendomeToken);
      dlog('constructor:', creds ? `creds loaded (user_id=${creds.user_id})` : 'NO credentials found — set TOKENDOME_TOKEN or pass tokendomeToken');
    }
    if (creds) startReporter();
    instrument(this);
    dlog('constructor: client wrapped, server =', SERVER);
  }
}

// Re-export the rest of the SDK so consumers can `import { ... } from '@tokendome/anthropic'`
// exactly as they would from '@anthropic-ai/sdk'.
export * from '@anthropic-ai/sdk';
