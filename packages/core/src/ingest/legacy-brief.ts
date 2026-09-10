import type { IngestContext, IngestedRowSpec } from '../collector/capture.js';

/**
 * Ingestion for the legacy brief hand-off — 04 §8, Q6, Q19 category 5.
 *
 * **The payload is archived as a `meta_response` from provider `host_app`**, so
 * a `legacy_*` row has the same provenance guarantee as any raw row (AC-1) and
 * the whole hand-off replays like any other capture (AC-4). The existing
 * application is not a data vendor, but it *is* a source, and `host_app` is the
 * enum value that says so without pretending otherwise.
 *
 * **Every candidate the brief scored is recorded, including the ones it
 * rejected** (P5). That is the entire reason this contract exists: the existing
 * app's `daily_briefs` stores only survivors, so it cannot answer whether its
 * own ranking was any good — the losers are the control group, and a pipeline
 * that discards them has thrown away the only data that could settle it.
 */

export interface LegacyHandoffLeg {
  readonly osiSymbol: string;
  readonly right: 'call' | 'put';
  readonly strike: number;
  readonly expiration: string;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly mid: number | null;
  /** A **fraction** here. The builder converts from the old app's percentage once. */
  readonly iv: number | null;
  readonly delta: number | null;
  readonly openInterest: number | null;
  readonly volume: number | null;
  /**
   * Whether the provider reported a volume at all.
   *
   * This is how the old app's `leg.volume ?? 0` is stopped at the border. It
   * turned "not reported" into "did not trade" on 23 of 250 stored legs, and a
   * liquidity gate then rejected them for it (D7).
   */
  readonly volumeReported: boolean;
  readonly liquidityScore: number | null;
}

export interface LegacyHandoffCandidate {
  readonly ticker: string;
  readonly mode: 'wheel' | 'buy' | 'options' | 'bullish' | 'bearish';
  readonly consideredRank: number;
  readonly survived: boolean;
  readonly compositeScore: number | null;
  readonly finalDisposition: string | null;
  readonly gates: readonly {
    readonly name: string;
    readonly passed: boolean;
    readonly testedValue: number | null;
    readonly threshold: number | null;
    readonly reason: string | null;
  }[];
  readonly signals: readonly {
    readonly key: string;
    readonly rawValue: number | null;
    readonly normalized: number | null;
    readonly weight: number;
    readonly enabled: boolean;
  }[];
  readonly legs: readonly LegacyHandoffLeg[];
  readonly critic?: {
    readonly verdict: string;
    readonly rationale: string;
    readonly contextJson: string;
    readonly model: string;
  };
}

export interface LegacyBriefHandoff {
  readonly legacyAppVersion: string;
  readonly briefId: number | null;
  readonly tradingDate: string;
  readonly slot: 'morning' | 'after_close';
  readonly emailedAt: string | null;
  readonly candidates: readonly LegacyHandoffCandidate[];
  readonly dice?: {
    readonly eligibleCount: number;
    readonly selectedTicker: string | null;
    readonly selectionRule: string;
    readonly eligibilityTraceJson: string;
  };
}

/**
 * A status-column pair (P3): a value and the reason it is what it is.
 *
 * The generated CHECK enforces that a non-`ok` status carries a NULL value, so
 * this is the only correct way to write one of these columns — and writing the
 * pair together is what stops "absent" and "zero" from collapsing.
 */
function valued(value: number | null): { value: number | null; status: string } {
  return value === null ? { value: null, status: 'omitted' } : { value, status: 'ok' };
}

function pair(prefix: string, value: number | null): Record<string, unknown> {
  const v = valued(value);
  return { [prefix]: v.value, [`${prefix}_status`]: v.status };
}

/**
 * The run's identity, derived rather than supplied.
 *
 * The old app numbers briefs per day, and both of its slots email a pick — so
 * the slot has to be part of the key or the morning run is indistinguishable
 * from the evening one. That is not hypothetical: `scoring-service.saveBrief`
 * deleted the same-day rows and `brief_candidates` was keyed without a slot, so
 * 248 of 250 stored picks were evening readings and the morning pick the
 * operator actually read was produced from data destroyed hours later.
 */
export function legacyRunId(h: {
  readonly tradingDate: string;
  readonly slot: string;
  readonly briefId: number | null;
}): string {
  return `${h.tradingDate}:${h.slot}:${h.briefId ?? 'nobrief'}`;
}

