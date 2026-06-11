# 14 — Daily Intelligence Brief & AI Critic

The Daily Intelligence Brief is the app's flagship output: a prioritized set of scored trade picks per strategy, each with a concrete structure, AI rationale, and an adversarial AI critique. Services: `daily-intelligence-brief-job.ts` (the pipeline, a batch job), `critic-service.ts`, `email-service.ts`, `brief-report-builder.ts`. IPC: read via `window.api.scoring.*`. View: `DailyBriefView.tsx` (📋 Daily Brief). Tables: `daily_briefs` (§2.14).

## 14.1 Pipeline (six stages + critic)

Runs as a batch job (§20), post-market, manual-trigger by default:

1. **Screen** — start from the full S&P 500 + Russell 1000 + ETF universe (read from `constituents`, not a pre-filtered screen, so weak names needed for bearish picks aren't excluded).
2. **Score** — run the Scoring Engine (§13) for all five strategies; rank candidates per strategy.
3. **Filter** — take the top candidates per strategy; apply a **hard liquidity gate**: drop any pick whose best relevant Strategy-Lab structure scores `liquidityScore < 5`. Short-premium strategies (**income, wheel, bearish**) additionally apply a **−20 composite earnings penalty** to any ticker with earnings in the next 45 days — high IVR driven by a known event is a trap, not an opportunity.
4. **Strategy Lab** — for each surviving pick, build the concrete structure (§09): legs, strikes, expiry, credit/debit, POP, grade.
5. **AI synthesis** — Claude (`claude-haiku-4-5`) writes a 2-sentence rationale per pick from the structured signals (instructed never to invent figures). For final picks, a live Polygon quote overrides any stale EOD price.
   - **5b. AI Critic** (see §14.3).
6. **Persist** — write one `daily_briefs` row per strategy (`picks` JSON), replacing any earlier same-ET-day run for that strategy (clean replacement, DST-safe ET date). `valid_until` = next trading day 9:30 ET.

After persist, **paper trades are auto-captured** for every post-gate pick (§15), and an **email + PDF** is sent.

## 14.2 Brief view

Per-strategy sections (order: wheel → bullish → bearish → income → buy), each a list of pick cards showing: rank badge, ticker, color-coded score badge, the primary structure (`$240 · Jul 17 · $3.25 cr`), human-readable signal chips, italic AI rationale, the relevant Strategy-Lab grade (and best-fit if different), stock price + CSP capital requirement, the Critic verdict badge (expandable), and quick-nav buttons (📈 Payoff / 🎯 Validate / 📉 Options). A history bar shows past briefs with an accuracy chip (§15). A **⚡ Conviction Alerts** section at the top surfaces conviction-list stocks in Buy/Mid zones (§19).

Exit plan per pick (in the PDF): target close at 50% credit, stop at 2× max loss, hold DTE.

## 14.3 AI Critic (Stage 5b)

`critic-service.ts` is an adversarial second opinion run after synthesis, before persist. For each pick it first runs **10 rule checks** — trend alignment, liquidity (chosen structure, score < 4), missing signals, score concentration, cross-strategy conflict, market regime (incl. bearish-vs-SPY-uptrend mirror), anomalous momentum, earnings-in-window, structure grade, and counter-trend ITM strike (bearish short strike at/below price on a bullish tape → warning) — then calls Claude (`claude-sonnet-4-6`) with an adversarial system prompt. All rule checks and the LLM context refer to the **same chosen structure** (first strategy-relevant score with a valid setup). Info-severity flags are advisory: the prompt instructs the LLM that a pick whose only flags are info can still merit `pass`. For **buy** picks where no relevant structure grades B or better (`shouldPresentAsStock`), the pick is presented as a plain stock purchase — the structure grade is excluded from the verdict and the view shows a `📈 Buy Shares` chip with the structure as optional. It returns a `CriticVerdict`: `pass | caution | flag` + rationale + `CriticFlag[]`.

The brief shows the verdict badge per pick and aggregate counts per strategy section; the email adds a Critic column + rationale sub-row. The same Critic is exposed to the external agent via the local API (`POST /critic/evaluate`, §22): the agent blocks entry on `flag`, warns on `caution`.

## 14.4 Email & PDF

After the job, `email-service.ts` sends an HTML email (trade-ready tables: ticker / grade / structure / strike / expiry / DTE / credit / ann. return / POP / max loss per strategy, plus the Lab Score and Critic columns) with a full PDF attachment (`brief-report-builder.ts`, pdfkit — all picks, AI rationale, signal breakdown, exit plan). Email uses the configured SMTP settings; email failure does not fail the job. `resendBriefEmail()` re-sends the latest.

## 14.5 Cross-pollination with the learning loop

- Pattern recommendations: when a gap cause recurs ≥3× for a strategy, a recommendation is written (§15) and surfaced.
- Signal-weight suggestions come from paper-trade outcome correlations (§13.5).
