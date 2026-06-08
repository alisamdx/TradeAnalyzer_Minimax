# Daily Brief — AI Critic (Second Opinion Engine)
**Capability Requirements Specification**
Version 1.0
Date: June 2026
Status: Draft — pending implementation

---

## 1. Purpose & Motivation

The Daily Intelligence Brief automates trade discovery and synthesis, but has no internal quality gate. If the pipeline produces a recommendation with conflicting signals, a near-term earnings event inside the DTE window, or a liquidity profile that makes the structure impractical, there is currently no signal of that to the user — the pick looks identical to a clean one.

Catching these issues today requires days or weeks of outcome observation. By then the trade opportunity has passed (or worse, the trade is already open).

**This capability adds a skeptical second opinion to every Daily Brief pick.** After the existing AI synthesis stage produces rationale for why a pick is good, the AI Critic independently evaluates each pick against a set of adversarial checks and returns a structured verdict: `pass`, `caution`, or `flag`, with a plain-language explanation of what it found.

### Design intent

- The critic is **adversarial by design** — its job is to find problems, not validate decisions
- It evaluates the **recommendation output**, not the underlying data pipeline; it cannot catch data quality issues upstream
- It does **not re-score** — it looks for things the scoring engine does not see holistically
- The human still decides — the verdict is advisory, not a block

---

## 2. Scope

### 2.1 In Scope

- **Critic evaluation engine** — runs per pick after Stage 5 AI synthesis, before persistence
- **Rule-based pre-checks** — deterministic checks for concrete conditions (earnings conflict, liquidity, signal gap, trend alignment)
- **LLM synthesis** — Claude haiku call per pick that receives rule check results + pick context and produces a 2-sentence verdict rationale
- **Critic verdict schema** — `verdict`, `confidence`, `flags[]`, `rationale` fields appended to each `BriefPick`
- **UI integration** — verdict badge + expandable rationale on every pick card in `DailyBriefView`
- **Email integration** — critic verdict included in daily brief email output

### 2.2 Out of Scope

- Re-running scoring signals (critic is downstream of scoring, not a scorer)
- Detecting bad input data (wrong IV, stale price) — that requires upstream data validation
- Blocking trades from the brief based on verdict — advisory only
- Intraday critic re-evaluation after brief is generated
- Backtesting the critic's accuracy (deferred — needs 30+ days of outcome data)

---

## 3. Architecture

### 3.1 Position in the Pipeline

The critic runs as **Stage 5b** — after AI synthesis (Stage 5) and before persistence (Stage 6):

```
Stage 5   — AI Synthesis      (Claude haiku: WHY this is a good pick — advocate role)
Stage 5b  — AI Critic         (rule checks + Claude haiku: what could go wrong — skeptic role)
Stage 6   — Brief Persistence (write critic verdict into each BriefPick in daily_briefs)
```

The advocate (Stage 5) and critic (Stage 5b) use the **same model but opposite system prompts**. Keeping them separate ensures the advocate writes clean positive rationale without hedging, and the critic writes clean adversarial evaluation without cheerleading.

### 3.2 Evaluation Approach: Hybrid Rule + LLM

The critic uses a two-step approach per pick:

**Step 1 — Rule-based pre-checks** (deterministic, no LLM)

Run the concrete checks defined in Section 4 against the pick's data. Each check produces a structured flag with a key, severity (`warning` | `info`), and a short machine-readable description.

**Step 2 — LLM synthesis** (Claude haiku)

Pass the pick's full context (ticker, strategy, composite score, top signals, Strategy Lab result, AI rationale from Stage 5) plus the pre-check flags to Claude haiku with a skeptic system prompt. The model synthesizes these into a 2-sentence verdict rationale and confirms or overrides the rule-based severity.

If no pre-check flags fire, the LLM is still called — it may identify cross-signal conflicts or context issues the rules miss. The rules act as a structured briefing, not a hard gate.

### 3.3 Cost

