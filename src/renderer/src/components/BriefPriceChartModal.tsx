// BriefPriceChartModal — 45-day candlestick popup for a Brief Trend pick.
// Shows price from the brief date through the 45-day options window.
// Overlays: brief price dashed line, 'Brief' arrowUp marker, 'D5' arrowDown marker.
// Dismiss: Escape key or click outside the card.

import { useEffect, useRef, useState } from 'react';
import { createChart, type IChartApi, ColorType, LineStyle } from 'lightweight-charts';
import type { BriefPickDetail } from '@shared/types.js';

function fmtPrice(n: number | null): string {
  if (n === null) return '—';
  return '$' + n.toFixed(2);
}

interface Props {
  pick: BriefPickDetail;
  briefDate: string;
  onClose: () => void;
}

export default function BriefPriceChartModal({ pick, briefDate, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError  ] = useState<string | null>(null);

  // Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Fetch + build chart
  useEffect(() => {
    let cancelled = false;

    const toDate = new Date(
      new Date(briefDate + 'T12:00:00Z').getTime() + 45 * 24 * 60 * 60 * 1000
    ).toISOString().slice(0, 10);

    window.api.historical.getPrices(pick.ticker, briefDate, toDate)
      .then(rawBars => {
        if (cancelled || !containerRef.current) return;

        const el = containerRef.current;
        const chart = createChart(el, {
          width:  el.getBoundingClientRect().width || 660,
          height: 310,
          layout: {
            background: { type: ColorType.Solid, color: '#0d1117' },
            textColor:  '#8b949e',
          },
          grid: {
            vertLines: { color: '#21262d' },
            horzLines: { color: '#21262d' },
          },
          crosshair:       { mode: 1 },
          timeScale:       { borderColor: '#30363d', timeVisible: false },
          rightPriceScale: { borderColor: '#30363d' },
        });
        chartRef.current = chart;

        if (rawBars.length < 2) {
          setError('Not enough price data for this ticker and date range.');
          chart.remove();
          chartRef.current = null;
          setLoading(false);
          return;
        }

        const candleSeries = chart.addCandlestickSeries({
          upColor:        '#3fb950',
          downColor:      '#f85149',
          borderUpColor:  '#3fb950',
          borderDownColor:'#f85149',
          wickUpColor:    '#3fb950',
          wickDownColor:  '#f85149',
        });

        candleSeries.setData(rawBars.map(b => ({
          time:  b.date as import('lightweight-charts').Time,
          open:  b.open,
          high:  b.high,
          low:   b.low,
          close: b.close,
        })));

        // Brief price reference line (dashed blue)
        if (pick.briefPrice !== null) {
          candleSeries.createPriceLine({
            price:            pick.briefPrice,
            color:            '#388bfd',
            lineWidth:        1,
            lineStyle:        LineStyle.Dashed,
            axisLabelVisible: true,
            title:            'Brief',
          });
        }

        // Markers: 'Brief' on the first bar (brief date), 'D5' on the 6th bar (Day 5)
        type Marker = import('lightweight-charts').SeriesMarker<import('lightweight-charts').Time>;
        const markers: Marker[] = [];

        if (rawBars[0]) {
          markers.push({
            time:     rawBars[0].date as import('lightweight-charts').Time,
            position: 'belowBar',
            color:    '#388bfd',
            shape:    'arrowUp',
            text:     'Brief',
          });
        }

        // Day 5 = 5th trading day after brief date = rawBars index 5 (index 0 is brief date)
        if (rawBars.length >= 6 && pick.day5Price !== null && rawBars[5]) {
          markers.push({
            time:     rawBars[5].date as import('lightweight-charts').Time,
            position: 'aboveBar',
            color:    '#8b949e',
            shape:    'arrowDown',
            text:     'D5',
          });
        }

        if (markers.length > 0) candleSeries.setMarkers(markers);

        chart.timeScale().fitContent();
        setLoading(false);
      })
      .catch(err => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load chart data.');
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      chartRef.current?.remove();
      chartRef.current = null;
    };
  }, [pick.ticker, briefDate, pick.briefPrice, pick.day5Price]);

  const toDateLabel = new Date(
    new Date(briefDate + 'T12:00:00Z').getTime() + 45 * 24 * 60 * 60 * 1000
  ).toISOString().slice(0, 10);

  return (
    <div
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.78)',
        zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: '#0d1117',
          border: '1px solid #30363d',
          borderRadius: 10,
          padding: '18px 22px 14px',
          width: 720, maxWidth: '95vw',
          boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 20, color: '#58a6ff' }}>
              {pick.ticker}
            </span>
            <span style={{ color: '#8b949e', fontSize: 13 }}>
              {briefDate} → {toDateLabel}
            </span>
            {pick.briefPrice !== null && (
              <span style={{ color: '#388bfd', fontSize: 12 }}>
                brief @ {fmtPrice(pick.briefPrice)}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            title="Close (Esc)"
            style={{
              background: 'none', border: 'none', color: '#8b949e',
              fontSize: 20, cursor: 'pointer', lineHeight: 1, padding: '0 4px',
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>

        {/* Chart area */}
        <div style={{ position: 'relative', height: 310 }}>
          <div ref={containerRef} style={{ width: '100%', height: 310 }} />
          {loading && (
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: '#0d1117', color: '#8b949e', fontSize: 13,
            }}>
              Loading…
            </div>
          )}
          {error && (
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: '#0d1117', color: '#f85149', fontSize: 13,
            }}>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          marginTop: 8,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          color: '#6e7681', fontSize: 11,
        }}>
          <span>
            45-day options window · blue dashed = brief price · click outside or Esc to close
          </span>
          {pick.returnPct !== null && (
            <span>
              5-day return:{' '}
              <span style={{
                fontWeight: 600,
                color: pick.returnPct >= 0 ? '#3fb950' : '#f85149',
              }}>
                {pick.returnPct >= 0 ? '+' : ''}{pick.returnPct.toFixed(1)}%
              </span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
