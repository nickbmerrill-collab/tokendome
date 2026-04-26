import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  db, now, randomHex, parseCookies, verifyState,
  makeSession, setSessionCookie, publicUrl, encryptAgentToken,
} from '../../lib/shared';

// Tokendome can be mounted at the origin root or under a path prefix
// (heyelab.com/tokendome). The post-OAuth redirect must land back on
// the dashboard, not the bare origin. Derive the path component from
// the configured public URL so /tokendome/ stays correct.
function dashboardPath(req: any): string {
  try {
    const u = new URL(publicUrl(req));
    return (u.pathname || '/').replace(/\/?$/, '/');
  } catch {
    return '/';
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const code = String(req.query.code || '');
  const stateParam = String(req.query.state || '');
  const stateCookie = parseCookies(req)['ta_oauth'];
  if (!code || !stateParam || stateParam !== stateCookie || !verifyState(stateParam)) {
    return res.status(400).send('bad state');
  }

  // Exchange code for token
  const tokRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${publicUrl(req)}/api/auth/callback`,
    }),
  });
  const tok = await tokRes.json() as { access_token?: string };
  if (!tok.access_token) return res.status(400).send('oauth exchange failed');

  // Fetch GitHub profile
  const meRes = await fetch('https://api.github.com/user', {
    headers: {
      authorization: `Bearer ${tok.access_token}`,
      'user-agent': 'tokendome',
      accept: 'application/vnd.github+json',
    },
  });
  const gh = await meRes.json() as { id: number; login: string; avatar_url: string };
  if (!gh.id) return res.status(400).send('github profile fetch failed');

  const sql = db();
  // Upsert user
  const existing = await sql`SELECT * FROM users WHERE github_id = ${gh.id}`;
  let userId: number;
  if (existing.length === 0) {
    const agent = randomHex(32);
    const rows = await sql`
      INSERT INTO users (github_id, login, avatar_url, agent_token, created_at)
      VALUES (${gh.id}, ${gh.login}, ${gh.avatar_url}, ${encryptAgentToken(agent)}, ${now()})
      RETURNING id
    `;
    userId = rows[0].id;
  } else {
    userId = existing[0].id;
    await sql`UPDATE users SET login = ${gh.login}, avatar_url = ${gh.avatar_url} WHERE id = ${userId}`;
  }

  setSessionCookie(res, makeSession(userId));
  // Clear OAuth state cookie
  res.setHeader('Set-Cookie', [
    res.getHeader('Set-Cookie') as string,
    'ta_oauth=; Path=/; Max-Age=0',
  ].filter(Boolean).flat() as string[]);
  res.redirect(302, dashboardPath(req));
}