- 1 haiku call per pick = ~$0.002/pick
- ≤ 25 picks/day → ≤ $0.05/day
- Combined with existing Stage 5: ≤ $0.10/day total AI cost per brief run
- All AI costs are logged in `run_meta` per NFR-02 of the existing brief spec

---

## 4. Critic Check Rules

These are the deterministic pre-checks. Rules are applied in order. Multiple flags can fire for a single pick.

### 4.1 Earnings Conflict (severity: warning)

**Key**: `earnings_in_window`

**Condition**: An earnings event is detected within the DTE window of the recommended structure.

**Logic**:
- If `strategyLabResult` has a recommended structure with a concrete expiry date, compute DTE from today
- If `screen_results` or `fundamentals_cache` contains `earningsDate` within that DTE window (or within 14 calendar days if no structure DTE is available), fire this flag
- Note: earnings date is frequently null (Polygon has no public endpoint). If null, this flag is suppressed with `info` level noting "earnings proximity unknown"

**Why this matters**: IV crush post-earnings destroys short premium trades. A wheel CSP expiring after earnings is a fundamentally different risk profile than the score suggests.

### 4.2 Trend vs. Strategy Misalignment (severity: warning)

**Key**: `trend_strategy_conflict`

**Condition**: The stock's observed trend conflicts with the strategy's requirements.

**Specific checks**:

| Strategy | Flag if... |
|---|---|
| Wheel | `trendStrength` signal raw value indicates price below 50MA (stock in downtrend — assignment risk is high) |
| Bullish | `trendStrength` signal indicates stock below both MAs (entering a downtrend) |
| Bearish | `downtrendScore` signal raw value indicates stock above both MAs (not confirmed bearish) |
| Income | `trendNeutral` signal score < 30 (stock in a strong directional trend — strangle/condor danger) |
| Buy | `trendStrength` score < 40 AND `relativeStrength` score < 40 (lagging in both trend and relative strength) |

These use the normalized signal scores already present in the `BriefPick.signals` breakdown — no new data access required.

### 4.3 Liquidity Gate Miss (severity: warning)

**Key**: `low_liquidity`

**Condition**: Strategy Lab validation returned a `liquidityScore < 6` on the recommended structure.

**Logic**: The existing liquidity hard gate (Section 6.2 of DAILY_INTELLIGENCE_BRIEF.md) uses `liquidityScore < 5`. The critic flags at `< 6` (slightly above the gate) as a softer caution — "technically passed the gate but liquidity is thin."

If `strategyLabResult` is absent (pick was not validated), fire with `info` level: "pick was not validated against live options chain — liquidity is unconfirmed."

### 4.4 Critical Signal Missing (severity: warning)

**Key**: `critical_signal_missing`

**Condition**: One or more of the top 2 signals by weight for the strategy has `missing: true` in the signal breakdown (value was null, scored as 0 by convention).

**Why this matters**: A pick scoring 82 with its two highest-weight signals set to 0 due to missing data is structurally different from a pick scoring 82 with all signals populated. The score was inflated by the remaining signals relative to what it would be with real data.

**Logic**: Look up the strategy's signal config from `scoring_strategy_configs`. Find the top 2 by weight. Check if either is flagged `missing: true` in `BriefPick.signals`.

### 4.5 Score Concentration Risk (severity: info)

**Key**: `score_concentrated`

**Condition**: A single signal accounts for > 50% of the pick's composite score contribution (normalized score × weight > 50 out of 100).

**Why this matters**: A pick whose entire score is driven by one outstanding signal (e.g., IV rank = 100 for a wheel pick) may look great but is actually a one-dimensional thesis. The AI Critic notes this so the user knows what they're really betting on.

### 4.6 Cross-Strategy Conflict (severity: info)

**Key**: `cross_strategy_conflict`

**Condition**: The same ticker appears in both a bullish strategy pick and a bearish strategy pick in the same brief run.

**Why this matters**: While rare, scoring noise can produce this. A ticker cannot be simultaneously a high-conviction bullish and bearish setup — one of them is wrong.

