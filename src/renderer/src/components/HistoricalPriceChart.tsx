// HistoricalPriceChart - Line chart with OHLCV and SMA overlay
// Supports multiple timeframes: 1M, 3M, 6M, 1Y, 2Y, 5Y
// see SPEC: FR-4 Historical Charts

import { useEffect, useState, useCallback } from 'react';
import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer
} from 'recharts';

interface PriceDataPoint {
  ticker: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adjustedClose: number | null;
  sma50: number | null;
}

interface ChartDataPoint {
  date: string;
  label: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  sma50: number | null;
}

type TimeRange = '1M' | '3M' | '6M' | '1Y' | '2Y' | '5Y';

interface HistoricalPriceChartProps {
  ticker: string;
}

const TIME_RANGES: { key: TimeRange; label: string; days: number }[] = [
  { key: '1M', label: '1 Month', days: 30 },
  { key: '3M', label: '3 Months', days: 90 },
  { key: '6M', label: '6 Months', days: 180 },
  { key: '1Y', label: '1 Year', days: 365 },
  { key: '2Y', label: '2 Years', days: 730 },
  { key: '5Y', label: '5 Years', days: 1825 }
];

function formatPrice(value: number | null): string {
  if (value === null) return '—';
  return `$${value.toFixed(2)}`;
}

function formatVolume(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return value.toString();
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
}

export function HistoricalPriceChart({ ticker }: HistoricalPriceChartProps) {
  const [data, setData] = useState<ChartDataPoint[]>([]);
  const [timeRange, setTimeRange] = useState<TimeRange>('1Y');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<{ high: number; low: number; avgVolume: number } | null>(null);

  const loadData = useCallback(async () => {
    if (!ticker) return;

    setLoading(true);
    setError(null);

    try {
      // Check if we need to fetch fresh data
      const needsFetch = await window.api.historical.needsRefresh(ticker, 'prices', 7);

      if (needsFetch) {
        await window.api.historical.fetchPrices(ticker, timeRange);
      }

      const prices = await window.api.historical.getPricesWithSMA(ticker, timeRange);

      // Transform data for chart
      const chartData: ChartDataPoint[] = prices.map(p => ({
        date: p.date,
        label: formatDate(p.date),
        open: p.open,
        high: p.high,
        low: p.low,
        close: p.close,
        volume: p.volume,
        sma50: p.sma50
      }));

      setData(chartData);

      // Calculate stats
      if (chartData.length > 0) {
        const high = Math.max(...chartData.map(d => d.high));
        const low = Math.min(...chartData.map(d => d.low));
        const avgVolume = chartData.reduce((sum, d) => sum + d.volume, 0) / chartData.length;
        setStats({ high, low, avgVolume });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [ticker, timeRange]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const exportCsv = useCallback(() => {
    if (data.length === 0) return;

    const header = 'Date,Open,High,Low,Close,Volume,SMA50\n';
    const rows = data.map(d =>
      `${d.date},${d.open},${d.high},${d.low},${d.close},${d.volume},${d.sma50 ?? ''}`
    ).join('\n');
    const csv = header + rows;

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${ticker}_prices_${timeRange}_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [data, ticker, timeRange]);

  const lastData = data.length > 0 ? data[data.length - 1] : null;
  const firstData = data.length > 0 ? data[0] : null;
  const currentPrice = lastData?.close ?? null;
  const priceChange = (currentPrice !== null && firstData) ? currentPrice - firstData.close : 0;
  const priceChangePct = (priceChange !== 0 && firstData) ? (priceChange / firstData.close) * 100 : 0;

  return (
    <div className="historical-chart-container">
      <div className="chart-header">
        <div>
          <h4>{ticker}</h4>
          {currentPrice !== null && (
            <span className={`price-tag ${priceChange >= 0 ? 'positive' : 'negative'}`}>
              {formatPrice(currentPrice)}
              {' '}
              ({priceChange >= 0 ? '+' : ''}{priceChangePct.toFixed(2)}%)
            </span>
          )}
        </div>
        <div className="chart-controls">
          {TIME_RANGES.map(range => (
            <button
              key={range.key}
              className={`range-btn ${timeRange === range.key ? 'active' : ''}`}
              onClick={() => setTimeRange(range.key)}
            >
              {range.label}
            </button>
          ))}
          <button onClick={loadData} className="refresh-btn" disabled={loading}>
            {loading ? '...' : '↻'}
          </button>
          <button onClick={exportCsv} className="export-btn" disabled={data.length === 0}>
            Export CSV
          </button>
        </div>
      </div>

      {stats && (
        <div className="chart-stats">
          <span>High: {formatPrice(stats.high)}</span>
          <span>Low: {formatPrice(stats.low)}</span>
          <span>Avg Vol: {formatVolume(stats.avgVolume)}</span>
        </div>
      )}

      {error && (
        <div className="chart-error">
          {error}
        </div>
      )}

      {loading && data.length === 0 && (
        <div className="chart-loading">
          Loading price data...
        </div>
      )}

      {!loading && data.length === 0 && !error && (
        <div className="chart-empty">
          No price data available for {ticker}
        </div>
      )}

      {data.length > 0 && (
        <div className="chart-body" style={{ height: 350 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11 }}
                tickMargin={10}
                interval="preserveStartEnd"
                minTickGap={30}
              />
              <YAxis
                yAxisId="price"
                domain={['auto', 'auto']}
                tick={{ fontSize: 11 }}
                tickFormatter={(val) => `$${val.toFixed(0)}`}
                width={60}
              />
              <YAxis
                yAxisId="volume"
                orientation="right"
                tick={{ fontSize: 10 }}
                tickFormatter={(val) => formatVolume(val)}
                width={60}
              />
              <Tooltip
                content={({ active, payload }) => {
                  const firstPayload = payload?.[0]?.payload;
                  if (!active || !firstPayload) return null;

                  const data = firstPayload as ChartDataPoint;
                  return (
                    <div className="custom-tooltip" style={{
                      background: 'white',
                      padding: '8px 12px',
                      border: '1px solid #ddd',
                      borderRadius: 4,
                      fontSize: 12
                    }}>
                      <div style={{ fontWeight: 'bold', marginBottom: 4 }}>{data.date}</div>
                      <div>Open: {formatPrice(data.open)}</div>
                      <div>High: {formatPrice(data.high)}</div>
                      <div>Low: {formatPrice(data.low)}</div>
                      <div>Close: {formatPrice(data.close)}</div>
                      <div>Volume: {formatVolume(data.volume)}</div>
                      {data.sma50 && <div>SMA50: {formatPrice(data.sma50)}</div>}
                    </div>
                  );
                }}
              />
              {/* Volume bars as area */}
              <Line
                yAxisId="volume"
                type="monotone"
                dataKey="volume"
                stroke="#3498db"
                strokeWidth={1}
                dot={false}
                opacity={0.3}
              />
              {/* Price line */}
              <Line
                yAxisId="price"
                type="monotone"
                dataKey="close"
                stroke="#2c3e50"
                strokeWidth={2}
                dot={false}
                name="Close"
              />
              {/* SMA 50 */}
              <Line
                yAxisId="price"
                type="monotone"
                dataKey="sma50"
                stroke="#e74c3c"
                strokeWidth={1.5}
                dot={false}
                strokeDasharray="5 5"
                name="SMA 50"
                connectNulls={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

export default HistoricalPriceChart;
