/**
 * POST /api/digest?key=<DIGEST_CRON_KEY>
 *
 * Sends a weekly email digest to every user who has opted in. Designed to be
 * called by Vercel Cron (or any scheduler). Idempotency is handled by the
 * caller — schedule it once a week.
 *
 * For each subscriber:
 *   - Their last-7-day rank in their primary scope (default = global)
 *   - Total tokens this week vs. last week
 *   - Top 3 models
 *   - Anyone who passed them since last digest
 *   - Any active trash-talk bubbles directed at them
 *
 * Sending uses Resend (https://resend.com) via REST. Set:
 *   RESEND_API_KEY    re_…              (mandatory)
 *   DIGEST_FROM       "Tokendome <…>"   (optional, defaults below)
 *   DIGEST_CRON_KEY   any random string (mandatory — gates this endpoint)
 *
 * Until those env vars are set the endpoint 503s with a clear message,
 * the email_subscriptions table stays empty, and the dashboard "subscribe"
 * toggle is dormant.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, now } from '../lib/shared';

export const config = { api: { bodyParser: { sizeLimit: '4kb' } } };

const FROM = process.env.DIGEST_FROM || 'Tokendome <digest@tokendome.vercel.app>';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'RESEND_API_KEY not configured on the server' });
  // Auth: accept either Vercel's auto-injected cron auth (Bearer CRON_SECRET)
  // OR a manual ?key=<DIGEST_CRON_KEY> for testing. At least one must match.
  const cronSecret = process.env.CRON_SECRET || process.env.DIGEST_CRON_KEY;
  const headerAuth = (req.headers['authorization'] || '').toString();
  const queryAuth = String(req.query.key || '');
  const ok = cronSecret && (headerAuth === `Bearer ${cronSecret}` || queryAuth === cronSecret);
  if (!ok) return res.status(401).json({ error: 'unauthorized — set CRON_SECRET and call with Authorization: Bearer <secret>' });

  const sql = db();
  const t = now();
  const weekAgo = t - 7 * 86400 * 1000;
  const twoWeeksAgo = t - 14 * 86400 * 1000;

  // Pull subscribers + everything we need to compose their emails in one
  // round trip per subscriber. (Cheap at our scale; if it grows we'll
  // batch by email_subscriptions LEFT JOIN ... GROUP BY user.)
  const subs = await sql`
    SELECT u.id, u.login, u.display_name, es.email
    FROM email_subscriptions es
    JOIN users u ON u.id = es.user_id
    WHERE es.weekly = TRUE
  `;

  const sent: Array<{ user_id: number; email: string; ok: boolean; status?: number; error?: string }> = [];
  for (const sub of subs as any[]) {
    const userId = sub.id as number;
    const handle = sub.display_name || sub.login;

    const [thisWeekRows, lastWeekRows, topModelRows, passedByRows, trashRows] = await Promise.all([
      sql`SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS total
          FROM token_events WHERE user_id = ${userId} AND ts > ${weekAgo}`,
      sql`SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS total
          FROM token_events WHERE user_id = ${userId} AND ts > ${twoWeeksAgo} AND ts <= ${weekAgo}`,
      sql`SELECT model, SUM(input_tokens + output_tokens)::bigint AS total
          FROM token_events WHERE user_id = ${userId} AND ts > ${weekAgo}
          GROUP BY model ORDER BY total DESC LIMIT 3`,
      // Anyone who out-passed this user in all-time score during the last
      // week. Ghost users are filtered: their identity must not show up
      // in another user's email, even though email isn't a public surface.
      sql`WITH ranks AS (
            SELECT t.user_id, RANK() OVER (ORDER BY (t.total_input + t.total_output) DESC) AS r
            FROM totals t
            JOIN users u ON u.id = t.user_id AND NOT u.hidden
          )
          SELECT u.login, u.display_name
          FROM ranks r
          JOIN users u ON u.id = r.user_id AND NOT u.hidden
          WHERE r.r < (SELECT r FROM ranks WHERE user_id = ${userId})
            AND u.id IN (SELECT user_id FROM token_events WHERE ts > ${weekAgo})
          LIMIT 5`,
      sql`SELECT COALESCE(s.display_name, s.login) AS sender, tt.message, tt.created_at
          FROM trash_talk tt
          JOIN users s ON s.id = tt.from_user_id AND NOT s.hidden
          WHERE tt.to_user_id = ${userId} AND tt.created_at > ${weekAgo}
          ORDER BY tt.created_at DESC LIMIT 10`,
    ]);

    const tw = Number((thisWeekRows[0] as any).total) || 0;
    const lw = Number((lastWeekRows[0] as any).total) || 0;
    const delta = tw - lw;
    const deltaStr = delta > 0 ? `+${delta.toLocaleString()}` : delta.toLocaleString();
    const trendArrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '·';

    const html = `<!doctype html>
<html><body style="font-family: ui-sans-serif, system-ui, sans-serif; max-width: 560px; margin: auto; padding: 24px; color: #0B0B10;">
<h1 style="font-size: 28px; font-weight: 900; font-style: italic; letter-spacing: -.02em; margin: 0 0 4px;">⚡ THE TOKENDOME</h1>
<p style="margin: 0 0 24px; color: #64748B; font-size: 12px; text-transform: uppercase; letter-spacing: .15em;">Weekly digest · ${handle}</p>

<div style="background:#facc15; padding: 16px; margin-bottom: 16px;">
  <div style="font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .2em;">This week</div>
  <div style="font-size: 36px; font-weight: 900; line-height: 1; font-variant-numeric: tabular-nums;">${tw.toLocaleString()}</div>
  <div style="font-size: 12px; opacity: .7; margin-top: 4px;">${trendArrow} ${deltaStr} vs. last week</div>
</div>

${topModelRows.length ? `<h3 style="font-size: 11px; text-transform: uppercase; letter-spacing: .2em; color: #64748B; margin: 24px 0 8px;">Top models</h3>
<ul style="padding-left: 16px; margin: 0;">
${(topModelRows as any[]).map(m => `<li style="font-family: ui-monospace, monospace; font-size: 13px;">${escapeHtml(String(m.model))} — ${Number(m.total).toLocaleString()} tok</li>`).join('')}
</ul>` : ''}

${passedByRows.length ? `<h3 style="font-size: 11px; text-transform: uppercase; letter-spacing: .2em; color: #64748B; margin: 24px 0 8px;">Combatants ahead of you</h3>
<p style="margin: 0; font-size: 13px;">${(passedByRows as any[]).map(r => '@' + escapeHtml(String(r.display_name || r.login))).join(' · ')}</p>` : ''}

${trashRows.length ? `<h3 style="font-size: 11px; text-transform: uppercase; letter-spacing: .2em; color: #64748B; margin: 24px 0 8px;">Trash talk this week</h3>
${(trashRows as any[]).map(t => `<blockquote style="border-left: 3px solid #facc15; padding: 4px 12px; margin: 8px 0; color: #475569; font-size: 13px;">"${escapeHtml(t.message)}" <span style="opacity:.6">— @${escapeHtml(t.sender)}</span></blockquote>`).join('')}` : ''}

<p style="margin-top: 32px; font-size: 12px; color: #64748B;">
  <a href="https://tokendome.vercel.app/" style="color: #0B0B10;">Open the dome</a> ·
  <a href="https://tokendome.vercel.app/" style="color: #94A3B8;">Manage subscription</a>
</p>
</body></html>`;

    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: FROM,
          to: [sub.email],
          subject: `⚡ Tokendome — ${tw.toLocaleString()} tok this week (${trendArrow}${deltaStr})`,
          html,
        }),
      });
      sent.push({ user_id: userId, email: sub.email, ok: r.ok, status: r.status });
    } catch (e: any) {
      sent.push({ user_id: userId, email: sub.email, ok: false, error: e.message });
    }
  }

  res.json({ ok: true, sent_count: sent.length, sent });
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
}
