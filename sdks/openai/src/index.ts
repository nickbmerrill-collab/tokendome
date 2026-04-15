/**
 * @tokendome/openai
 *
 * Drop-in replacement for the OpenAI SDK that tees token usage to THE
 * TOKENDOME leaderboard. Change one import line and you're on the board.
 *
 *   - import OpenAI from 'openai';
 *   + import OpenAI from '@tokendome/openai';
 *
 * Token discovery, in priority order:
 *   1. constructor option   { tokendomeToken: '<id>.<secret>' }
 *   2. env var              TOKENDOME_TOKEN=<id>.<secret>
 *   3. CLI config file      ~/.tokendome/config.json
 *
 * For streaming `chat.completions.create({stream:true})`, this SDK auto-injects
 * `stream_options: { include_usage: true }` if you didn't set it — that's the
 * only way OpenAI returns usage during a stream. Adds one extra final chunk
 * with `choices: []` and the usage block. Most iteration loops ignore it.
 */

import OpenAI from 'openai';
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
  reasoning_tokens?: number;
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
  let c = parseToken(opt);
  if (c) return c;
  c = parseToken(process.env.TOKENDOME_TOKEN);
  if (c) return c;
  try {
    const cfgPath = path.join(os.homedir(), '.tokendome', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg.user_id && cfg.agent_token) {
      return { user_id: cfg.user_id, agent_token: cfg.agent_token };
    }
  } catch {
    /* not installed — fine */
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
    if (!r.ok && !(globalThis as any).__tokendome_warned_ingest) {
      (globalThis as any).__tokendome_warned_ingest = true;
      console.warn(`[tokendome] ingest rejected (${r.status}): ${text}`);
    }
  } catch (err: any) {
    dlog('flush: network error', err?.message);
    queue.unshift(...batch);
  }
}

function startReporter(): void {
  if (started) return;
  started = true;
  const interval = setInterval(flush, 3000);
  (interval as any).unref?.();
  process.once('beforeExit', () => { void flush(); });
}

function pushFromUsage(model: string, usage: any): void {
  if (!usage) return;
  queue.push({
    ts: Date.now(),
    provider: 'openai',
    model: model || 'unknown',
    is_local: false,
    input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
    output_tokens: usage.completion_tokens || usage.output_tokens || 0,
    cache_read_tokens: usage.prompt_tokens_details?.cached_tokens || 0,
    reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || 0,
  });
}

function instrument(client: any): void {
  if (client.__tokendome_instrumented) return;
  client.__tokendome_instrumented = true;
  // Wrap chat.completions and (newer) responses with the same pattern.
  // Both expose .create() that returns a Promise<Response> or an async
  // iterable when stream:true is passed.
  wrapCreate(client.chat?.completions, 'chat.completions');
  wrapCreate(client.responses, 'responses');
}

function wrapCreate(target: any, label: string): void {
  if (!target?.create) {
    dlog('instrument: client.' + label + '.create not found, skipping');
    return;
  }
  if (target.__tokendome_wrapped) return;
  target.__tokendome_wrapped = true;
  const origCreate = target.create.bind(target);
  target.create = async function (params: any, ...rest: any[]) {
    // OpenAI streams only emit `usage` in the final chunk if you opt in via
    // stream_options.include_usage. Auto-enable when the user didn't set it.
    // (chat.completions only — responses API includes usage by default.)
    if (params?.stream === true && label === 'chat.completions') {
      const opts = params.stream_options ?? {};
      if (typeof opts.include_usage === 'undefined') {
        params = { ...params, stream_options: { ...opts, include_usage: true } };
        dlog('instrument: auto-enabled stream_options.include_usage');
      }
    }
    const result: any = await origCreate(params, ...rest);

    // Non-streaming: response has .usage at top level
    if (result?.usage && !result[Symbol.asyncIterator]) {
      pushFromUsage(result.model || params.model, result.usage);
      return result;
    }

    // Streaming: tap each chunk for the final usage. Both chat.completions
    // and responses APIs put usage on a terminal chunk.
    if (result && result[Symbol.asyncIterator]) {
      const origIterFactory = result[Symbol.asyncIterator].bind(result);
      let model = params.model;
      let usage: any = null;
      result[Symbol.asyncIterator] = async function* () {
        for await (const chunk of origIterFactory()) {
          try {
            if (chunk?.model) model = chunk.model;
            // chat.completions: chunk.usage on the final chunk
            if (chunk?.usage) usage = chunk.usage;
            // responses API: events carry response.usage on type 'response.completed'
            if (chunk?.response?.usage) usage = chunk.response.usage;
            if (chunk?.response?.model) model = chunk.response.model;
          } catch { /* never break the user's stream */ }
          yield chunk;
        }
        if (usage) pushFromUsage(model, usage);
      };
    }
    return result;
  };
}

type ClientOpts = ConstructorParameters<typeof OpenAI>[0] & {
  /** Token from https://tokendome.vercel.app/api/me — overrides env / CLI config */
  tokendomeToken?: string;
};

export default class TokendomeOpenAI extends OpenAI {
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

export * from 'openai';
