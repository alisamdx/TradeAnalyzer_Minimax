// Premium vs cost basis per stock holding — Bec's "risk line" (v1.1.359). Reporting only.
// One row per holding: what the shares cost, how much premium has been kept against them, the net
// basis that leaves, and whether the line has only ever fallen (her test of a holding worth keeping).
// see docs/formulas.md#premium-basis

import { Fragment, useEffect, useState } from 'react';
import type { PremiumBasisHolding } from '@shared/premium-basis.js';

const usd = (n: number, dp = 2): string =>
  `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

export function PremiumBasisPanel({ reloadKey }: { reloadKey: unknown }) {
  const [rows, setRows] = useState<PremiumBasisHolding[] | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    window.api.portfolio.premiumBasis()
      .then(r => { if (!cancelled) setRows(r); })
      .catch(() => { if (!cancelled) setRows(null); });
    return () => { cancelled = true; };
  }, [reloadKey]);

  if (!rows || rows.length === 0) return null;

  const toggle = (t: string) => setOpen(prev => {
    const next = new Set(prev);
    if (next.has(t)) next.delete(t); else next.add(t);
    return next;
  });

  return (
    <div className="capital-strip premium-basis">
      <div className="premium-basis-head">
        <span className="capital-k">Premium vs cost basis</span>
        <span className="capital-n">
          Premium kept on each holding, netted off what the shares cost. Bec keeps a holding whose line
          only ever falls. Reporting only.
        </span>
      </div>
      <table className="premium-basis-table">
        <thead>
          <tr>
            <th />
            <th>Ticker</th>
            <th className="num">Shares</th>
            <th className="num">Cost / sh</th>
            <th className="num">Kept / sh</th>
            <th className="num">Net basis</th>
            <th className="num">Reduced</th>
            <th>Line</th>
            <th className="num" title="Credit on short options still open: not kept until they expire or are closed">Open credit</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(h => {
            const expanded = open.has(h.ticker);
            return (
              <Fragment key={h.ticker}>
                <tr className="premium-basis-row" onClick={() => toggle(h.ticker)}>
                  <td className="premium-basis-caret">{h.steps.length + h.unresolved.length > 0 ? (expanded ? '▾' : '▸') : ''}</td>
                  <td><strong>{h.ticker}</strong></td>
                  <td className="num">{h.shares.toLocaleString('en-US')}</td>
                  <td className="num">{usd(h.costPerShare)}</td>
                  <td className="num">{usd(h.premiumKeptPerShare)}</td>
                  <td className="num"><strong>{usd(h.netBasis)}</strong></td>
                  <td className="num">{h.reductionPct.toFixed(1)}%</td>
                  <td>
                    {h.steps.length === 0
                      ? <span className="capital-n">no closed options yet</span>
                      : h.onlyFallen
                        ? <span className="premium-basis-good" title="No closed option has raised the basis">✓ only fallen</span>
                        : <span className="premium-basis-bad" title="A closed option lost money, so the basis went up">↑ rose {h.rises}×</span>}
                  </td>
                  <td className="num">
                    {h.openCredit > 0 ? usd(h.openCredit, 0) : '—'}
                    {h.openShortCalls > 0 && <span className="capital-n"> · {h.openShortCalls} call{h.openShortCalls === 1 ? '' : 's'}</span>}
                  </td>
                </tr>
                {expanded && (
                  <tr className="premium-basis-detail">
                    <td />
                    <td colSpan={8}>
                      <div className="capital-n">
                        Since {h.acquired} · {h.steps.length} closed option{h.steps.length === 1 ? '' : 's'} · {usd(h.premiumKept)} kept
                        {h.premiumInBrokerBasis > 0 && ` · ${usd(h.premiumInBrokerBasis)} from the assigning put is already in E*Trade's cost and is not subtracted again`}
                      </div>
                      <table className="premium-basis-steps">
                        <tbody>
                          {h.steps.map(s => (
                            <tr key={s.positionId}>
                              <td>{s.date}</td>
                              <td>{s.type} {s.strike ?? '—'} · exp {s.expiration ?? '—'}{s.contracts > 1 ? ` · ${s.contracts}×` : ''}</td>
                              <td className={`num ${s.rose ? 'premium-basis-bad' : ''}`}>{usd(s.kept)}</td>
                              <td className="num">→ {usd(s.basisAfter)}</td>
                              <td className="capital-n">
                                {s.inBrokerBasis ? 'already in broker cost' : s.estimated ? 'no closing fill: expired or assigned, full credit' : ''}
                              </td>
                            </tr>
                          ))}
                          {h.unresolved.map(u => (
                            <tr key={`u${u.positionId}`}>
                              <td>{u.exitDate}</td>
                              <td>{u.type} {u.strike ?? '—'} · exp {u.expiration ?? '—'}</td>
                              <td colSpan={3} className="capital-stale">
                                not counted: closed before expiry with no fill on record. Run Sync Closed Positions.
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
