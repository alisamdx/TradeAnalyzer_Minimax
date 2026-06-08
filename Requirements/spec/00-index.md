# TradeAnalyzer — Software Specification (Master Index)

**Version of record:** v0.32.6 (pre-1.0.0) · **Last regenerated:** 2026-06-07

---

## Purpose of this specification

This is the **authoritative, self-contained specification** for TradeAnalyzer. It is written so that **the entire application can be reconstructed from this document alone**, with no access to the existing source code. If the codebase were lost, a competent engineer (or AI coding agent) could rebuild a functionally equivalent app using only the files in this `spec/` folder.

To meet that bar, every section is **functional + data + formulas**:
- **Functional** — what each feature does, its screens, its workflows, its business rules.
- **Data** — the exact SQLite schema (every table and column) that backs each feature.
- **Formulas** — every financial/derived calculation, written out in full (no external references).

UI is described by **layout and intent**, not pixel-level CSS. Two implementations built from this spec should behave identically; they need not look byte-identical.

> This `spec/` folder supersedes all earlier requirements documents. The originals are preserved in `Requirements/_legacy/` for historical rationale only — they are **not** authoritative and are partially outdated.

---

## How to use this document

1. Read **`01-overview-and-architecture.md`** end-to-end first. It defines the stack, process model, data flow, and the conventions every other section assumes.
2. Read **`02-data-model.md`** and **`03-data-providers.md`** next. Almost every feature reads/writes the schema in §02 and pulls data through the providers in §03.
3. Each feature section (04–22) is self-contained: it states its purpose, screens, workflows, rules, the tables it owns, the IPC surface it exposes, and the formulas it uses (cross-referencing §23 for shared math).
4. **`23-formulas.md`** is the consolidated formula reference — every derived metric in one place, fully written out.
5. **`24-engineering-practices.md`** defines versioning, changelog, logging, testing, and packaging discipline. These are mandatory, not optional.

---

## Suggested rebuild order

A from-scratch rebuild should proceed roughly in this order (each layer depends on the ones above it):

| Phase | Build | Sections |
| --- | --- | --- |
| 1 | Shell, DB wrapper, migrations, settings, IPC plumbing | 01, 02, 24 |
| 2 | Data providers + rate limiter + caching | 03 |
| 3 | Watchlists + constituents/universe | 04 |
| 4 | Screener + filter templates | 05 |
| 5 | Analysis engine + validation dashboard | 06, 07, 23 |
| 6 | Options chain + payoff + strategy lab + LEAPS screeners | 08, 09, 10 |
| 7 | IV history + opportunity + scoring engine | 11, 12, 13 |
| 8 | Daily brief + critic + retrospect + news + earnings | 14, 15, 16, 17 |
| 9 | Portfolio + conviction + alerts | 18, 19 |
| 10 | Batch scheduler + jobs + backtesting + agent API | 20, 21, 22 |

---

## Section map

