// Trade Scoring Config page — edit signal weights + toggles per strategy.
// see Requirements/DAILY_INTELLIGENCE_BRIEF.md §7

import { useState, useEffect, useCallback } from 'react';
import type { ScoringConfig, ScoringSignal, ScoringStrategy, SignalWeightSuggestion } from '@shared/types.js';

const STRATEGY_LABELS: Record<ScoringStrategy, string> = {
  wheel:   '🎡  Wheel',
  bullish: '🐂  Bullish',
  bearish: '🐻  Bearish',
  income:  '💰  Income',
  buy:     '📈  Buy / Swing',
  inflection: '🎯  Inflection',
};

const DIRECTION_ICON: Record<ScoringSignal['direction'], string> = {
  higher_better: '↑',
  lower_better:  '↓',
  target_range:  '◎',
};

const DIRECTION_TITLE: Record<ScoringSignal['direction'], string> = {
  higher_better: 'Higher is better',
  lower_better:  'Lower is better',
  target_range:  'Target range',
};

const STRATEGIES: ScoringStrategy[] = ['wheel', 'bullish', 'bearish', 'income', 'buy'];

function totalWeight(signals: ScoringSignal[]): number {
  return signals.filter(s => s.enabled).reduce((sum, s) => sum + s.weight, 0);
}

/** Redistribute weight when one signal changes so enabled total stays at 100. */
function redistributeWeights(signals: ScoringSignal[], changedKey: string, newWeight: number): ScoringSignal[] {
  const others = signals.filter(s => s.key !== changedKey && s.enabled);
  if (others.length === 0) return signals.map(s => s.key === changedKey ? { ...s, weight: 100 } : s);

  const oldOtherTotal = others.reduce((sum, s) => sum + s.weight, 0);
  const remaining = 100 - newWeight;

  return signals.map(s => {
    if (s.key === changedKey) return { ...s, weight: newWeight };
    if (!s.enabled) return s;
    if (oldOtherTotal === 0) return { ...s, weight: remaining / others.length };
    return { ...s, weight: Math.round((s.weight / oldOtherTotal) * remaining) };
  });
}

function SignalRow({
  signal,
  onChange,
}: {
  signal: ScoringSignal;
  onChange: (updated: ScoringSignal) => void;
}) {
  const isActive = signal.enabled;

  return (
    <div className={`scoring-signal-row${!isActive ? ' disabled' : ''}`}>
      {/* Toggle */}
      <div className="sig-toggle">
        <input
          type="checkbox"
          checked={signal.enabled}
          onChange={e => onChange({ ...signal, enabled: e.target.checked })}
        />
      </div>

      {/* Label + source + direction */}
      <div className="sig-label">
        <div className="sig-name-row">
          <span className="sig-name">{signal.label}</span>
          <span
            className={`sig-direction dir-${signal.direction}`}
            title={DIRECTION_TITLE[signal.direction]}
          >
            {DIRECTION_ICON[signal.direction]}
          </span>

        </div>
        <span className="sig-source">{signal.dataSource}</span>
      </div>

      {/* Weight input + bar */}
      <div className="sig-weight">
        <div className="sig-weight-input-row">
          <input
            type="number"
            min={0}
            max={100}
            value={signal.weight}
            disabled={!signal.enabled}
            onChange={e => {
              const val = Math.min(100, Math.max(0, parseInt(e.target.value, 10) || 0));
              onChange({ ...signal, weight: val });
            }}
          />
          <span className="sig-weight-pct">%</span>
        </div>
        <div className="sig-weight-bar-track">
          <div
            className="sig-weight-bar-fill"
            style={{ width: `${Math.min(100, signal.weight)}%` }}
          />
        </div>
      </div>

      {/* Description */}
      <div className="sig-desc">{signal.description}</div>
    </div>
  );
}

