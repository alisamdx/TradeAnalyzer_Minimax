// IV History management screen — initial backfill, gap fill, coverage summary, token config.
// see docs/formulas.md#iv-history

import { useState, useEffect, useRef, useCallback } from 'react';
import type { IvHistoryCoverage, IvHistoryGapSummary, IvHistoryProgressEvent } from '@shared/types.js';

type Phase = 'initial_sp500' | 'initial_russell' | 'gap_fill';

interface InitialLoadStatus {
  sp500:   { complete: boolean; completedAt: string | null };
  russell: { complete: boolean; completedAt: string | null; newTickers: number };
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function CoverageCard({ label, value, color }: { label: string; value: number | null; color: string }) {
  return (
    <div style={{ background: '#1a1a2e', border: `1px solid ${color}44`, borderRadius: 8, padding: '12px 20px', minWidth: 110, textAlign: 'center' }}>
      <div style={{ fontSize: 28, fontWeight: 700, color }}>{value ?? '—'}</div>
      <div style={{ fontSize: 12, color: '#aaa', marginTop: 2 }}>{label}</div>
    </div>
  );
}

function StatusBadge({ complete, completedAt }: { complete: boolean; completedAt: string | null }) {
  if (complete) {
    return <span style={{ background: '#1a3a1a', color: '#4caf50', border: '1px solid #4caf5044', borderRadius: 4, padding: '2px 10px', fontSize: 12 }}>Complete {completedAt ? `(${completedAt})` : ''}</span>;
  }
  return <span style={{ background: '#2a1a1a', color: '#ff9800', border: '1px solid #ff980044', borderRadius: 4, padding: '2px 10px', fontSize: 12 }}>Not complete</span>;
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: '#13131f', border: '1px solid #2a2a3e', borderRadius: 10, padding: '20px 24px', marginBottom: 20 }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: '#c8c8e0', marginBottom: 14 }}>{title}</div>
      {children}
    </div>
  );
}

// ─── Main view ─────────────────────────────────────────────────────────────────

