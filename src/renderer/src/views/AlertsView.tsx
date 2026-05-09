// AlertsView - Priority 8: Alerts System Management
// Displays active and triggered alerts, provides form to create new ones.

import { useCallback, useEffect, useState } from 'react';

type AlertType = 'price' | 'expiration' | 'delta';

interface Alert {
  id: number;
  ticker: string;
  alertType: AlertType;
  priceThreshold: number | null;
  priceCondition: 'above' | 'below' | null;
  daysBeforeExpiration: number | null;
  deltaThreshold: number | null;
  deltaDirection: 'above' | 'below' | null;
  isActive: boolean;
  isTriggered: boolean;
  triggeredAt: string | null;
  playSound: boolean;
  createdAt: string;
  updatedAt: string;
}

export function AlertsView() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  
  // Form State
  const [showAddForm, setShowAddForm] = useState(false);
  const [formTicker, setFormTicker] = useState('');
  const [formType, setFormType] = useState<AlertType>('price');
  const [formPriceThreshold, setFormPriceThreshold] = useState('');
  const [formPriceCondition, setFormPriceCondition] = useState<'above'|'below'>('above');
  const [formPlaySound, setFormPlaySound] = useState(true);

  const loadAlerts = useCallback(async () => {
    try {
      const result = await window.api.alerts.list(false);
      if (result.success && result.data) {
        setAlerts(result.data);
      } else {
        setError(result.error || 'Failed to load alerts');
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    loadAlerts();
  }, [loadAlerts]);

  const resetForm = () => {
    setFormTicker('');
    setFormType('price');
    setFormPriceThreshold('');
    setFormPriceCondition('above');
    setFormPlaySound(true);
  };

  const handleAddAlert = async () => {
    if (!formTicker || (formType === 'price' && !formPriceThreshold)) {
      setError('Ticker and threshold are required');
      return;
    }

    try {
      const result = await window.api.alerts.create({
        ticker: formTicker.toUpperCase(),
        alertType: formType,
        priceThreshold: formType === 'price' ? parseFloat(formPriceThreshold) : undefined,
        priceCondition: formType === 'price' ? formPriceCondition : undefined,
        playSound: formPlaySound
      });

      if (result.success) {
        setStatusMsg('Alert created successfully');
        setShowAddForm(false);
        resetForm();
        loadAlerts();
      } else {
        setError(result.error || 'Failed to create alert');
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      const result = await window.api.alerts.delete(id);
      if (result.success) {
        setStatusMsg('Alert deleted');
        loadAlerts();
      } else {
        setError(result.error || 'Failed to delete alert');
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleReset = async (id: number) => {
    try {
      const result = await window.api.alerts.resetTriggered(id);
      if (result.success) {
        setStatusMsg('Alert reset');
        loadAlerts();
      } else {
        setError(result.error || 'Failed to reset alert');
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="alerts-view" style={{ padding: '20px' }}>
      {/* ── Error / status ── */}
      {error && (
        <div className="error-toast" onClick={() => setError(null)}>
          {error} <span style={{ float: 'right', cursor: 'pointer' }}>✕</span>
        </div>
      )}
      {statusMsg && !error && (
        <div className="status-toast" onClick={() => setStatusMsg(null)}>
          {statusMsg} <span style={{ float: 'right', cursor: 'pointer' }}>✕</span>
        </div>
      )}

      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2>Alerts Management</h2>
        <button onClick={() => setShowAddForm(!showAddForm)}>
          {showAddForm ? '✕ Cancel' : '+ New Alert'}
        </button>
      </div>

      {/* ── Add Alert Form ── */}
      {showAddForm && (
        <div className="form-card" style={{ background: 'var(--surface)', padding: '20px', borderRadius: '8px', marginBottom: '20px', border: '1px solid var(--border)' }}>
          <h3>Create Price Alert</h3>
          <div style={{ display: 'flex', gap: '15px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <label style={{ display: 'block', marginBottom: '5px' }}>Ticker</label>
              <input
                type="text"
                value={formTicker}
                onChange={e => setFormTicker(e.target.value)}
                placeholder="AAPL"
                style={{ width: '100px' }}
              />
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: '5px' }}>Condition</label>
              <select value={formPriceCondition} onChange={e => setFormPriceCondition(e.target.value as 'above'|'below')}>
                <option value="above">Crosses Above</option>
                <option value="below">Crosses Below</option>
              </select>
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: '5px' }}>Price Target</label>
              <input
                type="number"
                step="0.01"
                value={formPriceThreshold}
                onChange={e => setFormPriceThreshold(e.target.value)}
                placeholder="150.00"
                style={{ width: '120px' }}
              />
            </div>
            <div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '5px', height: '32px' }}>
                <input
                  type="checkbox"
                  checked={formPlaySound}
                  onChange={e => setFormPlaySound(e.target.checked)}
                />
                Play Sound
              </label>
            </div>
            <button onClick={handleAddAlert} style={{ background: 'var(--primary)', color: 'white' }}>
              Save Alert
            </button>
          </div>
        </div>
      )}

      {/* ── Alerts List ── */}
      <div className="alerts-list">
        {alerts.length === 0 ? (
          <div className="empty" style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
            No alerts configured.
          </div>
        ) : (
          <table className="items-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Status</th>
                <th>Ticker</th>
                <th>Condition</th>
                <th>Target Price</th>
                <th>Created At</th>
                <th>Triggered At</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map(alert => (
                <tr key={alert.id} style={{ opacity: alert.isActive ? 1 : 0.6 }}>
                  <td>
                    {alert.isTriggered ? (
                      <span style={{ color: '#e74c3c', fontWeight: 'bold' }}>Triggered</span>
                    ) : alert.isActive ? (
                      <span style={{ color: '#2ecc71' }}>Active</span>
                    ) : (
                      <span>Inactive</span>
                    )}
                  </td>
                  <td><strong>{alert.ticker}</strong></td>
                  <td>Price {alert.priceCondition}</td>
                  <td className="num">${alert.priceThreshold?.toFixed(2)}</td>
                  <td>{new Date(alert.createdAt).toLocaleString()}</td>
                  <td>{alert.triggeredAt ? new Date(alert.triggeredAt).toLocaleString() : '—'}</td>
                  <td>
                    {alert.isTriggered && (
                      <button onClick={() => handleReset(alert.id)} style={{ marginRight: '8px' }}>
                        Reset
                      </button>
                    )}
                    <button onClick={() => handleDelete(alert.id)} className="danger">
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
