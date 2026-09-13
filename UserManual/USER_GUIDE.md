<!--
SOURCE FILE — edit this Markdown, then regenerate the PDF.
Do not hand-edit the PDF. This .md is the source of truth and lives in the doc-maintenance loop.
-->

# TradeAnalyzer — User Guide

*A practical operator's guide. Version-tracked alongside the app. Last updated for v1.1.13.*

---

## 1. What this app is for

TradeAnalyzer helps you find, time, model, enter, and manage 1–2 month options-income and swing trades using math instead of gut feel. It scans the S&P 500 + Russell 1000 + ETF universe, ranks the best setups, builds a daily prioritized brief, models option payoffs, and tracks your portfolio synced from E*Trade.

For its core decision-support work it does **not** place orders: E*Trade is read-only — it reads quotes, option chains, and your positions, and you place those trades yourself in your broker.

A separate, **opt-in automated-execution engine** (v2) can place and manage defined-risk option trades for you — but it is **off by default**, **semi-automatic** (it proposes every order and you approve each one), and currently runs in **paper/simulation mode** (no real money). See §6.

**The mental model — five steps:**

> **Scan** the universe → **Score** and rank candidates → **Decide** on a specific trade → **Model** the option structure → **Track** the position and manage the exit.

Everything in the app maps onto one of those five steps.

---

## 2. First-time setup (do this once)

Open **⚙ Settings** (Data section of the sidebar) and work through these. Several features stay blank until the matching key is set.

1. **Polygon API key** — required. Powers stock quotes, fundamentals, and price history. Without it, screening and analysis won't work.
2. **Connect E*Trade** — required for option chains, Greeks, earnings dates, and portfolio sync.
   - Enter your consumer key + secret, click to start authentication, open the URL it gives you, approve, and paste the verifier code back.
   - **Tokens expire at midnight ET** and go idle after ~2 hours. If options/portfolio data stops loading, reconnect from Settings (or the app will prompt you).
3. **Anthropic (Claude) key** — optional but recommended. Powers the AI rationale in the Daily Brief, the AI Critic, the Portfolio Advisor, News synthesis, and the Payoff "Assess Trade" button. Without it, those features fall back to rule-only output (no crash).
4. **IV-history backfill** — important for premium selling. IV Rank is blank until you populate the history.
   - Add a MarketData.app key (Settings / Test API), then open **🗓️ History** and run the initial backfill (S&P 500, then Russell, then ETFs). After that, daily IV is captured automatically whenever a chain is fetched.
5. **Account size** — set this in Settings so the Portfolio screen can show Buying Power %.
6. **Email/SMTP** (optional) — lets the Daily Brief email itself to you with a PDF attached.

Once set up, the app auto-launches at login and keeps its data warm via background jobs (see §8).

---

## 3. Your daily routine

A typical morning:

