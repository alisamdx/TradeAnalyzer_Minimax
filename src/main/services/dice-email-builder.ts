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

import type { DicePick, DiceResult } from './roll-the-dice.js';
import { ownAtStrikeNote } from './own-at-strike.js';
import { etradeQuoteUrl, etradeOptionsUrl } from './etrade-links.js';

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

/**
 * The own-at-strike sentence.
 *
 * Conviction membership stopped gating the pick in v1.1.168, so this is the only place that
 * question now gets asked — and it has to ask it out loud rather than imply it by silence. The
 * four states are genuinely different and only one of them is an all-clear; in particular "not on
 * the list" is not a warning about the trade, it is a statement that nothing was pre-committed
 * and the judgement is live.
 */
function convictionNote(p: DicePick): string {
  const c = p.fit.conviction;
  // The band is nearly always satisfied by construction (0 breaches in 39 eligible picks), so a
  // bare "inside your never-above line" would read as an all-clear it did not earn. When it does
  // pass, say so briefly and let `ownAtStrikeNote` carry the actual judgement.
  if (c === null) {
    return `Not on your conviction list — you have not pre-committed to owning ${p.ticker} at any `
         + `price, so "would I be happy owning it at $${p.strike}?" is a live question here.`;
  }
  if (c.priceHigh == null || c.strikeWithinBand == null) {
    return `On your conviction list, but no "never above" band is set for ${p.ticker} — nothing to check the $${p.strike} strike against.`;
  }
  if (c.strikeWithinBand) {
    return `On your conviction list, and the $${p.strike} strike is inside your $${c.priceHigh} never-above line.`;
  }
  return `⚠ On your conviction list, but the $${p.strike} strike is ABOVE your $${c.priceHigh} `
       + `never-above line — on assignment you would be buying at a price you already ruled out.`;
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

/**
 * The two E*Trade pages this trade is placed from.
 *
 * The email states an order; these are where it gets checked and entered. Both are given because
 * they answer different questions — the quote page is "what is it doing right now", the chain is
 * "what is this strike actually bid". Rendered as text links rather than buttons: a bare <a> is
 * the one thing every mail client renders the same way, and this is read on a phone.
 */
function etradeLinks(ticker: string, size: 'lg' | 'sm' = 'lg'): string {
  const fs = size === 'lg' ? 13 : 11;
  const link = (href: string, label: string): string =>
    `<a href="${esc(href)}" target="_blank" style="color:${ACCENT};text-decoration:underline;">${esc(label)}</a>`;
  return `
      <div style="font-size:${fs}px;color:${MUTED};line-height:1.6;">
        E*Trade: ${link(etradeQuoteUrl(ticker), 'quote')} &middot; ${link(etradeOptionsUrl(ticker), 'option chain')}
      </div>`;
}

export function buildDiceEmailHtml(r: DiceResult, dateStr: string): string {
  // A pick above the operator's normal size is NOT an exception being granted — capital stopped
  // being a gate in v1.1.168 — so this states the number and hands the decision over rather than
  // justifying itself. It still leads, because it is the fact most likely to change the answer.
  const overBudget = r.pick && !r.pick.fit.withinCapital
    ? `<tr><td style="padding:14px 18px 0;">
         <div style="border:1px solid ${WARN};background:#fff8e6;border-radius:8px;padding:10px 12px;">
           <div style="font-size:13px;font-weight:700;color:${WARN};">TIES UP ${money(r.pick.capitalRequired)} — ABOVE YOUR USUAL ${money(r.pick.fit.maxCapital)}</div>
           <div style="font-size:12px;color:${TEXT};line-height:1.6;margin-top:4px;">
             Not a rejection — this is simply the best setup today, and whether you fund it is your
             call.${r.withinBudget ? ' The best one that fits your usual size is at the bottom.' : ''}
           </div>
         </div></td></tr>`
    : '';

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
          This is a normal outcome. Every remaining gate is a hard filter on the trade itself, so
          "nothing today" means nothing cleared — not that the system failed. Your position size
          and conviction list no longer remove anything, so a blank day is never about those.
        </div>
      </td></tr>`;
  } else {
    const p = r.pick;
    // Capital and conviction are absent from this list ON PURPOSE — they are reported elsewhere
    // as fit, and listing them here would restate them as bars the trade had to clear.
    const gates = [
      'critic passed (and actually ran)',
      `liquidity ${p.liquidityScore.toFixed(0)}/15`,
      'no earnings before expiry',
      'real net credit',
    ].join(' · ');

    body = `
      <tr><td style="padding:4px 18px 0;">
        <div style="font-size:12px;color:${MUTED};text-transform:uppercase;letter-spacing:.4px;">The order</div>
        <div style="font-size:22px;font-weight:700;color:${TEXT};line-height:1.3;margin:4px 0 2px;">
          Sell 1 <a href="${esc(etradeQuoteUrl(p.ticker))}" target="_blank" style="color:${TEXT};text-decoration:underline;">${esc(p.ticker)}</a> $${p.strike} put
        </div>
        <div style="font-size:14px;color:${MUTED};margin-bottom:6px;">
          expires ${esc(prettyDate(p.expiration))} · ${p.dte} days · ${esc(p.ticker)} at ${money2(p.price)}
        </div>
        ${etradeLinks(p.ticker)}
        <div style="height:14px;line-height:14px;">&nbsp;</div>
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

      <tr><td style="padding:12px 18px 0;">
        <div style="font-size:12px;color:${TEXT};line-height:1.6;font-weight:600;">
          ${esc(ownAtStrikeNote(p.ticker, p.fit.ownership))}
        </div>
        <div style="font-size:11px;color:${MUTED};line-height:1.6;margin-top:4px;">${esc(convictionNote(p))}</div>
      </td></tr>

      <tr><td style="padding:14px 18px 0;font-size:11px;color:${MUTED};line-height:1.6;">
        <b>Passed every gate:</b> ${esc(gates)}.
        ${r.runnerUp ? `Runner-up was ${esc(r.runnerUp.ticker)} (${r.runnerUp.compositeScore.toFixed(1)}).` : ''}
      </td></tr>`;
  }

  // The best candidate that FITS, shown only when the merit pick does not. This is the other
  // half of demoting the capital gate: the operator always leaves with something they can fund.
  const alt = r.withinBudget
    ? `<tr><td style="padding:16px 18px 0;">
         <div style="border:1px solid ${BORDER};border-radius:8px;padding:10px 12px;background:${BG};">
           <div style="font-size:11px;color:${MUTED};text-transform:uppercase;letter-spacing:.4px;">Within your usual size</div>
           <div style="font-size:15px;font-weight:700;color:${TEXT};margin:4px 0 2px;">
             Sell 1 ${esc(r.withinBudget.ticker)} $${r.withinBudget.strike} put, ${esc(prettyDate(r.withinBudget.expiration))}
           </div>
           <div style="font-size:12px;color:${MUTED};line-height:1.6;">
             ${money(r.withinBudget.capitalRequired)} cash · ${money(r.withinBudget.creditTotal)} credit ·
             own it at ${money2(r.withinBudget.effectiveCostBasis)} · score ${r.withinBudget.compositeScore.toFixed(1)} ·
             grade ${esc(r.withinBudget.grade)}
           </div>
           <div style="font-size:11px;color:${MUTED};line-height:1.6;margin-top:5px;">
             ${esc(ownAtStrikeNote(r.withinBudget.ticker, r.withinBudget.fit.ownership))}
           </div>
           <div style="margin-top:5px;">${etradeLinks(r.withinBudget.ticker, 'sm')}</div>
         </div></td></tr>`
    : '';

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
        These gates remove <i>checkable</i> problems with the <i>trade</i> — a flagged setup, an
        earnings print, a thin chain, a broken credit. Size and conviction are reported, not
        filtered: those are your calls. Nothing here can make a short put safe — you can be
        assigned, and the stock can fall well below your cost basis. Not investment advice.
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
        ${head}${stale}${overBudget}${body}${alt}${rejects}${foot}
      </table>
    </td></tr>
  </table>
</body></html>`;
}
