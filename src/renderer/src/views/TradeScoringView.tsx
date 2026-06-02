// Trade Scoring Config page — edit signal weights + toggles per strategy.
// see Requirements/DAILY_INTELLIGENCE_BRIEF.md §7

import { useState, useEffect, useCallback } from 'react';
import type { ScoringConfig, ScoringSignal, ScoringStrategy } from '@shared/types.js';

const STRATEGY_LABELS: Record<ScoringStrategy, string> = {
  wheel:   'Wheel',
  bullish: 'Bullish',
  bearish: 'Bearish',
  income:  'Income',
  buy:     'Buy / Swing',
};

const STRATEGIES: ScoringStrategy[] = ['wheel', 'bullish', 'bearish', 'income', 'buy'];

function totalWeight(signals: ScoringSignal[]): number {
  return signals.filter(s => s.enabled && !s.phase2).reduce((sum, s) => sum + s.weight, 0);
}

/** Redistribute weight when one signal changes so enabled total stays at 100. */
function redistributeWeights(signals: ScoringSignal[], changedKey: string, newWeight: number): ScoringSignal[] {
  const others = signals.filter(s => s.key !== changedKey && s.enabled && !s.phase2);
  if (others.length === 0) return signals.map(s => s.key === changedKey ? { ...s, weight: 100 } : s);

  const oldOtherTotal = others.reduce((sum, s) => sum + s.weight, 0);
  const remaining = 100 - newWeight;

  return signals.map(s => {
    if (s.key === changedKey) return { ...s, weight: newWeight };
    if (!s.enabled || s.phase2) return s;
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
  const isPhase2 = signal.phase2;

  return (
    <div className={`scoring-signal-row ${!signal.enabled || isPhase2 ? 'disabled' : ''}`}>
      <div className="signal-toggle">
        <input
          type="checkbox"
          checked={signal.enabled}
          disabled={isPhase2}
          onChange={e => onChange({ ...signal, enabled: e.target.checked })}
        />
      </div>
      <div className="signal-label">
        <span className="signal-name">{signal.label}</span>
        {isPhase2 && <span className="phase2-badge">Phase 2</span>}
        <span className="signal-source">{signal.dataSource}</span>
      </div>
      <div className="signal-weight">
        <input
          type="number"
          min={0}
          max={100}
          value={signal.weight}
          disabled={!signal.enabled || isPhase2}
          onChange={e => {
            const val = Math.min(100, Math.max(0, parseInt(e.target.value, 10) || 0));
            onChange({ ...signal, weight: val });
          }}
          style={{ width: 60 }}
        />
        <span className="weight-pct">%</span>
      </div>
      <div className="signal-desc" title={signal.description}>
        {signal.description}
      </div>
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

  useEffect(() => { load(); }, [load]);

  // When strategy changes, reload signals from fetched config
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
      // If weight changed, redistribute
      const old = prev.find(s => s.key === updated.key);
      if (old && old.weight !== updated.weight) {
        return redistributeWeights(prev, updated.key, updated.weight);
      }
      // If enabled toggled, also redistribute
      if (old && old.enabled !== updated.enabled) {
        const newSignals = prev.map(s => s.key === updated.key ? updated : s);
        // Re-normalize weights among enabled signals
        const enabled = newSignals.filter(s => s.enabled && !s.phase2);
        const tot = enabled.reduce((sum, s) => sum + s.weight, 0);
        if (tot === 0) return newSignals;
        const scale = 100 / tot;
        return newSignals.map(s =>
          s.enabled && !s.phase2 ? { ...s, weight: Math.round(s.weight * scale) } : s
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
      setSavedMsg(`Saved as "${version}"`);
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
      setSavedMsg('Reset to baseline');
      setTimeout(() => setSavedMsg(''), 3000);
    } catch (err) {
      console.error('[scoring] reset error:', err);
    }
  };

  const cfg = configs[selectedStrategy];
  const enabledTotal = totalWeight(editingSignals);
  const isBalanced = enabledTotal === 100 || editingSignals.filter(s => s.enabled && !s.phase2).length === 0;

  return (
    <div className="view trade-scoring-view">
      <div className="toolbar">
        <h2>Trade Scoring Config</h2>
        <div style={{ flex: 1 }} />
      </div>

      {/* Strategy selector */}
      <div className="scoring-strategy-bar">
        {STRATEGIES.map(s => (
          <button
            key={s}
            className={`strategy-tab ${selectedStrategy === s ? 'active' : ''}`}
            onClick={() => handleStrategyChange(s)}
          >
            {STRATEGY_LABELS[s]}
          </button>
        ))}
      </div>

      {cfg && (
        <div className="scoring-meta">
          <span className="meta">Version: <strong>{cfg.version}</strong></span>
          <span className="meta" style={{ marginLeft: 16 }}>
            Last saved: {new Date(cfg.updatedAt).toLocaleDateString()}
          </span>
          <span className="meta scoring-note" style={{ marginLeft: 'auto' }}>
            Changes take effect on the next brief generation run.
          </span>
        </div>
      )}

      {/* Signal rows */}
      <div className="scoring-signals-table">
        <div className="scoring-signals-header">
          <span style={{ width: 32 }} />
          <span style={{ flex: 1 }}>Signal</span>
          <span style={{ width: 80 }}>Weight</span>
          <span style={{ flex: 2 }}>Expert rationale</span>
        </div>
        {editingSignals.map(sig => (
          <SignalRow key={sig.key} signal={sig} onChange={handleSignalChange} />
        ))}
        <div className={`scoring-total ${isBalanced ? 'ok' : 'warn'}`}>
          <span>Total: <strong>{enabledTotal}%</strong></span>
          {!isBalanced && (
            <span className="total-warn"> (must equal 100%)</span>
          )}
        </div>
      </div>

      {/* Save / reset */}
      <div className="scoring-actions">
        <label>
          Version label:
          <input
            type="text"
            value={versionInput}
            onChange={e => setVersionInput(e.target.value)}
            placeholder="e.g. tastytrade_v2"
            style={{ marginLeft: 8, width: 180 }}
          />
        </label>
        <button
          onClick={handleSave}
          disabled={saving || !isBalanced}
          className="primary"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={handleReset}>
          Reset to Baseline
        </button>
        {savedMsg && <span className="save-msg">{savedMsg}</span>}
      </div>
    </div>
  );
}
