// Constituents viewer (Misc) — the S&P 500 and Russell 1000 lists the app tracks, with
// the date each ticker was first added to its index. Surfaces what the daily
// constituents-refresh job (v1.1.91) adds over time; rows added recently are badged NEW.

import { useEffect, useMemo, useState } from 'react';
import type { ConstituentWithMeta, ConstituentsMeta } from '@shared/types';

type IndexName = 'sp500' | 'russell1000';
type SortKey = 'ticker' | 'companyName' | 'sector' | 'addedAt';
type SortDir = 'asc' | 'desc';

const TABS: { key: IndexName; label: string }[] = [
  { key: 'sp500', label: 'S&P 500' },
  { key: 'russell1000', label: 'Russell 1000' },
];

const NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // rows added within 7 days are badged NEW

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function ConstituentsView() {
  const [tab, setTab] = useState<IndexName>('sp500');
  const [rows, setRows] = useState<ConstituentWithMeta[]>([]);
  const [meta, setMeta] = useState<ConstituentsMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('addedAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      window.api.screen.getConstituentsWithMeta(tab),
      window.api.screen.getMeta(tab),
    ])
      .then(([data, m]) => {
        if (cancelled) return;
        setRows(data);
        setMeta(m);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tab]);

  const sorted = useMemo(() => {
    const q = query.trim().toUpperCase();
    const filtered = q
      ? rows.filter((r) => r.ticker.toUpperCase().includes(q) || (r.companyName ?? '').toUpperCase().includes(q))
      : rows;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = a[sortKey] ?? '';
      const bv = b[sortKey] ?? '';
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      // Stable tiebreak on ticker so equal dates render deterministically.
      return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
    });
  }, [rows, sortKey, sortDir, query]);

  const newCount = useMemo(() => {
    const cut = Date.now() - NEW_WINDOW_MS;
    return rows.filter((r) => new Date(r.addedAt).getTime() >= cut).length;
  }, [rows]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'addedAt' ? 'desc' : 'asc'); // dates default newest-first
    }
  }

  const arrow = (key: SortKey) => (key === sortKey ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
  const th: React.CSSProperties = {
    textAlign: 'left', padding: '8px 10px', borderBottom: '2px solid var(--border)',
    cursor: 'pointer', userSelect: 'none', position: 'sticky', top: 0, background: 'var(--bg-elev)',
  };
  const td: React.CSSProperties = { padding: '6px 10px', borderBottom: '1px solid var(--border)' };

  return (
    <div style={{ padding: 16, maxWidth: 1000 }}>
      <h2 style={{ marginTop: 0 }}>📇 Index Constituents</h2>
      <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
        The S&P 500 and Russell 1000 lists the app tracks. Refreshed daily by the constituents job —
        newly added members appear at the top (sort by <em>Added</em>).
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: '6px 14px', borderRadius: 6, cursor: 'pointer',
              border: '1px solid var(--border)',
              background: tab === t.key ? 'var(--accent)' : 'var(--bg-elev)',
              color: tab === t.key ? '#fff' : 'var(--text)', fontWeight: tab === t.key ? 600 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by ticker or company…"
          style={{
            padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)',
            background: 'var(--bg)', color: 'var(--text)', minWidth: 240,
          }}
        />
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          {loading ? 'Loading…' : `${sorted.length} of ${rows.length} shown`}
          {newCount > 0 && !loading ? ` · ${newCount} added in last 7 days` : ''}
        </span>
        {meta && (
          <span style={{ color: 'var(--text-muted)', fontSize: 13, marginLeft: 'auto' }}>
            Source: {meta.source} · refreshed {fmtDate(meta.refreshedAt)}
          </span>
        )}
      </div>

      {error && <div style={{ color: 'var(--danger, #d33)', marginBottom: 8 }}>Error: {error}</div>}

      <div style={{ maxHeight: '65vh', overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr>
              <th style={th} onClick={() => toggleSort('ticker')}>Ticker{arrow('ticker')}</th>
              <th style={th} onClick={() => toggleSort('companyName')}>Company{arrow('companyName')}</th>
              <th style={th} onClick={() => toggleSort('sector')}>Sector{arrow('sector')}</th>
              <th style={th} onClick={() => toggleSort('addedAt')}>Added{arrow('addedAt')}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const isNew = Date.now() - new Date(r.addedAt).getTime() < NEW_WINDOW_MS;
              return (
                <tr key={r.ticker}>
                  <td style={{ ...td, fontWeight: 600 }}>{r.ticker}</td>
                  <td style={td}>{r.companyName ?? '—'}</td>
                  <td style={{ ...td, color: 'var(--text-muted)' }}>{r.sector ?? '—'}</td>
                  <td style={td}>
                    {fmtDate(r.addedAt)}
                    {isNew && (
                      <span style={{
                        marginLeft: 8, fontSize: 11, fontWeight: 700, color: '#fff',
                        background: 'var(--accent)', borderRadius: 4, padding: '1px 6px',
                      }}>NEW</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {!loading && sorted.length === 0 && (
              <tr><td style={{ ...td, color: 'var(--text-muted)' }} colSpan={4}>No constituents to show.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default ConstituentsView;