**Logic**: After all picks are scored, do a cross-strategy scan before calling the critic LLM. If a ticker appears in both Bullish and Bearish sections, flag both picks.

### 4.7 Elevated Market Risk Context (severity: info)

**Key**: `elevated_market_risk`

**Condition**: Macro regime conditions that alter the risk profile of this pick's strategy.

**Specific checks** (use existing market regime data computed during the brief job):

| Strategy | Condition |
|---|---|
| Short premium (Wheel, Income) | VIX > 30 — premium is elevated but risk of continued expansion is high; check if stock's historical vol is rising |
| Bullish, Buy | SPY below 200MA — broad market in downtrend; individual bullish picks face headwinds |
| Bearish | VIX < 14 — complacency; short-side setups often fail in low-vol environments |

This check uses the market regime context already computed in the pipeline — no additional data access.

---

## 5. Verdict Schema

The critic appends a `criticVerdict` field to each `BriefPick`:

```typescript
interface CriticVerdict {
  verdict:     'pass' | 'caution' | 'flag';
  confidence:  'high' | 'medium' | 'low';   // LLM's stated confidence in its verdict
  flags:       CriticFlag[];                 // rule check results (may be empty)
  rationale:   string | null;               // LLM 2-sentence synthesis; null if LLM unavailable
  generatedAt: string;                      // ISO timestamp
}

interface CriticFlag {
  key:         string;              // one of the keys defined in Section 4
  severity:    'warning' | 'info';
  description: string;              // human-readable, shown in the UI expandable
}
```

**Verdict determination**:
- `flag`: any `warning`-severity flags fired, or LLM determines high concern
- `caution`: only `info`-severity flags, or LLM sees soft concern, or critical signal missing
- `pass`: no flags fired AND LLM synthesis finds no additional concerns

**Confidence**:
- `high`: all required data was available; no missing signals; Strategy Lab result present
- `medium`: one or more signals was missing; or Strategy Lab result absent (unvalidated pick)
- `low`: most signals missing; or critic ran in degraded mode (no LLM available)

---

## 6. LLM Prompt Design

### 6.1 System Prompt (skeptic role)

```
You are a risk-focused options trading analyst reviewing daily trade recommendations.
Your job is to find problems, not validate decisions. Be skeptical and specific.

For each pick, you will receive:
- The ticker, strategy, composite score, and top signal values
- The concrete trade structure (strikes, expiry, credit, DTE) if available
- The advocate's rationale (why this pick was selected)
- Any rule-based flags that fired

Write exactly 2 sentences:
1. Your verdict on the most significant risk or concern you see (or confirm it looks clean if you see none)
2. The specific condition the user should check or monitor before acting on this pick

If rule-based flags are present, address at least one of them. Do not repeat the advocate's rationale.
Be direct. Do not hedge with "potentially" or "may" — state what you see.
```

### 6.2 User Message Structure

```json
{
  "ticker": "MSFT",
  "strategy": "wheel",
  "compositeScore": 87,
  "topSignals": [
    { "key": "ivRank", "label": "IV Rank", "raw": 72, "normalized": 72, "weight": 30 },
    { "key": "premiumYield", "label": "Premium Yield", "raw": 2.1, "normalized": 64, "weight": 25 }
  ],
  "structure": {
    "type": "CSP",
    "strike": 410,
    "expiry": "2026-07-18",
    "dte": 42,
    "credit": 3.25,
    "annualizedReturn": 28.4,
    "liquidityScore": 7
  },
  "advocateRationale": "Microsoft's elevated IV rank...",
  "ruleFlags": [
    { "key": "elevated_market_risk", "severity": "info", "description": "VIX at 28 — approaching elevated territory for short premium" }
  ]
}
```

---

## 7. UI Integration

### 7.1 Pick Card Verdict Badge

Each pick card in `DailyBriefView` shows a critic verdict badge below the advocate rationale:

