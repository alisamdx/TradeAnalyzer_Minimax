import React, { useState } from 'react';
import { StrategyLabView } from './StrategyLabView.js';
import { LeapsCspView } from './LeapsCspView.js';
import { CollaredLeapsView } from './CollaredLeapsView.js';

type Tab = 'lab' | 'leaps' | 'collared';

interface Props {
  initialTicker?: string | null;
  initialSlug?: string | null;
}

export function StrategyLabShellView({ initialTicker, initialSlug }: Props = {}) {
  const [tab, setTab] = useState<Tab>('lab');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      <div className="portfolio-tabs">
        <button className={`tab-btn ${tab === 'lab' ? 'active' : ''}`} onClick={() => setTab('lab')}>
          🔬 Strategy Lab
        </button>
        <button className={`tab-btn ${tab === 'leaps' ? 'active' : ''}`} onClick={() => setTab('leaps')}>
          ⚡ LEAPS
        </button>
        <button className={`tab-btn ${tab === 'collared' ? 'active' : ''}`} onClick={() => setTab('collared')}>
          🛡️ Collared LEAPS
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {tab === 'lab' && <StrategyLabView initialTicker={initialTicker} initialSlug={initialSlug} />}
        {tab === 'leaps' && <LeapsCspView />}
        {tab === 'collared' && <CollaredLeapsView />}
      </div>
    </div>
  );
}
