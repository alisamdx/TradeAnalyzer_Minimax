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
};

const STRATEGY_TO_SLUGS: Record<ScoringStrategy, string[]> = {
  wheel:   ['short-naked-put', 'covered-call'],
  bullish: ['long-call-vertical', 'big-lizard', 'call-zebra', 'call-butterfly', 'poor-mans-covered-call'],
  bearish: ['long-put-vertical', 'reverse-big-lizard', 'put-zebra', 'put-butterfly', 'poor-mans-covered-put'],
  income:  ['short-strangle', 'iron-condor', 'short-straddle', 'dynamic-width-iron-condor', 'iron-fly'],
  buy:     ['long-call-vertical', 'call-zebra', 'poor-mans-covered-call', 'call-calendar'],
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
          <td style="padding:7px 8px;font-weight:700;font-size:14px">${pick.ticker}</td>
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

// ─── PDF ──────────────────────────────────────────────────────────────────────

export async function buildPdf(
  date: string,
  briefsByStrategy: Map<ScoringStrategy, BriefPick[]>,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'LETTER', bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const dateStr = new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    const W = doc.page.width - 100; // usable width
    const DARK  = '#1a252f';
    const BLUE  = '#2980b9';
    const GRAY  = '#555555';
    const LGRAY = '#888888';
    const totalPicks = STRATEGY_ORDER.reduce((n, s) => n + (briefsByStrategy.get(s)?.length ?? 0), 0);

    // ── Cover page ──────────────────────────────────────────────────────────
    doc.rect(50, 50, W, 120).fill('#2c3e50');
    doc.fillColor('#ffffff').fontSize(24).font('Helvetica-Bold')
      .text('Daily Intelligence Brief', 70, 75);
    doc.fontSize(13).font('Helvetica').fillColor('#bdc3c7')
      .text(dateStr, 70, 108);
    doc.fontSize(12).fillColor('#ecf0f1')
      .text(`${totalPicks} picks across 5 strategies`, 70, 130);

    doc.moveDown(8);

    // Summary table of contents
    doc.fillColor(DARK).fontSize(11).font('Helvetica-Bold').text('Contents', 50, doc.y);
    doc.moveDown(0.4);
    STRATEGY_ORDER.forEach(strategy => {
      const picks = briefsByStrategy.get(strategy);
      if (!picks?.length) return;
      doc.fontSize(10).font('Helvetica').fillColor(GRAY)
        .text(`  ${STRATEGY_LABELS[strategy]}`, 50, doc.y, { continued: true })
        .fillColor(LGRAY).text(`  ·  ${picks.length} picks`);
      doc.moveDown(0.3);
    });

    doc.moveDown(1);
    doc.fontSize(9).fillColor(LGRAY)
      .text('Grades and setups are generated by the Strategy Lab validation engine. AI rationale is indicative, not financial advice.', 50, doc.y, { width: W });

    // ── Strategy sections ──────────────────────────────────────────────────
    for (const strategy of STRATEGY_ORDER) {
      const picks = briefsByStrategy.get(strategy);
      if (!picks?.length) continue;

      doc.addPage();

      // Strategy header bar
      doc.rect(50, 50, W, 28).fill('#2c3e50');
      doc.fillColor('#ffffff').fontSize(13).font('Helvetica-Bold')
        .text(`${STRATEGY_LABELS[strategy].toUpperCase()}  ·  ${picks.length} PICKS`, 60, 59);

      let y = 90;

      for (const pick of picks) {
        // Check if we need a new page (each pick card is ~200-240px tall)
        if (y > doc.page.height - 260) {
          doc.addPage();
          y = 50;
        }

        const setup = getRelevantSetup(pick, strategy);
        const grade = setup?.grade ?? '?';
        const gradeColor = GRADE_COLOR_HEX[grade] ?? '#666666';
        const score = setup?.labScore != null ? Math.round(setup.labScore) : null;

        // Pick card background
        const cardH = estimateCardHeight(pick);
        doc.rect(50, y, W, cardH).fillAndStroke('#f8f9fa', '#e0e0e0');

        // Rank badge
        doc.circle(68, y + 14, 10).fill(DARK);
        doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold')
          .text(`#${pick.rank}`, 62, y + 9, { width: 12, align: 'center' });

        // Ticker + price
        doc.fillColor(DARK).fontSize(16).font('Helvetica-Bold')
          .text(pick.ticker, 85, y + 6);
        doc.fillColor(GRAY).fontSize(10).font('Helvetica')
          .text(fmtPrice(pick.price), 85, y + 26);

        // Grade badge
        doc.rect(W - 50, y + 6, 40, 22).fill(gradeColor);
        doc.fillColor('#ffffff').fontSize(13).font('Helvetica-Bold')
          .text(grade, W - 45, y + 11, { width: 30, align: 'center' });

        // Lab score
        doc.fillColor(LGRAY).fontSize(9).font('Helvetica')
          .text(score != null ? `${score}/100` : '', W - 55, y + 32, { width: 50, align: 'center' });

        // Setup row
        if (setup) {
          let setupLine = setup.structureName;
          if (setup.strike != null) setupLine += `  ·  Strike ${fmtPrice(setup.strike)}`;
          if (setup.expiration) setupLine += `  ·  ${fmtExpShort(setup.expiration)}`;
          if (setup.dte != null) setupLine += `  ·  ${setup.dte}d`;
          if (setup.credit != null) setupLine += `  ·  cr ${fmtPrice(setup.credit)}`;
          else if (setup.debit != null) setupLine += `  ·  dr ${fmtPrice(setup.debit)}`;
          if (setup.annReturn != null) setupLine += `  ·  Ann ${fmtPct(setup.annReturn)}`;
          if (setup.pop != null) setupLine += `  ·  POP ${fmtPct(setup.pop)}`;
          if (setup.maxLoss != null) setupLine += `  ·  Max Loss ${fmtPrice(setup.maxLoss)}`;

          doc.fillColor(BLUE).fontSize(9).font('Helvetica-Bold')
            .text(setupLine, 85, y + 42, { width: W - 110 });
        }

        // Top signals
        // Signal contribution = normalized (0–1) × weight
        const topSignals = Object.entries(pick.signals)
          .filter(([, s]) => !s.missing && s.normalized > 0)
          .sort(([, a], [, b]) => (b.normalized * b.weight) - (a.normalized * a.weight))
          .slice(0, 5);

        if (topSignals.length > 0) {
          const sigY = y + 57;
          doc.fillColor(LGRAY).fontSize(8).font('Helvetica')
            .text('Signals: ', 85, sigY, { continued: true });
          topSignals.forEach(([name, sig], i) => {
            const label = name.replace(/([A-Z])/g, ' $1').trim();
            const contrib = (sig.normalized * sig.weight).toFixed(0);
            doc.fillColor('#444').text(`${label} (${contrib})${i < topSignals.length - 1 ? '  ' : ''}`, { continued: i < topSignals.length - 1 });
          });
        }

        // AI Rationale
        if (pick.aiRationale) {
          const rationaleY = y + 72;
          doc.rect(85, rationaleY, W - 90, 1).fill('#e0e0e0');
          doc.fillColor(LGRAY).fontSize(8).font('Helvetica-Bold')
            .text('AI RATIONALE', 85, rationaleY + 5);
          doc.fillColor('#333333').fontSize(9).font('Helvetica')
            .text(pick.aiRationale, 85, rationaleY + 17, { width: W - 90, lineGap: 2 });
        }

        y += cardH + 10;
      }
    }

    // Page numbers
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(pages.start + i);
      doc.fillColor(LGRAY).fontSize(8).font('Helvetica')
        .text(`TradeAnalyzer Daily Brief  ·  ${dateStr}  ·  Page ${i + 1} of ${pages.count}`,
          50, doc.page.height - 30, { width: W, align: 'center' });
    }

    doc.end();
  });
}

function estimateCardHeight(pick: BriefPick): number {
  const baseH = 90;
  if (!pick.aiRationale) return baseH;
  // Rough estimate: ~80 chars per line at 9pt, ~13px per line
  const chars = pick.aiRationale.length;
  const lines = Math.ceil(chars / 90);
  return baseH + 22 + lines * 13;
}
