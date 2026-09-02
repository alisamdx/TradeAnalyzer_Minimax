// Roll the Dice email — ONE opportunity, so it is built as a card, not a report.
//
// The brief's email is a grid because it carries ~25 picks across 5 strategies. This carries one
// trade, and a grid would be the wrong shape: there is nothing to compare it against. So the
// layout leads with the ORDER TO PLACE, then the three numbers that decide it, then the one
// question a wheel entry actually turns on — "am I happy owning this at that price?"
//
// EMAIL HTML CONSTRAINTS (why this looks dated):
//  - table-based layout, because Outlook's Word rendering engine ignores flex/grid
//  - every style inline, because Gmail strips <style> blocks
//  - explicit light background and text colours on every cell: email dark-mode is applied
//    inconsistently per client, and a transparent background inherits whatever the client
//    paints, which is how "invisible text in dark mode" happens
//  - max-width 560px with width:100% so it reads on a phone, which is where it will be read
//
// No PDF attachment: one trade does not need one.

import type { DiceResult } from './roll-the-dice.js';

const BG = '#f6f8fa';
const CARD = '#ffffff';
const BORDER = '#d0d7de';
const TEXT = '#24292f';
const MUTED = '#57606a';
const ACCENT = '#0969da';
const WARN = '#9a6700';

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

/** "Fri Sep 25" — short, unambiguous, no year noise for a near-dated expiry. */
function prettyDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  // No comma: this is embedded mid-sentence in the subject line ("sell the $205 put, Fri Sep 25"),
  // and toLocaleDateString's default "Fri, Sep 25" would double it up.
  const wd = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  const md = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return wd + ' ' + md;
}

const money = (n: number): string => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const money2 = (n: number): string => `$${n.toFixed(2)}`;

/**
 * Subject line carries the entire trade.
 *
 * This is the part most likely to be read — on a phone lock screen, without opening anything.
 * It has to be actionable on its own, so the ticker, the strike, the expiry and the credit all
 * go in it rather than a generic "your daily pick is ready".
 */
export function diceEmailSubject(r: DiceResult): string {
  if (!r.pick) {
    return `\u{1F3B2} No dice today — nothing cleared (${r.considered} considered)`;
  }
  const p = r.pick;
  return `\u{1F3B2} ${p.ticker} — sell the $${p.strike} put, ${prettyDate(p.expiration)} · ${money(p.creditTotal)} credit`;
}

function statRow(label: string, value: string, note?: string): string {
  return `
    <tr>
      <td style="padding:9px 14px;border-bottom:1px solid ${BORDER};color:${MUTED};font-size:13px;">${esc(label)}</td>
      <td style="padding:9px 14px;border-bottom:1px solid ${BORDER};color:${TEXT};font-size:17px;font-weight:700;text-align:right;white-space:nowrap;">
        ${esc(value)}${note ? `<div style="font-size:11px;font-weight:400;color:${MUTED};margin-top:2px;">${esc(note)}</div>` : ''}
      </td>
    </tr>`;
}

