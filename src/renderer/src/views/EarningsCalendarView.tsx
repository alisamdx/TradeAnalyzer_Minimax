// EarningsCalendarView — upcoming earnings in calendar grid or list format.
// v0.32.12

import { useCallback, useEffect, useState } from 'react';

interface EarningsEntry {
  ticker:     string;
  reportDate: string;   // YYYY-MM-DD
  reportTime: 'bmo' | 'amc' | null;
  source:     string;
  confirmed:  boolean;
  dte:        number | null;
}

type ViewMode = 'calendar' | 'list';
type Filter   = 'all' | 'week';

const SOURCE_LABEL: Record<string, string> = {
  etrade:      'E*Trade',
  polygon_est: '~Estimated',
  manual:      'Manual',
  finnhub:     'Finnhub',
  share_class: 'Share class',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Format ISO date string without timezone drift. */
function fmtDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

/** Today as YYYY-MM-DD in local time (no UTC shift). */
function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Date → local YYYY-MM-DD without UTC conversion. */
function toLocalIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dteColor(dte: number | null): string {
  if (dte === null) return '#6b7280';
  if (dte <= 7)  return '#ef4444';
  if (dte <= 21) return '#f59e0b';
  return '#22c55e';
}

// ── Calendar Grid ─────────────────────────────────────────────────────────────

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface CalendarGridProps {
  entries:         EarningsEntry[];
  viewMonth:       { year: number; month: number };
  onPrev:          () => void;
  onNext:          () => void;
  onToday:         () => void;
  onTickerClick:   (ticker: string) => void;
  onDeleteTicker:  (ticker: string) => void;
}

function CalendarGrid({
  entries, viewMonth, onPrev, onNext, onToday, onTickerClick, onDeleteTicker,
}: CalendarGridProps) {
  const { year, month } = viewMonth;
  const today = todayLocal();

  // Build entry map: YYYY-MM-DD → entries[]
  const entryMap = new Map<string, EarningsEntry[]>();
  for (const e of entries) {
    const list = entryMap.get(e.reportDate) ?? [];
    list.push(e);
    entryMap.set(e.reportDate, list);
  }

  // Month grid
  const firstOfMonth = new Date(year, month, 1);
  const daysInMonth  = new Date(year, month + 1, 0).getDate();
  const startDow     = firstOfMonth.getDay(); // 0=Sun
  const totalCells   = Math.ceil((startDow + daysInMonth) / 7) * 7;

  const cells: Array<{ dateStr: string; dayNum: number; inMonth: boolean; isWeekend: boolean }> = [];
  for (let i = 0; i < totalCells; i++) {
    const d = new Date(year, month, 1 + (i - startDow));
    cells.push({
      dateStr:   toLocalIso(d),
      dayNum:    d.getDate(),
      inMonth:   d.getMonth() === month,
      isWeekend: d.getDay() === 0 || d.getDay() === 6,
    });
  }

  const monthLabel = firstOfMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  // Count entries this month for summary
  const thisMonthEntries = entries.filter(e => {
    const [y, m] = e.reportDate.split('-').map(Number);
    return y === year && m === month + 1;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Month navigation */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={onPrev} style={navBtnStyle}>‹</button>
        <button onClick={onNext} style={navBtnStyle}>›</button>
        <span style={{ fontSize: 15, fontWeight: 700, color: '#e2e8f0', minWidth: 160 }}>{monthLabel}</span>
        <button onClick={onToday} style={{ ...navBtnStyle, fontSize: 11, padding: '3px 10px' }}>Today</button>
        {thisMonthEntries.length > 0 && (
          <span style={{ fontSize: 11, color: '#64748b', marginLeft: 4 }}>
            {thisMonthEntries.length} earning{thisMonthEntries.length !== 1 ? 's' : ''} this month
          </span>
        )}
      </div>

      {/* Day-of-week headers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
        {DOW.map(d => (
          <div key={d} style={{
            textAlign: 'center', fontSize: 10, fontWeight: 600,
            color: '#475569', padding: '4px 0', letterSpacing: '0.05em',
          }}>
            {d}
          </div>
        ))}

        {/* Day cells */}
        {cells.map(({ dateStr, dayNum, inMonth, isWeekend }) => {
          const dayEntries = entryMap.get(dateStr) ?? [];
          const isToday    = dateStr === today;
          const hasEntries = dayEntries.length > 0;

          return (
            <div key={dateStr} style={{
              minHeight: 72,
              background: isToday ? '#1a2a3a' : isWeekend ? '#0f1624' : '#131b2e',
              border: `2px solid ${isToday ? '#89b4fa' : hasEntries ? '#2d4a6e' : '#2d3748'}`,
              borderRadius: 4,
              padding: '4px 5px',
              opacity: inMonth ? 1 : 0.3,
              position: 'relative',
            }}>
              {/* Day number */}
              <div style={{
                fontSize: 10,
                fontWeight: isToday ? 700 : 400,
                color: isToday ? '#89b4fa' : isWeekend ? '#4b5563' : '#95a5a6',
                marginBottom: 3,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}>
                <span>{dayNum}</span>
                {isToday && <span style={{ fontSize: 8, color: '#89b4fa', fontWeight: 700 }}>TODAY</span>}
              </div>

              {/* Ticker chips */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {dayEntries.map(e => {
                  const weekendWarning = isWeekend && !e.confirmed;
                  return (
                    <div key={e.ticker} style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      gap: 2, padding: '2px 4px', borderRadius: 3,
                      background: weekendWarning ? '#2a1a00' : e.confirmed ? '#1a2a3a' : '#1e2535',
                      border: `2px solid ${weekendWarning ? '#f59e0b66' : e.confirmed ? '#2d4a6e' : '#2d3748'}`,
                      cursor: 'pointer',
                    }}
                      onClick={() => onTickerClick(e.ticker)}
                      title={`${e.ticker}${weekendWarning ? ' ⚠ Weekend date — likely approximate' : ''} · ${e.reportTime ? (e.reportTime === 'bmo' ? 'Before Market Open' : 'After Market Close') : 'Time unknown'} · ${e.confirmed ? 'Confirmed' : 'Estimated'} · ${SOURCE_LABEL[e.source] ?? e.source}`}
                    >
                      <span style={{ fontSize: 10, fontWeight: 700, color: weekendWarning ? '#fbbf24' : '#89b4fa' }}>
                        {weekendWarning ? '⚠ ' : ''}{e.ticker}
                      </span>
                      <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                        {e.reportTime && (
                          <span style={{
                            fontSize: 8, color: e.reportTime === 'bmo' ? '#2ecc71' : '#e74c3c',
                            fontWeight: 600,
                          }}>
                            {e.reportTime.toUpperCase()}
                          </span>
                        )}
                        <span
                          onClick={ev => { ev.stopPropagation(); onDeleteTicker(e.ticker); }}
                          style={{ fontSize: 9, color: '#4b5563', cursor: 'pointer', lineHeight: 1, paddingLeft: 1 }}
                          title="Remove"
                        >×</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 14, fontSize: 10, color: '#95a5a6', paddingTop: 4, flexWrap: 'wrap' }}>
        <span><span style={{ color: '#2ecc71' }}>BMO</span> = Before Market Open</span>
        <span><span style={{ color: '#e74c3c' }}>AMC</span> = After Market Close</span>
        <span><span style={{ color: '#89b4fa' }}>Blue border</span> = Confirmed</span>
        <span><span style={{ color: '#2d3748' }}>Dim border</span> = Estimated</span>
        <span><span style={{ color: '#fbbf24' }}>⚠ Amber</span> = Weekend date (approximate — verify manually)</span>
      </div>
    </div>
  );
}

// ── List View ─────────────────────────────────────────────────────────────────

interface ListViewProps {
  entries:        EarningsEntry[];
  filter:         Filter;
  onFilterChange: (f: Filter) => void;
  onTickerClick:  (ticker: string) => void;
  onDelete:       (ticker: string) => void;
  onRefresh:      () => void;
  refreshing:     boolean;
}

function ListView({ entries, filter, onFilterChange, onTickerClick, onDelete, onRefresh, refreshing }: ListViewProps) {
  const filtered = entries.filter(e => {
    if (filter === 'week') return (e.dte ?? 999) <= 7;
    return true;
  });

  const byDate = new Map<string, EarningsEntry[]>();
  for (const e of filtered) {
    const list = byDate.get(e.reportDate) ?? [];
    list.push(e);
    byDate.set(e.reportDate, list);
  }
  const sortedDates = [...byDate.keys()].sort();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Filter toggle */}
      <div style={{ display: 'flex', gap: 0, border: '1px solid #1e293b', borderRadius: 4, overflow: 'hidden', marginBottom: 12, alignSelf: 'flex-start' }}>
        {(['all', 'week'] as Filter[]).map(f => (
          <button key={f} onClick={() => onFilterChange(f)} style={{
            padding: '4px 12px', fontSize: 11, border: 'none', cursor: 'pointer',
            background: filter === f ? '#1d4ed8' : '#0f172a',
            color: filter === f ? '#fff' : '#64748b',
          }}>
            {f === 'all' ? 'All (180d)' : 'This week'}
          </button>
        ))}
      </div>

      {sortedDates.length === 0 ? (
        <div className="empty-state">
          <p>No upcoming earnings found.</p>
          <p className="meta">Click &quot;⟳ Refresh&quot; to fetch earnings dates for all portfolio, watchlist, and conviction tickers.</p>
          <button onClick={onRefresh} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh Now'}
          </button>
        </div>
      ) : (
        sortedDates.map(date => {
          const dayEntries = byDate.get(date)!;
          const daysOut = dayEntries[0]?.dte ?? 0;
          return (
            <div key={date} style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, paddingBottom: 4, borderBottom: '1px solid #1e293b' }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0' }}>{fmtDate(date)}</span>
                <span style={{ fontSize: 11, fontWeight: 600, color: dteColor(daysOut), background: dteColor(daysOut) + '22', padding: '1px 7px', borderRadius: 10 }}>
                  {daysOut === 0 ? 'Today' : daysOut === 1 ? 'Tomorrow' : `${daysOut}d`}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {dayEntries.map(e => (
                  <div key={e.ticker} style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '7px 10px',
                    background: '#0f172a', border: '1px solid #1e293b', borderRadius: 6,
                  }}>
                    <button onClick={() => onTickerClick(e.ticker)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 13, fontWeight: 700, color: '#60a5fa' }}>
                      {e.ticker}
                    </button>
                    {e.reportTime && (
                      <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: '#1e293b', color: '#94a3b8' }}>
                        {e.reportTime === 'bmo' ? 'BMO' : 'AMC'}
                      </span>
                    )}
                    <span style={{ fontSize: 10, color: e.confirmed ? '#16a34a' : '#d97706' }}>
                      {e.confirmed ? '✓ Confirmed' : '~ Estimated'}
                    </span>
                    <span style={{ fontSize: 10, color: '#64748b', marginLeft: 'auto' }}>
                      {SOURCE_LABEL[e.source] ?? e.source}
                    </span>
                    <button onClick={() => onDelete(e.ticker)} title="Remove" style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 13, lineHeight: 1 }}>×</button>
                  </div>
                ))}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const navBtnStyle: React.CSSProperties = {
  padding: '4px 10px', fontSize: 14, background: '#1e293b',
  border: '1px solid #334155', borderRadius: 4, color: '#94a3b8',
  cursor: 'pointer', lineHeight: 1,
};

// ── Main View ─────────────────────────────────────────────────────────────────

export function EarningsCalendarView() {
  const [entries, setEntries]     = useState<EarningsEntry[]>([]);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [viewMode, setViewMode]   = useState<ViewMode>('calendar');
  const [filter, setFilter]       = useState<Filter>('all');
  const [error, setError]         = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // Calendar month state (default = current month)
  const [viewMonth, setViewMonth] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });

  // Manual entry state
  const [showAddForm, setShowAddForm] = useState(false);
  const [addTicker, setAddTicker]     = useState('');
  const [addDate, setAddDate]         = useState('');
  const [addTime, setAddTime]         = useState<'bmo' | 'amc' | ''>('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.api.earnings.upcoming(180); // 6 months for calendar navigation
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
      await window.api.earnings.setManual(addTicker.trim().toUpperCase(), addDate, addTime || null);
      setAddTicker(''); setAddDate(''); setAddTime('');
      setShowAddForm(false);
      await load();
      setStatusMsg('Earnings date saved');
    } catch (e) { setError((e as Error).message); }
  };

  const navigateToAnalysis = (ticker: string) => {
    window.dispatchEvent(new CustomEvent('navigate-to-validate', { detail: { ticker } }));
  };

  const prevMonth = () => setViewMonth(({ year, month }) => {
    const d = new Date(year, month - 1, 1);
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const nextMonth = () => setViewMonth(({ year, month }) => {
    const d = new Date(year, month + 1, 1);
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const goToday = () => {
    const now = new Date();
    setViewMonth({ year: now.getFullYear(), month: now.getMonth() });
  };

  return (
    <div className="view" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* ── Header ── */}
      <div className="toolbar" style={{ flexShrink: 0 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>📅 Earnings Calendar</h2>
        <div style={{ flex: 1 }} />

        {/* View mode toggle */}
        <div style={{ display: 'flex', gap: 0, border: '1px solid #1e293b', borderRadius: 4, overflow: 'hidden' }}>
          {(['calendar', 'list'] as ViewMode[]).map(m => (
            <button key={m} onClick={() => setViewMode(m)} style={{
              padding: '4px 12px', fontSize: 11, border: 'none', cursor: 'pointer',
              background: viewMode === m ? '#1d4ed8' : '#0f172a',
              color: viewMode === m ? '#fff' : '#64748b',
            }}>
              {m === 'calendar' ? '📅 Calendar' : '☰ List'}
            </button>
          ))}
        </div>

        <button onClick={() => setShowAddForm(p => !p)} style={{ fontSize: 11, padding: '4px 10px', background: '#1e293b', border: '1px solid #374151', borderRadius: 4, color: '#94a3b8', cursor: 'pointer' }}>
          + Manual
        </button>
        <button onClick={() => handleRefresh(false)} disabled={refreshing} style={{ fontSize: 11, padding: '4px 10px', background: '#1e293b', border: '1px solid #374151', borderRadius: 4, color: refreshing ? '#64748b' : '#60a5fa', cursor: refreshing ? 'wait' : 'pointer' }}>
          {refreshing ? '⟳ Refreshing…' : '⟳ Refresh'}
        </button>
        <button onClick={() => handleRefresh(true)} disabled={refreshing} title="Force refresh — ignore smart cache" style={{ fontSize: 11, padding: '4px 10px', background: '#1e293b', border: '1px solid #374151', borderRadius: 4, color: '#6b7280', cursor: refreshing ? 'wait' : 'pointer' }}>
          Force refresh
        </button>
        <button
          onClick={async () => {
            const n = await window.api.earnings.clearNonManual();
            setEntries([]);
            setStatusMsg(`Cleared ${n} entries (manual entries kept)`);
          }}
          disabled={refreshing}
          title="Delete all non-manual earnings data — run batch job to repopulate"
          style={{ fontSize: 11, padding: '4px 10px', background: '#2a1010', border: '1px solid #e74c3c', borderRadius: 4, color: '#e74c3c', cursor: 'pointer' }}
        >
          🗑 Reset
        </button>
      </div>

      {/* ── Toasts ── */}
      {error    && <div className="error-toast"  onClick={() => setError(null)}>{error} <span style={{ float: 'right', cursor: 'pointer' }}>✕</span></div>}
      {statusMsg && !error && <div className="status-toast" onClick={() => setStatusMsg(null)}>{statusMsg} <span style={{ float: 'right', cursor: 'pointer' }}>✕</span></div>}

      {/* ── Manual add form ── */}
      {showAddForm && (
        <div style={{ padding: '10px 16px', background: '#0f172a', borderBottom: '1px solid #1e293b', display: 'flex', gap: 8, alignItems: 'flex-end', flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 10, color: '#64748b', marginBottom: 3 }}>Ticker</div>
            <input value={addTicker} onChange={e => setAddTicker(e.target.value.toUpperCase())} placeholder="AAPL" style={{ width: 80, padding: '5px 8px', fontSize: 12 }} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: '#64748b', marginBottom: 3 }}>Earnings date</div>
            <input type="date" value={addDate} onChange={e => setAddDate(e.target.value)} style={{ padding: '5px 8px', fontSize: 12 }} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: '#64748b', marginBottom: 3 }}>Time</div>
            <select value={addTime} onChange={e => setAddTime(e.target.value as 'bmo' | 'amc' | '')} style={{ padding: '5px 8px', fontSize: 12, background: '#1e293b', color: '#e2e8f0', border: '1px solid #374151', borderRadius: 4 }}>
              <option value="">Unknown</option>
              <option value="bmo">BMO (Before Market Open)</option>
              <option value="amc">AMC (After Market Close)</option>
            </select>
          </div>
          <button onClick={handleAddManual} style={{ padding: '6px 14px', background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: 4, fontSize: 12, cursor: 'pointer' }}>Save</button>
          <button onClick={() => setShowAddForm(false)} style={{ padding: '6px 10px', background: '#1e293b', color: '#94a3b8', border: '1px solid #374151', borderRadius: 4, fontSize: 12, cursor: 'pointer' }}>Cancel</button>
        </div>
      )}

      {/* ── Content ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
        {loading ? (
          <div className="empty">Loading…</div>
        ) : viewMode === 'calendar' ? (
          <CalendarGrid
            entries={entries}
            viewMonth={viewMonth}
            onPrev={prevMonth}
            onNext={nextMonth}
            onToday={goToday}
            onTickerClick={navigateToAnalysis}
            onDeleteTicker={handleDelete}
          />
        ) : (
          <ListView
            entries={entries}
            filter={filter}
            onFilterChange={setFilter}
            onTickerClick={navigateToAnalysis}
            onDelete={handleDelete}
            onRefresh={() => handleRefresh(false)}
            refreshing={refreshing}
          />
        )}
      </div>
    </div>
  );
}
