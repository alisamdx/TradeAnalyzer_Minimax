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
| S9 | 2026-09-19 | **Concentration: at most 3 open positions per sector** (option B; per-expiry cap not adopted). The first week held 5 energy/nat-gas positions (EOG, APA, DVN, COP, CF) and 4 tech, all on one expiry; at $2,500 each the energy group alone was a $12,500 (50%) single-event risk. **Simulated in the shadow report now, enforced by the `on` mode when built**: shadow picks stay uncapped so the evidence is not shaped by the cap, and the report shows the capped book beside the full one (v1.1.294). Sectors come from `constituents.sector`; an unknown sector is never pooled. Known limit: GICS labels are coarse, so CF counts as Materials although it trades with natural gas. |
| S8 | 2026-09-19 | **Q1 answered: a $25,000 account, 10% per position → `maxLossPerPosition` = $2,500** (was the $1,000 placeholder; v1.1.293). Max open positions not yet given — stays 10, guidance only until `on` enforces it. Note the arithmetic: at $2,500 × 10 open, a spread's margin equals its max loss, so ten positions commit the whole $25,000 and the worst case is all of it. The §4 study re-run must use `--capital 25000 --risk 2500` so the gate tests these numbers, not the $1,000 ones the #43 portfolio result came from. |
| S7 | 2026-09-19 | **Leg rules widened to match real strike grids, and the study (v1.1.292).** The first shadow week rejected 25 of 80 candidates for strike spacing alone: the 0.25–0.35Δ band fell between two strikes on liquid DVN/EOG/COP/MDT (12), and on CF-like grids ($5 strikes at ~$120) no strike sat 5–7.5% below the short (13). The #43 study took the strike *nearest* short − 5% of spot, so the mode was stricter than its evidence. Short: 0.20–0.40Δ, nearest 0.30. Long: nearest short − 5% of spot, within 3–10%. ETFs skip the earnings gate (EWZ was rejected ×5 as "earnings date unknown"). |

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
- **Short put:** two-sided quote, |Δ| in **0.20–0.40**, closest to **0.30** (0.25–0.35 until v1.1.292, S7).
- **Long put:** two-sided quote, strike closest to **short strike − 5% of spot**, accepting
  **3–10%**; if none, none (5–7.5% until v1.1.292, S7).

### 3.3 Costs and the liquidity gate

- Each leg fills by `options-fill.ts` `fillPrice` (halfway from mid to the far side) — the app's
  one fill convention. **Net credit** = short fill − long fill; **max loss** = width − net credit.
- **Round-trip cost share** = (entry slippage on both legs × 2) ÷ mid credit. **Excluded if > 25%.**
- Excluded if net credit ≤ $0.05.

### 3.4 Gates (each exclusion reported with its reason)

1. Critic verdict `flag`.
2. Earnings date unknown, stale, or on/before the expiry — fail closed, as Roll the Dice. **ETFs are exempt**
   (no earnings; `constituents.index_name = 'etf'`, v1.1.292). A stale date means no provider has announced the
   next one yet: measured for NTAP and INTU on 2026-09-19, both E*Trade (asked every brief run) and Finnhub
   (asked nightly) had none. The gate is doing its job.
3. No qualifying expiry, short or long leg (§3.2).
4. Round-trip cost share > 25% (§3.3).
5. One contract's max loss exceeds the per-position budget (§3.5).

No SMA50, IV-rank or credit-to-width gate (§2).

### 3.5 Sizing

- Settings: **`maxLossPerPosition`** ($), **`maxOpenPositions`** and **`maxOpenPerSector`** — operator numbers
  (§6 Q1, S9), edited in **Settings → Strategies** since v1.1.296 and written through `writeSpreadModeSettings`,
  which clamps to `SPREAD_MODE_LIMITS` and never stores a sector cap above the position cap.
- **Contracts** = floor(maxLossPerPosition ÷ max loss per contract), shown per pick with the total
  max loss. Open positions are not tracked in v1, so the position cap is shown as guidance.

- **Sector cap (S9):** at most **3** open positions per sector (`SPREAD_MODE_PROFILE.maxOpenPerSector`). A
  position occupies its sector from entry until its exit. Shadow: simulated only (`simulateSectorCap` in the
  report). `on`: enforced at pick time, lower-ranked candidates skipped with the reason stored.

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

*Revision 2026-09-19 (v1.1.290): condition 2 is now computed. `spread-mode-settle.ts`, read through
`GET /api/v1/diagnostics/spread-shadow` and printed by `node scripts/spread-shadow-report.mjs`, settles every
shadow pick on its own later captured quotes, with rules in `docs/formulas.md#bull-put-spread-mode`. It counts
**positions**, not pick rows. The same spread picked on consecutive days or in both slots is one trade, so
counting rows would inflate n and let one name set the mean (the episode rule the #43 study uses). The same
change fixes a data gap. Picks are held to the target or expiry at 21–35 DTE, but capture re-quoted a series
for only 21 days after its entry, so a pick's last ~2 weeks could not be marked. Capture now tracks every
picked series until it expires.*

*Revision 2026-09-19 (v1.1.296): the operator's numbers are editable in **Settings → Strategies** — mode
(shadow/off), max loss per position, max open positions, max open per sector — instead of being code defaults.
`writeSpreadModeSettings` is the single writer and clamps every value; the screen renders what was stored, not
what was typed. The shadow report reads the sector cap from the setting. `on` is not offered in the switch:
it does not exist until §4 passes.*

*Revision 2026-09-19 (v1.1.295): the report is also an in-app view, **🪜 Spread Shadow** (Intelligence). This is a
reading surface for the operator, not the `on` panel of §3.9: it shows shadow results and the gate, never a
pick to act on.*

*Revision 2026-09-19 (v1.1.291): a position is a ticker **episode**, as in the #43 study. A pick within 14
days of that ticker's last kept entry is a repeat, even with different strikes or expiry. The first week
had EOG 145/135 (09-14) and EOG 140/130 (09-16) counted as two positions, which is one bet counted twice.
Rejections now list their tickers, and a missing-leg rejection is diagnosed from its stored chain: no
deltas (the stale-Greeks guard or E*Trade), no strike in the band or wing range, or a zero-bid wing.*

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
| Q1 | **Your account size, max loss per position, and max open positions?** | **Answered 2026-09-19 (S8):** $25,000, 10% = $2,500 per position; max open still open (10 placeholder) |
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
