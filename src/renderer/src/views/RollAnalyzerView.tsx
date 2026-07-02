// Roll / Closure Analyzer — exit-side companion to the Payoff visualizer.
// For a single short option (CSP or covered call) you hold or want to model, it prices
// close-now vs hold-to-expiry and ranks credit-roll candidates by a metric you pick.

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type {
  RollPositionInput, RollMetric, RollAnalysis, RollCandidate, PositionEtrade,
} from '@shared/types';

const METRICS: { key: RollMetric; label: string; hint: string }[] = [
  { key: 'annualizedRoc',     label: 'Annualized return on capital', hint: 'Net credit ÷ capital ÷ days, annualized. Best yield per day per dollar.' },
  { key: 'netCredit',         label: 'Largest net credit',           hint: 'Most cash collected on the roll, regardless of duration.' },
  { key: 'riskAdjusted',      label: 'Risk-adjusted yield',          hint: 'Annualized ROC, down-weighted by assignment probability (delta).' },
  { key: 'capitalEfficiency', label: 'Capital efficiency',           hint: 'Credit per dollar of capital committed (favors rolling down).' },
];

// Client-side mirror of scoreByMetric (roll-analyzer-service) so switching the metric
// re-ranks instantly without re-fetching chains.
function scoreByMetric(c: RollCandidate, metric: RollMetric): number {
  switch (metric) {
    case 'netCredit':         return c.netCredit;
    case 'capitalEfficiency': return c.capitalEfficiency;
    case 'annualizedRoc':     return c.annualizedRoc ?? -Infinity;
    case 'riskAdjusted':      return (c.annualizedRoc ?? 0) * (1 - (c.assignmentProbability ?? 0.5));
  }
}

