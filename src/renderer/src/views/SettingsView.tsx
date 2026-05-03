// SettingsView — EP-10 diagnostics panel + EP-11 backup/restore + rate limit config.
// FR-6: API key management, cache TTLs, rate limit settings.

import { useCallback, useEffect, useState } from 'react';
import type { AppSettings, DiagnosticsResult } from '@shared/types.js';

declare const __APP_VERSION__: string;

interface DiagnosticCheck {
  ok: boolean;
  message: string;
}

const RATE_LIMIT_PRESETS = [
  { label: 'Conservative', rpm: 50, hint: '5 req/6s — safest for large batches' },
  { label: 'Default', rpm: 100, hint: 'Default — leaves headroom for ad-hoc clicks' },
  { label: 'Aggressive', rpm: 250, hint: '250 req/min — only if Polygons limits are confirmed raised' }
] as const;

function CheckRow({ label, check }: { label: string; check: DiagnosticCheck }) {
  return (
    <tr className={check.ok ? '' : 'check-fail'}>
      <td>{label}</td>
      <td>
        <span className={`status-dot ${check.ok ? 'ok' : 'fail'}`} />
      </td>
      <td className="num">{check.message}</td>
    </tr>
  );
}

export function SettingsView() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsResult | null>(null);
  const [diagRunning, setDiagRunning] = useState(false);
  const [diagError, setDiagError] = useState<string | null>(null);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const [restoreMsg, setRestoreMsg] = useState<string | null>(null);

  // Load settings on mount.
  useEffect(() => {
    window.api.settings.getAll()
      .then(setSettings)
      .catch(() => setSettings({} as AppSettings))
      .finally(() => setLoading(false));
  }, []);

  // Load API key.
  useEffect(() => {
    window.api.settings.getApiKey()
      .then(setApiKey)
      .catch(() => setApiKey(''));
  }, []);

  const saveSettings = useCallback(async (partial: Partial<AppSettings>) => {
    if (!settings) return;
    try {
      await window.api.settings.setAll(partial);
      setSettings(prev => prev ? { ...prev, ...partial } : null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      setSaved(false);
    }
  }, [settings]);

  const saveApiKey = useCallback(async () => {
    try {
      await window.api.settings.setApiKey(apiKey);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // silently fail
    }
  }, [apiKey]);

  const runDiagnostics = useCallback(async () => {
    setDiagRunning(true);
    setDiagError(null);
    try {
      const result = await window.api.diagnostics.run();
      setDiagnostics(result);
    } catch (e) {
      setDiagError((e as Error).message);
    } finally {
      setDiagRunning(false);
    }
  }, []);

  const handleBackup = useCallback(async () => {
    try {
      const result = await window.api.settings.backup();
      if (result) setBackupMsg(result.message ?? 'Backup created.');
      else setBackupMsg('Backup cancelled.');
      setTimeout(() => setBackupMsg(null), 5000);
    } catch (e) {
      setBackupMsg(`Backup failed: ${(e as Error).message}`);
    }
  }, []);

  const handleRestore = useCallback(async () => {
    if (!window.confirm('Restore from backup? This will replace the current database. Restart the app after restore.')) return;
    try {
      const result = await window.api.settings.restore();
      if (result) setRestoreMsg(result.message ?? 'Restore applied.');
      else setRestoreMsg('Restore cancelled.');
      setTimeout(() => setRestoreMsg(null), 5000);
    } catch (e) {
      setRestoreMsg(`Restore failed: ${(e as Error).message}`);
    }
  }, []);

  if (loading || !settings) {
    return <div className="empty-state"><div className="spinner" /><p>Loading settings…</p></div>;
  }

  const overallColor = diagnostics
    ? diagnostics.overall === 'ok' ? '#3fb950' : diagnostics.overall === 'degraded' ? '#d29922' : '#f85149'
    : '#8b949e';

  return (
    <div className="settings-view">
      {saved && (
        <div className="status-toast">
          ✓ Settings saved
        </div>
      )}

      <div className="settings-layout">
        {/* ── Left: nav tabs ── */}
        <aside className="settings-nav">
          <button className="settings-tab active">General</button>
          <button className="settings-tab">API & Data</button>
          <button className="settings-tab">Cache & Limits</button>
          <button className="settings-tab">Diagnostics</button>
          <button className="settings-tab">Backup</button>
        </aside>

        {/* ── Right: panels ── */}
        <main className="settings-panel">

          {/* ── General ── */}
          <div className="settings-section">
            <h2>General Settings</h2>

            <div className="settings-row">
              <label>Rate Limit Preset</label>
              <div className="preset-btns">
                {RATE_LIMIT_PRESETS.map(p => (
                  <button
                    key={p.rpm}
                    className={`preset-btn ${settings.rateLimitRpm === p.rpm ? 'active' : ''}`}
                    onClick={() => saveSettings({ rateLimitRpm: p.rpm })}
                    title={p.hint}
                  >
                    {p.label}
                    <span className="preset-hint">{p.rpm} rpm</span>
                  </button>
                ))}
              </div>
              <p className="hint">Currently set to: <strong>{settings.rateLimitRpm} req/min</strong></p>
            </div>

            <div className="settings-row">
              <label>Log Retention</label>
              <div className="inline-inputs">
                <input
                  type="number"
                  min={7} max={365}
                  value={settings.logRetentionDays}
                  onChange={e => saveSettings({ logRetentionDays: parseInt(e.target.value) || 30 })}
                  style={{ width: 60 }}
                />
                <span>days</span>
              </div>
            </div>

            <div className="settings-row">
              <label>Error Log Retention</label>
              <div className="inline-inputs">
                <input
                  type="number"
                  min={7} max={365}
                  value={settings.errorLogRetentionDays}
                  onChange={e => saveSettings({ errorLogRetentionDays: parseInt(e.target.value) || 90 })}
                  style={{ width: 60 }}
                />
                <span>days</span>
              </div>
            </div>

            <div className="settings-row">
              <label>Auto-Backup</label>
              <div className="toggle-row">
                <input
                  type="checkbox"
                  checked={settings.autoBackupEnabled}
                  onChange={e => saveSettings({ autoBackupEnabled: e.target.checked })}
                />
                <span>Enable weekly auto-backup</span>
              </div>
            </div>
          </div>

          {/* ── API & Data ── */}
          <div className="settings-section">
            <h2>API &amp; Data</h2>

            <div className="settings-row">
              <label>Polygon API Key</label>
              <div className="api-key-row">
                <input
                  type={apiKeyVisible ? 'text' : 'password'}
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder="Enter your Polygon API key"
                  style={{ fontFamily: apiKeyVisible ? 'monospace' : 'inherit', width: 300 }}
                />
                <button className="tiny-btn" onClick={() => setApiKeyVisible(v => !v)}>
                  {apiKeyVisible ? 'Hide' : 'Show'}
                </button>
                <button className="run-btn" onClick={saveApiKey} style={{ padding: '4px 10px', fontSize: 11 }}>
                  Save
                </button>
              </div>
              <p className="hint">API key is stored in the database. Never logged or sent anywhere except Polygon.</p>
            </div>

            <div className="settings-row">
              <label>Open Logs Directory</label>
              <button className="tiny-btn" onClick={() => window.api.settings.openLogsDir()}>
                Open logs/
              </button>
            </div>
          </div>

          {/* ── Cache & Limits ── */}
          <div className="settings-section">
            <h2>Cache &amp; Rate Limits</h2>

            <div className="settings-row">
              <label>Quote Cache TTL</label>
              <div className="inline-inputs">
                <input
                  type="number"
                  min={10} max={3600}
                  value={settings.quoteCacheTtlSec}
                  onChange={e => saveSettings({ quoteCacheTtlSec: parseInt(e.target.value) || 60 })}
                  style={{ width: 80 }}
                />
                <span>seconds</span>
                <span className="hint">({(settings.quoteCacheTtlSec / 60).toFixed(1)} min)</span>
              </div>
            </div>

            <div className="settings-row">
              <label>Fundamentals Cache TTL</label>
              <div className="inline-inputs">
                <input
                  type="number"
                  min={3600} max={604800}
                  value={settings.fundamentalsCacheTtlSec}
                  onChange={e => saveSettings({ fundamentalsCacheTtlSec: parseInt(e.target.value) || 86_400 })}
                  style={{ width: 80 }}
                />
                <span>seconds</span>
                <span className="hint">({(settings.fundamentalsCacheTtlSec / 3600).toFixed(1)} hrs)</span>
              </div>
            </div>

            <div className="settings-row">
              <label>Options Chain Cache TTL</label>
              <div className="inline-inputs">
                <input
                  type="number"
                  min={60} max={3600}
                  value={settings.optionsCacheTtlSec}
                  onChange={e => saveSettings({ optionsCacheTtlSec: parseInt(e.target.value) || 300 })}
                  style={{ width: 80 }}
                />
                <span>seconds</span>
                <span className="hint">({(settings.optionsCacheTtlSec / 60).toFixed(1)} min)</span>
              </div>
            </div>
          </div>

          {/* ── Diagnostics ── */}
          <div className="settings-section">
            <h2>Diagnostics</h2>
            <p className="hint" style={{ marginBottom: 12 }}>
              Run self-check to verify all subsystems are operational. No data is sent off your machine.
            </p>

            <button
              className="run-btn"
              onClick={runDiagnostics}
              disabled={diagRunning}
              style={{ width: 'auto', padding: '6px 16px' }}
            >
              {diagRunning ? 'Running…' : '▶ Run Self-Check'}
            </button>

            {diagError && (
              <div className="error-toast" style={{ marginTop: 8 }}>{diagError}</div>
            )}

            {diagnostics && (
              <div className="diag-results">
                <div className="diag-header">
                  <h3>Subsystems</h3>
                  <span
                    className="verdict-badge"
                    style={{
                      background: `${overallColor}22`,
                      color: overallColor,
                      borderColor: overallColor
                    }}
                  >
                    {diagnostics.overall.toUpperCase()}
                  </span>
                </div>
                <table className="diag-table">
                  <thead>
                    <tr><th>Subsystem</th><th>Status</th><th>Details</th></tr>
                  </thead>
                  <tbody>
                    {Object.entries(diagnostics.checks).map(([key, check]) => (
                      <CheckRow key={key} label={key.replace(/_/g, ' ')} check={check} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="settings-row" style={{ marginTop: 16 }}>
              <label>App Version</label>
              <span className="num">v{typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.3.0'}</span>
            </div>
          </div>

          {/* ── Backup / Restore ── */}
          <div className="settings-section">
            <h2>Backup &amp; Restore</h2>

            <div className="backup-card">
              <h3>Backup Everything</h3>
              <p>Creates a backup folder containing the SQLite database, recent logs, and AI_CONTEXT.md. Keep backups in a safe location.</p>
              <button className="run-btn" onClick={handleBackup} style={{ width: 'auto', padding: '6px 16px' }}>
                Backup Everything
              </button>
              {backupMsg && <p className="hint" style={{ marginTop: 8 }}>{backupMsg}</p>}
            </div>

            <div className="backup-card" style={{ marginTop: 16 }}>
              <h3>Restore from Backup</h3>
              <p>Replace the current database with a backed-up SQLite file. The app will load the restored data on next launch.</p>
              <button className="run-btn danger" onClick={handleRestore} style={{ width: 'auto', padding: '6px 16px' }}>
                Restore from Backup
              </button>
              {restoreMsg && <p className="hint" style={{ marginTop: 8 }}>{restoreMsg}</p>}
            </div>
          </div>

        </main>
      </div>
    </div>
  );
}