```
┌──────────────────────────────────────────────────────────────┐
│  #1  MSFT  Score 87  ✓ Validated                            │
│       IVR 72 · Premium yield 2.1% ann · Suitability 8/10   │
│       "Microsoft's elevated IV rank combined with..."        │
│  ─────────────────────────────────────────────────────────  │
│  🔍 Critic:  ⚠ Caution  [▼ expand]                          │
│  "VIX near elevated territory reduces wheel edge. Monitor   │
│   VIX direction; if it crosses 30, this trade loses its     │
│   premium advantage."                                        │
└──────────────────────────────────────────────────────────────┘
```

Badge colors:
- `pass` → subtle green check: `✓ Pass`
- `caution` → amber warning: `⚠ Caution`
- `flag` → red flag: `⚑ Flag`

The badge is always shown (collapsed to just the icon + label by default). The rationale text is shown on expand.

If `criticVerdict` is null (critic unavailable), show a muted "Second opinion unavailable" label — no badge.

### 7.2 Strategy Section Summary

At the top of each strategy section header, show an aggregate critic summary:

```
── WHEEL ──────────────────────── 3 pass · 1 caution · 0 flagged ──
```

This lets the user quickly triage: if a strategy section has `flag` verdicts, they know to review those picks carefully before acting.

### 7.3 Flag Detail Drawer

When the user expands the critic verdict, show:
1. LLM rationale (2 sentences)
2. Rule flags list (if any), each with its description
3. `Confidence: high / medium / low` label with a tooltip explaining what confidence means

### 7.4 Email Integration

The daily brief email (added in v0.22.28) must include the critic verdict for each pick:

- In the pick row: add a `Critic` column showing `Pass / Caution / Flag`
- After the AI rationale paragraph in the email body: add the critic's 2-sentence rationale in italic with a distinct label ("⚠ Second opinion:")

---

## 8. Functional Requirements

**FR-AIC-01**: The critic runs as Stage 5b in the Daily Intelligence Brief pipeline, after Stage 5 (AI synthesis) and before Stage 6 (persistence). It must not block Stage 6 — if the critic fails entirely, the brief is persisted without critic verdicts and picks show "Second opinion unavailable."

**FR-AIC-02**: All 7 rule checks defined in Section 4 must be evaluated for every pick. Rule checks must complete in < 100ms per pick (all reads from in-memory `BriefPick` data + the existing scoring config — no DB or API calls).

**FR-AIC-03**: The LLM critic call uses the same Claude model as Stage 5. The system prompt must be the skeptic prompt defined in Section 6.1. Advocate and critic calls must never be merged into a single prompt.

**FR-AIC-04**: If the Claude API is unavailable or the API key is missing, the critic runs rule-checks only. Verdict is determined from flags alone (any warning → `caution`, no flags → `pass`). Rationale is null. Confidence is `low`.

**FR-AIC-05**: The `criticVerdict` field is serialized into `BriefPick.picks` JSON in `daily_briefs`. Historical brief records retain the critic verdict that was generated at the time — the critic is not re-run when viewing historical briefs.

**FR-AIC-06**: Each pick card in `DailyBriefView` must show the critic badge inline (not hidden behind a button click). The rationale text is expandable. Collapsed state is fine; the badge itself is always visible.

**FR-AIC-07**: The strategy section header must show the aggregate verdict summary (N pass / N caution / N flagged) as defined in Section 7.2.

**FR-AIC-08**: The cross-strategy conflict check (Section 4.6) must scan all picks across all strategies before per-pick LLM calls are made. This ensures both sides of a conflict are flagged in the same brief run.

**FR-AIC-09**: The email brief must include the critic verdict column and rationale as defined in Section 7.4.

**FR-AIC-10**: The `run_meta` field of `daily_briefs` must record: critic stage duration, count of passes/cautions/flags, estimated Claude cost for Stage 5b, and whether the LLM was available.

---

## 9. Non-Functional Requirements

**NFR-AIC-01 Performance**: Stage 5b must complete in < 30 seconds for 25 picks. Rule checks are synchronous and near-instant; LLM calls for 25 picks can be parallelized (Promise.all) using the same Claude API client as Stage 5.

