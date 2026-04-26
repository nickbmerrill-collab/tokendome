# Tokendome Security and Correctness Audit

Audit date: 2026-04-25

Scope reviewed: `api/`, `lib/`, `agent/`, `sdks/`, `public/`, `schema.sql`, `server/`, package manifests, and README claims.

## CRITICAL

### Private dome leaderboards are readable without membership

File: `api/leaderboard.ts:21`, `api/leaderboard.ts:25`, `api/leaderboard.ts:58`, `api/domes.ts:39`, `api/domes.ts:42`, `api/domes.ts:152`

`/api/leaderboard?dome=<slug>` resolves a dome by slug and scopes results to its members, but it never authenticates the caller or checks that the caller belongs to that dome. Anyone who knows or guesses a slug can read the member-scoped leaderboard. `/api/domes?slug=<slug>&html=1` and `?og=1` are also explicitly public and expose the dome name, member count, top handles, and totals. That contradicts the "private domes / friend groups" model.

Concrete fix: require a signed-in member for JSON leaderboard dome scope, and decide whether public OG/HTML should require an invite token or become non-sensitive marketing-only output.

```ts
// api/leaderboard.ts
import { db, now, getCurrentUser } from '../lib/shared';

const domeSlug = String(req.query.dome || '').trim();
if (domeSlug) {
  const me = await getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  const rows = await sql`
    SELECT m.user_id
    FROM dome_members m
    JOIN domes d ON d.id = m.dome_id
    WHERE d.slug = ${domeSlug}
      AND EXISTS (
        SELECT 1 FROM dome_members mine
        WHERE mine.dome_id = d.id AND mine.user_id = ${me.id}
      )
  `;
  if (rows.length === 0) return res.status(404).json({ error: 'no such dome' });
}
```

### Correctly signed clients can forge arbitrary usage

File: `api/ingest.ts:63`, `api/ingest.ts:64`, `api/ingest.ts:65`, `api/ingest.ts:70`, `agent/src/tokendome.ts:221`, `agent/src/tokendome.ts:222`, `sdks/openai/src/index.ts:79`, `sdks/anthropic/src/index.ts:82`, `README.md:107`, `README.md:111`

The ingest endpoint authenticates the user token, but does not verify that the event came from an unmodified agent, a real provider response, or a provider billing record. A user can call `/api/ingest` directly with their own valid `agent_token` and arbitrary `provider`, `model`, `input_tokens`, and `output_tokens`. The README says there is no manual input and the only way to add totals is through the agent/SDK, but the server accepts any signed JSON payload.

Concrete fix: adjust claims to "tamper-evident per user, not cheat-proof" unless implementing stronger validation. For real enforcement, separate live agent events from provider-verified imports, show trust levels, add anomaly detection, and require provider-scoped idempotency for direct provider data. Do not call the leaderboard "provider-verified" for agent events.

## HIGH

### Ingest signatures are replayable for 60 seconds

File: `api/ingest.ts:34`, `api/ingest.ts:38`, `api/ingest.ts:47`, `api/ingest.ts:48`, `api/ingest.ts:101`, `schema.sql:13`

The server rejects timestamps outside a 60 second drift window, but stores no nonce, request hash, or event id. Anyone who observes a signed request can replay it repeatedly inside the 60 second window and inflate totals. The README says "You can't replay" on the public how-it-works page, but replay protection is only clock drift.

Concrete fix: add a `ingest_nonces` or `ingest_requests` table keyed by `(user_id, ts, body_hash, sig)` with a short TTL and insert-before-accept semantics.

```sql
CREATE TABLE ingest_requests (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts BIGINT NOT NULL,
  body_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, ts, body_hash)
);
```

```ts
const seen = await sql`
  INSERT INTO ingest_requests (user_id, ts, body_hash, created_at)
  VALUES (${user.id}, ${Number(ts)}, ${bodyHash}, ${now()})
  ON CONFLICT DO NOTHING
  RETURNING 1
`;
if (seen.length === 0) return res.status(409).send('replay');
```

### Agent tokens are stored in plaintext

File: `schema.sql:9`, `api/auth/callback.ts:45`, `api/auth/callback.ts:47`, `api/ingest.ts:48`, `api/me.ts:88`

