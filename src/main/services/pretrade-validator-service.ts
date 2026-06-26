// Pre-Trade Validator — orchestrates a verdict for a hand-built Payoff structure.
// Gathers live context (IV rank / direction via the Strategy Lab, earnings, ATR), runs the
// pure deterministic checks (pretrade-checks.ts), rolls up a verdict, suggests a better
// structure when flagged, and persists the validation. Decision-support only.
// see Requirements/PRE_TRADE_VALIDATOR_SPEC.md

import type { Database } from 'better-sqlite3';
import { StrategyLabService } from './strategy-lab-service.js';
import type { DataProvider } from './data-provider.js';
import type { OptionsProvider } from './options-provider.js';
import { runPretradeChecks, rollUpVerdict, pickSuggestedStructure } from './pretrade-checks.js';
import type {
  PretradeValidateInput,
  PretradeValidationResult,
  PretradeValidationRow,
  PretradeMarketContext,
  PretradeCheck,
  PretradeSuggestion,
  PretradeIntent,
  StrategyLabValidateResult,
} from '@shared/types.js';

const LAB_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min — "cache + refresh" per spec

export class PretradeValidatorService {
  private readonly lab: StrategyLabService;
  private readonly labCache = new Map<string, { at: number; result: StrategyLabValidateResult }>();

  constructor(dataProvider: DataProvider, optionsProvider: OptionsProvider) {
    this.lab = new StrategyLabService(dataProvider, optionsProvider);
  }

  async validate(db: Database, input: PretradeValidateInput): Promise<PretradeValidationResult> {
    const ticker = input.ticker?.trim().toUpperCase() || null;

    // ── Resolve lab context + candidate structures (cache + refresh) ──────────────
    let lab: StrategyLabValidateResult | null = null;
    let fromCache = false;
    if (ticker) {
      const cached = this.labCache.get(ticker);
      if (!input.refresh && cached && Date.now() - cached.at < LAB_CACHE_TTL_MS) {
        lab = cached.result;
        fromCache = true;
      } else {
        try {
          lab = await this.lab.validate(db, ticker);
          this.labCache.set(ticker, { at: Date.now(), result: lab });
        } catch {
          lab = null; // degrade gracefully — checks still run on legs + metrics
        }
      }
    }

    const context: PretradeMarketContext = {
      ivRank:        lab?.context.ivRank ?? null,
      ivPercentile:  lab?.context.ivPercentile ?? null,
      currentAtmIv:  lab?.context.currentAtmIv ?? null,
      directionBias: lab?.context.directionBias ?? null,
      ma20:          lab?.context.ma20 ?? null,
      ma50:          lab?.context.ma50 ?? null,
      atrPct:        ticker ? this.loadAtrPct(db, ticker) : null,
      nextEarningsDate: ticker ? this.loadNextEarnings(db, ticker) : null,
    };

    // ── Run checks + roll up verdict ──────────────────────────────────────────────
    const checks: PretradeCheck[] = runPretradeChecks({
      legs: input.legs,
      spot: input.spot,
      metrics: input.metrics,
      context,
      intent: input.intent,
    });
    const verdict = rollUpVerdict(checks);

    // ── Suggest a better structure when flagged ───────────────────────────────────
    let suggestion: PretradeSuggestion | null = null;
    if (verdict !== 'good' && lab) {
      suggestion = pickSuggestedStructure(lab.scores, input.intent, context.ivRank);
      // If the lab's best pick is the SAME structure the user already built, it's "no better
      // alternative" — not a different recommendation. Flag it so the UI doesn't present the
      // user's own trade back to them as an alternative.
      if (suggestion) suggestion.sameAsCurrent = suggestionMatchesInput(input.legs, suggestion);
    }

    this.persist(db, input, verdict, checks, suggestion);

    return { verdict, checks, context, suggestion, fromCache, generatedAt: new Date().toISOString() };
  }

  getHistory(db: Database, limit = 50): PretradeValidationRow[] {
    const rows = db.prepare(
      `SELECT * FROM pretrade_validations ORDER BY created_at DESC LIMIT ?`,
    ).all(limit) as Record<string, unknown>[];
    return rows.map(r => ({
      id:           r['id'] as number,
      ticker:       (r['ticker'] as string | null) ?? null,
      strategyName: (r['strategy_name'] as string | null) ?? '',
      spot:         (r['spot'] as number | null) ?? null,
      verdict:      r['verdict'] as PretradeValidationRow['verdict'],
      checks:       safeParse<PretradeCheck[]>(r['checks_json'] as string | null, []),
      suggestion:   safeParse<PretradeSuggestion | null>(r['suggestion_json'] as string | null, null),
      intent:       safeParse<PretradeIntent>(r['intent_json'] as string | null, { happyToOwn: null, purpose: 'income', multiQuarterThesis: false }),
      createdAt:    r['created_at'] as string,
    }));
  }

  // ── private ──────────────────────────────────────────────────────────────────

  private loadAtrPct(db: Database, ticker: string): number | null {
    const row = db.prepare(
      `SELECT atr_pct FROM technical_signals WHERE ticker = ? ORDER BY computed_at DESC LIMIT 1`,
    ).get(ticker) as { atr_pct: number | null } | undefined;
    return row?.atr_pct ?? null;
  }

  private loadNextEarnings(db: Database, ticker: string): string | null {
    const row = db.prepare(
      `SELECT report_date FROM earnings_calendar WHERE ticker = ? AND report_date >= date('now') ORDER BY report_date LIMIT 1`,
    ).get(ticker) as { report_date: string } | undefined;
    return row?.report_date ?? null;
  }

  private persist(
    db: Database,
    input: PretradeValidateInput,
    verdict: string,
    checks: PretradeCheck[],
    suggestion: PretradeSuggestion | null,
  ): void {
    db.prepare(`
      INSERT INTO pretrade_validations
        (ticker, strategy_name, spot, legs_json, intent_json, verdict, checks_json, suggestion_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.ticker?.trim().toUpperCase() || null,
      input.strategyName,
      input.spot,
      JSON.stringify(input.legs),
      JSON.stringify(input.intent),
      verdict,
      JSON.stringify(checks),
      suggestion ? JSON.stringify(suggestion) : null,
    );
  }
}

function safeParse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try { return JSON.parse(json) as T; } catch { return fallback; }
}

/** True when the suggestion's option legs are the same set as the user's built structure
 *  (same buy/sell + put/call + strike). Note PayoffLeg uses `side`/`type`; the suggestion uses
 *  `action`/`side`. Stock legs are ignored (suggestions are option structures). */
export function suggestionMatchesInput(inputLegs: PretradeValidateInput['legs'], sug: PretradeSuggestion): boolean {
  const opt = inputLegs.filter(l => l.type !== 'stock');
  if (opt.length === 0 || opt.length !== sug.legs.length) return false;
  const sig = (action: string, side: string, strike: number) => `${action}:${side}:${strike.toFixed(2)}`;
  const a = opt.map(l => sig(l.side, l.type, l.strike)).sort();
  const b = sug.legs.map(l => sig(l.action, l.side, l.strike)).sort();
  return a.every((x, i) => x === b[i]);
}