export function makeLegacyBriefIngest() {
  return (body: string, ctx: IngestContext): readonly IngestedRowSpec[] => {
    const h = JSON.parse(body) as LegacyBriefHandoff;
    const runKey = legacyRunId(h);

    const base = {
      run_id: ctx.runId,
      as_of_date: ctx.asOfDate,
      observed_at: ctx.observedAt,
      capture_rule_id: ctx.captureRuleId,
      source_response_id: ctx.sourceResponseId
    };

    const rows: IngestedRowSpec[] = [
      {
        table: 'legacy_brief_run',
        values: {
          ...base,
          legacy_run_id: runKey,
          trading_date: h.tradingDate,
          slot: h.slot,
          legacy_app_version: h.legacyAppVersion,
          brief_id: h.briefId,
          emailed_at: h.emailedAt,
          // Handed over live, not brought in by the one-time backward import.
          // The two have different reliability and must never be pooled
          // silently, which is the whole point of the column.
          pre_collector: 0
        }
      }
    ];

    for (const c of h.candidates) {
      const children = [];

      if (c.gates.length > 0) {
        children.push({
          table: 'legacy_brief_candidate_gate',
          parentColumn: 'candidate_row_id',
          rows: c.gates.map((g) => ({
            ...base,
            gate_name: g.name,
            passed: g.passed ? 1 : 0,
            ...pair('tested_value', g.testedValue),
            ...pair('threshold', g.threshold),
            reason: g.reason
          }))
        });
      }

      if (c.signals.length > 0) {
        children.push({
          table: 'legacy_brief_candidate_signal',
          parentColumn: 'candidate_row_id',
          rows: c.signals.map((s) => ({
            ...base,
            signal_key: s.key,
            ...pair('raw_value', s.rawValue),
            ...pair('normalized_value', s.normalized),
            weight: s.weight,
            enabled: s.enabled ? 1 : 0
          }))
        });
      }

      if (c.legs.length > 0) {
        children.push({
          table: 'legacy_brief_leg',
          parentColumn: 'candidate_row_id',
          rows: c.legs.map((l, i) => ({
            ...base,
            leg_index: i,
            osi_symbol: l.osiSymbol,
            right: l.right,
            strike: l.strike,
            expiration_date: l.expiration,
            ...pair('bid', l.bid),
            ...pair('ask', l.ask),
            ...pair('mid', l.mid),
            ...pair('iv', l.iv),
            ...pair('delta', l.delta),
            ...pair('open_interest', l.openInterest),
            // **Not `?? 0`.** An unreported volume is `omitted`, never zero:
            // zero says the contract did not trade, which is a different fact
            // and the one that got 23 legs wrongly rejected as illiquid.
            ...(l.volumeReported
              ? pair('volume', l.volume)
              : { volume: null, volume_status: 'omitted' }),
            ...pair('liquidity_score', l.liquidityScore)
          }))
        });
      }

      if (c.critic) {
        children.push({
          table: 'legacy_critic_verdict',
          parentColumn: 'candidate_row_id',
          rows: [
            {
              ...base,
              verdict: c.critic.verdict,
              rationale: c.critic.rationale,
              context_json: c.critic.contextJson,
              model: c.critic.model
            }
          ]
        });
      }

      rows.push({
        table: 'legacy_brief_candidate',
        values: {
          ...base,
          legacy_run_id: runKey,
          ticker: c.ticker,
          mode: c.mode,
          considered_rank: c.consideredRank,
          survived: c.survived ? 1 : 0,
          ...pair('composite_score', c.compositeScore),
          final_disposition: c.finalDisposition
        },
        ...(children.length > 0 ? { children } : {})
      });
    }

    if (h.dice) {
      rows.push({
        table: 'legacy_dice_selection',
        values: {
          ...base,
          legacy_run_id: runKey,
          eligible_count: h.dice.eligibleCount,
          // **Null until resolved on read.** The selected candidate's `row_id`
          // is not knowable here — an ingestion module gets no database handle
          // (P11) — and the ticker alone is ambiguous when the same name was
          // considered in more than one mode. The trace JSON carries the
          // ticker, so nothing is lost.
          selected_candidate_row_id: null,
          selection_rule: h.dice.selectionRule,
          eligibility_trace_json: h.dice.eligibilityTraceJson
        }
      });
    }

    return rows;
  };
}

/**
 * Sticky-contract rows for every leg the brief recommended (04 §4.4).
 *
 * Separate from the ingest module because these are `ref_` rows about *future
 * capture*, not a record of what the brief decided — but they are written in
 * the same transaction, so a recommended contract is sticky whether the brief
 * ran before or after the collector that day.
 */
export function stickyRowsFor(
  h: LegacyBriefHandoff,
  ctx: IngestContext
): readonly Readonly<Record<string, unknown>>[] {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];

  for (const c of h.candidates) {
    for (const l of c.legs) {
      if (seen.has(l.osiSymbol)) continue;
      seen.add(l.osiSymbol);
      out.push({
        run_id: ctx.runId,
        as_of_date: ctx.asOfDate,
        observed_at: ctx.observedAt,
        capture_rule_id: ctx.captureRuleId,
        source_response_id: ctx.sourceResponseId,
        osi_symbol: l.osiSymbol,
        ticker: c.ticker,
        expiration_date: l.expiration,
        reason: 'recommended_by_legacy',
        valid_from: ctx.asOfDate,
        valid_to: null,
        origin_ref: legacyRunId(h)
      });
    }
  }
  return out;
}
