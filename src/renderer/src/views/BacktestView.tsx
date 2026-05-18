import { useState, useEffect, useCallback, useRef } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine
} from 'recharts';
import type {
  BacktestConfig, BacktestRun, BacktestMetrics, BacktestTrade, BacktestProgressEvent
} from '@shared/types.js';

type BacktestStrategy = 'CSP' | 'CC' | 'Wheel';
type Panel = 'new' | 'run';

const DEFAULT_FORM: Omit<BacktestConfig, 'id' | 'createdAt'> = {
  name: '',
  strategy: 'CSP',
  ticker: '',
  startDate: '2022-01-01',
  endDate: new Date().toISOString().slice(0, 10),
  startingCapital: 10000,
  dteTarget: 30,
  deltaTarget: 0.30,
  profitTargetPct: 50,
  stopLossPct: 200
};

function fmt$(n: number | null, decimals = 0): string {
  if (n === null || n === undefined) return '—';
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return (n < 0 ? '-$' : '$') + formatted;
}
function fmtPct(n: number | null, decimals = 1): string {
  if (n === null || n === undefined) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(decimals) + '%';
}
function fmtNum(n: number | null, decimals = 2): string {
  if (n === null || n === undefined) return '—';
  return n.toFixed(decimals);
}

// ─── Metric Card ────────────────────────────────────────────────────────────

function MetricCard({ label, value, sub, positive }: { label: string; value: string; sub?: string; positive?: boolean | null }) {
  const cls = positive === true ? 'bt-metric-positive' : positive === false ? 'bt-metric-negative' : '';
  return (
    <div className={`bt-metric-card ${cls}`}>
      <div className="bt-metric-label">{label}</div>
      <div className="bt-metric-value">{value}</div>
      {sub && <div className="bt-metric-sub">{sub}</div>}
    </div>
  );
}

// ─── Trade Table ─────────────────────────────────────────────────────────────