1. **Open the app.** Background jobs have already refreshed quotes, fundamentals, technical signals, and IV overnight (16:30 ET the prior session).
2. **📋 Daily Brief** (Intelligence section) — read today's top scored picks per strategy (wheel / bullish / bearish / income / buy). Each pick shows a structure, an AI rationale, the AI Critic's verdict, and quick buttons to Payoff / Validate / Options / Analysis / E*Trade (opens the ticker's E*Trade quote page in your browser; ticker symbols in the brief email link there too). The **⚡ Conviction Alerts** strip at the top flags any of your "My Stocks" that just entered a buy zone.
3. **Triage.** For any pick worth pursuing, jump into Validate or Payoff (next section) to confirm and model it.
4. **Manage open positions.** Open **💼 Portfolio** and check the **⚡ Trade Management** banner — it flags positions at 50% profit, ≤ 21 DTE, or delta drift, and any earnings before expiry.

If the brief didn't run, you can trigger it manually from **🔄 Batch Jobs** → Daily Intelligence Brief → Run Now.

---

## 4. Core workflows

### 4.1 Find and validate a wheel / CSP trade

1. **🎯 Opportunity** (Screeners) — pick the Wheel or CSP strategy mode and run. You get a ranked table by composite Opportunity Score (fundamentals + IV rank + technical + premium yield). High IV rank floats premium-selling candidates up.
   *Alternative entry point:* **🔍 Screener** for a full fundamental filter run, or **📊 Analysis** to run all five modes over a watchlist.
2. Click a candidate to drill into **🎯 Validate** — the deep-dive dashboard: fundamental verdict, analyst opinion, trend, candlestick chart with entry/stop zones, RSI/MACD/Bollinger, and **IV rank/percentile**. An amber banner warns if earnings fall within ~45 days.
3. From there, open **📉 Options** to see the live chain. Find the strike/delta you want.
4. Click the **B** (buy) or **S** (sell) button on that contract → it sends the leg straight to **📐 Payoff**.

### 4.1a 🎲 Roll the Dice — one wheel trade, no reading

On the **Daily Brief**, next to *Run Now*, is **🎲 Roll the Dice**. It reduces the whole
brief to a single cash-secured put you can place without reading anything else — or it tells you
there isn't one today.

A pick has to clear every one of these. There is no scoring or weighing here; the brief has
already done that. This only removes:

| Gate | Why |
|---|---|
| Critic verdict is **pass** | A *caution* is something to read, and the point is not reading |
| Critic actually **ran** | A "pass" from the rule-based fallback is un-vetted, not an all-clear |
| Capital **≤ $30,000** | What you actually tie up (`strike × 100`), not the share price — the strike sits below spot, so a dearer stock struck low can cost less than a cheap one struck high |
| A real CSP exists on the chain | — |
| Liquidity **≥ 8/15** | You have to be able to get out |
| **No earnings before expiry** | And an unknown or stale earnings date also fails |
| Positive net credit | A zero credit is a broken chain, not a trade |

**"No dice today" is a normal answer.** On the stored history it produced a pick on about
**1 day in 3**. A version that always found something would have to lower its bar on exactly the
days the bar matters. Expand *"N rejected — why"* to see what it threw out and on which gate.

The card shows the strike and expiry, the credit, the cash required, your **cost basis if
assigned** and how far below the current price that is, the annualized return and probability of
profit, and the critic's own note.

**The exception, for when something is genuinely worth more capital.** A pick may go up to
**$50,000** — but only by clearing a higher bar on *every* count at once: it is on your **My
Stocks** conviction list, its strike is at or below the *never enter above* price **you** set for
it, its score is ≥ 70 (a normal good pick is ~66), and liquidity is ≥ 11/15. Every one of those is
something you decided *before* seeing the setup, which is the whole idea — an exception you can
argue yourself into is not an exception. On the last three months of briefs it would have fired
**twice**. When it does, the card and the email say so *above* the order, with the amount and the
reason, so it can never slip past as an ordinary night.

**It emails itself.** After the evening batch you get a one-card email — the subject alone carries
the trade (`🎲 NVDA — sell the $205 put, Fri Sep 25 · $744 credit`), so you can read it from a
phone notification. Inside: the order to place, what you collect, the cash required, and what you
would own it at if assigned. **You get one on no-pick days too**, saying so in a line — otherwise
silence would be indistinguishable from a batch that failed. The **✉ Email it** button on the
card sends the same thing on demand.

> **The name is the disclaimer.** These gates remove known, checkable problems — a flagged
> setup, an earnings print, an illiquid chain, a position too big for the account. They cannot
> make a trade safe. It is still a short put, you can still be assigned, and the stock can still
> fall well below your cost basis. Nothing here is investment advice.

### 4.1b 🎯 Wheel Shortlist — the five best puts at your profile

Also on the **Daily Brief**: **🎯 Wheel Shortlist**. Where Roll the Dice gives one trade, this gives
the **top 5 cash-secured puts** at your chosen profile — **0.35–0.45 delta, 14–30 days to expiry** —
ranked by **return on capital**, and priced live from E\*Trade when you press it.

**Where the names come from.** The latest brief run's wheel and income candidates that cleared the
liquidity check. The brief's composite score is *not* used to rank them: its top end has measured as
a worse predictor than its middle. Each candidate is excluded if the critic flagged it, if its
earnings date is unknown or stale, if it reports before every 14–30 day expiry, or if no put at
0.35–0.45 delta has a real two-sided quote. Expand *"N excluded — why"* to see which.

**Each row shows** the put and expiry, the return on capital per year, the credit per contract (and
the bid), the **cash required** (never filtered — sizing is your call), delta (roughly the odds of
finishing in the money), the bid/ask spread, the next earnings date, the critic's verdict if it
reviewed the name, and **roll room**. Hover a row for the own-at-strike read.

**Roll room is your roll rule, checked today.** Your rule: *if the put is in the money with 7 or
fewer days left, roll out to the next 14–30 day expiry at the same or a lower strike for a net
credit; if no credit roll exists, close it.* Roll room looks at the expiry a week or so later and
reports how far down you could roll for a credit **at today's prices**. At a real roll the put will
be in the money and cost more to buy back, so treat it as a comparison between names, not a promise.

**It emails itself after both brief runs** (`🎯 Wheel Shortlist — 5 ideas · top: … · 10:28 ET`),
including on days when nothing qualified. **✉ Email it** sends it on demand.

> **Advisory, and not yet validated on this profile.** The ranking by return on capital was measured
> on 0.20–0.35 delta puts at 30–45 days; your profile is outside that. TradeAnalyzer 2 is collecting
> the daily option chains needed to measure this exact profile — including your roll rule — and the
> first real answers arrive around late October.

### 4.2 Model a structure in Payoff

The **📐 Payoff** screen is where you confirm the trade before placing it:
- See the **P&L curve** with max profit, max loss, and breakeven(s).
- Toggle to the **⬛ Risk Matrix** — a price × date grid showing P&L over time (Black-Scholes pre-expiry), with your strikes highlighted and the earnings date column flagged amber.
- An amber **earnings strip** appears under the chart if the stock reports before expiry.
- Click **✨ Assess Trade** for an AI second opinion (needs the Anthropic key).
- Use the **strategy template dropdown** to auto-build any of 31 structures with live strikes and premiums.

### 4.3 Let Strategy Lab pick the best structure

Not sure which structure fits? Open **🔬 Strategy Lab**, enter a ticker, and the **Validate** tab scores all 31 tastylive strategies (IV fit + direction + premium + liquidity → A+/A/B/C/F). The **Explore** tab builds the concrete legs for any one of them. "View in Payoff" sends it over to model it.

### 4.4 Check earnings risk

**📅 Earnings** shows a monthly calendar (toggle to a list) of upcoming reports across the universe. Blue chips are confirmed dates; amber ⚠ chips are weekend-adjusted/unconfirmed. Click any ticker to jump to its Validate dashboard. Earnings also surface automatically as banners/badges in Validate, Payoff, and Portfolio — so you rarely get surprised.

### 4.5 Track and manage open positions

**💼 Portfolio** (Personal section):
- **Sync from E*Trade** to pull live positions, P&L, and Greeks; **Import Closed (YTD)** pulls your closed trades from transaction history.
- The **aggregate Greeks bar** shows Net Δ, Θ/day, Vega, and BP Used %.
- The **⚡ Trade Management** banner enforces discipline: Take Profits at ≥ 50%, Manage Now at ≤ 21 DTE, Delta Drift beyond 0.45.
- **⚡ Refresh Greeks** pulls fresh per-position Greeks.
- **AI Portfolio Advisor** tab gives a Claude-written review of your whole book.

### 4.6 Review how your picks performed

**🪞 Retrospect** (Intelligence) auto-tracks every Daily Brief pick as a paper trade and scores it over time. Tabs: In Progress, Summary (win rate per strategy), History, Settings. This is the feedback loop that tells you which strategies and signals actually work — and it feeds weight suggestions back into Trade Scoring.

### 4.7 Track your personal high-conviction names

**⭐ My Stocks** (Personal) is your conviction list. For each name you set three price bands — *buy here* / *experimental* / *never above*. When a stock drops into your buy zone you get a toast notification, a count badge on the sidebar, and a callout at the top of the Daily Brief.

---

## 5. Screen map (what each view is for)

**Data**
- **⚙ Settings** — API keys, E*Trade connection, account size, email, options-provider choice.
- **⚖ Trade Scoring** — tune the scoring weights per strategy (see §9).
- **🔄 Batch Jobs** — the background job scheduler (see §8).

**Intelligence**
- **📋 Daily Brief** — today's top scored picks per strategy, with AI rationale + critic. Includes **🎲 Roll the Dice** (§4.1a): one wheel entry that clears every gate, or an explicit nothing.
- **🪞 Retrospect** — paper-trade tracking of past picks; win rates and learnings.
- **📅 Earnings** — earnings calendar (month/list) across the universe.
- **🤖 Agent** — view/run the external autonomous TraderAgent.

**Execution** (v2 — opt-in, paper/mock for now)
- **🤝 Trading Desk** — start/stop the execution engine, approve/reject order proposals, watch open positions and the activity log (see §6).
- **🎚️ Execution Settings** — the engine's rules: risk limits, entry/exit policy, paper/live mode (see §6).

**Screeners**
- **🔍 Screener** — full fundamental filter run over a universe; save results as a watchlist.
- **📡 News & Research** — AI research dossier per ticker, ranked by impact score.
- **🎯 Opportunity** — one-click ranked "best setups right now" by composite score.
- **🎛️ Filters** — one-click pre-built scans (RSI, IV high/low, assignment risk, wheel). Universe choices include **All** (S&P + Russell + ETFs), and the nightly batch precomputes every filter over All — each filter card shows a match-count badge and opens instantly with the latest batch results (`batch ran …` stamp); ↻ Re-run fetches live.

**Analysis**
- **📐 Payoff** — multi-leg payoff modeling, risk matrix, AI assessment.
- **🎯 Validate** — per-stock deep-dive dashboard.
- **📉 Options** — live option chain with B/S buttons into Payoff.

**Strategy**
- **📚 Knowledge** — embedded reference for all 31 option strategies.
- **📊 Analysis** — run all five analysis modes over a watchlist.
- **🔬 Strategy Lab** — score/explore all 31 strategies for a ticker.
- **⚡ LEAPS** — LEAPS + CSP pairing screener.
- **🛡️ Collared LEAPS** — deep-ITM LEAPS + protective put screener.

**Misc** — a single **🗂️ Misc** entry opens a landing screen with these occasional tools:
- **🔔 Alerts** — price/expiration/delta alerts.
- **🔁 Backtest** — simulate CSP/CC/Wheel strategies on history.
- **🔬 Test API** — inspect raw provider responses (diagnostics).
- **🗄️ Data Sync** — manual universe/price refreshes.
- **🗓️ History** — IV-history backfill + bulk price loading.

**Personal**
- **⭐ My Stocks** — conviction list with price bands.
- **💼 Portfolio** — positions, P&L, Greeks, advisor.

---

## 6. Automated execution (Trading Desk)

> **New in v2, and deliberately conservative.** The execution engine can place and manage
> trades for you, but it is **off by default**, **semi-automatic**, **defined-risk only**,
> and currently trades in **paper/simulation mode** (a built-in mock broker — no real money
> and no broker account required). Think of it as a co-pilot you approve every move for, not
> an autopilot.

### How it works

The engine proposes a trade; **you approve it** before anything is placed; then the engine
manages the position to its exit per your rules. Nothing happens while the engine is
**Stopped** (its default state), and a master **Stop** is a hard stop. Two screens drive it:

**🤝 Trading Desk** — the control room:
- **Status header** — a **PAPER/LIVE** badge and the engine state (Stopped / Running / Paused / Kill-tripped).
- **Engine** — **Start**, **Pause**, and **Stop** (hard stop), plus broker-connection and health readouts.
- **Kill switch** — a one-click halt that blocks new entries; it also trips automatically if the day's loss hits your limit. Clear it manually when you're ready to resume.
- **Capital** — how much of your capital ceiling is deployed, today's realized + unrealized P&L, and the daily-loss trip level.
- **Proposals** — pending order proposals (entries and exits). **Approve** or **Reject** each. In paper mode approval is one click; in live mode you must type the ticker to confirm (a guard against fat-finger orders).
- **Open positions** and an **activity log** of everything the engine has done.

**🎚️ Execution Settings** — the rule book the engine obeys (it re-reads these every cycle):
- **Mode** — paper vs live, and which strategies are eligible (launch scope is *inflection* spreads only).
- **Risk limits** — capital ceiling, max risk per trade, max concurrent positions, daily-loss trip %, and per-ticker / per-strategy caps.
- **Entry policy** — minimum score, max new entries per day/week, the entry time window, proposal shelf-life, and a re-price tolerance.
- **Exit policy** — protective stop (× credit) and defensive-expiry close, plus a profit target and time-based exit that can either *propose* or act *automatically*.

Edit a value, **Save**, and it applies on the next cycle. Switching to **live** mode is confirmation-gated.

### What it won't do (yet)

Right now there is **no broker account wired in**, so the engine runs entirely on the paper
mock and won't generate its own entry proposals — the live-data hookup arrives with the
broker integration. You can still start the engine, watch it manage state, and exercise the
controls end-to-end in paper mode. Real-money trading is a later, deliberately gated step.

---

## 7. Watchlists

Watchlists feed Analysis and Validate. Create as many as you like (names are unique). The **Default** list can be renamed but not deleted. Add tickers individually or import a CSV (the only required column is `ticker`). You can also save any screener or analysis result set straight into a new watchlist.

---

## 8. Background jobs (Batch Jobs)

**🔄 Batch Jobs** runs the daily maintenance that keeps everything fast. You rarely touch it, but it's worth knowing:

- Most jobs chain at **16:30 ET** after market close: market sync (quotes + fundamentals), price gap fill, technical signals, then the Daily Brief.
- The **earnings refresh** and **options snapshot** run on startup; earnings uses smart caching so it mostly skips.
- Each job can be **Run Now** manually, has an editable schedule and rate-limit delay, and streams a live per-ticker log while running.
- A master **enable toggle** (top of the screen) pauses all scheduled/startup runs for the session if you want quiet.

If a job shows "skipped," it usually means E*Trade isn't connected — reconnect and re-run.

---

## 9. Tuning the scoring engine

**⚖ Trade Scoring** lets you adjust how candidates are ranked for each of the five strategies. Each strategy has a set of weighted signals (IV rank, trend, growth, liquidity, momentum, etc.) whose weights sum to 100. Drag the weights, toggle signals on/off, and the Daily Brief uses your config on its next run. **Reset to Baseline** restores the shipped defaults. The Retrospect feedback loop suggests which signals correlated with winners.

---

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| Options / portfolio data won't load | E*Trade token expired (midnight ET) or idle. Reconnect in **⚙ Settings**. |
| IV Rank is blank everywhere | Run the IV-history backfill in **🗓️ History** (needs a MarketData.app key). |
| A batch job says "skipped" | E*Trade not connected — reconnect and Run Now. |
| AI rationale / Critic / Advisor missing | No Anthropic key set, or it's invalid. Add it in **⚙ Settings**. |
| Daily Brief didn't appear | Trigger it manually: **🔄 Batch Jobs** → Daily Intelligence Brief → Run Now. |
| Numbers look stale | Check the freshness timestamp on the screen; run **🗄️ Data Sync** or the relevant batch job. |
| Earnings date looks a day off | E*Trade returns UTC dates; the app shifts weekend dates to Friday and marks them unconfirmed (amber ⚠). |
| Trading Desk shows no proposals | Expected for now — the engine runs on the paper mock with no live-data hookup yet, so it generates no entries (see §6). |
| Execution engine won't start | It refuses to start if it can't reconcile state; check the activity log. The engine is also Stopped by default — that's normal. |

---

## 11. A note on discipline

The app is built around a few hard rules that consistently improve premium-selling results. Let it enforce them:
- Don't sell premium when **IV rank is low** (the market is underpaying).
- **Avoid earnings** inside your DTE window unless you mean to trade them.
- **Take profits at ~50%** of max credit; **manage at 21 DTE**; cut when a short option's delta drifts past ~0.45.
- Size positions against your **account's buying power**, which the Portfolio Greeks bar tracks for you.

That's the whole loop: scan, score, decide, model, track — with the math doing the remembering.
