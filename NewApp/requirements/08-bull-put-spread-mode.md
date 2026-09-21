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
| S12 | 2026-09-20 | **A third arm, `premium`, on the rule T7 measured as best; and BPS-2 closed: the composite's cut stays.** T7 (docs/wheel-parameters.md; 6,221 settled rows, 54 dates, against a same-size random draw) found ranking the universe by annualized premium return the best rule tested (**+0.54% mean / 2.86% median**, random band −1.29…−0.52 / 1.14…1.34), beating the wheel composite (−0.12 / 2.02) and income (−0.56 / 1.67). `ivRank` — the composite's largest weight — is **inside** the band, and adding it to `premiumYield` made the pair worse than `premiumYield` alone; that may be a dead signal or the `iv_history` splice with zero overlapping days, and stored data cannot separate them. **No rule moved the assigned rate** (all inside 29.3–34.7%), which is this trade's own win condition: selection changes how much credit you collect, not how often you are breached. `premium` is **not a brief strategy** — the whole universe from `analysis_snapshots` (already filled nightly for ~1,100 tickers by `DailyOptionsSnapshotJob`, so the pool costs no new market data), liquidity ≥ 5/10, price ≤ $750, top 15. **Two asymmetries, stated not hidden:** it has no brief of its own so its critic verdicts come from whichever brief carries the ticker and are often absent; and T7's advantage is a CSP's return on *capital*, which is not a spread's return on *max loss* — the assignment finding transfers, the return finding is what this arm exists to test. Built v1.1.302, migration 087. |
| S11 | 2026-09-20 | **Two candidate pools run side by side in shadow: `wheel` (incumbent) and `income` (challenger); decide on the data, do not switch** — and **a defined-risk trade may go into names the wheel would refuse on quality**, which is the point of a capped loss. Reasoning (BPS-1): the wheel composite spends **21% on fundamentals + leverage**, weight that exists because an assigned CSP means you *own* the stock — a spread never does — plus 8% on `notDowntrend`, which this strategy's own study measured **backwards** (below SMA50 +9.4% vs +5.7%). `income` carries no ownership weight and its `premiumRiskRatio` (22) is near enough the quantity §3.6 already ranks on; its `trendNeutral` (15) is always missing because `USE_ADX_IN_SCORING = false`, so it runs four live signals on 85 weight. **Both, not either**, because every #43 number was measured on wheel-selected names and switching would forfeit the comparison permanently — the `iv_history` splice, which joined two sources with zero overlapping days and left nothing able to separate them. It costs **no extra E\*Trade calls**: income chains are already captured and income candidates already stored. §4 stays judged on `wheel` (`SPREAD_GATE_POOL`) so the gate does not change what it measures mid-sample. Counter-argument recorded, not dismissed: a gap through the long strike *is* the max loss, and gap risk was tested here and falsified as a signal — producing the evidence for going down-quality is what this experiment is for. Built v1.1.301, migration 086. |
| S10 | 2026-09-20 | **`maxLossPerPosition` stays at the stored $250 while the mode is in shadow** — deliberate, not the missing zero it looks like beside S8's $2,500. Confirmed by the operator after v1.1.299's report surfaced the stored value. **Do not "correct" it to $2,500.** Recorded because the consequence is easy to misread as a bug: the budget is a *gate* (§3.4.5 rejects a candidate whose one contract exceeds it), not only a sizing input, so at $250 only a spread with ≤ $2.50 max loss per contract survives — **8 of the 10 positions open on 2026-09-20 would have been rejected** (only APA $198 and DVN $184 clear it), and the 11 stored `one contract risks $# > $#` rejections grow accordingly. That slows §4 condition 2, which counts **settled positions**: a budget rejection is stored as a rejection, never becomes a position, and so never settles. **Resolved in v1.1.300**: §3.4.5 now binds only in `on`, so the $250 budget no longer costs the sample anything — shadow records an unaffordable pick with `contracts = 0` and the report shows the affordable subset beside the full book. |
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

One pass per pool in **`SPREAD_MODE_POOLS`**, over the same captured chains; each pass stores its rows
tagged with `pool` and replaces only its own. Composite rank ignored within a pool (top end
anti-predictive, v1.1.173).

| pool | source | why |
|---|---|---|
| `wheel` | `brief_candidates`, `picked` + `capped_out` | the incumbent, and the pool every #43 number was measured on; §4 is judged on it |
| `income` | same, `strategy = 'income'` | S11 — no ownership weight, where wheel spends 21% on fundamentals + leverage |
| `premium` | `analysis_snapshots`, whole universe ranked by annualized return | S12 — the best rule T7 measured; **not a brief strategy** |

**`resolvePoolTickers()` in `spread-pools.ts` is the single resolver**, called by both `spread-mode.ts`
and `spread-chain-capture.ts`. They must not disagree: a capture that missed a pool's tickers would leave
that arm building nothing and reading as a screen with no candidates rather than as a plumbing gap.

Critic verdicts come from the **same pool's** brief: a critic read of a ticker as a wheel candidate is an
opinion about owning it, which is not what an income candidate is being asked.

