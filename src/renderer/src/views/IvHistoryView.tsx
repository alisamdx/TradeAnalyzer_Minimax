// History screen — IV initial backfill + bulk price history load + coverage summary.
// Gap-fill (ongoing refresh) lives in Data Sync → sections 3 & 5.
// see docs/formulas.md#iv-history

import { useState, useEffect, useRef, useCallback } from 'react';
import type { IvHistoryCoverage, IvHistoryGapSummary, IvHistoryProgressEvent } from '@shared/types.js';

type IvPhase = 'initial_sp500' | 'initial_russell' | 'initial_etf';

interface InitialLoadStatus {
  sp500:   { complete: boolean; completedAt: string | null };
  russell: { complete: boolean; completedAt: string | null; newTickers: number };
  etf:     { complete: boolean; completedAt: string | null; totalTickers: number };
}

const IV_PHASE_LABELS: Record<IvPhase, string> = {
  initial_sp500:   'S&P 500 IV Initial Load',
  initial_russell: 'Russell 1000 IV Initial Load',
  initial_etf:     'ETF Universe IV Initial Load',
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

export function HistoryView() {
  const [ivKeyConfigured, setIvKeyConfigured] = useState(false);

  const [ivCoverage, setIvCoverage]     = useState<IvHistoryCoverage | null>(null);
  const [ivGaps, setIvGaps]             = useState<IvHistoryGapSummary | null>(null);
  const [loadStatus, setLoadStatus]     = useState<InitialLoadStatus | null>(null);

  // Ticker lookup
  const [lookupTicker, setLookupTicker]   = useState('');
  const [lookupMode, setLookupMode]       = useState<'iv' | 'price'>('iv');
  const [lookupRows, setLookupRows]       = useState<Array<{ date: string; atm_iv: number; underlying_px: number | null; source: string }> | null>(null);
  const [lookupRank, setLookupRank]       = useState<{ ivRank: number | null; ivPercentile: number | null; currentIv: number | null; dataPoints: number } | null>(null);
  const [priceRows, setPriceRows]         = useState<Array<{ date: string; open: number; high: number; low: number; close: number; volume: number; adjustedClose: number | null }> | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);

  // IV phase run state
  const [ivRunning, setIvRunning]         = useState(false);
  const [activeIvPhase, setActiveIvPhase] = useState<IvPhase | null>(null);
  const [ivProgress, setIvProgress]       = useState<IvHistoryProgressEvent | null>(null);
  const [ivResult, setIvResult]           = useState<{ processed: number; skipped: number; failed: number } | null>(null);
  const ivUnsubRef = useRef<(() => void) | null>(null);

  // Bulk price load state
  const [bulkUniverse, setBulkUniverse]   = useState<'sp500' | 'russell1000' | 'both' | 'etf'>('both');
  const [bulkRunning, setBulkRunning]     = useState(false);
  const [bulkProgress, setBulkProgress]   = useState<{ done: number; total: number; ticker: string; stored: number; failed: number } | null>(null);
  const [bulkResult, setBulkResult]       = useState<{ stored: number; skipped: number; failed: number } | null>(null);
  const [priceCoverage, setPriceCoverage] = useState<number | null>(null);
  const bulkCancelRef = useRef(false);

  const [error, setError]   = useState<string | null>(null);
  const [logs, setLogs]     = useState<string[]>(['Ready.']);
  const logBoxRef           = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [logs]);

  const appendLog = (msg: string) => {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    setLogs(prev => [...prev, `[${ts}] ${msg}`]);
  };

  const loadData = useCallback(async () => {
    try {
      const [cov, gapSummary, status, priceCnt] = await Promise.all([
        window.api.ivHistory.getCoverage('both'),
        window.api.ivHistory.getGaps('both'),
        window.api.ivHistory.getInitialLoadStatus(),
        window.api.historical.getPriceTickerCount(),
      ]);
      setIvCoverage(cov);
      setIvGaps(gapSummary);
      setLoadStatus(status);
      setPriceCoverage(priceCnt);
    } catch (e) {
      console.error('[HistoryView] loadData failed:', e);
    }
  }, []);

  useEffect(() => {
    window.api.settings.getIvolatilityKey().then(key => {
      const configured = Boolean(key);
      setIvKeyConfigured(configured);
      if (configured) appendLog('IVolatility API key is configured.');
      else appendLog('IVolatility key not set — add it in Settings → API & Data.');
    }).catch(console.error);
    loadData();
    return () => { ivUnsubRef.current?.(); };
  }, [loadData]);

  // ─── IV phase runner ──────────────────────────────────────────────────────

  const startIvPhase = async (phase: IvPhase) => {
    setError(null);
    setIvResult(null);
    setIvProgress(null);
    setIvRunning(true);
    setActiveIvPhase(phase);
    setBulkResult(null);
    setBulkProgress(null);
    appendLog(`Starting ${IV_PHASE_LABELS[phase]}…`);

    ivUnsubRef.current?.();
    ivUnsubRef.current = window.api.ivHistory.onProgress(evt => {
      setIvProgress(evt);
      const done = evt.processed + evt.skipped + evt.failed;
      if (evt.lastError) {
        appendLog(`✗ ${evt.ticker} — ${evt.lastError}`);
      } else if (done === 1 || done % 10 === 0) {
        const pct = evt.total > 0 ? Math.round(done / evt.total * 100) : 0;
        appendLog(`${evt.ticker} — ok:${evt.processed} skip:${evt.skipped} fail:${evt.failed} (${pct}%) ${evt.callsPerMin}/min`);
      }
    });

    try {
      const res = await window.api.ivHistory.startBackfill(phase);
      setIvResult(res);
      appendLog(`Done — ${res.processed} stored, ${res.skipped} skipped, ${res.failed} failed.`);
      await loadData();
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      appendLog(`Error: ${msg}`);
    } finally {
      setIvRunning(false);
      setActiveIvPhase(null);
      ivUnsubRef.current?.();
      ivUnsubRef.current = null;
    }
  };

  const cancelIv = async () => {
    appendLog('Cancelling IV load…');
    await window.api.ivHistory.cancel().catch(console.error);
  };

  // ─── Bulk price runner ────────────────────────────────────────────────────

  const startBulkPrice = async () => {
    setError(null);
    setBulkResult(null);
    setBulkProgress(null);
    setIvResult(null);
    setIvProgress(null);
    bulkCancelRef.current = false;
    setBulkRunning(true);

    const univLabel = bulkUniverse === 'both' ? 'S&P 500 + Russell 1000' : bulkUniverse === 'etf' ? 'ETFs' : bulkUniverse;
    appendLog(`Starting bulk price load — ${univLabel} · 2Y…`);

    try {
      const tickers = await window.api.historical.getUniverseTickers(bulkUniverse);
      appendLog(`${tickers.length} tickers to load.`);

      let stored = 0, failed = 0;
      for (const [i, ticker] of tickers.entries()) {
        if (bulkCancelRef.current) {
          appendLog('Cancelled by user.');
          break;
        }
        setBulkProgress({ done: i, total: tickers.length, ticker, stored, failed });

        try {
          const res = await window.api.historical.fetchPrices(ticker, '2Y');
          stored += res.count ?? 0;
          if ((i + 1) % 25 === 0 || i === tickers.length - 1) {
            const pct = Math.round((i + 1) / tickers.length * 100);
            appendLog(`${ticker} — ${i + 1}/${tickers.length} (${pct}%) · ${stored.toLocaleString()} bars stored`);
          }
        } catch {
          failed++;
          appendLog(`✗ ${ticker} — fetch failed`);
        }
      }

      const skipped = 0;
      setBulkResult({ stored, skipped, failed });
      appendLog(`Done — ${stored.toLocaleString()} bars stored, ${failed} failed.`);
      await loadData();
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      appendLog(`Error: ${msg}`);
    } finally {
      setBulkRunning(false);
      setBulkProgress(null);
    }
  };

  const cancelBulk = () => {
    bulkCancelRef.current = true;
    appendLog('Cancel requested…');
  };

  // ─── Ticker lookup ────────────────────────────────────────────────────────

  const fetchLookup = async () => {
    const t = lookupTicker.trim().toUpperCase();
    if (!t) return;
    setLookupLoading(true);
    setLookupRows(null);
    setLookupRank(null);
    setPriceRows(null);
    try {
      if (lookupMode === 'iv') {
        const [rows, rank] = await Promise.all([
          window.api.ivHistory.getRows(t),
          window.api.ivHistory.getRank(t),
        ]);
        setLookupRows(rows);
        setLookupRank(rank);
      } else {
        // Last 2 years for price spot-check
        const toDate  = new Date().toISOString().slice(0, 10);
        const fromDate = new Date(Date.now() - 730 * 86_400_000).toISOString().slice(0, 10);
        const rows = await window.api.historical.getPrices(t, fromDate, toDate);
        // Sort descending for easy spot-check (most recent first)
        setPriceRows([...rows].reverse());
      }
    } catch { /* silently ignore */ }
    finally { setLookupLoading(false); }
  };

  const clearLogs = () => setLogs([]);

  // ─── Derived progress values ──────────────────────────────────────────────

  const isRunning = ivRunning || bulkRunning;

  const progressPct = ivRunning && ivProgress && ivProgress.total > 0
    ? Math.round((ivProgress.processed + ivProgress.skipped + ivProgress.failed) / ivProgress.total * 100)
    : bulkRunning && bulkProgress && bulkProgress.total > 0
      ? Math.round((bulkProgress.done + 1) / bulkProgress.total * 100)
      : bulkResult || ivResult ? 100 : 0;

  const progressLabel = ivRunning && activeIvPhase
    ? IV_PHASE_LABELS[activeIvPhase]
    : bulkRunning ? 'Price History Bulk Load'
    : ivResult || bulkResult ? 'Last Run' : 'Progress';

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', gap: 20, padding: '20px 24px', height: '100%', boxSizing: 'border-box', fontFamily: 'inherit', minHeight: 0 }}>

      {/* ── Left column: controls ─────────────────────────────────────────── */}
      <div style={{ flex: '0 0 480px', display: 'flex', flexDirection: 'column', gap: 0, overflowY: 'auto' }}>

        <div style={{ marginBottom: 16 }}>
          <span style={{ fontSize: 20, fontWeight: 700, color: '#e0e0f0' }}>History</span>
          <span style={{ fontSize: 12, color: '#666', marginLeft: 10 }}>Initial bulk loads — IV &amp; price history</span>
        </div>

        {/* ── Section A: IV History ── */}
        <div style={{ fontSize: 11, fontWeight: 700, color: '#5a5a8a', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ flex: 1, height: 1, background: '#2a2a3e' }} />
          IV History
          <span style={{ flex: 1, height: 1, background: '#2a2a3e' }} />
        </div>

        {/* IVolatility key status */}
        <SectionCard title="IVolatility API Key">
          <div style={{ fontSize: 12, color: '#aaa', marginBottom: 6 }}>
            Status:{' '}
            {ivKeyConfigured
              ? <span style={{ color: '#4caf50' }}>Configured ✓</span>
              : <span style={{ color: '#ff9800' }}>Not configured — add key in <strong>Settings → API &amp; Data</strong></span>}
          </div>
          <div style={{ fontSize: 11, color: '#555' }}>
            IVolatility provides true as-of-date daily IVX snapshots (30-day CM ATM IV).
            One API call per ticker · rate limit: 1 req/sec · 20,000 req/month.
          </div>
        </SectionCard>

        {/* IV coverage */}
        <SectionCard title="IV Coverage">
          {ivCoverage ? (
            <>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                <CoverageCard label="Complete ≥252d" value={ivCoverage.complete} color="#4caf50" />
                <CoverageCard label="Partial 1–251d" value={ivCoverage.partial} color="#ff9800" />
                <CoverageCard label="No Data" value={ivCoverage.none} color="#ef5350" />
                <CoverageCard label="Total Rows" value={ivCoverage.totalReadings} color="#90caf9" />
              </div>
              {ivCoverage.lastRefreshDate && (
                <div style={{ fontSize: 11, color: '#666' }}>Last reading: {ivCoverage.lastRefreshDate}</div>
              )}
              {ivGaps && ivGaps.missingPairs > 0 && (
                <div style={{ fontSize: 11, color: '#ff9800', marginTop: 4 }}>
                  {ivGaps.missingPairs.toLocaleString()} gap pairs detected — run IV Gap Fill in Data Sync.
                </div>
              )}
              {ivGaps && ivGaps.missingPairs === 0 && (
                <div style={{ fontSize: 11, color: '#4caf50', marginTop: 4 }}>No gaps — IV history is up to date.</div>
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

        {/* IV initial load steps */}
        <SectionCard title="Initial Load — 252 trading days">
          {/* Step 1 */}
          <div style={{ padding: '10px 0', borderBottom: '1px solid #1e1e30' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#c8c8e0', marginBottom: 4 }}>Step 1 — S&amp;P 500 (~503 tickers)</div>
                {loadStatus && <StatusBadge complete={loadStatus.sp500.complete} completedAt={loadStatus.sp500.completedAt} />}
              </div>
              {ivRunning && activeIvPhase === 'initial_sp500' ? (
                <button onClick={cancelIv} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#7a2020', color: '#fff', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
              ) : (
                <button
                  onClick={() => startIvPhase('initial_sp500')}
                  disabled={isRunning || !ivKeyConfigured}
                  style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: ivKeyConfigured && !isRunning ? '#2a5a8a' : '#333', color: '#fff', fontSize: 12, cursor: isRunning || !ivKeyConfigured ? 'not-allowed' : 'pointer', opacity: isRunning || !ivKeyConfigured ? 0.5 : 1 }}
                >
                  {loadStatus?.sp500.complete ? 'Re-run' : 'Start'}
                </button>
              )}
            </div>
          </div>

          {/* Step 2 */}
          <div style={{ padding: '10px 0', borderBottom: '1px solid #1e1e30' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#c8c8e0', marginBottom: 2 }}>
                  Step 2 — Russell 1000{loadStatus?.russell.newTickers ? ` (~${loadStatus.russell.newTickers} unique)` : ''}
                </div>
                <div style={{ fontSize: 11, color: '#555', marginBottom: 4 }}>Skips tickers already loaded in Step 1</div>
                {loadStatus && <StatusBadge complete={loadStatus.russell.complete} completedAt={loadStatus.russell.completedAt} />}
              </div>
              {ivRunning && activeIvPhase === 'initial_russell' ? (
                <button onClick={cancelIv} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#7a2020', color: '#fff', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
              ) : (
                <button
                  onClick={() => startIvPhase('initial_russell')}
                  disabled={isRunning || !ivKeyConfigured}
                  style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: ivKeyConfigured && !isRunning ? '#2a5a8a' : '#333', color: '#fff', fontSize: 12, cursor: isRunning || !ivKeyConfigured ? 'not-allowed' : 'pointer', opacity: isRunning || !ivKeyConfigured ? 0.5 : 1 }}
                >
                  {loadStatus?.russell.complete ? 'Re-run' : 'Start'}
                </button>
              )}
            </div>
          </div>

          {/* Step 3 — ETF Universe */}
          <div style={{ padding: '10px 0 4px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#c8c8e0', marginBottom: 2 }}>
                  Step 3 — ETF Universe{loadStatus?.etf.totalTickers ? ` (${loadStatus.etf.totalTickers} tickers)` : ''}
                </div>
                <div style={{ fontSize: 11, color: '#555', marginBottom: 4 }}>Independent of Steps 1 & 2 — run any time</div>
                {loadStatus && <StatusBadge complete={loadStatus.etf.complete} completedAt={loadStatus.etf.completedAt} />}
              </div>
              {ivRunning && activeIvPhase === 'initial_etf' ? (
                <button onClick={cancelIv} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#7a2020', color: '#fff', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
              ) : (
                <button
                  onClick={() => startIvPhase('initial_etf')}
                  disabled={isRunning || !ivKeyConfigured}
                  style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: ivKeyConfigured && !isRunning ? '#2a5a8a' : '#333', color: '#fff', fontSize: 12, cursor: isRunning || !ivKeyConfigured ? 'not-allowed' : 'pointer', opacity: isRunning || !ivKeyConfigured ? 0.5 : 1 }}
                >
                  {loadStatus?.etf.complete ? 'Re-run' : 'Start'}
                </button>
              )}
            </div>
          </div>
        </SectionCard>

        {/* ── Section B: Price History ── */}
        <div style={{ fontSize: 11, fontWeight: 700, color: '#5a5a8a', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8, marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ flex: 1, height: 1, background: '#2a2a3e' }} />
          Price History
          <span style={{ flex: 1, height: 1, background: '#2a2a3e' }} />
        </div>

        <SectionCard title="Bulk Price Load — 2 Years Daily (Polygon)">
          <div style={{ fontSize: 12, color: '#888', marginBottom: 10 }}>
            Downloads 2 years of daily OHLCV bars for every ticker in the selected universe from Polygon.io.
            Required before running backtests. One API call per ticker — ~1,100 calls for Both.
          </div>

          {priceCoverage !== null && (
            <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
              <CoverageCard label="Tickers Loaded" value={priceCoverage} color="#90caf9" />
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            {(['sp500', 'russell1000', 'both', 'etf'] as const).map(u => (
              <button
                key={u}
                onClick={() => setBulkUniverse(u)}
                disabled={isRunning}
                style={{
                  padding: '5px 12px', borderRadius: 5, border: 'none', fontSize: 12, cursor: isRunning ? 'not-allowed' : 'pointer',
                  background: bulkUniverse === u ? '#2a5a8a' : '#1e1e30',
                  color: bulkUniverse === u ? '#fff' : '#888',
                }}
              >
                {u === 'sp500' ? 'S&P 500' : u === 'russell1000' ? 'Russell 1000' : u === 'both' ? 'Both' : 'ETFs'}
              </button>
            ))}
          </div>

          {bulkRunning ? (
            <button onClick={cancelBulk} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#7a2020', color: '#fff', fontSize: 12, cursor: 'pointer' }}>
              Cancel
            </button>
          ) : (
            <button
              onClick={startBulkPrice}
              disabled={isRunning}
              style={{ padding: '6px 20px', borderRadius: 6, border: 'none', background: isRunning ? '#333' : '#1a6a3a', color: '#fff', fontSize: 12, cursor: isRunning ? 'not-allowed' : 'pointer', opacity: isRunning ? 0.5 : 1 }}
            >
              {priceCoverage && priceCoverage > 0 ? '↻ Re-run Bulk Load' : '▶ Start Bulk Load'}
            </button>
          )}
          <div style={{ marginTop: 8, fontSize: 11, color: '#555' }}>
            Ongoing gap fill (daily refresh) lives in <strong style={{ color: '#7070a0' }}>Data Sync → section 5</strong>.
          </div>
        </SectionCard>

      </div>

      {/* ── Right column: progress + console + lookup ─────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>

        {/* Progress panel */}
        <div style={{ background: '#13131f', border: '1px solid #2a2a3e', borderRadius: 10, padding: '16px 20px', marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#9090b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {progressLabel}
            </span>
            {isRunning && <span style={{ fontSize: 11, color: '#ff9800' }}>● RUNNING</span>}
            {!isRunning && (ivResult || bulkResult) && <span style={{ fontSize: 11, color: '#4caf50' }}>● COMPLETE</span>}
            {!isRunning && error && <span style={{ fontSize: 11, color: '#ef5350' }}>● ERROR</span>}
          </div>

          <div style={{ background: '#1a1a2e', borderRadius: 6, height: 14, overflow: 'hidden', marginBottom: 8, border: '1px solid #2a2a3e' }}>
            <div style={{
              height: '100%',
              width: `${progressPct}%`,
              background: error ? '#ef5350' : (ivResult || bulkResult) && !isRunning ? '#4caf50' : '#3a8fd0',
              transition: 'width 0.4s ease',
              borderRadius: 6,
            }} />
          </div>

          <div style={{ display: 'flex', gap: 20, fontSize: 12, color: '#888', flexWrap: 'wrap' }}>
            {ivRunning && ivProgress ? (
              <>
                <span>Ticker: <strong style={{ color: '#e0e0f0' }}>{ivProgress.ticker}</strong></span>
                <span>{(ivProgress.processed + ivProgress.skipped + ivProgress.failed).toLocaleString()} / {ivProgress.total.toLocaleString()} <span style={{ color: '#777' }}>({progressPct}%)</span></span>
                <span>Stored: <strong style={{ color: '#4caf50' }}>{ivProgress.processed}</strong></span>
                <span>Skipped: <strong style={{ color: '#ff9800' }}>{ivProgress.skipped}</strong></span>
                <span>Failed: <strong style={{ color: '#ef5350' }}>{ivProgress.failed}</strong></span>
                <span>Rate: <strong style={{ color: '#90caf9' }}>{ivProgress.callsPerMin}/min</strong></span>
              </>
            ) : bulkRunning && bulkProgress ? (
              <>
                <span>Ticker: <strong style={{ color: '#e0e0f0' }}>{bulkProgress.ticker}</strong></span>
                <span>{(bulkProgress.done + 1).toLocaleString()} / {bulkProgress.total.toLocaleString()} <span style={{ color: '#777' }}>({progressPct}%)</span></span>
                <span>Bars stored: <strong style={{ color: '#4caf50' }}>{bulkProgress.stored.toLocaleString()}</strong></span>
                <span>Failed: <strong style={{ color: bulkProgress.failed > 0 ? '#ef5350' : '#888' }}>{bulkProgress.failed}</strong></span>
              </>
            ) : isRunning ? (
              <span style={{ color: '#ff9800' }}>Starting — waiting for first response…</span>
            ) : ivResult ? (
              <>
                <span>IV stored: <strong style={{ color: '#4caf50' }}>{ivResult.processed}</strong></span>
                <span>Skipped: <strong>{ivResult.skipped}</strong></span>
                <span>Failed: <strong style={{ color: ivResult.failed > 0 ? '#ef5350' : '#888' }}>{ivResult.failed}</strong></span>
              </>
            ) : bulkResult ? (
              <>
                <span>Bars stored: <strong style={{ color: '#4caf50' }}>{bulkResult.stored.toLocaleString()}</strong></span>
                <span>Failed: <strong style={{ color: bulkResult.failed > 0 ? '#ef5350' : '#888' }}>{bulkResult.failed}</strong></span>
              </>
            ) : error ? (
              <span style={{ color: '#ef5350' }}>{error}</span>
            ) : (
              <span style={{ color: '#444' }}>No run in progress.</span>
            )}
          </div>
        </div>

        {/* Console */}
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
                  color: line.includes('Error') || line.includes('fail') || line.includes('✗') ? '#ef9a9a'
                       : line.includes('Done') || line.includes('Configured') ? '#a5d6a7'
                       : line.includes('Cancel') ? '#ff9800'
                       : '#a0c0a0',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                }}>{line}</div>
              ))
            )}
          </div>
        </div>

        {/* Ticker lookup — IV + Price */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#13131f', border: '1px solid #2a2a3e', borderRadius: 10, overflow: 'hidden', minHeight: 0, marginTop: 12 }}>

          {/* Search bar */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid #1e1e30', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: '#6060a0', textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>Lookup</span>

            {/* Mode toggle */}
            {(['iv', 'price'] as const).map(m => (
              <button
                key={m}
                onClick={() => { setLookupMode(m); setLookupRows(null); setPriceRows(null); setLookupRank(null); }}
                style={{
                  padding: '3px 10px', borderRadius: 4, border: 'none', fontSize: 11, cursor: 'pointer',
                  background: lookupMode === m ? '#2a5a8a' : '#1e1e30',
                  color: lookupMode === m ? '#fff' : '#666',
                }}
              >
                {m === 'iv' ? 'IV History' : 'Price History'}
              </button>
            ))}

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

            {/* IV summary */}
            {lookupMode === 'iv' && lookupRank && lookupRows !== null && lookupRows.length > 0 && (
              <div style={{ display: 'flex', gap: 14, fontSize: 12, color: '#888' }}>
                <span>{lookupRows.length} rows</span>
                {lookupRank.currentIv !== null && <span>IV: <strong style={{ color: '#e0e0f0' }}>{lookupRank.currentIv.toFixed(1)}%</strong></span>}
                {lookupRank.ivRank !== null && <span>Rank: <strong style={{ color: '#fab387' }}>{lookupRank.ivRank.toFixed(1)}%</strong></span>}
                {lookupRank.ivPercentile !== null && <span>Pct: <strong style={{ color: '#89b4fa' }}>{lookupRank.ivPercentile.toFixed(1)}%</strong></span>}
              </div>
            )}

            {/* Price summary */}
            {lookupMode === 'price' && priceRows !== null && priceRows.length > 0 && (
              <div style={{ display: 'flex', gap: 14, fontSize: 12, color: '#888' }}>
                <span>{priceRows.length} bars</span>
                <span>Latest: <strong style={{ color: '#e0e0f0' }}>{priceRows[0]?.date ?? '—'}</strong></span>
                <span>Close: <strong style={{ color: '#4caf50' }}>${priceRows[0]?.close.toFixed(2) ?? '—'}</strong></span>
              </div>
            )}

            {/* No data messages */}
            {lookupMode === 'iv' && lookupRows !== null && lookupRows.length === 0 && (
              <span style={{ fontSize: 12, color: '#ff9800' }}>No IV data stored for {lookupTicker}</span>
            )}
            {lookupMode === 'price' && priceRows !== null && priceRows.length === 0 && (
              <span style={{ fontSize: 12, color: '#ff9800' }}>No price history stored for {lookupTicker}</span>
            )}
          </div>

          {/* IV table */}
          {lookupMode === 'iv' && lookupRows && lookupRows.length > 0 && (
            <div style={{ flex: 1, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead style={{ position: 'sticky', top: 0, background: '#13131f', zIndex: 1 }}>
                  <tr style={{ color: '#6c7086', borderBottom: '1px solid #2a2a3e' }}>
                    <th style={{ textAlign: 'left', padding: '6px 14px', fontWeight: 600 }}>#</th>
                    <th style={{ textAlign: 'left', padding: '6px 14px', fontWeight: 600 }}>Date</th>
                    <th style={{ textAlign: 'right', padding: '6px 14px', fontWeight: 600 }}>IV30</th>
                    <th style={{ textAlign: 'right', padding: '6px 14px', fontWeight: 600 }}>Stock Px</th>
                    <th style={{ textAlign: 'left', padding: '6px 14px', fontWeight: 600 }}>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {lookupRows.map((row, i) => {
                    const ivPct = row.atm_iv;
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

          {/* Price table */}
          {lookupMode === 'price' && priceRows && priceRows.length > 0 && (
            <div style={{ flex: 1, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead style={{ position: 'sticky', top: 0, background: '#13131f', zIndex: 1 }}>
                  <tr style={{ color: '#6c7086', borderBottom: '1px solid #2a2a3e' }}>
                    <th style={{ textAlign: 'left', padding: '6px 14px', fontWeight: 600 }}>Date</th>
                    <th style={{ textAlign: 'right', padding: '6px 14px', fontWeight: 600 }}>Open</th>
                    <th style={{ textAlign: 'right', padding: '6px 14px', fontWeight: 600 }}>High</th>
                    <th style={{ textAlign: 'right', padding: '6px 14px', fontWeight: 600 }}>Low</th>
                    <th style={{ textAlign: 'right', padding: '6px 14px', fontWeight: 600 }}>Close</th>
                    <th style={{ textAlign: 'right', padding: '6px 14px', fontWeight: 600 }}>Volume</th>
                    <th style={{ textAlign: 'right', padding: '6px 14px', fontWeight: 600 }}>Adj</th>
                  </tr>
                </thead>
                <tbody>
                  {priceRows.map((row, i) => (
                    <tr key={row.date} style={{ borderBottom: '1px solid #1a1a2e', background: i % 2 === 0 ? 'transparent' : '#0e0e1a' }}>
                      <td style={{ padding: '4px 14px', fontFamily: 'monospace', color: '#cdd6f4' }}>{row.date}</td>
                      <td style={{ padding: '4px 14px', textAlign: 'right', fontFamily: 'monospace', color: '#888' }}>{row.open.toFixed(2)}</td>
                      <td style={{ padding: '4px 14px', textAlign: 'right', fontFamily: 'monospace', color: '#4caf50' }}>{row.high.toFixed(2)}</td>
                      <td style={{ padding: '4px 14px', textAlign: 'right', fontFamily: 'monospace', color: '#ef5350' }}>{row.low.toFixed(2)}</td>
                      <td style={{ padding: '4px 14px', textAlign: 'right', fontFamily: 'monospace', color: '#e0e0f0', fontWeight: 600 }}>{row.close.toFixed(2)}</td>
                      <td style={{ padding: '4px 14px', textAlign: 'right', fontFamily: 'monospace', color: '#666' }}>{(row.volume / 1_000_000).toFixed(2)}M</td>
                      <td style={{ padding: '4px 14px', textAlign: 'right', fontFamily: 'monospace', color: '#555' }}>{row.adjustedClose !== null ? row.adjustedClose.toFixed(2) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Empty state */}
          {((lookupMode === 'iv' && !lookupRows) || (lookupMode === 'price' && !priceRows)) && (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#333', fontSize: 12 }}>
              Enter a symbol above to spot-check stored {lookupMode === 'iv' ? 'IV' : 'price'} history
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Backward-compatible alias (App.tsx imports IvHistoryView by name)
export { HistoryView as IvHistoryView };
