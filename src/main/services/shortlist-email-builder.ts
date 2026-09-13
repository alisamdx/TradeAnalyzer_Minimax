// Wheel Shortlist email — five ideas, so a compact table of cards, not the dice's single card.
//
// Same email constraints as `dice-email-builder.ts`: table layout, inline styles, explicit light
// colours, 560px max. Every formatter tolerates a missing value — a malformed entry shows "—"
// rather than costing the whole email (the lesson of v1.1.241).

import type { ShortlistEntry, ShortlistResult } from '@shared/wheel-shortlist.js';
import { SHORTLIST_PROFILE as P } from '@shared/wheel-shortlist.js';
import { ownAtStrikeNote } from '@shared/own-at-strike.js';
import { etradeQuoteUrl, etradeOptionsUrl } from './etrade-links.js';

const BG = '#f6f8fa';
const CARD = '#ffffff';
const BORDER = '#d0d7de';
const TEXT = '#24292f';
const MUTED = '#57606a';
const ACCENT = '#0969da';
const WARN = '#9a6700';

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}
const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const fixed = (n: unknown, d: number): string => (isNum(n) ? n.toFixed(d) : '—');
const money = (n: unknown): string => (isNum(n) ? `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—');
const money2 = (n: unknown): string => (isNum(n) ? `$${n.toFixed(2)}` : '—');

function prettyDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }) + ' '
    + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function shortlistEmailSubject(r: ShortlistResult): string {
  if (r.entries.length === 0) {
    return `\u{1F3AF} Wheel Shortlist — nothing qualified (${r.considered} considered)`;
  }
  const t = r.entries[0]!;
  return `\u{1F3AF} Wheel Shortlist — ${r.entries.length} idea${r.entries.length === 1 ? '' : 's'} · top: `
    + `${t.ticker} $${t.contract.strike} put ${prettyDate(t.contract.expiration)} · ${fixed(t.contract.premiumRocAnnualPct, 0)}%/yr`;
}

/** The D3 roll-room line, in words. */
export function rollRoomText(e: ShortlistEntry): string {
  const r = e.rollRoom;
  if (!r) return 'Roll room: roll expiry not priced.';
  if (r.strike == null) return `Roll room: no same-or-lower strike covers the buy-back in ${prettyDate(r.expiration)} at today's prices.`;
  if (!r.dollarsLower) return `Roll room: same strike only, ${prettyDate(r.expiration)} (at today's prices).`;
  return `Roll room: down to $${r.strike} (${money2(r.dollarsLower)} lower, ${r.strikesLower} strike${r.strikesLower === 1 ? '' : 's'}) `
    + `in ${prettyDate(r.expiration)} at today's prices.`;
}

function entryCard(e: ShortlistEntry, i: number): string {
  const c = e.contract;
  const link = (href: string, label: string): string =>
    `<a href="${esc(href)}" target="_blank" style="color:${ACCENT};text-decoration:underline;">${esc(label)}</a>`;
  const critic = e.criticVerdict ? ` · critic ${esc(e.criticVerdict)}` : '';
  return `
    <tr><td style="padding:10px 18px 0;">
      <div style="border:1px solid ${BORDER};border-radius:8px;background:${CARD};padding:10px 12px;">
        <div style="font-size:15px;font-weight:700;color:${TEXT};">
          ${i + 1}. Sell ${esc(e.ticker)} $${esc(c.strike)} put · ${esc(prettyDate(c.expiration))} (${esc(c.dte)}d)
        </div>
        <div style="font-size:12px;color:${MUTED};margin-top:2px;">
          ${esc(e.ticker)} at ${money2(e.spot)} · Δ ${fixed(c.delta, 2)} (~${fixed(e.assignmentProbPct, 0)}% ITM odds)${critic}
        </div>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:8px;">
          <tr>
            <td style="font-size:12px;color:${MUTED};">Return on capital</td>
            <td style="font-size:14px;font-weight:700;color:${TEXT};text-align:right;">${fixed(c.premiumRocAnnualPct, 1)}%/yr</td>
          </tr>
          <tr>
            <td style="font-size:12px;color:${MUTED};">Credit</td>
            <td style="font-size:13px;color:${TEXT};text-align:right;">${money(e.creditPerContract)} · mid ${money2(c.mid)} (bid ${money2(c.bid)})</td>
          </tr>
          <tr>
            <td style="font-size:12px;color:${MUTED};">Cash required</td>
            <td style="font-size:13px;color:${TEXT};text-align:right;">${money(e.capitalRequired)}</td>
          </tr>
          <tr>
            <td style="font-size:12px;color:${MUTED};">Spread · open interest</td>
            <td style="font-size:13px;color:${TEXT};text-align:right;">${fixed(c.spreadPct, 1)}% · ${esc(c.openInterest ?? '—')}</td>
          </tr>
          <tr>
            <td style="font-size:12px;color:${MUTED};">Next earnings</td>
            <td style="font-size:13px;color:${TEXT};text-align:right;">${esc(prettyDate(e.earningsDate))}</td>
          </tr>
        </table>
        <div style="font-size:12px;color:${TEXT};line-height:1.55;margin-top:8px;">${esc(rollRoomText(e))}</div>
        <div style="font-size:11px;color:${MUTED};line-height:1.55;margin-top:4px;">${esc(ownAtStrikeNote(e.ticker, e.ownership))}</div>
        <div style="font-size:11px;color:${MUTED};margin-top:6px;">
          E*Trade: ${link(etradeQuoteUrl(e.ticker), 'quote')} &middot; ${link(etradeOptionsUrl(e.ticker), 'option chain')}
        </div>
      </div>
    </td></tr>`;
}

