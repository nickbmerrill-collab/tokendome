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
import { spawnSync } from 'node:child_process';
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
            ollama: { base: 'http://localhost:11434', is_local: true },
        },
        model_routes: [],
    };
}
function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE))
        return defaultConfig();
    const def = defaultConfig();
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    // Shallow merge top-level + per-upstream merge so defaults like
    // `ollama.is_local: true` survive even if the saved file predates the field.
    const merged = { ...def, ...saved, upstreams: { ...def.upstreams } };
    if (saved.upstreams) {
        for (const k of Object.keys(saved.upstreams)) {
            merged.upstreams[k] = { ...def.upstreams[k], ...saved.upstreams[k] };
        }
    }
    return merged;
}
function saveConfig(c) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));
    fs.chmodSync(CONFIG_FILE, 0o600);
}
const queue = [];
const captures = [];
const CAPTURES_MAX = 200;
function recordCapture(c) {
    captures.push(c);
    if (captures.length > CAPTURES_MAX)
        captures.splice(0, captures.length - CAPTURES_MAX);
}
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
    recordCapture({
        ts: e.ts, provider: e.provider, model: e.model,
        in: e.input_tokens, out: e.output_tokens, is_local: e.is_local, status: 200,
    });
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
function localFor(cfg, name) {
    return cfg.upstreams[name]?.is_local ?? (name === 'ollama');
}
function route(cfg, method, urlPath, body) {
    if (urlPath.startsWith('/v1/messages') || urlPath === '/v1/complete') {
        return { provider: 'anthropic', base: cfg.upstreams.anthropic.base, is_local: localFor(cfg, 'anthropic'), extractor: extractAnthropic };
    }
    if (urlPath.startsWith('/api/generate') || urlPath.startsWith('/api/chat') || urlPath.startsWith('/api/embed')) {
        return { provider: 'ollama', base: cfg.upstreams.ollama.base, is_local: localFor(cfg, 'ollama'), extractor: extractOllamaNative };
    }
    if (urlPath.startsWith('/v1beta/')) {
        return { provider: 'google', base: cfg.upstreams.google.base, is_local: localFor(cfg, 'google'), extractor: extractGoogle };
    }
    if (urlPath.startsWith('/v1/')) {
        let model = '';
        if (body.length) {
            try {
                model = (JSON.parse(body.toString('utf8')).model || '').toString();
            }
            catch { }
        }
        // 1. User-defined model-prefix routes (let "local/llama3-70b" go to a
        //    self-hosted server while plain "gpt-4o" still hits cloud OpenAI).
        for (const r of cfg.model_routes || []) {
            if (r.prefix && model.startsWith(r.prefix)) {
                const up = cfg.upstreams[r.upstream];
                if (up?.base) {
                    return {
                        provider: r.upstream, base: up.base,
                        is_local: localFor(cfg, r.upstream),
                        extractor: extractOpenAI,
                        strip_model_prefix: r.strip === false ? undefined : r.prefix,
                    };
                }
            }
        }
        // 2. Built-in heuristics
        if (model.startsWith('claude-')) {
            return { provider: 'anthropic', base: cfg.upstreams.anthropic.base, is_local: localFor(cfg, 'anthropic'), extractor: extractOpenAI };
        }
        if (model.startsWith('gemini-')) {
            return { provider: 'google', base: cfg.upstreams.google.base, is_local: localFor(cfg, 'google'), extractor: extractOpenAI };
        }
        if (model.startsWith('ollama/')) {
            return { provider: 'ollama', base: cfg.upstreams.ollama.base, is_local: localFor(cfg, 'ollama'), extractor: extractOpenAI };
        }
        return { provider: 'openai', base: cfg.upstreams.openai.base, is_local: localFor(cfg, 'openai'), extractor: extractOpenAI };
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
    if (urlPath.startsWith('/_ta/captures')) {
        const u = new URL('http://x' + urlPath);
        const limit = Math.max(1, Math.min(CAPTURES_MAX, Number(u.searchParams.get('limit')) || 50));
        const slice = captures.slice(-limit).reverse(); // newest first
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ captures: slice }));
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
    // Strip the routing prefix from `model` before forwarding so the upstream
    // sees the real model name. Built-in for "ollama/" + any user-defined
    // model_routes prefix declared on the matching route.
    const stripPrefix = r.strip_model_prefix
        ?? (r.provider === 'ollama' && urlPath.startsWith('/v1/') ? 'ollama/' : null);
    if (stripPrefix && body.length) {
        try {
            const j = JSON.parse(body.toString('utf8'));
            if (typeof j.model === 'string' && j.model.startsWith(stripPrefix)) {
                j.model = j.model.slice(stripPrefix.length);
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
    for (const [k, v] of Object.entries(cfg.upstreams)) {
        const localTag = v.is_local ? ' 🏠 local' : '';
        console.log(`  ${k}: ${v.base}${localTag}`);
    }
    if ((cfg.model_routes || []).length > 0) {
        console.log('model routes:');
        for (const r of cfg.model_routes) {
            console.log(`  "${r.prefix}" → ${r.upstream}${r.strip === false ? ' (no-strip)' : ''}`);
        }
    }
}
// ─── upstream / route CLI commands ──────────────────────────────────────────
function parseFlags(args) {
    const positional = [];
    const flags = {};
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a.startsWith('--')) {
            const k = a.slice(2);
            const next = args[i + 1];
            if (!next || next.startsWith('--'))
                flags[k] = true;
            else {
                flags[k] = next;
                i++;
            }
        }
        else {
            positional.push(a);
        }
    }
    return { positional, flags };
}
function upstreamCmd(args) {
    const cfg = loadConfig();
    const { positional, flags } = parseFlags(args);
    const sub = positional[0];
    if (sub === 'add') {
        const name = positional[1];
        const base = flags.base;
        if (!name || !base) {
            console.error('usage: tokendome upstream add <name> --base <url> [--local]');
            process.exit(1);
        }
        cfg.upstreams[name] = { base, ...(flags.local ? { is_local: true } : {}) };
        saveConfig(cfg);
        console.log('✓ added upstream', name, '→', base, flags.local ? '(local)' : '');
        return;
    }
    if (sub === 'rm') {
        const name = positional[1];
        if (!name) {
            console.error('usage: tokendome upstream rm <name>');
            process.exit(1);
        }
        if (['openai', 'anthropic', 'google', 'ollama'].includes(name)) {
            console.error('✘ cannot remove built-in upstream', name, '(use `tokendome set upstreams.' + name + '.base <url>` to retarget instead)');
            process.exit(1);
        }
        delete cfg.upstreams[name];
        cfg.model_routes = (cfg.model_routes || []).filter((r) => r.upstream !== name);
        saveConfig(cfg);
        console.log('✓ removed upstream', name);
        return;
    }
    console.error('usage: tokendome upstream add|rm …');
    process.exit(1);
}
function routeCmd(args) {
    const cfg = loadConfig();
    const { positional, flags } = parseFlags(args);
    const sub = positional[0];
    cfg.model_routes ??= [];
    if (sub === 'add') {
        const prefix = positional[1];
        const upstream = positional[2];
        if (!prefix || !upstream) {
            console.error('usage: tokendome route add <model-prefix> <upstream-name>');
            process.exit(1);
        }
        if (!cfg.upstreams[upstream]) {
            console.error('✘ no such upstream:', upstream);
            process.exit(1);
        }
        cfg.model_routes = cfg.model_routes.filter((r) => r.prefix !== prefix);
        cfg.model_routes.push({ prefix, upstream, ...(flags['no-strip'] ? { strip: false } : {}) });
        saveConfig(cfg);
        console.log('✓ added route', prefix, '→', upstream);
        return;
    }
    if (sub === 'rm') {
        const prefix = positional[1];
        if (!prefix) {
            console.error('usage: tokendome route rm <model-prefix>');
            process.exit(1);
        }
        const before = cfg.model_routes.length;
        cfg.model_routes = cfg.model_routes.filter((r) => r.prefix !== prefix);
        saveConfig(cfg);
        console.log('✓ removed', before - cfg.model_routes.length, 'route(s)');
        return;
    }
    console.error('usage: tokendome route add|rm …');
    process.exit(1);
}
// Multi-machine config sync. `export-config` emits a base64-wrapped JSON
// blob of the live config (including the agent token + any custom upstreams
// and routes); `import-config <blob>` writes it on the destination box.
//
// The blob carries your bearer credential, so it's printed as one long
// line that you should treat like a password — pipe to clipboard, paste
// in a one-shot terminal on the other machine, then clear scrollback.
function exportConfigCmd() {
    const cfg = loadConfig();
    if (!cfg.agent_token) {
        console.error('✘ Not logged in — run `tokendome login` first.');
        process.exit(1);
    }
    const blob = Buffer.from(JSON.stringify(cfg)).toString('base64');
    // Print to stdout for piping; print a friendly note to stderr so it
    // doesn't end up inside `... | pbcopy`.
    console.error('# Pipe to clipboard:  tokendome export-config | pbcopy        (macOS)');
    console.error('# Pipe to clipboard:  tokendome export-config | xclip -selection clipboard   (Linux)');
    console.error('#');
    console.error('# Then on the other machine:  tokendome import-config <paste>');
    console.error('#');
    console.error('# ⚠  This blob includes your agent token. Treat it like a password.');
    console.log(blob);
}
function importConfigCmd(blob) {
    if (!blob) {
        console.error('usage: tokendome import-config <base64-blob>');
        process.exit(1);
    }
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(blob.trim(), 'base64').toString('utf8'));
    }
    catch (e) {
        console.error('✘ Could not decode blob —', e.message);
        process.exit(1);
    }
    if (!parsed.agent_token || !parsed.user_id) {
        console.error('✘ Blob is missing agent_token or user_id — was this from `tokendome export-config`?');
        process.exit(1);
    }
    // Don't blindly clobber a different login on this machine — confirm.
    const existing = loadConfig();
    if (existing.user_id && existing.user_id !== parsed.user_id) {
        console.error(`⚠  This machine is currently logged in as user ${existing.user_id}. Importing will switch to user ${parsed.user_id}.`);
        console.error('   Re-run with: tokendome import-config <blob> --force   to confirm.');
        if (!process.argv.includes('--force'))
            process.exit(1);
    }
    saveConfig(parsed);
    console.log('✓ Imported config. user_id =', parsed.user_id, '· server =', parsed.server_url);
    console.log('  Restart the agent for upstream changes to take effect.');
}
// `tokendome doctor` — five health checks, each a green/red line. Designed
// to be the first thing a user runs when "it's not working" — same kinds of
// failures we hit while debugging the buddy onboarding earlier.
async function doctorCmd() {
    const cfg = loadConfig();
    const ok = (m) => console.log('✓', m);
    const bad = (m, hint) => { console.log('✘', m); if (hint)
        console.log('  →', hint); };
    // 1. Config sane
    if (cfg.user_id && cfg.agent_token)
        ok(`config:   logged in as user ${cfg.user_id} → ${cfg.server_url}`);
    else
        bad('config:   not logged in', 'tokendome login <token> ' + cfg.server_url);
    // 2. Server reachable
    let serverOk = false;
    try {
        const r = await fetch(cfg.server_url + '/api/me');
        serverOk = r.ok || r.status === 401; // 401 means reachable but unauth
        if (serverOk)
            ok(`server:   reachable (${cfg.server_url})`);
        else
            bad(`server:   unexpected status ${r.status}`, 'check ' + cfg.server_url + ' in a browser');
    }
    catch (e) {
        bad('server:   network error: ' + e.message, 'check your internet / DNS');
    }
    // 3. Agent listening locally
    let agentOk = false;
    try {
        const r = await fetch(`http://127.0.0.1:${cfg.port}/_ta/health`);
        agentOk = r.ok;
        if (agentOk)
            ok(`agent:    listening on :${cfg.port}`);
        else
            bad(`agent:    health endpoint returned ${r.status}`);
    }
    catch {
        bad(`agent:    not running on :${cfg.port}`, 'tokendome start  (or: tokendome service install)');
    }
    // 4. Ingest accepts a synthetic event signed with our token
    if (cfg.user_id && cfg.agent_token && serverOk) {
        try {
            const body = JSON.stringify({ events: [{ ts: Date.now(), provider: 'doctor', model: 'doctor', is_local: true, input_tokens: 1, output_tokens: 1 }] });
            const ts = String(Date.now());
            const bh = crypto.createHash('sha256').update(body).digest('hex');
            const sig = crypto.createHmac('sha256', cfg.agent_token).update(`${ts}.${bh}`).digest('hex');
            const r = await fetch(cfg.server_url + '/api/ingest', {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-ta-user': String(cfg.user_id), 'x-ta-ts': ts, 'x-ta-sig': sig },
                body,
            });
            if (r.ok)
                ok('ingest:   accepted a signed test event (1 in / 1 out, marked local)');
            else
                bad(`ingest:   server rejected (${r.status}) — ${(await r.text().catch(() => '')).slice(0, 120)}`, "check that your token isn't stale and your clock is in sync");
        }
        catch (e) {
            bad('ingest:   ' + e.message);
        }
    }
    else {
        bad('ingest:   skipped (need login + server)');
    }
    // 5. Service status (best-effort)
    if (process.platform === 'darwin' || process.platform === 'linux') {
        const platform = process.platform === 'darwin' ? 'launchd' : 'systemd';
        if (platform === 'launchd') {
            const uid = process.getuid?.() ?? 0;
            const r = execv('launchctl', ['print', `gui/${uid}/${SERVICE_LABEL}`]);
            if (r.code === 0)
                ok('service:  launchd unit loaded — auto-starts on every login');
            else
                console.log('·  service:  not installed (run: tokendome service install) — only relevant if you want auto-start');
        }
        else {
            const r = execv('systemctl', ['--user', 'is-active', 'tokendome.service']);
            if (r.code === 0)
                ok('service:  systemd user unit active');
            else
                console.log('·  service:  not installed (run: tokendome service install)');
        }
    }
    console.log('');
    console.log('See last few captured calls with:  tokendome captures');
}
async function capturesCmd(args) {
    const { flags } = parseFlags(args);
    const limit = Number(flags.limit) || 50;
    const cfg = loadConfig();
    const url = `http://127.0.0.1:${cfg.port}/_ta/captures?limit=${limit}`;
    try {
        const r = await fetch(url);
        if (!r.ok) {
            console.error('✘ agent responded', r.status);
            process.exit(1);
        }
        const j = await r.json();
        if (!j.captures.length) {
            console.log('No captures yet — make a call through the proxy.');
            return;
        }
        for (const c of j.captures) {
            const d = new Date(c.ts).toISOString().slice(11, 19);
            const tokens = (c.in != null && c.out != null) ? `  ${c.in}↑ ${c.out}↓` : '';
            const local = c.is_local ? ' 🏠' : '';
            console.log(`${d}  ${String(c.status || '???').padEnd(3)} ${(c.provider || '?').padEnd(9)} ${(c.model || c.url).slice(0, 40).padEnd(40)}${tokens}${local}`);
        }
    }
    catch (e) {
        console.error('✘ could not reach agent on port', cfg.port, '—', e.message);
        console.error('  Is `tokendome start` running? Or did `tokendome service install` finish?');
        process.exit(1);
    }
}
function help() {
    console.log(`tokendome — local token telemetry agent

  tokendome login <token> [server_url]   save your credentials
  tokendome start                        run the proxy (foreground)
  tokendome status                       show config
  tokendome captures [--limit N]         show the last N requests the proxy has handled (default 50)
  tokendome set <key> <value>            e.g. tokendome set upstreams.ollama.base http://192.168.1.5:11434

  tokendome upstream add <name> --base <url> [--local]
  tokendome upstream rm <name>
  tokendome route add <model-prefix> <upstream-name> [--no-strip]
  tokendome route rm <model-prefix>

  tokendome service install              install as a launchd/systemd user service so the proxy starts on login
  tokendome service uninstall            remove the user service
  tokendome service status               show whether the user service is loaded

  tokendome capture-all install          (REQUIRES SUDO) transparent egress redirect for known LLM API hosts → localhost:4000.
                                         the "no escape" mode for services that ignore *_BASE_URL env vars.
  tokendome capture-all uninstall        revert the redirect rules

  tokendome export-config                print the full config (incl. token) as a single base64 line — pipe to clipboard
  tokendome import-config <blob>         restore on a second machine in one command

  tokendome doctor                       run end-to-end health checks (config, network, agent, server, ingest)

  tokendome help

Multi-source examples:
  # Mark a self-hosted vLLM as local compute on the leaderboard:
  tokendome upstream add vllm --base http://localhost:8000 --local
  tokendome route add "vllm/" vllm
  # Now any chat call with model="vllm/llama3-70b" hits the local vLLM
  # and shows up as is_local=true (cost = 0).
`);
}
// ─── Service install (launchd on macOS, systemd --user on Linux) ────────────
const SERVICE_LABEL = 'com.tokendome.agent';
function platformService() {
    if (process.platform === 'darwin')
        return 'launchd';
    if (process.platform === 'linux')
        return 'systemd';
    return null;
}
function execv(cmd, args) {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function serviceInstall() {
    const platform = platformService();
    const node = process.execPath;
    const script = path.join(CONFIG_DIR, 'tokendome.js');
    if (!fs.existsSync(script)) {
        console.error('✘ Expected', script, 'to exist (the install script puts it there).');
        console.error('  Run the one-line installer first:  curl -fsSL <server>/install.sh | bash');
        process.exit(1);
    }
    if (platform === 'launchd') {
        const plistPath = path.join(os.homedir(), 'Library/LaunchAgents', `${SERVICE_LABEL}.plist`);
        const logDir = path.join(CONFIG_DIR, 'logs');
        fs.mkdirSync(logDir, { recursive: true });
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${script}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(logDir, 'agent.out.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(logDir, 'agent.err.log')}</string>
  <key>WorkingDirectory</key><string>${CONFIG_DIR}</string>
</dict>
</plist>
`;
        fs.mkdirSync(path.dirname(plistPath), { recursive: true });
        fs.writeFileSync(plistPath, plist);
        // bootout if previously loaded, then bootstrap
        const uid = process.getuid?.() ?? 0;
        execv('launchctl', ['bootout', `gui/${uid}`, plistPath]); // ignore failure (not loaded)
        const r = execv('launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
        if (r.code !== 0) {
            console.error('✘ launchctl bootstrap failed:', r.stderr.trim() || r.stdout.trim());
            process.exit(1);
        }
        console.log('✓ Installed launchd service:', plistPath);
        console.log('  Logs:', logDir);
        console.log('  The agent now starts automatically on every login.');
        return;
    }
    if (platform === 'systemd') {
        const unitDir = path.join(os.homedir(), '.config/systemd/user');
        const unitPath = path.join(unitDir, 'tokendome.service');
        fs.mkdirSync(unitDir, { recursive: true });
        const unit = `[Unit]
Description=THE TOKENDOME local proxy agent
After=network-online.target

[Service]
ExecStart=${node} ${script} start
Restart=always
RestartSec=5
WorkingDirectory=${CONFIG_DIR}
StandardOutput=append:${path.join(CONFIG_DIR, 'logs', 'agent.out.log')}
StandardError=append:${path.join(CONFIG_DIR, 'logs', 'agent.err.log')}

[Install]
WantedBy=default.target
`;
        fs.mkdirSync(path.join(CONFIG_DIR, 'logs'), { recursive: true });
        fs.writeFileSync(unitPath, unit);
        execv('systemctl', ['--user', 'daemon-reload']);
        const r = execv('systemctl', ['--user', 'enable', '--now', 'tokendome.service']);
        if (r.code !== 0) {
            console.error('✘ systemctl --user enable failed:', r.stderr.trim() || r.stdout.trim());
            console.error('  Tip: ensure user lingering is enabled if you want it to run without an active login:');
            console.error('       sudo loginctl enable-linger', os.userInfo().username);
            process.exit(1);
        }
        console.log('✓ Installed systemd user service:', unitPath);
        console.log('  Logs:', path.join(CONFIG_DIR, 'logs'));
        return;
    }
    console.error('✘ tokendome service: only macOS (launchd) and Linux (systemd --user) are supported.');
    process.exit(1);
}
function serviceUninstall() {
    const platform = platformService();
    if (platform === 'launchd') {
        const plistPath = path.join(os.homedir(), 'Library/LaunchAgents', `${SERVICE_LABEL}.plist`);
        const uid = process.getuid?.() ?? 0;
        execv('launchctl', ['bootout', `gui/${uid}`, plistPath]);
        if (fs.existsSync(plistPath))
            fs.unlinkSync(plistPath);
        console.log('✓ Uninstalled launchd service.');
        return;
    }
    if (platform === 'systemd') {
        execv('systemctl', ['--user', 'disable', '--now', 'tokendome.service']);
        const unitPath = path.join(os.homedir(), '.config/systemd/user/tokendome.service');
        if (fs.existsSync(unitPath))
            fs.unlinkSync(unitPath);
        execv('systemctl', ['--user', 'daemon-reload']);
        console.log('✓ Uninstalled systemd user service.');
        return;
    }
    console.error('✘ tokendome service: only macOS and Linux supported.');
    process.exit(1);
}
// ─── capture-all: transparent egress redirect (pfctl on macOS, iptables on Linux)
//
// Hostnames the agent is willing to capture transparently. Conservative list
// — only well-known LLM provider endpoints. Adding more is a config change.
const CAPTURE_HOSTS = [
    'api.openai.com',
    'api.anthropic.com',
    'generativelanguage.googleapis.com',
];
const PF_ANCHOR = 'tokendome';
const PF_RULES_PATH = path.join(CONFIG_DIR, 'pf-rules.conf');
function resolveAll(host) {
    const r = execv('dig', ['+short', host]);
    if (r.code !== 0)
        return [];
    return r.stdout.split('\n').map(s => s.trim()).filter(s => /^\d+\.\d+\.\d+\.\d+$/.test(s));
}
async function captureAllInstall() {
    const platform = process.platform;
    console.log('⚠  capture-all transparently redirects egress to known LLM API hosts');
    console.log('   through localhost:' + loadConfig().port + '. Requires sudo. Reversible.');
    console.log('');
    console.log('   Hosts that will be redirected:');
    for (const h of CAPTURE_HOSTS)
        console.log('    -', h);
    console.log('');
    if (platform === 'darwin') {
        // pfctl approach: write rdr rules into a named anchor, then enable pf
        // and tell it to load our anchor. Idempotent: re-running replaces.
        const port = loadConfig().port;
        const ips = [];
        for (const h of CAPTURE_HOSTS)
            for (const ip of resolveAll(h))
                ips.push(ip);
        if (ips.length === 0) {
            console.error('✘ Could not resolve any capture hosts. Are you online?');
            process.exit(1);
        }
        const rules = ips.map(ip => `rdr pass on lo0 inet proto tcp from any to ${ip} port 443 -> 127.0.0.1 port ${port}`).join('\n');
        fs.writeFileSync(PF_RULES_PATH, rules + '\n');
        console.log('Wrote rules:', PF_RULES_PATH);
        console.log('You will be prompted for sudo …');
        const r1 = execv('sudo', ['pfctl', '-a', PF_ANCHOR, '-f', PF_RULES_PATH]);
        if (r1.code !== 0) {
            console.error('✘ pfctl load failed:', r1.stderr.trim());
            process.exit(1);
        }
        const r2 = execv('sudo', ['pfctl', '-E']);
        if (r2.code !== 0 && !/pf already enabled/i.test(r2.stderr)) {
            console.error('✘ pfctl enable failed:', r2.stderr.trim());
            process.exit(1);
        }
        console.log('✓ Egress redirect installed. To revert: tokendome capture-all uninstall');
        console.log('  Note: TLS will fail until your services trust the proxy as a man-in-the-middle.');
        console.log('  This is intentional — capture-all is a "what is bypassing me?" diagnostic, not a fully-working transparent MITM.');
        console.log('  Use it to discover which services need *_BASE_URL set, then uninstall.');
        return;
    }
    if (platform === 'linux') {
        const port = loadConfig().port;
        console.log('You will be prompted for sudo …');
        let installed = 0;
        for (const h of CAPTURE_HOSTS) {
            for (const ip of resolveAll(h)) {
                const r = execv('sudo', ['iptables', '-t', 'nat', '-A', 'OUTPUT', '-d', ip, '-p', 'tcp', '--dport', '443', '-j', 'REDIRECT', '--to-port', String(port), '-m', 'comment', '--comment', PF_ANCHOR]);
                if (r.code === 0)
                    installed++;
            }
        }
        console.log(`✓ Installed ${installed} iptables REDIRECT rules. Revert: tokendome capture-all uninstall`);
        return;
    }
    console.error('✘ capture-all: only macOS (pfctl) and Linux (iptables) supported.');
    process.exit(1);
}
function captureAllUninstall() {
    const platform = process.platform;
    if (platform === 'darwin') {
        console.log('You will be prompted for sudo to flush the pf anchor …');
        execv('sudo', ['pfctl', '-a', PF_ANCHOR, '-F', 'all']);
        if (fs.existsSync(PF_RULES_PATH))
            fs.unlinkSync(PF_RULES_PATH);
        console.log('✓ Egress redirect removed.');
        return;
    }
    if (platform === 'linux') {
        console.log('You will be prompted for sudo to remove iptables rules …');
        // Remove every rule we added (matched by our --comment)
        while (true) {
            const r = execv('sudo', ['iptables', '-t', 'nat', '-D', 'OUTPUT', '-m', 'comment', '--comment', PF_ANCHOR, '-j', 'REDIRECT']);
            if (r.code !== 0)
                break;
        }
        console.log('✓ iptables rules removed.');
        return;
    }
    console.error('✘ capture-all: only macOS and Linux supported.');
    process.exit(1);
}
function serviceStatus() {
    const platform = platformService();
    if (platform === 'launchd') {
        const uid = process.getuid?.() ?? 0;
        const r = execv('launchctl', ['print', `gui/${uid}/${SERVICE_LABEL}`]);
        if (r.code === 0) {
            const stateLine = r.stdout.split('\n').find(l => /\sstate\s*=/.test(l));
            console.log(stateLine ? stateLine.trim() : 'service loaded');
        }
        else {
            console.log('not installed (run: tokendome service install)');
        }
        return;
    }
    if (platform === 'systemd') {
        const r = execv('systemctl', ['--user', 'is-active', 'tokendome.service']);
        console.log('systemctl --user is-active tokendome.service →', (r.stdout || r.stderr).trim());
        return;
    }
    console.error('✘ tokendome service: only macOS and Linux supported.');
    process.exit(1);
}
function setKey(dotPath, value) {
    const cfg = loadConfig();
    const parts = dotPath.split('.');
    let cur = cfg;
    for (let i = 0; i < parts.length - 1; i++) {
        cur = cur[parts[i]] ??= {};
    }
    // Coerce booleans / numbers — JSON config wants real types, not "true"
    // strings (which would be truthy AND wrong for is_local etc.).
    let coerced = value;
    if (value === 'true')
        coerced = true;
    else if (value === 'false')
        coerced = false;
    else if (/^-?\d+$/.test(value))
        coerced = Number(value);
    cur[parts[parts.length - 1]] = coerced;
    saveConfig(cfg);
    console.log('✓ set', dotPath, '=', JSON.stringify(coerced));
}
function main() {
    const [, , cmd, ...rest] = process.argv;
    switch (cmd) {
        case 'login': return login(rest[0], rest[1]);
        case 'status': return status();
        case 'set': return setKey(rest[0], rest.slice(1).join(' '));
        case 'upstream': return upstreamCmd(rest);
        case 'route': return routeCmd(rest);
        case 'captures': return capturesCmd(rest);
        case 'service': {
            const sub = rest[0];
            if (sub === 'install')
                return serviceInstall();
            if (sub === 'uninstall')
                return serviceUninstall();
            if (sub === 'status')
                return serviceStatus();
            console.error('usage: tokendome service install|uninstall|status');
            process.exit(1);
        }
        case 'capture-all': {
            const sub = rest[0];
            if (sub === 'install')
                return void captureAllInstall();
            if (sub === 'uninstall')
                return captureAllUninstall();
            console.error('usage: tokendome capture-all install|uninstall');
            process.exit(1);
        }
        case 'export-config': return exportConfigCmd();
        case 'import-config': return importConfigCmd(rest[0]);
        case 'doctor': return void doctorCmd();
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
