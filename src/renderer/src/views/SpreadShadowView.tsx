// SpreadShadowView — the bull put spread mode's shadow picks, settled forward, and the 08 §4 enable gate.
// v1.1.295. Read-only: the same report scripts/spread-shadow-report.mjs prints
// (window.api.spreadMode.shadowReport → services/spread-mode-settle.ts).
//
// Shadow picks are never emailed, shown elsewhere or traded. Open positions show a MARK — the spread's
// mid debit against its credit — which is a paper value, not a settlement and not a stop signal.

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { ShadowPickRow, SpreadShadowReport, SpreadSettlement, BookSummary } from '@shared/spread-mode.js';

type StatusFilter = 'all' | 'open' | 'settled' | 'unsettleable';

const pct = (x: number | null | undefined, digits = 1): string => (x == null ? '—' : `${(x * 100).toFixed(digits)}%`);
const money = (x: number): string => x.toFixed(2);
const tone = (x: number | null | undefined): string =>
  x == null ? 'var(--text-muted)' : x > 0 ? 'var(--success)' : x < 0 ? 'var(--danger)' : 'var(--text)';

const card: CSSProperties = { background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, padding: 16, marginBottom: 16 };
const th: CSSProperties = { textAlign: 'left', padding: '6px 8px', borderBottom: '2px solid var(--border)', position: 'sticky', top: 0, background: 'var(--bg-elev)', whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 };
const td: CSSProperties = { padding: '5px 8px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
const num: CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
const h3: CSSProperties = { margin: '0 0 12px', fontSize: 14 };
const muted: CSSProperties = { color: 'var(--text-muted)', fontSize: 12 };

/** A paper return for an open position: what closing at the last mid would realise, on max loss. */
function markReturn(p: ShadowPickRow): number | null {
  const s = p.settlement;
  return s.status === 'open' && s.lastMidDebit != null ? (p.netCredit - s.lastMidDebit) / p.maxLoss : null;
}

function settledReturn(s: SpreadSettlement): number | null {
  return s.status === 'target' || s.status === 'expired' ? s.returnOnMaxLoss : null;
}

const STATUS_STYLE: Record<SpreadSettlement['status'], { label: string; color: string }> = {
  open: { label: 'open', color: 'var(--accent)' },
  target: { label: '50% target', color: 'var(--success)' },
  expired: { label: 'expired', color: 'var(--text)' },
  unsettleable: { label: 'unsettleable', color: 'var(--warning)' },
};

function Pill({ color, children, title }: { color: string; children: ReactNode; title?: string }) {
  return (
    <span title={title} style={{ fontSize: 11, padding: '1px 7px', borderRadius: 10, border: `1px solid ${color}`, color, whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}

function GateTile({ label, value, sub, met, progress }: { label: string; value: string; sub: string; met: boolean | null; progress?: number }) {
  const color = met == null ? 'var(--text-muted)' : met ? 'var(--success)' : 'var(--warning)';
  return (
    <div style={{ flex: '1 1 200px', border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
      <div style={muted}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color, margin: '4px 0' }}>{value}</div>
      {progress != null && (
        <div style={{ height: 6, background: 'var(--bg)', borderRadius: 3, overflow: 'hidden', margin: '6px 0' }}>
          <div style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%`, height: '100%', background: color }} />
        </div>
      )}
      <div style={muted}>{sub}</div>
    </div>
  );
}

function BookRow({ name, b, note }: { name: string; b: BookSummary; note?: string }) {
  return (
    <tr>
      <td style={td}>{name}{note && <span style={{ ...muted, marginLeft: 8 }}>{note}</span>}</td>
      <td style={num}>{b.positions}</td>
      <td style={num}>{b.settled}</td>
      <td style={{ ...num, color: tone(b.meanReturnOnMaxLoss) }}>{pct(b.meanReturnOnMaxLoss)}</td>
      <td style={num}>{pct(b.winRate, 0)}</td>
    </tr>
  );
}

export function SpreadShadowView() {
  const [report, setReport] = useState<SpreadShadowReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<StatusFilter>('all');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await window.api.spreadMode.shadowReport());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => {
    const all = [...(report?.positions ?? [])].reverse(); // newest first
    if (filter === 'all') return all;
    if (filter === 'settled') return all.filter(p => p.settlement.status === 'target' || p.settlement.status === 'expired');
    return all.filter(p => p.settlement.status === filter);
  }, [report, filter]);

  const g = report?.gate;
  const sc = report?.sectorCap;

  return (
    // `view-scroll` makes the page scroll: `.main` is a flex column with overflow:hidden, so a view
    // that does not scroll itself is clipped at the window edge (v1.1.298).
    <div className="view-scroll" style={{ maxWidth: 1240 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>🪜 Bull Put Spread — Shadow</h2>
        <Pill color="var(--warning)" title="Picks are stored after every brief but never emailed, shown elsewhere or traded, until the enable gate passes">
          shadow · not traded
        </Pill>
        <span style={{ flex: 1 }} />
        {report && <span style={muted}>as of {report.asOf}</span>}
        <button className="btn-ghost" onClick={() => void load()} disabled={loading}>{loading ? 'Loading…' : '↻ Refresh'}</button>
      </div>
      <p style={{ color: 'var(--text-muted)', marginTop: 6 }}>
        Every shadow pick, settled on its own captured quotes: the 50% profit target (decided on mid, filled with
        slippage), or intrinsic value at the expiry close. Picks of one ticker within 14 days count as one position.
      </p>

      {error && <div style={{ ...card, borderColor: 'var(--danger)', color: 'var(--danger)' }}>Could not load the report: {error}</div>}
      {!report && !error && <div style={card}>{loading ? 'Loading…' : 'No report.'}</div>}

      {report && g && sc && (
        <>
          {/* ── Enable gate ── */}
          <div style={card}>
            <h3 style={h3}>Enable gate <span style={muted}>(spec 08 §4 — all three must pass before the mode can be switched on)</span></h3>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <GateTile
                label="Intraday capture days" met={g.captureDaysMet}
                value={`${g.intradayCaptureDays} / ${g.intradayCaptureDaysNeeded}`}
                progress={g.intradayCaptureDays / g.intradayCaptureDaysNeeded}
                sub="then re-run the study on real quoted costs"
              />
              <GateTile
                label="Settled positions" met={g.settledMet}
                value={`${g.settledPositions} / ${g.settledPositionsNeeded}`}
                progress={g.settledPositions / g.settledPositionsNeeded}
                sub={`${report.counts.open} open · ${report.counts.target} at target · ${report.counts.expired} expired`}
              />
              <GateTile
                label="Mean return on max loss" met={g.meanPositive}
                value={pct(g.meanReturnOnMaxLoss)}
                sub={`must be > 0 · win rate ${pct(report.winRate, 0)} · median hold ${report.medianDaysHeld ?? '—'} d`}
              />
            </div>
            {report.settings && (
              <div style={{ ...muted, marginTop: 10 }}>
                Settings → Strategies: mode <b>{report.settings.mode}</b> · max loss/position{' '}
                <b>${report.settings.maxLossPerPosition.toLocaleString('en-US')}</b> · max open{' '}
                <b>{report.settings.maxOpenPositions}</b> · max open/sector <b>{report.settings.maxOpenPerSector}</b>
                {' — fully deployed that is '}
                <b>${(report.settings.maxLossPerPosition * report.settings.maxOpenPositions).toLocaleString('en-US')}</b> at risk
              </div>
            )}
          </div>

          {/* ── Capture quality ── */}
          <div style={card}>
            <h3 style={h3}>
              Capture quality{' '}
              <span style={muted}>(the quotes every settlement rests on — TradeAnalyzer 2&apos;s gate does not check this table)</span>
            </h3>
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'baseline' }}>
              <span>{report.captureQuality.captureDays} capture days</span>
              <span style={muted}>last {report.captureQuality.lastCaptureDate ?? '—'}</span>
              <span style={muted}>marks {report.captureQuality.marks}</span>
              <span style={muted}>missing a leg {report.captureQuality.gaps} ({pct(report.captureQuality.gapRate)})</span>
              <span style={muted}>not re-quoted {report.captureQuality.missingMarks} of {report.captureQuality.expectedMarks}</span>
            </div>
            {report.captureQuality.findings.length === 0 ? (
              <div style={{ marginTop: 10, color: 'var(--success)' }}>✓ nothing to look at</div>
            ) : (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {report.captureQuality.findings.map(f => (
                  <div key={f.code + f.detail} style={{ borderLeft: '3px solid var(--warning)', paddingLeft: 10 }}>
                    <div><Pill color="var(--warning)">{f.code}</Pill> <span style={{ marginLeft: 6 }}>{f.detail}</span></div>
                    {f.subjects.length > 0 && <div style={{ ...muted, marginTop: 3 }}>{f.subjects.join(' · ')}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Sector cap + concentration ── */}
          <div style={card}>
            <h3 style={h3}>Sector cap <span style={muted}>({sc.cap} open per sector — simulated; shadow picks are not capped)</span></h3>
            <table style={{ borderCollapse: 'collapse', width: '100%', maxWidth: 720 }}>
              <thead>
                <tr>
                  <th style={th}>Book</th><th style={{ ...th, textAlign: 'right' }}>Positions</th>
                  <th style={{ ...th, textAlign: 'right' }}>Settled</th><th style={{ ...th, textAlign: 'right' }}>Mean return</th>
                  <th style={{ ...th, textAlign: 'right' }}>Win rate</th>
                </tr>
              </thead>
              <tbody>
                <BookRow name="All positions" b={sc.all} />
                <BookRow name="Capped book" b={sc.capped} note={`${sc.skipped} skipped by the cap`} />
              </tbody>
            </table>
            {sc.unknownSector > 0 && (
              <div style={{ ...muted, marginTop: 8 }}>{sc.unknownSector} position(s) have no sector on record — each counted as its own sector.</div>
            )}
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginTop: 14 }}>
              <div>
                <div style={muted}>Open now by sector</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                  {report.concentration.bySector.length === 0 && <span style={muted}>none open</span>}
                  {report.concentration.bySector.map(x => (
                    <Pill key={x.key} color={x.n > sc.cap ? 'var(--danger)' : x.n === sc.cap ? 'var(--warning)' : 'var(--border)'}>
                      {x.key} {x.n}
                    </Pill>
                  ))}
                </div>
              </div>
              <div>
                <div style={muted}>Open now by expiry</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                  {report.concentration.byExpiry.length === 0 && <span style={muted}>none open</span>}
                  {report.concentration.byExpiry.map(x => <Pill key={x.key} color="var(--border)">{x.key} {x.n}</Pill>)}
                </div>
              </div>
            </div>
          </div>

          {/* ── Positions ── */}
          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
              <h3 style={{ ...h3, margin: 0 }}>Positions</h3>
              <span style={muted}>{report.counts.pickRows} pick rows → {report.counts.positions} positions</span>
              <span style={{ flex: 1 }} />
              {(['all', 'open', 'settled', 'unsettleable'] as const).map(f => (
                <button key={f} className="btn-ghost" onClick={() => setFilter(f)}
                  style={filter === f ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}>
                  {f}
                </button>
              ))}
            </div>
            {/* Only sideways: the page scrolls as one, so a nested vertical box would trap the wheel. */}
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead>
                  <tr>
                    <th style={th}>Entry</th><th style={th}>Ticker</th><th style={th}>Sector</th><th style={th}>Expiry</th>
                    <th style={{ ...th, textAlign: 'right' }}>Short / long</th><th style={{ ...th, textAlign: 'right' }}>Credit</th>
                    <th style={{ ...th, textAlign: 'right' }}>Max loss</th><th style={th}>Status</th><th style={th}>Exit / last mark</th>
                    <th style={{ ...th, textAlign: 'right' }} title="Settled: return on max loss. Open: paper value at the last mid (not a stop signal).">Return</th>
                    <th style={{ ...th, textAlign: 'right' }} title="Captured marks used / marks missing a leg">Marks</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && <tr><td style={td} colSpan={11}><span style={muted}>No positions match.</span></td></tr>}
                  {rows.map(p => {
                    const s = p.settlement;
                    const st = STATUS_STYLE[s.status];
                    const done = settledReturn(s);
                    const mark = markReturn(p);
                    const exit = s.status === 'target' || s.status === 'expired' ? s.exitDate : s.status === 'open' ? s.lastMarkDate ?? '—' : '—';
                    return (
                      <tr key={p.id} style={p.sectorCapSkipped ? { opacity: 0.6 } : undefined}>
                        <td style={td}>{p.asOfDate} <span style={muted}>{p.slot === 'intraday' ? 'am' : 'pm'}</span></td>
                        <td style={{ ...td, fontWeight: 600 }}>
                          {p.ticker}
                          {p.repeats > 0 && <span style={{ ...muted, marginLeft: 6 }} title="Later picks of this ticker within 14 days, collapsed into this position">+{p.repeats}</span>}
                        </td>
                        <td style={td}>
                          <span style={muted}>{p.sector ?? '—'}</span>
                          {p.sectorCapSkipped && <span style={{ marginLeft: 6 }}><Pill color="var(--warning)" title={`A book capped at ${sc.cap} per sector would not have opened this`}>cap: skipped</Pill></span>}
                        </td>
                        <td style={td}>{p.expiration}</td>
                        <td style={num}>{p.shortStrike} / {p.longStrike}</td>
                        <td style={num}>{money(p.netCredit)}</td>
                        <td style={num}>{money(p.maxLoss)}</td>
                        <td style={td}><Pill color={st.color} title={s.status === 'unsettleable' ? s.reason : undefined}>{st.label}</Pill></td>
                        <td style={td}>{exit}</td>
                        <td style={{ ...num, color: tone(done ?? mark), fontStyle: done == null && mark != null ? 'italic' : undefined }}
                          title={done == null && mark != null ? `paper value at the last mid debit ${s.status === 'open' && s.lastMidDebit != null ? money(s.lastMidDebit) : ''}` : undefined}>
                          {done != null ? pct(done) : mark != null ? `~${pct(mark)}` : '—'}
                        </td>
                        <td style={num}>{s.marks}/{s.gaps}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ ...muted, marginTop: 8 }}>
              <em>~italic</em> returns on open positions are paper values at the last captured mid — not settled, and not a stop signal (the mode holds to target or expiry).
            </div>
          </div>

          {/* ── Rejections ── */}
          <details style={card} open>
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Rejection reasons <span style={muted}>(all runs)</span></summary>
            <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: 12 }}>
              <thead>
                <tr><th style={{ ...th, textAlign: 'right' }}>n</th><th style={th}>Reason</th><th style={th}>Tickers</th></tr>
              </thead>
              <tbody>
                {report.rejectionReasons.map(r => (
                  <tr key={r.reason}>
                    <td style={{ ...num, verticalAlign: 'top' }}>{r.n}</td>
                    <td style={{ ...td, verticalAlign: 'top', whiteSpace: 'normal' }}>
                      {r.reason}
                      {r.causes.length > 0 && (
                        <div style={{ ...muted, marginTop: 4 }}>
                          {r.causes.map(c => <div key={c.cause}>↳ {c.n} × {c.cause}</div>)}
                        </div>
                      )}
                    </td>
                    <td style={{ ...td, whiteSpace: 'normal', color: 'var(--text-muted)' }}>
                      {r.tickers.map(t => (t.n > 1 ? `${t.ticker}×${t.n}` : t.ticker)).join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>

          {/* ── Runs ── */}
          <details style={card}>
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Runs <span style={muted}>({report.runs.length})</span></summary>
            <table style={{ borderCollapse: 'collapse', marginTop: 12 }}>
              <thead>
                <tr><th style={th}>Date</th><th style={th}>Slot</th><th style={{ ...th, textAlign: 'right' }}>Picks</th><th style={{ ...th, textAlign: 'right' }}>Rejected</th></tr>
              </thead>
              <tbody>
                {[...report.runs].reverse().map(r => (
                  <tr key={`${r.asOfDate}-${r.slot}`}>
                    <td style={td}>{r.asOfDate}</td><td style={td}>{r.slot}</td>
                    <td style={num}>{r.picks}</td><td style={num}>{r.rejected}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </div>
  );
}