**NFR-AIC-02 Cost**: Stage 5b AI cost ≤ $0.05/day (25 picks × ~$0.002/pick). Combined Stage 5 + 5b ≤ $0.10/day. Logged in `run_meta`.

**NFR-AIC-03 Graceful degradation**: If 1–N picks fail the critic LLM call, remaining picks still receive verdicts. Per-pick failures produce rule-check-only verdicts with confidence `low`.

**NFR-AIC-04 Auditability**: The critic's rule flags are stored in `criticVerdict.flags[]` in the persisted pick JSON. The user can always see which specific checks fired, not just the aggregate verdict.

**NFR-AIC-05 Separation of concerns**: The advocate rationale (Stage 5) and critic rationale (Stage 5b) must be stored in separate fields: `aiRationale` (existing) and `criticVerdict.rationale` (new). They must never be concatenated or merged in the DB.

---

## 10. What the Critic Cannot Catch (explicit limitation)

This section is intentionally documented to set correct expectations:

| Issue | Why the critic cannot catch it |
|---|---|
| Wrong IV value ingested (data error) | Critic sees the same IV that the scoring engine used — it cannot independently validate raw data |
| Scoring formula bugs | Critic evaluates the recommendation output, not the formula implementation |
| Stale fundamentals (60-day-old earnings) | Critic has no independent data source to compare against |
| Broader macro events not in the pipeline | Critic only knows what the brief pipeline computed (VIX, SPY trend, market regime from existing data) |
| Option mispricing relative to model IV | Would require computing theoretical value — outside the critic's scope |

The right mitigation for the above is upstream data validation (a separate capability).

---

## 11. Implementation Plan

### Phase 1 — Core (build now)

1. Add `criticVerdict: CriticVerdict | null` field to `BriefPick` interface in `shared/types.ts`
2. Implement `CriticService` in `src/main/services/critic-service.ts`:
   - `runRuleChecks(pick, strategyConfig, marketContext): CriticFlag[]`
   - `synthesizeVerdict(pick, flags): Promise<CriticVerdict>`
   - All 7 rule checks from Section 4
   - LLM call with skeptic system prompt from Section 6.1
3. Wire `CriticService` into `DailyIntelligenceBriefJob` as Stage 5b (parallel Promise.all across picks)
4. Update `DailyBriefView` pick cards with critic badge + expandable rationale (Section 7.1)
5. Update strategy section headers with aggregate summary (Section 7.2)
6. Update email builder to include critic column + rationale (Section 7.4)
7. Update `run_meta` logging (FR-AIC-10)

### Phase 2 — Refinement (after 30 days of live data)

1. Add critic accuracy tracking: when a Retrospect position closes, record whether the critic verdict correlated with the outcome
2. Tune rule check thresholds based on observed false-positive/negative rates
3. Tune LLM prompt based on observed rationale quality
4. Consider adding a "critic override" UI action: user can mark a flagged pick as "reviewed and accepted" with a note, suppressing the flag badge on that specific pick

---

## 12. Open Questions

- **Parallelism limit**: Stage 5 already runs LLM calls for 25 picks. Stage 5b doubles the concurrent LLM calls. Confirm the Anthropic API rate limit isn't a constraint (haiku is high-throughput; 50 simultaneous calls should be fine but worth verifying).
- **Earnings date availability**: The earnings conflict check is the most valuable rule but relies on earnings date data that is frequently null. Worth investigating whether the `screen_results` or any other stored data has a usable earnings proximity proxy.
- **Critic tone calibration**: The skeptic prompt needs real output review. First 5–10 runs should be checked manually to confirm the critic is being genuinely adversarial rather than producing hedged non-statements.
- **Verdict display when all picks pass**: If every pick in a section gets `pass`, the section header reads "5 pass · 0 caution · 0 flagged." This may feel falsely reassuring. Consider adding a note: "All picks cleared — verify market conditions have not changed since brief generation."
