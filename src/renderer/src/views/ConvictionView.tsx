// ConvictionView — Personal stock conviction list with price bands.
// v0.24.0

import { useCallback, useEffect, useState } from 'react';
import type {
  ConvictionStock, ConvictionZone, ConvictionBandHistory,
  ConvictionInput, ConvictionRecommendation,
} from '@shared/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(v: number | null, decimals = 2): string {
  if (v === null) return '—';
  return `$${v.toFixed(decimals)}`;
}

function fmtPct(v: number | null): string {
  if (v === null) return '—';
  return `${v.toFixed(1)}%`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Zone Badge ───────────────────────────────────────────────────────────────

const ZONE_CONFIG: Record<ConvictionZone, { label: string; bg: string; color: string; icon: string }> = {
  buy:   { label: 'Buy Zone',  bg: '#1a3a1a', color: '#2ecc71', icon: '✅' },
  mid:   { label: 'Mid Zone',  bg: '#2a2a0a', color: '#f1c40f', icon: '🟡' },
  watch: { label: 'Watch',     bg: '#1a2235', color: '#89b4fa', icon: '🔵' },
  high:  { label: 'Too High',  bg: '#3a1a1a', color: '#e74c3c', icon: '🚫' },
  unset: { label: 'No Bands',  bg: '#1e1e1e', color: '#555',    icon: '—'  },
};

function ZoneBadge({ zone }: { zone: ConvictionZone }) {
  const c = ZONE_CONFIG[zone];
  return (
    <span style={{
      background: c.bg, color: c.color,
      padding: '2px 8px', borderRadius: 10,
      fontSize: 11, fontWeight: 600,
      display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
    }}>
      {c.icon} {c.label}
    </span>
  );
}

// ─── Price Band Bar ───────────────────────────────────────────────────────────

function BandBar({ stock }: { stock: ConvictionStock }) {
  const { priceLow, priceMid, priceHigh, currentPrice } = stock;
  if (!priceLow || !priceHigh || !currentPrice) return null;

  const min = Math.min(priceLow, currentPrice) * 0.97;
  const max = Math.max(priceHigh, currentPrice) * 1.03;
  const range = max - min;
  if (range <= 0) return null;

  const pct = (v: number) => `${Math.max(0, Math.min(100, ((v - min) / range) * 100)).toFixed(1)}%`;

  return (
    <div style={{ position: 'relative', height: 6, background: '#1a2235', borderRadius: 3, minWidth: 80 }}>
      {/* Low → High fill */}
      <div style={{
        position: 'absolute', left: pct(priceLow), right: `${100 - parseFloat(pct(priceHigh))}%`,
        top: 0, bottom: 0, background: '#2d3748', borderRadius: 3,
      }} />
      {/* Low marker */}
      <div style={{ position: 'absolute', left: pct(priceLow), top: -1, width: 2, height: 8, background: '#2ecc71', borderRadius: 1 }} title={`Low: ${fmt(priceLow)}`} />
      {/* Mid marker */}
      {priceMid && <div style={{ position: 'absolute', left: pct(priceMid), top: -1, width: 2, height: 8, background: '#f1c40f', borderRadius: 1 }} title={`Mid: ${fmt(priceMid)}`} />}
      {/* High marker */}
      <div style={{ position: 'absolute', left: pct(priceHigh), top: -1, width: 2, height: 8, background: '#e74c3c', borderRadius: 1 }} title={`High: ${fmt(priceHigh)}`} />
      {/* Current price indicator */}
      <div style={{
        position: 'absolute', left: pct(currentPrice),
        top: -3, width: 3, height: 12,
        background: '#ecf0f1', borderRadius: 1,
        transform: 'translateX(-50%)',
      }} title={`Current: ${fmt(currentPrice)}`} />
    </div>
  );
}

// ─── History Modal ────────────────────────────────────────────────────────────

function HistoryModal({ ticker, onClose }: { ticker: string; onClose: () => void }) {
  const [history, setHistory] = useState<ConvictionBandHistory[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    window.api.conviction.history(ticker)
      .then(setHistory)
      .finally(() => setLoading(false));
  }, [ticker]);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#1e2535', border: '1px solid #2d3748', borderRadius: 10, padding: 24, minWidth: 520, maxWidth: 640, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3 style={{ margin: 0, color: '#ecf0f1' }}>Band History — {ticker}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#95a5a6', cursor: 'pointer', fontSize: 18 }}>✕</button>
        </div>
        {loading ? (
          <div style={{ color: '#95a5a6', textAlign: 'center', padding: 20 }}>Loading…</div>
        ) : history.length === 0 ? (
          <div style={{ color: '#95a5a6', textAlign: 'center', padding: 20 }}>No history yet — bands have never been changed.</div>
        ) : (
          <div style={{ overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  {['Changed', 'Low', 'Mid', 'High', 'Note'].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '6px 10px', color: '#89b4fa', borderBottom: '1px solid #2d3748', fontWeight: 600 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.map(h => (
                  <tr key={h.id} style={{ borderBottom: '1px solid #1e2535' }}>
                    <td style={{ padding: '6px 10px', color: '#95a5a6', whiteSpace: 'nowrap' }}>{fmtTime(h.changedAt)}</td>
                    <td style={{ padding: '6px 10px', color: '#2ecc71' }}>{fmt(h.priceLow)}</td>
                    <td style={{ padding: '6px 10px', color: '#f1c40f' }}>{fmt(h.priceMid)}</td>
                    <td style={{ padding: '6px 10px', color: '#e74c3c' }}>{fmt(h.priceHigh)}</td>
                    <td style={{ padding: '6px 10px', color: '#95a5a6', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={h.note ?? undefined}>{h.note || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ marginTop: 16, textAlign: 'right' }}>
          <button onClick={onClose} style={{ padding: '6px 16px', borderRadius: 6, border: '1px solid #3d4f6e', background: '#1e2a3a', color: '#89b4fa', cursor: 'pointer' }}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ─── Add / Edit Modal ─────────────────────────────────────────────────────────

interface EditModalProps {
  stock: ConvictionStock | null; // null = add new
  onSave: (input: ConvictionInput) => void;
  onClose: () => void;
}

function EditModal({ stock, onSave, onClose }: EditModalProps) {
  const isNew = stock === null;
  const [ticker, setTicker] = useState(stock?.ticker ?? '');
  const [priceLow, setPriceLow] = useState(stock?.priceLow?.toString() ?? '');
  const [priceMid, setPriceMid] = useState(stock?.priceMid?.toString() ?? '');
  const [priceHigh, setPriceHigh] = useState(stock?.priceHigh?.toString() ?? '');
  const [note, setNote] = useState(stock?.note ?? '');
  const [error, setError] = useState('');

  // Recommendation state
  const [rec, setRec] = useState<ConvictionRecommendation | null>(null);
  const [recLoading, setRecLoading] = useState(false);
  const [recError, setRecError] = useState('');

  const parsePrice = (s: string): number | null => {
    const v = parseFloat(s);
    return isNaN(v) || v <= 0 ? null : v;
  };

  const handleSave = () => {
    const low = parsePrice(priceLow);
    const mid = parsePrice(priceMid);
    const high = parsePrice(priceHigh);

    // Validate order when multiple bands are set
    if (low !== null && mid !== null && low >= mid) {
      setError('Low entry must be less than Mid price'); return;
    }
    if (mid !== null && high !== null && mid >= high) {
      setError('Mid price must be less than High (Never Enter)'); return;
    }
    if (low !== null && high !== null && low >= high) {
      setError('Low entry must be less than High (Never Enter)'); return;
    }

    const t = ticker.trim().toUpperCase();
    if (!t) { setError('Ticker is required'); return; }

    onSave({ ticker: t, priceLow: low, priceMid: mid, priceHigh: high, note: note.trim() || null });
  };

  const handleGetRecommendation = async () => {
    const t = (isNew ? ticker : stock!.ticker).trim().toUpperCase();
    if (!t) { setRecError('Enter a ticker first'); return; }
    setRecLoading(true);
    setRecError('');
    setRec(null);
    try {
      const result = await window.api.conviction.recommend(t);
      if (!result.hasData) {
        setRecError(result.priceLowBasis);
      } else {
        setRec(result);
      }
    } catch (e) {
      setRecError(e instanceof Error ? e.message : 'Recommendation failed');
    } finally {
      setRecLoading(false);
    }
  };

  const applyRec = (field: 'low' | 'mid' | 'high' | 'all') => {
    if (!rec) return;
    if (field === 'low' || field === 'all') setPriceLow(rec.priceLow?.toFixed(2) ?? '');
    if (field === 'mid' || field === 'all') setPriceMid(rec.priceMid?.toFixed(2) ?? '');
    if (field === 'high' || field === 'all') setPriceHigh(rec.priceHigh?.toFixed(2) ?? '');
    if (field === 'all') setRec(null);
  };

  const inputStyle: React.CSSProperties = {
    background: '#131b2e', border: '1px solid #2d3748', borderRadius: 6,
    color: '#ecf0f1', padding: '6px 10px', fontSize: 13, width: '100%', boxSizing: 'border-box',
  };
  const labelStyle: React.CSSProperties = { color: '#a0aec0', fontSize: 12, marginBottom: 4, display: 'block' };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#1e2535', border: '1px solid #2d3748', borderRadius: 10, padding: 24, width: 480, maxHeight: '90vh', overflowY: 'auto' }}>
        <h3 style={{ margin: '0 0 20px', color: '#ecf0f1' }}>{isNew ? '+ Add Stock' : `Edit — ${stock!.ticker}`}</h3>

        {/* Ticker */}
        {isNew && (
          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>Ticker *</label>
            <input style={inputStyle} value={ticker}
              onChange={e => setTicker(e.target.value.toUpperCase())}
              placeholder="e.g. NVDA" autoFocus />
          </div>
        )}

        {/* Price bands */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 14 }}>
          <div>
            <label style={{ ...labelStyle, color: '#2ecc71' }}>Low Entry ($)</label>
            <input style={{ ...inputStyle, borderColor: '#2ecc71' }} type="number" min="0" step="0.5"
              value={priceLow} onChange={e => setPriceLow(e.target.value)}
              placeholder="e.g. 180" />
          </div>
          <div>
            <label style={{ ...labelStyle, color: '#f1c40f' }}>Mid ($)</label>
            <input style={{ ...inputStyle, borderColor: '#f1c40f' }} type="number" min="0" step="0.5"
              value={priceMid} onChange={e => setPriceMid(e.target.value)}
              placeholder="e.g. 190" />
          </div>
          <div>
            <label style={{ ...labelStyle, color: '#e74c3c' }}>Never Enter Above ($)</label>
            <input style={{ ...inputStyle, borderColor: '#e74c3c' }} type="number" min="0" step="0.5"
              value={priceHigh} onChange={e => setPriceHigh(e.target.value)}
              placeholder="e.g. 200" />
          </div>
        </div>

        {/* Note */}
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>Note</label>
          <textarea style={{ ...inputStyle, resize: 'vertical', minHeight: 60 }}
            value={note} onChange={e => setNote(e.target.value)}
            placeholder="Personal thesis, why you like this stock…" />
        </div>

        {/* Recommendation button */}
        <div style={{ marginBottom: 16 }}>
          <button
            onClick={handleGetRecommendation}
            disabled={recLoading}
            style={{
              padding: '6px 14px', borderRadius: 6, fontSize: 13, cursor: recLoading ? 'not-allowed' : 'pointer',
              border: '1px solid #89b4fa', background: '#1a2235', color: '#89b4fa',
            }}
          >
            {recLoading ? '⟳ Loading…' : '💡 Get Recommendation'}
          </button>
          {recError && <span style={{ marginLeft: 10, color: '#e67e22', fontSize: 12 }}>{recError}</span>}
        </div>

        {/* Recommendation panel */}
        {rec && (
          <div style={{ background: '#131b2e', border: '1px solid #2d3748', borderRadius: 8, padding: 14, marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <span style={{ color: '#89b4fa', fontWeight: 600, fontSize: 13 }}>💡 System Recommendation</span>
              <button onClick={() => setRec(null)} style={{ background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: 14 }}>✕</button>
            </div>
            {[
              { label: 'Low', val: rec.priceLow, basis: rec.priceLowBasis, color: '#2ecc71', field: 'low' as const },
              { label: 'Mid', val: rec.priceMid, basis: rec.priceMidBasis, color: '#f1c40f', field: 'mid' as const },
              { label: 'High', val: rec.priceHigh, basis: rec.priceHighBasis, color: '#e74c3c', field: 'high' as const },
            ].map(row => (
              <div key={row.field} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <span style={{ color: row.color, fontWeight: 600, minWidth: 36, fontSize: 13 }}>{row.label}:</span>
                <span style={{ color: '#ecf0f1', fontWeight: 600, minWidth: 64, fontSize: 13 }}>{fmt(row.val)}</span>
                <span style={{ color: '#666', fontSize: 11, flex: 1 }}>{row.basis}</span>
                <button onClick={() => applyRec(row.field)} style={{
                  padding: '2px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer',
                  border: `1px solid ${row.color}`, background: 'transparent', color: row.color,
                }}>Apply</button>
              </div>
            ))}
            <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
              <button onClick={() => applyRec('all')} style={{
                padding: '5px 14px', borderRadius: 5, fontSize: 12, cursor: 'pointer',
                border: '1px solid #89b4fa', background: '#1a2a3a', color: '#89b4fa', fontWeight: 600,
              }}>Apply All</button>
              <button onClick={() => setRec(null)} style={{
                padding: '5px 14px', borderRadius: 5, fontSize: 12, cursor: 'pointer',
                border: '1px solid #444', background: 'transparent', color: '#666',
              }}>Dismiss</button>
            </div>
          </div>
        )}

        {error && <div style={{ color: '#e74c3c', fontSize: 12, marginBottom: 12 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '6px 16px', borderRadius: 6, border: '1px solid #444', background: 'transparent', color: '#95a5a6', cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleSave} style={{ padding: '6px 18px', borderRadius: 6, border: 'none', background: '#2980b9', color: '#fff', cursor: 'pointer', fontWeight: 600 }}>
            {isNew ? 'Add Stock' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main View ────────────────────────────────────────────────────────────────

export function ConvictionView() {
  const [stocks, setStocks] = useState<ConvictionStock[]>([]);
  const [loading, setLoading] = useState(true);
  const [editStock, setEditStock] = useState<ConvictionStock | null | undefined>(undefined); // undefined = closed, null = new
  const [historyTicker, setHistoryTicker] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');

  const load = useCallback(async () => {
    try {
      setStocks(await window.api.conviction.list());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = async (input: ConvictionInput) => {
    if (editStock === null) {
      await window.api.conviction.add(input);
    } else {
      const { ticker, ...rest } = input;
      await window.api.conviction.update(ticker, rest);
    }
    setEditStock(undefined);
    load();
  };

  const handleRemove = async (ticker: string) => {
    if (!await window.dialog.confirm({ title: 'Remove Stock', message: `Remove ${ticker} from your conviction list?` })) return;
    await window.api.conviction.remove(ticker);
    load();
  };

  const handleSync = async () => {
    setSyncing(true);
    setSyncMsg('');
    try {
      const result = await window.api.conviction.syncDefaultWatchlist();
      setSyncMsg(result.added.length > 0
        ? `Added ${result.added.length} stock${result.added.length !== 1 ? 's' : ''}: ${result.added.join(', ')}`
        : 'No new stocks — all watchlist tickers already in list.');
      if (result.added.length > 0) load();
    } finally {
      setSyncing(false);
    }
  };

  // Sort: buy zone first, then mid, watch, unset, high
  const zoneOrder: Record<ConvictionZone, number> = { buy: 0, mid: 1, watch: 2, unset: 3, high: 4 };
  const sorted = [...stocks].sort((a, b) => zoneOrder[a.zone] - zoneOrder[b.zone] || a.ticker.localeCompare(b.ticker));

  const buyZoneCount = stocks.filter(s => s.zone === 'buy').length;
  const midZoneCount = stocks.filter(s => s.zone === 'mid').length;

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div style={{ padding: '20px 24px', maxWidth: 1200, margin: '0 auto' }}>
        <style>{`
          .cv-table { width: 100%; border-collapse: collapse; font-size: 13px; }
          .cv-table th { background: #1a2235; color: #89b4fa; text-align: left; padding: 8px 10px; font-weight: 600; border-bottom: 1px solid #2d3748; white-space: nowrap; }
          .cv-table td { padding: 8px 10px; border-bottom: 1px solid #1e2535; vertical-align: middle; }
          .cv-table tr:hover td { background: #1a2535; }
          .cv-btn { padding: 3px 9px; border-radius: 4px; border: 1px solid #3d4f6e; background: #1e2a3a; color: #89b4fa; cursor: pointer; font-size: 11px; }
          .cv-btn:hover { background: #2a3a5a; }
          .cv-btn.danger { border-color: #e74c3c; color: #e74c3c; }
          .cv-btn.danger:hover { background: #3a1a1a; }
        `}</style>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <h2 style={{ color: '#ecf0f1', margin: '0 0 4px' }}>⭐ My Stocks — Conviction List</h2>
            <span style={{ color: '#95a5a6', fontSize: 13 }}>
              {stocks.length} stock{stocks.length !== 1 ? 's' : ''}
              {buyZoneCount > 0 && <span style={{ color: '#2ecc71', marginLeft: 10 }}>✅ {buyZoneCount} in buy zone</span>}
              {midZoneCount > 0 && <span style={{ color: '#f1c40f', marginLeft: 8 }}>🟡 {midZoneCount} in mid zone</span>}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button
              onClick={handleSync} disabled={syncing}
              style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #3d4f6e', background: '#1e2535', color: '#95a5a6', cursor: syncing ? 'not-allowed' : 'pointer', fontSize: 13 }}
            >
              {syncing ? '⟳ Syncing…' : '↓ Sync from Default Watchlist'}
            </button>
            <button
              onClick={() => setEditStock(null)}
              style={{ padding: '6px 16px', borderRadius: 6, border: '1px solid #2ecc71', background: '#1e2535', color: '#2ecc71', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
            >
              + Add Stock
            </button>
          </div>
        </div>

        {syncMsg && (
          <div style={{ background: '#1a2235', border: '1px solid #2d3748', borderRadius: 6, padding: '8px 14px', marginBottom: 16, color: '#89b4fa', fontSize: 13 }}>
            {syncMsg}
            <button onClick={() => setSyncMsg('')} style={{ marginLeft: 10, background: 'none', border: 'none', color: '#555', cursor: 'pointer' }}>✕</button>
          </div>
        )}

        {/* Table */}
        <div style={{ background: '#131b2e', borderRadius: 10, border: '1px solid #2d3748' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#95a5a6' }}>Loading…</div>
          ) : stocks.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#95a5a6' }}>
              <div style={{ fontSize: 32, marginBottom: 10 }}>⭐</div>
              <div>No stocks yet. Add your first stock or sync from your default watchlist.</div>
            </div>
          ) : (
            <table className="cv-table">
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>Zone</th>
                  <th style={{ textAlign: 'right' }}>Current</th>
                  <th style={{ textAlign: 'right', color: '#2ecc71' }}>Low Entry</th>
                  <th style={{ textAlign: 'right', color: '#f1c40f' }}>Mid</th>
                  <th style={{ textAlign: 'right', color: '#e74c3c' }}>Never Above</th>
                  <th>Bands</th>
                  <th style={{ textAlign: 'right' }}>IV</th>
                  <th style={{ textAlign: 'right' }}>IVR</th>
                  <th>Note</th>
                  <th style={{ textAlign: 'center' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(stock => (
                  <tr key={stock.ticker}>
                    <td>
                      <strong style={{ color: '#ecf0f1', fontSize: 14 }}>{stock.ticker}</strong>
                    </td>
                    <td><ZoneBadge zone={stock.zone} /></td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: stock.zone === 'buy' ? '#2ecc71' : stock.zone === 'high' ? '#e74c3c' : '#ecf0f1' }}>
                      {fmt(stock.currentPrice)}
                    </td>
                    <td style={{ textAlign: 'right', color: '#2ecc71' }}>{fmt(stock.priceLow)}</td>
                    <td style={{ textAlign: 'right', color: '#f1c40f' }}>{fmt(stock.priceMid)}</td>
                    <td style={{ textAlign: 'right', color: '#e74c3c' }}>{fmt(stock.priceHigh)}</td>
                    <td style={{ minWidth: 90 }}><BandBar stock={stock} /></td>
                    <td style={{ textAlign: 'right', color: '#95a5a6' }}>{fmtPct(stock.iv)}</td>
                    <td style={{ textAlign: 'right', color: stock.ivRank !== null && stock.ivRank >= 50 ? '#e67e22' : '#95a5a6' }}>
                      {stock.ivRank !== null ? Math.round(stock.ivRank) : '—'}
                    </td>
                    <td style={{ color: '#95a5a6', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={stock.note ?? undefined}>
                      {stock.note || <span style={{ color: '#333' }}>—</span>}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 5, justifyContent: 'center' }}>
                        <button className="cv-btn" onClick={() => setEditStock(stock)} title="Edit">✎</button>
                        <button className="cv-btn" onClick={() => setHistoryTicker(stock.ticker)} title="Band history">🕓</button>
                        <button className="cv-btn danger" onClick={() => handleRemove(stock.ticker)} title="Remove">✕</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Modals */}
      {editStock !== undefined && (
        <EditModal
          stock={editStock}
          onSave={handleSave}
          onClose={() => setEditStock(undefined)}
        />
      )}
      {historyTicker && (
        <HistoryModal ticker={historyTicker} onClose={() => setHistoryTicker(null)} />
      )}
    </div>
  );
}