export function buildDiceEmailHtml(r: DiceResult, dateStr: string): string {
  const head = `
    <tr><td style="padding:16px 18px 4px;">
      <div style="font-size:18px;font-weight:700;color:${TEXT};">\u{1F3B2} Roll the Dice</div>
      <div style="font-size:12px;color:${MUTED};margin-top:3px;">
        ${esc(dateStr)} · one wheel entry · ${r.considered} pick${r.considered === 1 ? '' : 's'} considered
      </div>
    </td></tr>`;

  const stale = r.staleWarning
    ? `<tr><td style="padding:0 18px 10px;">
         <div style="border:1px solid ${WARN};background:#fff8e6;color:${WARN};border-radius:6px;padding:8px 10px;font-size:12px;">
           ⚠ ${esc(r.staleWarning)}
         </div></td></tr>`
    : '';

  let body: string;

  if (!r.pick) {
    // A no-pick day still sends. Silence is ambiguous — it can't be told apart from a failed
    // job or a broken SMTP config, and the whole point is that the operator can stop checking.
    body = `
      <tr><td style="padding:4px 18px 18px;">
        <div style="font-size:15px;color:${TEXT};line-height:1.55;">${esc(r.noPickReason ?? 'Nothing qualified today.')}</div>
        <div style="font-size:12px;color:${MUTED};line-height:1.6;margin-top:12px;">
          This is a normal outcome — roughly two days in three. Every gate is a hard filter, so
          "nothing today" means nothing cleared, not that the system failed.
        </div>
      </td></tr>`;
  } else {
    const p = r.pick;
    const gates = [
      'critic passed (and actually ran)',
      `price ${money2(p.price)} within limit`,
      `liquidity ${p.liquidityScore.toFixed(0)}/15`,
      'no earnings before expiry',
    ].join(' · ');

    body = `
      <tr><td style="padding:4px 18px 0;">
        <div style="font-size:12px;color:${MUTED};text-transform:uppercase;letter-spacing:.4px;">The order</div>
        <div style="font-size:22px;font-weight:700;color:${TEXT};line-height:1.3;margin:4px 0 2px;">
          Sell 1 ${esc(p.ticker)} $${p.strike} put
        </div>
        <div style="font-size:14px;color:${MUTED};margin-bottom:14px;">
          expires ${esc(prettyDate(p.expiration))} · ${p.dte} days · ${esc(p.ticker)} at ${money2(p.price)}
        </div>
      </td></tr>

      <tr><td style="padding:0 18px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
               style="border:1px solid ${BORDER};border-radius:8px;background:${CARD};border-collapse:separate;">
          ${statRow('You collect', money(p.creditTotal), `${money2(p.premiumPerShare)} per share`)}
          ${statRow('Cash required', money(p.capitalRequired), 'cash-secured')}
          ${statRow('If assigned, you own it at', money2(p.effectiveCostBasis),
                    `${p.discountToSpotPct.toFixed(1)}% below today's ${money2(p.price)}`)}
        </table>
      </td></tr>

      <tr><td style="padding:12px 18px 0;font-size:12px;color:${MUTED};line-height:1.6;">
        Annualized <b style="color:${TEXT};">${p.annualizedReturn?.toFixed(0) ?? '—'}%</b> ·
        Probability of profit <b style="color:${TEXT};">${p.popEstimate?.toFixed(0) ?? '—'}%</b> ·
        Grade <b style="color:${TEXT};">${esc(p.grade)}</b> ·
        Brief score <b style="color:${TEXT};">${p.compositeScore.toFixed(1)}</b>
      </td></tr>

      ${p.criticRationale ? `
      <tr><td style="padding:14px 18px 0;">
        <div style="font-size:12px;color:${MUTED};text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;">Why this one</div>
        <div style="font-size:13px;color:${TEXT};line-height:1.6;">${esc(p.criticRationale)}</div>
      </td></tr>` : ''}

      <tr><td style="padding:14px 18px 0;">
        <div style="border-left:3px solid ${WARN};padding:2px 0 2px 10px;font-size:13px;color:${TEXT};line-height:1.6;">
          <b>The risk, plainly.</b> If ${esc(p.ticker)} is below $${p.strike} on
          ${esc(prettyDate(p.expiration))} you buy 100 shares at $${p.strike}, costing
          ${money(p.capitalRequired)}. Your break-even is ${money2(p.effectiveCostBasis)} —
          below that you are down roughly $100 for every dollar further it falls.
        </div>
      </td></tr>

      <tr><td style="padding:14px 18px 0;font-size:11px;color:${MUTED};line-height:1.6;">
        <b>Passed every gate:</b> ${esc(gates)}.
        ${r.runnerUp ? `Runner-up was ${esc(r.runnerUp.ticker)} (${r.runnerUp.compositeScore.toFixed(1)}).` : ''}
      </td></tr>`;
  }

  // The rejections make the bar visible rather than merely claimed — the same reasoning as the
  // in-app panel. Kept last and small: it is evidence, not the message.
  const rejects = r.rejections.length > 0
    ? `<tr><td style="padding:14px 18px 0;">
         <div style="font-size:11px;color:${MUTED};line-height:1.7;">
           <b>${r.rejections.length} rejected:</b>
           ${r.rejections.map(x => `${esc(x.ticker)} (${esc(x.reason)})`).join(' · ')}
         </div></td></tr>`
    : '';

  const foot = `
    <tr><td style="padding:16px 18px 18px;">
      <div style="border-top:1px solid ${BORDER};padding-top:12px;font-size:11px;color:${MUTED};line-height:1.6;">
        These gates remove <i>checkable</i> problems — a flagged setup, an earnings print, a thin
        chain, a position too large. They cannot make a short put safe: you can be assigned, and
        the stock can fall well below your cost basis. Not investment advice.
        <br><br>
        <span style="color:${ACCENT};">TradeAnalyzer</span> · generated from the
        ${r.briefDate ? esc(r.briefDate) : 'latest'} brief.
      </div>
    </td></tr>`;

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:${BG};">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${BG};">
    <tr><td align="center" style="padding:18px 10px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560"
             style="width:100%;max-width:560px;background:${CARD};border:1px solid ${BORDER};border-radius:10px;
                    font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${TEXT};">
        ${head}${stale}${body}${rejects}${foot}
      </table>
    </td></tr>
  </table>
</body></html>`;
}
