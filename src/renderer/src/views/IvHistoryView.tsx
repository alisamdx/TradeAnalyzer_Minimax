// IV History management screen — initial backfill, gap fill, coverage summary, token config.
// see docs/formulas.md#iv-history

import { useState, useEffect, useRef, useCallback } from 'react';
import type { IvHistoryCoverage, IvHistoryGapSummary, IvHistoryProgressEvent } from '@shared/types.js';

type Phase = 'initial_sp500' | 'initial_russell' | 'gap_fill';

interface InitialLoadStatus {
  sp500:   { complete: boolean; completedAt: string | null };
  russell: { complete: boolean; completedAt: string | null; newTickers: number };
}

const PHASE_LABELS: Record<Phase, string> = {
  initial_sp500:   'S&P 500 Initial Load',
  initial_russell: 'Russell 1000 Initial Load',
  gap_fill:        'Gap Fill',
};

// ─── Sub-components ────────────────────────────────────────────────────────────

function CoverageCard({ label, value, color }: { label: string; value: number | null; color: string }) {
  return (
    <div style={{ background: '#1a1a2e', border: `1px solid ${color}44`, borderRadius: 8, padding: '10px 16px', minWidth: 100, textAlign: 'center' }}>
      <div style={{ fontSize: 24, fontWeight: 700, color }}>{value ?? '—'}</div>
      <div style={{ fontSize: 11, color: '#aaa', marginTop: 2 }}>{label}</div>
    </div>
  );
}

function StatusBadge({ complete, completedAt }: { complete: boolean; completedAt: string | null }) {
  if (complete) {
    return <span style={{ background: '#1a3a1a', color: '#4caf50', border: '1px solid #4caf5044', borderRadius: 4, padding: '2px 8px', fontSize: 11 }}>
      ✓ Complete {completedAt ? `· ${completedAt}` : ''}
    </span>;
  }
  return <span style={{ background: '#2a1a1a', color: '#ff9800', border: '1px solid #ff980044', borderRadius: 4, padding: '2px 8px', fontSize: 11 }}>Not started</span>;
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: '#13131f', border: '1px solid #2a2a3e', borderRadius: 10, padding: '16px 20px', marginBottom: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#9090b8', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title}</div>
      {children}
    </div>
  );
}

// ─── Main view ─────────────────────────────────────────────────────────────────

