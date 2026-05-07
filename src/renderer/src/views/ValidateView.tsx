// ValidateView — FR-4: Per-stock validation dashboard with candlestick chart.
// Left pane: watchlist selector + ticker list with verdict badges.
// Right pane: 5-section dashboard (exec summary, market opinion, trend, chart, indicators).
// see SPEC: FR-4
// Chart: lightweight-charts v4

import { useCallback, useEffect, useRef, useState } from 'react';
import { createChart, type IChartApi, ColorType, type Time } from 'lightweight-charts';
import { VolumeProfile, type BarDataWithVolume } from './VolumeProfile';
import type {
  Watchlist,
  ValidateDashboardResult
} from '@shared/types.js';

// `window.api` is declared once in `src/renderer/src/global.d.ts`.

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtPrice(v: number | null): string {
  return v === null ? '—' : `$${v.toFixed(2)}`;
}
function fmtPct(v: number | null): string {
  return v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}
function fmtNum(v: number | null, decimals = 2): string {
  if (v === null) return '—';
  return v.toLocaleString(undefined, { maximumFractionDigits: decimals });
}

/** Render a tiny SVG sparkline for EPS history. */
function EPSSparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const W = 80, H = 24;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * W;
    const y = H - ((v - min) / range) * H;
    return `${x},${y}`;
  });
  const polyline = pts.join(' ');
  const lastPt = pts[pts.length - 1]!.split(',');
  const lastX = parseFloat(lastPt[0]!);
  const lastY = parseFloat(lastPt[1]!);
  const isUp = values[values.length - 1]! >= values[0]!;
  return (
    <svg width={W} height={H} style={{ display: 'block' }}>
      <polyline
        points={polyline}
        fill="none"
        stroke={isUp ? '#3fb950' : '#f85149'}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx={lastX} cy={lastY} r="2" fill={isUp ? '#3fb950' : '#f85149'} />
    </svg>
  );
}

const VERDICT_COLORS = {
  Strong: '#3fb950',
  Acceptable: '#8b949e',
  Caution: '#d29922',
  Avoid: '#f85149'
} as const;

const VERDICT_BG = {
  Strong: 'rgba(63,185,80,0.15)',
  Acceptable: 'rgba(139,148,158,0.15)',
  Caution: 'rgba(210,153,34,0.15)',
  Avoid: 'rgba(248,81,73,0.15)'
} as const;

const BADGE_COLORS = {
  BUY: '#3fb950',
  HOLD: '#8b949e',
  SELL: '#f85149'
} as const;

interface TimeframeOption { label: string; days: number }

const TIMEFRAMES: TimeframeOption[] = [
  { label: '1M', days: 30 },
  { label: '3M', days: 90 },
  { label: '6M', days: 180 },
  { label: '1Y', days: 365 },
  { label: '5Y', days: 1825 }
];

// ─── Component ────────────────────────────────────────────────────────────────

