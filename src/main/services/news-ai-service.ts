// News & Research — Claude AI synthesis layer (Phase 2).
// Single-ticker on-demand and batch watchlist prompts.
// Falls back silently to null when no API key is configured.
// See Requirements/news-research.md FR-NR-26 to FR-NR-31.

import Anthropic from '@anthropic-ai/sdk';
import { secureGet } from './secure-settings.js';
import type { Database } from 'better-sqlite3';
import type { RawSignals, KeyFactor, NewsResearchBias } from '@shared/types.js';

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_HEADLINES_PER_TICKER = 6;
const MAX_MACRO_EVENTS = 4;

export interface AiTickerResult {
  ticker: string;
  impactScore: number;
  bias: NewsResearchBias;
  keyFactors: KeyFactor[];
  summary: string;
  model: string;
}

export class NewsAIService {
  constructor(private readonly db: Database) {}

  private getApiKey(): string | null {
    try {
      return secureGet(this.db, 'anthropicApiKey') || null;
    } catch {
      return null;
    }
  }

  // ── Single ticker ────────────────────────────────────────────────────────────

  async synthesizeTicker(
    ticker: string,
    signals: RawSignals,
  ): Promise<AiTickerResult | null> {
    const apiKey = this.getApiKey();
    if (!apiKey) return null;

    try {
      const client = new Anthropic({ apiKey });
      const payload = buildTickerPayload(ticker, signals);

      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 400,
        system: buildSystemPrompt(false),
        messages: [{ role: 'user', content: JSON.stringify(payload) }],
      });

      const text = response.content.find((b) => b.type === 'text')?.text ?? '';
      const parsed = parseTickerResponse(text, ticker);
      if (!parsed) return null;
      return { ...parsed, model: MODEL };
    } catch {
      return null;
    }
  }

  // ── Batch (one call for the whole watchlist) ─────────────────────────────────
  // Returns a map: ticker → AiTickerResult (only for tickers successfully analyzed).

  async synthesizeBatch(
    items: Array<{ ticker: string; signals: RawSignals }>,
  ): Promise<Map<string, AiTickerResult>> {
    const apiKey = this.getApiKey();
    if (!apiKey || items.length === 0) return new Map();

    try {
      const client = new Anthropic({ apiKey });
      const payloads = items.map(({ ticker, signals }) =>
        buildTickerPayload(ticker, signals)
      );

      // Token estimate: ~200 per ticker input + ~300 per output — safe for Haiku with up to 40 tickers.
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: Math.min(4096, items.length * 350 + 256),
        system: buildSystemPrompt(true),
        messages: [{ role: 'user', content: JSON.stringify(payloads) }],
      });

      const text = response.content.find((b) => b.type === 'text')?.text ?? '';
      return parseBatchResponse(text, MODEL);
    } catch {
      return new Map();
    }
  }
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildSystemPrompt(isBatch: boolean): string {
  const inputDesc = isBatch
    ? 'a JSON array where each element represents one ticker'
    : 'a JSON object representing one ticker';

  return `You are a financial research analyst identifying short-term price catalysts for retail options traders.

You will receive ${inputDesc}. For ${isBatch ? 'each ticker' : 'the ticker'}, produce:
- impactScore: 0.0–10.0 (how price-moving are current signals; higher = more urgent trader attention needed)
- bias: "bull" | "bear" | "mixed"
- keyFactors: array of up to 5 objects with keys: tag, direction, description
  - tag: EARNINGS | ANALYST | INSIDER | MACRO | NEWS | REGULATORY | SHORT_SQUEEZE | SEASONALITY
  - direction: "bull" | "bear" | "neutral"
  - description: max 15 words, specific and factual, no invented numbers
- summary: exactly 2 sentences. Sentence 1: the single most important thing happening now. Sentence 2: what to watch or the key risk.

Impact score guidance:
- 8–10: earnings imminent (≤5 days) OR major regulatory event OR insider cluster buy/sell
- 5–7: earnings in 6–21 days OR analyst upgrade/downgrade OR multiple bearish/bullish headlines
- 2–4: macro event in ≤14 days OR mixed sentiment news
- 0–1: no significant catalysts detected

Rules (strictly enforced):
- NEVER invent or estimate data not provided. If a field is null, do not reference it.
- Only flag MACRO if the event is within 14 days.
- Only include a NEWS factor if sentiment is explicitly "positive" or "negative" and the headline has clear price implications.
- Do NOT fabricate earnings dates, analyst firms, or price targets.
${isBatch
  ? '\nReturn ONLY a valid JSON array sorted by impactScore descending — no markdown, no code fences, no extra text:\n[{"ticker":"...","impactScore":0.0,"bias":"...","keyFactors":[...],"summary":"..."}]'
  : '\nReturn ONLY a valid JSON object — no markdown, no code fences, no extra text:\n{"ticker":"...","impactScore":0.0,"bias":"...","keyFactors":[...],"summary":"..."}'
}`;
}

// ─── Input payload builders ───────────────────────────────────────────────────

