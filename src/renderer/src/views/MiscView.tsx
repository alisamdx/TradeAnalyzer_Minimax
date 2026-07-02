// Landing screen for the less-used "Misc" tools, to keep the sidebar uncluttered.
// Each card pushes the target view onto the nav stack (so the user gets a ← Back).

export type MiscTarget = 'backtest' | 'testApi' | 'data' | 'ivHistory' | 'alerts' | 'constituents';

const TOOLS: { view: MiscTarget; icon: string; title: string; desc: string }[] = [
  { view: 'constituents', icon: '📇', title: 'Index Constituents', desc: 'S&P 500 & Russell 1000 lists with date added — see what the daily job adds.' },
  { view: 'alerts',    icon: '🔔', title: 'Alerts',    desc: 'Price, expiration, and delta alerts.' },
  { view: 'backtest',  icon: '🔁', title: 'Backtest',  desc: 'Simulate CSP / CC / Wheel strategies on historical data.' },
  { view: 'testApi',   icon: '🔬', title: 'Test API',  desc: 'Inspect raw provider responses (diagnostics).' },
  { view: 'data',      icon: '🗄️', title: 'Data Sync', desc: 'Manual universe and price refreshes.' },
  { view: 'ivHistory', icon: '🗓️', title: 'History',   desc: 'IV-history backfill and bulk price loading.' },
];

export function MiscView({ onNavigate }: { onNavigate: (view: MiscTarget) => void }) {
  return (
    <div style={{ padding: 16, maxWidth: 760 }}>
      <h2 style={{ marginTop: 0 }}>🗂️ Misc</h2>
      <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
        Occasional tools and diagnostics, grouped here to keep the sidebar tidy.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12, marginTop: 16 }}>
        {TOOLS.map(t => (
          <button
            key={t.view}
            onClick={() => onNavigate(t.view)}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 12, textAlign: 'left',
              background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8,
              padding: 16, cursor: 'pointer', color: 'var(--text)',
            }}
          >
            <span style={{ fontSize: 24, lineHeight: 1 }}>{t.icon}</span>
            <span>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{t.title}</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{t.desc}</div>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default MiscView;
