import React, { useCallback, useEffect, useState } from 'react';
import type { ExecConfig } from '@shared/types.js';

// Execution Settings (Requirements/v2-execution §4, Phase 5d): a plain editor over the
// single exec_config row via window.api.execution.getConfig / updateConfig. The risk
// governor re-reads config on every gate, so saved changes take effect on the next cycle.

type Draft = Omit<ExecConfig, 'updatedAt'> & { eligibleStrategiesText: string };

function toDraft(c: ExecConfig): Draft {
  return { ...c, eligibleStrategiesText: c.eligibleStrategies.join(', ') };
}

export function ExecutionSettingsView() {
  const [config, setConfig] = useState<ExecConfig | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const c = await window.api.execution.getConfig();
      setConfig(c); setDraft(toDraft(c)); setError(null);
    } catch (e) { setError((e as Error).message); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft(d => (d ? { ...d, [key]: value } : d));
    setStatus(null);
  };

  const dirty = !!config && !!draft && JSON.stringify(toDraft(config)) !== JSON.stringify(draft);

  const onSave = async () => {
    if (!draft || !config) return;
    if (draft.executionMode === 'live' && config.executionMode !== 'live') {
      const ok = await window.dialog.confirm({
        title: 'Switch to LIVE mode',
        message: 'This points the engine at the LIVE broker. Real orders become possible once the engine is started and a proposal is approved. Continue?',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const { eligibleStrategiesText, ...rest } = draft;
      const eligibleStrategies = eligibleStrategiesText.split(',').map(s => s.trim()).filter(Boolean);
      const updated = await window.api.execution.updateConfig({ ...rest, eligibleStrategies });
      setConfig(updated); setDraft(toDraft(updated));
      setStatus('Saved.'); setError(null);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  if (!draft) {
    return <div style={{ padding: 16 }}>{error ? <ErrBox msg={error} onClose={() => setError(null)} /> : 'Loading…'}</div>;
  }

  return (
    <div style={{ padding: 16, maxWidth: 760, flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>🤝 Execution Settings</h2>
        <span style={{ flex: 1 }} />
        {config && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>updated {new Date(config.updatedAt).toLocaleString()}</span>}
      </div>

      {error && <ErrBox msg={error} onClose={() => setError(null)} />}
      {status && <div style={{ background: '#13361f', border: '1px solid var(--success)', borderRadius: 6, padding: '8px 12px', marginBottom: 12 }}>{status}</div>}

      <Section title="Mode">
        <Field label="Execution mode" help="Paper uses the mock/paper broker; live points at the real account.">
          <select value={draft.executionMode} onChange={e => set('executionMode', e.target.value as ExecConfig['executionMode'])}>
            <option value="paper">paper</option>
            <option value="live">live</option>
          </select>
        </Field>
        <Field label="Eligible strategies" help="Comma-separated. Launch scope is inflection-only.">
          <input type="text" value={draft.eligibleStrategiesText} onChange={e => set('eligibleStrategiesText', e.target.value)} style={{ width: 280 }} />
        </Field>
        <Field label="Inflection direction" help="Bear-call/down side is a validated net loser (FR-SEY-3) — default up.">
          <select value={draft.inflectionDirection} onChange={e => set('inflectionDirection', e.target.value as ExecConfig['inflectionDirection'])}>
            <option value="up">up-breakouts only</option>
            <option value="down">down-breakouts only</option>
            <option value="both">both</option>
          </select>
        </Field>
      </Section>

      <Section title="Risk limits">
        <Num label="Capital ceiling ($)" v={draft.capitalCeiling} on={v => set('capitalCeiling', v)} step={500} />
        <Num label="Max risk per trade (%)" v={draft.maxRiskPerTradePct} on={v => set('maxRiskPerTradePct', v)} step={0.5} />
        <Num label="Max concurrent positions" v={draft.maxConcurrentPositions} on={v => set('maxConcurrentPositions', v)} step={1} />
        <Num label="Daily-loss trip (%)" v={draft.dailyLossTripPct} on={v => set('dailyLossTripPct', v)} step={0.5} />
        <Num label="Max positions per ticker" v={draft.maxPositionsPerTicker} on={v => set('maxPositionsPerTicker', v)} step={1} />
        <NumNullable label="Max positions per strategy" v={draft.maxPositionsPerStrategy} on={v => set('maxPositionsPerStrategy', v)} help="Blank = off" />
        <NumNullable label="Max positions per sector" v={draft.maxPositionsPerSector} on={v => set('maxPositionsPerSector', v)} help="Blank = off (FR-SEY-1; SPDR sector bucket)" />
        <Num label="Drawdown throttle at (%)" v={draft.drawdownThrottlePct} on={v => set('drawdownThrottlePct', v)} step={1} help="0 = off (FR-SEY-2)" />
        <Num label="Throttle size factor" v={draft.drawdownThrottleFactor} on={v => set('drawdownThrottleFactor', v)} step={0.05} help="× per-trade size while throttled" />
      </Section>

      <Section title="Entry policy">
        <Num label="Min composite score" v={draft.minCompositeScore} on={v => set('minCompositeScore', v)} step={1} />
        <StrategyFloors
          strategies={draft.eligibleStrategiesText.split(',').map(s => s.trim()).filter(Boolean)}
          floors={draft.minCompositeByStrategy}
          globalFloor={draft.minCompositeScore}
          onChange={m => set('minCompositeByStrategy', m)}
        />
        <Num label="Max new entries / day" v={draft.maxNewEntriesPerDay} on={v => set('maxNewEntriesPerDay', v)} step={1} />
        <Num label="Max new entries / week" v={draft.maxNewEntriesPerWeek} on={v => set('maxNewEntriesPerWeek', v)} step={1} />
        <Num label="Proposal shelf-life (min)" v={draft.proposalShelfLifeMin} on={v => set('proposalShelfLifeMin', v)} step={1} />
        <Num label="Re-price tolerance (%)" v={draft.repriceTolerancePct} on={v => set('repriceTolerancePct', v)} step={0.5} />
        <Field label="Entry window (ET)">
          <input type="time" value={draft.entryWindowStart} onChange={e => set('entryWindowStart', e.target.value)} />
          <span style={{ margin: '0 8px' }}>–</span>
          <input type="time" value={draft.entryWindowEnd} onChange={e => set('entryWindowEnd', e.target.value)} />
        </Field>
        <Field label="Avoid earnings before expiry">
          <input type="checkbox" checked={draft.avoidEarningsBeforeExpiry} onChange={e => set('avoidEarningsBeforeExpiry', e.target.checked)} />
        </Field>
        <Field label="Risk-budget spread width" help="Size the inflection vertical's hedge leg to the per-trade budget so it's tradeable on a small account. Validated FR-SEY-5: neutral-to-better on return, makes high-priced names sizeable.">
          <input type="checkbox" checked={draft.budgetWidthEnabled} onChange={e => set('budgetWidthEnabled', e.target.checked)} />
        </Field>
        <Num label="Max combo spread (rel.)" v={draft.maxComboSpreadPct} on={v => set('maxComboSpreadPct', v)} step={0.05} help="0 = off. Liquidity gate: reject when (ask−bid)/|mid| exceeds this. ~0.20 live (can't be backtested — no historical bid/ask)." />
      </Section>

      <Section title="Exit policy">
        <Num label="Protective stop (× credit)" v={draft.stopMultiple} on={v => set('stopMultiple', v)} step={0.5} />
        <Num label="Defensive-expiry DTE" v={draft.defensiveDte} on={v => set('defensiveDte', v)} step={1} />
        <Num label="Profit target (% of credit)" v={draft.profitTargetPct} on={v => set('profitTargetPct', v)} step={5} />
        <Num label="Planned hold (days)" v={draft.holdDays} on={v => set('holdDays', v)} step={1} />
        <Num label="Time exit DTE (0 = off)" v={draft.timeExitDte} on={v => set('timeExitDte', v)} step={1} />
        <Field label="Profit-target action">
          <select value={draft.profitTargetMode} onChange={e => set('profitTargetMode', e.target.value as ExecConfig['profitTargetMode'])}>
            <option value="propose">propose</option>
            <option value="auto">auto</option>
          </select>
        </Field>
        <Field label="Time-exit action">
          <select value={draft.timeExitMode} onChange={e => set('timeExitMode', e.target.value as ExecConfig['timeExitMode'])}>
            <option value="propose">propose</option>
            <option value="auto">auto</option>
          </select>
        </Field>
      </Section>

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button onClick={onSave} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save changes'}</button>
        <button onClick={() => config && setDraft(toDraft(config))} disabled={busy || !dirty}>Revert</button>
        {dirty && <span style={{ alignSelf: 'center', fontSize: 12, color: 'var(--warning)' }}>unsaved changes</span>}
      </div>
    </div>
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function ErrBox({ msg, onClose }: { msg: string; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ background: '#3a1a1a', border: '1px solid var(--danger)', borderRadius: 6, padding: '8px 12px', marginBottom: 12, cursor: 'pointer' }}>
      {msg} <span style={{ float: 'right' }}>✕</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 16 }}>
      <div style={{ fontSize: 12, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 12, letterSpacing: 0.5 }}>{title}</div>
      {children}
    </div>
  );
}

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10, gap: 12 }}>
      <label style={{ width: 240, fontSize: 13 }}>
        {label}
        {help && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{help}</div>}
      </label>
      <div>{children}</div>
    </div>
  );
}