export function ValidateView() {
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [selectedWatchlistId, setSelectedWatchlistId] = useState<number | null>(null);
  const [tickers, setTickers] = useState<string[]>([]);
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [result, setResult] = useState<ValidateDashboardResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timeframe, setTimeframe] = useState<TimeframeOption>({ label: '6M', days: 180 });
  const [isValidatingAll, setIsValidatingAll] = useState(false);
  const [validateProgress, setValidateProgress] = useState<{ done: number; total: number } | null>(null);

  // Load watchlists on mount.
  useEffect(() => {
    window.api.watchlists.list()
      .then(setWatchlists)
      .catch((e) => setError((e as Error).message));
  }, []);

  // Load tickers when watchlist changes.
  useEffect(() => {
    if (!selectedWatchlistId) { setTickers([]); setSelectedTicker(null); return; }
    window.api.validate.getTickers(selectedWatchlistId)
      .then(setTickers)
      .catch(() => setTickers([]));
  }, [selectedWatchlistId]);

  // Load validate result when ticker changes.
  const loadTicker = useCallback(async (ticker: string) => {
    setLoading(true);
    setError(null);
    setResult(null);
    setSelectedTicker(ticker);
    try {
      const data = await window.api.validate.openTickerById({ ticker });
      setResult(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Refresh current ticker.
  const refreshTicker = useCallback(async () => {
    if (!selectedTicker) return;
    await loadTicker(selectedTicker);
  }, [selectedTicker, loadTicker]);

  // Validate all.
  const runValidateAll = useCallback(async () => {
    if (!selectedWatchlistId) return;
    setIsValidatingAll(true);
    setError(null);
    setValidateProgress({ done: 0, total: tickers.length });
    try {
      await window.api.validate.runValidateAll(selectedWatchlistId);
      // After run, refresh tickers (they now have cached results)
      const updated = await window.api.validate.getTickers(selectedWatchlistId);
      setTickers(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsValidatingAll(false);
      setValidateProgress(null);
    }
  }, [selectedWatchlistId, tickers.length]);

  const cancelValidateAll = useCallback(async () => {
    await window.api.validate.cancel();
    setIsValidatingAll(false);
    setValidateProgress(null);
  }, []);

  // ── Chart ──────────────────────────────────────────────────────────────────

  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const markerLayerRef = useRef<HTMLDivElement | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  // Track current result/timeframe for pattern zone re-render
  const patternResultRef = useRef<ValidateDashboardResult | null>(null);
  const patternTimeframeRef = useRef<TimeframeOption | null>(null);

  useEffect(() => {
    if (!chartContainerRef.current || !result) return;

    const bars = result.chart.bars;
    if (!bars.length) return;

    // Filter bars by timeframe.
    const now = Date.now();
    const cutoff = now - timeframe.days * 86_400_000;
    const filteredBars = bars.filter(b => b.t >= cutoff);

    // Destroy old chart.
    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }

    // Create the marker overlay layer (HTML div for pattern + zone callouts).
    // It sits in the same container as the chart canvas so it inherits position context.
    const markerLayer = document.createElement('div');
    markerLayer.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;overflow:hidden;';
    // We'll append it after the chart canvas.

    const container = chartContainerRef.current;

    const chart = createChart(container, {
      width: container.clientWidth,
      height: Math.max(300, container.clientHeight),
      layout: {
        background: { type: ColorType.Solid, color: '#0d1117' },
        textColor: '#8b949e'
      },
      grid: {
        vertLines: { color: '#1c2128' },
        horzLines: { color: '#1c2128' }
      },
      crosshair: {
        mode: 1
      },
      timeScale: {
        borderColor: '#30363d',
        timeVisible: true
      },
      rightPriceScale: {
        borderColor: '#30363d'
      }
    });

    // Candlestick series.
    const candleSeries = chart.addCandlestickSeries({
      upColor: '#3fb950',
      downColor: '#f85149',
      borderUpColor: '#3fb950',
      borderDownColor: '#f85149',
      wickUpColor: '#3fb950',
      wickDownColor: '#f85149'
    });
    candleSeries.setData(filteredBars.map(b => ({
      time: (b.t / 1000) as import('lightweight-charts').Time,
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      // @ts-expect-error volume is not a standard part of CandlestickData
      volume: b.v
    })));

    // Volume profile primitive.
    const volumeProfile = new VolumeProfile(filteredBars.map(b => ({
      time: (b.t / 1000) as Time,
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: b.v
    })), { binSize: 0.5 });
    candleSeries.attachPrimitive(volumeProfile);

    // Volume series.
    const volumeSeries = chart.addHistogramSeries({
      color: '#58a6ff',
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume'
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    volumeSeries.setData(filteredBars.map(b => ({
      time: (b.t / 1000) as import('lightweight-charts').Time,
      value: b.v,
      color: b.c >= b.o ? 'rgba(63,185,80,0.4)' : 'rgba(248,81,73,0.4)'
    })));

    // Helper to add a line series overlay.
    const addLineSeries = (data: { time: import('lightweight-charts').Time; value: number }[], color: string, lineW = 1, style = 0) => {
      const s = chart.addLineSeries({ color, lineWidth: lineW as import('lightweight-charts').LineWidth, lineStyle: style as import('lightweight-charts').LineStyle, priceLineVisible: false });
      s.setData(data);
      return s;
    };

    
    // Entry zone — shaded price band using two horizontal lines.
    if (result.chart.entryZoneLow !== null && result.chart.entryZoneHigh !== null) {
      const entryTopData = filteredBars.map(b => ({
        time: (b.t / 1000) as import('lightweight-charts').Time,
        value: result.chart.entryZoneHigh!
      }));
      const entryBotData = filteredBars.map(b => ({
        time: (b.t / 1000) as import('lightweight-charts').Time,
        value: result.chart.entryZoneLow!
      }));
      const entryTopSeries = addLineSeries(entryTopData, 'rgba(63,185,80,0.35)', 1);
      const entryBotSeries = addLineSeries(entryBotData, 'rgba(63,185,80,0.35)', 1);
      void entryTopSeries; void entryBotSeries;
    }

    // Target line.
    if (result.chart.target !== null) {
      const targetData = filteredBars.map(b => ({
        time: (b.t / 1000) as import('lightweight-charts').Time,
        value: result.chart.target!
      }));
      const targetSeries = addLineSeries(targetData, '#d29922', 1, 2); // dashed amber
      void targetSeries;
    }

    // Stop loss line.
    if (result.chart.stopLoss !== null) {
      const stopData = filteredBars.map(b => ({
        time: (b.t / 1000) as import('lightweight-charts').Time,
        value: result.chart.stopLoss!
      }));
      const stopSeries = addLineSeries(stopData, '#f85149', 1, 2); // dashed red
      void stopSeries;
    }

    // Support/resistance zones.
    for (const zone of result.chart.supportZones) {
      const zoneData = filteredBars.map(b => ({
        time: (b.t / 1000) as import('lightweight-charts').Time,
        value: zone.price
      }));
      const zoneColor = zone.type === 'demand' ? '#3fb950' : '#f85149';
      const zoneStyle = zone.type === 'demand' ? 3 : 2; // dotted for demand, dashed for supply
      const zoneSeries = addLineSeries(zoneData, zoneColor, 1, zoneStyle);
      void zoneSeries;
    }

    // Append marker layer on top of chart canvas.
    container.style.position = 'relative';
    container.appendChild(markerLayer);
    markerLayerRef.current = markerLayer;

    // ── Render HTML callouts (patterns + zones) ───────────────────────────────
    const renderCallouts = () => {
      if (!markerLayerRef.current || !chartRef.current) return;
      markerLayerRef.current.innerHTML = '';

      const chartApi = chartRef.current;
      const chartWidth = chartApi.options().width ?? 800;

      const timeScale = chartApi.timeScale();

      // Filter patterns that fall within the visible timeframe window.
      const visiblePatterns = result.chart.patterns.filter(p => {
        const bar = result.chart.bars[p.barIndex];
        return bar !== undefined && bar.t >= cutoff;
      });

      // Pattern callouts.
      for (const pattern of visiblePatterns) {
        const bar = result.chart.bars[pattern.barIndex]!;
        const barIndexInFiltered = filteredBars.findIndex(b => b.t === bar.t);
        if (barIndexInFiltered < 0) continue;

        // Get the logical location for this bar's time.
        const timeCoord = timeScale.timeToCoordinate(bar.t / 1000 as import('lightweight-charts').Time);
        if (timeCoord === null) continue;

        // Get the bar's high price as the Y anchor (priceToCoordinate lives on ISeriesApi).
        const priceCoord = candleSeries.priceToCoordinate(bar.h);
        if (priceCoord === null) continue;

        const label = pattern.name.replace(/_/g, ' ');
        const bgColor = pattern.direction === 'bullish' ? 'rgba(63,185,80,0.85)'
          : pattern.direction === 'bearish' ? 'rgba(248,81,73,0.85)' : 'rgba(139,148,158,0.85)';
        const borderColor = pattern.direction === 'bullish' ? '#3fb950'
          : pattern.direction === 'bearish' ? '#f85149' : '#8b949e';

        // Position label to the right of the bar, clamped within chart bounds.
        const labelX = Math.min(timeCoord + 8, chartWidth - 120);
        const labelY = Math.max(priceCoord - 12, 4);

        const el = document.createElement('div');
        el.textContent = label;
        el.style.cssText = `
          position:absolute;
          left:${labelX}px;
          top:${labelY}px;
          background:${bgColor};
          border:1px solid ${borderColor};
          color:#fff;
          font-size:10px;
          padding:2px 5px;
          border-radius:3px;
          white-space:nowrap;
          pointer-events:none;
          z-index:10;
          text-transform:capitalize;
        `;
        markerLayerRef.current!.appendChild(el);
      }

      // Zone labels on the right edge.
      for (const zone of result.chart.supportZones) {
        const priceCoord = candleSeries.priceToCoordinate(zone.price);
        if (priceCoord === null) continue;

        const color = zone.type === 'demand' ? '#3fb950' : '#f85149';
        const label = zone.type === 'demand' ? 'DEMAND' : 'SUPPLY';
        const barY = Math.max(priceCoord - 10, 4);

        const el = document.createElement('div');
        el.textContent = `${label} $${zone.price.toFixed(2)}`;
        el.style.cssText = `
          position:absolute;
          right:4px;
          top:${barY}px;
          background:${color}22;
          border:1px solid ${color};
          color:${color};
          font-size:10px;
          font-family:monospace;
          padding:1px 4px;
          border-radius:3px;
          pointer-events:none;
          z-index:10;
        `;
        markerLayerRef.current!.appendChild(el);
      }
    };

    // Wait for chart to finish rendering, then place HTML callouts.
    // Use a small timeout to let the chart lay out internally.
    const timerId = setTimeout(renderCallouts, 80);

    // Also re-render callouts when the visible range changes.
    const calloutHandler = () => { setTimeout(renderCallouts, 30); };
    chart.timeScale().subscribeVisibleLogicalRangeChange(calloutHandler);

    // Store refs for cleanup.
    chartRef.current = chart;
    patternResultRef.current = result;
    patternTimeframeRef.current = timeframe;

    // Resize observer.
    const ro = new ResizeObserver(() => {
      if (chartRef.current && chartContainerRef.current) {
        chartRef.current.applyOptions({
          width: chartContainerRef.current.clientWidth
        });
        setTimeout(renderCallouts, 50);
      }
    });
    ro.observe(container);
    resizeObserverRef.current = ro;

    return () => {
      clearTimeout(timerId);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(calloutHandler);
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      markerLayerRef.current = null;
    };
  }, [result, timeframe]);

  return (
    <div className="validate-view">
      {error && (
        <div className="error-toast" onClick={() => setError(null)}>
          {error} <span style={{ float: 'right', cursor: 'pointer' }}>✕</span>
        </div>
      )}

      <div className="validate-layout">
        {/* ── Left: ticker list ── */}
        <aside className="validate-ticker-list">
          <div className="validate-list-header">
            <h3>Validate</h3>
            <select
              value={selectedWatchlistId ?? ''}
              onChange={(e) => setSelectedWatchlistId(e.target.value ? Number(e.target.value) : null)}
              style={{ width: '100%', padding: 4, fontSize: 11 }}
            >
              <option value="">— Select watchlist —</option>
              {watchlists.map((w) => (
                <option key={w.id} value={w.id}>{w.name} ({w.itemCount})</option>
              ))}
            </select>
          </div>

          {tickers.length > 0 && (
            <div className="validate-actions">
              {isValidatingAll ? (
                <div>
                  <div className="progress-bar-wrap">
                    <div
                      className="progress-bar-fill"
                      style={{ width: `${validateProgress ? (validateProgress.done / Math.max(validateProgress.total, 1)) * 100 : 0}%` }}
                    />
                  </div>
                  <span className="meta" style={{ display: 'block', marginTop: 4 }}>
                    {validateProgress?.done}/{validateProgress?.total}
                  </span>
                  <button onClick={cancelValidateAll} className="cancel-btn" style={{ marginTop: 4 }}>
                    ■ Stop
                  </button>
                </div>
              ) : (
                <button onClick={runValidateAll} className="run-btn" style={{ width: '100%' }}>
                  ▶ Validate All
                </button>
              )}
            </div>
          )}

          <ul className="ticker-list">
            {tickers.map((ticker) => (
              <li
                key={ticker}
                className={`ticker-item ${selectedTicker === ticker ? 'active' : ''}`}
                onClick={() => loadTicker(ticker)}
              >
                <span className="ticker-symbol">{ticker}</span>
                <span className="verdict-dot" title="Refresh to load verdict" />
              </li>
            ))}
          </ul>
          {tickers.length === 0 && (
            <div className="empty-hint">Select a watchlist to see tickers.</div>
          )}
        </aside>

        {/* ── Right: dashboard ── */}
        <main className="validate-dashboard">
          {!selectedTicker && !loading && (
            <div className="empty-state">
              <p>Select a ticker from the list to load the validation dashboard.</p>
            </div>
          )}

          {loading && (
            <div className="empty-state">
              <div className="spinner" />
              <p>Loading {selectedTicker}…</p>
            </div>
          )}

          {result && !loading && (
            <>
              {/* ── Section A: Executive Summary ── */}
              <div className="section-card section-a">
                <div className="section-header">
                  <span
                    className="verdict-badge"
                    style={{
                      background: VERDICT_BG[result.verdict],
                      color: VERDICT_COLORS[result.verdict],
                      borderColor: VERDICT_COLORS[result.verdict]
                    }}
                  >
                    {result.verdict}
                  </span>
                  <h2>{result.ticker}</h2>
                  <button onClick={refreshTicker} className="tiny-btn" style={{ marginLeft: 8 }}>
                    ↻ Refresh
                  </button>
                  {result.fetchedAt && (
                    <span className="meta" style={{ marginLeft: 8 }}>
                      Updated {new Date(result.fetchedAt).toLocaleTimeString()}
                    </span>
                  )}
                </div>
                <p className="verdict-reason">{result.verdictReason || 'No verdict reason.'}</p>
                <div className="fundamentals-grid">
                  <div className="fund-item">
                    <span className="fund-label">P/E</span>
                    <span className="fund-value">{fmtNum(result.fundamentals.peRatio, 1)}</span>
                  </div>
                  <div className="fund-item">
                    <span className="fund-label">EPS</span>
                    <span className="fund-value">{fmtNum(result.fundamentals.eps, 2)}</span>
                  </div>
                  <div className="fund-item">
                    <span className="fund-label">Rev Growth</span>
                    <span className="fund-value">{fmtPct(result.fundamentals.revenueGrowth)}</span>
                  </div>
                  <div className="fund-item">
                    <span className="fund-label">Margin</span>
                    <span className="fund-value">{fmtPct(result.fundamentals.profitMargin)}</span>
                  </div>
                  <div className="fund-item">
                    <span className="fund-label">D/E</span>
                    <span className="fund-value">{fmtNum(result.fundamentals.debtToEquity, 2)}</span>
                  </div>
                  <div className="fund-item">
                    <span className="fund-label">ROE</span>
                    <span className="fund-value">{fmtPct(result.fundamentals.roe)}</span>
                  </div>
                </div>
                {result.fundamentals.daysToEarnings !== null && result.fundamentals.daysToEarnings <= 14 && (
                  <div className="warning-banner">
                    ⚠ Earnings in {result.fundamentals.daysToEarnings} days — {result.fundamentals.nextEarningsDate ?? 'date unknown'}
                  </div>
                )}
                {result.fundamentals.epsHistory.length > 1 && (
                  <div className="eps-history-row">
                    <span className="fund-label">EPS History</span>
                    <EPSSparkline values={result.fundamentals.epsHistory} />
                  </div>
                )}
              </div>

              {/* ── Section B: Market Opinion ── */}
              <div className="section-card section-b">
                <h3>Market Opinion</h3>
                <div className="opinion-row">
                  {result.marketOpinion.badge && (
                    <span
                      className="opinion-badge"
                      style={{
                        background: `${BADGE_COLORS[result.marketOpinion.badge]}22`,
                        color: BADGE_COLORS[result.marketOpinion.badge],
                        borderColor: BADGE_COLORS[result.marketOpinion.badge]
                      }}
                    >
                      {result.marketOpinion.badge}
                    </span>
                  )}
                  <div className="analyst-counts">
                    {result.marketOpinion.buyCount !== null && (
                      <span style={{ color: '#3fb950' }}>Buy {result.marketOpinion.buyCount}</span>
                    )}
                    {result.marketOpinion.holdCount !== null && (
                      <span style={{ color: '#8b949e', marginLeft: 12 }}>Hold {result.marketOpinion.holdCount}</span>
                    )}
                    {result.marketOpinion.sellCount !== null && (
                      <span style={{ color: '#f85149', marginLeft: 12 }}>Sell {result.marketOpinion.sellCount}</span>
                    )}
                  </div>
                  {result.marketOpinion.avgPriceTarget !== null && (
                    <div style={{ marginLeft: 16 }}>
                      <span className="meta">Price target: </span>
                      <span>{fmtPrice(result.marketOpinion.avgPriceTarget)}</span>
                      {result.marketOpinion.upsidePct !== null && (
                        <span className="meta" style={{ marginLeft: 4 }}>({fmtPct(result.marketOpinion.upsidePct)})</span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* ── Section C: Trend ── */}
              <div className="section-card section-c">
                <h3>Trend</h3>
                <div className="trend-row">
                  <span
                    className="trend-label"
                    style={{
                      color: result.trend.label === 'Bullish' ? '#3fb950'
                        : result.trend.label === 'Bearish' ? '#f85149' : '#8b949e'
                    }}
                  >
                    {result.trend.label}
                  </span>
                  {result.trend.adx !== null && (
                    <span className="adx-chip">ADX {fmtNum(result.trend.adx, 1)}</span>
                  )}
                  <div className="sma-stack">
                    {result.trend.smaStack.sma20 !== null && (
                      <span className="sma-chip sma20">SMA20 {fmtPrice(result.trend.smaStack.sma20)}</span>
                    )}
                    {result.trend.smaStack.sma50 !== null && (
                      <span className="sma-chip sma50">SMA50 {fmtPrice(result.trend.smaStack.sma50)}</span>
                    )}
                    {result.trend.smaStack.sma200 !== null && (
                      <span className="sma-chip sma200">SMA200 {fmtPrice(result.trend.smaStack.sma200)}</span>
                    )}
                  </div>
                  {result.trend.priceVsSma50 !== null && (
                    <span className="meta" style={{ marginLeft: 8 }}>
                      {result.trend.priceVsSma50 >= 0 ? '+' : ''}{fmtPct(result.trend.priceVsSma50)} vs SMA50
                    </span>
                  )}
                </div>
              </div>

              {/* ── Section D: Candlestick Chart ── */}
              <div className="section-card section-d">
                <div className="chart-header">
                  <h3>Chart</h3>
                  <div className="timeframe-btns">
                    {TIMEFRAMES.map((tf) => (
                      <button
                        key={tf.label}
                        className={`tiny-btn ${timeframe.label === tf.label ? 'active' : ''}`}
                        onClick={() => setTimeframe(tf)}
                      >
                        {tf.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="chart-container" ref={chartContainerRef} />
                {result.chart.patterns.length > 0 && (
                  <div className="pattern-callouts">
                    {result.chart.patterns.map((p, i) => (
                      <span key={i} className={`pattern-chip ${p.direction}`}>
                        {p.name.replace(/_/g, ' ')}
                      </span>
                    ))}
                  </div>
                )}
                <div className="chart-legend">
                  <span className="legend-item sma20">— SMA20</span>
                  <span className="legend-item sma50">— SMA50</span>
                  <span className="legend-item sma200">— SMA200</span>
                  {result.chart.entryZoneLow !== null && (
                    <span className="legend-item entry-zone">■ Entry Zone</span>
                  )}
                  {result.chart.stopLoss !== null && (
                    <span className="legend-item stop">-- Stop Loss</span>
                  )}
                  {result.chart.target !== null && (
                    <span className="legend-item" style={{ color: '#d29922' }}>-- Target</span>
                  )}
                  {result.chart.supportZones.some(z => z.type === 'demand') && (
                    <span className="legend-item" style={{ color: '#3fb950' }}>:.. Demand Zone</span>
                  )}
                  {result.chart.supportZones.some(z => z.type === 'supply') && (
                    <span className="legend-item" style={{ color: '#f85149' }}>:.. Supply Zone</span>
                  )}
                </div>
              </div>

              {/* ── Section E: Other Indicators ── */}
              <div className="section-card section-e">
                <h3>Indicators</h3>
                <div className="indicator-grid">
                  <div className="indicator-card">
                    <span className="ind-label">RSI(14)</span>
                    <span className={`ind-value ${(result.indicators.rsi ?? 50) > 70 ? 'overbought' : (result.indicators.rsi ?? 50) < 30 ? 'oversold' : ''}`}>
                      {fmtNum(result.indicators.rsi, 1)}
                    </span>
                    {result.indicators.rsi !== null && (
                      <span className="ind-badge">
                        {result.indicators.rsi > 70 ? 'OB' : result.indicators.rsi < 30 ? 'OS' : ''}
                      </span>
                    )}
                  </div>
                  <div className="indicator-card">
                    <span className="ind-label">MACD</span>
                    <span className="ind-value">
                      {result.indicators.macdValue !== null ? fmtNum(result.indicators.macdValue, 2) : '—'}
                      {result.indicators.macdSignal !== null && (
                        <span className="meta"> (sig {fmtNum(result.indicators.macdSignal, 2)})</span>
                      )}
                    </span>
                  </div>
                  <div className="indicator-card">
                    <span className="ind-label">BB Position</span>
                    <span className="ind-value">{fmtNum(result.indicators.bollingerPosition, 0)}%</span>
                  </div>
                  <div className="indicator-card">
                    <span className="ind-label">Volume vs Avg</span>
                    <span
                      className={`ind-value ${(result.indicators.volumeAnomalyPct ?? 0) > 20 ? 'high-vol' : ''}`}
                    >
                      {fmtPct(result.indicators.volumeAnomalyPct)}
                    </span>
                  </div>
                  <div className="indicator-card">
                    <span className="ind-label">IV</span>
                    <span className="ind-value">
                      {result.ivData.currentIv !== null ? `${result.ivData.currentIv.toFixed(0)}%` : '—'}
                    </span>
                    {result.ivData.iv52WkLow !== null && result.ivData.iv52WkHigh !== null && (
                      <span className="meta">
                        (range {result.ivData.iv52WkLow.toFixed(0)}–{result.ivData.iv52WkHigh.toFixed(0)}%)
                      </span>
                    )}
                  </div>
                  <div className="indicator-card">
                    <span className="ind-label">IV Rank</span>
                    <span className="ind-value">{fmtNum(result.ivData.ivRank, 0)}%</span>
                  </div>
                </div>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