| # | File | Covers |
| --- | --- | --- |
| 00 | `00-index.md` | This index, glossary, rebuild order |
| 01 | `01-overview-and-architecture.md` | Product, users, scope, stack, process model, data flow, project layout, NFRs |
| 02 | `02-data-model.md` | Full SQLite schema — every table & column |
| 03 | `03-data-providers.md` | DataProvider/OptionsProvider, Polygon, E*Trade OAuth, MarketData/IVolatility, Anthropic, SEC EDGAR, rate limiting, caching |
| 04 | `04-watchlists.md` | Watchlist CRUD, tickers, CSV import/export |
| 05 | `05-screener-and-filters.md` | Index screener (17 filters, presets, runs), filter templates |
| 06 | `06-analysis-engine.md` | Five analysis modes + indicator library |
| 07 | `07-validation-dashboard.md` | Per-stock validation, Validate All |
| 08 | `08-options-chain-and-payoff.md` | Options chain view, multi-leg payoff visualizer, risk matrix |
| 09 | `09-strategy-lab-and-knowledge.md` | 31-strategy scorer/explorer, embedded knowledge base |
| 10 | `10-leaps-strategies.md` | LEAPS+CSP screener, Collared LEAPS screener |
| 11 | `11-iv-history.md` | True IV rank/percentile pipeline |
| 12 | `12-opportunity-dashboard.md` | Composite opportunity scoring |
| 13 | `13-scoring-engine.md` | Configurable 5-strategy trade scoring |
| 14 | `14-daily-brief-and-critic.md` | Daily AI intelligence brief + AI critic |
| 15 | `15-retrospect-paper-trading.md` | Auto paper-trade capture + retrospective analysis |
| 16 | `16-news-research.md` | Per-ticker AI research dossiers + impact ranking |
| 17 | `17-earnings-calendar.md` | Earnings dates, calendar/list views, risk annotations |
| 18 | `18-portfolio.md` | Positions, E*Trade sync, Greeks, advisor, trade-management alerts |
| 19 | `19-conviction-list.md` | "My Stocks" conviction list with price bands |
| 20 | `20-batch-jobs.md` | Batch scheduler + all daily jobs |
| 21 | `21-backtesting.md` | Strategy backtesting engine |
| 22 | `22-agent-and-api-server.md` | TraderAgent view + local Fastify API |
| 23 | `23-formulas.md` | Consolidated formula reference (self-contained) |
| 24 | `24-engineering-practices.md` | Versioning, changelog, logging, testing, packaging, NFRs |

---

## Domain glossary

| Term | Definition |
| --- | --- |
| **CSP** | Cash-Secured Put — sell a put while holding cash to buy 100 shares at the strike if assigned. |
| **CC** | Covered Call — sell a call against 100 owned shares. |
| **Wheel** | Sell CSPs until assigned, then sell CCs against the assigned stock until called away, repeat. |
| **DTE** | Days To Expiration (calendar days, not trading days). |
| **Delta / Theta / Vega / Gamma** | Option Greeks. Delta ≈ probability ITM / share-equivalence; Theta = daily time decay; Vega = sensitivity to 1% IV change; Gamma = rate of delta change. |
| **IV** | Implied Volatility. Stored/displayed as a **percentage** (38.82) except inside Black-Scholes where the decimal fraction (0.3882) is used as sigma. |
| **IV Rank** | Where today's IV sits in its 52-week range: `(iv − min) / (max − min) × 100`. |
| **IV Percentile** | % of trading days in the past year IV was below today's. |
| **OI** | Open Interest — outstanding contracts. |
| **OHLCV** | Open/High/Low/Close/Volume price bar. |
| **TTM / LTM** | Trailing / Last Twelve Months. |
| **ROE / D/E / FCF / ROIC** | Return on Equity / Debt-to-Equity / Free Cash Flow / Return on Invested Capital. |
| **ADX** | Average Directional Index — trend-strength oscillator. |
| **POC / VAH / VAL** | Volume Profile: Point of Control / Value Area High / Value Area Low. |
| **LEAPS** | Long-term Equity AnticiPation Security — option ≥ ~1 year DTE. |
| **PMCC / PMCP** | Poor Man's Covered Call / Put — diagonal using a LEAPS as stock proxy. |
| **Strict / Soft-match** | Screener modes: strict = pass all enabled filters; soft = rank by count of filters passed. |
| **Universe** | The scannable ticker set: `sp500`, `russell1000`, `both` (dedup union), or `etf`. |
| **Constituents** | The stored index membership lists that define the universe. |
| **Brief** | The Daily Intelligence Brief — scored daily trade picks per strategy. |
| **Critic** | The adversarial AI second-opinion layer applied to brief picks. |
| **Conviction list** | "My Stocks" — personal high-conviction names with custom price bands. |
| **bmo / amc** | Before Market Open / After Market Close (earnings report timing). |
