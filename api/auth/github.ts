import type { VercelRequest, VercelResponse } from '@vercel/node';
import { makeState, publicUrl, rateCheck, clientIp } from '../../lib/shared';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Per-IP throttle on OAuth init. 20 starts/min is well above what an
  // honest user does even if they bounce through several browser windows,
  // and it caps the rate at which an attacker can probe the OAuth flow.
  const rl = await rateCheck(`oauth:ip:${clientIp(req)}`, 20, 60_000);
  if (!rl.ok) {
    res.setHeader('Retry-After', String(Math.ceil((rl.retry_after_ms ?? 60_000) / 1000)));
    return res.status(429).send('rate limited');
  }
  const state = makeState();
  const redirect = `${publicUrl(req)}/api/auth/callback`;
  const url = `https://github.com/login/oauth/authorize`
    + `?client_id=${process.env.GITHUB_CLIENT_ID}`
    + `&redirect_uri=${encodeURIComponent(redirect)}`
    + `&scope=read:user&state=${state}`;
  res.setHeader('Set-Cookie', `ta_oauth=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  res.redirect(302, url);
}