function TradeTable({ trades }: { trades: BacktestTrade[] }) {
  const [page, setPage] = useState(0);
  const pageSize = 20;
  const total = trades.length;
  const slice = trades.slice(page * pageSize, (page + 1) * pageSize);

  return (
    <div className="bt-trades">
      <div className="bt-trades-header">
        <span>Trade Log ({total} trades)</span>
        <div className="bt-pagination">
          <button disabled={page === 0} onClick={() => setPage(p => p - 1)}>◀</button>
          <span>{page + 1} / {Math.ceil(total / pageSize)}</span>
          <button disabled={(page + 1) * pageSize >= total} onClick={() => setPage(p => p + 1)}>▶</button>
        </div>
      </div>
      <table className="bt-trade-table">
        <thead>
          <tr>
            <th>Entry</th><th>Exp.</th><th>Side</th><th>Strike</th>
            <th>Prem.</th><th>Exit</th><th>Exit Reason</th><th>P&L</th>
          </tr>
        </thead>
        <tbody>
          {slice.map(t => (
            <tr key={t.id} className={t.pnl !== null && t.pnl > 0 ? 'bt-trade-win' : 'bt-trade-loss'}>
              <td>{t.entryDate}</td>
              <td>{t.expiration}</td>
              <td className={t.side === 'put' ? 'bt-put' : 'bt-call'}>{t.side.toUpperCase()}</td>
              <td>{fmt$(t.strike, 2)}</td>
              <td>{fmt$(t.entryPremium, 2)}</td>
              <td>{t.exitDate ?? '—'}</td>
              <td>{t.exitReason?.replace('_', ' ') ?? '—'}</td>
              <td className={t.pnl !== null && t.pnl >= 0 ? 'up' : 'down'}>{fmt$(t.pnl, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Results Panel ─────────────────────────────────────────────────────────

function ResultsPanel({ run, metrics, trades }: { run: BacktestRun; metrics: BacktestMetrics; trades: BacktestTrade[] }) {
  const netPositive = metrics.netPnl >= 0;
  const curve = metrics.equityCurve;
  const startEquity = run.config.startingCapital;

  return (
    <div className="bt-results">
      <div className="bt-results-title">
        {run.config.ticker} · {run.config.strategy} · {run.config.startDate} → {run.config.endDate}
      </div>

      <div className="bt-metrics-grid">
        <MetricCard label="Net P&L" value={fmt$(metrics.netPnl, 0)} positive={netPositive} />
        <MetricCard label="Total Return" value={fmtPct(metrics.totalReturnPct)} positive={metrics.totalReturnPct >= 0} />
        <MetricCard label="Ann. Return" value={fmtPct(metrics.annualizedReturnPct)} positive={metrics.annualizedReturnPct >= 0} />
        <MetricCard label="Max Drawdown" value={fmtPct(-metrics.maxDrawdownPct)} positive={false} />
        <MetricCard label="Sharpe Ratio" value={fmtNum(metrics.sharpeRatio)} positive={metrics.sharpeRatio >= 1} />
        <MetricCard label="Win Rate" value={fmtPct(metrics.winRate)} sub={`${metrics.winningTrades}W / ${metrics.losingTrades}L`} positive={metrics.winRate >= 50} />
        <MetricCard label="Total Trades" value={String(metrics.totalTrades)} />
        <MetricCard label="Avg P&L/Trade" value={fmt$(metrics.avgTradePnl, 0)} positive={metrics.avgTradePnl >= 0} />
      </div>

      <div className="bt-chart-section">
        <div className="bt-chart-title">Equity Curve</div>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={curve} margin={{ top: 4, right: 16, bottom: 4, left: 60 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: '#888' }}
              tickFormatter={v => v.slice(5)} // MM-DD
              interval={Math.floor(curve.length / 8)}
            />
            <YAxis
              tick={{ fontSize: 10, fill: '#888' }}
              tickFormatter={v => `$${(v / 1000).toFixed(0)}k`}
              domain={['auto', 'auto']}
            />
            <Tooltip
              formatter={(v: number) => [fmt$(v, 0), 'Equity']}
              labelFormatter={l => String(l)}
              contentStyle={{ background: '#1a1d23', border: '1px solid #333', fontSize: 12 }}
            />
            <ReferenceLine y={startEquity} stroke="#555" strokeDasharray="4 4" />
            <Line
              type="monotone"
              dataKey="equity"
              stroke={netPositive ? '#2ecc71' : '#e74c3c'}
              dot={false}
              strokeWidth={2}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <TradeTable trades={trades} />
    </div>
  );
}

// ─── Config Form ─────────────────────────────────────────────────────────────

function ConfigForm({
  initial,
  onSubmit,
  onCancel
}: {
  initial?: Partial<BacktestConfig>;
  onSubmit: (cfg: Omit<BacktestConfig, 'id' | 'createdAt'>) => void;
  onCancel?: () => void;
}) {
  const [form, setForm] = useState<Omit<BacktestConfig, 'id' | 'createdAt'>>({
    ...DEFAULT_FORM,
    ...initial
  });

  const set = <K extends keyof typeof form>(key: K, value: typeof form[K]) =>
    setForm(f => ({ ...f, [key]: value }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const name = form.name || `${form.ticker} ${form.strategy} ${form.startDate}`;
    onSubmit({ ...form, name });
  };

  return (
    <form className="bt-form" onSubmit={handleSubmit}>
      <div className="bt-form-title">New Backtest</div>

      <div className="bt-form-row">
        <label>Ticker</label>
        <input
          type="text"
          value={form.ticker}
          onChange={e => set('ticker', e.target.value.toUpperCase())}
          placeholder="AAPL"
          required
        />
      </div>

      <div className="bt-form-row">
        <label>Strategy</label>
        <div className="bt-strategy-tabs">
          {(['CSP', 'CC', 'Wheel'] as BacktestStrategy[]).map(s => (
            <button
              key={s}
              type="button"
              className={`bt-strategy-tab ${form.strategy === s ? 'active' : ''}`}
              onClick={() => set('strategy', s)}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="bt-strategy-hint">
          {form.strategy === 'CSP' && 'Sell cash-secured puts, close at profit/stop targets'}
          {form.strategy === 'CC' && 'Sell covered calls against existing stock (stock entered at start price)'}
          {form.strategy === 'Wheel' && 'Sell CSP → if assigned, sell CC → repeat'}
        </div>
      </div>

      <div className="bt-form-row">
        <label>Date Range</label>
        <div className="bt-date-range">
          <input type="date" value={form.startDate} onChange={e => set('startDate', e.target.value)} required />
          <span>→</span>
          <input type="date" value={form.endDate} onChange={e => set('endDate', e.target.value)} required />
        </div>
      </div>

      <div className="bt-form-row">
        <label>Starting Capital ($)</label>
        <input
          type="number"
          min={1000}
          step={1000}
          value={form.startingCapital}
          onChange={e => set('startingCapital', Number(e.target.value))}
          required
        />
      </div>

      <div className="bt-form-row bt-form-row-inline">
        <div>
          <label>DTE Target</label>
          <input
            type="number"
            min={7}
            max={90}
            value={form.dteTarget}
            onChange={e => set('dteTarget', Number(e.target.value))}
          />
          <span className="bt-hint">days</span>
        </div>
        <div>
          <label>Delta Target</label>
          <input
            type="number"
            min={0.05}
            max={0.50}
            step={0.05}
            value={form.deltaTarget}
            onChange={e => set('deltaTarget', Number(e.target.value))}
          />
        </div>
      </div>

      <div className="bt-form-row bt-form-row-inline">
        <div>
          <label>Profit Target</label>
          <input
            type="number"
            min={10}
            max={100}
            value={form.profitTargetPct}
            onChange={e => set('profitTargetPct', Number(e.target.value))}
          />
          <span className="bt-hint">% of premium</span>
        </div>
        <div>
          <label>Stop Loss</label>
          <input
            type="number"
            min={100}
            max={500}
            value={form.stopLossPct}
            onChange={e => set('stopLossPct', Number(e.target.value))}
          />
          <span className="bt-hint">% of premium</span>
        </div>
      </div>

      <div className="bt-form-row">
        <label>Run Name (optional)</label>
        <input
          type="text"
          value={form.name}
          onChange={e => set('name', e.target.value)}
          placeholder={`${form.ticker || 'TICKER'} ${form.strategy} ${form.startDate}`}
        />
      </div>

      <div className="bt-form-actions">
        {onCancel && <button type="button" className="bt-btn-secondary" onClick={onCancel}>Cancel</button>}
        <button type="submit" className="bt-btn-primary" disabled={!form.ticker}>
          ▶ Run Backtest
        </button>
      </div>
    </form>
  );
}

// ─── Main BacktestView ────────────────────────────────────────────────────────

export function BacktestView() {
  const [runs, setRuns] = useState<BacktestRun[]>([]);
  const [panel, setPanel] = useState<Panel>('new');
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [metrics, setMetrics] = useState<BacktestMetrics | null>(null);
  const [trades, setTrades] = useState<BacktestTrade[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<BacktestProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  const loadRuns = useCallback(async () => {
    try {
      const list = await window.api.backtest.run.list();
      setRuns(list);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  // Subscribe to progress events
  useEffect(() => {
    const unsub = window.api.backtest.run.onProgress((evt) => {
      setProgress(evt);
    });
    unsubRef.current = unsub;
    return () => unsub();
  }, []);

  const selectRun = useCallback(async (runId: number) => {
    setSelectedRunId(runId);
    setPanel('run');
    setMetrics(null);
    setTrades([]);
    try {
      const [m, t] = await Promise.all([
        window.api.backtest.run.metrics(runId),
        window.api.backtest.run.trades(runId)
      ]);
      setMetrics(m);
      setTrades(t);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const handleRunSubmit = useCallback(async (cfg: Omit<BacktestConfig, 'id' | 'createdAt'>) => {
    setError(null);
    setRunning(true);
    setProgress(null);
    try {
      const configId = await window.api.backtest.config.create(cfg);
      const { runId } = await window.api.backtest.run.start(configId);
      await loadRuns();
      await selectRun(runId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }, [loadRuns, selectRun]);

  const handleDelete = useCallback(async (runId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await window.api.backtest.run.delete(runId);
      if (selectedRunId === runId) { setSelectedRunId(null); setPanel('new'); }
      await loadRuns();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [selectedRunId, loadRuns]);

  const selectedRun = runs.find(r => r.id === selectedRunId) ?? null;

  return (
    <div className="bt-view">
      <div className="bt-sidebar">
        <div className="bt-sidebar-header">
          <span className="bt-sidebar-title">Backtests</span>
          <button className="bt-new-btn" onClick={() => { setPanel('new'); setSelectedRunId(null); }}>+ New</button>
        </div>

        <div className="bt-run-list">
          {runs.length === 0 && (
            <div className="bt-empty-list">No backtests yet. Create one to get started.</div>
          )}
          {runs.map(r => {
            const retPct = null; // loaded separately
            return (
              <div
                key={r.id}
                className={`bt-run-item ${selectedRunId === r.id ? 'selected' : ''} bt-run-${r.status}`}
                onClick={() => selectRun(r.id)}
              >
                <div className="bt-run-item-top">
                  <strong>{r.config.ticker}</strong>
                  <span className="bt-run-strategy">{r.config.strategy}</span>
                  <span className={`bt-run-status bt-status-${r.status}`}>{r.status}</span>
                </div>
                <div className="bt-run-item-sub">
                  {r.config.startDate} → {r.config.endDate}
                </div>
                <button className="bt-run-delete" title="Delete" onClick={(e) => handleDelete(r.id, e)}>✕</button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="bt-main">
        {error && (
          <div className="bt-error" onClick={() => setError(null)}>
            {error} <span style={{ float: 'right', cursor: 'pointer' }}>✕</span>
          </div>
        )}

        {running && (
          <div className="bt-progress-bar">
            <div className="bt-progress-label">
              {progress
                ? `Simulating ${progress.currentDate} — day ${progress.simulatedDays}/${progress.totalDays} — equity ${fmt$(progress.currentEquity, 0)}`
                : 'Starting simulation…'}
            </div>
            {progress && (
              <div className="bt-progress-track">
                <div
                  className="bt-progress-fill"
                  style={{ width: `${(progress.simulatedDays / progress.totalDays) * 100}%` }}
                />
              </div>
            )}
          </div>
        )}

        {panel === 'new' && !running && (
          <ConfigForm onSubmit={handleRunSubmit} />
        )}

        {panel === 'run' && selectedRun && (
          <>
            {selectedRun.status === 'running' && (
              <div className="bt-running-msg">Simulation in progress…</div>
            )}
            {selectedRun.status === 'failed' && (
              <div className="bt-error-panel">
                <strong>Simulation failed:</strong> {selectedRun.errorMsg}
                <div style={{ marginTop: 8, color: '#aaa', fontSize: 12 }}>
                  Make sure price history has been synced for {selectedRun.config.ticker} via Data Sync.
                </div>
              </div>
            )}
            {selectedRun.status === 'completed' && metrics && (
              <ResultsPanel run={selectedRun} metrics={metrics} trades={trades} />
            )}
            {selectedRun.status === 'completed' && !metrics && (
              <div className="bt-running-msg">Loading results…</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
