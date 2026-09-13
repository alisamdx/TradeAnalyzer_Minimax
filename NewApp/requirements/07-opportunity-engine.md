# 07 — Opportunity engine: finding the best wheel trades

Status: **design, v1 — 2026-09-12.** The purpose the rebuild started for: identify the best
wheel (cash-secured put) opportunities, with reasons that were *measured* rather than asserted.
Two deliverables share one definition — an **interim shortlist in the existing app, now**, and
the **measured engine in TradeAnalyzer 2**, once its answer key has matured.

---

## 1. Operator decisions (2026-09-12 — do not re-litigate; append dated revisions)

| # | Decision |
|---|---|
| D1 | **Objective: premium return on capital, avoiding assignment.** Assignment is a failure outcome, not an acceptable one. (Differs from the own-at-strike framing in which assignment at a good basis is fine.) |
| D2 | **Trade profile — aggressive:** short put at **0.35–0.45 delta**, **14–30 DTE**. |
| D3 | **Management rule (how assignment is avoided):** if the put is **in the money with ≤ 7 days left**, **roll out to the next 14–30 DTE expiry at the same or a lower strike, for a net credit only; if no credit roll exists, close it.** |
| D4 | **Output: top 5**, **no capital cap** — sizing is the operator's decision; capital required is shown, never filtered on. |
| D5 | **Cadence: after both daily brief runs** (≈10:15 and ≈17:00 ET). |
| D6 | **Act now:** ship an evidence-based interim shortlist in the existing app; build the measured engine in TA2. |
| D7 | **Surfaces:** a TA2 view and an email like Roll the Dice. (Interim: email + a Daily Brief panel in the existing app.) |

---

## 2. Evidence ledger — what the existing app has actually measured

All of it from the existing app's stored history, one market regime (mid-2026), and **none of it
in the D2 profile**. Numbers are quoted from `.ai/AI_CONTEXT.md` §11 and the study scripts.

### Measured, and relevant

| Finding | Scope | Source |
|---|---|---|
| **Higher delta earns more, monotonically**: ~0.23Δ +0.48% → ~0.28Δ **+1.14%** → 0.35Δ **+1.48%** return on capital; extra premium out-earns extra assignment (+2.4 pp per step). | 16,902 settled real CSPs; 937 matched pairs (same ticker, day, expiry); **0.20–0.35Δ, 30–45 DTE** | v1.1.171, `scripts/fr-wheel-delta-study.mjs` |
| **Ranking by premium richness helps**: top annualized return +1.03 mean / +2.67 median vs no selection; lowest is the worst rule. | 23,722 settled snapshot rows / 40 dates; 0.20–0.30Δ, 30–45 DTE | v1.1.176, `scripts/fr-wheel-selection-study.mjs` |
| **Own-at-strike × support**: basis ≤ SMA200 and strike below the 20-day low; "support-only" cell best (+3.46%), "neither" worst (−2.10%, 44% assigned). | 250 stored picks / 186 settled; wheel profile | v1.1.186–188 |
| **Liquidity is a gate, not a ranking signal** (liquid names trail illiquid on outcome). | 18,219 settled CSPs | v1.1.170, v1.1.176 |
| **Shorter tenor is not a free lunch**: at 14–22 DTE gate-clear rates are low (18–23%); weekly-vs-monthly A/B rejected. | 17,679 paired cells | v1.1.126 |

### Refuted or anti-predictive — do not use as ranking inputs

- The wheel **composite** at the top: 58–63 **+1.91%** vs 73+ **−4.99%** (v1.1.173).
- `notDowntrend` and the price-derived wheel signals (v1.1.178) — add nothing, one anti-predictive.
- SPY-regime gate, overbought guard, ADX — rejected on replay.

### Not measured — the D2/D3 profile itself

- Anything above **0.35Δ**; anything at **14–30 DTE** in the delta sense; any outcome **under the
  D3 roll rule**. The existing app stores no option chains, so none of this can be measured there.