export function IvHistoryView() {
  const [tokenInput, setTokenInput]           = useState('');
  const [tokenConfigured, setTokenConfigured] = useState(false);
  const [tokenSaving, setTokenSaving]         = useState(false);
  const [tokenMsg, setTokenMsg]               = useState<string | null>(null);

  const [coverage, setCoverage]               = useState<IvHistoryCoverage | null>(null);
  const [gaps, setGaps]                       = useState<IvHistoryGapSummary | null>(null);
  const [loadStatus, setLoadStatus]           = useState<InitialLoadStatus | null>(null);

  const [running, setRunning]                 = useState(false);
  const [activePhase, setActivePhase]         = useState<Phase | null>(null);
  const [progress, setProgress]               = useState<IvHistoryProgressEvent | null>(null);
  const [result, setResult]                   = useState<{ processed: number; skipped: number; failed: number } | null>(null);
  const [error, setError]                     = useState<string | null>(null);

  const unsubRef = useRef<(() => void) | null>(null);

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
    window.api.ivHistory.getTokenConfigured().then(setTokenConfigured).catch(console.error);
    loadData();
    return () => { unsubRef.current?.(); };
  }, [loadData]);

  const saveToken = async () => {
    if (!tokenInput.trim()) return;
    setTokenSaving(true);
    setTokenMsg(null);
    try {
      await window.api.ivHistory.saveToken(tokenInput.trim());
      setTokenConfigured(true);
      setTokenInput('');
      setTokenMsg('Token saved successfully.');
    } catch (e) {
      setTokenMsg(`Failed to save token: ${(e as Error).message}`);
    } finally {
      setTokenSaving(false);
    }
  };

  const startPhase = async (phase: Phase) => {
    setError(null);
    setResult(null);
    setProgress(null);
    setRunning(true);
    setActivePhase(phase);

    unsubRef.current?.();
    unsubRef.current = window.api.ivHistory.onProgress(evt => {
      setProgress(evt);
    });

    try {
      const res = await window.api.ivHistory.startBackfill(phase);
      setResult(res);
      await loadData();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
      setActivePhase(null);
      unsubRef.current?.();
      unsubRef.current = null;
    }
  };

  const cancel = async () => {
    await window.api.ivHistory.cancel().catch(console.error);
  };

  const progressPct = progress && progress.total > 0
    ? Math.round((progress.processed + progress.skipped + progress.failed) / progress.total * 100)
    : 0;

  const PHASE_LABELS: Record<Phase, string> = {
    initial_sp500:   'S&P 500 Initial Load',
    initial_russell: 'Russell 1000 Initial Load',
    gap_fill:        'Gap Fill',
  };

  return (
    <div style={{ padding: '24px 28px', maxWidth: 860, fontFamily: 'inherit' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <span style={{ fontSize: 22, fontWeight: 700, color: '#e0e0f0' }}>IV History</span>
        <span style={{ fontSize: 13, color: '#888', marginTop: 3 }}>30-day ATM IV • 252 trading days • true IV rank/percentile</span>
      </div>

      {/* ── Token Configuration ───────────────────────────────────────────── */}
      <SectionCard title="MarketData.app API Token">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, color: '#aaa', marginRight: 4 }}>
            Status: {tokenConfigured
              ? <span style={{ color: '#4caf50' }}>Configured</span>
              : <span style={{ color: '#ff9800' }}>Not configured — required for backfill and gap fill</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            type="password"
            placeholder="Paste MarketData.app API token…"
            value={tokenInput}
            onChange={e => setTokenInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && saveToken()}
            style={{ flex: 1, minWidth: 280, padding: '7px 12px', borderRadius: 6, border: '1px solid #3a3a5e', background: '#1a1a2e', color: '#e0e0f0', fontSize: 13 }}
          />
          <button
            onClick={saveToken}
            disabled={tokenSaving || !tokenInput.trim()}
            style={{ padding: '7px 18px', borderRadius: 6, border: 'none', background: '#3a5fb0', color: '#fff', fontSize: 13, cursor: 'pointer', opacity: tokenSaving || !tokenInput.trim() ? 0.5 : 1 }}
          >
            {tokenSaving ? 'Saving…' : 'Save Token'}
          </button>
        </div>
        {tokenMsg && <div style={{ marginTop: 8, fontSize: 13, color: tokenMsg.startsWith('Failed') ? '#ef5350' : '#4caf50' }}>{tokenMsg}</div>}
        <div style={{ marginTop: 10, fontSize: 12, color: '#666' }}>
          Trader trial: ~100k credits/day (use for initial S&P 500 + Russell backfill). Starter ($12/mo): ~10k/day (for weekly gap fills).
        </div>
      </SectionCard>

      {/* ── Coverage Summary ──────────────────────────────────────────────── */}
      <SectionCard title="Coverage Summary (S&P 500 + Russell 1000)">
        {coverage ? (
          <>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 12 }}>
              <CoverageCard label="Complete (≥252)" value={coverage.complete} color="#4caf50" />
              <CoverageCard label="Partial (1–251)" value={coverage.partial} color="#ff9800" />
              <CoverageCard label="No Data" value={coverage.none} color="#ef5350" />
              <CoverageCard label="Total Readings" value={coverage.totalReadings} color="#90caf9" />
            </div>
            {coverage.lastRefreshDate && (
              <div style={{ fontSize: 12, color: '#777' }}>Last reading: {coverage.lastRefreshDate}</div>
            )}
          </>
        ) : (
          <div style={{ fontSize: 13, color: '#666' }}>Loading…</div>
        )}
        <button
          onClick={loadData}
          style={{ marginTop: 10, padding: '5px 14px', borderRadius: 6, border: '1px solid #3a3a5e', background: 'transparent', color: '#aaa', fontSize: 12, cursor: 'pointer' }}
        >
          Refresh
        </button>
      </SectionCard>

      {/* ── Initial Load ──────────────────────────────────────────────────── */}
      <SectionCard title="Initial Load">
        <div style={{ fontSize: 12, color: '#777', marginBottom: 14 }}>
          Run once using your MarketData.app Trader trial to backfill 252 trading days of IV history.
          Requires ~126,000 API credits for S&P 500 and ~125,000 for unique Russell tickers.
        </div>

        {/* Step 1: S&P 500 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, padding: '12px 0', borderBottom: '1px solid #1e1e30' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#c8c8e0' }}>Step 1 — S&P 500 (~503 tickers)</div>
            <div style={{ marginTop: 4 }}>
              {loadStatus && <StatusBadge complete={loadStatus.sp500.complete} completedAt={loadStatus.sp500.completedAt} />}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {running && activePhase === 'initial_sp500' ? (
              <button onClick={cancel} style={{ padding: '7px 18px', borderRadius: 6, border: 'none', background: '#7a2020', color: '#fff', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
            ) : (
              <button
                onClick={() => startPhase('initial_sp500')}
                disabled={running || !tokenConfigured}
                style={{ padding: '7px 18px', borderRadius: 6, border: 'none', background: tokenConfigured ? '#2a5a8a' : '#333', color: '#fff', fontSize: 13, cursor: running || !tokenConfigured ? 'not-allowed' : 'pointer', opacity: running || !tokenConfigured ? 0.6 : 1 }}
              >
                {loadStatus?.sp500.complete ? 'Re-run' : 'Start'}
              </button>
            )}
          </div>
        </div>

        {/* Step 2: Russell 1000 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, padding: '12px 0 4px' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#c8c8e0' }}>
              Step 2 — Russell 1000 unique tickers
              {loadStatus?.russell.newTickers ? ` (~${loadStatus.russell.newTickers} not in S&P 500)` : ''}
            </div>
            <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>Skips tickers already covered by Step 1</div>
            <div style={{ marginTop: 4 }}>
              {loadStatus && <StatusBadge complete={loadStatus.russell.complete} completedAt={loadStatus.russell.completedAt} />}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {running && activePhase === 'initial_russell' ? (
              <button onClick={cancel} style={{ padding: '7px 18px', borderRadius: 6, border: 'none', background: '#7a2020', color: '#fff', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
            ) : (
              <button
                onClick={() => startPhase('initial_russell')}
                disabled={running || !tokenConfigured}
                style={{ padding: '7px 18px', borderRadius: 6, border: 'none', background: tokenConfigured ? '#2a5a8a' : '#333', color: '#fff', fontSize: 13, cursor: running || !tokenConfigured ? 'not-allowed' : 'pointer', opacity: running || !tokenConfigured ? 0.6 : 1 }}
              >
                {loadStatus?.russell.complete ? 'Re-run' : 'Start'}
              </button>
            )}
          </div>
        </div>
      </SectionCard>

      {/* ── Ongoing Refresh (Gap Fill) ────────────────────────────────────── */}
      <SectionCard title="Ongoing Refresh — Gap Fill">
        <div style={{ fontSize: 12, color: '#777', marginBottom: 12 }}>
          Fills missing trading days since the last reading. Run weekly with your MarketData.app Starter subscription.
          E*Trade auto-capture stores today's IV automatically whenever you open an options chain — no API credits consumed.
        </div>
        {gaps ? (
          <div style={{ fontSize: 13, color: '#c8c8e0', marginBottom: 12 }}>
            {gaps.missingPairs === 0
              ? <span style={{ color: '#4caf50' }}>No gaps detected — coverage is up to date.</span>
              : <>
                  <span style={{ color: '#ff9800' }}>{gaps.missingPairs.toLocaleString()} missing (ticker, date) pairs</span>
                  {' '}across {gaps.missingDays.toLocaleString()} trading days
                  {gaps.oldestGapDate && ` (${gaps.oldestGapDate} → ${gaps.newestGapDate})`}.
                  {' '}Estimated {gaps.estimatedCalls.toLocaleString()} API calls.
                </>
            }
          </div>
        ) : (
          <div style={{ fontSize: 13, color: '#666', marginBottom: 12 }}>Loading gap summary…</div>
        )}
        {running && activePhase === 'gap_fill' ? (
          <button onClick={cancel} style={{ padding: '7px 18px', borderRadius: 6, border: 'none', background: '#7a2020', color: '#fff', fontSize: 13, cursor: 'pointer' }}>Cancel Gap Fill</button>
        ) : (
          <button
            onClick={() => startPhase('gap_fill')}
            disabled={running || !tokenConfigured || gaps?.missingPairs === 0}
            style={{ padding: '7px 18px', borderRadius: 6, border: 'none', background: tokenConfigured && gaps?.missingPairs ? '#2a5a8a' : '#333', color: '#fff', fontSize: 13, cursor: 'pointer', opacity: running || !tokenConfigured || gaps?.missingPairs === 0 ? 0.5 : 1 }}
          >
            Start Gap Fill
          </button>
        )}
      </SectionCard>

      {/* ── Progress Panel ─────────────────────────────────────────────────── */}
      {(running || result || error) && (
        <SectionCard title={running ? `Running: ${activePhase ? PHASE_LABELS[activePhase] : '…'}` : 'Last Run Result'}>
          {running && progress && (
            <>
              <div style={{ display: 'flex', gap: 24, fontSize: 13, color: '#aaa', marginBottom: 10, flexWrap: 'wrap' }}>
                <span>Ticker: <strong style={{ color: '#e0e0f0' }}>{progress.ticker}</strong></span>
                <span>Date: <strong style={{ color: '#e0e0f0' }}>{progress.date}</strong></span>
                <span>Processed: <strong style={{ color: '#4caf50' }}>{progress.processed}</strong></span>
                <span>Skipped: <strong style={{ color: '#ff9800' }}>{progress.skipped}</strong></span>
                <span>Failed: <strong style={{ color: '#ef5350' }}>{progress.failed}</strong></span>
                <span>Rate: <strong style={{ color: '#90caf9' }}>{progress.callsPerMin}/min</strong></span>
              </div>
              <div style={{ background: '#1a1a2e', borderRadius: 6, height: 12, overflow: 'hidden', marginBottom: 6 }}>
                <div style={{ height: '100%', width: `${progressPct}%`, background: '#3a8fd0', transition: 'width 0.3s ease', borderRadius: 6 }} />
              </div>
              <div style={{ fontSize: 12, color: '#777' }}>
                {progress.processed + progress.skipped + progress.failed} / {progress.total} ({progressPct}%)
              </div>
            </>
          )}
          {!running && result && (
            <div style={{ fontSize: 13, color: '#c8c8e0' }}>
              Done — <span style={{ color: '#4caf50' }}>{result.processed} stored</span>, {result.skipped} skipped, {result.failed} failed.
            </div>
          )}
          {!running && error && (
            <div style={{ fontSize: 13, color: '#ef5350' }}>Error: {error}</div>
          )}
        </SectionCard>
      )}
    </div>
  );
}
