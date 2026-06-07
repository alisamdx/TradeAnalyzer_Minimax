// News & Research data fetcher.
// Fetches news headlines (Polygon), macro events (DB), and derives a rule-based
// impact score + key factors.  AI synthesis is added in Phase 2.
// See Requirements/news-research.md for spec.

import type { Database } from 'better-sqlite3';
import type {
  RawSignals,
  NewsResearchResult,
  KeyFactor,
  ResearchEvent,
  NewsHeadline,
  MacroEvent,
  NewsResearchBias,
  NewsBatchProgressEvent,
} from '@shared/types.js';

const POLYGON_BASE = 'https://api.polygon.io';

// ─── Polygon news response types ─────────────────────────────────────────────

interface PolygonNewsInsight {
  ticker: string;
  sentiment: 'positive' | 'negative' | 'neutral';
  sentiment_reasoning?: string;
}

interface PolygonNewsItem {
  id: string;
  publisher: { name: string };
  title: string;
  author?: string;
  published_utc: string;
  article_url: string;
  tickers?: string[];
  insights?: PolygonNewsInsight[];
}

interface PolygonNewsResponse {
  results?: PolygonNewsItem[];
  status?: string;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class NewsDataFetcher {
  constructor(
    private readonly getApiKey: () => string,
    private readonly db: Database,
  ) {}

  /**
   * Fetch raw signals for a single ticker.
   * One Polygon API call (news) + one DB query (macro events).
   */
  async fetchRawSignals(ticker: string): Promise<RawSignals> {
    const [newsHeadlines, macroEvents] = await Promise.all([
      this.fetchNews(ticker),
      this.getMacroEvents(60),
    ]);

    return {
      earnings: null,           // Phase 3: earnings calendar endpoint
      analystRatings: [],       // Phase 3: analyst ratings endpoint
      insiderTransactions: [],  // Phase 3: SEC EDGAR Form 4
      shortInterest: null,      // Phase 3: short interest endpoint
      macroEvents,
      newsHeadlines,
    };
  }

  /**
   * Derive key factors, events timeline, impact score and bias from raw signals.
   */
  deriveInsights(ticker: string, signals: RawSignals): {
    keyFactors: KeyFactor[];
    events: ResearchEvent[];
    impactScore: number;
    bias: NewsResearchBias;
    summary: string | null;
  } {
    const keyFactors = computeKeyFactors(signals);
    const events = computeEvents(signals);
    const impactScore = computeImpactScore(signals, keyFactors);
    const bias = computeBias(keyFactors);

    // Phase 1: plain rule-based summary.  Phase 2 replaces this with Claude AI.
    const summary = buildRuleSummary(ticker, keyFactors, signals);

    return { keyFactors, events, impactScore, bias, summary };
  }

  /** Build a full NewsResearchResult ready to persist and return. */
  async buildResult(ticker: string): Promise<NewsResearchResult> {
    const signals = await this.fetchRawSignals(ticker);
    const { keyFactors, events, impactScore, bias, summary } = this.deriveInsights(ticker, signals);
    const today = localTradingDate();

    return {
      ticker,
      cacheDate: today,
      impactScore,
      bias,
      keyFactors,
      summary,
      portfolioNote: null,   // Phase 2: inject open position context
      events,
      news: signals.newsHeadlines,
      rawSignals: signals,
      aiModel: null,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Fetch + process an entire watchlist.
   * Skip tickers that already have a valid today-cache.
   * Calls onProgress(event) after each ticker completes.
   */
  async fetchWatchlist(
    tickers: string[],
    onProgress: (e: NewsBatchProgressEvent) => void,
    forceRefresh = false,
  ): Promise<NewsResearchResult[]> {
    const today = localTradingDate();
    const results: NewsResearchResult[] = [];

    // Load all cached results for today first.
    const cachedMap = new Map<string, NewsResearchResult>();
    if (!forceRefresh) {
      for (const ticker of tickers) {
        const cached = this.readCache(ticker, today);
        if (cached) cachedMap.set(ticker, cached);
      }
    }

    let done = 0;
    const total = tickers.length;

    for (const ticker of tickers) {
      if (cachedMap.has(ticker)) {
        results.push(cachedMap.get(ticker)!);
        done++;
        onProgress({ done, total, ticker });
        continue;
      }

      try {
        const result = await this.buildResult(ticker);
        this.writeCache(result);
        results.push(result);
      } catch {
        // Graceful degrade: push a skeleton result rather than aborting the batch.
        results.push(buildSkeletonResult(ticker, today));
      }

      done++;
      onProgress({ done, total, ticker });
    }

    // Sort by impact score descending.
    results.sort((a, b) => (b.impactScore ?? 0) - (a.impactScore ?? 0));
    return results;
  }

  // ─── Cache helpers ──────────────────────────────────────────────────────────

  readCache(ticker: string, date: string): NewsResearchResult | null {
    try {
      const row = this.db.prepare(
        'SELECT * FROM news_research_cache WHERE ticker = ? AND cache_date = ?'
      ).get(ticker, date) as NewsResearchCacheRow | undefined;

      if (!row) return null;
      return cacheRowToResult(row);
    } catch {
      return null;
    }
  }

  writeCache(result: NewsResearchResult): void {
    try {
      const rawDataJson = JSON.stringify(result.rawSignals);
      const aiSummaryJson = JSON.stringify({
        keyFactors: result.keyFactors,
        summary: result.summary,
        portfolioNote: result.portfolioNote,
      });

      this.db.prepare(`
        INSERT INTO news_research_cache
          (ticker, cache_date, raw_data, ai_summary, impact_score, bias, ai_model, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(ticker, cache_date) DO UPDATE SET
          raw_data     = excluded.raw_data,
          ai_summary   = excluded.ai_summary,
          impact_score = excluded.impact_score,
          bias         = excluded.bias,
          ai_model     = excluded.ai_model,
          updated_at   = datetime('now')
      `).run(
        result.ticker,
        result.cacheDate,
        rawDataJson,
        aiSummaryJson,
        result.impactScore,
        result.bias,
        result.aiModel,
      );
    } catch (err) {
      console.error('[NewsDataFetcher] writeCache error:', err);
    }
  }

  // ─── Macro events ───────────────────────────────────────────────────────────

  getMacroEvents(daysAhead = 60): MacroEvent[] {
    const today = localTradingDate();
    const future = new Date();
    future.setDate(future.getDate() + daysAhead);
    const futureStr = future.toISOString().slice(0, 10);

    const rows = this.db.prepare(
      `SELECT event_date AS date, event_type AS type, description
       FROM macro_events
       WHERE event_date >= ? AND event_date <= ?
       ORDER BY event_date ASC`
    ).all(today, futureStr) as MacroEvent[];

    return rows;
  }

  // ─── Polygon news fetch ─────────────────────────────────────────────────────

  private async fetchNews(ticker: string): Promise<NewsHeadline[]> {
    try {
      const apiKey = this.getApiKey();
      if (!apiKey) return [];

      // Fetch last 7 days of news.
      const from = new Date();
      from.setDate(from.getDate() - 7);
      const fromStr = from.toISOString().slice(0, 10);

      const url = new URL(`${POLYGON_BASE}/v2/reference/news`);
      url.searchParams.set('ticker', ticker);
      url.searchParams.set('limit', '12');
      url.searchParams.set('sort', 'published_utc');
      url.searchParams.set('order', 'desc');
      url.searchParams.set('published_utc.gte', fromStr);
      url.searchParams.set('apiKey', apiKey);

      const response = await fetch(url.toString());
      if (!response.ok) return [];

      const data = (await response.json()) as PolygonNewsResponse;
      const items = data.results ?? [];

      return items.map((item): NewsHeadline => {
        // Find sentiment insight for this ticker specifically.
        const insight = item.insights?.find(
          (ins) => ins.ticker.toUpperCase() === ticker.toUpperCase()
        ) ?? item.insights?.[0];

        return {
          headline: item.title,
          source: item.publisher?.name ?? 'Unknown',
          publishedUtc: item.published_utc,
          url: item.article_url,
          sentiment: insight?.sentiment ?? null,
        };
      });
    } catch {
      return [];
    }
  }
}

// ─── Local helpers ────────────────────────────────────────────────────────────

function localTradingDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function dteDays(dateStr: string): number {
  const target = new Date(dateStr + 'T12:00:00Z');
  const now = new Date();
  return Math.round((target.getTime() - now.getTime()) / 86_400_000);
}

function computeKeyFactors(signals: RawSignals): KeyFactor[] {
  const factors: KeyFactor[] = [];

  // Earnings proximity
  if (signals.earnings?.daysToEarnings !== null && signals.earnings?.daysToEarnings !== undefined) {
    const dte = signals.earnings.daysToEarnings;
    if (dte >= 0 && dte <= 30) {
      const epsPart = signals.earnings.epsEstimate != null
        ? ` — EPS est $${signals.earnings.epsEstimate.toFixed(2)}`
        : '';
      factors.push({
        tag: 'EARNINGS',
        direction: 'neutral',
        description: `Earnings in ${dte} day${dte === 1 ? '' : 's'}${epsPart}`,
      });
    }
  }

  // Analyst ratings (most recent 2)
  for (const r of signals.analystRatings.slice(0, 2)) {
    const lower = r.action.toLowerCase();
    const isUpgrade = lower.includes('upgrade') || lower.includes('initiate') || lower.includes('reiterate');
    const isDowngrade = lower.includes('downgrade');
    const dir: 'bull' | 'bear' | 'neutral' = isUpgrade ? 'bull' : isDowngrade ? 'bear' : 'neutral';
    const ptPart = r.priceTargetTo != null ? ` PT $${r.priceTargetTo}` : '';
    factors.push({
      tag: 'ANALYST',
      direction: dir,
      description: `${r.firm}: ${r.action}${ptPart}`,
    });
  }

  // Insider transactions (largest by value)
  const insiders = [...signals.insiderTransactions]
    .sort((a, b) => (b.totalValue ?? 0) - (a.totalValue ?? 0))
    .slice(0, 1);
  for (const ins of insiders) {
    const dir: 'bull' | 'bear' = ins.transactionType === 'buy' ? 'bull' : 'bear';
    const valPart = ins.totalValue != null
      ? ` $${(ins.totalValue / 1_000_000).toFixed(1)}M`
      : '';
    factors.push({
      tag: 'INSIDER',
      direction: dir,
      description: `${ins.filerName}${ins.filerTitle ? ` (${ins.filerTitle})` : ''}: ${ins.transactionType}${valPart}`,
    });
  }

  // Nearby macro events (within 14 days)
  for (const ev of signals.macroEvents.slice(0, 3)) {
    const dte = dteDays(ev.date);
    if (dte >= 0 && dte <= 14) {
      factors.push({
        tag: 'MACRO',
        direction: 'neutral',
        description: `${ev.description} in ${dte} day${dte === 1 ? '' : 's'}`,
      });
    }
  }

  // News headlines with strong sentiment (max 2)
  const sentimentNews = signals.newsHeadlines
    .filter((h) => h.sentiment === 'positive' || h.sentiment === 'negative')
    .slice(0, 2);
  for (const h of sentimentNews) {
    factors.push({
      tag: 'NEWS',
      direction: h.sentiment === 'positive' ? 'bull' : 'bear',
      description: h.headline.length > 80 ? h.headline.slice(0, 77) + '…' : h.headline,
    });
  }

  return factors.slice(0, 5);
}

function computeEvents(signals: RawSignals): ResearchEvent[] {
  const events: ResearchEvent[] = [];

  // Earnings
  if (signals.earnings?.earningsDate) {
    const dte = dteDays(signals.earnings.earningsDate);
    events.push({
      date: signals.earnings.earningsDate,
      type: 'EARNINGS',
      description: `Earnings${signals.earnings.epsEstimate != null ? ` — est EPS $${signals.earnings.epsEstimate.toFixed(2)}` : ''}`,
      daysUntil: dte,
    });
  }

  // Macro events (next 60 days)
  for (const ev of signals.macroEvents) {
    const dte = dteDays(ev.date);
    if (dte >= 0) {
      events.push({
        date: ev.date,
        type: ev.type,
        description: ev.description,
        daysUntil: dte,
      });
    }
  }

  // Sort by date ascending
  events.sort((a, b) => a.daysUntil - b.daysUntil);
  return events;
}

function computeImpactScore(signals: RawSignals, keyFactors: KeyFactor[]): number {
  let score = 0;

  // Earnings proximity — max 3.0
  const dte = signals.earnings?.daysToEarnings;
  if (dte !== null && dte !== undefined && dte >= 0 && dte <= 30) {
    score += 3.0 * (1 - dte / 30);
  }

  // Analyst activity (within 7 days) — max 1.5
  const recentAnalyst = signals.analystRatings.filter((r) => {
    return (Date.now() - new Date(r.date).getTime()) < 7 * 86_400_000;
  });
  score += Math.min(1.5, recentAnalyst.length * 0.75);

  // Insider (within 14 days) — max 1.0
  const recentInsider = signals.insiderTransactions.filter((i) => {
    return (Date.now() - new Date(i.filingDate).getTime()) < 14 * 86_400_000;
  });
  if (recentInsider.length > 0) score += 1.0;

  // Macro proximity (≤7 days) — max 1.0
  const nearMacro = signals.macroEvents.filter((e) => {
    const d = dteDays(e.date);
    return d >= 0 && d <= 7;
  });
  if (nearMacro.length > 0) score += 1.0;

  // News sentiment volume — max 1.0
  const bullNews = keyFactors.filter((f) => f.tag === 'NEWS' && f.direction === 'bull').length;
  const bearNews = keyFactors.filter((f) => f.tag === 'NEWS' && f.direction === 'bear').length;
  score += Math.min(1.0, (bullNews + bearNews) * 0.5);

  // Short squeeze — max 0.5
  const shortPct = signals.shortInterest?.shortPctFloat ?? 0;
  if (shortPct > 20) score += 0.5;

  return Math.min(10, Math.round(score * 10) / 10);
}

function computeBias(keyFactors: KeyFactor[]): NewsResearchBias {
  const bulls = keyFactors.filter((f) => f.direction === 'bull').length;
  const bears = keyFactors.filter((f) => f.direction === 'bear').length;
  if (bulls - bears >= 2) return 'bull';
  if (bears - bulls >= 2) return 'bear';
  return 'mixed';
}

function buildRuleSummary(ticker: string, factors: KeyFactor[], signals: RawSignals): string | null {
  if (factors.length === 0 && signals.newsHeadlines.length === 0) return null;

  const lines: string[] = [];
  if (factors.length > 0) {
    lines.push(`${ticker} has ${factors.length} active signal${factors.length > 1 ? 's' : ''}.`);
  }
  const macroNear = signals.macroEvents.filter((e) => dteDays(e.date) <= 7 && dteDays(e.date) >= 0);
  if (macroNear.length > 0) {
    lines.push(`Macro risk: ${macroNear.map((e) => e.description).join(', ')} upcoming.`);
  }
  if (signals.newsHeadlines.filter((h) => h.sentiment === 'negative').length >= 2) {
    lines.push('Multiple bearish news headlines detected in the past 7 days.');
  }
  if (signals.newsHeadlines.filter((h) => h.sentiment === 'positive').length >= 2) {
    lines.push('Multiple positive news headlines detected in the past 7 days.');
  }
  return lines.join(' ') || null;
}

function buildSkeletonResult(ticker: string, cacheDate: string): NewsResearchResult {
  return {
    ticker,
    cacheDate,
    impactScore: null,
    bias: null,
    keyFactors: [],
    summary: null,
    portfolioNote: null,
    events: [],
    news: [],
    rawSignals: {
      earnings: null,
      analystRatings: [],
      insiderTransactions: [],
      shortInterest: null,
      macroEvents: [],
      newsHeadlines: [],
    },
    aiModel: null,
    updatedAt: new Date().toISOString(),
  };
}

// ─── DB row shape ─────────────────────────────────────────────────────────────

interface NewsResearchCacheRow {
  id: number;
  ticker: string;
  cache_date: string;
  raw_data: string;
  ai_summary: string | null;
  impact_score: number | null;
  bias: string | null;
  ai_model: string | null;
  updated_at: string;
}

function cacheRowToResult(row: NewsResearchCacheRow): NewsResearchResult {
  const rawSignals = JSON.parse(row.raw_data) as RawSignals;
  const aiSummary = row.ai_summary
    ? (JSON.parse(row.ai_summary) as { keyFactors: KeyFactor[]; summary: string | null; portfolioNote: string | null })
    : null;

  return {
    ticker: row.ticker,
    cacheDate: row.cache_date,
    impactScore: row.impact_score,
    bias: (row.bias as NewsResearchBias | null),
    keyFactors: aiSummary?.keyFactors ?? [],
    summary: aiSummary?.summary ?? null,
    portfolioNote: aiSummary?.portfolioNote ?? null,
    events: computeEvents(rawSignals),
    news: rawSignals.newsHeadlines,
    rawSignals,
    aiModel: row.ai_model,
    updatedAt: row.updated_at,
  };
}