- **The tension:** delta ≈ probability of finishing in the money. At 0.40Δ roughly 4 in 10 trades
  expire ITM unmanaged; D1 is achievable only through D3. Selection matters less than
  **rollability** for this objective.

---

## 3. Interim shortlist — existing app (advisory)

**What it is:** after each brief run, the five best D2 contracts by the one ranking with measured
support, with the annotations that bear on D1. **What it is not:** an engine input. It never reaches
the v2 execution path, so it is advisory decision support and ships as a labelled, unvalidated
view. Anything that later wires it into trade-taking needs FR-SEY-5 evidence first.

### 3.1 Pool

The brief's **wheel and income Stage-4 candidate pools** (`brief_candidates`, both slots), deduped by
ticker — **not** the composite's top 5, whose ranking is anti-predictive at the top. Dispositions
`picked` and `capped_out` (validated, cleared the lab liquidity gate). `failed_liquidity` excluded
(gate), `not_validated` excluded (no lab result).

### 3.2 Contract, priced live

For each pool ticker, from the E*Trade chain at run time: the put with **|delta| in [0.35, 0.45]**
in an expiry at **14–30 DTE**, two-sided (`bid > 0`, `ask > 0`). If several qualify, the one with the
highest **premium ROC** (§3.4). Entry credit at **mid**, shown with the bid.

### 3.3 Gates (exclusions)

- **Earnings on or before expiry** — excluded; **unknown or stale** earnings date also excluded
  (same fail-closed rule as Roll the Dice).
- **Critic flag** — excluded where a critic verdict exists (critic runs on brief picks only).
- **No qualifying contract** — excluded, reason recorded.
- **Capital is not a gate** (D4). Capital required is displayed.

### 3.4 Ranking

**Premium return on capital, annualized:** `mid ÷ strike × 365 ÷ DTE`. The only measured-positive
ranking (§2); extended here to a profile it was not measured on, and labelled so.

### 3.5 Annotations on each of the five

