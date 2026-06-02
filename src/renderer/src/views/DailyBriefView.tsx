// Daily Intelligence Brief view — shows today's trade shortlist by strategy.
// see Requirements/DAILY_INTELLIGENCE_BRIEF.md §6

import { useState, useEffect, useCallback } from 'react';
import type { DailyBriefEntry, BriefPick, ScoringStrategy } from '@shared/types.js';

const STRATEGY_LABELS: Record<ScoringStrategy, string> = {
  wheel:   '🎡  Wheel — CSP / Covered Call',
  bullish: '🐂  Bullish — Call Spread / Long Call',
  bearish: '🐻  Bearish — Put Spread / Long Put',
  income:  '💰  Options Income — Strangle / Iron Condor',
  buy:     '📈  Buy / Swing Trade',
};

// Human-readable labels for signal keys shown in chips
const SIGNAL_LABELS: Record<string, string> = {
  ivRank:           'IV Rank',
  premiumYield:     'Prem Yield',
  premiumRiskRatio: 'Prem/Risk',
  fundamentalScore: 'Fundamentals',
  fundamentalWeakness: 'Fund. Weakness',
  technicalNeutral: 'RSI Neutral',
  rsiMomentum:      'RSI',
  rsiOverbought:    'RSI',
  optionLiquidity:  'Liq.',
  trendStrength:    'Trend Strength',
  downtrendScore:   'Downtrend',
  trendNeutral:     'Trend Neutral',
  earningsGrowth:   'Earnings',
  priceMomentumPct: '52w Momentum',
  priceDecayPct:    '52w Decay',
  breakoutScore:    'Breakout',
  buySignalScore:   'Buy Signal',
};

const STRATEGY_ORDER: ScoringStrategy[] = ['wheel', 'bullish', 'bearish', 'income', 'buy'];

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short',
  });
}

function isStale(validUntil: string): boolean {
  return new Date() > new Date(validUntil);
}

function scoreBg(score: number): string {
  if (score >= 75) return '#1f6b38';
  if (score >= 55) return '#7a5400';
  return '#7a1f1a';
}
function scoreColor(score: number): string {
  if (score >= 75) return '#3fb950';
  if (score >= 55) return '#e3a008';
  return '#f85149';
}

function fmtRaw(raw: number | null, key: string): string {
  if (raw === null) return '—';
  // Percentage signals
  if (['ivRank','fundamentalScore','fundamentalWeakness','trendStrength',
       'downtrendScore','earningsGrowth','breakoutScore','buySignalScore',
       'rsiMomentum','rsiOverbought','technicalNeutral'].includes(key)) {
    return raw.toFixed(0);
  }
  // Momentum — show sign + 1dp
  if (key === 'priceMomentumPct' || key === 'priceDecayPct') {
    return (raw >= 0 ? '+' : '') + raw.toFixed(1) + '%';
  }
  // Liquidity score 0–10
  if (key === 'optionLiquidity') return raw.toFixed(1) + '/10';
  // Yield/return — annualised %
  if (key === 'premiumYield' || key === 'premiumRiskRatio') return raw.toFixed(1) + '%';
  return raw.toFixed(1);
}

function TopSignals({ signals }: { signals: BriefPick['signals'] }) {
  const entries = Object.entries(signals)
    .filter(([, v]) => !v.missing && v.raw !== null)
    .sort((a, b) => (b[1].weight * b[1].normalized) - (a[1].weight * a[1].normalized))
    .slice(0, 4);

  if (entries.length === 0) return null;
  return (
    <div className="pick-signals">
      {entries.map(([key, v]) => (
        <span key={key} className="signal-chip">
          <span className="signal-chip-label">{SIGNAL_LABELS[key] ?? key}</span>
          <span className="signal-chip-value">{fmtRaw(v.raw, key)}</span>
        </span>
      ))}
    </div>
  );
}

function PickCard({
  pick,
  onGoToStrategyLab,
}: {
  pick: BriefPick;
  onGoToStrategyLab: (ticker: string) => void;
}) {
  return (
    <div className="brief-pick-card">
      {/* Left column — rank bubble */}
      <div className="pick-rank-col">
        <span className="pick-rank">#{pick.rank}</span>
      </div>

      {/* Right column — all content */}
      <div>
        {/* Row 1: ticker · score · validated · lab btn */}
        <div className="pick-main-row">
          <span className="pick-ticker">{pick.ticker}</span>
          <span
            className="pick-score-badge"
            style={{ background: scoreBg(pick.compositeScore), color: scoreColor(pick.compositeScore) }}
          >
            Score {pick.compositeScore.toFixed(1)}
          </span>
          {pick.validated
            ? <span className="pick-badge validated">✓ Validated</span>
            : <span className="pick-badge unvalidated">Unvalidated</span>
          }
          <button className="pick-lab-btn" onClick={() => onGoToStrategyLab(pick.ticker)}>
            Strategy Lab →
          </button>
        </div>

        {/* Row 2: top signal chips */}
        <TopSignals signals={pick.signals} />

        {/* Row 3: AI rationale */}
        {pick.aiRationale
          ? <p className="pick-rationale">{pick.aiRationale}</p>
          : <p className="pick-rationale muted">AI reasoning unavailable</p>
        }
      </div>
    </div>
  );
}