`users.agent_token` stores the raw HMAC key. A database read leak gives an attacker all active ingest credentials. This is weaker than password/API-token storage best practice.

Concrete fix: derive separate public token id and secret. Store only a keyed hash of the secret, or encrypt the HMAC key with KMS. Since HMAC verification needs the secret or a stable equivalent, the pragmatic pattern is:

- token shown once: `<user_id>.<token_id>.<secret>`
- DB columns: `token_id`, `token_hash = HMAC(PEPPER, secret)` or Argon2id if request volume is low
- lookup by `user_id, token_id`, verify secret hash, then use either the raw secret supplied by the request to recompute the event HMAC or switch to `HMAC(token_hash, ts.body_hash)` on both client and server.

### Ingest HMAC comparison is not timing-safe

File: `api/ingest.ts:48`, `api/ingest.ts:49`, `lib/shared.ts:69`, `lib/shared.ts:70`

Session and OAuth state signatures use `crypto.timingSafeEqual`, but ingest uses `expected !== sig`. The timing side channel is harder to exploit over the network than a local oracle, but this is still inconsistent with the security claim and easy to fix.

Concrete fix:

```ts
import * as crypto from 'node:crypto';

const expectedBuf = Buffer.from(expected, 'hex');
const sigBuf = Buffer.from(sig, 'hex');
if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(expectedBuf, sigBuf)) {
  return res.status(401).send('bad signature');
}
```

Also reject non-hex signatures before converting.

### Server clamps oversized events instead of rejecting them

File: `api/ingest.ts:58`, `api/ingest.ts:60`, `api/ingest.ts:64`, `api/ingest.ts:65`, `public/how-it-works.html:119`, `README.md:113`

The README says single events over 2M tokens are capped/rejected; the how-it-works page says "rejects single events > 2M tokens". The implementation clamps each side to 2M and accepts the event. A malicious user can submit endless 2M/2M events, and the response still says accepted.

Concrete fix:

```ts
if (e.input_tokens > MAX || e.output_tokens > MAX) {
  return res.status(413).send('event too large');
}
```

Reject negative and non-integer token fields too, rather than silently normalizing.

### Raw ingest body has no size limit

File: `api/ingest.ts:21`, `api/ingest.ts:23`, `api/ingest.ts:24`, `api/ingest.ts:45`

The Vercel body parser is disabled so signatures can be verified over exact bytes, but `readRawBody` buffers the entire request without enforcing a maximum. An unauthenticated attacker can send very large bodies and force memory/CPU work before JSON parsing and batch-size checks.

Concrete fix: enforce a byte limit while reading. For 500 compact events, 256KB or 512KB is ample.

```ts
async function readRawBody(req: VercelRequest, limit = 512 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as any) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += b.length;
    if (total > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}
```

### Host header is trusted for OAuth URLs, invite URLs, OG URLs, and server-side fetches

File: `lib/shared.ts:126`, `lib/shared.ts:127`, `lib/shared.ts:128`, `api/auth/github.ts:6`, `api/auth/callback.ts:23`, `api/domes.ts:109`, `api/profile/[login].ts:135`, `api/profile/[login].ts:145`, `api/domes.ts:184`, `api/domes.ts:191`

`publicUrl(req)` uses `x-forwarded-host`, `host`, and `x-forwarded-proto` directly. These values feed OAuth `redirect_uri`, generated invite links, OG URLs, and `fetch(`${base}/index.html`)`. If the deployment accepts untrusted Host headers, this enables host-header poisoning and can become SSRF from the profile/dome HTML endpoints.

Concrete fix: use a configured canonical origin such as `PUBLIC_URL`, and only fall back to request headers in local dev.

```ts
export function publicUrl(_req: VercelRequest): string {
  const origin = process.env.PUBLIC_URL;
  if (!origin) throw new Error('PUBLIC_URL not set');
  return origin.replace(/\/$/, '');
}
```

### Admin imports are not atomic and can double-count under concurrent runs

File: `api/import.ts:192`, `api/import.ts:194`, `api/import.ts:207`, `api/import.ts:223`

