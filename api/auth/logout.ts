import type { VercelRequest, VercelResponse } from '@vercel/node';
import { clearSessionCookie } from '../../lib/shared';

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  clearSessionCookie(res);
  res.redirect(302, '/');
}
