# 12 — Opportunity Dashboard

A single ranked table of "today's best setups" that collapses the screener → analysis → chain → payoff funnel into one screen. Service: `opportunity-service.ts`. IPC: `window.api.opportunity.run(opts)`. View: `OpportunityView.tsx` (🎯 Opportunity).

## 12.1 Purpose

Decision speed and discipline: go from "market opens" to "here are today's top trades" in one click, ranked by a composite **Opportunity Score (0–100)**.

## 12.2 Data sourcing (local only)

The service batch-queries four local tables — `iv_history`, `quote_cache`, `screen_results`, `analysis_snapshots` — and computes IV ranks for the entire universe with a single SQLite window-function query. No live API calls; it reads what the batch jobs already populated.

## 12.3 Composite score

```
Opportunity Score (0–100) =
    Fundamentals quality   × 25%     (from screener / OpportunityService.scoreFundamentals)
  + IV rank (strategy-adj) × 30%
  + Technical setup        × 25%     (from analysis engine)
  + Premium yield (ann.)   × 20%
```

The **strategy mode selector** (Wheel / CSP / Spreads / Bullish swing / Bearish swing) flips the IV-rank scoring direction: premium-selling modes reward high IV rank; buying modes reward low IV rank.

## 12.4 UI

A ranked table with score circles, mini score bars, and IV-rank badges (HIGH / MED / LOW). Secondary per-row flags: earnings within the DTE window (risk), sector concentration, days since the last screener run. One-click drill-in to full Analysis and the Options chain (and onward to Payoff). Auto-refreshes on app open; manual refresh button.

`OpportunityRunOptions` selects the universe and strategy mode. Output rows are `OpportunityRow`.
