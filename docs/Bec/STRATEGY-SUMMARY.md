# Bec — strategy summary, and what it means for our engine

Extracted 2026-09-09 from five video transcripts in this folder (~16,000 words). Everything in
§1–§6 is **her** stated method, paraphrased. §7 onward is **our** comparison and is the part worth
arguing with.

Source files:

| # | Video | Mostly about |
|---|---|---|
| 1 | $1035 Per Week With Options — My Exact Trades | account structure, trade mix, capital rotation |
| 2 | High Premium Options Stocks | *why* premium exists; who buys what you sell |
| 3 | My Rules To Sell Options On A Smaller Account | the CSP entry rules — universe, timing, strike, roll-vs-assign |
| 4 | Selling Covered Calls Below Purchase Price | repairing an underwater position |
| 5 | These Options Positions Give Me High Returns And Lower Risk | the "anchor" concept |

She states in every video that this is not advice and that nobody should copy it. Treat this
document the same way: it is a specification of someone else's system, written so we can test the
parts of it that are testable.

---

## 1. The organising idea: premium is demand, and demand only exists in uptrends

This is the spine of her whole approach, and it is the piece our engine has no representation of.

She reasons from **who is on the other side of the trade**. Puts are bought by two groups: holders
locking in gains, and bears betting on a fall. Calls are bought by people who need a *fast* rise to
profit. Then:

- **In an uptrend** there are gains worth protecting, there is fear of missing out, and there are
  bears betting the top is in. All three groups are buying. Premium is rich, and the option chain
  is wide — you can sell far out of the money and still get paid.
- **After a sustained fall** nobody has gains left to protect, the bearish bet is already spent, and
  a fast rise is hard to believe in. Buyers evaporate, premium collapses, and the range of usable
  strikes narrows.

Her conclusion is that IV is a *symptom*, not an input. She says outright that she does not look at
implied volatility or IV rank — she looks at whether the chart is going up, and treats that as the
whole barometer.

**The trap she names:** you sell a put on a falling stock while premiums still look good, get
assigned, plan to "just sell calls until it recovers" — and by then the call premium has dried up
and the strikes near your cost basis pay nothing. You are left holding capital you cannot earn on.

## 2. Universe: uptrending, quality, and understood

- **Uptrend is non-negotiable.** She will not sell puts on names in a downtrend regardless of how
  good the premium looks.
- **Cheap is not diversification.** She explicitly rejects the 10%-per-ticker rule for a small
  account, because on a $50k account it forces you into sub-$50 stocks, which are cheap for a
  reason. She would rather hold two or three high-quality uptrending names she knows her way out
  of.
- **Sourcing hack:** read the holdings of **SPMO** (an S&P 500 momentum ETF) as a pre-filtered list
  of names already in an uptrend, then apply her other criteria.
- **Understood, not screened.** Repeatedly: do the work on a company once, then trade it over and
  over, rather than hunting a new ticker every week.

## 3. Entry timing: one indicator

**Stochastic RSI**, used only for its turn:

- Do not enter while it is pointing down — more down usually follows.
- Enter when it has reached the bottom and turned back up.
- She is explicit it is not a crystal ball; the claim is only that *most of the down move is
  probably behind you*.
- She rejects "wait for a green day" — the colour of the day is irrelevant, the direction of the
  next likely move is what matters.

## 4. Strike selection: support, not delta

She says she does not look at delta at all when setting a CSP strike.

1. Find the **support level**.
2. Put the strike **below** it — never at it.

The reasoning is about what happens *after* assignment: if you strike at support and support
breaks, you now own stock **above resistance**, which is much harder to sell calls against or exit.

If the premium at the safer strike is unattractive, she takes **no trade** rather than moving the
strike up. And if premium at the safe strike is unusually rich, she will go *lower still* and accept
less — because a strike $10 lower is a materially safer trade, and if the stock runs she can **roll
the strike up** later to recapture the premium she left on the table.

## 5. Management: don't get assigned

Her stated number-one rule for a small account, and the sharpest break from textbook wheel doctrine.

**Roll vs assign — the asymmetry she uses:**

- Rolling gives two *guarantees*: an extra credit, and a lower assignment price. She will not roll
  unless both hold.
- Assignment guarantees only that you own the shares.
- So in a small account, where capital preservation dominates, rolling wins on the guarantees.

**Roll early.** It is easier to roll at or near the strike than after a deep breach. Once price is
far below, the roll gets expensive and the tenor gets long.

**Know when to stop rolling.** If she no longer believes the stock recovers to the strike, she cuts
and takes the loss rather than rolling indefinitely. A small loss now beats capital dead in a
falling name.

