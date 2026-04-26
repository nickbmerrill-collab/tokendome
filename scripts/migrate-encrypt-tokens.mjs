#!/usr/bin/env node
/**
 * One-shot migration: wrap every plaintext agent_token in users with
 * AES-256-GCM-at-rest encryption. Idempotent — already-encrypted rows
 * (those starting with `enc1:`) are skipped.
 *
 * Run once after deploying the encryption code:
 *   DATABASE_URL=… SESSION_SECRET=… node scripts/migrate-encrypt-tokens.mjs
 */
import { neon } from '@neondatabase/serverless';
import * as crypto from 'node:crypto';

const PREFIX = 'enc1:';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
if (!process.env.SESSION_SECRET) { console.error('SESSION_SECRET not set'); process.exit(1); }

function tokenKey() {
  const ikm = Buffer.from(process.env.SESSION_SECRET, 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), 'tokendome-agent-token-v1', 32));
}
function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', tokenKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64url');
}

const sql = neon(process.env.DATABASE_URL);
const rows = await sql`SELECT id, agent_token FROM users WHERE agent_token NOT LIKE ${PREFIX + '%'}`;
console.log(`Found ${rows.length} plaintext token(s) to migrate.`);
let migrated = 0;
for (const r of rows) {
  const enc = encrypt(r.agent_token);
  await sql`UPDATE users SET agent_token = ${enc} WHERE id = ${r.id}`;
  migrated++;
}
console.log(`Encrypted ${migrated} agent_token(s) at rest.`);
