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
    // Pick is_local from the user's per-upstream config — defaults match reality
    // (only `ollama` is local out of the box) but can be overridden so e.g.
    // pointing `openai` at a local vLLM/llama.cpp/MLX server gets correctly
    // tagged as local compute.
    const localFor = (name) => cfg.upstreams[name].is_local ?? (name === 'ollama');
    if (urlPath.startsWith('/v1/messages') || urlPath === '/v1/complete') {
        return { provider: 'anthropic', base: cfg.upstreams.anthropic.base, is_local: localFor('anthropic'), extractor: extractAnthropic };
    }
    if (urlPath.startsWith('/api/generate') || urlPath.startsWith('/api/chat') || urlPath.startsWith('/api/embed')) {
        return { provider: 'ollama', base: cfg.upstreams.ollama.base, is_local: localFor('ollama'), extractor: extractOllamaNative };
    }
    if (urlPath.startsWith('/v1beta/')) {
        return { provider: 'google', base: cfg.upstreams.google.base, is_local: localFor('google'), extractor: extractGoogle };
    }
    if (urlPath.startsWith('/v1/')) {
        let model = '';
        if (body.length) {
            try {
                model = (JSON.parse(body.toString('utf8')).model || '').toString();
            }
            catch { }
        }
        if (model.startsWith('claude-')) {
            return { provider: 'anthropic', base: cfg.upstreams.anthropic.base, is_local: localFor('anthropic'), extractor: extractOpenAI };
        }
        if (model.startsWith('gemini-')) {
            return { provider: 'google', base: cfg.upstreams.google.base, is_local: localFor('google'), extractor: extractOpenAI };
        }
        if (model.startsWith('ollama/')) {
            return { provider: 'ollama', base: cfg.upstreams.ollama.base, is_local: localFor('ollama'), extractor: extractOpenAI };
        }
        return { provider: 'openai', base: cfg.upstreams.openai.base, is_local: localFor('openai'), extractor: extractOpenAI };
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
    for (const [k, v] of Object.entries(cfg.upstreams)) {
        const localTag = v.is_local ? ' 🏠 local' : '';
        console.log(`  ${k}: ${v.base}${localTag}`);
    }
}
function help() {
    console.log(`tokendome — local token telemetry agent

  tokendome login <token> [server_url]   save your credentials
  tokendome start                        run the proxy (foreground)
  tokendome status                       show config
  tokendome set <key> <value>            e.g. tokendome set upstreams.ollama.base http://192.168.1.5:11434
                                         e.g. tokendome set upstreams.openai.is_local true   (mark a self-hosted OpenAI-compat server as local)
  tokendome service install              install as a launchd/systemd user service so the proxy starts on login
  tokendome service uninstall            remove the user service
  tokendome service status               show whether the user service is loaded
  tokendome help
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
