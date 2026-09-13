# 08 — Bull put spread mode: the second strategy after wheel

Status: **design v1 approved 2026-09-13; built in shadow, v1.1.244.** An existing-app brief mode, built
**switched off** and enabled only once captured real quotes confirm the study (§4). TODO #44; the
evidence is TODO #43 and `scripts/fr-bull-put-spread-study.mjs`.

---

## 1. Operator decisions (do not re-litigate; append dated revisions)

| # | Date | Decision |
|---|---|---|
| S1 | 2026-09-12 | **Second strategy after wheel: a bull put credit spread** — premium, not direction. The wheel is slow and ties up capital. Bearish is out (already measured as the weakest strategy); debit spreads were rejected in June (`fr-debit-spread-study.mjs`). |
| S2 | 2026-09-12 | **Quick in and out, 5–15 days.** *Revised by evidence 2026-09-13:* forced exits at 10–15 days halved the portfolio result; a profit target alone averages **~14–18 days**. The mode aims for the target, not a date (§3.7). |
| S3 | 2026-09-12 | **Risk as fixed dollars, or a percent of the trade.** Implemented as a fixed max-loss budget per position (§3.5). |
| S4 | 2026-09-12 | **Delivered as a new brief mode alongside wheel.** |
| S5 | 2026-09-13 | **Write the design now; build it switched off; enable after a re-run on captured quotes (§4).** |
| S6 | 2026-09-13 | **Design approved; every §6 question at its recommended default** — $1,000 max loss and 10 positions until real numbers are set, wheel pool only, ship `shadow`, 50% target, engine stop as a separate item (TODO #45). |

---

## 2. Evidence ledger

All from `scripts/fr-bull-put-spread-study.mjs` on the wheel Brief Replay, **1,495 picks / 475
episodes, entries 2025-06-02 … 2026-08-04, six quarters**. Prices are **Black-Scholes on stored ATM
IV plus a 3-point skew** — not quotes. Full numbers in NewApp/TODO.md #43.

### Measured, and relevant

| Finding | Evidence |
|---|---|
| **On one capital pot the spread out-earns the CSP ~3×, with ~6× the drawdown.** | $25k pot, $1,000 max loss, ≤ 10 open, $0.03/leg: Δ0.30 / 5% wing / 50% target / no stop → **+75% (56% ann.)**, realised drawdown 9%, vs CSP **+26% (20% ann.)**, drawdown 1.4%. Neighbouring settings (Δ0.25–0.35, 50–75% target, no stop) +48 to +80% vs CSP +18 to +26%. |
| **The loss stop and the time stop are the damage.** | Draft 2× stop + 15-day time stop: **+30%** vs +75% without. A 1× stop is negative in almost every cell once costs exist. Defined risk already caps the loss; sizing is the control. |
| **A profit target is the lever; hold for it.** | 50% and 75% targets both beat hold-to-expiry per day; forcing an exit by date lowers return. |
| **Costs decide it, and a cost gate makes the result robust to how costs are modelled.** | Flat $0.05/leg cut per-trade return from +6.3% to +1.5%. With round-trip cost ≤ 25% of mid credit, the portfolio returned **+61.7% on flat costs and +60.8% on quoted costs**; ungated, quoted costs took it from +75% to +52%. |
| **Higher delta and a wider wing absorb fixed costs better.** | At $0.05/leg, 0.20Δ went to ~zero while 0.30Δ held; a 7.5–10% wing beat 5% per trade under quoted costs. |

### Refuted — do not use

- **Credit ≥ 30% of width**: reached by 3 of 475 trades (median credit is ~18–20% of a 5%-of-spot wing).
- **Close above SMA50** ("trend intact"): trades *below* SMA50 did better (+6.6% vs +2.2% per trade,
  n=67). Consistent with `notDowntrend` being anti-predictive for short puts.
- **Loss stop, time stop** — see above.

### Not measured

- **IV rank as a gate** — 233 of 282 entries read ≥ 80, an artefact of the iv_history source splice.
- **Any ranking** — the study took picks in replay order. The ranking in §3.6 is unvalidated.
- **Real wing prices and real skew** — no stored quote for a bought put existed before v1.1.243.
- **Real fill costs** — intraday quotes cover 32 tickers and read a median **$0.50/leg**; the
  $0.03 assumed elsewhere is optimistic for many names. The cost gate is the protection.
- **A second regime** — per-trade returns were negative in 2025-Q3.

---

## 3. The mode

### 3.1 Pool

The latest brief run's **wheel** candidates with disposition `picked` or `capped_out` — the pool the
evidence was measured on. Composite rank ignored (top end anti-predictive, v1.1.173). Income is
excluded until measured (§6 Q2).

### 3.2 Construction — from the chains captured in the same run

Read from `spread_chain_capture` rows this run just wrote (`reason = 'entry'`), so the mode
**makes no E\*Trade calls of its own**. For each ticker:

- **Expiry:** listed, **21–35 DTE**, before the next earnings report; the one nearest **30 DTE**.
- **Short put:** two-sided quote, |Δ| in **0.25–0.35**, closest to **0.30**.
- **Long put:** two-sided quote, strike closest to **short strike − 5% of spot**, accepting
  **5–7.5%**; if none, none.

### 3.3 Costs and the liquidity gate

- Each leg fills by `options-fill.ts` `fillPrice` (halfway from mid to the far side) — the app's
  one fill convention. **Net credit** = short fill − long fill; **max loss** = width − net credit.
- **Round-trip cost share** = (entry slippage on both legs × 2) ÷ mid credit. **Excluded if > 25%.**
- Excluded if net credit ≤ $0.05.

### 3.4 Gates (each exclusion reported with its reason)

1. Critic verdict `flag`.
2. Earnings date unknown, stale, or on/before the expiry — fail closed, as Roll the Dice.
3. No qualifying expiry, short or long leg (§3.2).
4. Round-trip cost share > 25% (§3.3).
5. One contract's max loss exceeds the per-position budget (§3.5).

No SMA50, IV-rank or credit-to-width gate (§2).

### 3.5 Sizing

- Settings: **`maxLossPerPosition`** ($) and **`maxOpenPositions`** — operator numbers (§6 Q1).
- **Contracts** = floor(maxLossPerPosition ÷ max loss per contract), shown per pick with the total
  max loss. Open positions are not tracked in v1, so the position cap is shown as guidance.

### 3.6 Ranking — unvalidated, labelled so

**Net credit ÷ max loss** (return on risk, after modelled fills), descending; **top 5**. The only
related evidence is that premium richness ranked positively for CSPs (v1.1.176).

### 3.7 Exit guidance, printed with every pick

- **Take profit at 50%** of the net credit — e.g. a GTC limit to buy the spread back at half the credit.
- **No loss stop, no time stop.** The position is sized so its max loss is acceptable.
- Expect a typical hold of **2–3 weeks**; about 1 in 8 trades runs to expiry.

### 3.8 Annotations

Expiry and DTE; both strikes, width, short Δ; bid/ask of each leg; net credit, max loss, return on
risk, breakeven; contracts at budget and total max loss; round-trip cost share; open interest per
leg; earnings date; critic verdict; the "unvalidated — model-priced evidence" label.

### 3.9 Switch, surfaces, storage

- *Revision 2026-09-13 (v1.1.244): the build implements `off` and `shadow` only. The `on` panel and email
  are built when §4 passes — before that they would have nothing validated to show. A stored `on` reads as
  the default.*
- Setting **`bullPutSpreadMode`**: `off` | `shadow` | `on`.
  - `off` — nothing runs.
  - `shadow` — computed after each brief run and **stored**, with no panel and no email. Forward
    outcomes then accumulate from day one, marked on the same run's `track` quotes.
  - `on` — also a Daily Brief panel and an email after each brief, through the logged, retried
    delivery the shortlist and dice emails already use.
- **Ships as `shadow`** (§6 Q3), unless the operator prefers `off`.
- New table **`spread_mode_picks`**: date, slot, ticker, rank, expiry, both strikes, each leg's
  bid/ask/Δ, fills, net credit, max loss, cost share, contracts, mode — plus rejections with
  reasons. Kept 730 days, like `brief_candidates`.
- Runs **after** spread chain capture in the brief job, never throws, logs `spread-mode:run`.
- **Not an engine input.** Nothing here reaches the v2 execution path.

---

## 4. Enabling — the FR-SEY-5 gate

Switch to `on` only when **both** hold:

1. **Study re-run on captured costs.** Once `spread_chain_capture` holds ≥ 15 intraday trading days,
   re-run the study with `--slip-model quoted`. The gated Δ0.30 / 5% / 50%-target row must still
   beat the CSP on total return with an annualised return ≥ 20%, and quoted-cost coverage must
   reach ≥ 50% of entries — so the answer is not resting on the $0.03 fallback.
2. **Shadow picks settle positive.** ≥ 30 shadow picks settled — at the 50% target or at expiry,
   marked on `track` rows — with mean return on max loss > 0 after modelled fills.

If either fails, the mode stays `shadow` and the failure is written down with its numbers.

---

## 5. Out of scope for v1

- **Tracking open spreads and exit alerts** — needs portfolio-sync matching of E\*Trade legs.
- **The v2 engine's wheel spread exits.** The engine already trades wheel as a put spread with a
  **50% target and a 2× stop**, validated in June without costs. §2 says that stop halves the
  result. Separate item; not changed here.
- Rolling, the call side, and income as a pool.

---

## 6. Open questions

| # | Question | Default until answered |
|---|---|---|
| Q1 | **Your account size, max loss per position, and max open positions?** | $1,000 and 10 — the study's placeholders |
| Q2 | Include the income pool? | No — unmeasured |
| Q3 | Ship as `shadow` (stores picks for validation, no email/panel) or `off`? | `shadow` |
| Q4 | Profit target 50% or 75%? 75% returned slightly more with lower drawdown on flat costs; 50% exits sooner. | 50% |
| Q5 | Open a separate item to revisit the v2 engine's 2× stop on wheel spreads? | Yes, separately |

---

## 7. Risks

- **The evidence is model-priced** (BS + an assumed skew). A skew of 6 points cuts per-trade return
  by a third. §4 exists because of this.
- **One replay period.** Six quarters, one negative per trade.
- **Drawdown.** ~6× the CSP's on the same pot. Defined risk caps each loss, not a cluster of them.
- **Costs.** The names with real quotes were expensive; the gate removes them rather than pricing them in.
