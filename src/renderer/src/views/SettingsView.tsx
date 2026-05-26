// SettingsView — EP-10 diagnostics panel + EP-11 backup/restore + rate limit config.
// FR-6: API key management, cache TTLs, rate limit settings.

import React, { useCallback, useEffect, useState } from 'react';
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

interface SettingsViewProps {
  /** Set when app startup detected an expired/missing E*Trade token. */
  etradeWarning?: string | null;
  /** Called when the user dismisses the warning (e.g. after successful connect). */
  onEtradeWarningDismiss?: () => void;
}

// ─── E*Trade connection panel ──────────────────────────────────────────────────

type ETradeStep = 'idle' | 'awaiting-verifier';
type ETradeConnStatus = 'unknown' | 'ok' | 'expired' | 'no_token' | 'no_credentials' | 'error';

interface ETradeConnectPanelProps {
  warning?: string | null;
  onConnected?: () => void;
}

function ETradeConnectPanel({ warning, onConnected }: ETradeConnectPanelProps) {
  const [consumerKey, setConsumerKey]     = useState('');
  const [consumerSecret, setConsumerSecret] = useState('');
  const [verifier, setVerifier]           = useState('');
  const [step, setStep]                   = useState<ETradeStep>('idle');
  const [authUrl, setAuthUrl]             = useState('');
  const [busy, setBusy]                   = useState(false);
  const [connStatus, setConnStatus]       = useState<ETradeConnStatus>('unknown');
  const [statusMsg, setStatusMsg]         = useState<string | null>(null);
  const [error, setError]                 = useState<string | null>(null);
  const [credsSaved, setCredsSaved]       = useState(false);

  // Load existing consumer key + connection status on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await window.api.etrade.getStatus();
        setConsumerKey(res.consumerKey ?? '');
        const check = await window.api.etrade.checkConnection();
        setConnStatus(check.status);
      } catch { /* ignore */ }
    })();
  }, []);

  const saveCredentials = async () => {
    if (!consumerKey.trim() || !consumerSecret.trim()) {
      setError('Enter both Consumer Key and Consumer Secret.');
      return;
    }
    setBusy(true); setError(null);
    try {
      await window.api.etrade.saveCredentials(consumerKey.trim(), consumerSecret.trim());
      setCredsSaved(true);
      setConnStatus('no_token');
      setStep('idle');
      setTimeout(() => setCredsSaved(false), 2500);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const startAuth = async () => {
    setBusy(true); setError(null);
    try {
      const res = await window.api.etrade.startAuth();
      setAuthUrl(res.authUrl);
      setStep('awaiting-verifier');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const submitVerifier = async () => {
    if (!verifier.trim()) { setError('Paste the verifier code from the E*Trade browser page.'); return; }
    setBusy(true); setError(null);
    try {
      await window.api.etrade.submitVerifier(verifier.trim());
      setConnStatus('ok');
      setStep('idle');
      setVerifier('');
      setStatusMsg('Connected successfully!');
      setTimeout(() => setStatusMsg(null), 3000);
      onConnected?.();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const renewToken = async () => {
    setBusy(true); setError(null);
    try {
      await window.api.etrade.renewToken();
      setConnStatus('ok');
      setStatusMsg('Token renewed.');
      setTimeout(() => setStatusMsg(null), 2500);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const disconnect = async () => {
    await window.api.etrade.disconnect();
    setConnStatus('no_token');
    setStep('idle');
  };

  const statusBadge = () => {
    if (connStatus === 'ok')             return <span style={{ color: '#4ade80', fontWeight: 600 }}>✓ Connected</span>;
    if (connStatus === 'expired')        return <span style={{ color: '#f87171', fontWeight: 600 }}>✗ Token expired — reconnect required</span>;
    if (connStatus === 'no_token')       return <span style={{ color: '#fbbf24', fontWeight: 600 }}>⚠ Not authenticated</span>;
    if (connStatus === 'no_credentials') return <span style={{ color: '#f87171', fontWeight: 600 }}>✗ No credentials saved</span>;
    if (connStatus === 'error')          return <span style={{ color: '#f87171', fontWeight: 600 }}>✗ Connection error</span>;
    return <span style={{ color: '#9ca3af' }}>Checking…</span>;
  };

  const inp: React.CSSProperties = { width: '100%', padding: '6px 10px', background: '#1a1d23', border: '1px solid #333', borderRadius: 4, color: '#cdd6f4', fontSize: 13 };
  const btn = (color = '#3b82f6'): React.CSSProperties => ({ padding: '6px 14px', background: color, border: 'none', borderRadius: 4, color: '#fff', fontWeight: 600, fontSize: 12, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1 });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* Startup warning banner */}
      {warning && (
        <div style={{ padding: '10px 14px', background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.35)', borderRadius: 6, color: '#fbbf24', fontSize: 13, lineHeight: 1.5 }}>
          ⚠ {warning}
        </div>
      )}

      {/* Connection status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ color: '#9ca3af', fontSize: 13 }}>Status:</span>
        {statusBadge()}
        {statusMsg && <span style={{ color: '#4ade80', fontSize: 12 }}>{statusMsg}</span>}
      </div>

      {/* Credentials */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label style={{ fontSize: 12, color: '#9ca3af' }}>Consumer Key</label>
        <input
          style={inp}
          placeholder="From developer.etrade.com"
          value={consumerKey}
          onChange={e => setConsumerKey(e.target.value)}
        />
        <label style={{ fontSize: 12, color: '#9ca3af' }}>Consumer Secret</label>
        <input
          style={inp}
          type="password"
          placeholder="Consumer Secret"
          value={consumerSecret}
          onChange={e => setConsumerSecret(e.target.value)}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button style={btn()} disabled={busy} onClick={saveCredentials}>Save Credentials</button>
          {credsSaved && <span style={{ color: '#4ade80', fontSize: 12 }}>✓ Saved</span>}
        </div>
        <p style={{ fontSize: 11, color: '#6b7280', margin: 0 }}>
          API keys from <strong style={{ color: '#9ca3af' }}>developer.etrade.com</strong> → My Applications. Stored encrypted on this machine only.
        </p>
      </div>

      {/* OAuth connect */}
      {step === 'idle' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button style={btn('#22c55e')} disabled={busy} onClick={startAuth}>
            {busy ? 'Opening browser…' : '🔗 Connect — Open E*Trade Login'}
          </button>
          <span style={{ fontSize: 11, color: '#6b7280' }}>
            Browser will open → log in → E*Trade shows a verifier code → paste it below.
          </span>
        </div>
      )}

      {step === 'awaiting-verifier' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {authUrl && (
            <span style={{ fontSize: 11, color: '#6b7280' }}>
              Auth page opened. Log in to E*Trade, approve access, and paste the verifier code:
            </span>
          )}
          <input
            style={inp}
            placeholder="Paste verifier code here…"
            value={verifier}
            onChange={e => setVerifier(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submitVerifier()}
            autoFocus
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={btn('#22c55e')} disabled={busy} onClick={submitVerifier}>Submit Code</button>
            <button style={btn('#6b7280')} disabled={busy} onClick={() => { setStep('idle'); setVerifier(''); }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Renew / Disconnect (only when we have a token) */}
      {(connStatus === 'ok' || connStatus === 'expired') && (
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button style={btn('#6366f1')} disabled={busy} onClick={renewToken}>Renew Token</button>
          <button style={btn('#6b7280')} disabled={busy} onClick={disconnect}>Disconnect</button>
        </div>
      )}

      {error && <p style={{ color: '#f87171', fontSize: 12, margin: 0 }}>{error}</p>}
    </div>
  );
}

// ─── Main SettingsView ─────────────────────────────────────────────────────────

export function SettingsView({ etradeWarning, onEtradeWarningDismiss }: SettingsViewProps = {}) {
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

  // If we arrived here due to an E*Trade warning, default to the API & Data tab
  const [activeTab, setActiveTab] = useState(etradeWarning ? 'API & Data' : 'General');
  const [optionsProvider, setOptionsProvider] = useState<'polygon' | 'etrade'>('polygon');
  const [optionsProviderSaved, setOptionsProviderSaved] = useState(false);

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

  // Load options provider setting.
  useEffect(() => {
    window.api.settings.getOptionsProvider()
      .then(setOptionsProvider)
      .catch(() => setOptionsProvider('polygon'));
  }, []);

  const saveOptionsProvider = useCallback(async (provider: 'polygon' | 'etrade') => {
    try {
      await window.api.settings.setOptionsProvider(provider);
      setOptionsProvider(provider);
      setOptionsProviderSaved(true);
      setTimeout(() => setOptionsProviderSaved(false), 2500);
    } catch { /* silently fail */ }
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
    const confirmed = await window.dialog.confirm({
      title: 'Restore from backup',
      message: 'Restore from backup? This will replace the current database. Restart the app after restore.'
    });
    if (!confirmed) return;
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
          <button className={`settings-tab ${activeTab === 'General' ? 'active' : ''}`} onClick={() => setActiveTab('General')}>General</button>
          <button className={`settings-tab ${activeTab === 'API & Data' ? 'active' : ''}`} onClick={() => setActiveTab('API & Data')}>API & Data</button>
          <button className={`settings-tab ${activeTab === 'Cache & Limits' ? 'active' : ''}`} onClick={() => setActiveTab('Cache & Limits')}>Cache & Limits</button>
          <button className={`settings-tab ${activeTab === 'Keyboard' ? 'active' : ''}`} onClick={() => setActiveTab('Keyboard')}>Keyboard</button>
          <button className={`settings-tab ${activeTab === 'Diagnostics' ? 'active' : ''}`} onClick={() => setActiveTab('Diagnostics')}>Diagnostics</button>
          <button className={`settings-tab ${activeTab === 'Backup' ? 'active' : ''}`} onClick={() => setActiveTab('Backup')}>Backup</button>
        </aside>

        {/* ── Right: panels ── */}
        <main className="settings-panel">

          {/* ── General ── */}
          {activeTab === 'General' && (
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

            <div className="settings-row">
              <label>Theme</label>
              <div className="preset-btns">
                <button
                  className={`preset-btn ${settings.theme === 'dark' ? 'active' : ''}`}
                  onClick={() => saveSettings({ theme: 'dark' })}
                >
                  Dark
                </button>
                <button
                  className={`preset-btn ${settings.theme === 'light' ? 'active' : ''}`}
                  onClick={() => saveSettings({ theme: 'light' })}
                >
                  Light
                </button>
              </div>
            </div>

            <div className="settings-row">
              <label>Sound Alerts</label>
              <div className="toggle-row">
                <input
                  type="checkbox"
                  checked={settings.soundAlertsEnabled}
                  onChange={e => saveSettings({ soundAlertsEnabled: e.target.checked })}
                />
                <span>Enable sound alerts for triggered alerts</span>
              </div>
            </div>

            <div className="settings-row">
              <label>Default Screener Index</label>
              <select
                value={settings.defaultScreenerIndex}
                onChange={e => saveSettings({ defaultScreenerIndex: e.target.value as AppSettings['defaultScreenerIndex'] })}
                style={{ width: 200 }}
              >
                <option value="sp500">S&P 500</option>
                <option value="russell1000">Russell 1000</option>
                <option value="both">Both (Combined)</option>
              </select>
            </div>

            <div className="settings-row" style={{ marginTop: '20px' }}>
               <button className="run-btn" onClick={() => saveSettings({})} style={{ width: 'auto', padding: '6px 16px' }}>Save Settings</button>
            </div>
          </div>
          )}

          {/* ── API & Data ── */}
          {activeTab === 'API & Data' && (
          <div className="settings-section">
            <h2>API &amp; Data</h2>

            {/* Options Data Source */}
            <div className="settings-row">
              <label>Options Data Source</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <select
                  value={optionsProvider}
                  onChange={e => saveOptionsProvider(e.target.value as 'polygon' | 'etrade')}
                  style={{ width: 200 }}
                >
                  <option value="polygon">Polygon.io</option>
                  <option value="etrade">E*Trade</option>
                </select>
                {optionsProviderSaved && (
                  <span style={{ color: '#4ade80', fontSize: 13 }}>
                    ✓ Saved — restart to apply
                  </span>
                )}
              </div>
              <p className="hint">
                Controls which provider is used for options chains, IV, and the LEAPS+CSP screener.
                <strong> Restart the app after changing.</strong>
              </p>
            </div>

            {/* E*Trade Connection — shown whenever E*Trade is selected, or when a warning is present */}
            {(optionsProvider === 'etrade' || etradeWarning) && (
              <div className="settings-row" style={{ borderLeft: '3px solid #6366f1', paddingLeft: 14 }}>
                <label style={{ color: '#a5b4fc', marginBottom: 10, display: 'block' }}>E*Trade Connection</label>
                <ETradeConnectPanel
                  warning={etradeWarning}
                  onConnected={onEtradeWarningDismiss}
                />
              </div>
            )}

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
              </div>
              <p className="hint">Used for stock quotes, fundamentals, and historical bars. Never logged or sent anywhere except Polygon.</p>
            </div>

            <div className="settings-row">
              <label>Open Logs Directory</label>
              <button className="tiny-btn" onClick={() => window.api.settings.openLogsDir()}>
                Open logs/
              </button>
            </div>

            <div className="settings-row" style={{ marginTop: '20px' }}>
               <button className="run-btn" onClick={saveApiKey} style={{ width: 'auto', padding: '6px 16px' }}>Save Settings</button>
            </div>
          </div>
          )}

          {/* ── Cache & Limits ── */}
          {activeTab === 'Cache & Limits' && (
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
            
            <div className="settings-row" style={{ marginTop: '20px' }}>
               <button className="run-btn" onClick={() => saveSettings({})} style={{ width: 'auto', padding: '6px 16px' }}>Save Settings</button>
            </div>
          </div>
          )}

          {/* ── Diagnostics ── */}
          {activeTab === 'Diagnostics' && (
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
          )}

          {/* ── Keyboard Shortcuts ── */}
          {activeTab === 'Keyboard' && (
          <div className="settings-section">
            <h2>Keyboard Shortcuts</h2>
            <p className="hint" style={{ marginBottom: 16 }}>
              Configure keyboard shortcuts for quick navigation. Changes apply immediately.
            </p>

            <div className="settings-row">
              <label>Refresh Quotes</label>
              <input
                type="text"
                value={settings.keyboardShortcuts?.refreshQuotes ?? 'F5'}
                onChange={e => saveSettings({
                  keyboardShortcuts: { ...settings.keyboardShortcuts, refreshQuotes: e.target.value }
                })}
                style={{ width: 120, fontFamily: 'monospace' }}
                placeholder="F5"
              />
            </div>

            <div className="settings-row">
              <label>Run Analysis</label>
              <input
                type="text"
                value={settings.keyboardShortcuts?.runAnalysis ?? 'Ctrl+Shift+A'}
                onChange={e => saveSettings({
                  keyboardShortcuts: { ...settings.keyboardShortcuts, runAnalysis: e.target.value }
                })}
                style={{ width: 120, fontFamily: 'monospace' }}
                placeholder="Ctrl+Shift+A"
              />
            </div>

            <div className="settings-row">
              <label>Open Screener</label>
              <input
                type="text"
                value={settings.keyboardShortcuts?.openScreener ?? 'Ctrl+Shift+S'}
                onChange={e => saveSettings({
                  keyboardShortcuts: { ...settings.keyboardShortcuts, openScreener: e.target.value }
                })}
                style={{ width: 120, fontFamily: 'monospace' }}
                placeholder="Ctrl+Shift+S"
              />
            </div>

            <div className="settings-row">
              <label>Open Portfolio</label>
              <input
                type="text"
                value={settings.keyboardShortcuts?.openPortfolio ?? 'Ctrl+Shift+P'}
                onChange={e => saveSettings({
                  keyboardShortcuts: { ...settings.keyboardShortcuts, openPortfolio: e.target.value }
                })}
                style={{ width: 120, fontFamily: 'monospace' }}
                placeholder="Ctrl+Shift+P"
              />
            </div>

            <div className="settings-row">
              <label>Open Briefing</label>
              <input
                type="text"
                value={settings.keyboardShortcuts?.openBriefing ?? 'Ctrl+Shift+B'}
                onChange={e => saveSettings({
                  keyboardShortcuts: { ...settings.keyboardShortcuts, openBriefing: e.target.value }
                })}
                style={{ width: 120, fontFamily: 'monospace' }}
                placeholder="Ctrl+Shift+B"
              />
            </div>

            <p className="hint" style={{ marginTop: 16 }}>
              <strong>Note:</strong> Keyboard shortcuts require app restart to take effect.
            </p>
          </div>
          )}

          {/* ── Backup / Restore ── */}
          {activeTab === 'Backup' && (
          <div className="settings-section">
            <h2>Backup &amp; Restore</h2>

            <div className="backup-card">
              <h3>Backup Everything</h3>
              <p>Creates a backup folder containing the SQLite database, recent logs, and .ai/AI_CONTEXT.md. Keep backups in a safe location.</p>
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
          )}

        </main>
      </div>
    </div>
  );
}
