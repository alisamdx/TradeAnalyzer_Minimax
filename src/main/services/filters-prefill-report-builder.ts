// FiltersPrefillReportBuilder — builds the email body for the Filters Prefill batch job.
// Two curated lists: the top 10 IV High (Vetted) candidates (of potentially dozens of gate
// survivors — ranked, not the full list) and every Wheel (Vetted) match (already a small,
// gated funnel). Both sources have already passed Wheel (Vetted)'s downtrend / earnings /
// liquidity / IV-ceiling safety gates (see filter-templates-service.ts IV_HIGH_VETTED_DEFAULTS)
// — this email is not sourced from the loose, ungated `iv_rank_high` template.
// Style mirrors brief-report-builder.ts's email so the two look like one family of report.

import type { FilterTemplateResult } from '@shared/types.js';

function fmtPrice(n: number | null | undefined): string {
  return n == null ? '—' : `$${n.toFixed(2)}`;
}

function num(v: number | string | null | undefined): number | null {
  return typeof v === 'number' ? v : null;
}

function str(v: number | string | null | undefined): string | null {
  return typeof v === 'string' ? v : null;
}

/** ETF vs stock — the filter service tags a universe='all' scan's rows with 'ETF' or 'All'. */
function typeOf(r: FilterTemplateResult): string {
  return r.watchlists.includes('ETF') ? 'ETF' : 'Stock';
}

/** Highest-IV-first: IV Rank (0–100, cross-name comparable) is the primary sort — it measures
 *  where IV sits in the ticker's OWN 1-year range, which is what "elevated for selling premium"
 *  actually means, unlike raw IV % which conflates inherently-high-vol names with ones merely
 *  elevated for themselves. Falls back to raw IV % for rows missing IV Rank. */
export function topIvHigh(results: FilterTemplateResult[], limit = 10): FilterTemplateResult[] {
  return [...results]
    .sort((a, b) => {
      const aRank = num(a.metrics['ivRank']), bRank = num(b.metrics['ivRank']);
      if (aRank !== null && bRank !== null) return bRank - aRank;
      if (aRank !== null) return -1;
      if (bRank !== null) return 1;
      const aIv = num(a.metrics['currentIv']) ?? -Infinity;
      const bIv = num(b.metrics['currentIv']) ?? -Infinity;
      return bIv - aIv;
    })
    .slice(0, limit);
}

/** Wheel (Vetted)'s own default sort (matches FiltersView.tsx TEMPLATE_DEFAULT_SORT). */
export function sortWheelVetted(results: FilterTemplateResult[]): FilterTemplateResult[] {
  return [...results].sort((a, b) => (num(b.metrics['riskAdjustedReturn']) ?? -Infinity) - (num(a.metrics['riskAdjustedReturn']) ?? -Infinity));
}

function ivHighRows(results: FilterTemplateResult[]): string {
  return results.map(r => `
    <tr style="border-bottom:1px solid #e8e8e8">
      <td style="padding:7px 8px;font-weight:700;font-size:14px"><a href="https://us.etrade.com/e/t/invest/quotesandresearch?content=3&amp;sym=${r.ticker.toLowerCase()}" style="color:#1a1a1a;text-decoration:underline" target="_blank">${r.ticker}</a></td>
      <td style="padding:7px 8px;color:#888;font-size:12px">${typeOf(r)}</td>
      <td style="padding:7px 8px;color:#555">${fmtPrice(r.lastPrice)}</td>
      <td style="padding:7px 8px;font-weight:700;color:#c0392b">${num(r.metrics['ivRank']) != null ? num(r.metrics['ivRank'])!.toFixed(0) : '—'}</td>
      <td style="padding:7px 8px;color:#555">${num(r.metrics['currentIv']) != null ? `${num(r.metrics['currentIv'])!.toFixed(1)}%` : '—'}</td>
      <td style="padding:7px 8px;color:#888;font-size:12px">${num(r.metrics['openInterest']) != null ? num(r.metrics['openInterest'])!.toLocaleString() : '—'}</td>
      <td style="padding:7px 8px;color:#888;font-size:12px">${num(r.metrics['spread']) != null ? `${num(r.metrics['spread'])}%` : '—'}</td>
      <td style="padding:7px 8px;color:#777;font-size:11px">${r.matchReason}</td>
    </tr>`).join('');
}