// Per-strategy composite floors: {strategy: floor} overrides the global Min composite score
// (composites aren't comparable across strategies). Blank = inherit the global floor.
// EntryPolicy reads minCompositeByStrategy[strategy] ?? minCompositeScore.
function StrategyFloors({
  strategies,
  floors,
  globalFloor,
  onChange,
}: {
  strategies: string[];
  floors: Record<string, number>;
  globalFloor: number;
  onChange: (m: Record<string, number>) => void;
}) {
  // Show every eligible strategy plus any existing override key (so stale overrides are visible/removable).
  const rows = Array.from(new Set([...strategies, ...Object.keys(floors)]));
  if (rows.length === 0) return null;
  const setFloor = (strategy: string, value: number | null) => {
    const next = { ...floors };
    if (value === null) delete next[strategy];
    else next[strategy] = value;
    onChange(next);
  };
  return (
    <Field label="Per-strategy composite floors" help={`Overrides the global floor for one strategy. Blank = inherit global (${globalFloor}).`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map(s => {
          const stale = !strategies.includes(s);
          return (
            <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 110, fontSize: 13, color: stale ? 'var(--warning)' : undefined }}>
                {s}{stale ? ' (not eligible)' : ''}
              </span>
              <input
                type="number"
                value={floors[s] ?? ''}
                placeholder={String(globalFloor)}
                step={1}
                onChange={e => setFloor(s, e.target.value === '' ? null : Number(e.target.value))}
                style={{ width: 100 }}
              />
            </div>
          );
        })}
      </div>
    </Field>
  );
}

function Num({ label, v, on, step, help }: { label: string; v: number; on: (v: number) => void; step?: number; help?: string }) {
  return (
    <Field label={label} help={help}>
      <input type="number" value={v} step={step ?? 1} onChange={e => on(Number(e.target.value))} style={{ width: 120 }} />
    </Field>
  );
}

function NumNullable({ label, v, on, help }: { label: string; v: number | null; on: (v: number | null) => void; help?: string }) {
  return (
    <Field label={label} help={help}>
      <input
        type="number"
        value={v ?? ''}
        onChange={e => on(e.target.value === '' ? null : Number(e.target.value))}
        style={{ width: 120 }}
      />
    </Field>
  );
}

export default ExecutionSettingsView;