The comparison is reported over the **paired window only** — the dates every pool ran — with `pairedDays`
carried beside it, so that a wheel-only stretch cannot read as a one-sided win. At `pairedDays = 0` the
report states there is nothing to compare rather than showing an empty book beside a full one.

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
5. One contract's max loss exceeds the per-position budget (§3.5) — **`on` only, and therefore not yet
   implemented** (v1.1.300, S10). In `shadow` the budget sizes and never excludes: a rejection never becomes
   a position and so never settles, so gating here would shrink the §4 *sample* rather than the book, and §4
   measures a per-share ratio that does not depend on contract count. The candidate is kept with
   `contracts = 0`. Enforced in `budgetGates()` as an exhaustive switch over `SpreadModeSwitch`, so adding
   `'on'` to that union fails the build at this decision rather than silently inheriting today's answer.

No SMA50, IV-rank or credit-to-width gate (§2).

### 3.5 Sizing

- Settings: **`maxLossPerPosition`** ($), **`maxOpenPositions`** and **`maxOpenPerSector`** — operator numbers
  (§6 Q1, S9), edited in **Settings → Strategies** since v1.1.296 and written through `writeSpreadModeSettings`,
  which clamps to `SPREAD_MODE_LIMITS` and never stores a sector cap above the position cap.
- **Contracts** = floor(maxLossPerPosition ÷ max loss per contract), shown per pick with the total
  max loss. Open positions are not tracked in v1, so the position cap is shown as guidance.

- **Resolved 2026-09-20 (v1.1.300), was an open question under S10: in `shadow` the budget does not gate.**
  A candidate the budget cannot afford is recorded with `contracts = 0` instead of rejected, so the
  operator's budget still expresses the account without shrinking the evidence §4 is waiting on. `contracts`
  is never a divisor and `spread-mode-settle.ts` never reads it, so settlement and the gate's mean are
  unaffected. **A stored zero is the affordability flag** — `on` cannot produce one, because there the
  budget excludes (§3.4.5).
- **What this changes about the sample, stated plainly:** picks from 2026-09-21 onward are drawn from a
  wider candidate pool than those before it, and the §3.6 ranking now ranks unaffordable spreads alongside
  affordable ones, so the top-5 cut can differ. The §4 sample therefore has a seam at that date. It is
  recorded rather than smoothed, because an undeclared join between two differently-selected populations is
  the `iv_history` splice all over again — and unlike that one, this seam is documented on the day it was
  made. The report shows both books (`budget.affordable` beside `sectorCap.all`) so the two readings —
  about the strategy, and about this account — never have to be untangled later.

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

*Revision 2026-09-19 (v1.1.297): the captures the gate rests on get their own checks. `spread_chain_capture` is
written by TradeAnalyzer, so **TradeAnalyzer 2's quality gate says nothing about it**, and a silent capture
failure would decide §4 by shrinking or distorting the sample. `spread-capture-quality.ts` reports four, all
warnings and none blocking: SC-1 the capture has stopped while positions are open; SC-2 a live position was not
re-quoted on a day the capture ran (unrecoverable marks); SC-3 too many captures missing one of the two legs;
SC-4 an open position whose both-leg quotes have not moved for three captures. SC-2 compares against the days
the capture ran at all, so it needs no trading calendar and cannot fire on a holiday. Shown in the report, the
view and the script. **The proper fix stays (b):** move this capture into the collector once TA2 is promoted,
so it inherits the gate and the duplicate E*Trade fetching ends.*

*Revision 2026-09-19 (v1.1.296): the operator's numbers are editable in **Settings → Strategies** — mode
(shadow/off), max loss per position, max open positions, max open per sector — instead of being code defaults.
`writeSpreadModeSettings` is the single writer and clamps every value; the screen renders what was stored, not
what was typed. The shadow report reads the sector cap from the setting. `on` is not offered in the switch:
it does not exist until §4 passes.*

*Revision 2026-09-19 (v1.1.295): the report is also an in-app view, **🪜 Spread Shadow** (Intelligence). This is a
reading surface for the operator, not the `on` panel of §3.9: it shows shadow results and the gate, never a
pick to act on.*

*Revision 2026-09-20 (v1.1.299): a stored missing-leg rejection is judged under **both** bands — today's and
the one that made it. `diagnoseLegs` reads the live profile, so from v1.1.292 it applied the widened band
(S7) to rejections stored under the narrow one, and every chain the widening rescued was reported as
`legs present (another expiry was chosen)` — a label written one commit earlier, which the widening made
wrong. The band in force that day survives in the rejection's own text, because `buildBullPutSpread`
formats the live profile into both reasons ("no two-sided put at 0.25–0.35Δ"), so `parseLegBand` recovers it
with no new column. A rejection now reads `the widened rules would now build it` unless **both** bands find
legs, in which case the expiry really was the choice. This is what makes S7 checkable without waiting for a
run under the new rules: the count under that cause is the dry run of v1.1.292. Where a reason names only
its own half of the band the other half stays today's, which can only under-report the rule change, never
over-claim it. The report also returns the **stored** Settings → Strategies numbers, which `GET /settings`
(a fixed allowlist) never carried — until now the saved values could only be seen by opening the database.*

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