The idempotency model is "delete prior import for `(user, source, provider)`, insert rows, recompute totals". That is idempotent for sequential retries, but not safe under concurrent imports. Two overlapping requests can both delete, both insert, and then totals can include duplicate rows. There is no transaction or advisory lock.

Concrete fix: wrap delete/insert/recompute in a transaction, or take a per-user/provider/source advisory lock. Neon template API may require `sql.transaction`.

```ts
await sql.transaction(async tx => {
  await tx`SELECT pg_advisory_xact_lock(${userId}, hashtext(${source + ':' + provider}))`;
  await tx`DELETE FROM token_events WHERE user_id = ${userId} AND source = ${source} AND provider = ${provider}`;
  // insert rows
  // recompute totals
});
```

### Ghost users leak through weekly digest rankings and trash-talk

File: `api/digest.ts:50`, `api/digest.ts:51`, `api/digest.ts:75`, `api/digest.ts:77`, `api/digest.ts:81`, `api/digest.ts:83`, `README.md:95`

Public API surfaces filter `u.hidden`, but weekly digest queries do not. `passedByRows` can email another subscriber a hidden user's GitHub login/display name, and `trashRows` can reveal a hidden sender. Ghost mode is documented as "you don't appear on any public surface"; email is not public, but it is still a cross-user surface.

Concrete fix: filter hidden users anywhere their identity is sent to another user.

```sql
JOIN users u ON u.id = r.user_id AND NOT u.hidden
JOIN users s ON s.id = tt.from_user_id AND NOT s.hidden
```

### The legacy Cloudflare Worker leaks internals and lacks current privacy controls

File: `server/src/index.ts:42`, `server/src/index.ts:44`, `server/src/index.ts:253`, `server/src/index.ts:254`, `server/src/index.ts:274`, `server/src/index.ts:319`, `server/src/index.ts:321`, `server/schema.sql:2`

The `server/` implementation appears older than the Vercel API, but it is still in the repo with deploy scripts. It returns `Internal error: <err.message>` to clients, uses non-timing-safe ingest comparison, truncates event timestamps with `e.ts | 0`, and has no pseudonym/ghost-mode schema or filters. If deployed, it violates multiple current README claims.

Concrete fix: remove `server/` if it is obsolete, or bring it to parity with the Vercel implementation before keeping deploy instructions.

## MEDIUM

### No durable rate limiting on ingest, leaderboards, OAuth, or imports

File: `api/ingest.ts:31`, `api/leaderboard.ts:9`, `api/auth/github.ts:4`, `api/import.ts:244`, `api/trash-talk.ts:18`

Only trash-talk has a naive in-memory per-instance cooldown. Ingest, leaderboard, OAuth start/callback, and import endpoints have no durable IP/user/token rate limits. `/api/leaderboard` runs many aggregate queries in parallel and is cacheable for only two seconds. `/api/import` can trigger expensive provider API calls for every authenticated request.

Concrete fix: add platform rate limits per IP and per authenticated user/token. For ingest, enforce events/min and tokens/min per user. For import, allow one active import per `(user, provider)` and add a cooldown.

### Dome membership can be enumerated from public slug responses

File: `api/domes.ts:42`, `api/domes.ts:154`, `api/domes.ts:156`, `api/domes.ts:165`, `api/domes.ts:166`, `api/domes.ts:179`

Even aside from the JSON leaderboard issue, the public dome OG endpoint returns member count, top handles, and token totals for a slug. If domes are meant to be private friend groups, a slug should not be sufficient to reveal membership metadata.

Concrete fix: require an invite code for public preview, or return generic metadata until the viewer is a member.

### Hidden users still affect public profile rank numbers

File: `api/profile/[login].ts:69`, `api/profile/[login].ts:71`, `api/profile/[login].ts:74`, `api/profile/[login].ts:78`

Profile lookup hides ghost users themselves, but the rank CTEs rank across all users, including hidden users. Public users can see rank gaps or unexpectedly lower ranks caused by hidden accounts. This is not direct identity disclosure, but it makes ghost users influence public surfaces.

Concrete fix: add `JOIN users u ON u.id = totals.user_id AND NOT u.hidden` to rank CTEs, and similarly filter weekly/local ranks.