export function buildShortlistEmailHtml(r: ShortlistResult, dateStr: string): string {
  const head = `
    <tr><td style="padding:16px 18px 4px;">
      <div style="font-size:18px;font-weight:700;color:${TEXT};">\u{1F3AF} Wheel Shortlist</div>
      <div style="font-size:12px;color:${MUTED};margin-top:3px;">
        ${esc(dateStr)} · ${esc(r.considered)} candidate${r.considered === 1 ? '' : 's'} considered ·
        puts at ${P.deltaMin}–${P.deltaMax}Δ, ${P.dteMin}–${P.dteMax} DTE · ranked by return on capital
      </div>
      <div style="font-size:11px;color:${WARN};border:1px solid ${WARN};background:#fff8e6;border-radius:6px;padding:6px 8px;margin-top:8px;line-height:1.5;">
        Advisory and not yet validated on this profile: the ranking was measured on 0.20–0.35Δ / 30–45 DTE
        puts. Capital is shown, never filtered — sizing is your call.
      </div>
    </td></tr>`;

  const body = r.entries.length === 0
    ? `<tr><td style="padding:10px 18px;font-size:14px;color:${TEXT};line-height:1.55;">${esc(r.noResultReason ?? 'Nothing qualified today.')}</td></tr>`
    : r.entries.map(entryCard).join('');

  const rejects = r.rejections.length > 0
    ? `<tr><td style="padding:12px 18px 0;font-size:11px;color:${MUTED};line-height:1.7;">
         <b>${r.rejections.length} excluded:</b> ${r.rejections.map(x => `${esc(x.ticker)} (${esc(x.reason)})`).join(' · ')}
       </td></tr>`
    : '';

  const foot = `
    <tr><td style="padding:14px 18px 18px;">
      <div style="border-top:1px solid ${BORDER};padding-top:10px;font-size:11px;color:${MUTED};line-height:1.6;">
        <b>Your roll rule:</b> if the put is in the money with ${P.rollTriggerDte} or fewer days left, roll out to the next
        ${P.dteMin}–${P.dteMax} DTE expiry at the same or a lower strike for a net credit; if no credit roll exists, close it.
        Roll room is measured at today's prices — at a real roll the put costs more to buy back.
        Marks are midpoints. Not investment advice.
        <br><span style="color:${ACCENT};">TradeAnalyzer</span> · from the ${esc(r.briefGeneratedAt ?? 'latest')} brief run.
      </div>
    </td></tr>`;

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:${BG};">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${BG};">
    <tr><td align="center" style="padding:18px 10px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560"
             style="width:100%;max-width:560px;background:${CARD};border:1px solid ${BORDER};border-radius:10px;
                    font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${TEXT};">
        ${head}${body}${rejects}${foot}
      </table>
    </td></tr>
  </table>
</body></html>`;
}
