#!/usr/bin/env node
/**
 * Tokendome — local proxy agent.
 *
 * Runs an HTTP server on localhost:4000. Users point their LLM clients at this
 * URL instead of the real provider. The agent:
 *
 *   1. Matches the incoming request to an upstream (OpenAI, Anthropic, Ollama,
 *      Google, or a user-configured custom).
 *   2. Forwards the request verbatim (headers, body, streaming).
 *   3. Tees the response stream to a token counter that extracts the
 *      provider-reported usage numbers (we never re-tokenize).
 *   4. Batches events and POSTs them to the Tokendome server with an
 *      HMAC-SHA256 signature derived from the user's agent token.
 *
 * Privacy: request/response bodies are NEVER sent to the server. Only counts.
 * Upstream API keys pass through directly to the real provider. They never
 * land on the agent's disk, and never on the Tokendome server.
 */
import * as http from 'node:http';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { URL } from 'node:url';
// ─── Config ────────────────────────────────────────────────────────────────
const CONFIG_DIR = path.join(os.homedir(), '.tokendome');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_PORT = 4000;
function defaultConfig() {
    return {
        server_url: 'https://tokendome.example.com',
        user_id: 0,
        agent_token: '',
        port: DEFAULT_PORT,
        upstreams: {
            openai: { base: 'https://api.openai.com' },
            anthropic: { base: 'https://api.anthropic.com' },
            google: { base: 'https://generativelanguage.googleapis.com' },
            ollama: { base: 'http://localhost:11434' },
        },
    };
}
function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE))
        return defaultConfig();
    return { ...defaultConfig(), ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
}
function saveConfig(c) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));
    fs.chmodSync(CONFIG_FILE, 0o600);
}
const queue = [];
// Approximate USD prices per 1M tokens (snapshot Apr 2026). Kept in sync with
// lib/pricing.ts on the server. Local models are $0.
const PRICES = {
    'openai:gpt-4o-mini': { in: 0.15, out: 0.60 },
    'openai:gpt-4o': { in: 2.50, out: 10.00, cr: 1.25 },
    'openai:gpt-4.1-mini': { in: 0.40, out: 1.60 },
    'openai:gpt-4.1': { in: 2.00, out: 8.00 },
    'openai:o3-mini': { in: 1.10, out: 4.40 },
    'openai:o3': { in: 10.00, out: 40.00 },
    'openai:o1': { in: 15.00, out: 60.00 },
    'openai:': { in: 2.50, out: 10.00 },
    'anthropic:claude-opus': { in: 15.00, out: 75.00, cr: 1.50 },
    'anthropic:claude-sonnet': { in: 3.00, out: 15.00, cr: 0.30 },
    'anthropic:claude-haiku': { in: 0.80, out: 4.00, cr: 0.08 },
    'anthropic:claude-3-5-son': { in: 3.00, out: 15.00 },
    'anthropic:claude-3-opus': { in: 15.00, out: 75.00 },
    'anthropic:': { in: 3.00, out: 15.00 },
    'google:gemini-2.5-flash': { in: 0.30, out: 2.50 },
    'google:gemini-2.5-pro': { in: 2.50, out: 15.00 },
    'google:': { in: 1.25, out: 5.00 },
    'ollama:': { in: 0, out: 0 },
};
function estimateCostUSD(e) {
    if (e.is_local)
        return 0;
    const key = `${e.provider}:${e.model.toLowerCase()}`;
    let best = null;
    let bestLen = -1;
    for (const [k, v] of Object.entries(PRICES)) {
        if (key.startsWith(k) && k.length > bestLen) {
            best = v;
            bestLen = k.length;
        }
    }
    if (!best)
        return 0;
    const cr = e.cache_read_tokens || 0;
    const freshInput = Math.max(0, e.input_tokens - cr);
    return (freshInput * best.in + e.output_tokens * best.out + cr * (best.cr ?? 0)) / 1_000_000;
}
// Running totals (session lifetime) for the on-screen display.
const sessionTotals = { in: 0, out: 0, cost: 0, events: 0 };
function pushEvent(e) {
    if (!e.input_tokens && !e.output_tokens)
        return;
    queue.push(e);
    const cost = estimateCostUSD(e);
    sessionTotals.in += e.input_tokens;
    sessionTotals.out += e.output_tokens;
    sessionTotals.cost += cost;
    sessionTotals.events += 1;
    const costStr = cost >= 0.01 ? ` · $${cost.toFixed(4)}` : cost > 0 ? ` · <$0.01` : '';
    const sessStr = ` [session: ${sessionTotals.events} events, $${sessionTotals.cost.toFixed(4)}]`;
    console.log(`  ▸ ${e.provider}/${e.model} ` +
        `${e.input_tokens} in · ${e.output_tokens} out` +
        (e.is_local ? ' 🏠' : '') +
        costStr + sessStr);
}
async function flushLoop(cfg) {
    while (true) {
        await new Promise(r => setTimeout(r, 3000));
        if (queue.length === 0)
            continue;
        const batch = queue.splice(0, queue.length);
        // Offline mode: no cloud reporting, just drain the queue.
        if (!cfg.agent_token || !cfg.user_id)
            continue;
        try {
            await report(cfg, batch);
        }
        catch (err) {
            console.error('⚠︎ report failed, re-queuing:', err.message);
            queue.unshift(...batch);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}
async function report(cfg, events) {
    const body = JSON.stringify({ events });
    const ts = String(Date.now());
    const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
    const sig = crypto.createHmac('sha256', cfg.agent_token).update(`${ts}.${bodyHash}`).digest('hex');
    const res = await fetch(cfg.server_url + '/api/ingest', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-ta-user': String(cfg.user_id),
            'x-ta-ts': ts,
            'x-ta-sig': sig,
        },
        body,
    });
    if (!res.ok)
        throw new Error(`${res.status} ${await res.text()}`);
}
function route(cfg, method, urlPath, body) {
    // Anthropic native messages API
    if (urlPath.startsWith('/v1/messages') || urlPath === '/v1/complete') {
        return { provider: 'anthropic', base: cfg.upstreams.anthropic.base, is_local: false, extractor: extractAnthropic };
    }
    // Ollama native
    if (urlPath.startsWith('/api/generate') || urlPath.startsWith('/api/chat') || urlPath.startsWith('/api/embed')) {
        return { provider: 'ollama', base: cfg.upstreams.ollama.base, is_local: true, extractor: extractOllamaNative };
    }
    // Google Gemini
    if (urlPath.startsWith('/v1beta/')) {
        return { provider: 'google', base: cfg.upstreams.google.base, is_local: false, extractor: extractGoogle };
    }
    // OpenAI-compat. Peek at the model in the body to decide.
    if (urlPath.startsWith('/v1/')) {
        let model = '';
        if (body.length) {
            try {
                model = (JSON.parse(body.toString('utf8')).model || '').toString();
            }
            catch { }
        }
        if (model.startsWith('claude-')) {
            // anthropic exposes /v1/chat/completions — same path works
            return { provider: 'anthropic', base: cfg.upstreams.anthropic.base, is_local: false, extractor: extractOpenAI };
        }
        if (model.startsWith('gemini-')) {
            return { provider: 'google', base: cfg.upstreams.google.base, is_local: false, extractor: extractOpenAI };
        }
        if (model.startsWith('ollama/')) {
            // rewrite model to strip prefix — but we can only mutate the body (easy enough)
            return { provider: 'ollama', base: cfg.upstreams.ollama.base, is_local: true, extractor: extractOpenAI };
        }
        return { provider: 'openai', base: cfg.upstreams.openai.base, is_local: false, extractor: extractOpenAI };
    }
    return null;
}
async function extractOpenAI(ctx) {
    // Both streaming and non-streaming OpenAI responses expose `usage`.
    // Streaming: only present in final chunk IF stream_options.include_usage=true.
    // We handle both paths. If usage is missing in a stream, we skip (refuse to
    // estimate — accuracy > coverage).
    if (ctx.contentType.includes('application/json')) {
        const txt = Buffer.concat(ctx.bodyChunks).toString('utf8');
        try {
            const j = JSON.parse(txt);
            const u = j.usage;
            if (!u)
                return;
            pushEvent({
                ts: Date.now(),
                provider: ctx.provider,
                model: j.model || ctx.model || 'unknown',
                is_local: ctx.is_local,
                input_tokens: u.prompt_tokens || u.input_tokens || 0,
                output_tokens: u.completion_tokens || u.output_tokens || 0,
                reasoning_tokens: u.completion_tokens_details?.reasoning_tokens || 0,
                cache_read_tokens: u.prompt_tokens_details?.cached_tokens || 0,
            });
        }
        catch { }
        return;
    }
    // SSE stream
    let lastUsage = null, model = ctx.model;
    for (const ev of ctx.sseEvents) {
        const dataLines = ev.split('\n').filter(l => l.startsWith('data: '));
        for (const l of dataLines) {
            const payload = l.slice(6).trim();
            if (payload === '[DONE]' || !payload)
                continue;
            try {
                const j = JSON.parse(payload);
                if (j.model)
                    model = j.model;
                if (j.usage)
                    lastUsage = j.usage;
            }
            catch { }
        }
    }
    if (!lastUsage)
        return;
    pushEvent({
        ts: Date.now(),
        provider: ctx.provider,
        model: model || 'unknown',
        is_local: ctx.is_local,
        input_tokens: lastUsage.prompt_tokens || lastUsage.input_tokens || 0,
        output_tokens: lastUsage.completion_tokens || lastUsage.output_tokens || 0,
        reasoning_tokens: lastUsage.completion_tokens_details?.reasoning_tokens || 0,
        cache_read_tokens: lastUsage.prompt_tokens_details?.cached_tokens || 0,
    });
}
async function extractAnthropic(ctx) {
    // Non-streaming: top-level .usage { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }
    if (ctx.contentType.includes('application/json')) {
        const txt = Buffer.concat(ctx.bodyChunks).toString('utf8');
        try {
            const j = JSON.parse(txt);
            const u = j.usage;
            if (!u)
                return;
            pushEvent({
                ts: Date.now(),
                provider: 'anthropic',
                model: j.model || ctx.model || 'unknown',
                is_local: false,
                input_tokens: u.input_tokens || 0,
                output_tokens: u.output_tokens || 0,
                cache_read_tokens: u.cache_read_input_tokens || 0,
                cache_write_tokens: u.cache_creation_input_tokens || 0,
            });
        }
        catch { }
        return;
    }
    // Streaming: usage arrives piecewise.
    //   message_start: full usage object with input_tokens (+ cache fields) + output_tokens (initial)
    //   message_delta: { usage: { output_tokens: final } }
    let input = 0, output = 0, cacheR = 0, cacheW = 0, model = ctx.model;
    for (const ev of ctx.sseEvents) {
        const eventLine = ev.split('\n').find(l => l.startsWith('event: '));
        const dataLine = ev.split('\n').find(l => l.startsWith('data: '));
        if (!dataLine)
            continue;
        const type = eventLine?.slice(7).trim();
        try {
            const j = JSON.parse(dataLine.slice(6));
            if (type === 'message_start' && j.message) {
                model = j.message.model || model;
                input = j.message.usage?.input_tokens || input;
                cacheR = j.message.usage?.cache_read_input_tokens || cacheR;
                cacheW = j.message.usage?.cache_creation_input_tokens || cacheW;
                output = j.message.usage?.output_tokens || output;
            }
            else if (type === 'message_delta' && j.usage) {
                if (typeof j.usage.output_tokens === 'number')
                    output = j.usage.output_tokens;
                if (typeof j.usage.input_tokens === 'number')
                    input = j.usage.input_tokens;
            }
        }
        catch { }
    }
    if (input || output) {
        pushEvent({
            ts: Date.now(), provider: 'anthropic',
            model: model || 'unknown', is_local: false,
            input_tokens: input, output_tokens: output,
            cache_read_tokens: cacheR, cache_write_tokens: cacheW,
        });
    }
}
async function extractOllamaNative(ctx) {
    // Ollama streams NDJSON. Final object has done:true plus `prompt_eval_count`
    // and `eval_count`. Non-stream is a single JSON object with the same fields.
    const raw = Buffer.concat(ctx.bodyChunks).toString('utf8');
    const lines = raw.split('\n').filter(Boolean);
    let input = 0, output = 0, model = ctx.model;
    for (const ln of lines) {
        try {
            const j = JSON.parse(ln);
            if (j.model)
                model = j.model;
            if (typeof j.prompt_eval_count === 'number')
                input = j.prompt_eval_count;
            if (typeof j.eval_count === 'number')
                output = j.eval_count;
        }
        catch { }
    }
    if (input || output) {
        pushEvent({
            ts: Date.now(), provider: 'ollama',
            model: model || 'unknown', is_local: true,
            input_tokens: input, output_tokens: output,
        });
    }
}
async function extractGoogle(ctx) {
    // Gemini returns usageMetadata: { promptTokenCount, candidatesTokenCount, totalTokenCount }
    // Both streaming (SSE) and non-streaming shapes carry it on the final payload.
    const tryExtract = (j) => {
        const u = j?.usageMetadata;
        if (!u)
            return;
        pushEvent({
            ts: Date.now(), provider: 'google',
            model: j.modelVersion || ctx.model || 'unknown', is_local: false,
            input_tokens: u.promptTokenCount || 0,
            output_tokens: u.candidatesTokenCount || 0,
        });
    };
    if (ctx.contentType.includes('application/json')) {
        try {
            tryExtract(JSON.parse(Buffer.concat(ctx.bodyChunks).toString('utf8')));
        }
        catch { }
        return;
    }
    for (const ev of ctx.sseEvents) {
        const dataLine = ev.split('\n').find(l => l.startsWith('data: '));
        if (!dataLine)
            continue;
        try {
            tryExtract(JSON.parse(dataLine.slice(6)));
        }
        catch { }
    }
}
// ─── HTTP proxy ─────────────────────────────────────────────────────────────
function startProxy(cfg) {
    const server = http.createServer((clientReq, clientRes) => {
        // Buffer the request body so we can peek at the model for routing and
        // replay upstream.
        const chunks = [];
        clientReq.on('data', (c) => chunks.push(c));
        clientReq.on('end', () => handleRequest(cfg, clientReq, clientRes, Buffer.concat(chunks)));
        clientReq.on('error', (e) => console.error('client err', e.message));
    });
    server.listen(cfg.port, '127.0.0.1', () => {
        console.log(`\n⚡ THE TOKENDOME — agent listening on http://localhost:${cfg.port}`);
        console.log(`    point your tools at it:`);
        console.log(`      OPENAI_BASE_URL=http://localhost:${cfg.port}/v1`);
        console.log(`      ANTHROPIC_BASE_URL=http://localhost:${cfg.port}`);
        console.log(`      OLLAMA_HOST=http://localhost:${cfg.port}`);
        console.log(`    reporting to: ${cfg.server_url}\n`);
    });
}
function handleRequest(cfg, req, res, body) {
    const urlPath = req.url || '/';
    if (urlPath === '/_ta/health') {
        res.writeHead(200);
        res.end('ok');
        return;
    }
    const r = route(cfg, req.method || 'GET', urlPath, body);
    if (!r) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('tokendome: no upstream matches ' + urlPath);
        return;
    }
    // Construct upstream URL
    let finalPath = urlPath;
    let finalBody = body;
    // If user sent "ollama/llama3" via OpenAI-compat, strip prefix.
    if (r.provider === 'ollama' && urlPath.startsWith('/v1/') && body.length) {
        try {
            const j = JSON.parse(body.toString('utf8'));
            if (typeof j.model === 'string' && j.model.startsWith('ollama/')) {
                j.model = j.model.slice('ollama/'.length);
                finalBody = Buffer.from(JSON.stringify(j));
            }
        }
        catch { }
    }
    const upstream = new URL(r.base + finalPath);
    const lib = upstream.protocol === 'https:' ? https : http;
    const outHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
        if (!v)
            continue;
        const lk = k.toLowerCase();
        // drop host — we're rewriting it
        if (lk === 'host' || lk === 'content-length')
            continue;
        outHeaders[k] = v;
    }
    outHeaders['host'] = upstream.host;
    outHeaders['content-length'] = String(finalBody.length);
    const upReq = lib.request({
        host: upstream.hostname,
        port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
        path: upstream.pathname + upstream.search,
        method: req.method,
        headers: outHeaders,
    }, (upRes) => {
        // Mirror status + headers
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        const contentType = String(upRes.headers['content-type'] || '');
        const isStream = contentType.includes('text/event-stream') || contentType.includes('application/x-ndjson');
        // Parse the request body to learn the model name for the extractor
        let reqModel = '';
        try {
            reqModel = (JSON.parse(finalBody.toString('utf8')).model || '').toString();
        }
        catch { }
        if (isStream) {
            // Stream to client and tee to a string buffer we split into SSE events.
            let carry = '';
            const events = [];
            upRes.on('data', (chunk) => {
                res.write(chunk);
                carry += chunk.toString('utf8');
                // SSE events separated by \n\n; NDJSON by single \n
                if (contentType.includes('text/event-stream')) {
                    let idx;
                    while ((idx = carry.indexOf('\n\n')) !== -1) {
                        events.push(carry.slice(0, idx));
                        carry = carry.slice(idx + 2);
                    }
                }
                else {
                    // NDJSON: treat each line as one "event"
                    let idx;
                    while ((idx = carry.indexOf('\n')) !== -1) {
                        events.push(carry.slice(0, idx));
                        carry = carry.slice(idx + 1);
                    }
                }
            });
            upRes.on('end', () => {
                if (carry)
                    events.push(carry);
                res.end();
                // Only extract on 2xx
                if ((upRes.statusCode || 0) < 300) {
                    r.extractor({
                        provider: r.provider, is_local: r.is_local,
                        contentType, bodyChunks: [], sseEvents: events, model: reqModel,
                    }).catch(e => console.error('extractor err', e));
                }
            });
        }
        else {
            const bufs = [];
            upRes.on('data', (c) => { bufs.push(c); res.write(c); });
            upRes.on('end', () => {
                res.end();
                if ((upRes.statusCode || 0) < 300) {
                    r.extractor({
                        provider: r.provider, is_local: r.is_local,
                        contentType, bodyChunks: bufs, sseEvents: [], model: reqModel,
                    }).catch(e => console.error('extractor err', e));
                }
            });
        }
    });
    upReq.on('error', (e) => {
        console.error('upstream err', e.message);
        if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'text/plain' });
        }
        res.end('tokendome: upstream error: ' + e.message);
    });
    upReq.end(finalBody);
}
// ─── CLI ────────────────────────────────────────────────────────────────────
async function login(token, serverUrl) {
    // agent_token format: <user_id>.<hex-secret>   so the agent knows who it is
    // without an extra round trip. The server issues it on sign-up.
    const cfg = loadConfig();
    const dot = token.indexOf('.');
    if (dot < 1) {
        console.error('bad token format');
        process.exit(1);
    }
    const uid = Number(token.slice(0, dot));
    const secret = token.slice(dot + 1);
    if (!uid || !secret) {
        console.error('bad token');
        process.exit(1);
    }
    cfg.user_id = uid;
    cfg.agent_token = secret;
    if (serverUrl)
        cfg.server_url = serverUrl;
    saveConfig(cfg);
    console.log('✓ logged in as user', uid);
    console.log('  config:', CONFIG_FILE);
}
function status() {
    const cfg = loadConfig();
    console.log('server:  ', cfg.server_url);
    console.log('user_id: ', cfg.user_id || '(not logged in)');
    console.log('port:    ', cfg.port);
    console.log('upstreams:');
    for (const [k, v] of Object.entries(cfg.upstreams))
        console.log(`  ${k}: ${v.base}`);
}
function help() {
    console.log(`tokendome — local token telemetry agent

  tokendome login <token> [server_url]   save your credentials
  tokendome start                        run the proxy
  tokendome status                       show config
  tokendome set <key> <value>            e.g. tokendome set upstreams.ollama.base http://192.168.1.5:11434
  tokendome help
`);
}
function setKey(dotPath, value) {
    const cfg = loadConfig();
    const parts = dotPath.split('.');
    let cur = cfg;
    for (let i = 0; i < parts.length - 1; i++) {
        cur = cur[parts[i]] ??= {};
    }
    cur[parts[parts.length - 1]] = value;
    saveConfig(cfg);
    console.log('✓ set', dotPath, '=', value);
}
function main() {
    const [, , cmd, ...rest] = process.argv;
    switch (cmd) {
        case 'login': return login(rest[0], rest[1]);
        case 'status': return status();
        case 'set': return setKey(rest[0], rest.slice(1).join(' '));
        case 'start': {
            const cfg = loadConfig();
            if (!cfg.agent_token) {
                console.log('ℹ︎ no agent token — running in OFFLINE mode (counts print locally, no cloud upload)');
            }
            startProxy(cfg);
            flushLoop(cfg);
            return;
        }
        case 'help':
        case '--help':
        case undefined: return help();
        default:
            console.error('unknown command:', cmd);
            help();
            process.exit(1);
    }
}
main();