interface TickerPayload {
  t: string;  // ticker
  news: Array<{ h: string; s: string | null; d: string }>;
  macro: Array<{ d: string; e: string; dte: number }>;
  earnings?: { dte: number; epsEst: number | null } | null;
  analysts?: Array<{ firm: string; action: string; pt: number | null }>;
  insiders?: Array<{ name: string; type: 'buy' | 'sell'; value: number | null }>;
}

function buildTickerPayload(ticker: string, signals: RawSignals): TickerPayload {
  const today = new Date();

  const news = signals.newsHeadlines
    .slice(0, MAX_HEADLINES_PER_TICKER)
    .map((h) => ({
      h: h.headline.slice(0, 100),
      s: h.sentiment,
      d: h.publishedUtc.slice(0, 10),
    }));

  const macro = signals.macroEvents
    .filter((e) => {
      const dte = Math.round((new Date(e.date + 'T12:00:00Z').getTime() - today.getTime()) / 86_400_000);
      return dte >= 0 && dte <= 14;
    })
    .slice(0, MAX_MACRO_EVENTS)
    .map((e) => ({
      d: e.date,
      e: e.description,
      dte: Math.round((new Date(e.date + 'T12:00:00Z').getTime() - today.getTime()) / 86_400_000),
    }));

  const payload: TickerPayload = { t: ticker, news, macro };

  if (signals.earnings?.daysToEarnings !== null && signals.earnings?.daysToEarnings !== undefined && signals.earnings.daysToEarnings <= 30) {
    payload.earnings = {
      dte: signals.earnings.daysToEarnings,
      epsEst: signals.earnings.epsEstimate,
    };
  }

  if (signals.analystRatings.length > 0) {
    payload.analysts = signals.analystRatings.slice(0, 3).map((r) => ({
      firm: r.firm,
      action: r.action,
      pt: r.priceTargetTo,
    }));
  }

  if (signals.insiderTransactions.length > 0) {
    payload.insiders = signals.insiderTransactions.slice(0, 2).map((i) => ({
      name: i.filerName,
      type: i.transactionType,
      value: i.totalValue,
    }));
  }

  return payload;
}

// ─── Response parsers ─────────────────────────────────────────────────────────

interface RawAiEntry {
  ticker?: unknown;
  impactScore?: unknown;
  bias?: unknown;
  keyFactors?: unknown;
  summary?: unknown;
}

function parseEntry(entry: RawAiEntry, fallbackTicker: string): Omit<AiTickerResult, 'model'> | null {
  const ticker = (typeof entry.ticker === 'string' ? entry.ticker : fallbackTicker).toUpperCase();
  const impactScore = typeof entry.impactScore === 'number'
    ? Math.min(10, Math.max(0, entry.impactScore))
    : null;
  if (impactScore === null) return null;

  const bias = ['bull', 'bear', 'mixed'].includes(entry.bias as string)
    ? (entry.bias as NewsResearchBias)
    : 'mixed';

  const rawFactors = Array.isArray(entry.keyFactors) ? entry.keyFactors : [];
  const keyFactors: KeyFactor[] = rawFactors
    .slice(0, 5)
    .filter((f): f is Record<string, unknown> => f !== null && typeof f === 'object')
    .map((f): KeyFactor => ({
      tag: validTag(f['tag']) ?? 'NEWS',
      direction: validDir(f['direction']) ?? 'neutral',
      description: typeof f['description'] === 'string' ? f['description'].slice(0, 120) : '',
    }))
    .filter((f) => f.description.length > 0);

  const summary = typeof entry.summary === 'string' && entry.summary.length > 0
    ? entry.summary.slice(0, 400)
    : null;

  if (summary === null) return null;

  return { ticker, impactScore, bias, keyFactors, summary };
}

function parseTickerResponse(text: string, fallbackTicker: string): Omit<AiTickerResult, 'model'> | null {
  try {
    const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned) as RawAiEntry;
    return parseEntry(parsed, fallbackTicker);
  } catch {
    return null;
  }
}

function parseBatchResponse(text: string, model: string): Map<string, AiTickerResult> {
  const map = new Map<string, AiTickerResult>();
  try {
    const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const arr = JSON.parse(cleaned) as unknown[];
    if (!Array.isArray(arr)) return map;

    for (const item of arr) {
      if (typeof item !== 'object' || item === null) continue;
      const entry = item as RawAiEntry;
      const ticker = typeof entry.ticker === 'string' ? entry.ticker.toUpperCase() : null;
      if (!ticker) continue;
      const parsed = parseEntry(entry, ticker);
      if (parsed) map.set(ticker, { ...parsed, model });
    }
  } catch { /* return whatever we got */ }
  return map;
}

// ─── Validation helpers ───────────────────────────────────────────────────────

const VALID_TAGS = new Set<KeyFactor['tag']>([
  'EARNINGS', 'ANALYST', 'INSIDER', 'MACRO',
  'REGULATORY', 'SHORT_SQUEEZE', 'NEWS', 'SEASONALITY',
]);

function validTag(v: unknown): KeyFactor['tag'] | null {
  if (typeof v === 'string' && VALID_TAGS.has(v as KeyFactor['tag'])) return v as KeyFactor['tag'];
  return null;
}

function validDir(v: unknown): KeyFactor['direction'] | null {
  if (v === 'bull' || v === 'bear' || v === 'neutral') return v;
  return null;
}
