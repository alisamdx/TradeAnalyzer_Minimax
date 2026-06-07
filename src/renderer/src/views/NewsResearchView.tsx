// News & Research view — two-panel layout.
// Left: watchlist selector + ranked ticker list.
// Right: research dossier for selected ticker (Summary | Events | News tabs).
// See Requirements/news-research.md

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Watchlist, WatchlistItem, NewsResearchResult, NewsResearchBias, KeyFactor } from '@shared/types.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const BIAS_ICON: Record<NewsResearchBias, string> = {
  bull: '🟢',
  bear: '🔴',
  mixed: '🟡',
};
const BIAS_LABEL: Record<NewsResearchBias, string> = {
  bull: 'Bullish',
  bear: 'Bearish',
  mixed: 'Mixed',
};
const BIAS_COLOR: Record<NewsResearchBias, string> = {
  bull: '#3fb950',
  bear: '#f85149',
  mixed: '#d29922',
};

const TAG_LABEL: Record<KeyFactor['tag'], string> = {
  EARNINGS: 'EARNINGS',
  ANALYST: 'ANALYST',
  INSIDER: 'INSIDER',
  MACRO: 'MACRO',
  REGULATORY: 'REG',
  SHORT_SQUEEZE: 'SHORT',
  NEWS: 'NEWS',
  SEASONALITY: 'SEASONAL',
};

const DIR_COLOR: Record<KeyFactor['direction'], string> = {
  bull: '#3fb950',
  bear: '#f85149',
  neutral: '#8b949e',
};

const DIR_ICON: Record<KeyFactor['direction'], string> = {
  bull: '↑',
  bear: '↓',
  neutral: '→',
};

const EVENT_TYPE_COLOR: Record<string, string> = {
  EARNINGS:  '#a5d6ff',
  FOMC:      '#f97316',
  CPI:       '#d2a8ff',
  PPI:       '#d2a8ff',
  JOBS:      '#79c0ff',
  OTHER:     '#8b949e',
};

// ─── Component ───────────────────────────────────────────────────────────────

