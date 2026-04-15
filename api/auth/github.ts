import type { VercelRequest, VercelResponse } from '@vercel/node';
import { makeState, publicUrl } from '../../lib/shared';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const state = makeState();
  const redirect = `${publicUrl(req)}/api/auth/callback`;
  const url = `https://github.com/login/oauth/authorize`
    + `?client_id=${process.env.GITHUB_CLIENT_ID}`
    + `&redirect_uri=${encodeURIComponent(redirect)}`
    + `&scope=read:user&state=${state}`;
  res.setHeader('Set-Cookie', `ta_oauth=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  res.redirect(302, url);
}
