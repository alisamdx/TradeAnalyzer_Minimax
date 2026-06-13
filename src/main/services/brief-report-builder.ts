// BriefReportBuilder — builds the Daily Intelligence Brief email body and PDF.
// Email: trade-ready tables (enough to place a trade from your phone).
// PDF: full detail — all 25 picks, signal breakdown, complete AI rationale.

import PDFDocument from 'pdfkit';
import type { BriefPick, ScoringStrategy, StrategyLabValidateResult, StrategySetup } from '@shared/types.js';

// ─── Strategy metadata ────────────────────────────────────────────────────────

const STRATEGY_LABELS: Record<ScoringStrategy, string> = {
  wheel:   'Wheel (CSP / CC)',
  bullish: 'Bullish',
  bearish: 'Bearish',
  income:  'Options Income',
  buy:     'Buy Zone',
  inflection: 'Inflection (Breakout)',
};

const STRATEGY_TO_SLUGS: Record<ScoringStrategy, string[]> = {
  wheel:   ['short-naked-put', 'covered-call'],
  bullish: ['long-call-vertical', 'big-lizard', 'call-zebra', 'call-butterfly', 'poor-mans-covered-call'],
  bearish: ['long-put-vertical', 'reverse-big-lizard', 'put-zebra', 'put-butterfly', 'poor-mans-covered-put'],
  income:  ['short-strangle', 'iron-condor', 'short-straddle', 'dynamic-width-iron-condor', 'iron-fly'],
  buy:     ['long-call-vertical', 'call-zebra', 'poor-mans-covered-call', 'call-calendar'],
  inflection: ['bull-put-spread', 'bear-call-spread'],
};

const SLUG_SHORT: Record<string, string> = {
  'short-naked-put':           'CSP',
  'covered-call':              'Covered Call',
  'long-call-vertical':        'Call Spread',
  'big-lizard':                'Big Lizard',
  'call-zebra':                'Call Zebra',
  'call-butterfly':            'Call Butterfly',
  'poor-mans-covered-call':    'PMCC',
  'long-put-vertical':         'Put Spread',
  'reverse-big-lizard':        'Rev. Big Lizard',
  'put-zebra':                 'Put Zebra',
  'put-butterfly':             'Put Butterfly',
  'poor-mans-covered-put':     'PMCP',
  'short-strangle':            'Strangle',
  'iron-condor':               'Iron Condor',
  'short-straddle':            'Straddle',
  'dynamic-width-iron-condor': 'Dyn. IC',
  'iron-fly':                  'Iron Fly',
  'call-calendar':             'Call Calendar',
};

const GRADE_COLOR_HEX: Record<string, string> = {
  'A+': '#2ea043', 'A': '#3fb950', 'B': '#d29922', 'C': '#e07d3a', 'F': '#f85149',
};

// Must match the screen order in DailyBriefView.tsx STRATEGY_ORDER
const STRATEGY_ORDER: ScoringStrategy[] = ['wheel', 'bullish', 'bearish', 'income', 'buy'];

// ─── Shared helpers ───────────────────────────────────────────────────────────