### Ollama streaming usage is never recorded

File: `agent/src/tokendome.ts:426`, `agent/src/tokendome.ts:429`, `agent/src/tokendome.ts:554`, `agent/src/tokendome.ts:560`, `agent/src/tokendome.ts:586`, `agent/src/tokendome.ts:588`

Native Ollama streaming is `application/x-ndjson`, so the proxy enters the streaming branch and accumulates parsed lines in `sseEvents`. `extractOllamaNative` ignores `ctx.sseEvents` and only reads `ctx.bodyChunks`, which is empty in that branch. Non-streaming Ollama works; streaming does not report usage.

Concrete fix:

```ts
const raw = ctx.bodyChunks.length
  ? Buffer.concat(ctx.bodyChunks).toString('utf8')
  : ctx.sseEvents.join('\n');
```

### Anthropic proxy ignores routed provider/local flags

File: `agent/src/tokendome.ts:373`, `agent/src/tokendome.ts:382`, `agent/src/tokendome.ts:384`, `agent/src/tokendome.ts:418`, `agent/src/tokendome.ts:419`

`extractAnthropic` hardcodes `provider: 'anthropic'` and `is_local: false`, unlike `extractOpenAI`, which uses `ctx.provider` and `ctx.is_local`. If a user retargets the Anthropic upstream to a local/self-hosted Anthropic-compatible endpoint, events are reported as paid cloud Anthropic usage.

Concrete fix: use the route context in both non-streaming and streaming Anthropic events.

```ts
provider: ctx.provider,
is_local: ctx.is_local,
```

### Digest HTML does not escape model names or passed-by handles

File: `api/digest.ts:105`, `api/digest.ts:107`, `api/digest.ts:110`, `api/digest.ts:111`, `api/digest.ts:145`

Trash-talk fields are escaped in the email, but top model names and "combatants ahead of you" handles are interpolated directly into HTML. Model names can come from signed ingest events and are attacker-controlled for the sender's own account; display names are currently restricted, but GitHub logins/model names should still be escaped consistently.

Concrete fix: wrap all interpolated HTML text with `escapeHtml`, including `m.model`, `r.display_name`, and `r.login`.

### State-changing endpoints rely only on SameSite cookies for CSRF

File: `api/me.ts:8`, `api/domes.ts:69`, `api/domes.ts:130`, `api/domes.ts:119`, `api/trash-talk.ts:22`, `api/import.ts:244`, `lib/shared.ts:78`

Session cookies use `SameSite=Lax`, which blocks most cross-site POSTs in modern browsers, but no endpoint verifies an explicit CSRF token or Origin. This is usually acceptable for a small app but brittle across browser quirks, same-site subdomains, and future embedding.

Concrete fix: add a signed CSRF token returned by `/api/me` and require it on all authenticated mutating endpoints, or enforce `Origin`/`Sec-Fetch-Site` checks.

### Import error responses can leak upstream internals

File: `api/import.ts:73`, `api/import.ts:78`, `api/import.ts:120`, `api/import.ts:125`, `api/import.ts:287`

Provider error bodies are returned to the browser as `upstream`. They are sliced to 500 bytes, but could still include account identifiers, request IDs, or provider diagnostic details. This endpoint is authenticated, but the user is pasting highly privileged admin keys.

Concrete fix: log provider diagnostics server-side with redaction and return a generic user-safe message plus status code.

### Shell install and SDK one-liners put agent tokens into shell history

File: `public/index.html:1119`, `public/index.html:1120`, `public/index.html:1123`, `public/index.html:1126`, `api/me.ts:88`

The dashboard builds commands with `TOKENDOME_TOKEN=<secret>` inline. Users who paste these commands will likely store the token in shell history, terminal scrollback, and possibly command telemetry. The UI labels the token secret but encourages a leaky transport.

Concrete fix: prefer `tokendome login` prompt/stdin, or copy a token separately with explicit warning. For one-liners, use a short-lived install code exchanged server-side for the real token after OAuth.

### SDK dependency ranges are too broad for security-sensitive shims