function wheelVettedRows(results: FilterTemplateResult[]): string {
  return results.map(r => `
    <tr style="border-bottom:1px solid #e8e8e8">
      <td style="padding:7px 8px;font-weight:700;font-size:14px"><a href="https://us.etrade.com/e/t/invest/quotesandresearch?content=3&amp;sym=${r.ticker.toLowerCase()}" style="color:#1a1a1a;text-decoration:underline" target="_blank">${r.ticker}</a></td>
      <td style="padding:7px 8px;color:#888;font-size:12px">${typeOf(r)}</td>
      <td style="padding:7px 8px;color:#555">${fmtPrice(r.lastPrice)}</td>
      <td style="padding:7px 8px;color:#555;font-size:12px">${num(r.metrics['suitabilityScore']) != null ? `${num(r.metrics['suitabilityScore'])}/100` : '—'}</td>
      <td style="padding:7px 8px">${str(r.metrics['expiry']) ?? '—'}</td>
      <td style="padding:7px 8px;font-weight:600">${num(r.metrics['putStrike']) != null ? fmtPrice(num(r.metrics['putStrike'])) : '—'}</td>
      <td style="padding:7px 8px;color:#27ae60">${num(r.metrics['credit']) != null ? fmtPrice(num(r.metrics['credit'])) : '—'}</td>
      <td style="padding:7px 8px;color:#2980b9">${num(r.metrics['annualizedReturn']) != null ? `${num(r.metrics['annualizedReturn'])}%` : '—'}</td>
      <td style="padding:7px 8px;color:#8e44ad;font-weight:700">${num(r.metrics['riskAdjustedReturn']) != null ? `${num(r.metrics['riskAdjustedReturn'])}%` : '—'}</td>
      <td style="padding:7px 8px;color:#888;font-size:12px">${num(r.metrics['openInterest']) != null ? num(r.metrics['openInterest'])!.toLocaleString() : '—'}</td>
      <td style="padding:7px 8px;color:#888;font-size:12px">${num(r.metrics['spread']) != null ? `${num(r.metrics['spread'])}%` : '—'}</td>
    </tr>`).join('');
}

function section(title: string, subtitle: string, headerCells: string[], rowsHtml: string, emptyMessage: string): string {
  const body = rowsHtml.length > 0
    ? `<div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid #ddd;border-top:none">
          <thead>
            <tr style="background:#f5f6fa;color:#666;font-size:11px;text-transform:uppercase">
              ${headerCells.map(h => `<th style="padding:6px 8px;text-align:left">${h}</th>`).join('')}
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>`
    : `<div style="padding:16px;border:1px solid #ddd;border-top:none;color:#888;font-size:13px;text-align:center">${emptyMessage}</div>`;

  return `
    <div style="margin-bottom:28px">
      <div style="background:#2c3e50;color:#fff;padding:10px 14px;border-radius:6px 6px 0 0;font-size:13px;font-weight:700;letter-spacing:0.5px">
        ${title.toUpperCase()} &nbsp;·&nbsp; ${subtitle}
      </div>
      ${body}
    </div>`;
}

export function buildFiltersPrefillEmailHtml(
  dateIso: string,
  ivHigh: { top: FilterTemplateResult[]; totalScanned: number },
  wheelVetted: FilterTemplateResult[],
): string {
  const dateStr = new Date(dateIso + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const ivHighSection = section(
    '🛡️ IV High (Vetted)',
    `top ${ivHigh.top.length} of ${ivHigh.totalScanned} gate survivors`,
    ['Ticker', 'Type', 'Last', 'IV Rank', 'IV %', 'OI', 'Spread', 'Reason'],
    ivHighRows(ivHigh.top),
    'No tickers cleared the IV High (Vetted) gates today.',
  );

  const wheelSection = section(
    '✅ Wheel (Vetted)',
    `${wheelVetted.length} pick${wheelVetted.length !== 1 ? 's' : ''}`,
    ['Ticker', 'Type', 'Last', 'Score', 'Expiry', 'Put Strike', 'Credit', 'Ann %', 'Risk-Adj %', 'OI', 'Spread'],
    wheelVettedRows(wheelVetted),
    'No tickers passed the Wheel (Vetted) funnel today.',
  );

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:-apple-system,Arial,sans-serif;background:#f0f2f5">
<div style="max-width:860px;margin:0 auto;padding:24px">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#1a252f,#2c3e50);color:#fff;padding:24px 28px;border-radius:8px;margin-bottom:24px">
    <div style="font-size:22px;font-weight:700;margin-bottom:4px">🎛️ Filters Prefill</div>
    <div style="color:#bdc3c7;font-size:14px">${dateStr}</div>
    <div style="margin-top:12px;display:flex;gap:24px;font-size:13px">
      <span><strong style="color:#f39c12">${ivHigh.top.length}</strong> IV High (Vetted, top-ranked)</span>
      <span><strong style="color:#f39c12">${wheelVetted.length}</strong> Wheel (Vetted)</span>
    </div>
  </div>

  ${ivHighSection}
  ${wheelSection}

  <!-- Footer -->
  <div style="margin-top:16px;font-size:11px;color:#aaa;text-align:center;border-top:1px solid #ddd;padding-top:12px">
    Full results for every filter template are in the app's 🎛️ Filters view.<br>
    Generated by TradeAnalyzer · ${new Date().toISOString()}
  </div>
</div>
</body>
</html>`;
}