**Larger/longer-horizon accounts differ.** She let the same position assign in a retirement account
— because a 20-year horizon can absorb it — while rolling the identical position in the small
account. The account's horizon changes the decision, not the chart.

## 6. Two structures worth naming

### 6a. "Anchors"

A small number of deliberately-chosen stock positions, held to sell covered calls against week
after week. The distinguishing claim:

> An anchor is chosen on purpose. It is not whatever a CSP happened to assign you.

Criteria: upward trending, good premium, ETFs favoured for lower single-name risk, a business she
understands with stability and increasing earnings, and a chart she can follow.

**Why she prefers this to pure put-selling — the risk-direction argument.** Every covered call sold
against an anchor *reduces* cost basis, so the risk line only ever moves down. A put-seller who
keeps rolling strikes up in a rising market has a risk line that moves *up*. That asymmetry is her
stated reason for anchoring a chunk of the portfolio in stock.

She also accepts **rolling sideways** — same strike, next week — purely to collect the weekly
premium target, on the grounds that redeploying that capital elsewhere would require a *new* trade
to go the right way, whereas the anchor's risk is already known and already out of the money.

### 6b. Covered calls below cost basis

For a position already underwater, assuming you still believe it recovers (if not, exit):

- **Tight expiries** — one week, two at most, to keep control.
- **Timing matters more than the strike.** Sell when price is being **rejected** by a moving average
  (next move likely down). Wait when price is far *extended below* the next moving average above,
  because it tends to come back up and test it.
- **Do not wait for a green day.** Red days put the call into profit immediately.
- **Roll before it gets deep** in the money, or the roll costs months of tenor.
- **Do not reflexively take 50% profit** on the call while the stock is still falling — the call is
  cushioning the stock's loss, and closing it re-exposes you dollar-for-dollar.
- **Do not buy back a breached call hoping for a run.** If the run does not come you have paid a
  loss and raised the price at which you must sell.

**Rollability check** — the most mechanisable idea in the whole set. Before accepting a strike, look
at the cost to buy back the first in-the-money call, then look forward one week, two weeks, a month:
how many strikes up can that same credit buy you? That tells you how far into the future you would
have to go to get back above your break-even. If the answer is a year, the trade is a trap.

## 7. Where this agrees with what we have already measured

Some of her claims line up with findings this project reached independently and the other way
round — which is worth saying, because it raises confidence in both.

- **Premium richness is not a mistake to avoid.** v1.1.176 measured that ranking the whole universe
  on premium richness *beats* no selection (+1.03 mean / +2.67 median), and that ranking on the
  lowest premium is the worst rule tested. Her "rich premium is a symptom of demand, trade it" is
  consistent with that.
- **It also refuted our own earlier story.** v1.1.173 found the composite anti-predictive at the top
  and I attributed that to `ivRank` + `premiumYield` rewarding premium richness. v1.1.176 killed
  that attribution. Her framing — richness is *information about demand*, not a risk premium you
  are being paid to eat — is a better fit for the data we actually have.
- **Liquidity is a risk proxy, not a quality signal** (v1.1.170, reproduced v1.1.176 on 23,722
  snapshots). She never treats a liquid chain as a reason to trade; she treats a *narrowing* chain
  as a symptom of a dying uptrend. Same observation, opposite direction of use.

## 8. Where it conflicts with our engine — the interesting part

Our wheel composite (`BASELINE_WHEEL`, weights summing to 100):

| Signal | Weight | Bec's view |
|---|---|---|
| `ivRank` | 22 | **Does not use IV at all.** Uptrend is the proxy. |
| `premiumYield` | 19 | Agrees it matters — but as a *consequence* of trend, not an independent axis |
| `fundamentalScore` | 17 | Agrees strongly — "a company you understand, increasing earnings" |
| `technicalNeutral` (RSI 40–60) | 11 | **Direct conflict** — see below |
| `recentVolatility` (lower better) | 10 | Partial conflict — her names are high-vol momentum names |
| `optionLiquidity` | 9 | Uses chain *width* as a trend health check, not a score |
| `notDowntrend` | 8 | **This is her #1 gate, and we have it at weight 8** |
| `leverageQuality` | 4 | Compatible |

Three concrete disagreements:

**1. We reward neutral; she requires bullish.** `technicalNeutral` scores RSI 40–60 highest — we are
explicitly paying for *neutrality*. She wants an uptrend with stochastic RSI turning up off a low.
These select nearly disjoint sets. This is the single largest philosophical gap.

**2. Trend is a weight for us and a gate for her.** At weight 8 of 100, `notDowntrend` cannot veto a
pick that scores well on IV rank and yield. For her, a downtrend is disqualifying regardless of
every other input.