function StrategySection({
  strategy,
  entry,
  collapsed,
  onToggle,
  onGoToStrategyLab,
}: {
  strategy: ScoringStrategy;
  entry: DailyBriefEntry | undefined;
  collapsed: boolean;
  onToggle: () => void;
  onGoToStrategyLab: (ticker: string) => void;
}) {
  return (
    <div className="brief-strategy-section">
      <button className="strategy-header" onClick={onToggle}>
        <span className="strategy-label">{STRATEGY_LABELS[strategy]}</span>
        {entry && (
          <span className="strategy-pick-count">
            {entry.picks.length} pick{entry.picks.length !== 1 ? 's' : ''}
          </span>
        )}
        <span className="strategy-chevron">{collapsed ? '▶' : '▼'}</span>
      </button>
      {!collapsed && (
        <div className="strategy-picks">
          {!entry || entry.picks.length === 0 ? (
            <div className="empty-section">No picks for this strategy today.</div>
          ) : (
            entry.picks.map(pick => (
              <PickCard
                key={pick.ticker}
                pick={pick}
                onGoToStrategyLab={onGoToStrategyLab}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

interface DailyBriefViewProps {
  onGoToStrategyLab?: (ticker: string) => void;
}

export function DailyBriefView({ onGoToStrategyLab }: DailyBriefViewProps) {
  const [briefs, setBriefs] = useState<DailyBriefEntry[]>([]);
  const [history, setHistory] = useState<DailyBriefEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [selectedHistoryId, setSelectedHistoryId] = useState<number | null>(null);

  const [collapsed, setCollapsed] = useState<Record<ScoringStrategy, boolean>>(() => {
    try {
      const saved = localStorage.getItem('brief-collapsed');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const latest = await window.api.scoring.getLatestBrief();
      setBriefs(latest as DailyBriefEntry[]);
    } catch (err) {
      console.error('[brief] load error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const h = await window.api.scoring.getBriefHistory(30);
      setHistory(h as DailyBriefEntry[]);
    } catch (err) {
      console.error('[brief] history error:', err);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (showHistory) loadHistory();
  }, [showHistory, loadHistory]);

  // Listen for batch progress completion to auto-refresh
  useEffect(() => {
    const unsub = window.api.batch.onProgress(evt => {
      if (evt.jobId === 'daily-intelligence-brief') {
        if (evt.message?.includes('Brief generated')) {
          setRunning(false);
          load();
        }
      }
    });
    return () => unsub();
  }, [load]);

  const handleRunNow = async () => {
    setRunning(true);
    try {
      await window.api.batch.runNow('daily-intelligence-brief');
    } catch (err) {
      console.error('[brief] run error:', err);
      setRunning(false);
    }
  };

  const toggleCollapse = (strategy: ScoringStrategy) => {
    setCollapsed(prev => {
      const next = { ...prev, [strategy]: !prev[strategy] };
      localStorage.setItem('brief-collapsed', JSON.stringify(next));
      return next;
    });
  };

  const goToStrategyLab = (ticker: string) => {
    onGoToStrategyLab?.(ticker);
  };

  // Pick displayed briefs — either latest or selected historical
  const displayedBriefs = selectedHistoryId !== null
    ? history.filter(b => {
        // Show all strategies for the same run group (same generated_at prefix day)
        const sel = history.find(h => h.id === selectedHistoryId);
        if (!sel) return false;
        return b.generatedAt.slice(0, 10) === sel.generatedAt.slice(0, 10);
      })
    : briefs;

  const latestEntry = displayedBriefs[0];
  const generatedAt = latestEntry?.generatedAt ?? null;
  const validUntil = latestEntry?.validUntil ?? null;
  const stale = validUntil ? isStale(validUntil) : false;

  const briefMap = new Map(displayedBriefs.map(b => [b.strategy as ScoringStrategy, b]));

  // Unique history dates for the dropdown
  const historyDates = Array.from(new Map(
    history.map(h => [h.generatedAt.slice(0, 10), h])
  ).values()).slice(0, 30);

  return (
    <div className="view daily-brief-view">
      <div className="brief-header toolbar">
        <h2>Daily Intelligence Brief</h2>
        {generatedAt && (
          <span className="meta">{fmtDate(generatedAt)}</span>
        )}
        {stale && (
          <span className="stale-badge">This brief is from a previous session — run to refresh</span>
        )}
        <div style={{ flex: 1 }} />
        <button
          className="brief-history-btn"
          onClick={() => { setShowHistory(p => !p); setSelectedHistoryId(null); }}
        >
          History {showHistory ? '▲' : '▼'}
        </button>
        <button
          className="brief-run-btn"
          onClick={handleRunNow}
          disabled={running}
        >
          {running ? 'Running…' : 'Run Now'}
        </button>
      </div>

      {showHistory && history.length > 0 && (
        <div className="brief-history-bar">
          {historyDates.map(h => (
            <button
              key={h.id}
              className={`history-date-btn ${selectedHistoryId !== null && h.generatedAt.slice(0, 10) === history.find(x => x.id === selectedHistoryId)?.generatedAt.slice(0, 10) ? 'active' : ''}`}
              onClick={() => setSelectedHistoryId(selectedHistoryId === h.id ? null : h.id)}
            >
              {h.generatedAt.slice(0, 10)}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="empty">Loading…</div>
      ) : displayedBriefs.length === 0 ? (
        <div className="brief-empty-state">
          <p>No brief yet for today.</p>
          <p className="meta">Run the Daily Intelligence Brief job to generate your first shortlist.</p>
          <button onClick={handleRunNow} disabled={running}>
            {running ? 'Running…' : 'Run Now'}
          </button>
        </div>
      ) : (
        <div className="brief-strategies">
          {STRATEGY_ORDER.map(strategy => (
            <StrategySection
              key={strategy}
              strategy={strategy}
              entry={briefMap.get(strategy)}
              collapsed={collapsed[strategy] ?? false}
              onToggle={() => toggleCollapse(strategy)}
              onGoToStrategyLab={goToStrategyLab}
            />
          ))}
        </div>
      )}
    </div>
  );
}