function fmtExpShort(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtPrice(n: number | null | undefined): string {
  return n == null ? '—' : `$${n.toFixed(2)}`;
}

function fmtPct(n: number | null | undefined): string {
  return n == null ? '—' : `${Math.round(n)}%`;
}

function primaryStrike(setup: StrategySetup): number | null {
  const shortLeg = setup.legs.find(l => l.action === 'sell');
  return (shortLeg ?? setup.legs[0])?.strike ?? null;
}

function getRelevantSetup(pick: BriefPick, strategy: ScoringStrategy): {
  structureName: string;
  labScore: number | null;  // Strategy Lab totalScore (0-100) — same scale as grade
  strike: number | null;
  expiration: string | null;
  dte: number | null;
  credit: number | null;
  debit: number | null;
  maxLoss: number | null;
  annReturn: number | null;
  pop: number | null;
  grade: string | null;
} | null {
  if (!pick.strategyLabResult) return null;
  const result = pick.strategyLabResult as StrategyLabValidateResult;
  if (!result.scores?.length) return null;

  const slugs = STRATEGY_TO_SLUGS[strategy];
  let best = result.scores.find(s => slugs.includes(s.slug));
  if (!best) best = result.scores[0];
  if (!best) return null;

  const setup = best.setup;
  if (!setup || setup.unavailableReason) {
    return {
      structureName: SLUG_SHORT[best.slug] ?? best.name,
      labScore: best.totalScore,
      strike: null, expiration: null, dte: null,
      credit: null, debit: null, maxLoss: null, annReturn: null, pop: null,
      grade: best.grade,
    };
  }

  return {
    structureName: SLUG_SHORT[best.slug] ?? best.name,
    labScore: best.totalScore,
    strike: primaryStrike(setup),
    expiration: setup.expiration,
    dte: setup.dte,
    credit: setup.netCredit && setup.netCredit > 0 ? setup.netCredit : null,
    debit: setup.netDebit && setup.netDebit > 0 ? setup.netDebit : null,
    maxLoss: setup.maxLoss,
    annReturn: setup.annualizedReturn,
    pop: setup.popEstimate,
    grade: best.grade,
  };
}

// ─── Email HTML ───────────────────────────────────────────────────────────────

export function buildEmailHtml(
  date: string,
  briefsByStrategy: Map<ScoringStrategy, BriefPick[]>,
): string {
  const dateStr = new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const totalPicks = STRATEGY_ORDER.reduce((n, s) => n + (briefsByStrategy.get(s)?.length ?? 0), 0);

  const strategyBlocks = STRATEGY_ORDER.map(strategy => {
    const picks = briefsByStrategy.get(strategy);
    if (!picks?.length) return '';

    const rows = picks.map(pick => {
      const setup = getRelevantSetup(pick, strategy);
      const grade = setup?.grade ?? '—';
      const gradeColor = GRADE_COLOR_HEX[grade] ?? '#666';
      // labScore is the Strategy Lab totalScore (0-100) — same system as the grade.
      // compositeScore is the scoring engine rank used to SELECT the pick (different scale).
      const score = setup?.labScore != null ? Math.round(setup.labScore) : null;

      const structure = setup?.structureName ?? '—';
      const strike    = setup?.strike != null ? fmtPrice(setup.strike) : '—';
      const expiry    = setup?.expiration ? fmtExpShort(setup.expiration) : '—';
      const dte       = setup?.dte != null ? `${setup.dte}d` : '—';
      const premium   = setup?.credit != null
        ? `<span style="color:#27ae60">cr ${fmtPrice(setup.credit)}</span>`
        : setup?.debit != null
          ? `<span style="color:#e74c3c">dr ${fmtPrice(setup.debit)}</span>`
          : '—';
      const annRet  = setup?.annReturn != null ? fmtPct(setup.annReturn) : '—';
      const pop     = setup?.pop != null ? fmtPct(setup.pop) : '—';
      const maxLoss = setup?.maxLoss != null ? fmtPrice(setup.maxLoss) : '—';

      const cv = pick.criticVerdict;
      const criticLabel = cv ? { pass: '✓ Pass', caution: '⚠ Caution', flag: '⚑ Flag' }[cv.verdict] : '—';
      const criticColor = cv ? { pass: '#27ae60', caution: '#e67e22', flag: '#c0392b' }[cv.verdict] : '#aaa';

      return `
        <tr style="border-bottom:1px solid #e8e8e8">
          <td style="padding:7px 8px;font-weight:700;color:#1a1a1a">#${pick.rank}</td>
          <td style="padding:7px 8px;font-weight:700;font-size:14px"><a href="https://us.etrade.com/e/t/invest/quotesandresearch?content=3&amp;sym=${pick.ticker.toLowerCase()}" style="color:#1a1a1a;text-decoration:underline" target="_blank">${pick.ticker}</a></td>
          <td style="padding:7px 8px;color:#555">${fmtPrice(pick.price)}</td>
          <td style="padding:7px 8px;font-weight:700;color:${gradeColor}">${grade}</td>
          <td style="padding:7px 8px;color:#555;font-size:12px">${score != null ? `${score}/100` : '—'}</td>
          <td style="padding:7px 8px;color:#333">${structure}</td>
          <td style="padding:7px 8px;font-weight:600">${strike}</td>
          <td style="padding:7px 8px">${expiry}</td>
          <td style="padding:7px 8px;color:#888">${dte}</td>
          <td style="padding:7px 8px">${premium}</td>
          <td style="padding:7px 8px;color:#2980b9">${annRet}</td>
          <td style="padding:7px 8px;color:#8e44ad">${pop}</td>
          <td style="padding:7px 8px;color:#c0392b;font-size:12px">${maxLoss}</td>
          <td style="padding:7px 8px;font-weight:600;color:${criticColor};font-size:12px">${criticLabel}</td>
        </tr>
        ${cv?.rationale ? `<tr style="background:#fafafa"><td></td><td colspan="13" style="padding:4px 8px 6px;font-size:11px;color:#555;font-style:italic"><strong>⚠ Second opinion:</strong> ${cv.rationale}</td></tr>` : ''}`;
    }).join('');

    return `
      <div style="margin-bottom:28px">
        <div style="background:#2c3e50;color:#fff;padding:10px 14px;border-radius:6px 6px 0 0;font-size:13px;font-weight:700;letter-spacing:0.5px">
          ${STRATEGY_LABELS[strategy].toUpperCase()} &nbsp;·&nbsp; ${picks.length} picks
        </div>
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid #ddd;border-top:none">
            <thead>
              <tr style="background:#f5f6fa;color:#666;font-size:11px;text-transform:uppercase">
                <th style="padding:6px 8px;text-align:left">#</th>
                <th style="padding:6px 8px;text-align:left">Ticker</th>
                <th style="padding:6px 8px;text-align:left">Price</th>
                <th style="padding:6px 8px;text-align:left">Grade</th>
                <th style="padding:6px 8px;text-align:left">Lab Score</th>
                <th style="padding:6px 8px;text-align:left">Structure</th>
                <th style="padding:6px 8px;text-align:left">Strike</th>
                <th style="padding:6px 8px;text-align:left">Expiry</th>
                <th style="padding:6px 8px;text-align:left">DTE</th>
                <th style="padding:6px 8px;text-align:left">Premium</th>
                <th style="padding:6px 8px;text-align:left">Ann.Ret</th>
                <th style="padding:6px 8px;text-align:left">POP</th>
                <th style="padding:6px 8px;text-align:left">Max Loss</th>
                <th style="padding:6px 8px;text-align:left">Critic</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:-apple-system,Arial,sans-serif;background:#f0f2f5">
<div style="max-width:860px;margin:0 auto;padding:24px">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#1a252f,#2c3e50);color:#fff;padding:24px 28px;border-radius:8px;margin-bottom:24px">
    <div style="font-size:22px;font-weight:700;margin-bottom:4px">📊 Daily Intelligence Brief</div>
    <div style="color:#bdc3c7;font-size:14px">${dateStr}</div>
    <div style="margin-top:12px;display:flex;gap:24px;font-size:13px">
      <span><strong style="color:#f39c12">${totalPicks}</strong> picks across 5 strategies</span>
    </div>
  </div>

  <!-- Strategy sections -->
  ${strategyBlocks}

  <!-- Footer -->
  <div style="margin-top:16px;font-size:11px;color:#aaa;text-align:center;border-top:1px solid #ddd;padding-top:12px">
    See attached PDF for full signal breakdown and AI rationale for all 25 picks.<br>
    Generated by TradeAnalyzer · ${new Date().toISOString()}
  </div>
</div>
</body>
</html>`;
}

// ─── PDF helpers ─────────────────────────────────────────────────────────────

const SIGNAL_LABEL_MAP: Record<string, string> = {
  ivRank: 'IV Rank', premiumYield: 'Prem Yield', premiumRiskRatio: 'Prem/Risk',
  fundamentalScore: 'Fundamentals', fundamentalWeakness: 'Fund Weakness',
  technicalNeutral: 'RSI Neutral', rsiMomentum: 'RSI', rsiOverbought: 'RSI OB',
  optionLiquidity: 'Liquidity', recentVolatility: 'Recent Vol',
  trendStrength: 'Trend', downtrendScore: 'Downtrend', trendNeutral: 'Trend Neutral',
  earningsGrowth: 'Earnings', priceMomentumPct: '52w Mom', priceDecayPct: '52w Decay',
  breakoutScore: 'Breakout', buySignalScore: 'Buy Signal',
  relativeStrength: 'Rel Strength', relativeWeakness: 'Rel Weakness',
  sectorMomentum: 'Sector Mom', sectorWeakness: 'Sector Weak',
  leverageQuality: 'Leverage', leverageRisk: 'Lev Risk',
  revenueGrowth5Y: 'Rev Growth 5Y', epsGrowth5Y: 'EPS Growth 5Y',
};

function fmtSignalVal(raw: number | null, key: string): string {
  if (raw == null) return '—';
  if (['ivRank','fundamentalScore','fundamentalWeakness','trendStrength','downtrendScore',
       'earningsGrowth','breakoutScore','buySignalScore','rsiMomentum','rsiOverbought',
       'technicalNeutral','relativeStrength','relativeWeakness','sectorMomentum',
       'sectorWeakness','leverageQuality','leverageRisk'].includes(key)) return raw.toFixed(0);
  if (key === 'recentVolatility') return `${raw.toFixed(1)}%`;
  if (key === 'priceMomentumPct' || key === 'priceDecayPct') return `${raw >= 0 ? '+' : ''}${raw.toFixed(1)}%`;
  if (key === 'optionLiquidity') return `${raw.toFixed(1)}/10`;
  if (key === 'premiumYield' || key === 'premiumRiskRatio') return `${raw.toFixed(1)}%`;
  return raw.toFixed(1);
}

/** Estimate total pixel height for a pick card including all sections. */
function estimateCardHeight(pick: BriefPick, strategy: ScoringStrategy): number {
  const result = pick.strategyLabResult as StrategyLabValidateResult | null;
  const slugs  = STRATEGY_TO_SLUGS[strategy];
  const bestScore = result?.scores?.find(s => slugs.includes(s.slug)) ?? result?.scores?.[0];
  const setup  = bestScore?.setup && !bestScore.setup.unavailableReason ? bestScore.setup : null;
  const numLegs = setup?.legs?.length ?? 0;
  const bucketScores = result?.scores?.filter(s => slugs.includes(s.slug)) ?? [];
  const allSignalEntries  = Object.entries(pick.signals);
  const activeSignals     = allSignalEntries.filter(([, s]) => !s.missing && s.normalized > 0);
  const inactiveSignals   = allSignalEntries.filter(([, s]) => s.missing || s.normalized === 0);

  let h = 52;  // header (rank, ticker, price, grade)

  // Context block (ATM IV, IV Rank, bias, MA20/MA50, momentum)
  if (result?.context) {
    h += 6 + 4 + 10 + 12 + 13; // divider + gap + label + 2 lines
  }

  h += 14;     // setup line 1: structure · expiry · credit
  h += 14;     // setup line 2: max profit · max loss · breakeven · POP

  // Exit plan
  h += 6 + 4 + 10 + 24; // divider + gap + label + 1 line (take profit · stop · DTE)

  if (numLegs > 0) {
    h += 18;           // legs section header bar
    h += numLegs * 15; // leg rows
    h += 4;
  }

  // Score breakdown + flags
  if (bestScore) {
    h += 6 + 4 + 10 + 12; // divider + gap + label + scores line
    if (bestScore.flags.length > 0) h += 12;
  }

  // All structures in bucket
  if (bucketScores.length > 1) {
    h += 6 + 4 + 10 + 13;         // divider + gap + label + table header
    h += bucketScores.length * 13 + 4;
  }

  // All signals (active + inactive)
  if (allSignalEntries.length > 0) {
    h += 6 + 4 + 10; // divider + gap + label
    if (activeSignals.length > 0) {
      const sigStr = activeSignals.map(([k, s]) => `${k}: ${s.raw} (${s.weight}%)`).join('  ·  ');
      h += Math.ceil(sigStr.length / 80) * 12 + 4;
    }
    if (inactiveSignals.length > 0) {
      const misStr = inactiveSignals.map(([k]) => k).join('  ·  ');
      h += Math.ceil(('Missing/inactive: ' + misStr).length / 90) * 10 + 2;
    }
  }

  // Strategy Lab AI rationale (from bestScore)
  if (bestScore?.aiRationale) {
    h += 6 + 4 + 10;
    h += Math.ceil(bestScore.aiRationale.length / 88) * 12 + 4;
  }

  // Pick-level AI rationale
  if (pick.aiRationale) {
    h += 6 + 4 + 10;
    h += Math.ceil(pick.aiRationale.length / 88) * 12 + 4;
  }

  // Critic verdict
  if (pick.criticVerdict) {
    h += 6 + 4 + 10; // divider + gap + label
    if (pick.criticVerdict.rationale) {
      h += Math.ceil(pick.criticVerdict.rationale.length / 88) * 12 + 4;
    } else {
      h += 13;
    }
    if (pick.criticVerdict.flags.length > 0) {
      h += pick.criticVerdict.flags.length * 11 + 2;
    }
  }

  h += 10; // bottom padding
  return Math.max(h, 100);
}

// ─── PDF ──────────────────────────────────────────────────────────────────────

export async function buildPdf(
  date: string,
  briefsByStrategy: Map<ScoringStrategy, BriefPick[]>,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'LETTER', bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const dateStr = new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    const W     = doc.page.width - 100; // usable width (512 on LETTER)
    const LX    = 50;                    // left margin
    const CX    = 82;                    // content indent inside card
    const CW    = W - 36;               // content width inside card
    const DARK  = '#1a252f';
    const BLUE  = '#2980b9';
    const GREEN = '#27ae60';
    const RED   = '#c0392b';
    const GRAY  = '#555555';
    const LGRAY = '#888888';

    const totalPicks = STRATEGY_ORDER.reduce((n, s) => n + (briefsByStrategy.get(s)?.length ?? 0), 0);

    // ── Cover page ────────────────────────────────────────────────────────────
    doc.rect(LX, 50, W, 120).fill('#2c3e50');
    doc.fillColor('#ffffff').fontSize(24).font('Helvetica-Bold')
      .text('Daily Intelligence Brief', LX + 20, 75);
    doc.fontSize(13).font('Helvetica').fillColor('#bdc3c7')
      .text(dateStr, LX + 20, 108);
    doc.fontSize(12).fillColor('#ecf0f1')
      .text(`${totalPicks} picks across 5 strategies`, LX + 20, 130);

    doc.moveDown(8);
    doc.fillColor(DARK).fontSize(11).font('Helvetica-Bold').text('Contents', LX, doc.y);
    doc.moveDown(0.4);
    STRATEGY_ORDER.forEach(s => {
      const picks = briefsByStrategy.get(s);
      if (!picks?.length) return;
      doc.fontSize(10).font('Helvetica').fillColor(GRAY)
        .text(`  ${STRATEGY_LABELS[s]}`, LX, doc.y, { continued: true })
        .fillColor(LGRAY).text(`  ·  ${picks.length} picks`);
      doc.moveDown(0.3);
    });
    doc.moveDown(1);
    doc.fontSize(9).fillColor(LGRAY)
      .text('Grades and setups are generated by the Strategy Lab validation engine. ' +
            'AI rationale is indicative, not financial advice.', LX, doc.y, { width: W });

    // ── Per-strategy sections ─────────────────────────────────────────────────
    for (const strategy of STRATEGY_ORDER) {
      const picks = briefsByStrategy.get(strategy);
      if (!picks?.length) continue;

      doc.addPage();
      doc.rect(LX, 50, W, 28).fill('#2c3e50');
      doc.fillColor('#ffffff').fontSize(13).font('Helvetica-Bold')
        .text(`${STRATEGY_LABELS[strategy].toUpperCase()}  ·  ${picks.length} PICKS`, LX + 10, 59);

      let y = 90;

      for (const pick of picks) {
        const cardH = estimateCardHeight(pick, strategy);
        if (y + cardH > doc.page.height - 50) { doc.addPage(); y = 50; }

        // Resolve Strategy Lab result for this strategy
        const labResult  = pick.strategyLabResult as StrategyLabValidateResult | null;
        const slugs      = STRATEGY_TO_SLUGS[strategy];
        const bestScore  = labResult?.scores?.find(s => slugs.includes(s.slug)) ?? labResult?.scores?.[0];
        const grade      = bestScore?.grade ?? '?';
        const gradeColor = GRADE_COLOR_HEX[grade] ?? '#666666';
        const labScore   = bestScore?.totalScore != null ? Math.round(bestScore.totalScore) : null;
        const setup      = bestScore?.setup && !bestScore.setup.unavailableReason ? bestScore.setup : null;

        // ── Card background ──────────────────────────────────────────────────
        doc.rect(LX, y, W, cardH).fillAndStroke('#f8f9fa', '#d0d0d0');

        // ── Header row ───────────────────────────────────────────────────────
        // Rank badge
        doc.circle(LX + 16, y + 14, 10).fill(DARK);
        doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold')
          .text(`#${pick.rank}`, LX + 10, y + 9, { width: 12, align: 'center' });

        // Ticker
        doc.fillColor(DARK).fontSize(16).font('Helvetica-Bold')
          .text(pick.ticker, CX, y + 5);

        // Price + validated badge
        let priceX = CX + 50;
        if (pick.price != null) {
          doc.fillColor(GRAY).fontSize(10).font('Helvetica')
            .text(fmtPrice(pick.price), priceX, y + 9);
          priceX += 48;
        }
        const validatedLabel = pick.validated ? '✓ Validated' : '⚠ Unvalidated';
        const validatedColor = pick.validated ? GREEN : '#e67e22';
        doc.fillColor(validatedColor).fontSize(8).font('Helvetica')
          .text(validatedLabel, priceX, y + 10);

        // Grade badge (top-right)
        doc.rect(LX + W - 52, y + 5, 42, 22).fill(gradeColor);
        doc.fillColor('#ffffff').fontSize(13).font('Helvetica-Bold')
          .text(grade, LX + W - 47, y + 10, { width: 32, align: 'center' });
        if (labScore != null) {
          doc.fillColor(LGRAY).fontSize(8).font('Helvetica')
            .text(`${labScore}/100`, LX + W - 52, y + 32, { width: 42, align: 'center' });
        }

        let cy = y + 42; // current y cursor inside card

        // ── Market context ───────────────────────────────────────────────────
        const ctx = labResult?.context;
        if (ctx) {
          cy += 2;
          doc.rect(CX, cy, CW, 1).fill('#d8d8d8');
          cy += 4;
          doc.fillColor(LGRAY).fontSize(7).font('Helvetica-Bold').text('MARKET CONTEXT', CX, cy);
          cy += 10;

          const ctxParts1: string[] = [
            `ATM IV: ${ctx.currentAtmIv.toFixed(0)}%`,
          ];
          if (ctx.ivRank != null)       ctxParts1.push(`IV Rank: ${ctx.ivRank.toFixed(0)}`);
          if (ctx.ivPercentile != null) ctxParts1.push(`IV Pct: ${ctx.ivPercentile.toFixed(0)}%`);
          ctxParts1.push(`Bias: ${ctx.directionBias.toUpperCase()}`);
          if (ctx.momentum5d != null)   ctxParts1.push(`5d Mom: ${ctx.momentum5d >= 0 ? '+' : ''}${ctx.momentum5d.toFixed(1)}%`);

          doc.fillColor('#333333').fontSize(8).font('Helvetica')
            .text(ctxParts1.join('  ·  '), CX, cy, { width: CW });
          cy += 12;

          const ctxParts2: string[] = [];
          if (ctx.ma20 != null)  ctxParts2.push(`MA20: ${fmtPrice(ctx.ma20)}`);
          if (ctx.ma50 != null)  ctxParts2.push(`MA50: ${fmtPrice(ctx.ma50)}`);
          ctxParts2.push(`IV data pts: ${ctx.ivDataPoints}`);
          doc.fillColor(GRAY).fontSize(8).font('Helvetica')
            .text(ctxParts2.join('  ·  '), CX, cy, { width: CW });
          cy += 13;
        }

        // ── Setup lines ──────────────────────────────────────────────────────
        if (setup || bestScore) {
          const sn = SLUG_SHORT[bestScore?.slug ?? ''] ?? bestScore?.name ?? '—';

          // Line 1: structure · expiry · DTE · credit/debit
          const line1Parts: string[] = [sn];
          if (setup?.expiration) line1Parts.push(fmtExpShort(setup.expiration));
          if (setup?.dte        != null) line1Parts.push(`${setup.dte}d`);
          if (setup?.netCredit  != null && setup.netCredit > 0) line1Parts.push(`Net Cr ${fmtPrice(setup.netCredit)}`);
          else if (setup?.netDebit != null && setup.netDebit > 0) line1Parts.push(`Net Dr ${fmtPrice(setup.netDebit)}`);
          if (setup?.annualizedReturn != null) line1Parts.push(`Ann ${fmtPct(setup.annualizedReturn)}`);
          if (setup?.popEstimate != null) line1Parts.push(`POP ${fmtPct(setup.popEstimate)}`);

          doc.fillColor(BLUE).fontSize(9).font('Helvetica-Bold')
            .text(line1Parts.join('  ·  '), CX, cy, { width: CW - 20 });
          cy += 13;

          // Line 2: max profit · max loss · breakevens
          const line2Parts: string[] = [];
          if (setup?.maxProfit != null) line2Parts.push(`Max Profit ${fmtPrice(setup.maxProfit)}`);
          if (setup?.maxLoss != null) line2Parts.push(`Max Loss ${fmtPrice(setup.maxLoss)}`);
          if (setup?.breakevens?.length) {
            line2Parts.push(`BE ${setup.breakevens.map(b => fmtPrice(b)).join(' / ')}`);
          }
          if (line2Parts.length > 0) {
            doc.fillColor(GRAY).fontSize(8).font('Helvetica')
              .text(line2Parts.join('  ·  '), CX, cy, { width: CW - 20 });
            cy += 13;
          }
        }

        // ── Legs table ───────────────────────────────────────────────────────
        if (setup?.legs?.length) {
          cy += 2;
          // Section header bar
          doc.rect(CX, cy, CW, 14).fill('#e8edf2');
          doc.fillColor('#2c3e50').fontSize(7).font('Helvetica-Bold')
            .text('LEG', CX + 2, cy + 4, { width: 28 });

          // Column x positions (relative to CX)
          // action(0) type(28) strike(56) mid(96) delta(132) gamma(162) theta(192) vega(222) iv(252) oi(278) bidask(322)
          const COL = { action: 0, type: 28, strike: 56, mid: 96, delta: 132, gamma: 162, theta: 192, vega: 222, iv: 252, oi: 278, bidask: 322 };

          doc.fillColor(LGRAY).fontSize(7).font('Helvetica')
            .text('TYPE',    CX + COL.type,   cy + 4, { width: 26 })
            .text('STRIKE',  CX + COL.strike,  cy + 4, { width: 36, align: 'right' })
            .text('MID',     CX + COL.mid,     cy + 4, { width: 28, align: 'right' })
            .text('DELTA',   CX + COL.delta,   cy + 4, { width: 28, align: 'right' })
            .text('GAMMA',   CX + COL.gamma,   cy + 4, { width: 28, align: 'right' })
            .text('THETA',   CX + COL.theta,   cy + 4, { width: 28, align: 'right' })
            .text('VEGA',    CX + COL.vega,    cy + 4, { width: 28, align: 'right' })
            .text('IV%',     CX + COL.iv,      cy + 4, { width: 22, align: 'right' })
            .text('OI',      CX + COL.oi,      cy + 4, { width: 40, align: 'right' })
            .text('BID×ASK', CX + COL.bidask,  cy + 4, { width: CW - COL.bidask });
          cy += 14;

          for (const leg of setup.legs) {
            const rowBg = leg.action === 'sell' ? '#fff8f0' : '#f0fff4';
            doc.rect(CX, cy, CW, 14).fill(rowBg);

            const actionColor = leg.action === 'sell' ? '#c0392b' : '#27ae60';
            const fmtGreek = (v: number | null, decimals = 3) =>
              v != null ? (v >= 0 ? '+' : '') + v.toFixed(decimals) : '—';
            const deltaStr = fmtGreek(leg.delta, 2);
            const gammaStr = fmtGreek(leg.gamma, 3);
            const thetaStr = leg.theta != null
              ? (leg.theta >= 0 ? '+' : '') + leg.theta.toFixed(2)
              : '—';
            const vegaStr  = leg.vega != null
              ? (leg.vega >= 0 ? '+' : '') + leg.vega.toFixed(2)
              : '—';
            const ivStr  = leg.iv > 0 ? `${leg.iv.toFixed(0)}%` : '—';
            const oiStr  = leg.openInterest != null && leg.openInterest > 0 ? leg.openInterest.toLocaleString() : '—';
            const bidAsk = `${fmtPrice(leg.bid)} × ${fmtPrice(leg.ask)}`;
            const qtyLabel = leg.qty > 1 ? `${leg.qty}×` : '';

            doc.fillColor(actionColor).fontSize(7.5).font('Helvetica-Bold')
              .text(qtyLabel + leg.action.toUpperCase(), CX + COL.action, cy + 3, { width: 26 });
            doc.fillColor(DARK).fontSize(7.5).font('Helvetica')
              .text(leg.side.toUpperCase(),  CX + COL.type,   cy + 3, { width: 26 })
              .text(fmtPrice(leg.strike),    CX + COL.strike,  cy + 3, { width: 36, align: 'right' })
              .text(fmtPrice(leg.mid),       CX + COL.mid,     cy + 3, { width: 28, align: 'right' });
            doc.fillColor(leg.delta != null && Math.abs(leg.delta) > 0.45 ? '#e07d3a' : DARK)
              .fontSize(7.5).font('Helvetica')
              .text(deltaStr, CX + COL.delta, cy + 3, { width: 28, align: 'right' });
            doc.fillColor(DARK).fontSize(7.5).font('Helvetica')
              .text(gammaStr, CX + COL.gamma, cy + 3, { width: 28, align: 'right' })
              .text(thetaStr, CX + COL.theta, cy + 3, { width: 28, align: 'right' })
              .text(vegaStr,  CX + COL.vega,  cy + 3, { width: 28, align: 'right' })
              .text(ivStr,    CX + COL.iv,    cy + 3, { width: 22, align: 'right' })
              .text(oiStr,    CX + COL.oi,    cy + 3, { width: 40, align: 'right' })
              .text(bidAsk,   CX + COL.bidask, cy + 3, { width: CW - COL.bidask });
            cy += 15;
          }
          cy += 4;
        }

        // ── Exit plan ────────────────────────────────────────────────────────
        if (setup) {
          cy += 2;
          doc.rect(CX, cy, CW, 1).fill('#d8d8d8');
          cy += 4;
          doc.fillColor(LGRAY).fontSize(7).font('Helvetica-Bold').text('EXIT PLAN', CX, cy);
          cy += 10;

          const exitParts: string[] = [];
          // Target: 50% of credit (or debit recovery target)
          if (setup.netCredit != null && setup.netCredit > 0) {
            exitParts.push(`Take profit: ${fmtPrice(setup.netCredit * 0.5)} (50% of ${fmtPrice(setup.netCredit)} credit)`);
            exitParts.push(`Hard stop: ${fmtPrice(setup.netCredit * 2)} loss (2× credit)`);
          } else if (setup.netDebit != null && setup.netDebit > 0) {
            exitParts.push(`Target: ${fmtPrice(setup.netDebit * 2)} (2× debit return)`);
            exitParts.push(`Stop: ${fmtPrice(setup.netDebit * 0.5)} loss (50% of debit)`);
          }
          // DTE target
          if (setup.dte != null) {
            const targetDte = Math.max(1, Math.round(setup.dte * 0.45)); // 21 DTE rule for ~45-day positions
            exitParts.push(`Close by: ${targetDte} DTE (before gamma risk accelerates)`);
          }
          if (exitParts.length > 0) {
            doc.fillColor('#333333').fontSize(8).font('Helvetica')
              .text(exitParts.join('  ·  '), CX, cy, { width: CW, lineGap: 1 });
            cy += Math.ceil(exitParts.join('  ·  ').length / 80) * 12 + 4;
          }
        }

        // ── Score breakdown ──────────────────────────────────────────────────
        if (bestScore) {
          cy += 2;
          doc.rect(CX, cy, CW, 1).fill('#d8d8d8');
          cy += 4;
          doc.fillColor(LGRAY).fontSize(7).font('Helvetica-Bold')
            .text('SCORE BREAKDOWN', CX, cy, { continued: true });
          doc.fillColor(DARK).fontSize(7).font('Helvetica')
            .text(`  Total: ${Math.round(bestScore.totalScore)}/100  ·  Complexity: ${bestScore.complexity}`);
          cy += 10;

          const subScoreLine = [
            `IV: ${bestScore.ivScore.toFixed(0)}/30`,
            `Direction: ${bestScore.directionScore.toFixed(0)}/30`,
            `Premium: ${bestScore.premiumScore.toFixed(0)}/25`,
            `Liquidity: ${bestScore.liquidityScore.toFixed(0)}/15`,
          ].join('  ·  ');
          doc.fillColor('#333333').fontSize(8).font('Helvetica')
            .text(subScoreLine, CX, cy, { width: CW });
          cy += 12;

          if (bestScore.flags.length > 0) {
            doc.fillColor(LGRAY).fontSize(7).font('Helvetica')
              .text('Flags: ', CX, cy, { continued: true });
            doc.fillColor('#555555').fontSize(7).font('Helvetica')
              .text(bestScore.flags.join('  ·  '), { width: CW - 30 });
            cy += 12;
          }
        }

        // ── All structures evaluated in this bucket ──────────────────────────
        const bucketScores = labResult?.scores?.filter(s => slugs.includes(s.slug)) ?? [];
        if (bucketScores.length > 1) {
          cy += 2;
          doc.rect(CX, cy, CW, 1).fill('#d8d8d8');
          cy += 4;
          doc.fillColor(LGRAY).fontSize(7).font('Helvetica-Bold')
            .text('ALL STRUCTURES EVALUATED', CX, cy);
          cy += 10;

          // Table header
          doc.rect(CX, cy, CW, 13).fill('#e8edf2');
          const SC = { name: 0, grade: 110, score: 135, iv: 165, dir: 193, prem: 221, liq: 249, setup: 273 };
          doc.fillColor('#2c3e50').fontSize(7).font('Helvetica-Bold')
            .text('STRUCTURE',  CX + SC.name,  cy + 3, { width: SC.grade - SC.name - 2 })
            .text('GR',         CX + SC.grade, cy + 3, { width: SC.score - SC.grade - 2 })
            .text('SCORE',      CX + SC.score, cy + 3, { width: SC.iv - SC.score - 2 })
            .text('IV',         CX + SC.iv,    cy + 3, { width: SC.dir - SC.iv - 2 })
            .text('DIR',        CX + SC.dir,   cy + 3, { width: SC.prem - SC.dir - 2 })
            .text('PR',         CX + SC.prem,  cy + 3, { width: SC.liq - SC.prem - 2 })
            .text('LQ',         CX + SC.liq,   cy + 3, { width: SC.setup - SC.liq - 2 })
            .text('SETUP',      CX + SC.setup, cy + 3, { width: CW - SC.setup });
          cy += 13;

          for (const sc of bucketScores) {
            const isBest = sc.slug === bestScore?.slug;
            doc.rect(CX, cy, CW, 13).fill(isBest ? '#fffbf0' : '#ffffff');
            const gc2 = GRADE_COLOR_HEX[sc.grade] ?? '#666666';

            let setupSummary = '—';
            if (sc.setup?.unavailableReason) {
              setupSummary = sc.setup.unavailableReason;
            } else if (sc.setup) {
              const sp = sc.setup;
              const parts: string[] = [];
              if (sp.expiration) parts.push(fmtExpShort(sp.expiration));
              const shortLeg = sp.legs.find(l => l.action === 'sell');
              if (shortLeg) parts.push(`${shortLeg.side.charAt(0).toUpperCase()} ${fmtPrice(shortLeg.strike)}`);
              if (sp.netCredit != null && sp.netCredit > 0) parts.push(`cr ${fmtPrice(sp.netCredit)}`);
              else if (sp.netDebit != null && sp.netDebit > 0) parts.push(`dr ${fmtPrice(sp.netDebit)}`);
              if (sp.popEstimate != null) parts.push(`POP ${fmtPct(sp.popEstimate)}`);
              if (sp.annualizedReturn != null) parts.push(`Ann ${fmtPct(sp.annualizedReturn)}`);
              setupSummary = parts.join(' · ');
            }

            doc.fillColor(DARK).fontSize(7.5).font(isBest ? 'Helvetica-Bold' : 'Helvetica')
              .text(SLUG_SHORT[sc.slug] ?? sc.name, CX + SC.name, cy + 3, { width: SC.grade - SC.name - 2 });
            doc.fillColor(gc2).fontSize(7.5).font('Helvetica-Bold')
              .text(sc.grade, CX + SC.grade, cy + 3, { width: SC.score - SC.grade - 2 });
            doc.fillColor(DARK).fontSize(7.5).font('Helvetica')
              .text(Math.round(sc.totalScore).toString(),    CX + SC.score, cy + 3, { width: SC.iv - SC.score - 2 })
              .text(sc.ivScore.toFixed(0),        CX + SC.iv,    cy + 3, { width: SC.dir - SC.iv - 2 })
              .text(sc.directionScore.toFixed(0), CX + SC.dir,   cy + 3, { width: SC.prem - SC.dir - 2 })
              .text(sc.premiumScore.toFixed(0),   CX + SC.prem,  cy + 3, { width: SC.liq - SC.prem - 2 })
              .text(sc.liquidityScore.toFixed(0), CX + SC.liq,   cy + 3, { width: SC.setup - SC.liq - 2 });
            doc.fillColor(LGRAY).fontSize(7).font('Helvetica')
              .text(setupSummary, CX + SC.setup, cy + 3, { width: CW - SC.setup - 4 });
            cy += 13;
          }
          cy += 4;
        }

        // ── All signals ──────────────────────────────────────────────────────
        const allSignalEntries = Object.entries(pick.signals)
          .sort(([, a], [, b]) => (b.normalized * b.weight) - (a.normalized * a.weight));
        const activeSignals   = allSignalEntries.filter(([, s]) => !s.missing && s.normalized > 0);
        const inactiveSignals = allSignalEntries.filter(([, s]) => s.missing || s.normalized === 0);

        if (activeSignals.length > 0 || inactiveSignals.length > 0) {
          cy += 2;
          doc.rect(CX, cy, CW, 1).fill('#d8d8d8');
          cy += 4;
          doc.fillColor(LGRAY).fontSize(7).font('Helvetica-Bold')
            .text('SCORING SIGNALS', CX, cy);
          cy += 10;

          if (activeSignals.length > 0) {
            const sigParts = activeSignals.map(([key, sig]) => {
              const label = SIGNAL_LABEL_MAP[key] ?? key.replace(/([A-Z])/g, ' $1').trim();
              return `${label}: ${fmtSignalVal(sig.raw, key)} (wt ${sig.weight}%)`;
            });
            const sigStr = sigParts.join('  ·  ');
            doc.fillColor('#333333').fontSize(8).font('Helvetica')
              .text(sigStr, CX, cy, { width: CW, lineGap: 1 });
            cy += Math.ceil(sigStr.length / 78) * 12 + 4;
          }

          if (inactiveSignals.length > 0) {
            const misParts = inactiveSignals.map(([key, sig]) => {
              const label = SIGNAL_LABEL_MAP[key] ?? key.replace(/([A-Z])/g, ' $1').trim();
              return `${label}${sig.missing ? ' (n/a)' : ': 0'}`;
            });
            const misStr = 'Inactive/missing: ' + misParts.join('  ·  ');
            doc.fillColor(LGRAY).fontSize(7).font('Helvetica')
              .text(misStr, CX, cy, { width: CW, lineGap: 1 });
            cy += Math.ceil(misStr.length / 90) * 10 + 2;
          }
        }

        // ── Strategy Lab AI rationale (per-structure fit explanation) ────────
        if (bestScore?.aiRationale) {
          cy += 2;
          doc.rect(CX, cy, CW, 1).fill('#d8d8d8');
          cy += 4;
          doc.fillColor(LGRAY).fontSize(7).font('Helvetica-Bold')
            .text('STRATEGY FIT', CX, cy);
          cy += 10;
          doc.fillColor('#333333').fontSize(9).font('Helvetica')
            .text(bestScore.aiRationale, CX, cy, { width: CW, lineGap: 1 });
          cy += Math.ceil(bestScore.aiRationale.length / 88) * 12 + 2;
        }

        // ── AI Rationale ─────────────────────────────────────────────────────
        if (pick.aiRationale) {
          cy += 2;
          doc.rect(CX, cy, CW, 1).fill('#d8d8d8');
          cy += 4;
          doc.fillColor(LGRAY).fontSize(7).font('Helvetica-Bold')
            .text('AI RATIONALE', CX, cy);
          cy += 10;
          doc.fillColor('#333333').fontSize(9).font('Helvetica')
            .text(pick.aiRationale, CX, cy, { width: CW, lineGap: 1 });
          cy += Math.ceil(pick.aiRationale.length / 88) * 12 + 2;
        }

        // ── Critic verdict ───────────────────────────────────────────────────
        const cv = pick.criticVerdict;
        if (cv) {
          cy += 2;
          doc.rect(CX, cy, CW, 1).fill('#d8d8d8');
          cy += 4;
          const cvLabelColor = cv.verdict === 'pass' ? GREEN : cv.verdict === 'flag' ? RED : '#e67e22';
          const cvLabel = { pass: '✓ PASS', caution: '⚠ CAUTION', flag: '⚑ FLAG' }[cv.verdict];
          doc.fillColor(LGRAY).fontSize(7).font('Helvetica-Bold')
            .text('SECOND OPINION  ', CX, cy, { continued: true });
          doc.fillColor(cvLabelColor).fontSize(7).font('Helvetica-Bold')
            .text(cvLabel);
          cy += 10;

          if (cv.rationale) {
            doc.fillColor('#444444').fontSize(8).font('Helvetica')
              .text(cv.rationale, CX, cy, { width: CW, lineGap: 1 });
            cy += Math.ceil(cv.rationale.length / 88) * 12 + 2;
          }

          if (cv.flags.length > 0) {
            for (const flag of cv.flags) {
              const flagColor = flag.severity === 'warning' ? '#c0392b' : LGRAY;
              const flagIcon  = flag.severity === 'warning' ? '⚠' : 'ℹ';
              doc.fillColor(flagColor).fontSize(7.5).font('Helvetica')
                .text(`${flagIcon} ${flag.description}`, CX + 4, cy, { width: CW - 4, lineGap: 1 });
              cy += 11;
            }
          }
        }

        y += cardH + 8;
      }
    }

    // ── Page numbers ──────────────────────────────────────────────────────────
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(pages.start + i);
      doc.fillColor(LGRAY).fontSize(8).font('Helvetica')
        .text(`TradeAnalyzer Daily Brief  ·  ${dateStr}  ·  Page ${i + 1} of ${pages.count}`,
          LX, doc.page.height - 30, { width: W, align: 'center' });
    }

    doc.end();
  });
}