**⚠ But we have prior evidence pointing the other way, and it must not be ignored.** Three trend-ish
rules have already been tested and rejected on our data: the SPY-regime gate, the overbought guard,
and ADX in scoring (removed v1.1.33 as anti-predictive — high-ADX names mean-revert over ~21 days).
That is *not* the same test as hers — ADX measures trend *strength*, and a SPY regime gate is a
market-wide filter, whereas she is describing per-name price structure (above rising MAs, stoch RSI
turning up). But anyone proposing "uptrend only" here should expect it to be a hard sell against
that history, and should design the A/B to distinguish *her* rule from the three we already killed.

**3. Assignment.** Our whole wheel frame treats assignment as an acceptable outcome — the
own-at-strike work (T8, 1,585 episodes) is literally about *how well you own it*. Her small-account
frame treats assignment as the failure mode. Both can be right at different account sizes; we
currently encode only one of them, and we encode it implicitly.

## 9. What is missing from our engine entirely

Ranked by how mechanisable each is, most first:

1. **Rollability score.** Given a strike, a cost basis and a chain: how far up can one week of
   credit move the strike, and how many weeks to get back above break-even? Pure chain arithmetic,
   no new data, and it converts "can I get out of this?" from a feeling into a number. **We already
   store the chains this needs.** Highest value-to-effort ratio on this list.
2. **Strike-from-support instead of strike-from-delta.** We already have
   `src/main/services/support-resistance.ts` (`findRecentDemandZone`, `computeEntryZoneAndStop`) and
   it is not wired into wheel strike selection. Placing the strike below the demand zone, and
   *rejecting the trade* when premium there is inadequate rather than climbing the chain, is a
   concrete alternative policy that Brief Replay could A/B.
3. **Stochastic RSI.** We compute RSI, SMA20/50/200, ADX, ATR — but not stoch RSI. It is a cheap
   derived indicator over data we already hold, and it is the only entry-timing input she uses.
4. **Chain-width / strike-availability as a trend-health signal.** Her "the usable strikes have
   narrowed" observation is measurable from the chains we already store, and we have never looked
   at it.
5. **Anchor positions as a first-class object.** A deliberately-held covered-call position with a
   weekly premium target, a declining cost basis, and a rule that says "roll sideways for the
   credit rather than redeploy". We have portfolio tracking and covered-call analysis, but nothing
   that models a position as a *deliberate income anchor* with its own targets.
6. **Cost-basis-decline tracking.** She judges an anchor by whether the risk line only ever falls.
   We track realised P&L per position but do not surface cumulative premium as a running reduction
   in basis.
7. **Opportunity cost / capital rotation.** She treats capital sitting in an unrecoverable assigned
   position as the primary small-account failure. We have no measure of capital-days consumed per
   dollar of premium.

## 10. Proposed order of work

Everything here is a **candidate**, and under FR-SEY-5 anything that changes which trades the engine
takes has to show at worst neutral on Brief Replay / Backtest before it ships enabled.

**Tier 1 — build it, it is additive and cannot make anything worse:**

- ~~Rollability score (§9.1).~~ **Shipped v1.1.240 (2026-09-12)** — a panel on the Roll Analyzer.
  It adds information to a decision we already make and gates nothing.
- ~~Stochastic RSI as a *displayed* indicator (§9.3)~~ **Shipped v1.1.358 (2026-10-13)** — the Daily
  Brief grid's Stoch RSI column (`turned_up` / `rising` / `falling`), display only, so we can see it
  on picks before deciding whether it should influence anything.
- Cumulative-premium-vs-basis on portfolio positions (§9.6). Reporting only.

**Tier 2 — measurable A/Bs, run before believing:**

- Strike-from-support vs strike-from-delta on the wheel path (§9.2).
- `technicalNeutral` → a bullish-structure signal, replayed head-to-head (§8.1). This is the one
  most likely to fail given the ADX history, and the most valuable to settle either way.
- `notDowntrend` promoted from weight 8 to a gate (§8.2), designed so it is distinguishable from the
  already-rejected SPY-regime gate.

**Tier 3 — design work first, not code:**

- Anchors as a portfolio object (§9.5) — this is a UI and data-model question, not a scoring one.
- An explicit account-size / horizon mode that switches assignment between "acceptable" and "avoid"
  (§8.3). Right now that assumption is buried.

**Do not do:**

- Do not drop `ivRank` because she does not use it. She trades a handful of names she knows by eye;
  we rank a 1,089-name universe and need a numeric premium-richness axis. Her argument is that IV
  is *downstream* of trend — which is a claim we can test directly by measuring the correlation on
  our own snapshots before touching any weight.