File: `sdks/openai/package.json:25`, `sdks/anthropic/package.json:25`, `sdks/openai/package-lock.json:31`, `sdks/anthropic/package-lock.json:18`

The OpenAI shim allows `openai >=4.50.0`; the Anthropic shim allows `@anthropic-ai/sdk >=0.30.0` as a peer and has lock/package mismatch. These packages monkey-patch SDK internals, so broad future-major ranges can silently break instrumentation or usage extraction.

Concrete fix: pin and test known-compatible major ranges, for example `^6.34.0` for OpenAI if that is what was tested, and update intentionally with CI streaming/non-streaming fixtures.

## LOW

### OAuth state is not single-use in the Vercel implementation

File: `lib/shared.ts:84`, `lib/shared.ts:91`, `api/auth/github.ts:11`, `api/auth/callback.ts:10`, `api/auth/callback.ts:11`, `api/auth/callback.ts:59`

OAuth state is signed and short-lived, and the cookie is cleared after success. It is not stored server-side or consumed atomically, so the same state can be reused until expiry if the cookie remains available. The GitHub code itself should be single-use, so practical impact is low.

Concrete fix: store state nonces server-side with TTL and delete on callback, or include a double-submit cookie plus Origin validation.

### Logout cookie clearing omits security attributes

File: `lib/shared.ts:76`, `lib/shared.ts:80`, `lib/shared.ts:81`

The session cookie is set with `HttpOnly; Secure; SameSite=Lax`, but cleared with only `Path=/; Max-Age=0`. Browsers generally clear by name/path/domain, but matching attributes avoids edge cases.

Concrete fix:

```ts
ta_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0
```

### Display name uniqueness is only application-enforced

File: `api/me.ts:24`, `api/me.ts:25`, `api/me.ts:31`, `api/me.ts:33`, `schema.sql:5`, `schema.sql:6`

The app checks display-name collisions before update, but there is no database unique index on `lower(display_name)`. Concurrent requests can race and assign the same display name, undermining pseudonym routing and impersonation protection.

Concrete fix:

```sql
CREATE UNIQUE INDEX users_display_name_lower_unique
ON users (lower(display_name))
WHERE display_name IS NOT NULL;
```

Consider a second index on `lower(login)` or a trigger if display names must never collide with any login.

### Invite codes are short bearer secrets

File: `api/domes.ts:95`, `api/domes.ts:138`, `schema.sql:43`

Invite codes are 6 random bytes rendered as 12 hex characters. That is 48 bits, which is probably enough against casual guessing if rate limited, but there is no join rate limit. A longer code is cheap.

Concrete fix: use at least 16 random bytes and rate-limit join attempts per IP/user.

### Admin import rows are not capped like live ingest rows

File: `api/import.ts:178`, `api/import.ts:179`, `api/import.ts:181`, `api/import.ts:182`, `api/import.ts:207`

CSV and provider imports parse non-negative numbers but do not apply the 2M per-event cap used by ingest. Admin API daily buckets can legitimately exceed 2M, but CSV can be hand-edited and is not provider-verified.

Concrete fix: apply caps to CSV imports or mark CSV rows as unverified and exclude them from "provider-scoped Admin API" claims.

### `npm audit` could not run in this environment

File: `package.json:10`, `agent/package.json:11`, `sdks/openai/package.json:24`, `sdks/anthropic/package.json:24`, `server/package.json:10`

Dependency audit attempted for root, agent, and SDK workspaces, but network access to `registry.npmjs.org` failed with `ENOTFOUND`. I reviewed manifests and locks locally, but this audit does not include current advisory database results.

Concrete fix: run `npm audit --workspaces` or separate audits for each package in CI with network access.

## INFO

### SQL injection review: current API queries are parameterized

File: `api/ingest.ts:41`, `api/leaderboard.ts:25`, `api/profile/[login].ts:22`, `api/domes.ts:75`, `api/trash-talk.ts:42`, `api/import.ts:194`

The Vercel API consistently uses Neon tagged templates for dynamic SQL values. I did not find string-concatenated SQL in `api/` or `lib/`.

### GitHub OAuth has state and secure session cookies

