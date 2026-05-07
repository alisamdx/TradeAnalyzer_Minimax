// HistoricalFinancialChart - Area chart for financial metrics
// Supports quarterly/annual data with multiple metrics
// see SPEC: FR-4 Historical Charts

import { useEffect, useState, useCallback } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer
} from 'recharts';

interface FinancialDataPoint {
  ticker: string;
  filingDate: string;
  periodType: 'quarterly' | 'annual';
  periodEndDate: string;
  revenues: number | null;
  netIncome: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  earningsPerShare: number | null;
  sharesOutstanding: number | null;
  totalAssets: number | null;
  totalLiabilities: number | null;
  shareholdersEquity: number | null;
  longTermDebt: number | null;
  currentAssets: number | null;
  currentLiabilities: number | null;
  operatingCashFlow: number | null;
  freeCashFlow: number | null;
  ebitda: number | null;
}

type MetricKey = 'revenues' | 'netIncome' | 'grossProfit' | 'operatingIncome' |
  'earningsPerShare' | 'totalAssets' | 'shareholdersEquity' | 'freeCashFlow' | 'ebitda';

interface ChartDataPoint {
  date: string;
  label: string;
  value: number;
  [key: string]: string | number;
}

interface HistoricalFinancialChartProps {
  ticker: string;
}

const METRICS: { key: MetricKey; label: string; color: string; format: 'currency' | 'number' | 'perShare' }[] = [
  { key: 'revenues', label: 'Revenue', color: '#3498db', format: 'currency' },
  { key: 'netIncome', label: 'Net Income', color: '#2ecc71', format: 'currency' },
  { key: 'grossProfit', label: 'Gross Profit', color: '#9b59b6', format: 'currency' },
  { key: 'operatingIncome', label: 'Operating Income', color: '#e67e22', format: 'currency' },
  { key: 'earningsPerShare', label: 'EPS', color: '#e74c3c', format: 'perShare' },
  { key: 'totalAssets', label: 'Total Assets', color: '#1abc9c', format: 'currency' },
  { key: 'shareholdersEquity', label: 'Shareholders Equity', color: '#f39c12', format: 'currency' },
  { key: 'freeCashFlow', label: 'Free Cash Flow', color: '#34495e', format: 'currency' },
  { key: 'ebitda', label: 'EBITDA', color: '#16a085', format: 'currency' }
];

function formatValue(value: number | null, format: 'currency' | 'number' | 'perShare'): string {
  if (value === null) return '—';

  if (format === 'perShare') {
    return `$${value.toFixed(2)}`;
  }

  // Large number formatting (B/M/K)
  const absVal = Math.abs(value);
  if (absVal >= 1e12) {
    return `$${(value / 1e12).toFixed(2)}T`;
  } else if (absVal >= 1e9) {
    return `$${(value / 1e9).toFixed(2)}B`;
  } else if (absVal >= 1e6) {
    return `$${(value / 1e6).toFixed(2)}M`;
  } else if (absVal >= 1e3) {
    return `$${(value / 1e3).toFixed(2)}K`;
  }
  return `$${value.toFixed(0)}`;
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function HistoricalFinancialChart({ ticker }: HistoricalFinancialChartProps) {
  const [data, setData] = useState<ChartDataPoint[]>([]);
  const [periodType, setPeriodType] = useState<'quarterly' | 'annual'>('quarterly');
  const [selectedMetric, setSelectedMetric] = useState<MetricKey>('revenues');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const metric = METRICS.find(m => m.key === selectedMetric)!;

  const loadData = useCallback(async () => {
    if (!ticker) return;

    setLoading(true);
    setError(null);

    try {
      // Check if we need to fetch fresh data
      const needsFetch = await window.api.historical.needsRefresh(ticker, 'financials', 30);

      if (needsFetch) {
        await window.api.historical.fetchFinancials(ticker, periodType);
      }

      const financials = await window.api.historical.getFinancials(ticker, periodType, 20);

      // Transform data for chart
      const chartData: ChartDataPoint[] = financials.map(f => ({
        date: f.periodEndDate,
        label: formatDate(f.periodEndDate),
        value: f[selectedMetric] ?? 0
      })).filter(d => d.value !== 0);

      setData(chartData);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [ticker, periodType, selectedMetric]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const exportCsv = useCallback(() => {
    if (data.length === 0) return;

    const header = 'Date,Value\n';
    const rows = data.map(d => `${d.date},${d.value}`).join('\n');
    const csv = header + rows;

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${ticker}_financials_${selectedMetric}_${periodType}_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [data, ticker, selectedMetric, periodType]);

  return (
    <div className="historical-chart-container">
      <div className="chart-header">
        <h4>{ticker} - {metric.label}</h4>
        <div className="chart-controls">
          <select
            value={periodType}
            onChange={(e) => setPeriodType(e.target.value as 'quarterly' | 'annual')}
            className="period-selector"
          >
            <option value="quarterly">Quarterly</option>
            <option value="annual">Annual</option>
          </select>
          <select
            value={selectedMetric}
            onChange={(e) => setSelectedMetric(e.target.value as MetricKey)}
            className="metric-selector"
          >
            {METRICS.map(m => (
              <option key={m.key} value={m.key}>{m.label}</option>
            ))}
          </select>
          <button onClick={loadData} className="refresh-btn" disabled={loading}>
            {loading ? '...' : '↻'}
          </button>
          <button onClick={exportCsv} className="export-btn" disabled={data.length === 0}>
            Export CSV
          </button>
        </div>
      </div>

      {error && (
        <div className="chart-error">
          {error}
        </div>
      )}

      {loading && data.length === 0 && (
        <div className="chart-loading">
          Loading financial data...
        </div>
      )}

      {!loading && data.length === 0 && !error && (
        <div className="chart-empty">
          No financial data available for {ticker}
        </div>
      )}

      {data.length > 0 && (
        <div className="chart-body" style={{ height: 300 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={`color${selectedMetric}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={metric.color} stopOpacity={0.3}/>
                  <stop offset="95%" stopColor={metric.color} stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 12 }}
                tickMargin={10}
              />
              <YAxis
                tick={{ fontSize: 12 }}
                tickFormatter={(val) => formatValue(val, metric.format)}
                width={80}
              />
              <Tooltip
                formatter={(value) => {
                  const numValue = typeof value === 'number' ? value : null;
                  return [formatValue(numValue, metric.format), metric.label];
                }}
                labelFormatter={(label) => `Period: ${label}`}
                contentStyle={{ borderRadius: 4, border: '1px solid #ddd' }}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke={metric.color}
                fill={`url(#color${selectedMetric})`}
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

export default HistoricalFinancialChart;
