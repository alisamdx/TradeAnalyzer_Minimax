<!--
SOURCE FILE — edit this Markdown, then regenerate the PDF.
Do not hand-edit the PDF. This .md is the source of truth and lives in the doc-maintenance loop.
-->

# TradeAnalyzer — User Guide

*A practical operator's guide. Version-tracked alongside the app. Last updated for v0.32.6.*

---

## 1. What this app is for

TradeAnalyzer helps you find, time, model, enter, and manage 1–2 month options-income and swing trades using math instead of gut feel. It scans the S&P 500 + Russell 1000 + ETF universe, ranks the best setups, builds a daily prioritized brief, models option payoffs, and tracks your portfolio synced from E*Trade.

It does **not** place orders. E*Trade is read-only — it reads quotes, option chains, and your positions. You always place trades yourself in your broker.

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

Once set up, the app auto-launches at login and keeps its data warm via background jobs (see §7).

---

## 3. Your daily routine

A typical morning:

1. **Open the app.** Background jobs have already refreshed quotes, fundamentals, technical signals, and IV overnight (16:30 ET the prior session).
2. **📋 Daily Brief** (Intelligence section) — read today's top scored picks per strategy (wheel / bullish / bearish / income / buy). Each pick shows a structure, an AI rationale, the AI Critic's verdict, and quick buttons to Payoff / Validate / Options. The **⚡ Conviction Alerts** strip at the top flags any of your "My Stocks" that just entered a buy zone.
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
- **⚖ Trade Scoring** — tune the scoring weights per strategy (see §8).
- **🔄 Batch Jobs** — the background job scheduler (see §7).

**Intelligence**
- **📋 Daily Brief** — today's top scored picks per strategy, with AI rationale + critic.
- **🪞 Retrospect** — paper-trade tracking of past picks; win rates and learnings.
- **📅 Earnings** — earnings calendar (month/list) across the universe.

**Screeners**
- **🔍 Screener** — full fundamental filter run over a universe; save results as a watchlist.
- **📡 News & Research** — AI research dossier per ticker, ranked by impact score.
- **🎯 Opportunity** — one-click ranked "best setups right now" by composite score.
- **🎛️ Filters** — one-click pre-built scans (RSI, IV high/low, assignment risk, wheel).

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

**Misc**
- **🤖 Agent** — view/run the external autonomous TraderAgent.
- **🔁 Backtest** — simulate CSP/CC/Wheel strategies on history.
- **🔬 Test API** — inspect raw provider responses (diagnostics).
- **🗄️ Data Sync** — manual universe/price refreshes.
- **🗓️ History** — IV-history backfill + bulk price loading.
- **🔔 Alerts** — price/expiration/delta alerts.

**Personal**
- **⭐ My Stocks** — conviction list with price bands.
- **💼 Portfolio** — positions, P&L, Greeks, advisor.

---

## 6. Watchlists

Watchlists feed Analysis and Validate. Create as many as you like (names are unique). The **Default** list can be renamed but not deleted. Add tickers individually or import a CSV (the only required column is `ticker`). You can also save any screener or analysis result set straight into a new watchlist.

---

## 7. Background jobs (Batch Jobs)

**🔄 Batch Jobs** runs the daily maintenance that keeps everything fast. You rarely touch it, but it's worth knowing:

- Most jobs chain at **16:30 ET** after market close: market sync (quotes + fundamentals), price gap fill, technical signals, then the Daily Brief.
- The **earnings refresh** and **options snapshot** run on startup; earnings uses smart caching so it mostly skips.
- Each job can be **Run Now** manually, has an editable schedule and rate-limit delay, and streams a live per-ticker log while running.
- A master **enable toggle** (top of the screen) pauses all scheduled/startup runs for the session if you want quiet.

If a job shows "skipped," it usually means E*Trade isn't connected — reconnect and re-run.

---

## 8. Tuning the scoring engine

**⚖ Trade Scoring** lets you adjust how candidates are ranked for each of the five strategies. Each strategy has a set of weighted signals (IV rank, trend, growth, liquidity, momentum, etc.) whose weights sum to 100. Drag the weights, toggle signals on/off, and the Daily Brief uses your config on its next run. **Reset to Baseline** restores the shipped defaults. The Retrospect feedback loop suggests which signals correlated with winners.

---

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| Options / portfolio data won't load | E*Trade token expired (midnight ET) or idle. Reconnect in **⚙ Settings**. |
| IV Rank is blank everywhere | Run the IV-history backfill in **🗓️ History** (needs a MarketData.app key). |
| A batch job says "skipped" | E*Trade not connected — reconnect and Run Now. |
| AI rationale / Critic / Advisor missing | No Anthropic key set, or it's invalid. Add it in **⚙ Settings**. |
| Daily Brief didn't appear | Trigger it manually: **🔄 Batch Jobs** → Daily Intelligence Brief → Run Now. |
| Numbers look stale | Check the freshness timestamp on the screen; run **🗄️ Data Sync** or the relevant batch job. |
| Earnings date looks a day off | E*Trade returns UTC dates; the app shifts weekend dates to Friday and marks them unconfirmed (amber ⚠). |

---

## 10. A note on discipline

The app is built around a few hard rules that consistently improve premium-selling results. Let it enforce them:
- Don't sell premium when **IV rank is low** (the market is underpaying).
- **Avoid earnings** inside your DTE window unless you mean to trade them.
- **Take profits at ~50%** of max credit; **manage at 21 DTE**; cut when a short option's delta drifts past ~0.45.
- Size positions against your **account's buying power**, which the Portfolio Greeks bar tracks for you.

That's the whole loop: scan, score, decide, model, track — with the math doing the remembering.
