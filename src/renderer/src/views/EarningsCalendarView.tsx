// EarningsCalendarView — upcoming earnings for portfolio + watchlist + conviction tickers.
// v0.31.0

import { useCallback, useEffect, useState } from 'react';

interface EarningsEntry {
  ticker:     string;
  reportDate: string;
  reportTime: 'bmo' | 'amc' | null;
  source:     string;
  confirmed:  boolean;
  dte:        number | null;
}

type Filter = 'all' | 'week' | 'portfolio';

const TIME_LABEL: Record<string, string> = { bmo: 'BMO', amc: 'AMC' };
const SOURCE_LABEL: Record<string, string> = { etrade: 'E*Trade', polygon_est: '~Estimated', manual: 'Manual' };

function dteColor(dte: number | null): string {
  if (dte === null) return '#6b7280';
  if (dte <= 7)  return '#ef4444';
  if (dte <= 21) return '#f59e0b';
  return '#22c55e';
}

function fmtDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function EarningsCalendarView() {
  const [entries, setEntries]     = useState<EarningsEntry[]>([]);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter]       = useState<Filter>('all');
  const [error, setError]         = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // Manual entry state
  const [showAddForm, setShowAddForm] = useState(false);
  const [addTicker, setAddTicker]     = useState('');
  const [addDate, setAddDate]         = useState('');
  const [addTime, setAddTime]         = useState<'bmo' | 'amc' | ''>('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.api.earnings.upcoming(90);
      setEntries(result);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRefresh = async (force = false) => {
    setRefreshing(true); setError(null);
    try {
      const r = await window.api.earnings.refresh(undefined, force);
      setStatusMsg(`Updated ${r.updated}, skipped ${r.skipped}${r.failed > 0 ? `, ${r.failed} failed` : ''}`);
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setRefreshing(false); }
  };

  const handleDelete = async (ticker: string) => {
    await window.api.earnings.delete(ticker);
    setEntries(prev => prev.filter(e => e.ticker !== ticker));
    setStatusMsg(`Removed ${ticker}`);
  };

  const handleAddManual = async () => {
    if (!addTicker.trim() || !addDate) return;
    try {
      await window.api.earnings.setManual(
        addTicker.trim().toUpperCase(),
        addDate,
        addTime || null,
      );
      setAddTicker(''); setAddDate(''); setAddTime('');
      setShowAddForm(false);
      await load();
      setStatusMsg('Earnings date saved');
    } catch (e) { setError((e as Error).message); }
  };

  const navigateToAnalysis = (ticker: string) => {
    window.dispatchEvent(new CustomEvent('navigate-to-analysis', { detail: { ticker } }));
  };

  const filtered = entries.filter(e => {
    if (filter === 'week') return (e.dte ?? 999) <= 7;
    return true;
  });

  // Group by date
  const byDate = new Map<string, EarningsEntry[]>();
  for (const e of filtered) {
    if (!byDate.has(e.reportDate)) byDate.set(e.reportDate, []);
    byDate.get(e.reportDate)!.push(e);
  }
  const sortedDates = [...byDate.keys()].sort();

  return (
    <div className="view" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* ── Header ── */}
      <div className="toolbar" style={{ flexShrink: 0 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>📅 Earnings Calendar</h2>
        <div style={{ flex: 1 }} />
        {/* Filter */}
        <div style={{ display: 'flex', gap: 0, border: '1px solid #1e293b', borderRadius: 4, overflow: 'hidden' }}>
          {(['all', 'week'] as Filter[]).map(f => (
            <button key={f} onClick={() => setFilter(f)} style={{
              padding: '4px 12px', fontSize: 11, border: 'none', cursor: 'pointer',
              background: filter === f ? '#1d4ed8' : '#0f172a',
              color: filter === f ? '#fff' : '#64748b',
            }}>
              {f === 'all' ? 'All (90d)' : 'This week'}
            </button>
          ))}
        </div>
        <button onClick={() => setShowAddForm(p => !p)} style={{ fontSize: 11, padding: '4px 10px', background: '#1e293b', border: '1px solid #374151', borderRadius: 4, color: '#94a3b8', cursor: 'pointer' }}>
          + Manual
        </button>
        <button
          onClick={() => handleRefresh(false)}
          disabled={refreshing}
          style={{ fontSize: 11, padding: '4px 10px', background: '#1e293b', border: '1px solid #374151', borderRadius: 4, color: refreshing ? '#64748b' : '#60a5fa', cursor: refreshing ? 'wait' : 'pointer' }}
        >
          {refreshing ? '⟳ Refreshing…' : '⟳ Refresh'}
        </button>
        <button
          onClick={() => handleRefresh(true)}
          disabled={refreshing}
          title="Force refresh all tickers ignoring 24h cache"
          style={{ fontSize: 11, padding: '4px 10px', background: '#1e293b', border: '1px solid #374151', borderRadius: 4, color: '#6b7280', cursor: refreshing ? 'wait' : 'pointer' }}
        >
          Force refresh
        </button>
      </div>

      {/* ── Toasts ── */}
      {error && <div className="error-toast" onClick={() => setError(null)}>{error} <span style={{ float: 'right', cursor: 'pointer' }}>✕</span></div>}
      {statusMsg && !error && <div className="status-toast" onClick={() => setStatusMsg(null)}>{statusMsg} <span style={{ float: 'right', cursor: 'pointer' }}>✕</span></div>}

      {/* ── Add form ── */}
      {showAddForm && (
        <div style={{ padding: '10px 16px', background: '#0f172a', borderBottom: '1px solid #1e293b', display: 'flex', gap: 8, alignItems: 'flex-end', flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 10, color: '#64748b', marginBottom: 3 }}>Ticker</div>
            <input value={addTicker} onChange={e => setAddTicker(e.target.value.toUpperCase())} placeholder="AAPL" style={{ width: 80, padding: '5px 8px', fontSize: 12, textTransform: 'uppercase' }} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: '#64748b', marginBottom: 3 }}>Earnings date</div>
            <input type="date" value={addDate} onChange={e => setAddDate(e.target.value)} style={{ padding: '5px 8px', fontSize: 12 }} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: '#64748b', marginBottom: 3 }}>Time</div>
            <select value={addTime} onChange={e => setAddTime(e.target.value as 'bmo' | 'amc' | '')} style={{ padding: '5px 8px', fontSize: 12, background: '#1e293b', color: '#e2e8f0', border: '1px solid #374151', borderRadius: 4 }}>
              <option value="">Unknown</option>
              <option value="bmo">BMO (Before Market)</option>
              <option value="amc">AMC (After Market)</option>
            </select>
          </div>
          <button onClick={handleAddManual} style={{ padding: '6px 14px', background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: 4, fontSize: 12, cursor: 'pointer' }}>Save</button>
          <button onClick={() => setShowAddForm(false)} style={{ padding: '6px 10px', background: '#1e293b', color: '#94a3b8', border: '1px solid #374151', borderRadius: 4, fontSize: 12, cursor: 'pointer' }}>Cancel</button>
        </div>
      )}

      {/* ── Calendar content ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
        {loading ? (
          <div className="empty">Loading…</div>
        ) : sortedDates.length === 0 ? (
          <div className="empty-state">
            <p>No upcoming earnings found.</p>
            <p className="meta">Click "⟳ Refresh" to fetch earnings dates for all portfolio, watchlist, and conviction tickers.</p>
            <button onClick={() => handleRefresh(false)} disabled={refreshing}>
              {refreshing ? 'Refreshing…' : 'Refresh Now'}
            </button>
          </div>
        ) : (
          sortedDates.map(date => {
            const dayEntries = byDate.get(date)!;
            const daysOut = dayEntries[0]?.dte ?? 0;
            return (
              <div key={date} style={{ marginBottom: 16 }}>
                {/* Date group header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, paddingBottom: 4, borderBottom: '1px solid #1e293b' }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0' }}>{fmtDate(date)}</span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: dteColor(daysOut), background: dteColor(daysOut) + '22', padding: '1px 7px', borderRadius: 10 }}>
                    {daysOut === 0 ? 'Today' : daysOut === 1 ? 'Tomorrow' : `${daysOut}d`}
                  </span>
                </div>

                {/* Rows */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {dayEntries.map(e => (
                    <div key={e.ticker} style={{
                      display: 'flex', alignItems: 'center', gap: 12, padding: '7px 10px',
                      background: '#0f172a', border: '1px solid #1e293b', borderRadius: 6,
                    }}>
                      <button
                        onClick={() => navigateToAnalysis(e.ticker)}
                        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 13, fontWeight: 700, color: '#60a5fa' }}
                        title={`Open Analysis for ${e.ticker}`}
                      >
                        {e.ticker}
                      </button>

                      {e.reportTime && (
                        <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: '#1e293b', color: '#94a3b8' }}>
                          {TIME_LABEL[e.reportTime]}
                        </span>
                      )}

                      <span style={{ fontSize: 10, color: e.confirmed ? '#22c55e' : '#f59e0b' }} title={SOURCE_LABEL[e.source] ?? e.source}>
                        {e.confirmed ? '✓ Confirmed' : '~ Estimated'}
                      </span>

                      <span style={{ fontSize: 10, color: '#475569', marginLeft: 'auto' }}>
                        {SOURCE_LABEL[e.source] ?? e.source}
                      </span>

                      <button
                        onClick={() => handleDelete(e.ticker)}
                        title="Remove this earnings entry"
                        style={{ background: 'none', border: 'none', color: '#374151', cursor: 'pointer', fontSize: 13, lineHeight: 1 }}
                      >×</button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