File: `api/auth/github.ts:5`, `api/auth/github.ts:10`, `api/auth/github.ts:11`, `api/auth/callback.ts:10`, `api/auth/callback.ts:11`, `lib/shared.ts:63`, `lib/shared.ts:70`, `lib/shared.ts:78`

The Vercel OAuth flow creates a signed short-lived state value, stores it in an `HttpOnly; Secure; SameSite=Lax` cookie, checks callback state against the cookie, and signs the session cookie with timing-safe verification. Callback redirects to `/`, so there is no obvious `next=` open redirect in the callback itself. The Host-header issue above still needs fixing.

### Privacy send path matches the "counts only" claim for agent and SDK telemetry

File: `agent/src/tokendome.ts:115`, `agent/src/tokendome.ts:221`, `agent/src/tokendome.ts:222`, `agent/src/tokendome.ts:226`, `sdks/openai/src/index.ts:31`, `sdks/openai/src/index.ts:80`, `sdks/openai/src/index.ts:86`, `sdks/anthropic/src/index.ts:32`, `sdks/anthropic/src/index.ts:83`, `sdks/anthropic/src/index.ts:89`

The agent and SDK shims serialize `{ events: [...] }` containing timestamp, provider, model, local flag, token counts, and optional cache/reasoning counts. They do not send prompts, completions, tool calls, request URLs, upstream API keys, or response bodies to Tokendome. Debug logging logs ingest status and local event counts, not prompt/completion content.

### HMAC byte format matches between clients and Vercel ingest

File: `agent/src/tokendome.ts:222`, `agent/src/tokendome.ts:224`, `agent/src/tokendome.ts:225`, `sdks/openai/src/index.ts:80`, `sdks/openai/src/index.ts:82`, `sdks/openai/src/index.ts:83`, `sdks/anthropic/src/index.ts:83`, `sdks/anthropic/src/index.ts:85`, `sdks/anthropic/src/index.ts:86`, `api/ingest.ts:21`, `api/ingest.ts:45`, `api/ingest.ts:47`, `api/ingest.ts:48`

The Vercel ingest route disables body parsing and verifies the HMAC over the raw request body string. The agent and SDKs all use `JSON.stringify({ events })`, SHA-256 that exact body, and sign `${ts}.${bodyHash}`. For the project’s own UTF-8 JSON clients, the byte-level format is consistent.

### Clock drift check uses the server clock

File: `api/ingest.ts:19`, `api/ingest.ts:38`

The stale check compares `x-ta-ts` to `Date.now()` on the server. It does not trust event `e.ts` for replay freshness.

### Pseudonyms and ghost mode are mostly enforced on public API surfaces

File: `api/leaderboard.ts:53`, `api/leaderboard.ts:54`, `api/leaderboard.ts:58`, `api/profile/[login].ts:20`, `api/profile/[login].ts:26`, `api/profile/[login].ts:27`, `api/profile/[login].ts:33`, `api/profile/[login].ts:34`, `api/me.ts:80`, `api/me.ts:86`

Leaderboard and profile JSON use `COALESCE(display_name, login)`, suppress GitHub avatars when `display_name` is set, and exclude `hidden` users from main public result sets. The remaining leaks are called out above: digest queries, rank calculations, and public dome previews.

### Frontend rendering generally escapes or uses text nodes

File: `public/index.html:749`, `public/index.html:856`, `public/index.html:889`, `public/index.html:893`, `public/index.html:923`, `public/index.html:926`, `public/index.html:1415`

Most user-controlled frontend values are written via `textContent` or passed through the local `esc()` helper before `innerHTML`. Trash-talk bubbles are set with `textContent`, and model names in the profile drawer are escaped. The digest email is the main escaping gap found.

### Hot-path indexes exist, but aggregate scale will be limited

File: `schema.sql:32`, `schema.sql:33`, `schema.sql:53`, `schema.sql:76`, `api/leaderboard.ts:41`, `api/leaderboard.ts:51`

There are indexes on `(user_id, ts)`, `ts`, dome membership by user, and trash-talk expiry by target. At 10k users, the current leaderboard endpoint still runs multiple aggregates over `token_events` every few seconds. It will need rollup tables/materialized views for provider, week, velocity, and sparkline buckets.