export function IvHistoryView() {
  const [keyConfigured, setKeyConfigured]     = useState(false);

  const [coverage, setCoverage]               = useState<IvHistoryCoverage | null>(null);
  const [gaps, setGaps]                       = useState<IvHistoryGapSummary | null>(null);
  const [loadStatus, setLoadStatus]           = useState<InitialLoadStatus | null>(null);

  // Ticker lookup
  const [lookupTicker, setLookupTicker]       = useState('');
  const [lookupRows, setLookupRows]           = useState<Array<{ date: string; atm_iv: number; underlying_px: number | null; source: string }> | null>(null);
  const [lookupRank, setLookupRank]           = useState<{ ivRank: number | null; ivPercentile: number | null; currentIv: number | null; dataPoints: number } | null>(null);
  const [lookupLoading, setLookupLoading]     = useState(false);

  const [running, setRunning]                 = useState(false);
  const [activePhase, setActivePhase]         = useState<Phase | null>(null);
  const [progress, setProgress]               = useState<IvHistoryProgressEvent | null>(null);
  const [result, setResult]                   = useState<{ processed: number; skipped: number; failed: number } | null>(null);
  const [error, setError]                     = useState<string | null>(null);
  const [logs, setLogs]                       = useState<string[]>(['Ready. Configure an IVolatility API key in Settings → API & Data, then press Start.']);

  const unsubRef  = useRef<(() => void) | null>(null);
  const logBoxRef = useRef<HTMLDivElement>(null);

  // Auto-scroll console to bottom when new lines arrive
  useEffect(() => {
    if (logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [logs]);

  const appendLog = (msg: string) => {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    setLogs(prev => [...prev, `[${ts}] ${msg}`]);
  };

  const loadData = useCallback(async () => {
    try {
      const [cov, gapSummary, status] = await Promise.all([
        window.api.ivHistory.getCoverage('both'),
        window.api.ivHistory.getGaps('both'),
        window.api.ivHistory.getInitialLoadStatus(),
      ]);
      setCoverage(cov);
      setGaps(gapSummary);
      setLoadStatus(status);
    } catch (e) {
      console.error('[IvHistoryView] loadData failed:', e);
    }
  }, []);

  useEffect(() => {
    window.api.settings.getIvolatilityKey().then(key => {
      const configured = Boolean(key);
      setKeyConfigured(configured);
      if (configured) appendLog('IVolatility API key is configured.');
    }).catch(console.error);
    loadData();
    return () => { unsubRef.current?.(); };
  }, [loadData]);

  const startPhase = async (phase: Phase) => {
    setError(null);
    setResult(null);
    setProgress(null);
    setRunning(true);
    setActivePhase(phase);
    appendLog(`Starting ${PHASE_LABELS[phase]}…`);

    unsubRef.current?.();
    unsubRef.current = window.api.ivHistory.onProgress(evt => {
      setProgress(evt);
      // Log every 50 processed to avoid flooding; always log first event
      const done = evt.processed + evt.skipped + evt.failed;
      // Always log errors; log progress every 10 tickers
      if (evt.lastError) {
        appendLog(`✗ ${evt.ticker} — ${evt.lastError}`);
      } else if (done === 1 || done % 10 === 0) {
        const pct = evt.total > 0 ? Math.round(done / evt.total * 100) : 0;
        appendLog(
          `${evt.ticker} — ok:${evt.processed} skip:${evt.skipped} fail:${evt.failed} (${pct}%) ${evt.callsPerMin}/min`
        );
      }
    });

    try {
      const res = await window.api.ivHistory.startBackfill(phase);
      setResult(res);
      appendLog(`Done — ${res.processed} stored, ${res.skipped} skipped, ${res.failed} failed.`);
      await loadData();
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      appendLog(`Error: ${msg}`);
    } finally {
      setRunning(false);
      setActivePhase(null);
      unsubRef.current?.();
      unsubRef.current = null;
    }
  };

  const cancel = async () => {
    appendLog('Cancelling…');
    await window.api.ivHistory.cancel().catch(console.error);
  };

  const clearLogs = () => setLogs([]);

  const fetchLookup = async () => {
    const t = lookupTicker.trim().toUpperCase();
    if (!t) return;
    setLookupLoading(true);
    setLookupRows(null);
    setLookupRank(null);
    try {
      const [rows, rank] = await Promise.all([
        window.api.ivHistory.getRows(t),
        window.api.ivHistory.getRank(t),
      ]);
      setLookupRows(rows);
      setLookupRank(rank);
    } catch { /* silently ignore */ }
    finally { setLookupLoading(false); }
  };

  const progressPct = progress && progress.total > 0
    ? Math.round((progress.processed + progress.skipped + progress.failed) / progress.total * 100)
    : 0;

  const doneSoFar = progress ? progress.processed + progress.skipped + progress.failed : 0;

  // ─── render ─────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', gap: 20, padding: '20px 24px', height: '100%', boxSizing: 'border-box', fontFamily: 'inherit', minHeight: 0 }}>

      {/* ── Left column: controls ─────────────────────────────────────────── */}
      <div style={{ flex: '0 0 480px', display: 'flex', flexDirection: 'column', gap: 0, overflowY: 'auto' }}>

        <div style={{ marginBottom: 16 }}>
          <span style={{ fontSize: 20, fontWeight: 700, color: '#e0e0f0' }}>IV History</span>
          <span style={{ fontSize: 12, color: '#666', marginLeft: 10 }}>30-day ATM IV · 252 trading days</span>
        </div>

        {/* Key status */}
        <SectionCard title="IVolatility API Key">
          <div style={{ fontSize: 12, color: '#aaa', marginBottom: 6 }}>
            Status:{' '}
            {keyConfigured
              ? <span style={{ color: '#4caf50' }}>Configured ✓</span>
              : <span style={{ color: '#ff9800' }}>Not configured — add key in <strong>Settings → API &amp; Data</strong></span>}
          </div>
          <div style={{ fontSize: 11, color: '#555' }}>
            IVolatility provides true as-of-date daily IVX snapshots (pre-computed 30-day CM ATM IV).
            One API call per ticker covers the full date range — ~500 calls for S&amp;P 500, ~500 more for Russell unique.
            Rate limit: 1 req/sec · 20,000 req/month.
          </div>
        </SectionCard>

        {/* Coverage */}
        <SectionCard title="Coverage Summary">
          {coverage ? (
            <>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                <CoverageCard label="Complete ≥252d" value={coverage.complete} color="#4caf50" />
                <CoverageCard label="Partial 1–251d" value={coverage.partial} color="#ff9800" />
                <CoverageCard label="No Data" value={coverage.none} color="#ef5350" />
                <CoverageCard label="Total Rows" value={coverage.totalReadings} color="#90caf9" />
              </div>
              {coverage.lastRefreshDate && (
                <div style={{ fontSize: 11, color: '#666' }}>Last reading: {coverage.lastRefreshDate}</div>
              )}
            </>
          ) : (
            <div style={{ fontSize: 12, color: '#666' }}>Loading…</div>
          )}
          <button
            onClick={loadData}
            style={{ marginTop: 8, padding: '4px 12px', borderRadius: 5, border: '1px solid #3a3a5e', background: 'transparent', color: '#888', fontSize: 11, cursor: 'pointer' }}
          >
            Refresh
          </button>
        </SectionCard>

        {/* Initial Load */}
        <SectionCard title="Initial Load — 252 trading days">
          {/* Step 1 */}
          <div style={{ padding: '10px 0', borderBottom: '1px solid #1e1e30' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#c8c8e0', marginBottom: 4 }}>Step 1 — S&P 500 (~503 tickers)</div>
                {loadStatus && <StatusBadge complete={loadStatus.sp500.complete} completedAt={loadStatus.sp500.completedAt} />}
              </div>
              {running && activePhase === 'initial_sp500' ? (
                <button onClick={cancel} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#7a2020', color: '#fff', fontSize: 12, cursor: 'pointer' }}>
                  Cancel
                </button>
              ) : (
                <button
                  onClick={() => startPhase('initial_sp500')}
                  disabled={running || !keyConfigured}
                  style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: keyConfigured && !running ? '#2a5a8a' : '#333', color: '#fff', fontSize: 12, cursor: running || !keyConfigured ? 'not-allowed' : 'pointer', opacity: running || !keyConfigured ? 0.5 : 1 }}
                >
                  {loadStatus?.sp500.complete ? 'Re-run' : 'Start'}
                </button>
              )}
            </div>
          </div>

          {/* Step 2 */}
          <div style={{ padding: '10px 0 4px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#c8c8e0', marginBottom: 2 }}>
                  Step 2 — Russell 1000
                  {loadStatus?.russell.newTickers ? ` (~${loadStatus.russell.newTickers} unique)` : ''}
                </div>
                <div style={{ fontSize: 11, color: '#555', marginBottom: 4 }}>Skips tickers already in Step 1</div>
                {loadStatus && <StatusBadge complete={loadStatus.russell.complete} completedAt={loadStatus.russell.completedAt} />}
              </div>
              {running && activePhase === 'initial_russell' ? (
                <button onClick={cancel} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#7a2020', color: '#fff', fontSize: 12, cursor: 'pointer' }}>
                  Cancel
                </button>
              ) : (
                <button
                  onClick={() => startPhase('initial_russell')}
                  disabled={running || !keyConfigured}
                  style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: keyConfigured && !running ? '#2a5a8a' : '#333', color: '#fff', fontSize: 12, cursor: running || !keyConfigured ? 'not-allowed' : 'pointer', opacity: running || !keyConfigured ? 0.5 : 1 }}
                >
                  {loadStatus?.russell.complete ? 'Re-run' : 'Start'}
                </button>
              )}
            </div>
          </div>
        </SectionCard>

        {/* Gap Fill */}
        <SectionCard title="Ongoing Refresh — Gap Fill">
          <div style={{ fontSize: 12, color: '#888', marginBottom: 10 }}>
            Fetches any trading days missing since the last reading — one API call per ticker.
            E*Trade auto-capture also stores today's IV for free whenever you open an options chain.
          </div>
          {gaps ? (
            <div style={{ fontSize: 12, color: '#c8c8e0', marginBottom: 10 }}>
              {gaps.missingPairs === 0
                ? <span style={{ color: '#4caf50' }}>No gaps — up to date.</span>
                : <>
                    <span style={{ color: '#ff9800' }}>{gaps.missingPairs.toLocaleString()} pairs</span>
                    {' '}· {gaps.missingDays} days
                    {gaps.oldestGapDate ? ` · ${gaps.oldestGapDate} → ${gaps.newestGapDate}` : ''}
                  </>
              }
            </div>
          ) : (
            <div style={{ fontSize: 12, color: '#555', marginBottom: 10 }}>Loading…</div>
          )}
          {running && activePhase === 'gap_fill' ? (
            <button onClick={cancel} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#7a2020', color: '#fff', fontSize: 12, cursor: 'pointer' }}>
              Cancel Gap Fill
            </button>
          ) : (
            <button
              onClick={() => startPhase('gap_fill')}
              disabled={running || !keyConfigured || gaps?.missingPairs === 0}
              style={{ padding: '6px 16px', borderRadius: 6, border: 'none', background: keyConfigured && gaps?.missingPairs && !running ? '#2a5a8a' : '#333', color: '#fff', fontSize: 12, cursor: 'pointer', opacity: running || !keyConfigured || gaps?.missingPairs === 0 ? 0.5 : 1 }}
            >
              Start Gap Fill
            </button>
          )}
        </SectionCard>
      </div>

      {/* ── Right column: progress + console ─────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>

        {/* Progress bar + stats */}
        <div style={{ background: '#13131f', border: '1px solid #2a2a3e', borderRadius: 10, padding: '16px 20px', marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#9090b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {running && activePhase ? PHASE_LABELS[activePhase] : result ? 'Last Run' : 'Progress'}
            </span>
            {running && (
              <span style={{ fontSize: 11, color: '#ff9800', animation: 'pulse 1.2s ease-in-out infinite' }}>● RUNNING</span>
            )}
            {!running && result && (
              <span style={{ fontSize: 11, color: '#4caf50' }}>● COMPLETE</span>
            )}
            {!running && error && (
              <span style={{ fontSize: 11, color: '#ef5350' }}>● ERROR</span>
            )}
          </div>

          {/* Progress bar — always visible */}
          <div style={{ background: '#1a1a2e', borderRadius: 6, height: 14, overflow: 'hidden', marginBottom: 8, border: '1px solid #2a2a3e' }}>
            <div style={{
              height: '100%',
              width: running || result ? `${progressPct}%` : '0%',
              background: error ? '#ef5350' : result ? '#4caf50' : '#3a8fd0',
              transition: 'width 0.4s ease',
              borderRadius: 6,
            }} />
          </div>

          {/* Stats row */}
          <div style={{ display: 'flex', gap: 20, fontSize: 12, color: '#888', flexWrap: 'wrap' }}>
            {running && progress ? (
              <>
                <span>Ticker: <strong style={{ color: '#e0e0f0' }}>{progress.ticker}</strong></span>
                <span>Date: <strong style={{ color: '#e0e0f0' }}>{progress.date}</strong></span>
                <span>{doneSoFar.toLocaleString()} / {progress.total.toLocaleString()} <span style={{ color: '#777' }}>({progressPct}%)</span></span>
                <span>Stored: <strong style={{ color: '#4caf50' }}>{progress.processed}</strong></span>
                <span>Skipped: <strong style={{ color: '#ff9800' }}>{progress.skipped}</strong></span>
                <span>Failed: <strong style={{ color: '#ef5350' }}>{progress.failed}</strong></span>
                <span>Rate: <strong style={{ color: '#90caf9' }}>{progress.callsPerMin}/min</strong></span>
              </>
            ) : running ? (
              <span style={{ color: '#ff9800' }}>Starting — waiting for first response…</span>
            ) : result ? (
              <>
                <span>Stored: <strong style={{ color: '#4caf50' }}>{result.processed}</strong></span>
                <span>Skipped: <strong style={{ color: '#888' }}>{result.skipped}</strong></span>
                <span>Failed: <strong style={{ color: result.failed > 0 ? '#ef5350' : '#888' }}>{result.failed}</strong></span>
              </>
            ) : error ? (
              <span style={{ color: '#ef5350' }}>{error}</span>
            ) : (
              <span style={{ color: '#444' }}>No run in progress.</span>
            )}
          </div>
        </div>

        {/* Console log box — half height */}
        <div style={{ flex: '0 0 180px', display: 'flex', flexDirection: 'column', background: '#0c0c18', border: '1px solid #2a2a3e', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 14px', background: '#13131f', borderBottom: '1px solid #1e1e30' }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: '#6060a0', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Console</span>
            <button onClick={clearLogs} style={{ fontSize: 10, color: '#555', background: 'transparent', border: 'none', cursor: 'pointer', padding: '2px 6px' }}>Clear</button>
          </div>
          <div ref={logBoxRef} style={{ flex: 1, overflowY: 'auto', padding: '8px 14px', fontFamily: '"Cascadia Code", "Fira Code", "Consolas", monospace', fontSize: 11, lineHeight: 1.55, color: '#a0c0a0' }}>
            {logs.length === 0 ? (
              <span style={{ color: '#444' }}>No output yet.</span>
            ) : (
              logs.map((line, i) => (
                <div key={i} style={{
                  color: line.includes('Error') || line.includes('fail') ? '#ef9a9a'
                       : line.includes('Done') || line.includes('saved') || line.includes('Configured') ? '#a5d6a7'
                       : line.includes('Cancel') ? '#ff9800'
                       : '#a0c0a0',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                }}>{line}</div>
              ))
            )}
          </div>
        </div>

        {/* ── Ticker Lookup ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#13131f', border: '1px solid #2a2a3e', borderRadius: 10, overflow: 'hidden', minHeight: 0 }}>
          {/* Search bar */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid #1e1e30' }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: '#6060a0', textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>Lookup Symbol</span>
            <input
              type="text"
              value={lookupTicker}
              onChange={e => setLookupTicker(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && fetchLookup()}
              placeholder="e.g. AAPL"
              style={{ width: 90, padding: '4px 8px', borderRadius: 5, border: '1px solid #3a3a5e', background: '#1a1a2e', color: '#e0e0f0', fontSize: 12, fontFamily: 'monospace', textTransform: 'uppercase' }}
            />
            <button
              onClick={fetchLookup}
              disabled={lookupLoading || !lookupTicker.trim()}
              style={{ padding: '4px 12px', borderRadius: 5, border: 'none', background: '#3a5fb0', color: '#fff', fontSize: 12, cursor: 'pointer', opacity: lookupLoading || !lookupTicker.trim() ? 0.5 : 1 }}
            >
              {lookupLoading ? 'Loading…' : 'Fetch'}
            </button>
            {lookupRank && lookupRows !== null && (
              <div style={{ display: 'flex', gap: 16, marginLeft: 8, fontSize: 12, color: '#888' }}>
                <span>{lookupRows.length} rows</span>
                {lookupRank.currentIv !== null && <span>Current IV: <strong style={{ color: '#e0e0f0' }}>{lookupRank.currentIv.toFixed(1)}%</strong></span>}
                {lookupRank.ivRank !== null && <span>IV Rank: <strong style={{ color: '#fab387' }}>{lookupRank.ivRank.toFixed(1)}%</strong></span>}
                {lookupRank.ivPercentile !== null && <span>IV Pct: <strong style={{ color: '#89b4fa' }}>{lookupRank.ivPercentile.toFixed(1)}%</strong></span>}
              </div>
            )}
            {lookupRows !== null && lookupRows.length === 0 && (
              <span style={{ fontSize: 12, color: '#ff9800', marginLeft: 8 }}>No data stored for {lookupTicker}</span>
            )}
          </div>

          {/* Data grid */}
          {lookupRows && lookupRows.length > 0 && (
            <div style={{ flex: 1, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead style={{ position: 'sticky', top: 0, background: '#13131f', zIndex: 1 }}>
                  <tr style={{ color: '#6c7086', borderBottom: '1px solid #2a2a3e' }}>
                    <th style={{ textAlign: 'left', padding: '6px 14px', fontWeight: 600 }}>#</th>
                    <th style={{ textAlign: 'left', padding: '6px 14px', fontWeight: 600 }}>Date</th>
                    <th style={{ textAlign: 'right', padding: '6px 14px', fontWeight: 600 }}>IV30</th>
                    <th style={{ textAlign: 'right', padding: '6px 14px', fontWeight: 600 }}>Stock Price</th>
                    <th style={{ textAlign: 'left', padding: '6px 14px', fontWeight: 600 }}>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {lookupRows.map((row, i) => {
                    const ivPct = row.atm_iv;  // stored as percentage since migration 017
                    const ivColor = ivPct > 50 ? '#ef5350' : ivPct > 30 ? '#ff9800' : '#4caf50';
                    return (
                      <tr key={row.date} style={{ borderBottom: '1px solid #1a1a2e', background: i % 2 === 0 ? 'transparent' : '#0e0e1a' }}>
                        <td style={{ padding: '4px 14px', color: '#444', fontFamily: 'monospace' }}>{lookupRows.length - i}</td>
                        <td style={{ padding: '4px 14px', fontFamily: 'monospace', color: '#cdd6f4' }}>{row.date}</td>
                        <td style={{ padding: '4px 14px', textAlign: 'right', fontFamily: 'monospace', color: ivColor, fontWeight: 600 }}>{ivPct.toFixed(2)}%</td>
                        <td style={{ padding: '4px 14px', textAlign: 'right', fontFamily: 'monospace', color: '#cdd6f4' }}>{row.underlying_px !== null ? `$${row.underlying_px.toFixed(2)}` : '—'}</td>
                        <td style={{ padding: '4px 14px' }}>
                          <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: row.source === 'ivolatility' ? '#1a2a3a' : row.source === 'etrade' ? '#2a1a3a' : '#1a2a1a', color: row.source === 'ivolatility' ? '#89b4fa' : row.source === 'etrade' ? '#cba6f7' : '#a6e3a1' }}>
                            {row.source}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {!lookupRows && (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#333', fontSize: 12 }}>
              Enter a symbol above to inspect stored IV history
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