- **Assignment probability** ≈ |delta|.
- **Roll room (D3, today's chain):** at the next listed expiry 7+ days beyond the chosen one and
  within 14–30 DTE of it, the lowest strike whose mid ≥ the chosen contract's mid — i.e. how far
  down a credit roll could go if it had to be done at today's prices. Shown as `$X lower, N strikes`
  or `no credit roll at today's prices`. A proxy, not a forecast — labelled.
- **Own-at-strike and support** (existing `ownAtStrikeNote`).
- **Earnings date**, **capital required**, **spread %**, open interest.
- Rejections with reasons (evidence that the gates ran).

### 3.6 Surfaces

- **Email "🎯 Wheel Shortlist · HH:MM ET"** after each brief (D5), built and sent through the same
  logged path as the dice email (`brief-emails.ts` pattern: compute / build / send, retry once,
  outcome to `logs/errors`). A zero-result run still sends, stating why.
- **Daily Brief panel** with the same content and an "✉ Email it" button.

### 3.7 Budget

≈ 30 tickers × (1 expirations + ~2–3 chains in window) ≈ 100 E*Trade calls per run, after Stage 4.
Paced like the rest of the brief's E*Trade path.

---

## 4. The answer key — TradeAnalyzer 2, stage 2

TA2 captures, every trading day from 2026-09-14, the full chain (all strikes, ≤ 90 DTE + 2 monthlies)
for ~500 tickers. That makes the **counterfactual** measurable: every D2 contract that could have been
sold, and — uniquely — **the D3 roll simulated with the quotes that actually existed on the roll day.**

### 4.1 Population

Every `(ticker, entry date, contract)` with |delta| in [0.35, 0.45], DTE in [14, 30], two-sided quote,
from `raw_option_contract_snapshot` on the latest observation of the entry date.

### 4.2 Simulated management (D3), on stored quotes

Walk forward day by day on the stored chain:
1. **Entry** at the bid (conservative) — mid recorded alongside.
2. On the first day with **DTE ≤ 7 and spot < strike**: look for a **credit roll** — buy back at the
   ask; sell the **next expiry with 14–30 DTE**, strike ≤ current strike, at the bid; net credit > 0.
   Choose the credit roll with the highest strike ≤ current (least moved) — *to be confirmed*, see §8.
   If none exists, **close** at the ask.
3. A rolled position repeats step 2 on its new expiry. The **cycle** ends at expiry OTM, at a close, or
   at assignment (only if a roll day's quotes were missing — recorded as a data failure, not a choice).
4. Cap the number of rolls per cycle (proposed 6) so a runaway chain is visible, not endless.

### 4.3 Labels per cycle

- `premium_roc` — total net credits − buy-backs, ÷ strike × 100, and annualized by capital-days.
- `outcome` — `expired_otm` | `rolled_then_expired` | `closed_no_credit_roll` | `assigned_data_gap`.
- `rolls`, `days_held`, `max_adverse_excursion`, `worst_mark`.

### 4.4 Maturity

A 14–30 DTE contract entered 2026-09-14 settles 2026-09-28 – 10-14; rolled cycles run longer.
First labels ≈ early October; a usable sample (~40 entry dates) ≈ **mid-November**; still one regime.

---

## 5. Features (point-in-time, all from TA2's raw layer)

Premium ROC · IV30 · IV30 − realized vol · IV rank (**needs a year of IV30 or the IVolatility
bootstrap, TODO #21**) · put skew · term structure slope · spread % and OI · roll room (§3.5) ·
own-at-strike (basis vs SMA200, 52-week percentile) · support (strike vs 20-day low) · trend structure ·
stochastic RSI · days to earnings · fundamentals quality (EDGAR) · short interest · analyst trend ·
insider buying · sector · regime (VIX, SPY trend).

---

## 6. Evaluation protocol — the lessons, as rules

1. **Walk-forward only**; no feature may read data after its entry date.
2. **Collapse repeated entries** of the same position into one episode before any statistic.
3. **Excess over SPY** for the same window, alongside raw.
4. **Split by regime** before claiming anything; one regime is a hypothesis.
5. **Deciles and monotonicity**, medians alongside means (single outcomes reach −87%).
6. **Baselines:** a random eligible contract; the interim rule (premium ROC). A feature must beat both.
7. **Count choice sets** — how often a ranking actually chooses (79% of old dice days had ≤ 1).
8. **Keep the losers**; the population is every contract, not the survivors.
9. **FR-SEY-5:** nothing reaches trade-taking without a replay/backtest delta at worst neutral.

---

## 7. TA2 deliverable

- **Opportunity view:** today's top 5 with measured reasons, roll room, and the evidence behind each
  reason (effect size, sample, regime count).
- **Email** like Roll the Dice, after each run.
- **Scorecard:** how every past shortlist performed vs the baselines, updated as cycles settle — the
  engine grades itself in public.

---

## 8. Open questions

1. D3 roll choice when several credit rolls exist: least strike movement (proposed), largest credit, or
   lowest strike reachable?
2. Roll-day timing: the first day DTE ≤ 7 and ITM (proposed), or at a fixed DTE?
3. Entry price convention for the interim email: mid (proposed, shown with bid) vs bid.
4. Whether the interim pool should widen beyond the brief's wheel/income candidates (e.g. the chain
   subset) once TA2 data is readable from the existing app.

## 9. Dependencies and risks

- **IV rank** needs the bootstrap (#21) or a year of capture.
- **Chain subset** (~500 names, $233M dollar volume) bounds the TA2 universe.
- **One regime** until the pilot has run through a different market.
- **E*Trade chain quality** (zero bids outside RTH; the after-close run captures settled quotes).
- The interim shortlist's ranking is **extrapolated** from 0.20–0.35Δ / 30–45 DTE evidence.