const money = (n: number | null | undefined) => (n == null ? '—' : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
const money2 = (n: number | null | undefined) => (n == null ? '—' : `$${n.toFixed(2)}`);
const pct = (n: number | null | undefined) => (n == null ? '—' : `${(n * 100).toFixed(0)}%`);
const pct1 = (n: number | null | undefined) => (n == null ? '—' : `${(n * 100).toFixed(1)}%`);

const DIR_LABEL: Record<RollCandidate['direction'], string> = {
  'same': 'out (same strike)', 'out-down': '↓ down & out', 'out-up': '↑ up & out',
};

export function RollAnalyzerView() {
  const [ticker, setTicker] = useState('');
  const [optionType, setOptionType] = useState<'put' | 'call'>('put');
  const [strike, setStrike] = useState('');
  const [expiration, setExpiration] = useState('');
  const [contracts, setContracts] = useState('1');
  const [entryCredit, setEntryCredit] = useState('');
  const [metric, setMetric] = useState<RollMetric>('annualizedRoc');

  const [positions, setPositions] = useState<PositionEtrade[]>([]);
  const [result, setResult] = useState<RollAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load open short-option positions for the "Load position" dropdown.
  useEffect(() => {
    window.api.portfolio.etrade.listPositions()
      .then((rows) => setPositions(
        (rows ?? []).filter((p) => (p.positionType === 'CSP' || p.positionType === 'CC') && p.status === 'open' && p.strikePrice != null && p.expirationDate != null),
      ))
      .catch(() => { /* portfolio optional — manual entry still works */ });
  }, []);

  function loadPosition(id: number) {
    const p = positions.find((x) => x.id === id);
    if (!p) return;
    setTicker(p.ticker);
    setOptionType(p.positionType === 'CSP' ? 'put' : 'call');
    setStrike(String(p.strikePrice ?? ''));
    setExpiration((p.expirationDate ?? '').slice(0, 10));
    setContracts(String(Math.max(1, Math.abs(p.quantity) || 1)));
    setEntryCredit(p.premiumReceived != null ? String(p.premiumReceived) : '');
    setResult(null);
    setError(null);
  }

  const inputValid = ticker.trim() && Number(strike) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(expiration) && Number(contracts) > 0 && Number(entryCredit) > 0;

  async function analyze() {
    if (!inputValid) { setError('Fill ticker, strike, expiry (YYYY-MM-DD), contracts, and entry credit.'); return; }
    setLoading(true);
    setError(null);
    const input: RollPositionInput = {
      ticker: ticker.trim().toUpperCase(),
      optionType,
      strike: Number(strike),
      expiration,
      contracts: Number(contracts),
      entryCredit: Number(entryCredit),
    };
    try {
      const res = await window.api.roll.analyze(input, metric);
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  // Re-rank client-side when the metric changes (no re-fetch).
  const rankedCandidates = useMemo(() => {
    if (!result) return [];
    return [...result.candidates]
      .map((c) => ({ ...c, score: scoreByMetric(c, metric) }))
      .sort((a, b) => b.score - a.score);
  }, [result, metric]);

  const cur = result?.current;
  const label: CSSProperties = { display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 };
  const field: CSSProperties = { padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', width: '100%' };
  const th: CSSProperties = { textAlign: 'right', padding: '6px 8px', borderBottom: '2px solid var(--border)', position: 'sticky', top: 0, background: 'var(--bg-elev)', whiteSpace: 'nowrap' };
  const td: CSSProperties = { textAlign: 'right', padding: '5px 8px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };

  return (
    <div style={{ padding: 16, maxWidth: 1120 }}>
      <h2 style={{ marginTop: 0 }}>🔄 Roll / Closure Analyzer</h2>
      <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
        For a single short option (cash-secured put or covered call) you hold — or want to model —
        compare <strong>close vs hold vs roll</strong>, and rank credit-roll candidates by the metric you choose.
      </p>

      {/* ── Position input ── */}
      <div style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, padding: 16, marginBottom: 16 }}>
        {positions.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <label style={label}>Load an open position (CSP / covered call)</label>
            <select style={{ ...field, maxWidth: 420 }} defaultValue="" onChange={(e) => e.target.value && loadPosition(Number(e.target.value))}>
              <option value="">— manual entry —</option>
              {positions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.ticker} {p.positionType} ${p.strikePrice} {(p.expirationDate ?? '').slice(0, 10)} ×{Math.abs(p.quantity)}
                </option>
              ))}
            </select>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 12 }}>
          <div><label style={label}>Ticker</label><input style={field} value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="MRVL" /></div>
          <div>
            <label style={label}>Type</label>
            <select style={field} value={optionType} onChange={(e) => setOptionType(e.target.value as 'put' | 'call')}>
              <option value="put">Short put (CSP)</option>
              <option value="call">Short call (CC)</option>
            </select>
          </div>
          <div><label style={label}>Strike</label><input style={field} value={strike} onChange={(e) => setStrike(e.target.value)} placeholder="270" inputMode="decimal" /></div>
          <div><label style={label}>Expiry (YYYY-MM-DD)</label><input style={field} value={expiration} onChange={(e) => setExpiration(e.target.value)} placeholder="2026-07-31" /></div>
          <div><label style={label}>Contracts</label><input style={field} value={contracts} onChange={(e) => setContracts(e.target.value)} inputMode="numeric" /></div>
          <div><label style={label}>Entry credit / sh</label><input style={field} value={entryCredit} onChange={(e) => setEntryCredit(e.target.value)} placeholder="3.20" inputMode="decimal" /></div>
        </div>

        <div style={{ marginTop: 14 }}>
          <label style={label}>Rank roll candidates by</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {METRICS.map((m) => (
              <button
                key={m.key}
                title={m.hint}
                onClick={() => setMetric(m.key)}
                style={{
                  padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
                  border: '1px solid var(--border)',
                  background: metric === m.key ? 'var(--accent)' : 'var(--bg)',
                  color: metric === m.key ? '#fff' : 'var(--text)', fontWeight: metric === m.key ? 600 : 400,
                }}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={analyze}
            disabled={loading || !inputValid}
            style={{
              padding: '8px 20px', borderRadius: 6, border: 'none', cursor: loading || !inputValid ? 'not-allowed' : 'pointer',
              background: loading || !inputValid ? 'var(--border)' : 'var(--accent)', color: '#fff', fontWeight: 600,
            }}
          >
            {loading ? 'Analyzing…' : 'Analyze'}
          </button>
          {error && <span style={{ color: 'var(--danger, #d33)' }}>{error}</span>}
        </div>
      </div>

      {/* ── Results ── */}
      {result && cur && (
        <>
          {/* Recommendation banner */}
          <div style={{
            padding: '12px 16px', borderRadius: 8, marginBottom: 16,
            background: 'var(--bg-elev)', borderLeft: `4px solid ${result.recommendation.action === 'close' ? '#e0a800' : result.recommendation.action === 'roll' ? 'var(--accent)' : '#4caf50'}`,
          }}>
            <strong style={{ textTransform: 'uppercase', fontSize: 13, letterSpacing: 0.5 }}>
              {result.recommendation.action === 'hold' ? '✋ Hold' : result.recommendation.action === 'close' ? '💰 Close' : '🔄 Roll'}
            </strong>
            <span style={{ marginLeft: 10, color: 'var(--text-muted)' }}>{result.recommendation.reason}</span>
          </div>

          {/* Current state */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 16 }}>
            {[
              ['Underlying', money2(cur.underlyingPrice)],
              ['Moneyness', `${cur.moneyness} · ${cur.dte}d left`],
              ['Mark to close /sh', money2(cur.markToClose)],
              ['Close now P&L', cur.unrealizedPnl == null ? '—' : `${money(cur.unrealizedPnl)} (${pct(cur.pctOfMaxProfit)} of credit)`],
              ['Assignment prob (Δ)', pct(cur.assignmentProbability)],
              ['Breakeven', money2(cur.breakeven)],
              ['Capital at risk', money(cur.capitalAtRisk)],
              ['Credit at open', money(cur.openCredit)],
            ].map(([k, v]) => (
              <div key={k} style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{k}</div>
                <div style={{ fontSize: 15, fontWeight: 600, marginTop: 2 }}>{v}</div>
              </div>
            ))}
          </div>

          {result.notes.length > 0 && (
            <ul style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 0 }}>
              {result.notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          )}

          {/* Roll candidates */}
          <h3 style={{ marginBottom: 8 }}>Roll candidates ({rankedCandidates.length}) — ranked by {METRICS.find((m) => m.key === metric)?.label}</h3>
          <div style={{ maxHeight: '50vh', overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: 'left' }}>Expiry</th>
                  <th style={th}>DTE (+add)</th>
                  <th style={{ ...th, textAlign: 'left' }}>Strike / dir</th>
                  <th style={th}>Net credit</th>
                  <th style={th}>Ann. ROC</th>
                  <th style={th}>Cap. eff.</th>
                  <th style={th}>Assign Δ</th>
                  <th style={th}>New breakeven</th>
                  <th style={th}>Liq</th>
                </tr>
              </thead>
              <tbody>
                {rankedCandidates.map((c, i) => (
                  <tr key={`${c.expiration}-${c.strike}`} style={{ background: i === 0 ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : undefined }}>
                    <td style={{ ...td, textAlign: 'left' }}>{c.expiration}</td>
                    <td style={td}>{c.dte} <span style={{ color: 'var(--text-muted)' }}>(+{c.addedDte})</span></td>
                    <td style={{ ...td, textAlign: 'left' }}>${c.strike} <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{DIR_LABEL[c.direction]}</span></td>
                    <td style={{ ...td, fontWeight: 600 }}>{money(c.netCredit)}</td>
                    <td style={td}>{pct1(c.annualizedRoc)}</td>
                    <td style={td}>{pct1(c.capitalEfficiency)}</td>
                    <td style={td}>{pct(c.assignmentProbability)}</td>
                    <td style={td}>{money2(c.breakeven)}</td>
                    <td style={td}>{c.liquidityOk ? '✓' : <span title="Wide bid/ask — confirm fill" style={{ color: '#e0a800' }}>⚠</span>}</td>
                  </tr>
                ))}
                {rankedCandidates.length === 0 && (
                  <tr><td style={{ ...td, textAlign: 'left', color: 'var(--text-muted)' }} colSpan={9}>No net-credit roll found in the scanned expiries/strikes.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 8 }}>
            Credit-rolls only (net credit &gt; 0). Marks are bid/ask midpoints — confirm real fills before trading.
            New breakeven folds the roll credit into your cumulative basis.
          </p>
        </>
      )}
    </div>
  );
}

export default RollAnalyzerView;
