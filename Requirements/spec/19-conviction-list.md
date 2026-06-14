# 19 — Conviction List ("My Stocks")

A personal, permanent reference of high-conviction names with custom price bands defining where the user is comfortable buying. Distinct from watchlists (which are many, neutral lists). Service: `conviction-service.ts`. IPC: `window.api.conviction.*`. View: `ConvictionView.tsx` (⭐ My Stocks). Tables: `conviction_stocks`, `conviction_band_history` (§2.16).

## 19.1 Model

A single list (not multi-list). Each stock has three price bands:
- **price_low** — comfortable entry ("I'd buy here").
- **price_mid** — experimental zone.
- **price_high** — never enter above this.

Plus a `note` and an **`in_play`** on/off flag (a transient "pay attention / may act on this" marker — e.g. flag it today to watch tomorrow). Every band/note change appends an audit row to `conviction_band_history`; toggling `in_play` does **not** (it's not a band change).

## 19.2 Zones & recommendation engine

The current quote maps a stock into a zone relative to its bands:
- **Buy zone** — price ≤ `price_low`.
- **Mid zone** — `price_low` < price ≤ `price_mid`.
- **Watch / Above** — price > `price_mid` (and a hard "never above" at `price_high`).

`recommend(ticker)` returns a system recommendation (`ConvictionRecommendation`) combining the zone with available signals. Each row shows a zone badge and band history.

## 19.3 UI & alerts

- The list shows each stock, its bands, current price, and zone badge, plus a 🚩 **in-play** toggle column (flagged rows are highlighted; the header shows an in-play count).
- **✉ Email My Stocks** sends the list via the configured SMTP (`ConvictionService.buildEmailReport()` → `EmailService`) as an HTML table including the in-play flag, sorted in-play first then by zone; the Actions column is omitted (UI-only). Button disabled (with tooltip) when email isn't configured.
- **Zone-entry toast** notifications fire when a stock crosses into the Buy zone (polled on mount + every 5 min; the first load is excluded so it doesn't toast everything at once).
- A green **count badge** on the "⭐ My Stocks" sidebar item shows how many stocks are currently in the Buy zone.
- The Daily Brief shows a **⚡ Conviction Alerts** section at the top for stocks in Buy/Mid zones (§14).

## 19.4 Sync & API

`syncDefaultWatchlist()` imports tickers from the Default watchlist into the conviction list (returns `{ added, skipped }`). IPC: `list`, `add(input)`, `update(ticker, input)`, `remove(ticker)`, `setInPlay(ticker, on)`, `history(ticker)`, `recommend(ticker)`, `syncDefaultWatchlist()`, `emailConfigured()`, `sendEmail()`.