export function NewsResearchView() {
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [activeWlId, setActiveWlId] = useState<number | null>(null);
  const [wlTickers, setWlTickers] = useState<string[]>([]);
  const [resultsMap, setResultsMap] = useState<Map<string, NewsResearchResult>>(new Map());
  // tickerOrder: watchlist order normally; re-sorted by score after batch run
  const [tickerOrder, setTickerOrder] = useState<string[]>([]);
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'summary' | 'events' | 'news'>('summary');
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number; phase?: 'fetch' | 'synthesis' } | null>(null);
  const [fetchingTicker, setFetchingTicker] = useState<string | null>(null);
  const [lastBatchTime, setLastBatchTime] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const batchUnsubRef = useRef<(() => void) | null>(null);

  // ── Load watchlists on mount ────────────────────────────────────────────────
  useEffect(() => {
    window.api.watchlists.list()
      .then((lists) => {
        setWatchlists(lists);
        if (lists.length > 0) setActiveWlId(lists[0]!.id);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  // ── Load tickers when watchlist changes ────────────────────────────────────
  useEffect(() => {
    if (activeWlId === null) return;
    window.api.watchlists.items.list(activeWlId)
      .then((items: WatchlistItem[]) => {
        const tickers = items.map((i) => i.ticker);
        setWlTickers(tickers);
        setTickerOrder(tickers);
        setSelectedTicker(null);
        setResultsMap(new Map());
        setLastBatchTime(null);

        // Load any today-cached results for the watchlist tickers.
        loadCachedResults(tickers);
      })
      .catch((e) => setError((e as Error).message));
  }, [activeWlId]);

  const loadCachedResults = useCallback(async (tickers: string[]) => {
    const map = new Map<string, NewsResearchResult>();
    await Promise.all(
      tickers.map(async (ticker) => {
        try {
          const cached = await window.api.news.getCached(ticker);
          if (cached) map.set(ticker, cached);
        } catch { /* ignore individual failures */ }
      })
    );
    setResultsMap(map);
  }, []);

  // ── Select ticker — auto-fetch if no cache ─────────────────────────────────
  const selectTicker = useCallback(async (ticker: string) => {
    setSelectedTicker(ticker);
    setActiveTab('summary');

    if (resultsMap.has(ticker)) return; // already cached

    setFetchingTicker(ticker);
    try {
      const result = await window.api.news.fetchTicker(ticker);
      setResultsMap((prev) => new Map(prev).set(ticker, result));
    } catch (e) {
      setError(`Failed to fetch ${ticker}: ${(e as Error).message}`);
    } finally {
      setFetchingTicker(null);
    }
  }, [resultsMap]);

  // ── Refresh selected ticker ────────────────────────────────────────────────
  const refreshTicker = useCallback(async (ticker: string) => {
    setFetchingTicker(ticker);
    try {
      const result = await window.api.news.refreshTicker(ticker);
      setResultsMap((prev) => new Map(prev).set(ticker, result));
    } catch (e) {
      setError(`Refresh failed: ${(e as Error).message}`);
    } finally {
      setFetchingTicker(null);
    }
  }, []);

  // ── Batch run ──────────────────────────────────────────────────────────────
  const runBatch = useCallback(async (forceRefresh = false) => {
    if (batchRunning || wlTickers.length === 0) return;

    // If all cached today and not forced, confirm re-run.
    const today = new Date().toISOString().slice(0, 10);
    if (!forceRefresh) {
      const allCached = wlTickers.every(
        (t) => resultsMap.get(t)?.cacheDate === today
      );
      if (allCached) {
        const ok = await window.dialog.confirm({
          title: 'Re-run watchlist research?',
          message: `All ${wlTickers.length} tickers already analyzed today. Re-run and refresh all?`,
        });
        if (!ok) return;
        return runBatch(true);
      }
    }

    setBatchRunning(true);
    setBatchProgress({ done: 0, total: wlTickers.length });

    // Subscribe to progress events.
    batchUnsubRef.current?.();
    batchUnsubRef.current = window.api.news.onBatchProgress((p) => {
      setBatchProgress({ done: p.done, total: p.total, phase: p.phase });
    });

    try {
      const results = await window.api.news.fetchWatchlist(wlTickers, forceRefresh);

      // Update resultsMap with all returned results.
      setResultsMap(() => {
        const m = new Map<string, NewsResearchResult>();
        for (const r of results) m.set(r.ticker, r);
        return m;
      });

      // Re-sort ticker order by impact score.
      setTickerOrder(results.map((r) => r.ticker));

      // Auto-select #1 ranked ticker.
      if (results.length > 0 && results[0]) {
        setSelectedTicker(results[0].ticker);
        setActiveTab('summary');
      }

      setLastBatchTime(new Date().toLocaleTimeString());
    } catch (e) {
      setError(`Batch run failed: ${(e as Error).message}`);
    } finally {
      setBatchRunning(false);
      setBatchProgress(null);
      batchUnsubRef.current?.();
      batchUnsubRef.current = null;
    }
  }, [batchRunning, wlTickers, resultsMap]);

  // Cleanup on unmount.
  useEffect(() => () => { batchUnsubRef.current?.(); }, []);

  // ── Derived ────────────────────────────────────────────────────────────────
  const selectedResult = selectedTicker ? resultsMap.get(selectedTicker) ?? null : null;
  const today = new Date().toISOString().slice(0, 10);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="nr-root">
      {error && (
        <div className="error-toast" onClick={() => setError(null)}>
          {error} <span style={{ float: 'right', cursor: 'pointer' }}>✕</span>
        </div>
      )}

      {/* ── Left panel ──────────────────────────────────────────────────── */}
      <aside className="nr-left">
        {/* Header */}
        <div className="nr-left-header">
          <select
            className="wl-selector"
            value={activeWlId ?? ''}
            onChange={(e) => {
              const id = parseInt(e.target.value, 10);
              if (!isNaN(id)) setActiveWlId(id);
            }}
            disabled={watchlists.length === 0}
          >
            {watchlists.length === 0
              ? <option value="">No watchlists</option>
              : watchlists.map((w) => (
                  <option key={w.id} value={w.id}>{w.name} ({w.itemCount})</option>
                ))
            }
          </select>

          <button
            className="nr-run-btn"
            onClick={() => runBatch(false)}
            disabled={batchRunning || wlTickers.length === 0}
            title={`Analyze all ${wlTickers.length} tickers in this watchlist`}
          >
            {batchRunning
              ? batchProgress?.phase === 'synthesis'
                ? '🤖 AI synthesis…'
                : `⏳ ${batchProgress ? `${batchProgress.done}/${batchProgress.total}` : '…'}`
              : '▶ Run Watchlist'}
          </button>

          {lastBatchTime && !batchRunning && (
            <div className="nr-last-run">Last run: today {lastBatchTime}</div>
          )}
        </div>

        {/* Ticker list */}
        <div className="nr-ticker-list">
          {tickerOrder.length === 0 && (
            <div className="nr-empty">Select a watchlist to get started.</div>
          )}
          {tickerOrder.map((ticker, idx) => {
            const res = resultsMap.get(ticker);
            const isSelected = selectedTicker === ticker;
            const isFetching = fetchingTicker === ticker;
            const isStale = res && res.cacheDate !== today;
            const hasBatchRanking = lastBatchTime !== null;

            return (
              <div
                key={ticker}
                className={`nr-ticker-row ${isSelected ? 'selected' : ''} ${isFetching ? 'loading' : ''}`}
                onClick={() => selectTicker(ticker)}
                title={isStale ? `Data from ${res?.cacheDate} — click to refresh` : undefined}
              >
                <span className="nr-ticker-rank">
                  {hasBatchRanking ? `#${idx + 1}` : ''}
                </span>
                <span className="nr-ticker-sym">{ticker}</span>
                <span className="nr-ticker-bias">
                  {isFetching
                    ? <span style={{ color: '#8b949e', fontSize: 11 }}>…</span>
                    : res?.bias
                      ? <span style={{ color: BIAS_COLOR[res.bias], fontWeight: 600 }}>
                          {BIAS_ICON[res.bias]}
                        </span>
                      : <span style={{ color: '#30363d' }}>—</span>
                  }
                </span>
                <span className="nr-ticker-score">
                  {res?.impactScore != null
                    ? <span style={{ color: scoreColor(res.impactScore), fontWeight: 600 }}>
                        {res.impactScore.toFixed(1)}
                      </span>
                    : <span style={{ color: '#30363d' }}>—</span>
                  }
                </span>
                {isStale && <span className="nr-stale-dot" title="Stale" />}
              </div>
            );
          })}
        </div>
      </aside>

      {/* ── Right panel ─────────────────────────────────────────────────── */}
      <section className="nr-right">
        {!selectedTicker ? (
          <div className="nr-empty nr-empty-right">
            Select a ticker from the list, or click <strong>▶ Run Watchlist</strong> to analyze all.
          </div>
        ) : (
          <>
            {/* Dossier header */}
            <div className="nr-dossier-header">
              <div className="nr-dossier-title">
                <strong style={{ fontSize: 20 }}>{selectedTicker}</strong>
                {selectedResult?.bias && (
                  <span
                    className="nr-bias-badge"
                    style={{ background: BIAS_COLOR[selectedResult.bias] + '22', color: BIAS_COLOR[selectedResult.bias], border: `1px solid ${BIAS_COLOR[selectedResult.bias]}44` }}
                  >
                    {BIAS_ICON[selectedResult.bias]} {BIAS_LABEL[selectedResult.bias]}
                  </span>
                )}
                {selectedResult?.impactScore != null && (
                  <span className="nr-score-badge" style={{ color: scoreColor(selectedResult.impactScore) }}>
                    Impact {selectedResult.impactScore.toFixed(1)}/10
                  </span>
                )}
              </div>
              <div className="nr-dossier-meta">
                {fetchingTicker === selectedTicker
                  ? <span style={{ color: '#8b949e' }}>Fetching…</span>
                  : selectedResult
                    ? <>
                        {selectedResult.cacheDate !== today
                          ? <span style={{ color: '#d29922' }}>⚠ Data from {selectedResult.cacheDate}</span>
                          : <span style={{ color: '#8b949e' }}>
                              Updated {new Date(selectedResult.updatedAt).toLocaleTimeString()}
                            </span>
                        }
                        <button
                          className="nr-refresh-btn"
                          onClick={() => refreshTicker(selectedTicker)}
                          disabled={fetchingTicker === selectedTicker}
                          title="Force refresh from Polygon"
                        >
                          🔄 Refresh
                        </button>
                      </>
                    : null
                }
              </div>
            </div>

            {/* Tabs */}
            <div className="nr-tabs">
              {(['summary', 'events', 'news'] as const).map((tab) => (
                <button
                  key={tab}
                  className={`nr-tab ${activeTab === tab ? 'active' : ''}`}
                  onClick={() => setActiveTab(tab)}
                >
                  {tab === 'summary' ? '⚡ Summary' : tab === 'events' ? '📅 Events' : '📰 News'}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div className="nr-tab-content">
              {fetchingTicker === selectedTicker
                ? <div className="nr-loading">Fetching research data…</div>
                : !selectedResult
                  ? <div className="nr-empty">No data — will fetch automatically.</div>
                  : activeTab === 'summary'
                    ? <SummaryTab result={selectedResult} />
                    : activeTab === 'events'
                      ? <EventsTab result={selectedResult} />
                      : <NewsTab result={selectedResult} />
              }
            </div>
          </>
        )}
      </section>
    </div>
  );
}

// ─── Summary Tab ─────────────────────────────────────────────────────────────

function SummaryTab({ result }: { result: NewsResearchResult }) {
  const { keyFactors, summary, impactScore, bias } = result;

  return (
    <div className="nr-summary">
      {/* Impact score bar */}
      {impactScore != null && (
        <div className="nr-impact-row">
          <span className="nr-impact-label">Impact Score</span>
          <div className="nr-impact-bar-track">
            <div
              className="nr-impact-bar-fill"
              style={{ width: `${(impactScore / 10) * 100}%`, background: scoreColor(impactScore) }}
            />
          </div>
          <span className="nr-impact-value" style={{ color: scoreColor(impactScore) }}>
            {impactScore.toFixed(1)} / 10
          </span>
        </div>
      )}

      {/* Key factors */}
      {keyFactors.length > 0 ? (
        <div className="nr-factors">
          <div className="nr-section-label">Key Factors</div>
          {keyFactors.map((f, i) => (
            <div key={i} className="nr-factor-row">
              <span className="nr-factor-icon" style={{ color: DIR_COLOR[f.direction] }}>
                {DIR_ICON[f.direction]}
              </span>
              <span className="nr-factor-tag" style={{ color: DIR_COLOR[f.direction] }}>
                {TAG_LABEL[f.tag]}
              </span>
              <span className="nr-factor-desc">{f.description}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="nr-no-factors">
          No significant signals detected in the last 7 days.
        </div>
      )}

      {/* Summary / narrative */}
      {summary && (
        <div className="nr-narrative">
          <div className="nr-section-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Summary
            {result.aiModel
              ? <span className="nr-ai-badge">🤖 AI</span>
              : <span className="nr-rule-badge">Rule-based</span>
            }
          </div>
          <p>{summary}</p>
        </div>
      )}

      {/* Signal coverage note */}
      <div className="nr-coverage-note">
        {result.aiModel
          ? <span style={{ color: '#8b949e' }}>AI model: {result.aiModel}  ·  Data: 📰 News  ·  📅 Macro</span>
          : <>
              <span>Data: 📰 News  ·  📅 Macro</span>
              <span style={{ color: '#30363d' }}>  ·  Coming: 📊 Earnings  ·  🏦 Analyst  ·  📋 Insider</span>
            </>
        }
      </div>
    </div>
  );
}

// ─── Events Tab ──────────────────────────────────────────────────────────────

function EventsTab({ result }: { result: NewsResearchResult }) {
  const { events } = result;

  if (events.length === 0) {
    return <div className="nr-empty">No upcoming events in the next 60 days.</div>;
  }

  return (
    <div className="nr-events">
      <div className="nr-section-label">Upcoming Events</div>
      {events.map((ev, i) => {
        const dteColor = ev.daysUntil <= 7 ? '#f85149' : ev.daysUntil <= 21 ? '#d29922' : '#8b949e';
        const typeColor = EVENT_TYPE_COLOR[ev.type] ?? '#8b949e';
        return (
          <div key={i} className="nr-event-row">
            <div className="nr-event-date" style={{ color: dteColor }}>
              {ev.date}
              <span className="nr-event-dte" style={{ color: dteColor }}>
                {ev.daysUntil === 0 ? 'today' : `${ev.daysUntil}d`}
              </span>
            </div>
            <span
              className="nr-event-type"
              style={{ background: typeColor + '22', color: typeColor, border: `1px solid ${typeColor}44` }}
            >
              {ev.type}
            </span>
            <span className="nr-event-desc">{ev.description}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── News Tab ────────────────────────────────────────────────────────────────

function NewsTab({ result }: { result: NewsResearchResult }) {
  const { news } = result;

  if (news.length === 0) {
    return <div className="nr-empty">No recent news found for this ticker.</div>;
  }

  return (
    <div className="nr-news">
      <div className="nr-section-label">Recent News (7 days)</div>
      {news.map((item, i) => {
        const sentColor = item.sentiment === 'positive' ? '#3fb950'
          : item.sentiment === 'negative' ? '#f85149'
          : '#8b949e';
        const sentLabel = item.sentiment === 'positive' ? '↑ Pos'
          : item.sentiment === 'negative' ? '↓ Neg'
          : '→ Neu';
        const pubDate = item.publishedUtc
          ? new Date(item.publishedUtc).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
          : '';

        return (
          <div key={i} className="nr-news-row">
            <div className="nr-news-meta">
              <span className="nr-news-source">{item.source}</span>
              <span className="nr-news-date">{pubDate}</span>
              {item.sentiment && (
                <span className="nr-news-sentiment" style={{ color: sentColor }}>
                  {sentLabel}
                </span>
              )}
            </div>
            <a
              className="nr-news-headline"
              href={item.url}
              target="_blank"
              rel="noreferrer"
              title="Open article in browser"
            >
              {item.headline}
            </a>
          </div>
        );
      })}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 7) return '#f85149';
  if (score >= 4) return '#d29922';
  return '#3fb950';
}