export function TradeScoringView() {
  const [configs, setConfigs] = useState<Record<ScoringStrategy, ScoringConfig | null>>(
    Object.fromEntries(STRATEGIES.map(s => [s, null])) as Record<ScoringStrategy, ScoringConfig | null>
  );
  const [selectedStrategy, setSelectedStrategy] = useState<ScoringStrategy>('wheel');
  const [editingSignals, setEditingSignals] = useState<ScoringSignal[]>([]);
  const [versionInput, setVersionInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');
  const [suggestions, setSuggestions] = useState<SignalWeightSuggestion[]>([]);
  const [loadingSugg, setLoadingSugg] = useState(false);

  const load = useCallback(async () => {
    try {
      const all = await window.api.scoring.getConfig() as ScoringConfig[];
      const map = Object.fromEntries(all.map(c => [c.strategy, c])) as Record<ScoringStrategy, ScoringConfig>;
      setConfigs(map);
      const current = map[selectedStrategy];
      if (current) {
        setEditingSignals([...current.signals]);
        setVersionInput(current.version);
      }
    } catch (err) {
      console.error('[scoring] load error:', err);
    }
  }, [selectedStrategy]);

  const loadSuggestions = useCallback(async (strategy: ScoringStrategy) => {
    setLoadingSugg(true);
    try {
      const sugg = await window.api.scoring.signalCorrelations(strategy);
      setSuggestions(sugg as SignalWeightSuggestion[]);
    } catch (err) {
      console.error('[scoring] suggestions error:', err);
      setSuggestions([]);
    } finally {
      setLoadingSugg(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadSuggestions(selectedStrategy); }, [selectedStrategy, loadSuggestions]);

  const handleStrategyChange = (strategy: ScoringStrategy) => {
    setSelectedStrategy(strategy);
    const cfg = configs[strategy];
    if (cfg) {
      setEditingSignals([...cfg.signals]);
      setVersionInput(cfg.version);
    }
  };

  const handleSignalChange = (updated: ScoringSignal) => {
    setEditingSignals(prev => {
      const old = prev.find(s => s.key === updated.key);
      if (old && old.weight !== updated.weight) {
        return redistributeWeights(prev, updated.key, updated.weight);
      }
      if (old && old.enabled !== updated.enabled) {
        const newSignals = prev.map(s => s.key === updated.key ? updated : s);
        const enabled = newSignals.filter(s => s.enabled);
        const tot = enabled.reduce((sum, s) => sum + s.weight, 0);
        if (tot === 0) return newSignals;
        const scale = 100 / tot;
        return newSignals.map(s =>
          s.enabled ? { ...s, weight: Math.round(s.weight * scale) } : s
        );
      }
      return prev.map(s => s.key === updated.key ? updated : s);
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const version = versionInput.trim() || `v${Date.now()}`;
      await window.api.scoring.updateConfig(selectedStrategy, editingSignals, version);
      setSavedMsg(`✓ Saved as "${version}"`);
      setTimeout(() => setSavedMsg(''), 3000);
      await load();
    } catch (err) {
      console.error('[scoring] save error:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    const ok = await window.dialog.confirm({
      title: 'Reset to Baseline',
      message: `This will discard your custom weights for ${STRATEGY_LABELS[selectedStrategy]} and restore the expert defaults. Continue?`,
    });
    if (!ok) return;
    try {
      const cfg = await window.api.scoring.resetToBaseline(selectedStrategy);
      setEditingSignals([...(cfg as ScoringConfig).signals]);
      setVersionInput((cfg as ScoringConfig).version);
      setSavedMsg('✓ Reset to baseline');
      setTimeout(() => setSavedMsg(''), 3000);
    } catch (err) {
      console.error('[scoring] reset error:', err);
    }
  };

  const cfg = configs[selectedStrategy];
  const enabledTotal = totalWeight(editingSignals);
  const isBalanced = enabledTotal === 100 || editingSignals.filter(s => s.enabled).length === 0;
  const activeSignals = editingSignals.filter(s => s.enabled);

  return (
    <div className="view trade-scoring-view">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="toolbar">
        <h2>Trade Scoring Config</h2>
        <div style={{ flex: 1 }} />
        {cfg && (
          <span className="meta" style={{ fontSize: 12 }}>
            v<strong>{cfg.version}</strong>
            <span style={{ marginLeft: 12, color: '#64748b' }}>
              saved {new Date(cfg.updatedAt).toLocaleDateString()}
            </span>
          </span>
        )}
      </div>

      {/* ── Strategy tabs ───────────────────────────────────────── */}
      <div className="scoring-strategy-tabs">
        {STRATEGIES.map(s => (
          <button
            key={s}
            className={`scoring-tab${selectedStrategy === s ? ' active' : ''}`}
            onClick={() => handleStrategyChange(s)}
          >
            {STRATEGY_LABELS[s]}
          </button>
        ))}
        <span className="scoring-tab-note">
          Changes take effect on the next Brief run
        </span>
      </div>

      {/* ── Signal table ────────────────────────────────────────── */}
      <div className="scoring-signals-area">
        {/* Column header */}
        <div className="scoring-signals-header">
          <span className="sh-toggle" />
          <span className="sh-label">Signal</span>
          <span className="sh-weight">Weight</span>
          <span className="sh-desc">Expert rationale</span>
        </div>

        {editingSignals.map(sig => (
          <SignalRow key={sig.key} signal={sig} onChange={handleSignalChange} />
        ))}

        {/* Weight total */}
        <div className={`scoring-total-row${isBalanced ? ' ok' : ' warn'}`}>
          <span className="total-label">Enabled weight total</span>
          <span className="total-value">{enabledTotal}%</span>
          {!isBalanced && (
            <span className="total-warn-msg">must equal 100%</span>
          )}
          {isBalanced && activeSignals.length > 0 && (
            <span className="total-ok-msg">{activeSignals.length} signals active</span>
          )}
        </div>
      </div>

      {/* ── Actions footer ──────────────────────────────────────── */}
      <div className="scoring-footer">
        <label className="scoring-version-label">
          <span>Version label</span>
          <input
            type="text"
            value={versionInput}
            onChange={e => setVersionInput(e.target.value)}
            placeholder="e.g. tastytrade_v2"
          />
        </label>
        <div style={{ flex: 1 }} />
        {savedMsg && <span className="scoring-save-msg">{savedMsg}</span>}
        <button className="btn-ghost" onClick={handleReset}>
          Reset to Baseline
        </button>
        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={saving || !isBalanced}
        >
          {saving ? 'Saving…' : 'Save Config'}
        </button>
      </div>

      {/* ── Signal weight suggestions (1e) ──────────────────────── */}
      <div className="scoring-suggestions-panel">
        <div className="scoring-suggestions-header">
          <span className="scoring-suggestions-title">Signal Correlation Suggestions</span>
          <span className="scoring-suggestions-subtitle">
            Pearson correlation between signal values and Day+1 positive outcomes · needs ≥ 10 snapshots
          </span>
        </div>
        {loadingSugg ? (
          <div style={{ padding: '12px 0', color: 'var(--text-muted)', fontSize: 13 }}>Computing…</div>
        ) : suggestions.length === 0 ? (
          <div style={{ padding: '12px 0', color: 'var(--text-muted)', fontSize: 13 }}>
            Not enough data yet — accumulate more Day+1 snapshots by running the Daily Brief regularly.
          </div>
        ) : (
          <table className="scoring-sugg-table">
            <thead>
              <tr>
                <th>Signal</th>
                <th>Current Weight</th>
                <th>Correlation (r)</th>
                <th>Suggested Weight</th>
                <th>Direction</th>
                <th>Samples</th>
              </tr>
            </thead>
            <tbody>
              {suggestions.map(s => {
                const dirColor = s.direction === 'increase' ? '#3fb950' : s.direction === 'decrease' ? '#f85149' : '#8b949e';
                const dirLabel = s.direction === 'increase' ? '↑ Increase' : s.direction === 'decrease' ? '↓ Decrease' : '— Hold';
                const corrColor = Math.abs(s.correlation) > 0.3 ? '#3fb950' : Math.abs(s.correlation) > 0.1 ? '#e3a008' : '#8b949e';
                return (
                  <tr key={s.signalKey}>
                    <td style={{ fontWeight: 500 }}>{s.signalLabel}</td>
                    <td style={{ color: '#c9d1d9' }}>{s.currentWeight}%</td>
                    <td style={{ color: corrColor, fontFamily: 'monospace' }}>{s.correlation >= 0 ? '+' : ''}{s.correlation.toFixed(3)}</td>
                    <td style={{ color: s.suggestedWeight !== s.currentWeight ? '#58a6ff' : '#8b949e', fontWeight: s.suggestedWeight !== s.currentWeight ? 600 : 400 }}>
                      {s.suggestedWeight}%
                    </td>
                    <td style={{ color: dirColor, fontWeight: 600 }}>{dirLabel}</td>
                    <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{s.sampleSize}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
