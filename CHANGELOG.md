# Changelog

## [1.1.92] — 2026-07-01

### Fixed
- **Evening batch chain no longer halts on a dormant E*Trade token (renew-and-retry on ANY probe failure).** The 17:00 orchestrator slot failed at Daily IV Update with `E*Trade connectivity check failed: terminated` on 8 of the last 10 trading days, forcing a manual re-run at ~18:30–22:00 ET (which also meant the brief measured option liquidity on extra-stale quotes). Root cause: a **dormant token (inactive >2h — idle since the ~10:40 morning run) doesn't reliably fail as a clean 401** — E*Trade kills/hangs the response stream (undici `terminated`), the connectivity check's auth-message heuristic (`401|token|auth|oauth`) didn't match, so `renewToken()` was **never attempted** and the job (and the whole orchestrator chain behind it) died — even though the token was renewable without any login all along (the manual evening re-runs succeeded because opening the app renewed it via `withRenew` paths). The check now **unconditionally renews and retries once on any probe failure** (renewing an active token errors harmlessly); only if the retry also fails does it classify: auth-shaped → "token expired, reconnect" CTA (true midnight expiry), else a real connectivity failure (message now says "after token renew + retry"). The orchestrator's pre-wake renewal (`_checkEtradeToken`) also logs failures instead of swallowing them silently. Manual re-auth is still required only for the true **midnight-ET hard expiry** — the away-at-work dormancy case is now fully automatic. Regression tests: `tests/daily-iv-capture-connectivity.test.ts` (3). `src/main/services/jobs/daily-iv-capture.ts`, `batch-orchestrator-job.ts`.

## [1.1.91] — 2026-07-01

### Added
- **Automated S&P 500 + Russell 1000 constituent refresh (new batch job `constituents-refresh`).** Index membership was a manual step (Wikipedia "Refresh" button / CSV import); it now refreshes automatically as the **first sub-job in the orchestrator chain** (sequence 2, before Market Sync — migration `063` shifted the other jobs +1) so every downstream job sees today's membership. Source: **Vanguard fund holdings** — VOO (S&P 500) and VONE (Russell 1000) via Vanguard's free public paginated JSON API (validated live: 503 / 1,002 rows) — with the existing **Wikipedia scrape as fallback**. Both sources run **gated**: row-count floor (480 / 940) and a ≤25% membership-turnover guard vs the stored list, so a truncated or corrupt feed can never wipe a known-good list (the annual Russell reconstitution is ~8-12% turnover; the gate never fires on a legit rebalance). Sector and company name are **preserved for carried-over tickers** (Vanguard carries no sector field). The manual "Refresh" button now uses the same gated Vanguard-first path (`screen:refresh-constituents`); CSV import stays as the manual override. `ConstituentsService.refreshFromVanguard/refreshIndexAuto/applyRefresh` (+`ConstituentsRefreshOutcome` diff), `src/main/services/jobs/constituents-refresh-job.ts`, `ConstituentsMeta.source` gains `'vanguard'`.
  - **New index members are backfilled automatically**: the job diffs membership and fetches **1 year of Polygon daily bars** for added tickers with no price history (a ticker moving between lists or already tracked keeps its bars — no duplicate fetch). Quotes/fundamentals follow minutes later via Market Sync in the same orchestrator run; technical signals compute the same evening. `iv_history` cannot be backfilled from Polygon — IV rank appears after 21 trading days of the daily IV capture (scoring already treats it as a missing signal until then), or run the manual IVolatility backfill for instant full history.
  - **A source outage never halts the nightly chain**: refresh failures return `status: 'success'` with a "kept existing list" warning note (`tickersFailed` counts them) because a slightly stale constituent list is strictly better than skipping the brief — the orchestrator stops the whole chain on a failed sub-job.
  - Regression tests: `tests/constituents-refresh.test.ts` (8 — pagination, diff, sector preservation, both gates, Wikipedia fallback, bootstrap-only-new, outage-is-success).

## [1.1.90] — 2026-06-30

### Added
- **Daily Brief surfaces a Level-2-tradeable (debit) vertical for bullish/bearish picks (display-only).** The brief's recommended/credit structures (bull-put, big lizard, iron condor) all require IBKR **options Level 3**. Both the Grouped card and the Ranked Grid now also show a `📈 L2-tradeable: Long Call Spread …` (bullish) / `Long Put Spread …` (bearish) chip — a **debit** vertical a **Level 2** account *can* place, so a small, defined-risk directional trade can be made (e.g. to build options history toward L3) instead of nothing. The vertical is narrowed at brief-generation time to a small max-risk budget (**$750** default): long leg ATM, short leg pulled in from the same live chain to the widest strike whose net debit stays within budget (`buildNarrowDebitVertical`, `src/main/services/level2-debit-vertical.ts`, `docs/formulas.md#level2-debit-vertical`), computed inside `StrategyLabService.validate()` and stored on `StrategyLabValidateResult.level2DebitAlts` (no extra E*Trade fetch, no brief-job stage). The chip shows debit / max-risk / **breakeven + move-to-profit — deliberately NOT a PoP**, because the lab's short-strike `popEstimate` is credit-spread semantics and would badly overstate a debit spread's true odds. A leg with no quote is priced via Black-Scholes from its chain IV; if even the narrowest spread exceeds the budget it's shown flagged (`exceededBudget`). Clicking opens the Payoff Visualizer pre-loaded with the legs. **Display-only / account-building context** — not the optimal structure at high IV (you're buying expensive premium), and it does NOT change what the brief recommends, the Conviction score, or what the engine trades (no FR-SEY-5 impact). Accessor `level2DebitAlternative` in `src/shared/brief-ranking.ts`. Regression tests: `tests/level2-debit-vertical.test.ts` (7), `tests/brief-ranking.test.ts` (+4, 18 total). **Needs one brief re-run to populate `level2DebitAlts` on stored picks** (older briefs degrade gracefully to no chip).

## [1.1.89] — 2026-06-29

### Added
- **Total G/L column on the Portfolio open-positions table.** The open-positions grid showed only **Day's G/L** (the single-session change); it now also shows **Total G/L** — the full-position unrealized gain/loss since entry, in dollars and percent (e.g. `+$1.2K (+8.40%)`). Sourced from the E*Trade sync (`totalGain` $, stored as `unrealizedPnl`, + `totalGainPct` %), falling back to the stored `unrealizedPnl` when no E*Trade row is present. Green/red coloured to match Day's G/L. Display-only — no scoring/trade-logic impact (not FR-SEY-5-gated). `src/renderer/src/views/PortfolioView.tsx`.

## [1.1.88] — 2026-06-27

### Added
- **Gap Risk metric on the Validate dashboard (display-only).** Each single-ticker validation now shows a **Gap Risk** indicator: the stock's trailing ~252-day **95th-percentile downside overnight gap** divided by its **IV-implied 1-day move** (`atmIv/√252`). A score **> 1** means the name historically gaps *down* harder than its implied volatility prices — i.e. you're under-compensated by option premium for its jump risk (relevant to owning the stock or selling cash-secured puts); **< 1** means realized gaps sit within what IV implies. Badged High/Mid/Low with the underlying figures (`gap X% vs IV Y%/day`). Pure metric in `src/shared/gap-risk.ts` (`computeGapRisk`, `docs/formulas.md#gap-risk`), wired through `ValidateDashboardResult.gapRisk`. Regression tests: `tests/gap-risk.test.ts` (6).
  - **Context metric, not a trade gate.** A Brief-Replay study (`scripts/fr-gap-risk-study.mjs`, `scripts/fr-gap-risk-csp.mjs`; recorded in `Requirements/NEW_FRONTIER.md §9` as draft FR-SEY-6) found the score is **not** a shippable entry filter on the current ~13-month IV panel: it *inverts* on defined-risk spreads (whose long wing already caps gap loss) and is only a mild, tail-blind win-quality nudge on naked short puts. It is surfaced for the trader to eyeball, never enforced — no FR-SEY-5 gate.

## [1.1.87] — 2026-06-27

### Added
- **Daily Brief surfaces a defined-risk alternative for bullish picks (display-only).** Bullish picks almost always recommend a **Big Lizard** (a coin-flip ATM range trade with a large tail), while the lab also scores a defined-risk **bull put spread** (`short-put-vertical`) that the bullish bucket can't recommend (it's filed under `inflection`). Both the **Grouped** card (expanded detail) and the **Ranked Grid** (under the Best Structure cell) now show a `⚖ Defined-risk alt: Bull Put Spread A+ · $strike · expiry · credit · PoP%` chip when the spread is constructible and carries a strictly smaller max loss than the recommended structure. Clicking it opens the Payoff Visualizer pre-loaded with the spread's legs. This is **purely informational** — it does NOT change which structure the brief recommends or the engine trades, so it's not FR-SEY-5-gated (the engine-side rubric change remains disabled behind `USE_POP_WEIGHTED_PREMIUM` pending the July backtest). Computed client-side from the already-stored lab scores (no job re-run). Bullish-scoped to match the validated finding. New `definedRiskAlternative()` in `src/shared/brief-ranking.ts`; regression tests in `tests/brief-ranking.test.ts` (+5, 14 total).

## [1.1.86] — 2026-06-27

### Added
- **Experimental PoP-weighted premium scoring (disabled) + lizard-vs-spread backtest harness.** Investigation into why the bullish brief recommends a Big Lizard over a bull put spread found the lab's `premiumScore` **saturates** (any short-premium structure returning ≥1.5%/30d on capital pegs the 25-pt cap) and ignores probability-of-profit. A static risk-geometry study of 102 historical bullish picks (using the lab's own stored `maxLoss`/`popEstimate`) showed the bull put spread is risk-adjusted *superior* — higher return-on-risk in 86% of picks, higher PoP in **100%** (70.6% vs the lizard's coin-flip 52.7%), for ~15× less capital — yet the lab grades the lizard ~1.8 pts **higher**. New `USE_POP_WEIGHTED_PREMIUM` flag (**default false**) re-grades the short-premium `premiumScore` as `25 × clamp(ret30d/3,0,1) × clamp((PoP−40)/35,0.3,1)` (`popWeightedPremiumScore`, `docs/formulas.md#pop-weighted-premium`), which on the sample flips selection toward the spread. **Shipped disabled pending an FR-SEY-5 realized-P&L backtest** — the 2026-06 bullish sample doesn't settle until Jul 2–24 2026 (none had expired). Harness `scripts/backtest-lizard-vs-spread.mjs` settles each structure at hold-to-expiry **intrinsic** (no IV assumptions; `src/shared/structure-settle.ts`) from the stored legs + price paths — re-run after Jul 24 to get the delta and decide whether to enable. Finding recorded in `Requirements/v2-execution/06-seykota-risk-extensions.md`. Regression tests: `tests/structure-settle.test.ts` (5), `tests/lab-pop-premium.test.ts` (5). Selection/grading is unchanged with the flag off.

## [1.1.85] — 2026-06-26

### Added
- **Daily Intelligence Brief — Ranked Grid tab + critic pass-filter.** The brief now has two tabs: **Grouped** (the existing expand-by-strategy accordion) and **Ranked Grid** — one flat, sortable row per pick across every strategy. Columns: Ticker · Price · **Conviction** · Strategy · Composite · Best Structure (→ Payoff) · Expiry · Strike · Premium · Rating · Flag · RSI · Actions (Payoff/Validate/Options/Analysis/E*Trade icons). All columns sortable; default sort is **Conviction** descending.
  - **Conviction** is the one ranking that *is* comparable across strategies. Raw composite scores are strategy-specific (different signals/weights) and can't be ranked head-to-head, so Conviction = the **Strategy-Lab structure score** (0–100, shared IV+direction+premium+liquidity rubric) **minus a critic penalty** (caution −15, flag −35, not-vetted −25). It is a quality/triage ordering, **not** a backtested profit forecast — labelled as such in the header tooltip. Composite remains as a (non-comparable) column for reference.
  - A **Critic** segmented filter (All / Pass + Caution / Pass only) is honoured by **both** tabs; pass filters exclude not-vetted picks (no verdict / degraded critic). Tab + filter selections persist to `localStorage`.
  - RSI is shown where available (buy/bullish/bearish picks); wheel/income/inflection render `—`. Ranking + filter logic extracted to `src/shared/brief-ranking.ts`; regression test `tests/brief-ranking.test.ts` (9). Not FR-SEY-5 (display/surfacing only — changes no trade logic).

## [1.1.84] — 2026-06-25

### Changed
- **Paper-tracking now scores brief picks on real structure P&L, not stock direction.** The Retrospect paper-tracking layer (which auto-records every brief pick and snapshots it daily) measured `stock_return_pct` and decided win/loss by a crude proxy (income = within ±8%, others = stock up/down) — which mis-scores the premium-sellers (a wheel CSP "lost" if the stock dipped 1% even when the put expired worthless). It now **Black-Scholes-marks the actual structure from its legs** (`structure-mark.ts`, reusing `black-scholes.ts`) at each daily snapshot and at close, honoring per-leg expiry; the closed-trade **`outcome` now derives from the real structure P&L** (falling back to the stock proxy only when legs can't be priced). New `structure_pnl` / `structure_return_pct` on `paper_trade_snapshots` and `structure_pnl` on `paper_trades` (migration 062); Retrospect History table gains a **Struct P&L** column. `stock_return_pct` is retained for reference. Not FR-SEY-5 (measurement only — changes no trade logic). Regression test `tests/structure-mark.test.ts` (7).

### Notes
- A one-time backfill (`scripts/backfill-structure-pnl.mjs`) re-scores the existing 2,608 snapshots + closed trades; run it once with the app closed **after** launching the new build (so migration 062 has added the columns). Marking holds IV at entry-IV (no historical per-strike IV), so it isolates the underlying move + theta — accurate for direction/theta, approximate across a vol crush. Full suite **756 passing**.

## [1.1.83] — 2026-06-25

### Fixed
- **Validator no longer suggests your own trade back as a "better" structure.** When the Strategy Lab's best pick is effectively the structure you're already evaluating (same legs — e.g. a held NVDA 185 CSP whose lab-best is also a 185 short put), the suggestion now shows **"LAB: NO BETTER ALTERNATIVE"** with a note ("the lab has no higher-graded structure than the one you're evaluating — shown for context") instead of the misleading "LAB SUGGESTS INSTEAD." The useful signal in that case — the grade and the IV-regime note ("consider waiting for higher IV / just own it") — is preserved. New `PretradeSuggestion.sameAsCurrent` flag computed by `suggestionMatchesInput` (leg-set comparison, order-independent). Regression test `tests/pretrade-suggestion-match.test.ts` (5).

## [1.1.82] — 2026-06-25

### Fixed
- **Pre-Trade Validator "Lab suggests instead" no longer recommends a pin-bet butterfly.** For an *ownership* (wheel) intent it was surfacing a grade-A **Put Butterfly** — a neutral structure that pays only if the underlying pins a narrow window at expiry and never acquires shares — because the filter matched any slug containing "put". The suggestion picker now uses explicit per-intent slug allowlists (ownership → `short-naked-put` / `short-put-vertical`; income → the validated short-premium structures; directional → bull/bear categories; hedge → long puts) and **globally excludes pin-bet butterflies** (incl. broken-wing/heart variants) from every suggestion. Regression tests added (`tests/pretrade-checks.test.ts`, 24).

## [1.1.81] — 2026-06-25

### Fixed
- **Root cause of the unstable position-greek signs: two write paths with opposite conventions.** The E\*Trade portfolio sync stored greeks **raw** (verbatim from E\*Trade — a short put's δ negative), while the "refresh greeks from chain" action stored them **position-signed** (negating shorts → +δ/+θ/−ν). Whichever ran last set the sign, so the *same* position flipped convention between a sync and a refresh — which is what made a CSP read as "bearish" in the validator (v1.1.80 patched the symptom downstream; this fixes the source). Both paths now go through one shared helper, `shared/position-greeks.ts` `toPositionSignedGreeks`, so the stored convention is deterministically **position-signed** and the two paths can't drift again. The Portfolio net-greek aggregation and the planned Book Greeks monitor already expect this convention. Regression test `tests/position-greeks.test.ts` (6). (Rows last written by the sync before this version may still be raw until the next portfolio sync re-writes them; the defensive normalization in `position-payoff.ts` keeps the Payoff/validator correct in the meantime.)

## [1.1.80] — 2026-06-25

### Fixed
- **A reconstructed position no longer reads with inverted greeks (a CSP showed as "bearish").** When opening a held position in Payoff (v1.1.79), the Pre-Trade Validator's direction check labeled a cash-secured put — a *bullish* structure — as "bearish, aligns with the bearish trend." Root cause: the portfolio sync's greek **sign convention is unstable** (the same short put was stored *raw* on one sync and *position-signed* on another), so the position's `+`delta got the sell-side flip applied a second time → net delta inverted. Fix: `positionToPayoffLegs` now **normalizes greeks to canonical raw by leg type** (`rawGreeks`: put δ<0 / call δ>0; long-option θ<0, ν>0) before the Payoff engine applies the side sign — correct whichever way the source stored them. Now a CSP correctly reads bullish (→ "against the trend, by intent" when you're a happy owner in a downtrend), and net θ/ν display correctly. Also corrects the (now-wrong) "greeks are always raw" comment in `portfolio-service.ts`. Regression tests added (`tests/position-payoff.test.ts`, 8).

### Known issue (flagged, not yet fixed)
- The **E*Trade greek sign convention is inconsistent across syncs** — the underlying data-integrity cause is still open. All current consumers normalize defensively by type, but the sync itself should be made deterministic (and the planned Book Greeks monitor must normalize, not trust the stored sign).

## [1.1.79] — 2026-06-25

### Fixed
- **Portfolio → Payoff (📐) now shows your *actual* position, not a generic rebuild.** The button used to route through the chain-rebuild path, which snapped the expiry to the nearest of only the **7 weekly Fridays** loaded (so a 57-DTE position like a NOW 80 put expiring 08-21 landed on 08-07), snapped to the nearest weekly strike (80 → 82), and re-priced at the current market mid (your $4.32 entry credit showed as $3.77) — i.e. a brand-new near-term CSP that merely *approximated* your holding. It now reconstructs the position exactly: same strike, same expiry, your entry premium, contract quantity, and stored greeks. New pure helper `src/shared/position-payoff.ts` (`positionToPayoffLegs`) with `tests/position-payoff.test.ts` (6); falls back to the old behavior only if a position lacks the strike/expiry to rebuild.

## [1.1.78] — 2026-06-25

### Changed
- **Pre-Trade Validator: the IV-regime "selling cheap volatility" check is now intent-gated** (first threshold tuning, from validating the live wheel book). When premium isn't your edge — **ownership** purpose or **happy-to-own = yes** — selling into low IV rank is reported as **info** (context), not a warning; for **income / directional** it stays a **warning** (there premium *is* the edge). This matches how the direction and earnings checks already gate on intent, so the verdict reflects *is this good for what you're trying to do*. Net effect on a happy-to-own wheel book: names selling cheap vol (e.g. NVDA IVR 24, TSLA IVR 28) no longer get pushed to caution on the IV check alone — only genuine issues (thin cushion, etc.) do. Regression test added (`tests/pretrade-checks.test.ts`, 22).

## [1.1.77] — 2026-06-25

### Added
- **"Open in Lab →" from the Pre-Trade Validator suggestion.** When the validator flags your trade and the Strategy Lab suggests a better structure, a button next to **LAB SUGGESTS INSTEAD** jumps straight to the Strategy Lab's **Explore** tab, pre-populated with that ticker + structure and **auto-built** (the concrete setup loads without a manual click). Reuses the existing `navigate-to-strategyLab` deep-link (now carries an optional `slug`); `StrategyLabView`/`ExploreTab` accept the slug, land on Explore, and fire a single auto-explore on arrival.

## [1.1.76] — 2026-06-25

### Added
- **Pre-Trade Validator on the Payoff view** — build a structure, declare your **intent** (purpose · happy-to-own? · multi-quarter thesis), and click **Validate Trade** to get a **good / caution / bad** verdict with concrete, deterministic checks: reward-vs-risk (only for defined-risk spreads — a CSP's structural max-loss no longer false-flags it), undefined-risk, **IV-regime fit** (warns when you're selling cheap vol / buying expensive vol), direction-vs-trend (intent-gated — a deliberate ownership fade is info, not a warning), **earnings-before-expiry** (warning, or info if you're happy to own), **cushion-vs-ATR** (flags a thin short-strike on a high-volatility name), horizon match, and effective ownership basis. When a trade is flagged, the **Strategy Lab suggests a better structure** for the same name (intent + IV-regime filtered — and it may say "don't sell premium here"). Each validation is **persisted** (`pretrade_validations`, migration 061). Verdict is **intent-aware** because the same trade can be a bad income trade but a fine ownership trade. Decision-support only — it does not place orders and is not wired to the execution engine. New `pretrade-validator-service.ts` + pure, unit-tested `pretrade-checks.ts` (21 tests); `window.api.pretradeValidator.*`. Thresholds are first-pass and tunable. See `Requirements/PRE_TRADE_VALIDATOR_SPEC.md` + `spec/08`.

### Notes
- ~80% reuse: payoff metrics (renderer), the Strategy Lab (`validate` → IV rank / direction / candidate structures, cached 10 min with a Refresh action), `earnings_calendar` (nearest-date fix v1.1.75), and `technical_signals.atr_pct`. Full suite **728 passing**.

## [1.1.75] — 2026-06-24

### Fixed
- **Earnings calendar dropped the *next* earnings date for actively-reporting names — a real-money risk for the premium-selling book.** The Earnings Refresh job fetches Finnhub in two windows (today→+90d, then +90d→+180d) and the upsert overwrites unconditionally, so any quarterly reporter present in **both** windows had its **near** date (window 1) overwritten by the **following** quarter (window 2). Confirmed live: NVDA stored 2026-11-17 when Finnhub also returned 2026-08-25; same for MRVL/AMAT/ADI (all stored Nov, dropped the real Aug report). Because `earnings_calendar` holds one row per ticker, all three consumers read the wrong date: the v2 **entry gate** (`brief-entry-source` earnings-before-expiry), the **critic** earnings flag, and the brief's **Stage-3 −20 earnings penalty** — so the engine could sell a credit spread / iron condor straight **through** an earnings report believing the window was clear. Fix: Phase 1 now keeps the **nearest** future date (skips a candidate on/after an already-stored future date), matching the per-ticker Phase-2 path. Poisoned data self-heals on the next Earnings Refresh run (runs on startup + after-close). Regression test `tests/earnings-refresh-job.test.ts`.

### Notes
- Found during the iterative Daily Brief accuracy deep-dive (round 9). The rest of the latest brief verified clean: credit/maxLoss/breakeven/annualized all tie out to an independent recompute (conservative slippage-modeled fill at the mid↔adverse-side midpoint), prices fresh + internally consistent, no earnings actually inside today's July expiries (the bug was latent today, not biting). Full suite **707 passing**.

## [1.1.74] — 2026-06-24

### Added
- **Auto-backup location is now configurable.** Settings → Backup → Automatic Backup has a **Backup folder** picker ("Choose…" / "Reset to default"). When set, auto-backups are written into a `TradeAnalyzer-AutoBackups` subfolder of your chosen folder (e.g. a cloud-synced or external drive); otherwise the default app-data location is used. Backups always go into that dedicated subfolder so the newest-5 prune only ever touches its own files, never anything else in the folder you picked. New `autoBackupDir` setting + `settings:pick-directory` IPC.

## [1.1.73] — 2026-06-24

### Fixed / Changed
- **Backup now produces a real `.zip` at the location you choose.** Previously the "Save as .zip" dialog was misleading — it ignored your chosen path and instead dumped an *un-zipped* folder into AppData, telling you to copy it manually. Backup now writes a single zip to the path you pick, containing a **consistent** database snapshot (via SQLite's online backup — WAL-safe, so in-flight data is included, unlike the old live-file copy), plus recent logs, AI_CONTEXT (in dev), and a manifest.
- **Restore now accepts a backup `.zip`** (the database is extracted from it) as well as a bare `.sqlite`/`.db` file. It overwrites the live DB and prompts you to restart.
- **Auto-backup now actually works.** The setting existed but nothing ran it. On launch, if enabled and the chosen interval has elapsed since the last one, the app writes a backup zip to `userData/backups/auto/` (newest 5 retained). The control was also **moved from General to the Backup tab** (where you'd expect it) and gained an **interval (days)** field.

### Notes
- New `src/main/services/backup-service.ts` (shared by the IPC handlers + startup auto-backup); new `adm-zip` dependency. 12 new tests (`tests/backup-service.test.ts`). Full suite **704 passing**.

## [1.1.72] — 2026-06-24

### Added
- **Retrospect header now shows a "Take Profit" signal count** alongside the existing Close Signal badge. A green `✓ N Take Profits` chip appears whenever open paper trades have a take-profit recommendation (counts `insight.action === 'take_profit'`, matching the In Progress grid's Action column). Shows only when N > 0.

## [1.1.71] — 2026-06-24

### Fixed
- **Retrospect → In Progress: the Brief dropdown now stays pinned to the top while you scroll the picks grid.** It used to scroll away with the table, so switching to a different brief meant scrolling all the way back up. The selector bar is now `position: sticky` at the top of the scroll area (full-width with a divider; rows scroll underneath it). CSS-only.

## [1.1.70] — 2026-06-24

### Added
- **Settings-driven, per-mode broker selection** (07-broker-alternatives §3). `exec_config` now carries `paper_broker` / `live_broker` (`mock | ibkr | tradier`), editable as dropdowns in **Execution Settings → Mode**. The active venue is chosen by mode (paper→paper_broker, live→live_broker), with `TA_EXEC_BROKER` env still overriding for dev/tests. Default `mock` preserves the existing opt-in behaviour. Changing the **live** broker requires a confirm gate; the fail-closed spread-permission preflight and live confirm gate are broker-agnostic, so any venue inherits them.
- **Tradier execution adapter (`TradierExecutionBroker`) — skeleton.** Chosen as the path off IBKR (which approved only Options **Level 2** on the live account — no spreads — with a 30-day cooldown, and never had paper spread permission). Tradier is the only venue with a *real* sandbox **and** production on one REST API with native multi-leg orders. Ships fully **unit-tested pure mapping helpers** (OCC/OSI symbols, multileg payload, net credit/debit sign convention, status mapping, combo pricing, preview classification) plus a **fail-closed network shell** implemented to Tradier's documented REST shapes — Bearer auth, sandbox/production by mode, polling-based status/fills, COID idempotency via the order `tag`. Network endpoints are marked `// VERIFY` pending live-sandbox calibration (account + L3 approval + tokens still required). IBKR remains fully supported behind the seam.

### Notes
- Validation-exempt per FR-SEY-5 — broker selection changes neither which trades are selected nor how they're sized/exited. New `tests/tradier-execution-broker.test.ts` + extended factory/schema tests. Full suite **692 passing**.

## [1.1.69] — 2026-06-23

### Fixed
- **Spread-permission preflight timed out instead of returning a verdict — would have blocked arming even *with* permission.** The first live run of the preflight (paper, validating Level 3) showed `check_failed: IBKR request … timed out after 12000ms`. Cause: `discoverProbeSpread` asked TWS for the reference underlying's option contract details with **no expiry/strike filter**, so IBKR tried to return the *entire* SPY put chain (tens of thousands of contracts) and blew past the 12s timeout. The probe now constrains the request to **one near monthly expiry** (`nextMonthlyExpiry` — the next 3rd-Friday ≥10 days out, computed all-UTC), so it returns a few hundred contracts and resolves fast, then picks two strikes as before. (Latent until now: paper skipped the preflight pre-v1.1.66, and live was never reached.)
- **`scripts/ibkr-level3-spread-test.mjs` gave a false "✅ CONFIRMED" after hours.** A market-closed order queues as `PreSubmitted`, but IBKR can still reject it on permission grounds a moment later (→ `Inactive` + error). The script declared victory on the first `PreSubmitted`, then also printed the real "⛔ NOT permitted." It now treats a queued status as **tentative** — confirming only if it survives ~6s with no rejection, and reporting denial on `Inactive`/`Cancelled` or a permission error.

### Notes
- Infrastructure/diagnostic fix to the permission probe — no trade-logic change. Validation-exempt per FR-SEY-5. 4 new tests for `nextMonthlyExpiry` (3rd-Friday math + month roll). Full suite **669 passing**. (Tonight's validation verdict stands: the IBKR paper account is **still not** spread-permitted — an explicit IBKR rejection — so this fix is what makes the engine's own Start give a clean "permitted / not permitted" once the account is upgraded.)

## [1.1.68] — 2026-06-23

### Fixed
- **The critic now cautions on liquidity in step with what the engine will actually trade — a "clean Pass" can no longer hide an untradeable spread.** A brief deep-dive found the critic flagged `low_liquidity` only below score 4, while the v2 entry gate rejects anything below 8 (or with a $0-bid leg). So a defined-risk spread scoring 4–7 got a green "✓ Pass" from the critic yet would be **rejected** by the engine — e.g. today's inflection #1 AEP (liq 6, grade A, "clean pass") sat in that gap, and BALL's long leg had a $0 bid (can't be exited). A human trading the brief's verdict could enter spreads the engine itself refuses.
  - The two thresholds are now one shared constant (`MIN_TRADABLE_LIQUIDITY_SCORE = 8` in `strategy-structures.ts`), used by both the engine gate and the critic, so they can't drift.
  - For **defined-risk multi-leg spreads** (what the engine trades), the critic raises a **warning** when the chosen structure is below the tradability bar, or has a no-bid leg — so the verdict reflects real tradability. Single-name short-premium (where 4–7 liquidity is normal) is unchanged.

### Notes
- Decision-support / display change — the engine's liquidity gate (8) is **unchanged**; this aligns the *critic's* caution to it. Strictly more conservative (the critic can only add caution). Validation-exempt per FR-SEY-5. 4 new critic regression tests. Full suite **665 passing**. Surfaced by the real-money readiness audit of the after-close brief.

## [1.1.67] — 2026-06-23

### Fixed
- **A degraded (LLM-failed) critic no longer reads as an all-clear, and the engine won't trade on it.** When the Anthropic API is overloaded (today's 10:28 brief hit a `529 overloaded_error`), the critic falls back to the rule-based verdict only — which is `pass` when no rule flag fires. Every pick then showed `✓ Pass / low confidence / no rationale`, looking like 21 clean adversarial passes when in fact the LLM critic never ran. Worse, the v2 entry gate accepted that fallback `pass` (it ignored `confidence`/`rationale`), so the engine would have entered trades from an **un-vetted** brief — fail-*open* on AI failure.
  - `CriticVerdict.degraded` now marks a fallback verdict; `EntryPolicy` rejects degraded picks with `critic_degraded` (**fail-closed** — never trade an un-vetted pick).
  - The Daily Brief UI shows **"⚠ Critic unavailable / not vetted"** (neutral, not a green Pass) instead of `✓ Pass` for degraded verdicts, with an explanation on expand.

### Changed
- **Critic AI calls retry harder on transient overload.** The critic's Anthropic client now uses `maxRetries: 4` (above the SDK default of 2) so a brief 429/500/`529` overload rides out on exponential backoff instead of blanking the whole critic layer.

### Notes
- Surfaced by a deep-dive on today's 10:15 brief (user saw "too many pass"). Root cause was the API 529, not lenient scoring. The fail-closed guard is strictly more conservative (it can only *remove* un-vetted trades, never add or re-rank). Validation-exempt per FR-SEY-5. 3 new regression tests (gate rejects `critic_degraded`; brief→PickInput maps `degraded`; clean stays un-degraded). Full suite **661 passing**. (Separately noted from the same audit: the 10:15 lean run can't be trusted for **inflection** — partial-bar `volumeSurge` collapses the composite — and skips the earnings-refresh; trust the after-close run for those.)

## [1.1.66] — 2026-06-23

### Changed
- **The spread-permission preflight now runs in PAPER mode too (not just live).** Root cause of the day's "armed but nothing trades": the IBKR **paper** account (`DUQ795672`) lacks options **spread** (multi-leg) trading permission, so IBKR rejected/cancelled every 2-leg combo the engine sent. `startEngine()` previously ran the fail-closed permission probe in **live mode only** — paper was skipped on the (false) assumption it always has full permissions — so the engine armed and silently spammed rejected orders. Now paper runs the same preflight: `startEngine()` connects, probes `checkSpreadPermission()` (the IBKR adapter uses a non-transmitted whatIf combo), and **refuses to start** with reason `spread_permission:<code>` if the account can't place a spread. The Trading Desk already surfaces this as `Engine refused to start: spread_permission:no_spread_permission`, turning a multi-hour silent failure into a one-line message.

### Notes
- Fail-closed safety change — strictly more conservative (won't arm an account that can't trade the engine's defined-risk spreads); no change to selection/sizing/exits. Validation-exempt per FR-SEY-5. The mock broker grants permission, so tests/dev are unaffected. Updated the existing preflight tests (paper now probes) + added a paper-denied regression test. Full suite **659 passing**. **Operator action required:** enable options spread permission on the IBKR account (Client Portal → Trading Permissions → Options; paper mirrors live) before the engine can trade.

## [1.1.65] — 2026-06-23

### Fixed
- **TWS order-rejection reasons were silently dropped — orders ended `cancelled` with no reason.** With the eTradeOnly/firmQuoteOnly fix (v1.1.62), the engine's combo orders now reach TWS — but TWS was rejecting/cancelling them, and the reason was lost: IBKR reports an order's reject reason on the **error channel** (keyed by order id), which `IbkrExecutionBroker` only handled for *data* requests, and `onIbkrOrderStatus` set `rejectReason` only for a literal `'rejected'` status (not `'cancelled'`/`'inactive'`). So every rejected order showed `status='cancelled', reject_reason=NULL` and the operator had no idea why. The broker now matches an order-id error to its tracked order, logs it (`[ibkr] order N … error`), and surfaces it as a status update carrying the reason; `OrderManager.handleStatus` persists it into `exec_orders.reject_reason` via `COALESCE` (robust to error/status event ordering).

### Notes
- Diagnostic/observability fix — no change to order construction or trade logic. Validation-exempt per FR-SEY-5. New regression test asserts a broker reject reason lands on the order row. Full suite **658 passing**. **This unblocks diagnosing why TWS rejects the paper combos** — the next rejected order will record the IBKR reason in `exec_orders.reject_reason` (and the app log).

## [1.1.64] — 2026-06-23

### Fixed
- **Dropped/never-acked orders permanently consumed the daily entry cap, so the engine stopped entering.** An order the broker silently drops (the eTradeOnly/firmQuoteOnly TWS bug, v1.1.62) sits `submitted` forever, and its `approved` proposal kept counting against `max_new_entries_per_day`/`_per_week` indefinitely. After the two dropped AVGO orders this morning, `dayUsed` was stuck at 2/2 and every subsequent cycle silently rejected all picks with `daily_cap`. New `OrderManager.reconcileStaleOrders()` runs at the start of each market cycle: any order stuck `pending`/`submitted` past 90s with no broker ack is cancelled (best-effort broker cancel + `stale_no_ack`), and its proposal is `expired` (OPEN) — freeing the cap — or its position un-stuck to `open` for a retry (CLOSE). This also **auto-clears today's two phantom AVGO entries** on the first cycle after restart.
- **No per-ticker entry dedup — the same name could be entered repeatedly.** AVGO was proposed twice today because the first order never filled (no position to dedup against), and the daily cap was the *only* thing limiting the stacking. `EntryPolicy.generateEntries` now skips any pick whose ticker already has a non-closed position or a `pending`/`approved` entry proposal (and dedups repeats within a batch), rejecting with `duplicate_ticker`.
- **A filled entry was counted twice against the cap.** On fill, the position was opened but its proposal stayed `approved`, so `countNewEntries` (which counts approved proposals **and** open positions) counted one entry twice — a single fill could consume the whole `cap=2`. The proposal is now retired to `superseded` when its position opens, so each entry counts exactly once throughout its life.

### Notes
- Correctness/safety fixes to engine plumbing (cap accounting, stuck-order cleanup, concentration dedup) — no change to scoring weights, signals, or entry/exit thresholds; the dedup is strictly more conservative (won't stack a name). Validation-exempt per FR-SEY-5. 6 new regression tests across `tests/order-manager.test.ts` + `tests/entry-policy.test.ts`. Full suite **657 passing**. **Relaunch + Start: the stale-order sweep clears today's stuck cap automatically.**

## [1.1.63] — 2026-06-23

### Fixed
- **Engine showed "running + armed" after a restart but was inert — no broker connection, no cycle loop, no trades.** `engine_state` is persisted in `exec_risk_state`, but the broker connection and the cycle loop are process-local and were never restored on restart, and nothing at boot re-ran `startEngine()`. So after a relaunch (crash, reboot, repackage-and-relaunch) the Trading Desk/`/exec/state` reported `engineState:"running"`, `armed:true` while `brokerConnected:false` and `lastCycleAt:null` — the engine took no trades, silently. Surfaced when an IBKR-paper relaunch sat "armed" with no socket to TWS.
- **Boot reconciliation (operator choice: force-stopped-on-boot).** On boot, any persisted `running`/`paused` engine state is now reset to `stopped` (`RiskGovernor.forceStopOnBoot()` → audited distinctly as `boot_reset`), so the UI tells the truth and the operator must explicitly **Start** — which reconnects the broker and restarts the loop — after every restart. A tripped kill switch is left tripped (manual-clear only).

### Notes
- Engine **lifecycle** change, not trade logic — no change to selection/sizing/exits; strictly more conservative (won't trade after a restart until an explicit Start). Validation-exempt per FR-SEY-5. New regression tests cover `forceStopOnBoot` (running→stopped, paused→stopped, no-op when stopped, kill-tripped left tripped). Full suite **651 passing**.

## [1.1.62] — 2026-06-23

### Fixed
- **IBKR combo orders silently dropped by TWS — nothing reached the paper account.** The armed unattended engine logged `proposal → gate_pass → approved → order_submitted` for live AVGO wheel entries, but no fills came back and nothing appeared at the broker. Cause: the production `IbkrExecutionBroker` order object omitted the legacy compliance flags **`eTradeOnly: false`** and **`firmQuoteOnly: false`**. Newer TWS **silently drops** combo orders that lack them — no `orderStatus`, no `error`, no fill — while the `placeOrder()` API call returns cleanly, so the engine recorded "submitted" and waited forever. The three validated diagnostic scripts (`scripts/ibkr-*.mjs`) already set both flags; the engine's own placement path never did. Both the live order and the whatIf permission-preflight order now go through a single shared `buildComboOrder()` that always sets the flags.

### Notes
- Bug fix to order **delivery**, not trade logic — no change to which trades are selected, how they're sized, or how they exit. Validation-exempt per FR-SEY-5. New regression test asserts `eTradeOnly`/`firmQuoteOnly` are `false` on both live and whatIf combo orders (`tests/ibkr-execution-broker.test.ts`, 29 tests). **Re-arm and re-run on paper to confirm fills now land at IBKR.**

## [1.1.61] — 2026-06-23

### Added
- **Execution control API wired into boot.** `ExecutionControlApi` (Fastify on `127.0.0.1:7433`, token-authed via `~/.tradeanalyzer/agent.token`) was built in Phase 3b but never started; it now launches at app boot and stops on `will-quit`. This lets an external operator/agent read live engine state and drive control (start/pause/stop, kill switch) **while the app window is closed** — and, concretely, lets you confirm whether the three switches for an unattended day are set without eyeballing UI pills.
- **`/exec/state` now surfaces `broker` (mock vs ibkr), `automationMode`, and `armed`.** When wired with the engine facade's `getState()`, the endpoint returns the full state view (engine-state, kill switch, executionMode, **automationMode**, **armed**, drawdownPct, health) plus the **broker kind** — the exact fields needed to verify "is it really on IBKR, running, and armed?". `GET http://127.0.0.1:7433/exec/state` with header `X-Agent-Token: <token>`.

### Notes
- Back-compatible: the endpoint still works from core+governor alone (broker defaults to `mock`). No engine/trade-logic change — validation-exempt per FR-SEY-5. New regression test (`tests/control-api.test.ts`) covers the broker/automationMode/armed pass-through. Full suite: **644 passing**.

## [1.1.60] — 2026-06-23

### Added
- **Trading Desk redesign (spec 08 §5, Part D — the last piece of the unattended-operation feature).** The desk is now **tabbed** so each grid stays large enough for many rows, with a proper stylesheet, **aligned column headers**, and **click-to-sort** on every grid (via the shared `useSortable` hook). The always-visible header (PAPER/LIVE + engine pill, arm switch with the paper-only guard, Start/Pause/Stop, kill switch, capital gauge + day P&L + health) sits above the tabs unchanged.
- **Seven tabs:** **Live** (default landing) · **Proposals** · **Entries** · **Exits** · **Rejects** · **Positions** · **Activity**. Each tab badges its row count; **Proposals** badges/highlights (⚠) only when something needs approval and **auto-focuses** the moment a new pending proposal appears.
- **Live tab = the day's story.** A horizontal **daily activity timeline** (9:30 open / 4:00 close markers, shaded entry window, pinned events — brief committed, entries, exits, kill trip/clear) above a friendly **live activity feed** (today's audit events rendered as readable one-liners with colored dots).
- **Entries / Exits / Rejects** are derived per-day (ET): Entries = positions opened today **+ dry-run "not placed" rows**; Exits = positions closed today **+ dry-run exits**, tagged **protective vs discretionary**; Rejects = today's gate/proposal/order rejections with the gate reason.

### Notes
- Validation-exempt per FR-SEY-5 — pure presentation; no change to trade selection, sizing, or exits. One small backend read added: `ExecutionEngine.getRecentPositions` (open + recently-closed, for the Entries/Exits day tabs) → `execution:get-recent-positions` IPC + `window.api.execution.getRecentPositions`; `getPositions` stays open-only for the Positions tab. Trading Desk stylesheet (`.td-*`) added to `styles.css`. This completes spec 08 (Parts A–D all shipped). Full suite: **643 passing**.

## [1.1.59] — 2026-06-22

### Added
- **Lean intraday batch (spec 08 §4, #4).** The daily brief sits at position 8 in the job sequence; everything after it (options snapshot, paper snapshot, earnings refresh, options-premium history) runs *after* the brief commits and can't contribute to it. A new per-job flag **`batch_jobs.after_close_only`** lets the orchestrator's **lean ~10:15 slot skip that post-brief tail** while still running the brief's full upstream closure (jobs 2–8) — so the brief is **identical**, and the morning run is faster (the tail is options-API-heavy). The after-close ~17:00 slot runs everything.
- **Slot lean-ness** is `OrchestratorJobConfig.leanSlots` (explicit) or the default — **every slot except the latest** (the after-close slot is the full run); manual/startup runs always do the full batch. Pure `isLeanSlot` helper.
- **Batch view:** a per-job **Slot** column with a **Lean / After-close** toggle (re-classify a job without a code change), and a **brief-freshness banner** (`batch:brief-freshness`) showing whether the engine has a fresh same-day brief to act on.

### Notes
- Validation-exempt per FR-SEY-5 — the lean brief is bit-identical (same upstream job closure); only the post-brief housekeeping is deferred. The 4 tail jobs are seeded `after_close_only=1` (migration 059 UPDATE for existing installs; `registerJob({afterCloseOnly:true})` for fresh); user toggles persist via `INSERT OR IGNORE`. New tests (`tests/lean-batch.test.ts`): `isLeanSlot` cases, the per-job flag + lean filter expression, freshness. Full suite: **643 passing**. Still deferred: the Part D Trading Desk visual redesign (tabs + activity timeline).

## [1.1.58] — 2026-06-22

### Added
- **Unattended paper operation (spec 08, Part A).** The execution engine can now run a full unattended paper trading day. A single **arm switch** (`exec_config.automation_mode`) has three stances: **Off** (`semi` — approve each, current), **Dry-run** (decide everything, place nothing → `exec_dry_run_log`), and **Armed** (`unattended` — auto-approve entries + auto-fire discretionary exits). **Auto-entry is PAPER-ONLY** — enforced in the engine (`tryGenerateEntries` auto-approves only when `executionMode==='paper'`); live always stays semi-auto.
- **Cycle loop driver wired.** `ExecutionCore.startLoop` was previously unwired (nothing ticked unattended); the engine now starts the management/entry loop on start at `exec_config.cycle_interval_sec` (default 120s) and stops it on stop. index.ts opts in via `enableCycleLoop`.
- **Brief-freshness gate.** The engine acts only on a brief generated **today (ET)** — `loadBriefPickInputs(..., requireToday=true)` — never yesterday's after-close brief. Eliminates the 10:00–10:15 stale-brief window.
- **Notifications.** Per-action OS push (gated by `notify_push`) + email on each entry/exit/kill-trip (`notify_per_action`), and an **end-of-day digest email** that fires **only when armed** (`notify_eod_digest`). Wired in index.ts via Electron `Notification` + the existing `EmailService`.
- **Keep-awake while armed.** index.ts starts an Electron `powerSaveBlocker('prevent-display-sleep')` whenever the engine is armed (running + unattended + paper), released on disarm/stop, so an all-day run doesn't sleep.
- **UI.** Trading Desk gains an **Automation (arm switch)** panel + prominent `⚡ ARMED` / `DRY-RUN` header pills; Execution Settings gains an **Automation & notifications** section. New `exec_config` columns + `exec_dry_run_log` table (migration 058); `execution:get-dry-run-log` IPC + `window.api.execution.getDryRunLog`.

### Notes
- Validation-exempt per FR-SEY-5 — nothing changes which trades are selected or how they're sized/exited; auto-entry only removes the human click on already-selected picks, the freshness gate only prevents acting on stale picks, and every auto-entry passes the full risk gate (re-priced) exactly as a human approval does. Caps (1/day etc.) and the kill switch bind unchanged. The planned separate `entry_mode` column was folded into `automation_mode` (one source of truth). Deferred to a later pass (Part D): the full tabbed Trading Desk redesign + activity timeline, the lean intraday batch (#4), and the in-app live notification feed. New tests: freshness gate, unattended/semi/live/dry-run cycle behavior, dry-run dedupe + no audit pollution, armed state. Full suite: **633 passing**.

## [1.1.57] — 2026-06-22

### Added
- **Live preflight: broker spread-permission gate (fail-closed).** Before the engine goes **live**, `startEngine()` now confirms the broker account can actually place a defined-risk option spread, and **refuses to start** if it can't — so a Level-1 / cash IBKR account can never go live and sit silently getting every multi-leg order rejected. The TWS API doesn't expose the options trading level directly, so the IBKR adapter probes with a **non-transmitted `whatIf` combo order** on a reference vertical (default SPY): an `OrderState` back ⇒ permitted; an order error ⇒ not permitted. Any failure to confirm (not connected, no probe buildable, permission/eligibility error, unrelated error, or timeout) is fail-closed (`started:false`, reason `spread_permission:<code>` / `broker_connect_failed:…`), with outcomes written to the audit log (`preflight_permission_ok` / `_failed`). New `ExecutionBroker.checkSpreadPermission()` (mock always grants — a simulator models no entitlement). Spec: `Requirements/v2-execution/02-risk-governor.md §2.13`.

### Notes
- **Context:** IBKR approved the *live* account for **Options Level 1 only** (covered calls / protective puts), which can't place the engine's credit spreads; the live flip is deferred pending an account upgrade to Level 3, and the operator is staying **paper-only** for now. This gate is defensive insurance for the eventual live flip. **PAPER IS UNAFFECTED** — the preflight runs in LIVE mode only (paper has full permissions and is left out of the soak path), and the broker still defaults to mock with IBKR strictly opt-in. New tests: engine paper-skips / live-refuses / live-allows; IBKR pure helpers (`classifyPermissionError`, `interpretWhatIfState`, `pickProbeSpread`). Full suite: **626 passing**.

## [1.1.56] — 2026-06-21

### Added
- **Per-strategy composite floors are now editable in Execution Settings → Entry policy.** The `exec_config.min_composite_by_strategy` map (shipped v1.1.55) was migration-set only; it now has a UI editor — one floor input per eligible strategy (plus any stale override key, flagged "not eligible" so it can be removed). A blank input inherits the global **Min composite score** (shown as the placeholder); a value overrides it. Reads/writes the existing config field, so it round-trips through `getConfig`/`updateConfig` with no engine changes. This makes the income=0 floor (and any future per-strategy calibration) adjustable without a migration.

### Notes
- No behavior change to the engine — `EntryPolicy.filterPick` already used `minCompositeByStrategy[strategy] ?? minCompositeScore`. UI-only (renderer). The **liquidity gate** (`max_combo_spread_pct`) remains in the UI and **off** by default (FR-SEY-5: not backtestable). Full suite: **617 passing**.

## [1.1.55] — 2026-06-18

### Added
- **v2 execution now trades Iron Condors** (income) — the neutral, high-IV, two-sided theta workhorse, and the second strategy in the multi-strategy book. New 4-leg `iron-condor` `ExecStructure`; income picks map to the lab's iron-condor setup. **Budget-width extended to the condor**: each long wing is sized to the per-trade budget via the existing per-wing selector, so a condor that was $2.7k–$12.6k max loss (today's income brief) becomes ≤ budget (~$400). The exit policy (credit + DTE based) already handled it with no changes. FR-SEY-5 validated (`scripts/fr-iron-condor-study.mjs`, 1,397 income replay picks, budget-sized IC, 0.16Δ shorts, 30 DTE, 50% PT / 2× stop): **win 82.3% / return-on-capital 5.7% / avg max loss $403**, vs a random-day baseline of 75.4% / 1.9% — a real edge and the highest win rate of any strategy. Migration 057.
- **Per-strategy composite floors** (`exec_config.min_composite_by_strategy`, JSON `{strategy: floor}`). A single global `min_composite_score` is wrong for a multi-strategy book — composites aren't comparable across strategies. Income scores on a lower scale (replay picks all < 50) and composite isn't predictive for condors, so the inflection-calibrated 50 floor would gate out **every** income pick; income's floor is set to 0 (the validated population). Strategies without an override fall back to the global floor (inflection/wheel unchanged).

### Notes
- `eligible_strategies` is now `inflection,wheel,income`. Caps still bind across the union (the engine takes its best 1/day, 3/week), so income adds neutral-market coverage without raising the trade rate. Iron condor exit/order/sizing reused the existing structure-agnostic machinery (4-leg BAG, credit-based exits). Tests: income→IC mapping, per-strategy floor round-trip; `tests/{brief-entry-source,entry-policy}.test.ts`. Full suite: **617 passing**.

## [1.1.54] — 2026-06-18

### Added
- **v2 execution now trades the Wheel** (as a defined-risk put credit spread) — the first step in broadening the engine from a single-setup sniper to a multi-strategy book. The entry source is generalized: it reads the latest brief for **every eligible strategy** (`exec_config.eligible_strategies`, now `inflection,wheel`) and maps each to the credit structure the engine trades — inflection → direction-locked vertical, **wheel → short-put-vertical** (the small-account "wheel"; a naked CSP can't be sized at $10k, the put credit spread can). All existing gates/caps/pricing/fills are reused unchanged. FR-SEY-5 validated (`scripts/fr-wheel-spread-study.mjs`, 1,388 wheel replay picks, budget-sized put credit spread, 30 DTE, 50% PT / 2× stop): **wheel win 79.8% / return-on-capital 8.2%**, vs inflection 75.1% / 6.1% and a random-day baseline of 74.3% / 3.7% — a real selection edge that beats the already-shipped inflection edge. Wheel composites (66–75) clear the 50 floor and all picks carry critic verdicts, so the existing filters apply cleanly. Migration 056 (preserves a user override).

### Notes
- The daily/weekly caps still apply across the **union** of strategies, so adding wheel widens the candidate pool (more days have something tradeable) without raising the trade rate — consistent with the "capital deployed in validated edges, not trades/day" goal. Iron condors (income) are the next strategy to add. `brief-entry-source` generalized to `loadBriefPickInputs(db, strategies, now)` + `briefPickToPickInput(pick, strategy, …)`; tests in `tests/brief-entry-source.test.ts`. Full suite: **614 passing**.

## [1.1.53] — 2026-06-18

### Changed
- **Risk-budget spread width is now ON by default** (migration 055) — FR-SEY-5 validated. The inflection vertical's hedge leg is sized to the per-trade budget (5% of capital), so high-priced names become tradeable on a small account instead of being silently rejected. Validation (`scripts/fr-budget-width-study.mjs`, faithful `simulateSingleSpread` replica over 1,386 inflection replay picks, same 0.30Δ short + same picks, only the wing differs), at the operative **$500** budget: return/max-loss **5.6% → 6.1%** (Δ **+0.5 pts**), win rate **75.0% → 75.1%** (unchanged), **sizeable at $500: 58% → 100%**. Narrower spreads carry a higher credit/max-loss ratio on wins → return-on-capital is neutral-to-better while every pick becomes sizeable. (Sensitivity: +0.9 pts at $250, −1.2 pts at $1,000 — wider budgets widen spreads and lose efficiency, which the 5% cap already prevents.) Toggle in **Execution Settings → Entry policy**.

### Added
- **Execution Settings** exposes the two new controls: **Risk-budget spread width** (toggle, now on) and **Max combo spread (rel.)** (the liquidity gate).

### Notes
- The **liquidity gate** (`max_combo_spread_pct`, v1.1.52) stays **OFF**: it can't be backtested (no historical bid/ask to compute a combo spread), so per FR-SEY-5 it ships disabled with the finding recorded. Live evidence — the Phase 7 AMAT round-trip crossed ~23% of the credit — is the rationale to enable it (~0.20) manually. Validation script committed as `scripts/fr-budget-width-study.mjs`. Full suite: **610 passing**.

## [1.1.52] — 2026-06-18

### Added
- **v2 execution — small-account spread fitness (infrastructure, default OFF).** Two gaps that Phase 7 paper calibration surfaced — both shipped disabled pending FR-SEY-5 validation:
  - **Risk-budget-driven spread width** (`exec_config.budget_width_enabled`, migration 053). The strategy lab builds short verticals with delta-targeted legs (sell 0.30Δ, buy 0.15Δ), so width is uncontrolled — $60 wide on AMAT (580/520), max loss $4,428, which the risk gate sizes at **0 contracts** under a $10k/5% ($500) budget. When enabled, the brief passes the per-trade budget to the lab and `findBudgetWidthHedge` picks the **widest** hedge leg whose max loss still fits the budget (~$5 wide on AMAT → sizeable). Returns `unavailable` ("No spread within the per-trade risk budget") if even the narrowest spread busts the budget.
  - **Liquidity / economics gate** (`exec_config.max_combo_spread_pct`, migration 054). Even when sized, wide-bid/ask names bleed the edge to slippage (live AMAT round-trip crossed ~23% of the credit). When > 0, `EntryPolicy.buildProposal` rejects a proposal (`wide_market`) whose combo relative spread `(ask−bid)/|mid|` exceeds the threshold.

### Notes
- **Both default OFF** (`budget_width_enabled = 0`, `max_combo_spread_pct = 0`) — no behavior change until validated. Per FR-SEY-5, a backtest delta on the budget-sized width must show at-worst-neutral before either ships enabled. New formula doc: `docs/formulas.md#budget-width`. Tests: `findBudgetWidthHedge` (4) in `tests/strategy-lab-service.test.ts`; liquidity gate (2) in `tests/entry-policy.test.ts`. Full suite: **610 passing**.

## [1.1.51] — 2026-06-18

### Fixed
- **IBKR combo pricing now prices from the individual legs, not the BAG.** During live Phase 7 calibration on the paper account, `IbkrExecutionBroker.priceCombo` returned no bid/ask: IBKR doesn't serve market data for smart-routed BAG combos (single-leg option data works fine). `priceCombo` now requests top-of-book for **each leg** and nets them into the combo quote (new pure helper `comboQuoteFromLegs`): a sold leg adds its premium, a bought leg subtracts it; `bid` is the conservative side (sell each short leg at its bid, buy each long leg at its ask), `ask` the other, `mid`/`netCredit` from leg mids. Validated live (AAPL 280/275 put vertical → ~$0.59 credit at mid, bid $0.49 / ask $0.70). Requires an **options market-data subscription** on the account (OPRA); a leg with no quote raises a clear error.

### Notes
- This needs the account's US options data subscription (OPRA add-on) — confirmed active on the paper account. Order placement/fills don't need data, but pricing proposals does. New unit tests for `comboQuoteFromLegs` (credit spread, lone CSP, debit, ratios) in `tests/ibkr-execution-broker.test.ts`. Diagnostic scripts added: `ibkr-md-diagnose.mjs` (single-leg vs combo data) and `ibkr-price-from-legs.mjs` (live leg-based pricing check). Full suite: **604 passing**.

## [1.1.50] — 2026-06-18

### Changed
- **Lowered the v2 inflection entry gate `min_composite_score` from 70 → 50** (migration 052; configurable, preserves a user override). Backtest-validated, not a guess: over **5 years / 32,760 with-trend up-breakouts**, on a bull-put-spread outcome proxy (short strike 5% OTM, ~30-day hold) the inflection composite is **non- to mildly *anti*-predictive**. Any breakout wins ~75.9% (random-day baseline 74.9%); the composite ≥70 slice wins only ~69.7% while admitting <3% of breakouts, and `volume_surge`/`decisiveness` are monotonically *anti*-predictive (higher value → lower win rate). So the 70 gate wasn't protecting quality — it selected slightly-worse trades **and** starved the inflection-only engine of entries (no inflection pick ever reached 70). A ~50 sanity floor admits genuine breakouts at the base rate (~76%) — at worst neutral per FR-SEY-5 — and leaves real quality control to the critic gate + defined-risk structures + 2× stop / profit target + 1/day, 3/week caps.

### Notes
- **`volume_surge`/`breakoutDecisiveness` `normMax` scaling intentionally left unchanged.** `decisiveness` normMax:3 is technically too harsh (real breakouts top ~1.5 at p95 → norm 50), but the signal is anti-predictive, so re-scaling it to drive the score *more* would amplify the wrong signal. The "miscalibration" isn't worth fixing because the signal doesn't predict outcomes.
- This is a directional proxy (no credit/IV/stop modeling) — it shows the *directional* signals don't predict the stock holding up; it does **not** claim inflection is unprofitable (the credit/IV economics need the app's option-priced Backtest engine, which only has forward data from now). Re-validate once live inflection trades accumulate.
- `entry-policy.test.ts` seeded-default assertion updated to 50. Full suite: **600 passing**.

## [1.1.49] — 2026-06-18

### Fixed
- **The after-close batch run failed to overwrite the morning run's *partial* daily price bar — silently corrupting breakout/inflection scoring.** The batch runs twice a trading day: an intraday scan (≈10:15 ET) and an after-close run (≈16:30+ ET). The morning run stores a partial same-day bar (only the session-so-far volume + an intraday "close"). `PriceGapFillJob`'s staleness gate (`HAVING MAX(date) < date('now')`) then treated that partial bar as "fresh," so the after-close run **skipped the ticker entirely** and never refreshed it. The evening brief therefore computed breakouts on a non-final close and read `volume_surge` at ~10–25% of average for *every* candidate (today's bar held only the first ~50 min of volume). Because `volume_surge` is 25% of the inflection composite weight, this structurally capped inflection composites well below the v2 entry gate (`min_composite_score = 70`). The job now re-fetches the recent daily-bar window for **every** ticker with history on every run; `historical_prices` is `INSERT OR REPLACE` on (ticker, date), so the finalized after-close bar overwrites the partial morning one.
- **Paper-trade snapshots now overwrite today's row on a same-day re-run** (`paper_trade_snapshots` ON CONFLICT `DO NOTHING` → `DO UPDATE` for today only). The after-close run replaces the morning intraday/partial-bar close with the finalized close; past snapshots stay immutable.

### Notes
- Root cause of the inflection brief's "no tradeable picks" symptom found in the brief-accuracy audit: with full-volume bars, `volume_surge` will reflect real breakout participation and inflection composites can clear 70. The audit-found data bug is fixed at the source; no scoring weights were changed.
- Audit of all batch jobs' same-day write semantics: `historical_prices`/`options_premium_history` (INSERT OR REPLACE), `technical_signals`/`iv_history` (ON CONFLICT DO UPDATE), `daily_briefs` (newest row) all already overwrite; only price-gap-fill (skip) and paper-snapshot (DO NOTHING) needed fixing.
- New spec §20.5 documents the two-slot "refresh + overwrite" invariant. Regression test `tests/price-gap-fill-refetch-today.test.ts`. Full suite: **600 passing**.

## [1.1.48] — 2026-06-17

### Fixed
- **The on-demand E\*Trade options path now self-heals from token dormancy** — the second half of the "TraderAgent makes no trades on evening runs" problem (the first was the v1.1.47 Saturday-expiration bug). E\*Trade access tokens go dormant after ~2 h of inactivity and the API then returns 401. The nightly batch jobs already renew-and-retry, but `ETradeDataProvider.getOptionsChain` / `getOptionsExpirations` — the path the API-server options route, the TraderAgent scout, and the Strategy Lab all use — did **not**. So any options fetch made more than ~2 h after the last E\*Trade activity threw a 401, which the options route swallowed into an empty chain (and the agent recorded zero contracts). The provider now wraps both calls in `withRenew`: on a dormant-token auth error it calls `renewAccessToken` once and retries. A fully expired token (past midnight ET) still propagates — that needs a manual re-auth in Settings → E\*Trade Connection.

### Notes
- This rescues **early-evening** agent runs (token idle but E\*Trade still serving quotes). It cannot manufacture data if E\*Trade is fully dark late at night; for reliability, run the agent during or within ~1–2 h of the close. Combined with v1.1.47, a market-hours run now produces trades again.
- Regression test: `tests/etrade-dormant-token-renew.test.ts` (4 tests — renew-and-retry on 401 for both chain and expirations, no renew on non-auth errors, propagate a failed renew). Full suite: **599 passing**.

## [1.1.47] — 2026-06-17

### Fixed
- **The local API options endpoint returned an empty chain on evening runs — which silently starved the TraderAgent of trades (zero new positions for ~10 days).** `GET /api/v1/options/:ticker`, when called without an explicit `expiration`, guesses the next 8 weekly Friday expirations. That helper (`nextFridays`) computed the weekday from **local** time (`getDay()`/`getDate()`) but serialized the result with **UTC** (`toISOString()`). Run after the local clock crossed UTC midnight — i.e. any evening run in a timezone behind UTC — every "Friday" it produced shifted to the **Saturday** UTC date. E\*Trade lists Friday expirations only, so each chain lookup missed, the route swallowed the per-expiration miss, and returned `{ ok: true, [] }`. The TraderAgent scout therefore recorded **zero option contracts** for every survivor, and `decide` had nothing to select. Verified against the data: the agent's last trade was June 8 (a daytime run); every evening run June 9→18 produced 80–130 survivors but 0 contracts, while the app's own snapshot job (which resolves real expirations) kept pulling Friday chains the whole time. `nextFridays` now computes entirely in UTC, matching the pattern already used in `analysis-service` / `filter-templates-service`.

### Notes
- Root cause was purely the expiration-date math in `routes-options.ts`; E\*Trade auth, the screener (Polygon), and the agent's own pipeline were all healthy. The two other Friday-expiration helpers (`ipc-options.generateNextFridays`, `opportunity-service.nearestFridayAtLeast`) serialize with **local** methods throughout, so they were internally consistent and unaffected.
- Regression test: `tests/options-route-fridays.test.ts` (2 tests) pins the helper to UTC Fridays under a fake evening clock. Full suite: **595 passing**.

## [1.1.46] — 2026-06-17

### Added
- **v2 execution — Phase 6b (part 1): the brief→entry source.** The execution engine can now turn the daily brief's **inflection** picks into entry proposals. A new `brief-entry-source.ts` reads the latest committed inflection brief, selects the direction-locked defined-risk vertical from each pick's Strategy Lab result (`pickRelevantStructure`: up-breakout → short-put-vertical, down → short-call-vertical), and maps it to the normalized `PickInput` the `EntryPolicy` consumes — legs, composite score, critic verdict, liquidity, earnings-before-expiry (resolved from `earnings_calendar`), and per-contract max loss. The engine runs this on each **market-open cycle** (not at brief-commit), so the entry window (10:00–15:00 ET), daily/weekly caps, critic/composite filters, and live IBKR re-pricing all apply; a stale brief never trades a stale price, and the daily cap stops repeats across cycles.

### Notes
- Wired on the existing `ExecutionEngine` market-cycle hook — **no engine/UI changes** beyond the new source. Entries only generate while the engine is **running**, the broker is **connected**, and the market is **open**; generation is fail-safe (never throws into the management cycle). With the mock broker this runs offline; against IBKR it prices each candidate on the live chain. **Still pending (Phase 7): live combo pricing + order/fill calibration on the paper account once options-spread approval lands.**
- Pure mapping + the loader covered by `tests/brief-entry-source.test.ts` (15 tests). Full suite: **590 passing**.

## [1.1.45] — 2026-06-17

### Added
- **v2 execution — Phase 6a: the IBKR adapter (`IbkrExecutionBroker`).** A live implementation of the `ExecutionBroker` seam over the TWS socket API (via `@stoqey/ib`), so the engine can place/manage real orders through a locally-running **TWS or IB Gateway**. Paper vs live is purely the connection port (TWS paper 7497 / live 7496, Gateway paper 4002 / live 4001) — never an engine or UI change. A new **broker factory** (`broker-factory.ts`) selects mock vs IBKR: the default stays the deterministic `MockExecutionBroker`, and IBKR is **opt-in** via `TA_EXEC_BROKER=ibkr` (with `TA_IBKR_HOST` / `TA_IBKR_PORT` / `TA_IBKR_GATEWAY` / `TA_IBKR_CLIENT_ID` overrides), so existing installs are unaffected. The IBKR combo net-price sign convention (credit-positive → IBKR's credit-negative BUY limit) is centralised in one helper for paper calibration.

### Notes
- **Connection, contract qualification, buying-power, and position/order reads are live-verified** against the IBKR paper account (account-summary + positions smoke via `scripts/ibkr-probe.mjs`); these need no options permission. **Combo order placement + fills are implemented to IBKR's documented combo conventions but are calibrated/verified on paper in Phase 7**, once the account's options-spread permission is approved. The paper account is a *margin* paper account, so credit-spread paper validation is possible there even though a live **cash** account would need a Reg-T margin upgrade first.
- Pure mapping logic (expiry/contract/status/net-price conversions + factory settings) covered by `tests/ibkr-execution-broker.test.ts` (16 tests). Full suite: **575 passing**.

## [1.1.44] — 2026-06-17

### Added
- **Full-sync close now records an estimated realized P&L**, so a position closed at the broker no longer lands in the Closed tab with a blank P&L. When `closeMissingPositions` marks a position closed it sets `realized_pnl = COALESCE(realized_pnl, unrealized_pnl)` — i.e. its last E\*Trade mark (`totalGain`, persisted since v1.1.43) — and stamps `exit_date` + an `exit_notes` flag that it's an estimate. **It never overwrites a realized P&L already set** (e.g. by the transaction-history "Sync Closed Positions", which stays the authoritative exact source).

### Notes
- Applies to positions closed **going forward** (the estimate needs the last mark, stored only since v1.1.43). A position that was already closed before these builds (no stored mark) stays blank — run **Sync Closed Positions** to pull its exact figure from transaction history. Regression coverage in `tests/etrade-portfolio-reconcile.test.ts` (estimates from the last mark; doesn't overwrite an existing realized figure).

## [1.1.43] — 2026-06-17

### Fixed
- **Portfolio Unrealized P&L now populates from the E\*Trade sync (was always $0).** E\*Trade's portfolio response includes the dollar gain/loss per position (`totalGain`), but `upsertPosition` only stored the *percentage* (`total_gain_pct`) and never set `unrealized_pnl`. Since `getPnLSummary` sums `unrealized_pnl` (null for every synced position), the **Unrealized P&L** summary card read $0. The sync now stores `raw.totalGain` into `unrealized_pnl` on both insert and update, so per-position and total unrealized P&L show after a sync. (`current_price` stays driven by the live-quote refresh — short options can't derive a clean per-share price from market value.)

### Notes
- **Re-sync required**: existing rows have `unrealized_pnl = null`; run the portfolio E\*Trade sync once on the new build to backfill them. Found via user report ("not showing P&L"). Regression coverage in `tests/etrade-portfolio-reconcile.test.ts` (totalGain → unrealized_pnl on insert and re-sync update).

## [1.1.42] — 2026-06-17

### Fixed
- **Portfolio E\*Trade sync is now a full sync — positions closed at the broker drop off.** The sync only *upserted* the positions E\*Trade returned; a position you closed (e.g. NVDA) stayed in the local DB and kept showing as open. The sync now **reconciles**: after a successful fetch, any OPEN, E\*Trade-sourced position for that account whose broker id is no longer in the response is marked `closed` (the row is kept, so notes / realized P&L / history are preserved; the portfolio shows only open positions). The sync result reports the count (e.g. "Synced: 8 updated, 0 skipped, **1 closed**"). Safety: reconciliation runs **only after a successful fetch** (a fetch error never closes anything), is **scoped to the synced account(s)**, and **never touches manual positions** (those without an `etrade_position_id`); the upsert also re-asserts `status='open'`, so a position the broker reports again self-heals back to open.

### Notes
- Found via user report (closed NVDA still showing). Regression coverage in `tests/etrade-portfolio-reconcile.test.ts` (closes a gone position; leaves manual / other-account / already-closed alone; closes all when the account is flat).

## [1.1.41] — 2026-06-17

### Added
- **Payoff "🔧 Fix" now covers lizards and iron condors** (was the two vertical credit spreads only). It still narrows the protective wing(s) toward the short strike(s) — keeping your shorts — re-priced from the live chain, widest passing strike first:
  - **Jade Lizard / Big Lizard** — narrows the long **call** so total credit ≥ the call-spread width (the "no upside risk" condition).
  - **Reverse Jade / Reverse Big Lizard** — narrows the long **put** so credit ≥ the put-spread width.
  - **Iron Condor / Dynamic Width Iron Condor** — greedily narrows whichever wing is currently **wider** (the binding side) until credit ≥ ⅓ × max(put width, call width).
  Refactored into a generalized single-wing path + a two-wing condor path in `src/shared/payoff-fix.ts`; the button stays hidden when the rule already passes or no strike narrows enough.

## [1.1.40] — 2026-06-17

### Added
- **One-click "🔧 Fix" in the Payoff strategy-rules panel.** When a credit spread fails the "credit ≥ ⅓ of spread width" rule (shown with a ✗), a Fix button appears that adjusts the legs to pass it — **narrowing the protective wing toward the short strike while keeping your short strike** (the thesis), re-priced from the live option chain at mid, choosing the widest strike that passes (least narrowing). E.g. a bull put $620/$590 ($30 wide, $9.40 credit, ✗) becomes $620/$595 ($25 wide, credit ≥ ⅓). Scope: the two vertical credit spreads (Bull Put Spread / Bear Call Spread — the inflection launch structures and the common failing case); the button is hidden when no fix applies (chain not loaded, unsupported strategy, or no strike narrows enough). Implemented as the pure, unit-tested `fixLegsForStrategy` (`src/shared/payoff-fix.ts`).

## [1.1.39] — 2026-06-17

### Fixed
- **Opening Payoff from the Daily Brief now loads the option chain for the pick's own expiry, not the nearest weekly.** When navigating to the Payoff visualizer from a brief pick (which supplies pre-built legs), the brief-nav effect only set the legs and never loaded the chain or set `selectedExpiry` — so the chain panel and the "Suggested next leg" / manual leg-add buttons fell back to this week's Friday, adding legs at the wrong expiry (e.g. this Friday instead of the 7/17 the pick used). The effect now also loads the chain for `initialExpiry` (snapped to the nearest available expiry, which is an exact match when the brief's expiry is listed) and sets `selectedExpiry`, so all leg operations use the pick's expiry. Mirrors the existing Opportunity-navigation behavior.

### Notes
- Renderer-only — **no brief re-run needed**; relaunch the app. Found via user report (added next leg landed on this Friday instead of the 7/17 expiry from the brief).

## [1.1.38] — 2026-06-17

### Changed
- **Brief card lab line is now a single row** with the setup inline after the recommended structure: `CSP A+ : $470 Jul 17 $2305.00 cr | Top lab pick: Big Lizard A+` (was a two-row layout with the setup under the grade). The setup sits right after its structure's grade (`:` separator) so it can't be misread; the Top-lab-pick cross-reference follows after a `|`. Display layout only.

## [1.1.37] — 2026-06-17

### Changed
- **Renamed the brief card's "Best fit" cross-reference to "Top lab pick".** On a pick whose recommended structure isn't the single highest-scoring lab structure, the card shows that top structure as an FYI (e.g. a Big Lizard on a wheel CSP card). "Best fit" implied it was a *better* choice for the strategy; it's actually just the highest-scoring structure overall for the ticker across all strategies. "Top lab pick" reads as informational, not a competing recommendation. Display-label only.

## [1.1.36] — 2026-06-17

### Fixed
- **The Daily Brief's Payoff/Options buttons now load the recommended structure, not the best-overall one.** On a pick whose recommended trade isn't the single highest-scoring lab structure, `PickNavRow` used `scores[0]` (the best-OVERALL structure across all 31 strategies) for the Payoff visualizer and the Options expiry — so clicking **Payoff** on a wheel **CSP** pick (AMD $470 / \$2,305) loaded a **Big Lizard** (\~\$6,200) instead. This affected wheel, income, buy, and **inflection** (the v2 launch strategy — its Payoff loaded a Big Lizard rather than the bull-put credit spread). The nav row now resolves the structure via the same `pickDisplayStructure(scores, strategy, breakoutDirection)` selector the card uses, so Payoff/Options/legs match the recommended trade shown on the card.
- **The brief card's setup line is now labeled with its structure.** The `strike · expiry · premium` line describes the *relevant* structure (e.g. the CSP), but it visually trailed the "Best fit: Big Lizard A+" tag, making it ambiguous which structure the `$470 / $2,305` belonged to. It's now prefixed with the structure name (`CSP: $470 · Jul 17 · $2305.00 cr`).

### Notes
- Renderer-only change — **no brief re-run needed**; relaunch the app and the persisted brief renders correctly. The relevant-structure selector (`pickDisplayStructure`) is covered by `tests/strategy-structures.test.ts`; this routes the nav row through it (same pattern as the v1.1.30 inflection-direction fix). Found via user report (wheel AMD).

## [1.1.35] — 2026-06-17

### Fixed
- **The critic no longer calls a bounded short-put loss "unlimited/uncapped" — it now cites the precomputed max loss.** The critic's structure context omitted `maxProfit`/`maxLoss`, so on every bullish big-lizard the LLM described the short-put downside as "uncapped … nearly unlimited" — technically wrong: a short put's loss is **bounded** (worst case at underlying → 0), and the figure was already computed (e.g. AMD −\$44,836, ALAB −\$29,931). Only a naked short **call** is truly unbounded. The critic context now carries `structure.maxProfit` / `structure.maxLoss` (per-contract ×100; `null` ⇒ genuinely unbounded — naked short call) and `structure.breakevens`, and the prompt instructs the model to cite these for any reward/risk or max-loss statement and to never call a finite `maxLoss` "unlimited/uncapped". Same remediation pattern as the precomputed expected-move (v1.1.31) and IV (v1.1.20/29) — a number the critic reasons about must be given, not invented. This also lets the critic affirm the **defined-risk max loss** on inflection credit spreads (the v2 launch structures).

### Notes
- Rationale-accuracy only — no rule check, gate, or trade selection changed (the deterministic defined-risk preference already used `maxLoss`; this only surfaces it to the LLM). The bounded-short-put / unbounded-short-call facts are covered by `classifySingleExpiryPnl` tests (`tests/strategy-lab-service.test.ts`). The persisted 2026-06-17 brief keeps the old wording; **re-run the brief** for rationales that cite the real max loss.

## [1.1.34] — 2026-06-17

### Fixed
- **ATM (0.50-delta) structure bodies are now centered on spot, fixing a silent directional skew from stale E\*Trade Greeks.** The neutral body legs of straddles / iron-flies (income) and big-lizards (bullish) target 0.50 delta, but E\*Trade can serve deltas computed at an old spot whose deviation still slips under the `trustDeltas` 8% guard — e.g. on the 2026-06-17 brief MRVL's delta-implied ATM was \$300 vs spot \$278.67 (7.65%), so the "neutral" iron-fly/big-lizard body was placed at \$300, **7.7% above spot** (an ITM short put that needs a rally to profit). The critic flagged this on nearly every income/bullish pick (AMD \$520/+2.5%, COHR \$400/+4.5%, Z \$35/+5.2%, ALAB \$380/+5.1%). `findByDelta` now selects `deltaTarget ≈ 0.50` legs by **moneyness** (the strike nearest spot — correct for ATM by definition and robust to stale Greeks); OTM-wing selection (0.16/0.20/0.05 delta) is unchanged. This re-centers the income iron-flies and bullish big-lizards on spot.
- **The degenerate-spread guard is now expiration-aware.** With ATM bodies selected by moneyness, a calendar's two 0.50-delta legs legitimately land on the same strike (different expirations) — the guard compared strike only and falsely rejected them as degenerate. It now requires same strike **and** same expiration, so calendars/diagonals build correctly while a real same-expiry collision (mislabeled condor) is still caught.

### Notes
- Structure-quality fix on already-selected picks — **ticker selection is unchanged** (income/bullish composites come from `analysis-service` signals, not the lab structures), so it's neutral on Brief Replay by construction (no FR-SEY-5 gate). Income/bullish are decision-support (not in the v2 inflection-only launch scope). The persisted 2026-06-17 brief keeps the skewed bodies; **re-run the brief** for centered structures. Regression coverage in `tests/strategy-lab-service.test.ts` (`findByDelta` ATM-by-moneyness vs stale delta; calendar same-strike build).

## [1.1.33] — 2026-06-17

### Fixed
- **ADX is no longer ~14× too large (Wilder average, not sum).** `analysis-service.computeADX` reused the Wilder running-**sum** helper for the final ADX step and never divided by `period` — correct for the +DI/−DI ratios (the sums cancel) but wrong for ADX, which is the **average** of DX. So ADX came out an impossible ~648 for AMD (true ~46), saturating the trend signals and surfacing "trendNeutral score of 630" in a brief rationale. Fixed by `÷ period` (the exact Wilder ADX recursion); ADX is now bounded [0, 100]. The companion `daily-technical-signals-job.computeADX` was already correct.

### Changed
- **ADX removed from composite scoring (FR-SEY-5 validated).** A full-year Brief-Replay A/B (the corrected ADX fed into scoring vs absent) showed enabling it is **net-negative on every strategy that uses it** — bullish **−1.50pp**, bearish **−1.15pp**, income **−0.43pp** on direction-aware forward returns, with lower hit-rates — because strong-trend (high-ADX) names mean-revert over the next ~21 days. The live brief was *accidentally protected* because the 14× bug saturated the signal to a non-discriminating constant, so naively shipping the arithmetic fix would have silently degraded those strategies. `ScoringService.USE_ADX_IN_SCORING = false`: `trendStrength` (bullish) and `downtrendScore` (bearish) now use only their MA-stack component, and income's `trendNeutral` goes missing — the validated-best state (≈ prior behaviour; replay never fed ADX into scoring). The corrected ADX is retained for **display only** (Validate dashboard, Analysis view).

### Notes
- Net effect on the brief: bullish/bearish/income rankings unchanged-or-better, no more "ADX 630", and the "fixing the bug silently hurts" trap is defused. Buy/wheel/inflection never used ADX (unaffected). The A/B harness `tests/adx-replay-validation.test.ts` (gated behind `RUN_ADX_AB`, ADX-on arm via `REPLAY_WITH_ADX`) stays for future re-validation. see `docs/formulas.md#adx`.

## [1.1.32] — 2026-06-16

### Changed
- **One canonical ATM-IV definition shared by the lab and the live E\*Trade provider — the provider no longer uses a "closest call only" measure.** An audit of the 2026-06-16 brief flagged AMD reading **70.27%** ATM IV in the brief/critic vs **81.83%** in `quote_cache`. Investigation showed the bulk of that gap is a legitimate *tenor* difference (the brief measures its ~30-DTE expiration; the chain-view value measures the **nearest** expiration, which spikes hardest on AMD's −7.3% day) — **the brief was correct and never reads the chain-view value.** But it also surfaced a real definitional inconsistency: `etrade-data-provider.getOptionsIV` computed ATM IV from the **closest call only**, while the lab (`computeAtmIv`) and `iv_history` use the **call+put average** at the closest strike, so the same expiration could read differently by the put/call skew. Both now share the single pure `atmIvAtClosestStrike(items, underlyingPx)` (`src/main/services/iv-utils.ts`) = average IV of every contract at the strike nearest spot. The lab's number is **unchanged** (the helper replicates its prior call+put average exactly); the E\*Trade chain-view / dashboard / screener IV now includes the put side. No trade-logic or brief change — the brief/critic path was already self-consistent on the 30-DTE value. see `docs/formulas.md#atm-iv`.

### Notes
- Affects display surfaces only (options-chain view, Morning-Briefing dashboard, screener wheel metrics, `quote_cache.current_iv`); the brief, critic, IV-rank, and execution paths are untouched. Regression coverage in `tests/iv-utils.test.ts` (call+put average vs calls-only, nearest-strike selection, unit pass-through, null/empty guards).

## [1.1.31] — 2026-06-16

### Fixed
- **The critic no longer computes the expected 1-sigma move itself — it now cites a precomputed value, fixing rationales that overstated the move by 40–85%.** The critic prompt handed the LLM the formula (`impliedVolPct × √(dte/365)`) and asked it to compute the expected/1-sigma move; the model's manual arithmetic was unreliable, routinely overstating it on the 2026-06-16 brief — **AMD** (wheel) "the 1-sigma downside move … is roughly ±\$149 (~29%)" when the true figure is **±\$104 (20.5%)** (70.271% IV, 31 DTE, \$507.29 — confirmed against live data); **MRVL** (bullish) "~\$152" vs the true **±\$82 (29.5%)**. This is the same class of error as the IV fabrication already eliminated from the volatility context (v1.1.20/29): a number the critic reasons about numerically must be *given* to it, not derived. The expected move is now precomputed via the exported pure `expectedOneSigmaMove(impliedVolPct, dte, price)` and passed in `volatility.expectedMove1SigmaPct` / `expectedMove1SigmaUsd`; the prompt instructs the model to cite the provided numbers verbatim and **never** compute the move itself (and to skip expected-move reasoning entirely when they're absent). see `docs/formulas.md#expected-move`.

### Notes
- Rationale-accuracy only — no rule check, gate, or trade selection changes; the deterministic rule layer never relied on the LLM's move estimate. The persisted 2026-06-16 brief still carries the old (LLM-computed) rationales; **re-run the brief** for rationales that cite the precomputed move. Regression coverage in `tests/critic-service.test.ts` (AMD ±\$104/20.5%, MRVL ±\$82/29.5%, null-IV/zero-DTE → no move).

## [1.1.30] — 2026-06-16

### Fixed
- **Inflection structure selection is now LOCKED to the breakout direction, so an up breakout can never surface a bearish bear-call spread.** Inflection's two relevant verticals are direction-opposite (bull-put `short-put-vertical` for an up breakout, bear-call `short-call-vertical` for a down breakout) and **both are always constructible on any chain**. `pickRelevantStructure` chose the *higher-graded* of the two — so on the 2026-06-16 brief **MCHP** (an UP breakout, `breakout_state = 1`) surfaced a **short-call vertical** because the bear-call (A+, 94) out-graded the bull-put (A+, 93) by a single point. The advocate rationale even flagged it ("notably this is a call-side structure, implying bearish inflection") — a bearish trade recommended on a bullish breakout. This is the v2 launch strategy (real-money path), and it diverged from how **Brief Replay / Backtest** (`simulateSingleSpread`) already select the spread (up → bull-put, down → bear-call). Selection now narrows to the breakout-side slug via a new shared `relevantSlugsForPick(strategy, breakoutDirection)`; the breakout side is persisted on each pick as `BriefPick.breakoutDirection` (`'up'`/`'down'`, set from `technical_signals.breakout_state`) so the advocate, critic, PDF/email report, and Daily Brief card all lock to the **same** direction-matched structure. The brief's liquidity gate (`getBestLiquidityScore`/`hasAdequateLiquidity`) is direction-aware too, so it evaluates the structure actually recommended. Defaults to `'up'` (the launch/default config — down breakouts are off by default) when direction is absent, and surfaces **nothing** rather than the opposite-side trade if the breakout-side vertical is unavailable.

### Notes
- **Ticker selection is unchanged** (composite-driven, independent of lab grade) — only the structure shown per already-selected inflection pick changes, so this is neutral on Brief Replay returns by construction (no FR-SEY-5 gate). It in fact brings the live brief into line with the direction-locked spread the backtest already simulates. The persisted 2026-06-16 brief still holds the old (grade-locked) structure; **re-run the brief** for MCHP to show its correct bull-put vertical. Regression coverage in `tests/strategy-structures.test.ts` (MCHP up-breakout, down-breakout lock, up-default, unavailable-side → null).

## [1.1.29] — 2026-06-16

### Fixed
- **The critic now sees the full structure (all legs), not just the short strike.** The advocate was given the complete leg list (v1.1.23) but the critic's LLM context still passed only the single short-leg `strike`, so on multi-leg structures the critic misread the trade — on the latest brief it called a **put zebra**'s $35 financing short leg a lone in-the-money strike and flagged an "inconsistency" against the advocate's fuller "$37.5/$35" description (LBRDK, EL). The critic context now carries `structure.legs` (e.g. `["buy 2× put $37.5", "sell put $35"]`) via a single shared `formatStructureLegs` used by both the advocate and the critic — so both reason about the same complete structure, with leg quantities shown for ratio structures (zebra/butterfly bodies). The old single short strike is retained as `shortStrike`/`strikeOtmPct`.
- **The critic no longer mistakes the advocate's "recent volatility" for an implied-vol discrepancy.** The advocate cites the realized-vol scoring signal (e.g. ASTS "recent volatility 138.7"); the critic only had `impliedVolPct` (111.6) and flagged a phantom "unexplained IV discrepancy," inflating the verdict to `flag`. `extractVolatilityContext` now also surfaces `volatility.realizedVolPct` (the recentVolatility signal), and the prompt states it is realized vol — a momentum signal, expected to differ from implied vol — so the gap is not treated as an error. Residual of the v1.1.20 IV-conflation class, from the advocate-number angle.

### Notes
- Critic-context completeness only — no risk was hidden and no recommendation changed; these removed muddled reasoning and ~1 phantom flag. The persisted brief carries the critic verdicts from its generation run; **re-run the brief to get verdicts from the improved context.**

## [1.1.28] — 2026-06-16

### Fixed
- **Structure P&L is now computed from the actual expiry payoff, fixing wrong max-profit on debit verticals and dangerously understated max-loss on butterflies.** `classifySingleExpiryPnl` previously classified by leg signature, which broke two ways the defined-risk/directional preferences (v1.1.25/27) newly surfaced: **(a)** long/*debit* verticals (`long-put-vertical`, `long-call-vertical`) used a wrong-sign width → **negative max profit** (GPN −698.75, EL −753.75; should be +301.25 / +246.25) and a breakeven off the wrong leg; **(b)** 3-leg **butterflies** fell through the 2-leg branch and reported max loss as just the debit, **understating the true risk ~5–30×** on the broken-wing flies the lab builds (ARE reported −$8.75, true −$258.75; FLUT −$115, true −$615). It now evaluates the position's piecewise-linear payoff (entry cash flow + each leg's intrinsic at every kink), taking extrema for max profit/loss and sign-changes for breakevens, with explicit unbounded detection (net-short calls → `null` loss, net-long calls → `null` profit; puts always bounded since S ≥ 0). This prices verticals (both orientations), balanced and broken-wing butterflies, condors, lizards, and ratio/zebra structures correctly, and surfaces breakevens the old code missed (e.g. a big lizard's upper breakeven). Iron condors/flies and the calendar/PMCC diagonal branch are unchanged.
- **Debit reward/risk now uses the actual max loss, not the debit paid.** The lab's premium score for debit structures divided max profit by `netDebit`; for a broken-wing butterfly the true max loss exceeds the debit, so this overstated attractiveness. It now divides by `|maxLoss|` (equal to the debit for a simple vertical, larger for a broken-wing fly), so the corrected risk flows into the grade.
- **Degenerate spread wings are rejected.** When a spread's long and short legs on the same side collapse to the *same strike* (no further-OTM strike available — observed on an ASTS "iron condor" built sell-call \$100 / buy-call \$100, really a mislabeled put spread), the structure is now marked unavailable instead of presenting a phantom wing.

### Notes
- Ticker selection is unchanged (composite-driven). The corrected max-loss/max-profit do shift some lab **grades** (directional debit verticals up; broken-wing butterflies to an honest, lower reward/risk), but only the structure shown per already-selected pick — neutral on Brief Replay by construction, no FR-SEY-5 gate. The persisted 2026-06-16 brief still holds the old values; **a fresh brief run is needed for the corrected figures to appear.**

## [1.1.27] — 2026-06-16

### Changed
- **Directional strategies now de-prioritise narrow-range "pin bet" butterflies in favour of directional structures.** A put/call butterfly only pays off if the underlying lands in a tight window at expiry (low probability of profit), so it's a poor expression of a directional bullish/bearish thesis — yet because butterflies can post a high reward/risk score, the defined-risk preference (v1.1.25) was surfacing them as the recommended structure (e.g. 3 of 5 bearish picks on the 2026-06-16 brief). `pickRelevantStructure` now, for directional strategies (bullish/bearish/buy), prefers a directional structure over a butterfly — **but only when a reasonably graded (≥ C) directional alternative exists**; it keeps the butterfly when the only directional options are badly priced (D/F), so it never trades a viable structure for a broken one. On the 2026-06-16 bearish brief this switches LBRDK (put-butterfly A → poor-man's-covered-put B, directional) while correctly keeping ARE/FLUT's C butterflies (their only directional alternatives were grade F). No-op for income (range-bound — iron flies/condors are appropriate) and inflection/wheel.
- **Ticker selection is unchanged** (composite-driven, independent of the lab structure), so this is neutral on Brief Replay returns by construction — same picks, only the structure-per-pick differs. No FR-SEY-5 gate (verified on the live 2026-06-16 brief: only one pick's structure changed, no ticker/order change).

## [1.1.26] — 2026-06-16

### Fixed
- **Brief `valid_until` is now based on the ET calendar date and is DST-correct.** `nextTradingDayOpen()` had two date bugs. (1) It computed the next trading day from the **UTC** date of `generated_at`; for an evening-ET run (already "tomorrow" in UTC — e.g. a Monday 8:57pm EDT brief is `00:57Z` Tuesday) it skipped a trading day, so the brief was marked valid until Wednesday instead of Tuesday. It now keys off the **ET** calendar date. (2) It hardcoded 9:30 ET as `13:30Z`, which is correct only under EDT — all winter (EST) 9:30 ET is `14:30Z`, so `valid_until` was an hour early. It now derives the ET↔UTC offset for the target date. Cosmetic-only (affects the "valid until" label / auto-supersede timing, never pick data), surfaced while reviewing overnight-run behavior. Regression test: `tests/next-trading-day-open.test.ts` (+6: evening-ET no-skip, winter EST instant, weekend/holiday skips, host-TZ independence).

## [1.1.25] — 2026-06-16

### Changed
- **The Brief now prefers defined-risk structures over unbounded-risk ones when a viable alternative exists.** `pickRelevantStructure` partitions a strategy's relevant validated structures into defined-risk (finite `maxLoss`) vs unbounded (`maxLoss === null` — naked short call, strangle/straddle, reverse lizard) and presents the best **defined-risk** one, falling back to the unbounded set only when no capped-risk structure is viable. Real-money safety: the brief never *recommends* an unlimited-risk structure when a capped-risk alternative is on the table. On the 2026-06-16 brief this shifts **income** picks from short straddles/strangles to iron flies/condors (4 of 5; all still A+/B grade) and — combined with the v1.1.24 unbounded-maxLoss fix — **bearish** reverse-big-lizards to long put verticals. It is a **no-op for inflection/wheel/bullish/buy**, whose relevant structures are already all defined-risk (the v2 execution engine, inflection-only, is unaffected).
- **All four brief structure selectors are now unified on the shared `pickRelevantStructure` / `pickDisplayStructure`** (critic, advocate, `DailyBriefView`, `brief-report-builder`). Previously each had subtly different ad-hoc logic (first-relevant vs max-score vs first-valid), so the card, the email/PDF, and the critic could feature *different* structures for the same pick. Now the displayed structure always matches what the critic evaluated.

### Notes
- **Ticker selection is unchanged.** Composite scores (which tickers are picked and in what order) come from the scoring engine, independent of the lab structure/grade; this change only swaps *which structure* is shown per already-selected pick. Brief Replay outcomes are ticker-return-based and therefore unaffected — so this is neutral on the historical sample by construction (no FR-SEY-5 trade-selection delta to validate). Verified on the 2026-06-16 brief: same tickers, same order, only the structure-per-pick changed.

## [1.1.24] — 2026-06-16

### Fixed
- **Reverse Big Lizard / Reverse Jade Lizard now report their unbounded risk honestly.** These structures pair a short put *spread* with a **naked short call**, so the upside loss is unlimited. `buildSetup` mis-classified them into the bounded-risk branch and reported `maxLoss` as the small put-spread residual — e.g. FLUT's bearish #1-ish pick showed **max loss −$11.25** and an **annualized return of 100,248%** on a position that can lose without bound (LBRDK 15,154%, ARE a *positive* +$43.75 "max loss"). The P&L classifier now returns `maxLoss = null` (unbounded) for any naked-short-call structure, which cascades correctly: `annualizedReturn` becomes `null` (capital is undefined). The single-expiration P&L logic was extracted into a pure, exported `classifySingleExpiryPnl()` with direct unit coverage of every branch. **Ranking is unchanged** — the structure's `premiumScore` falls back to the short-put-strike capital basis (line 614–616), which yields the same score band, so this is a risk-display correctness fix, not a scoring change (no FR-SEY-5 gate). Found in the 2026-06-16 brief audit. See `docs/formulas.md#structure-pnl`.

## [1.1.23] — 2026-06-15

### Fixed
- **Critic is no longer structure-blind on inflection (the v2 launch strategy).** The critic's copy of the strategy→relevant-structure-slug map (`STRATEGY_RELEVANT_SLUGS` in `critic-service.ts`) had drifted from the brief job's and was **missing the `inflection` entry**. So `selectRelevantStructure()` returned null for every inflection pick: the LLM context carried *no structure*, the structure-aware rule checks (liquidity, grade) silently skipped, and the `if (strategy === 'inflection')` direction branch was dead code. With no structure, the critic invented a non-existent straddle and reasoned **backwards** — warning that high IV made options "severely overpriced" for *buying*, when the actual `short-put-vertical` *sells* premium (high IV is favorable). Found in the 2026-06-16 brief audit (AMD inflection critic literally said *"the absence of a `structure` field means no specific trade parameters exist to evaluate"*).
- **All four copies of the strategy→slug map are now one shared source of truth** (`src/shared/strategy-structures.ts`, imported by the critic, brief job, report builder, and `DailyBriefView`). This is the drift class that caused the bug above. `tests/strategy-structures.test.ts` asserts every `ScoringStrategy` is covered (the guarantee the critic lacked) and that `pickRelevantStructure` resolves an inflection structure.
- **The advocate (Stage-5 rationale) now describes the actual trade, not an invented one.** It previously received only ticker/strategy/score/signals — no structure — so it guessed the structure from the strategy name. For inflection it recommended "straddle sells / iron condors / directional calls" (the inverse of the real bull-put credit spread) and argued high IV was bad. It now gets a compact `structure` summary (type, credit-vs-debit with the IV implication spelled out, and legs) and is instructed to base the rationale on it and never suggest a different structure.
- **`counter_trend_itm_strike` critic flag no longer false-fires on bearish debit verticals.** The rule judged the first `sell` leg of the structure; for a `long-put-vertical` (a defined-risk *debit* spread) that leg is the lower short put, which correctly sits *below* spot. The rule mislabeled a 7–11% **OTM** short put as "at/in the money — zero cushion" (GPN, EL on the 2026-06-16 brief), and both critics burned their entire rationale rebutting the bad flag. The rule now evaluates only the rally-exposed **short call** (skipping structures without one), and the contradictory "(at/in the money)" wording is gone. Regression test added; existing counter-trend tests updated to model the short call explicitly.

## [1.1.22] — 2026-06-15

### Fixed
- **Morning Briefing market regime now reads the real VIX.** `BriefingService.getMarketRegime()` fetched VIX via `dataProvider.getQuote('VIX')` — Polygon's *stocks* snapshot, which can't serve an index, so it always returned null (and burned a rate-limited API call each call). It now reads VIX from `quote_cache`, where the brief job's `refreshVixQuote()` writes the E*Trade-sourced value (v1.1.21). So the dashboard's `vixValue`/`vixLevel` and regime summary reflect the actual VIX, consistently with the critic. Completes the VIX migration — both consumers now use one E*Trade-sourced value. Regression test: `briefing-service.test.ts` (+3; asserts `getQuote('VIX')` is never called and the level is classified from `quote_cache`).

## [1.1.21] — 2026-06-15

### Added
- **VIX is now wired into the critic's macro context (E*Trade).** Follow-up to the v1.1.20 audit's documented VIX gap. The brief job's new `refreshVixQuote()` fetches VIX via E*Trade `/v1/market/quote/VIX` (`getETradeLastPrice` in `etrade-options.ts`), sane-range-validates it (`[5,150]` — a quote typo can return an unrelated symbol), and upserts it into `quote_cache` (ticker `'VIX'`) before the critic stage runs; `CriticService.getMarketContext()` reads it there. This re-activates the two previously-dormant VIX rules (wheel/income caution at VIX>30, bearish complacency at VIX<14) and fills the macro "fear/complacency regime" context. **Fail-closed at every step** — no E*Trade creds, fetch error, out-of-range value, or wrong account index symbol leaves `quote_cache` untouched and the critic keeps its safe null-VIX behavior. The fetched value is surfaced in `runMeta.vix` so the operator can verify it against the real VIX on the first run (**the E*Trade index symbol `'VIX'` is unverified offline**). Tests: `critic-service.test.ts` (+3: reads populated VIX, wheel fear rule fires at VIX>30, dormant when null).

### Verified (no change needed)
- **The advocate rationale does not fabricate volatility.** Audited all 30 picks (`scripts/advocate-rationale-audit.mjs`): every number the advocate cites maps to a real scoring signal it was given (`0/30` cite a vol figure without an IV/vol signal). This also explains the v1.1.20 critic "140.8% IV": that's the wheel `recentVolatility` **signal** (140.8, realized vol), which the advocate correctly labels "recent volatility 140.8" — the **critic** received it via `advocateRationale` and mislabeled it as *implied* volatility. The v1.1.20 F1 fix (real `impliedVolPct` + forbid inventing/relabeling vol) addresses exactly that conflation.

### Note
- `briefing-service.getQuote('VIX')` (a separate market-summary consumer) still uses the broken Polygon stocks-snapshot path and is **not** migrated to read `quote_cache` — left as a follow-up.

## [1.1.20] — 2026-06-15

### Fixed — daily-brief accuracy audit (pre-real-money)
- **Critic no longer fabricates volatility figures.** The critic's LLM context carried **no** implied- or realized-vol field, yet its system prompt instructed the model to compute an "expected 1-sigma move (annualized vol / sqrt(365/dte))." With nothing to anchor to, the model **invented** precise vol numbers shown to the user as risk rationale (e.g. MRVL wheel cited "140.8% implied volatility" against the true 104.7% ATM IV; RKLB "~108% realized," ASTS "~139%"). Now `extractVolatilityContext()` feeds the real `{ impliedVolPct, ivRank }` from the lab context, the prompt uses that field for all expected-move reasoning, and it **forbids** citing any volatility figure not provided (null → "could not be measured"). Rationale-accuracy only — no change to which trades are taken. Tests: `critic-service.test.ts` (+3).
- **Breakeven-distance is now strike-aware.** `breakevenDistancePct` was `|netCredit| / price`, which equals the breakeven distance only for an **at-the-money short straddle**; for short strangles, iron condors, and OTM-strike CSPs the short strikes sit away from spot, so it understated the true breakeven ~10× (MRVL iron condor read **2.3%** vs the real **~28%**) and made the critic falsely flag structurally-wide condors `thin_breakeven`. Replaced with an exported pure `breakevenDistancePct(legs, netCredit, price)` that computes the distance to the nearest `shortStrike ± credit` using only the short legs (long wings cap loss, not breakeven). Fixes both the LLM context value (income) and the `thin_breakeven` rule (income/wheel). Tests: `critic-service.test.ts` (+8); `docs/formulas.md#breakeven-distance` rewritten.
- **Brief diagnostic `scripts/brief-deep-dive.mjs` repaired.** The script used to vet a brief before relying on it was itself unreliable: it crashed on a stale `analysis_snapshots` schema, printed `undefined` in its verdict summary (read `f.rule`; flags carry `f.key`), displayed `scores[0]` (the overall top structure) instead of the strategy-relevant one — which made bearish picks *look* like they had bullish structures — and omitted the 6th `inflection` strategy entirely. Now shows the actual presented structure, includes all six strategies, fixes the freshness query (`technical_signals`), and adds a "no relevant structure" anomaly check.

### Known gap (documented, not yet fixed)
- **VIX is always null** in the critic's macro context. Nothing writes a `'VIX'` row to `quote_cache`, and the only fetch hits Polygon's *stocks* snapshot for ticker `VIX` (an index = `I:VIX`, an Indices-plan ticker the Stocks Starter plan lacks). The macro context is SPY-trend-only and the two VIX critic rules (wheel/income VIX>30, bearish VIX<14) are dormant — fail-safe (null → rules skip). A real fix needs a verified index-quote source (E*Trade `/market/quote` or a Polygon Indices plan) and is deferred until live-verifiable. Documented in `CLAUDE.md` Known quirks + `.ai/AI_CONTEXT.md §10`.

### Not changed (validated, deliberately left alone)
- Bearish picks can surface on stocks in short-term uptrends (lab `directionBias: bullish`, `trend: Sideways/Bullish`) driven by fundamental-weakness + the `rsiOverbought` signal saturating below RSI 70. This is a **validated** characteristic of the bearish ≥70 composite (real short edge on full-year replay), an overbought guard was already tested and **rejected** on the same sample (FR-SEY-5), and the critic surfaces the risk (`elevated_market_risk`, `counter_trend_itm_strike`). Not re-engineered.

## [1.1.19] — 2026-06-15

### Fixed
- **Premium-history wheel rows now label covered-call fallbacks as `CC`, not `CSP`.** The wheel analysis (`findSuitableChain`) recommends a cash-secured put when one exists in the 0.20–0.30 delta band, and otherwise **falls back to a covered call** in the same band (intended behavior — both are valid wheel legs). But `wheelResultToRow` hardcoded `structure: 'CSP'`, so ~12% of daily wheel picks (the CC fallbacks, concentrated in lower-priced names whose coarse strike grid has no put in the tight band — e.g. AA, ACGL) were recorded as `CSP` in `options_premium_history`. That would corrupt the future CSP-vs-CC return-on-capital analysis the table exists to enable. The structure is now derived from **delta sign** (put ≤ 0 → `CSP`, call > 0 → `CC`; null delta → `CSP`) — robust because sign is fixed by option type, surviving E*Trade's stale-greek magnitude drift, and `findSuitableChain` guarantees a non-null delta on any real recommendation. No trade-logic change: the recommendation itself is untouched, only its recorded label. Self-heals already-persisted rows on the next capture. Regression tests in `tests/options-premium-history.test.ts` (+2: positive-delta → CC, null-delta → CSP). `docs/formulas.md#wheel-structure-label`.

## [1.1.18] — 2026-06-14

### Fixed
- **🤝 Execution views now scroll — the Execution Settings Save button was unreachable.** `.main` is `overflow: hidden`, so each view must manage its own scroll; the Trading Desk and Execution Settings root divs didn't, so on shorter windows the tall Settings form (and its Save/Revert buttons) was clipped with no scrollbar. Both view roots now fill and scroll (`flex: 1; min-height: 0; overflow-y: auto`) — same pattern as the v1.1.11 sidebar fix. CSS-only; no testable unit.

## [1.1.17] — 2026-06-14

### Added
- **v2 execution — inflection-direction guard (FR-SEY-3 follow-up, execution layer).** Completes the "both, configurable" rollout: the execution engine now also refuses to propose the validated-losing inflection side. Migration **051** adds `exec_config.inflection_direction` (`'up'` default / `'down'` / `'both'`, CHECK-constrained). `EntryPolicy.filterPick` rejects an inflection pick whose breakout direction isn't allowed (`short-put-vertical` = up, `short-call-vertical` = down) with reason `inflection_direction`. Mapped in `RiskGovernor` config; editable in 🤝 Execution Settings → Mode. So whether picks come from the brief (app `inflectionDirection` setting) or the engine's own entry policy (`exec_config`), the same up-only-by-default policy holds. Tests: `entry-policy.test.ts` (+2: default rejects down, `'both'` accepts). Full suite 459 green.

## [1.1.16] — 2026-06-14

### Changed
- **Inflection is now up-breakout-only by default (configurable) — strategy layer.** The FR-SEY-3 follow-up validated (on authoritative `simulateSingleSpread` P&L) that down-breakout/bear-call inflection is a net loser (−1.4%/trade) while up-breakout/bull-put is solidly profitable (+6.1%, 76% win). A new **`inflectionDirection`** app setting (`'up'` default / `'down'` / `'both'`) gates which breakout sides the scoring engine surfaces: `ScoringService.hasBreakout` honours it, so both the **Daily Brief** and **Brief Replay** (both score via `scoreFromSignalData`) stop recommending the losing bear-call side. Set it in **⚙ Settings → General**. Refreshed once per scoring pass (runtime changes apply without restart). Wired through `AppSettings` + `settings:get-all/set-all`. Regression tests in `tests/inflection-scoring.test.ts` (default gates down to 0; `'both'` re-enables; `'down'` gates up to 0). Full suite 457 green. (Execution-engine guard for the same setting lands next.)

## [1.1.15] — 2026-06-14

### Added
- **v2 execution — FR-SEY-1: sector-concentration cap (Seykota diversification).** Caps concurrent open positions sharing a correlation bucket so "five semiconductor spreads" count as one bet, not five — a gap the count caps (5 concurrent, 1/ticker) couldn't see. Bucket = SPDR sector ETF, derived from `fundamentals_cache` via `sectorStringToEtf` (coarse enough that "semiconductors" and "electronic computers" both map to XLK); unmapped names stay uncapped. **Default OFF** (`maxPositionsPerSector = null`). Migration **050** adds `exec_config.max_positions_per_sector`. New pure `per_sector` check in `evaluateGate` (skipped when off); `risk-governor` resolves sectors from `fundamentals_cache` only when the cap is enabled. Extracted the sector→ETF mapper into a shared `src/main/services/sector-etf.ts` (was private in `scoring-service.ts`) so both the scorer and the governor use one source. Exposed in Execution Settings → Risk limits. Tests: `risk-gate.test.ts` (+2) and `risk-governor.test.ts` (+3); full suite 455 green. Ships disabled by default per FR-SEY-5 (a conservative concentration limit, not an edge claim).

## [1.1.14] — 2026-06-14

### Added
- **v2 execution — FR-SEY-2: drawdown-scaled risk (Seykota "equity-curve money management").** The risk governor now tracks a **closed-equity high-water mark** and, when drawdown from it reaches `drawdownThrottlePct`, multiplies the effective per-trade risk by `drawdownThrottleFactor` (e.g. 0.5 = half size) until the curve recovers — a graduated step between "normal" and the binary daily kill switch. **Default OFF** (`drawdownThrottlePct = 0`), so behaviour is unchanged until the operator opts in (Execution Settings → Risk limits). Migration **049** adds `exec_config.drawdown_throttle_pct`/`_factor` and `exec_risk_state.equity_high_water` (seeded to the ceiling, ratchets up only). Pure helper `drawdownThrottleFactor()` in `risk-gate.ts`; the gate's `per_trade_risk` check uses a new optional `effectiveMaxRiskPct`; `risk-governor` computes drawdown (closed-equity, to avoid unrealized-swing thrash), applies the throttle in `sizeEntry` + `checkEntry`, and exposes `drawdownPct` on the engine state view. The Trading Desk shows drawdown + HWM + throttle status. Tests: `risk-gate.test.ts` (+5) and `risk-governor.test.ts` (+4); full suite 450 green. Per FR-SEY-5 it ships **disabled by default** (a conservative size-reducer, not an edge claim — enabling is the operator's risk choice).

## [1.1.13] — 2026-06-14

### Changed
- **Moved 🔔 Alerts into the 🗂️ Misc landing screen.** Alerts was a standalone button under the Personal section; it's now a card on the Misc screen alongside Backtest / Test API / Data Sync / History, further trimming the sidebar. The 🗂️ Misc button highlights while Alerts (or any other Misc tool) is open. AlertsView and its IPC are unchanged.

## [1.1.12] — 2026-06-14

### Changed
- **Decluttered the sidebar: the Misc section is now a single 🗂️ Misc entry** that opens a landing screen with the four occasional tools as cards — **Backtest**, **Test API**, **Data Sync**, **History** (`src/renderer/src/views/MiscView.tsx`). Selecting one pushes it onto the nav stack, so a **← Back** returns to the Misc screen. The Misc sidebar button highlights while any of those four views is open. No functionality removed — the views and their IPC are unchanged; only the navigation path changed.

## [1.1.11] — 2026-06-14

### Fixed
- **Sidebar now scrolls when the menu is taller than the window.** The nav lives in a single `.nav-section` inside `.sidebar` (which is `overflow: hidden`), so on shorter windows the bottom items (Misc → History, and the new Execution section) were clipped and unreachable. `.nav-section` now fills the sidebar and scrolls (`flex: 1; min-height: 0; overflow-y: auto`) — `min-height: 0` lets the flex child shrink below its content height so the overflow scrolls instead of clipping. CSS-only; no testable unit (visual layout fix).

## [1.1.10] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 5c/d (control panel UI), completing Phase 5.** New **🤝 Execution** sidebar section with two Electron views, both driving the (mock-backed) engine through `window.api.execution.*`. **Trading Desk** (`src/renderer/src/views/TradingDeskView.tsx`): master header with PAPER/LIVE badge + engine-state pill; Engine panel (Start/Pause/Stop — master Stop = hard stop — + broker/health/last-cycle); Kill Switch panel (status + Trip/Clear); Capital panel (deployed-vs-ceiling gauge, day P&L, trip threshold); proposals queue with Approve/Reject (**paper = 1-click, live = type-to-confirm**); open-positions table; activity log off the audit trail. Live-updates via `execution:event` + a 15 s poll fallback. **Execution Settings** (`src/renderer/src/views/ExecutionSettingsView.tsx`): an editor over the `exec_config` row (`getConfig`/`updateConfig`) grouped into Mode / Risk limits / Entry policy / Exit policy, with dirty-tracking, Save/Revert, and a confirmation gate on switching to live mode. `src/renderer/src/App.tsx` adds the section, `View` union entries, and `renderEntry` cases. No new automated tests (renderer views; underlying engine/IPC already covered — full suite green, 441). No auto-generated entries yet (brief→`PickInput` lands with Phase 6); the desk otherwise reflects live engine state. The product is now demonstrable end-to-end without IBKR.

## [1.1.9] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 5b (activation).** The first **non-dormant** step: `ExecutionEngine` is now instantiated in `src/main/index.ts` against the deterministic `MockExecutionBroker` and starts `stopped` (constructing it opens no broker connection and places no orders), and its event stream is forwarded to the renderer (`webContents.send('execution:event', …)`). New `src/main/ipc/ipc-execution.ts` (`registerExecutionIpc`) exposes the engine facade as a thin pass-through — reads (`execution:get-state`/`:get-config`/`:get-risk-state`/`:get-positions`/`:get-proposals`/`:get-audit`), config (`:update-config`), control (`:start`/`:stop`/`:pause`, `:kill-trip`/`:kill-clear`), and approvals (`:approve-proposal` routing entry→order-manager, exit→management; `:reject-proposal`). New `window.api.execution.*` preload namespace (34th) mirrors it, with `onEvent(cb)` subscribing to the live event stream. New renderer-facing facade types in `src/shared/types.ts` (`ExecEngineStateView`, `ExecEngineHealth`, `ExecEngineEvent`, `ExecPositionRow`, `ExecProposalRow`, `ExecAuditRow`, `ExecApproveResult`, `ExecStartResult`). No new tests — the facade is covered by `tests/execution-engine.test.ts` and the IPC layer is a pure pass-through; full suite green (441). The Electron Trading Desk / Settings UI lands next (Phase 5c/d); live auto-entries (brief→`PickInput`) land with the IBKR adapter (Phase 6).

## [1.1.8] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 5a (engine assembly).** `src/main/execution/execution-engine.ts` (`ExecutionEngine`) wires the whole subsystem into one object: governor, order manager, entry/exit policy, management loop, and the headless core — with the management loop bound to the core's market-cycle hook (so each market-open cycle evaluates exits and acts). The broker is **injected**, so the same assembly runs the `MockExecutionBroker` (tests/dev) or the IBKR adapter (Phase 6) with no code change. Exposes the small facade the IPC/control-API layers will call: lifecycle (`startEngine`/`stopEngine`/`pauseEngine`/kill-switch), `generateEntries`, approval routing (`approveProposal` dispatches entry→order-manager / exit→management; `rejectProposal`), and reads (`getState`/`getConfig`/`updateConfig`/`getRiskState`/`getPositions`/`getProposals`/`getAudit`). Constructing it is inert — engine starts `stopped`, no broker connection, no orders. `tests/execution-engine.test.ts` (6): start, generate→approve→open, the full open→mark-moves→protective-stop-close loop, discretionary exit-proposal approval routing, reject, config/risk reads. Still dormant — **not yet instantiated in the app.**

## [1.1.7] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 4c (exit policy), completing Phase 4.** The position-management half of the trade logic. Migration **048** adds the configurable exit rules to `exec_config` (`stop_multiple` 2×, `defensive_dte` 2, `profit_target_pct` 50, `hold_days` 5, `time_exit_dte`, plus `profit_target_mode`/`time_exit_mode` propose|auto) and `exec_proposals.position_id`/`close_reason` (for exit proposals). `src/main/execution/exit-policy.ts` (`ExitPolicy.evaluate`, pure): priority-ordered rules — **protective** stop (loss ≥ 2× credit) and defensive-expiry close (auto, §0.3 invariant), then **discretionary** profit-target (≤ 50% of credit) and planned/time exit. `src/main/execution/position-manager.ts` (`ManagementLoop`): each cycle evaluates every open position and acts — protective → auto `submitClose`; discretionary → auto-close if the mode is `auto`, else raise an exit proposal (one pending per position); `approveExitProposal` closes on approval. Tests: `tests/exit-policy.test.ts` (9, every rule + priority + unpriced) and `tests/position-manager.test.ts` (6, protective auto-close, discretionary propose/auto, no-dup, no-trigger, approve-exit). Still dormant — wired to nothing yet; the engine assembly + brief→pick source land with the IBKR integration.

## [1.1.6] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 4b (order manager).** The bridge between proposals/exits and the broker. Migration **047** adds `exec_orders.position_id` (links an order to the position it opens/closes). `src/main/execution/order-manager.ts` (`OrderManager`): `approveProposal` re-runs the pre-trade gate at submission (§2.5), mints a client order id and persists the order row **before** the broker send (idempotency, §2.8), then submits an open combo order; broker status/fill callbacks drive the order state machine and **open an `exec_positions` row** on fill (recomputing deployed capital). `submitClose` reverses the position's legs into a close order, marking the position `closing → closed` with its `close_reason` on fill. Fills are de-duplicated by broker exec id; expired/already-approved proposals and gate failures are rejected with reasons; everything is audited (`proposal_approved`, `order_submitted`, `fill`, `position_opened`, `position_closed`). `tests/order-manager.test.ts` (6): full approve→fill→position, not-pending, expired, gate-recheck reject, close→freed capital, already-closed. Still dormant — wired to nothing yet.

## [1.1.5] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 4a (entry policy).** The first half of the trade logic: turning eligible brief picks into priced, risk-gated proposals awaiting approval. Migration **046** adds the configurable entry-policy columns to `exec_config` (`min_composite_score` 70, `max_new_entries_per_day` 1, `max_new_entries_per_week` 3, `avoid_earnings_before_expiry`, `entry_window_start`/`_end` 10:00–15:00 ET, `reprice_tolerance_pct`), surfaced through `ExecConfig` + the governor. `src/main/execution/entry-policy.ts` (`EntryPolicy`, on a normalized `PickInput` so it's decoupled from v1 brief internals): `filterPick` (eligible strategy · critic pass/caution · composite ≥ floor · liquidity · earnings · entry window), `buildProposal` (price the combo at the venue → size via the governor → run the pre-trade gate → persist a pending `exec_proposals` row with shelf-life, audited), and `generateEntries` (daily/weekly caps, highest-composite first). Helpers `etMinutesOfDay`/`hhmmToMinutes` added to `market-hours.ts`. Tests: `tests/entry-policy.test.ts` (14). Still dormant — wired to nothing yet.

## [1.1.4] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 3b (control API + SSE), completing Phase 3.** `src/main/execution/control-api.ts` (`ExecutionControlApi`): a Fastify server on `127.0.0.1:7433` — separate from the v1 agent API (`:7432`) so it's reachable when the app window is closed — that wraps the `ExecutionCore` + `RiskGovernor`. Token-authed via `X-Agent-Token` (reuses `~/.tradeanalyzer/agent.token`), with a public `/exec/health` probe. Routes: engine control (`POST /exec/engine/start|stop|pause`, `POST /exec/kill-switch/trip|clear`), reads (`GET /exec/state|config|risk|positions|audit`), the zero-latency `POST /exec/brief-ready` handoff (audits + invokes an optional Phase-4 `onBriefReady` hook), and an SSE stream `GET /exec/events` of the core's engine-state/cycle/health/reconcile events. `tests/control-api.test.ts` (9 tests, via `fastify.inject`): auth gating, state, engine start/pause/stop, pause-409, kill trip/clear, config/risk/positions/audit reads, brief-ready hook, SSE frame formatting. Still dormant — wired to nothing yet.

## [1.1.3] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 3a (headless core runtime).** The always-on engine that ties the governor + broker together (control API/SSE follow in 3b). `src/main/execution/market-hours.ts`: a DST-correct US RTH gate (`isMarketOpen`, Mon–Fri 09:30–16:00 ET via `Intl`, configurable holidays) + `etDateString` (ET date for the day-P&L anchor). `src/main/execution/reconciliation.ts`: `reconcile()` — the broker is the source of truth; syncs order status + position marks into `exec_*` and detects drift (positions the broker holds that the core doesn't, and vice-versa), plus `markNeedsAttention()`. `src/main/execution/execution-core.ts` (`ExecutionCore`): owns the broker + governor and runs the management cycle — **cold-start reconcile-before-act** (refuses to start on drift, flags the positions), a per-cycle flow that **fails closed** on a disconnected broker and **trips the kill switch** on drift, only invokes the entry/exit policy hook while the market is open (the hook is filled in Phase 4), a health watchdog (broker-disconnected / stale-cycle), and an event stream for the SSE layer. Tests: `tests/market-hours.test.ts` (7), `tests/reconciliation.test.ts` (5), `tests/execution-core.test.ts` (11). Still dormant — wired to nothing yet.

## [1.1.2] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 2 (risk governor, the safety core).** Added the fail-closed risk layer that no order may bypass, split into a pure decision layer and a stateful service. `src/main/execution/risk-gate.ts` (pure, no I/O): `sizePosition()` (contracts = floor(per-trade-risk / max-loss), capped by remaining deployable capital) and `evaluateGate()` — the ordered 10-check pre-trade gate (engine running · broker connected · defined-risk & eligible strategy · per-trade risk · max concurrent · per-ticker · per-strategy · capital ceiling · buying power · daily-loss headroom), first failure supplies the reject reason. `src/main/execution/risk-governor.ts` (`RiskGovernor`, DB-backed): the single source of risk truth — reads/writes `exec_config` + `exec_risk_state`, the engine state machine (`start`/`stop`/`pause`/`tripKillSwitch`/`clearKillSwitch` with validated transitions — can't start while kill-tripped, manual clear only), day-P&L accounting that auto-trips the kill switch at the configured % loss (realized + unrealized, resets at session anchor), deployed-capital recompute, COID minting, and the append-only audit log; every state change commits atomically with its audit entry. `checkEntry()` assembles a context from the DB + broker and runs the pure gate. Tests: `tests/risk-gate.test.ts` (17) + `tests/risk-governor.test.ts` (18). Still dormant — wired to nothing yet.

## [1.1.1] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 1 (broker seam + mock).** Added the `ExecutionBroker` interface (`src/main/execution/execution-broker.ts`) — the abstraction over the venue that prices, places, and fills orders, so the engine never depends on a concrete broker (paper vs live becomes a config of the IBKR implementation, not a code branch). Added `MockExecutionBroker` (`src/main/execution/mock-execution-broker.ts`): a deterministic, fully controllable in-memory broker (configurable pricing, fills full/partial/reject/manual, connection state, buying power, marks) that lets the entire engine — risk governor, loops, control panel — be built and tested with **no IBKR account**. It is idempotent on `clientOrderId` (a repeated COID never duplicates an order) and matches closing orders to their opening position regardless of leg direction. `tests/mock-execution-broker.test.ts` (12 tests) pins the contract: pricing, auto/manual/partial/reject fills, idempotency, fail-closed-when-disconnected, position open/close, marks, cancel. Still dormant — wired to nothing yet.

## [1.1.0] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 0 (schema foundation).** First increment toward automated trade execution (full requirements in `Requirements/v2-execution/`). Migration **045** creates the seven namespaced `exec_*` tables — `exec_config`, `exec_risk_state`, `exec_proposals`, `exec_orders`, `exec_fills`, `exec_positions`, and the append-only `exec_audit_log` — and seeds the singleton config + risk-state rows with the locked v2.0 defaults ($10k ceiling · 5% max-risk/trade · 5 concurrent · 10% daily-loss trip · 1 position/ticker · inflection-only · engine `stopped`). Added the `Exec*` domain types to `src/shared/types.ts` and `tests/exec-schema.test.ts` (table presence, seeded defaults, single-row + enum CHECK constraints, idempotent seeding, COID uniqueness). **The tables are dormant** — created and seeded but not yet wired to any service or UI; the headless execution core, risk governor, loops, and control panel come in later phases. No behavior change to the existing app.

## [1.0.0] — 2026-06-14

### Milestone
- **v1.0.0 — the decision-support app is feature-complete.** This release draws the line under v1: watchlists, screener, five-mode analysis, the configurable scoring engine, the daily AI intelligence brief + critic, Brief Replay, validation dashboards, multi-leg payoff modeling, E\*Trade-synced portfolio tracking, LEAPS+CSP / collared-LEAPS screeners, earnings calendar, News & Research, the Agent overhaul, and backtesting — all shipped and verified against the v1 spec (`Requirements/spec/`). The app remains **read-only at the broker** by design: it analyzes, recommends, and validates, but never places an order.
- **Next phase is v2: automated execution.** Work begins on a headless execution core (semi-auto, approve-each), trading a segregated IBKR account in paper first, then real capital under hard risk limits. This is a new subsystem with its own requirement set — see the new execution spec section and `.ai/AI_CONTEXT.md §11`. No behavior change in this release; it is the version marker that separates decision-support (v1) from execution (v2).

## [0.34.10] — 2026-06-14

### Added
- **💰 dollar P&L for directional strategies (buy / bullish / bearish)** — the Brief Replay summary's 💰 button now appears on the three directional rows too, so you can compare **buy vs bullish dollar-to-dollar**. These aren't premium structures, so instead of an option sim they run a **fixed-notional stock position**: $10,000 deployed per pick (long for buy/bullish, **short for bearish**), marked at the replay's 21-day forward close. Every pick uses the same $10k, so Total P&L is directly comparable between buy and bullish; the modal notes the premium strategies above use a different capital base (option collateral), so those are compared by ROC, not headline dollars. `AggregatePickBacktest.structure` gains `'stock'`; new `notionalPerTrade` field. The modal labels, subtitle, chart caption, and footnote adapt to the stock structure (ROC → "return").

## [0.34.9] — 2026-06-13

### Added
- **💰 aggregate backtest now covers Inflection (directional credit spread)** — the Brief Replay summary's 💰 button now appears on the **inflection** row too, not just wheel/income. Because inflection is a directional credit spread (not a CSP), it runs a new `simulateSingleSpread`: a **bull put spread** for up-breakouts / **bear call spread** for down-breakouts (sell ~0.30Δ, buy 0.15Δ — mirroring the live `short-put-vertical`/`short-call-vertical`), per pick, IV-priced, **defined-risk** (return on max-loss capital, each loss capped at the spread width). The modal labels and footnote adapt to the credit-spread structure. `AggregatePickBacktest` gains a `structure` ('csp' | 'credit-spread') field.

## [0.34.8] — 2026-06-13

### Fixed
- **💰 aggregate backtest: dollar-based equity curve + drawdown (was misleading)** — the modal previously showed a "Cumulative ROC" that summed per-trade *percentages* across all trades (e.g. +407%) and a "Max drawdown" of −158% — dimensionally meaningless (you can't draw down 158% of capital). The equity curve is now **cumulative realized dollar P&L** (ending exactly at Total P&L), and **Max drawdown is a real dollar figure** (largest peak-to-trough drop). The line turns red when the strategy is net-negative. Added an explanatory note for the common case of a **high win rate but net dollar loss** — the short-premium asymmetry (many small premium wins, a few large assignment losses; avg ROC is equal-weight per trade while Total P&L is collateral-weighted, so they legitimately diverge). Type: `AggregatePickBacktest.equityCurve[].cumReturnPct → cumPnl`, `maxDrawdownPct → maxDrawdownPnl`.

## [0.34.7] — 2026-06-13

### Added
- **💰 aggregate CSP backtest shows dollar P&L** — the "CSP backtest over every pick" modal now displays **Total P&L** ($) and **Avg $/trade** alongside the ROC metrics (the backend already computed `totalPnl`; it just wasn't surfaced). Total P&L = sum of one CSP contract (100 shares) per pick.

## [0.34.6] — 2026-06-13

### Changed
- **Backtest auto-runs when opened from a deep-link** — landing on Backtest via the 🔁 action (My Stocks / Brief picks) now runs the backtest automatically with the pre-filled ticker + strategy, instead of waiting for a manual "Run" click. It waits for IV coverage to load first so the start date defaults to the IV-accurate range, then kicks off. Manually opening the Backtest view still shows the form for you to fill in.

## [0.34.5] — 2026-06-13

### Changed
- **Backtest: dropped the Starting Capital input** — the field is gone; the engine auto-sizes the capital base to exactly one contract (`max spot × 100`) and reports metrics as return on the capital one contract ties up. This also **removes the capital gate** entirely, so high-priced stocks (META, etc.) just run — no more flat-zero curve and no need for the "raise capital" error added in v0.34.4. (`starting_capital` stays in the schema for back-compat but is unused.)
- **Backtest trade log is now sortable** — click any column header to sort (toggles asc/desc; nulls last). Defaults to **entry date, descending** (most recent trades first).

## [0.34.4] — 2026-06-13

### Fixed
- **Backtest no longer silently returns a flat-zero curve when capital is too small** — a CSP/Wheel backtest on a high-priced stock (e.g. META ~$645 → ~$60k collateral) with the default $25k starting capital could never open a position, producing a flat equity curve and all-zero metrics with no explanation. The engine now throws a clear error: *"No trades: starting capital ($25,000) is below the ~$60,000 collateral a 0.30-delta CSP needs for META. Raise Starting Capital."* (Also covers the no-premium/insufficient-data case.) Note: the aggregate 💰 P&L backtest is unaffected — it's per-trade ROC, not capital-constrained.

## [0.34.3] — 2026-06-13

### Added
- **Backtest trade log shows the underlying stock price at entry & exit** — new **Stk@Entry** and **Stk@Exit** columns (migration 044 adds `backtest_trades.entry_spot` / `exit_spot`, populated by the engine from the simulated spot at open and close). Makes each trade readable — you can see where the stock sat relative to the strike. Existing runs show "—" for these until re-run.

## [0.34.2] — 2026-06-13

### Added
- **Backtest trade log shows exit price** — the trade table now has an **Exit Px** column (the option's settlement/buyback price per share at close: the closing mid on a profit/stop exit, intrinsic on assignment, 0 on a worthless expiry). The entry premium column is relabeled **Entry Px** for symmetry. (No data change — `exitPremium` was already captured per trade.)

## [0.34.1] — 2026-06-13

### Added
- **Backtest form guides toward IV-accurate start dates** — the New Backtest form now defaults its start date to the oldest date in `iv_history` (when available) and sets that as the date input's `min`, so backtests are IV-priced by default. If a start date earlier than IV coverage is chosen, an inline ⚠ warning explains that earlier dates are priced from realized vol (not implied vol) and offers a one-click "Use {date}". When the start is within coverage, a "✓ IV-priced" hint confirms it. `BacktestEngine.ivHistoryStart()` + IPC `backtest:iv-coverage`. (IV history currently begins 2025-05-29 — ~1 year — so older backtests were silently realized-vol priced.)

## [0.34.0] — 2026-06-13

### Added
- **Aggregate "backtest my picks" in Brief Replay (integration phase 2 of 2)** — the summary table's new **💰 P&L** button (on the wheel & income rows) simulates a cash-secured put on **every** historical Brief-Replay pick for that strategy and pools the results into one view: trade count, win rate, avg/median return-on-capital, cumulative ROC, max drawdown, avg days held, and an **equity curve** (cumulative ROC by exit date). This answers *"if I'd traded every wheel/income pick, what would they have actually returned?"* — using **real option P&L** (Black-Scholes from historical price + IV), not the stock-move proxy the summary columns show. `BacktestEngine.backtestReplayPicks(strategy)`; IPC `backtest:replay-picks`. Each pick is one 0.30-delta / 30-DTE CSP with 50%-profit / 200%-stop exits; equal-weight, capital unconstrained. Completes the backtest integration begun in v0.33.7.

## [0.33.8] — 2026-06-13

### Changed
- **Backtest engine prices off historical implied volatility** — the simulator now uses `iv_history` ATM IV (as-of the entry date) for its Black-Scholes volatility input, falling back to 20-day realized vol only when no IV history exists. Previously it always used realized vol, which understated the premium a CSP/CC/Wheel actually collects (sellers are paid IV, which runs above realized — the variance risk premium). The same `sigma` drives strike selection, entry premium, and daily mark-to-market. See `docs/formulas.md#backtest-iv`.

## [0.33.7] — 2026-06-13

### Added
- **Backtest deep-link from recommendations (integration phase 1 of 2)** — a "🔁 Backtest" action now appears on **My Stocks** rows (every stock → pre-fills a CSP) and on **Daily Brief** wheel/income pick cards (wheel → Wheel, income → CSP), opening the Backtest view pre-filled with the ticker + strategy. No more manual one-stock data entry to test a recommendation. (Backtest only appears where its engine applies — premium-selling strategies; buy/bullish/bearish/inflection brief picks don't show it.) New `navigate-to-backtest` event; `BacktestView` accepts `initialTicker`/`initialStrategy`. Phase 2 (aggregate "backtest all my picks" with one equity curve) is next.

## [0.33.6] — 2026-06-13

### Fixed
- **My Stocks email: header/data column alignment** — the email table's header cells were all left-aligned while the numeric data cells were right-aligned, so headers didn't line up over their columns. Header and data alignment are now driven by a single per-column definition (numeric columns right, text columns left, flag centered).

## [0.33.5] — 2026-06-13

### Added
- **My Stocks: "in play" flag** — each stock in the conviction list has an on/off 🚩 flag (migration 043 adds `conviction_stocks.in_play`) to mark stocks you want to pay attention to / may act on. Toggle it from a new flag column in the table (flagged rows are highlighted and counted in the header). It's a transient marker — toggling does **not** write a band-history snapshot.
- **My Stocks: email the list** — a new "✉ Email My Stocks" button sends the list (via the existing SMTP/email config) as an HTML table including the 🚩 flag, sorted in-play first then by zone. The **Actions** column is omitted (UI-only, no information). The button is disabled with a tooltip when email isn't configured. New IPC: `conviction:set-in-play`, `conviction:send-email`, `conviction:email-configured`.

## [0.33.4] — 2026-06-13

### Changed
- **Daily Brief & email/PDF: strategy sections now ordered by the day's top composite score** — instead of a fixed sequence, the strategy with the highest-scoring single pick that day appears first, then descending. The previous fixed order (wheel→bullish→bearish→income→buy→inflection) is the tiebreaker and orders strategies with no picks last. Applied consistently to the on-screen brief, the HTML email, and the PDF (shared `orderByTopComposite`). Note: composite scores are strategy-specific (different signals/weights per strategy), so this is a surfacing heuristic — it floats the strongest-scored pick to the top, not a cross-strategy quality ranking (the score-badge tooltip already flags this). Also fixed the PDF cover's hardcoded "across 5 strategies" → actual count.

## [0.33.3] — 2026-06-13

### Changed
- **Brief Replay Score-Signal tab now shows all strategies** — the score-quintile and pick-rank charts were hardcoded to curated 3-strategy subsets (buy·bullish·bearish / buy·bullish·wheel), so inflection (and income/wheel) didn't appear. Both charts now render every strategy in the chart payload, driven by `data.strategies` with a per-strategy color fallback. Inflection's bars use its direction-adjusted 21d return.

## [0.33.2] — 2026-06-13

### Fixed
- **Brief Replay charts now include the Inflection strategy** — the Monthly hit-rate chart (labeled "all strategies") used a hardcoded 5-strategy list that omitted inflection, and the charts modal's color/label maps had no `inflection` entry (so it rendered gray/uncapitalized in the Performance, Regime, and Ticker tabs). Added inflection to `ReplayChartMonthlyRow` + the backend monthly builder (`mHr('inflection')`, using the already-direction-adjusted 21d return), and to `STRAT_COLORS`/`STRAT_LABEL` + the Monthly chart's line/legend lists. The curated Score-Signal and Rank charts (explicitly buy·bullish·bearish / buy·bullish·wheel) are unchanged by design.

## [0.33.1] — 2026-06-13

### Added
- **Bearish inflection (both directions complete)** — the Inflection strategy now also takes **down breakouts** (fresh 20-day-low break in a downtrend → **bear call spread**, `short-call-vertical`), not just up breakouts. `hasBreakout` accepts `breakout_state === ±1`. To make the metrics correct for a mixed long/short strategy, **Brief Replay outcomes are now direction-aware**: migration 042 adds `replay_outcomes.direction` (1 long / −1 short, populated per pick from the breakout sign; bearish = −1, others = 1; legacy rows fall back to the strategy-implied direction). The replay summary hit-rate uses it uniformly, and inflection's average return is direction-adjusted (positive = thesis worked) so long and short picks don't cancel; the charts direction-adjust inflection's 21-day return likewise. The critic now selects inflection's **higher-graded** relevant vertical (the lab's direction bias makes the correct one — bull put for up-breaks, bear call for down — grade higher), matching the brief card's existing best-score pick.

## [0.33.0] — 2026-06-13

### Added
- **Inflection strategy live in the Daily Brief (Phase 3 of 3)** — `inflection` joins the live brief as a 6th strategy: a **directional credit spread anchored at a fresh 20-day breakout** (bullish). It surfaces up to 5 top-ranked breakout picks per day; on days with few breakouts it shows fewer (the signal scores 0 without a fresh with-trend breakout). The structure is the existing **`short-put-vertical` (bull put spread)** credit vertical — already defined-risk with correct credit P&L; mapped via `STRATEGY_RELEVANT_SLUGS` so the liquidity gate, critic, and brief card all use it. Added a 6th section to the Daily Brief view (and the PDF/email report), with `short-put-vertical`/`short-call-vertical` shown as "Bull Put Spread"/"Bear Call Spread". Brief Replay scores the same 6 strategies (`REPLAY_STRATEGIES` now aliases `STRATEGIES`). **Still bullish-only**; bearish inflection (down-break → bear call spread) remains a follow-up needing direction-aware replay outcomes.

### Fixed
- Corrected the inflection relevant-slug mapping introduced in v0.32.99 — it referenced non-existent `bull-put-spread`/`bear-call-spread` slugs; the real Strategy Lab credit verticals are `short-put-vertical`/`short-call-vertical`.

## [0.32.99] — 2026-06-13

### Added
- **Inflection scoring strategy (Phase 2 of 3)** — `inflection` is now a 6th `ScoringStrategy`. Its composite ranks breakout-setup quality from four signals, **all gated on a fresh with-trend breakout** (`breakout_state`): `breakoutDecisiveness` (30), `volumeSurge` (25), `breakoutIvRank` (25, premium richness), `breakoutAtrPct` (20). A ticker with no fresh breakout scores 0 and never surfaces. Signals are read live from `technical_signals` (`gatherSignalData`) and point-in-time in Brief Replay. **Phase 2 surfaces bullish (up) breakouts only** so the replay "stock-up = win" aggregation is correct; bearish (down → bear call spread) is a follow-up needing direction-aware outcomes. The strategy scores in **Brief Replay** (`REPLAY_STRATEGIES`) for validation but is **not yet in the live Daily Brief** (`STRATEGIES` stays at 5) — that's Phase 3. Tune its weights in the Trade Scoring view.

## [0.32.98] — 2026-06-13

### Added
- **Breakout/continuation signals (Inflection strategy — Phase 1 of 3)** — `DailyTechnicalSignalsJob` now computes and stores five breakout signals per ticker (migration 041 adds them to `technical_signals`): `breakout_state` (−1 fresh 20-day-low breakdown in a downtrend / 0 none / 1 fresh 20-day-high breakout in an uptrend), `breakout_level` (the broken 20-day high/low), `breakout_decisiveness` (`|close − level| / ATR14`), `volume_surge` (today vs 20-day avg volume), and `atr_pct` (`ATR14 / close × 100`). Gated to **with-trend continuation** (up-breaks above SMA50, down-breaks below). These feed the forthcoming Inflection strategy (a directional credit spread anchored at the breakout level); nothing reads them yet, so this phase is purely additive. Validated offline: top-quintile breakouts let a credit spread placed ~0.5–1 ATR beyond the level expire OTM ~84–90% of the time. See `docs/formulas.md#breakout-signals`.

## [0.32.97] — 2026-06-13

### Changed
- **Realistic option fill modeling (slippage haircut)** — credits/debits are no longer priced at the optimistic mid. A new shared `fillPrice()` (`options-fill.ts`) models a leg's fill toward the disadvantageous side: sells fill below mid (toward the bid), buys above mid (toward the ask), by `SLIPPAGE_FRACTION` (0.5) × the half-spread. Applied to Strategy Lab `buildSetup` net credit/debit (incl. PMCC/calendar net debit) and to wheel/income premium in `analysis-service.ts`. **Wheel & income previously used `premium = mid/2`** — an indefensible flat 50% haircut; they now use the realistic fill (premiums rise toward accurate, which shifts their scoring rankings and the values captured in `options_premium_history`). The Strategy Lab previously used raw mid (optimistic); its credits now drop slightly. The effect is largest where liquidity is worst — exactly where it should be. See `docs/formulas.md#fill-model`.
- **Liquidity score now counts same-day volume** — the Strategy Lab `liquidityScore` (0–15) is rebalanced to spread 8 / open interest 4 / **volume 3**, and the wheel `optionLiquidityScore` (0–10) to OI 4 / spread 4 / **volume 2**. A high-OI/zero-volume strike (stale interest that won't fill well) no longer scores as fully liquid; an actively-traded low-OI strike is credited. `SetupLeg` gains a `volume` field. See `docs/formulas.md#liquidity-score`.

## [0.32.96] — 2026-06-13

### Added
- **Strategy Lab: PMCC & calendar second-expiration construction** — the lab now fetches a second far-dated chain (~120 DTE) so the four two-expiration structures (Poor Man's Covered Call/Put, Call/Put Calendar) build real legs instead of returning `unavailableReason: 'Requires two expirations'`. The long leg is drawn from the far chain, the short leg from the near chain. Max profit (which has no closed form for diagonals/calendars) is computed by valuing the long leg's residual time value at the short leg's expiry via Black-Scholes (`bsPrice`), assuming the underlying pins the short strike. This gives buy/bullish a defined-risk, B-grade-capable structure in high-IV regimes where single-leg debits grade C/F. One extra E*Trade `getOptionsChain` call per ticker in `validate()` (graceful: those strategies stay unavailable if no suitable far expiration exists). See `docs/formulas.md#calendar-diagonal-pnl`.

### Changed
- **Black-Scholes extracted to a shared util** (`src/main/services/black-scholes.ts`, exports `bsPrice` / `normCdf` / `RISK_FREE_RATE`); `collared-leaps-service.ts` and the new Strategy Lab calendar/PMCC math both use it (was duplicated).

## [0.32.95] — 2026-06-13

### Added
- **Brief Replay: premium-history readiness banner** — an in-app check that surfaces in the Brief Replay view once enough `options_premium_history` has accumulated to compute real income/wheel ROC. `BriefReplayService.getPremiumHistoryReadiness()` (IPC `replay:premium-history-readiness`) reports total rows, distinct days, date range, and **matured** days (entries older than ~45 days, so the recommended option would have expired). While accumulating it shows a muted progress note (`N/40 matured days`); once ≥40 matured days exist it shows a green "ready — ask Claude to build the ROC view" prompt. Renders nothing when the table is empty, so it stays invisible until the new daily capture job (v0.32.94) has run for a while.

## [0.32.94] — 2026-06-13

### Added
- **Daily Options Premium History job + table** — a new batch job (`daily-options-premium-history`, registered last in the sequence) and table (`options_premium_history`, migration 040) that captures a durable, query-friendly daily time series of the recommended option structure (strike, expiry, premium, delta, bid/ask, IV, annualized return) per ticker for **premium-based strategies**. Wheel CSP rows are reused from the same-day wheel snapshot (`analysis_snapshots`) so no extra E*Trade calls are made; income CSP/CC rows are fetched live via `analyzeTicker('options_income')` — the previously-missing data. One row per `(as_of_date, ticker, strategy)`, **never pruned**. This closes the gap where income/wheel premium had no durable history: a year from now this enables **true return-on-capital** analysis (and real income/wheel ROC in Brief Replay, replacing the stayed-above-strike proxy). Configurable via `config_json` (`callDelayMs`, `maxTickers`, `captureWheel`, `captureIncome`). No startup run; driven by the orchestrator or manual trigger.

## [0.32.93] — 2026-06-13

### Added
- **Bearish composite quality gate (≥70)** — bearish picks now require a composite score ≥70 to surface in the daily brief and Brief Replay (`minCompositeForStrategy()` in `scoring-service.ts`; applied at the Stage-4 pool filter in `daily-intelligence-brief-job.ts` and at replay pick selection in `brief-replay-service.ts`). Full-year replay (2025-05 → 2026-06, 1,300 bearish picks) shows sub-70 picks have ~0 alpha vs SPY and lose money in aggregate (short P&L −1.8%, win 46%), while ≥70 picks underperform SPY by ~3.3% — a real short edge (short P&L +1.0%, win 56%). The gate is rank-agnostic (a rank-2/3 pick clearing 70 is kept; a top-ranked pick below 70 is dropped) and self-suppresses bearish on weak days (~42% of dates yield zero ≥70 picks). Other strategies are ungated.

### Removed
- **Brief Replay: SPY regime risk gate / ⚠ badge (reverted from 0.32.90)** — the regime badge in the summary and picks tables (and `ReplaySummary.regimeRiskDates` / `ReplayPickRow.spyRegime`) is removed. Its "bearish HR ~25% in bullish regime vs ~79% in bearish regime" basis was a 5-month small-sample artifact; the full-year replay *inverts* it — gating bearish to bear-regime dates (SPY below its 50-day SMA at entry) actually performed worse (short P&L −6.7%, win 38%), because below-SMA dips kept V-bouncing and squeezing shorts. Replaced by the composite quality gate above. `computeSpyRegimes()` is retained solely for the descriptive Regime chart tab (no longer drives any filter or badge).

## [0.32.92] — 2026-06-13

### Added
- **Brief Replay: performance charts modal** — a "Charts" button appears after a replay run. Clicking it opens a full-screen modal with five tabs: Performance (avg 21d return + hit rate per strategy), Regime (bull vs bear SPY regime split), Monthly (HR21d line chart), Score Signal (score quintile → return chart exposing the anti-predictive scoring pattern, plus rank-order chart), and Tickers (top/worst tickers per strategy with at least 4 appearances). All aggregations are computed server-side in `BriefReplayService.getChartData()` using `computeSpyRegimes()` for regime splits. Bearish strategy HR/sorting is direction-aware (stock down = win). Charts use Recharts (existing dependency).

## [0.32.91] — 2026-06-13

### Fixed
- **Daily Brief: $5 price floor for briefing candidates** — the screener candidate SQL in `BriefingService` now filters `lastPrice >= 5`, preventing sub-$5 penny stocks (e.g. NWL at $4.92) from appearing in income/wheel/buy picks. The same screener data already had this filter in Brief Replay (replay job enforced it) but the live briefing query did not.

### Added
- **Critic: `high_vol_naked_structure` rule** — fires `warning` when the income strategy selects a `short-straddle` or `short-strangle` (unlimited-risk structures) for a stock whose 1Y price return exceeds 100%. High directional momentum contradicts the range-bound thesis required for straddles/strangles; rule recommends a defined-risk alternative (iron condor or iron fly).
- **Critic: `thin_breakeven` rule** — fires `warning` when income or wheel strategy has a breakeven buffer below 2%. Computed the same way as the LLM context: `|netCredit| / price` (per-contract ÷ per-share = %). A thin buffer means a small adverse move wipes the premium entirely.

## [0.32.90] — 2026-06-12

### Added
- **Brief Replay: SPY regime risk gate for bearish picks** — `BriefReplayService.computeSpyRegimes()` checks whether SPY closed above its 50-day SMA on each replay date. Bearish picks on bullish-regime dates are flagged with a ⚠ badge in the picks table (tooltip: "SPY above 50-day SMA — bullish regime reduces bearish win rate"). The hit-rate summary table shows a "⚠ N/Total regime risk" count on the bearish row (e.g. "⚠ 76/98 regime risk"), derived from replay data showing bearish HR averages ~25% in bullish regimes vs ~79% in bearish regimes. No schema change — computed at query time from existing `historical_prices` SPY bars.

## [0.32.89] — 2026-06-12

### Added
- **Brief Replay** — new Intelligence section screen that back-tests the 5-strategy scoring pipeline against historical dates. Pick a date range, hit Run, and the pipeline scores every NYSE trading day in the window using point-in-time price/IV data and current fundamentals. Produces a hit-rate summary table (5d/10d/21d) per strategy and a drillable picks detail table with entry price, forward returns, and max drawdown. No E*Trade options chains (Option A liquidity proxy: avgVolume ≥ 1 M + price ≥ $5). New tables: `replay_briefs`, `replay_outcomes` (migration 038). Cancellable in-progress runs; data cleared and re-populated on each Run.

## [0.32.88] — 2026-06-12

### Added
- **Daily Brief: 🔍 Analysis and 🏦 E*Trade quick-nav buttons** on every pick card, next to Payoff/Validate/Options. Analysis navigates to the Analysis view pre-loaded with the ticker; E*Trade opens the ticker's quote page (`us.etrade.com/e/t/invest/quotesandresearch?content=3&sym={ticker}`) in the system browser — same deep-link the Opportunity screen uses.
- **Brief email: ticker symbols are now E*Trade links** — each ticker in the per-strategy tables links to its E*Trade quote page, so you can jump from the morning email straight to the order screen.

## [0.32.87] — 2026-06-12

### Fixed
- **ORCL fake net-cash: stale EDGAR concepts no longer serve as current data** — Oracle's only `LongTermDebt` entry in us-gaap is a $0 value from FY2022 (its real ~$90B of debt lives in dimensioned per-instrument contexts that `companyfacts['us-gaap']` doesn't aggregate). The provider served that 4-year-old zero as "current debt" against $38B of current cash → `netDebtToEbitda` −1.37. New `conceptIsStale()` guard: any concept whose newest entry (any form) is older than 540 days is skipped during concept selection — active filers always have an entry within ~120 days, so this only rejects abandoned tags. ORCL's debt now correctly resolves to null (no fake numbers). Also applied to the composite D&A base. T/VZ/MO verified unaffected (current concepts).
- **Banks no longer spuriously pass the leverage value-score criterion** — `netDebtToEbitda` is now null for the financial sector (same detection as the existing D/E exemption): EBITDA is meaningless for banks, and their cash positions produced absurd negatives (RF: −176) that passed `passLte(≤3)` and inflated valueScore/growthScore. Also nulled when |ratio| > 50 (near-zero EBITDA denominators — observed 252, 909). Legitimate negatives for true net-cash companies are kept.
- **docs/formulas.md `#quality-signals` anchor now exists** — code comments referenced it but the section was never written; added with the FCF/NI, ROIC, and NetDebtToEBITDA formulas and null conditions.

## [0.32.86] — 2026-06-11

### Fixed
- **netDebtToEbitda null for 373/1,002 tickers — composite D&A fallback** — modern filers (MSFT, GOOGL, ORCL) no longer tag a combined D&A concept in us-gaap: they tag `Depreciation` (PP&E only) and amortization parts separately, with the combined cash-flow line often in a company extension namespace invisible to `facts['us-gaap']`. New `compositeEntries()` sums `Depreciation` + `AmortizationOfIntangibleAssets` + `FinanceLeaseRightOfUseAssetAmortization` per exact reporting period (each component deduped per period first so comparative re-reports can't double-count), producing a synthetic entry list that flows through the normal `annualSeries`/`ttmPair` machinery. Selection keeps the most-recent-annual-wins rule: the composite replaces a combined concept only when its annual series is strictly more recent — covering both "no combined concept at all" and "combined concept abandoned years ago". Base-only periods are acceptable: understating D&A overstates net-debt-to-EBITDA, the conservative direction for a leverage-risk signal. Validated against live filings: MSFT D&A $31.4B, GOOGL $21.7B, ORCL $6.2B. Banks/energy nulls (no `OperatingIncomeLoss`) are structural and remain null by design.

## [0.32.85] — 2026-06-11

### Fixed
- **Brief rationales: max_tokens sized for the real request volume** — stage 5 requests rationales for all stage-4 candidates (up to 15 per strategy = 75, not the final 25), because the liquidity gate runs later at assembly. The v0.32.81 cap of 4096 still truncated: the first live run salvaged 38/75 and the income/buy strategies (last in the array) got zero rationales. Raised to 16384 (~7K actually needed). The v0.32.81 salvage + `runMeta.aiError` visibility is what made this immediately diagnosable from run history.

## [0.32.84] — 2026-06-11

### Added
- **Dividend yield wired (was 100% null)** — `getFundamentals()` now also queries Polygon `/v3/reference/dividends` (included in the Stocks Starter plan): trailing yield = sum of regular cash dividends with ex-date in the last 365 days / current price × 100. Special dividends (`dividend_type='SC'`) are excluded so one-off payouts don't inflate the yield the wheel/income scoring sees. 0 = confirmed non-payer; null only when the fetch fails. see docs/formulas.md#dividend-yield
- **Beta wired (was 100% null)** — new `BetaService` computes 1-year daily beta vs SPY from local `historical_prices` (1,046/1,067 tickers have ≥250 bars; zero API cost): cov/var over date-joined returns, `adjusted_close` preferred, null under 200 overlapping observations. Injected into `PolygonDataProvider` as an optional callback. see docs/formulas.md#beta

## [0.32.83] — 2026-06-11

### Changed
- **EDGAR fundamentals: true TTM from 10-Q roll-forward** — slot-0 income/cash-flow values were the last 10-K, which is up to ~11 months stale for companies early in their fiscal year (MSFT's FY ends in June; its "TTM" revenue was from June 2025 while P/E used today's price). New `ttmPair()` implements the standard XBRL roll-forward: TTM = FY + YTD(current 10-Qs) − YTD(prior year same period). The prior-year TTM (YoY denominator) rolls the same way using the two-years-back comparative. TTM mode engages only when the full quarterly chain exists; otherwise both values fall back to consistent fiscal years — a TTM numerator over an FY denominator would misstate YoY growth by the stub-period difference. Verified live: MSFT TTM revenue now $318.3B through 2026-03-31 (was $282B through 2025-06-30), NI $125.2B (was $102B). 5Y CAGR keeps its annual base.

## [0.32.82] — 2026-06-11

### Fixed
- **Earnings blind spot: "no earnings data" no longer reads as "no earnings risk"** — ~11% of the universe (119/1,068 tickers) has no future row in `earnings_calendar` (Finnhub bulk-fill gaps; DELL was picked tonight while invisible to the earnings check). Three changes: (1) the brief job now runs a per-pick E*Trade earnings fallback for the ~25 final pick tickers before the critic stage — `refreshTickers` smart-skips tickers that already have valid future dates, so this is typically only a handful of API calls; result recorded in `runMeta.earningsFallback`. (2) The critic's rule check now distinguishes "known clear" from "no data": a pick with an options structure but no future earnings row gets an info-severity `earnings_unknown` flag telling the trader to verify the report date manually. (3) The critic's AI context gains `earningsKnown` so the LLM treats missing calendar data as unverified risk rather than absence of risk.

## [0.32.81] — 2026-06-11

### Fixed
- **Daily brief: all 25 AI rationales were dropped silently** — Stage 5 asks for 25 pick rationales in one call with `max_tokens: 2048`, but 25 × ~90 tokens needs ~2.3K+. The response truncated mid-JSON, the `\[[\s\S]*\]` extraction regex found no closing bracket, and every `aiRationale` stayed null while the ~$0.07 API spend was still incurred — with no error recorded. Fixes: (1) `max_tokens` raised to 4096; (2) new `parseRationaleResponse()` (own module, unit-tested) salvages every complete object from a truncated array instead of all-or-nothing regex matching; (3) `stop_reason === 'max_tokens'` and zero-parse outcomes are now recorded in `runMeta.aiError` so partial/failed synthesis is visible in the run history instead of silent.

## [0.32.80] — 2026-06-11

### Fixed
- **EDGAR 5Y CAGR was computed from a 2-years-ago base, not 5** — every 10-K re-reports the two prior fiscal years as comparatives, so the raw 10-K entry list contains each year 2–3 times (FY25, FY24, FY24, FY23, FY23, FY23…). The provider indexed this list as if entry N were N years back, landing the "5 years ago" slot on FY-2. Result: `revenueGrowth5Y`/`epsGrowth5Y` systematically understated for every steady grower (AAPL: computed 1.66% vs true 8.68%), which suppressed the `earningsGrowth`, `revenueGrowth5Y`, and `epsGrowth5Y` signals in the bullish/buy strategies plus valueScore/growthScore/stockGrade universe-wide. Fix: new `annualSeries()` dedupes by period end (most recently filed wins, so restatements are honored) and drops non-annual durations (<300 or >400 days) that some filers tag inside 10-Ks. `EdgarEntry` now captures `start` to enable the duration check.
- **5Y CAGR no longer silently degrades to a 3–4 year base** — the old fallback computed a "5Y" CAGR from whatever history existed. Now companies with fewer than 6 deduped annuals get null, which the scoring engine correctly treats as a missing signal and reweights.

## [0.32.79] — 2026-06-11

### Changed
- **Fundamentals now sourced from SEC EDGAR instead of Polygon** — Polygon `/vX/reference/financials` requires a Developer plan ($199/mo); the current Stocks Starter plan returns 403. Replaced with the free SEC EDGAR XBRL API (`data.sec.gov`), which requires no API key and exposes the same financial data via US-GAAP concept tags.
- **CapEx now included in FCF calculation** — EDGAR exposes CapEx (`PaymentsToAcquirePropertyPlantAndEquipment`), which Polygon never reliably provided. Added `capital_expenditures` to `PolygonFinancials.cash_flow_statement` so `computeRatios()` can compute proper FCF = Operating CF − |CapEx| instead of using Operating CF alone.
- **Removed Polygon plan-restriction workaround** — the `fundamentalsPlanRestricted` flag and 403 branch in `screener-service.syncUniverse()` have been removed. EDGAR does not have plan tiers.

### Implementation notes
- New `src/main/services/sec-edgar-provider.ts`: `resolveEdgarCik()` (ticker → CIK, cached per process), `getEdgarFundamentals()` (companyfacts fetch → `PolygonFinancials`). Concept selection uses "most-recent annual date wins" heuristic to handle ASC-606-style transitions (e.g. Apple: `Revenues` → `RevenueFromContractWithCustomer…` in 2019).
- Filing array layout: 20 slots (so `sumFiveYearAgoTtm()` length check passes). Real data at slots 0 (current annual), 4 (prior year), 16 (5-years-ago). All other slots hold an empty placeholder so `sumTtm()` skips them gracefully.
- Balance sheet at slot 0 uses the most-recent entry regardless of form (10-Q preferred over 10-K for currency).
- `EDGAR_HEADERS`, `resolveEdgarCik`, `pickEdgarLatest`, `EDGAR_FIELD_SPECS`, and `EdgarEntry` are exported from `sec-edgar-provider.ts` and imported by `ipc-test-api.ts` (no duplication).

## [0.32.78] — 2026-06-11

### Fixed
- **EDGAR test: concept selection picks most-recent data, not first-found** — when a company has multiple matching US-GAAP concepts (e.g. Apple has both `Revenues` with 2018 data and `RevenueFromContractWithCustomerExcludingAssessedTax` with current data), the old code returned the first one that had any entries, giving stale 2018 revenue. Fix: collect all matching candidates and pick the one with the most recent 10-K filing date.

## [0.32.77] — 2026-06-11

### Added
- **Test API — SEC EDGAR tab** — new tab in Test API screen for validating the SEC EDGAR XBRL data source before full provider implementation. Enter any ticker to: (1) resolve CIK via `company_tickers.json` (cached for the session); (2) fetch `companyfacts/{CIK}.json`; (3) check all 11 US-GAAP concepts that `computeRatios()` needs (revenue, net income, operating income, D&A, stockholders' equity, current assets/liabilities, long-term debt, cash, operating CF, CapEx). Results show per-field found/not-found, concept name used, latest annual (10-K) and quarterly (10-Q) values with dates, and filing counts. Concept browser shows all available GAAP concepts, highlighting the ones in use. No API key required; SEC rate limit is 10 req/s.

## [0.32.76] — 2026-06-11

### Fixed
- **Market sync: Polygon fundamentals plan restriction (403) is now visible, not silent** — `/vX/reference/financials` requires a Polygon Developer plan or higher; the Stocks Starter plan (currently in use) returns 403. Previously v0.32.75 silently skipped the 403 per-ticker, which meant fundamentals data was quietly missing with no indication in the job history. New behaviour: on the first 403 from the fundamentals endpoint the flag `fundamentalsPlanRestricted` is set, all subsequent tickers skip the fundamentals call (avoiding ~1000 redundant 403 round-trips), and the job completes with status `success` but with a note: "Fundamentals skipped — /vX/reference/financials requires a Polygon Developer plan or higher (current plan: Stocks Starter)." Quotes still sync normally. The note is visible in Batch Jobs → run history.
- **Root cause of "why only with the orchestrator"** — the fundamentals cache TTL is 24 hours (`TTL_SECONDS.FUNDAMENTALS = 86_400`). All prior manual runs happened within 24 hours of each other, so `isStale()` always returned false and `getFundamentals()` was never called. The orchestrator's strict daily schedule is the first code path that reliably runs with a stale cache, triggering the live Polygon call and exposing the plan restriction.

## [0.32.75] — 2026-06-11

### Fixed
- **Market sync: false "Invalid Polygon API Key" abort on 403 plan-restriction responses** — Polygon returns 403 (not 401) for plan-tier restrictions, and their 403 body frequently contains the phrase "apiKey" (e.g. "your apiKey plan does not include this endpoint"). The screener's `includes('api key')` check matched this and aborted the entire sync with a misleading "Invalid or missing Polygon API Key" error even though the key was perfectly valid. Fix: only hard-abort on a genuine HTTP 401 (`'Polygon HTTP 401'`); 403 plan-restriction errors now silently skip that ticker, matching the existing behaviour for other per-ticker failures.
- **Polygon provider: 4xx auth/plan errors were retried unnecessarily** — `fetchWithRetry` retried all non-ok responses including 401 and 403. These will never recover on retry. Fix: only retry 429 (rate limit) and 5xx (server errors), matching the comment that was already in the code.

## [0.32.74] — 2026-06-11

### Fixed
- **Orchestrator: second daily slot re-runs all jobs instead of skipping everything** — the previous skip rule (`lastSuccessDate === today`) caused the 16:30 slot to skip all 10 jobs because the 10:15 slot had already marked them as "succeeded today". Replaced with a 90-minute time window: a job is skipped only if its last successful run completed within the past 90 minutes. This means a resume (re-trigger minutes after a failure) still skips the already-done jobs, while a second scheduled slot hours later re-runs everything. Skip log message now shows how long ago the job ran (e.g. "skipped (succeeded 12m ago)").

## [0.32.73] — 2026-06-11

### Fixed
- **Orchestrator: false "token invalid" on active E*Trade sessions** — the orchestrator was calling `renewAccessToken()` as the validity check, but E*Trade rejects that call when the token is active (recently used, non-dormant). This caused the orchestrator to abort with "E*Trade token invalid — renewal failed" even though Settings showed "✓ Connected". Fix: use the same date-stamp check that `checkConnection` (Settings page) uses — if `etradeTokenDate` matches today's ET date the token is valid. `renewAccessToken()` is now called as a best-effort wakeup for dormant tokens only; a failure on an active token is silently ignored.

## [0.32.72] — 2026-06-11

### Fixed
- **Orchestrator Edit modal: schedule slots now editable** — replaced the "use raw config editor" note with a full slot manager: list current slots with remove (✕) buttons, add new slots via HH:MM input (Enter or + Add), auto-sorted, duplicate/format validation. The Schedule column in the jobs table now shows the orchestrator's actual `scheduleSlots` instead of the unused `dailyScheduleTime` fallback.

## [0.32.71] — 2026-06-11

### Added
- **Batch Orchestrator** — new `BatchOrchestratorJob` (`batch-orchestrator`, sequence position 1) is the single scheduled job that drives all others. Features: non-trading day guard (scheduled runs only), E*Trade token renewal check, consolidated start email (token status + resume state + outcome), stop-on-first-failure, natural resume via per-job `last_success_date`, multi-slot scheduling (`config_json.scheduleSlots` — each slot fires at most once per day). Sub-jobs are called via `BatchService.runJobDirect()` so their full run history is preserved. "Run All in Sequence" button excludes the orchestrator. Custom orchestrator config modal in Batch Jobs view: job enable/disable list (in sequence order), validateEtradeToken + emailOnStart toggles.
- **Remote trigger** — `POST /api/v1/orchestrator/run` + `GET /api/v1/orchestrator/status` routes (X-Agent-Token auth) allow triggering and polling from Termius / Claude Code CLI when away from home.
- **Trigger context in run history** — `batch_runs.trigger` (`manual|schedule|startup`) and `batch_runs.slot_time` are recorded on every run. Batch Jobs view shows a Trigger column in run history.
- **Migration 037** — shifts all `batch_jobs.sequence_order` +1 to reserve position 1 for the orchestrator; adds `trigger` and `slot_time` columns to `batch_runs`.

## [0.32.70] — 2026-06-10

### Changed
- **Brief Stage-4 pool deepened 10 → 15 per strategy** — the liquidity gate now correctly rejects thin chains (v0.32.69), which left wheel with 4 picks and income with 3. A deeper validation pool gives the gate more candidates so each strategy can still fill 5 picks. Worst-case E*Trade cap rises to 75 unique tickers/run (typically far fewer due to cross-strategy overlap).

## [0.32.69] — 2026-06-10

### Fixed
- **Strategy Lab: stale E*Trade Greeks no longer poison structures** — E*Trade serves months-old deltas on thin (OI=0) chains while option *prices* stay correct (2026-06-10 brief: WSO chain claimed delta −0.50 at $450 with spot at $375.66 → wheel put built 11.8% ITM; AWI income straddle struck 31% above spot *passed* the critic; MIDD, ALGM also affected — 4 of 25 picks). The lab estimated the underlying from those deltas. Now: underlying price comes from `chain.underlyingPrice` (E*Trade's real-time spot, was always available but unused) → live Polygon quote → chain-delta estimate as last resort. When the delta-implied ATM deviates >8% from real spot, chain deltas are distrusted and leg selection uses moneyness.
- **Critic prompt: `strikeOtmPct` defined side-aware** — the "positive = OTM" gloss is wrong for puts; it made the LLM read AWI's broken +31% straddle as "safely OTM". Now defined as strike-vs-spot with explicit per-side ITM/OTM semantics.

### Added
- **Critic rule: `stale_lab_price`** (warning) — fires when the lab's underlying price deviates >5% from the live pick price; deterministic catch-all for structure-data integrity regardless of LLM judgment.

## [0.32.68] — 2026-06-10

### Changed
- **Batch Jobs screen: stable three-panel layout** — all three panels now have fixed heights (Registered Jobs 300px, Run History ~4 rows, Live Activity log 200px) so nothing shifts or "dances" while a job runs. The Live Activity panel is permanently visible (placeholder when idle) and the log is no longer auto-cleared 3s after a run — it persists until the next run starts, so failures can be inspected. Added ⧉ Copy (clipboard) and ✕ Clear buttons. Auto-scroll now scrolls only the log's own scrollbar; previously `scrollIntoView` yanked the entire page down on every progress event, pushing the jobs grid out of view.

## [0.32.67] — 2026-06-10

### Fixed
- **`annualizedReturn` 100× unit bug** — per-share premium was divided by per-contract collateral (`strike × 100`), understating annualized options return 100×. This zeroed the wheel `premiumYield` (wt 19) and income `premiumRiskRatio` (wt 22) scoring signals for every ticker — both strategies effectively ranked without their premium signal, letting earnings-pumped high-IVR names float to rank 1. Values self-correct on the next analysis snapshot refresh.
- **`GRADE_RANK` missing `'A+'`** — an A+ structure ranked 0 (below F); a pick whose only available structures were A+ and F would incorrectly fire `poor_structure_grade`.
- **Critic liquidity flag now reads the chosen structure** — previously it reported the *best* liquidity across relevant structures while the LLM context showed the *chosen* structure's, producing contradictory numbers in the same prompt (observed: HAYW flagged 5/15, context said 3/15 — the LLM called out the discrepancy).

### Changed
- **Earnings penalty extended to wheel + bearish** — the −20 composite penalty for earnings within 45 days (previously income-only) now applies to all short-premium strategies. 3 of 5 wheel picks on 2026-06-10 carried confirmed earnings inside the expiry window.
- **Critic calibration: info flags are advisory** — prompt now states a pick whose only flags are info-severity can still merit `pass`; `low_liquidity` threshold lowered from <6 to <4 (4–6 is normal for single-name large caps).
- **Buy strategy is stock-first** — when no buy-relevant structure grades B or better (systematic in high-IV regimes, where all debit structures grade C/F), the pick is presented as a plain stock purchase: `📈 Buy Shares` chip in the brief view, structure demoted to "Optional", `poor_structure_grade` suppressed, and the critic LLM told to evaluate the stock thesis.

### Added
- **Critic rule: bearish SPY mirror** — bearish picks now get an info flag when SPY is above its 200-day MA (the bullish/buy macro-headwind check already existed; the mirror didn't).
- **Critic rule: `counter_trend_itm_strike`** — warning when a bearish short strike sits at/below the current price (zero cushion) while SPY trends up. 3 of 5 bearish picks on 2026-06-10 had ATM/ITM short strikes on a bullish tape.

## [0.32.66] — 2026-06-10

### Added
- **Brief Trend: total Return $ in summary bar** — sum of dollar returns across all rated picks shown next to avg return.

## [0.32.65] — 2026-06-10

### Added
- **Brief Trend: Return $ column** — shows dollar return (latest available price − brief price) alongside Return %. Uses the same colour coding as Return %. Sortable.

## [0.32.64] — 2026-06-10

### Added
- **Brief Trend: all columns sortable** — click any column header to sort ascending; click again to flip to descending. Active column shows ▲/▼; inactive columns show a faint ⇅. Nulls always sort last. Sort resets when changing the brief date or strategy filter.

## [0.32.63] — 2026-06-10

### Fixed
- **Portfolio sync now captures all legs of multi-leg strategies** — long option legs (e.g. the long call in a jade/big lizard) were silently skipped during E*Trade sync. Added `'Long Put'` and `'Long Call'` position types; upsertPosition now maps LONG CALL → `Long Call` and LONG PUT → `Long Put` instead of dropping them. Greeks for long positions use natural (un-negated) chain values. Migration 036 expands the `position_type` CHECK constraint via table recreation.

## [0.32.62] — 2026-06-09

### Fixed
- **Paper trades: stale picks from multi-run days now replaced, not accumulated** — each time the brief runs on the same date, `autoCapture` now deletes all existing open picks for that strategy/date before inserting the current run's picks. Previously, picks from earlier runs (e.g. debugging iterations) were permanently retained alongside the final run's picks via the `ON CONFLICT DO UPDATE` upsert that only updated matching tickers and couldn't remove ones that were dropped. Result: income could accumulate 13 picks across 7 runs when only 5 are correct.
- **Historical cleanup on next brief run** — `cleanupStalePicksAllDates()` is called once at the start of each Stage 6. Uses `json_each(picks)` to compare open paper trades against the latest brief for each date/strategy, and deletes any ticker not present in that final run. Removes stale picks from all past dates on the next brief generation (61 stale picks identified across June 3, 5, 8, 9 from dev/debugging runs).

## [0.32.61] — 2026-06-09

### Fixed
- **Critic context mismatch: structures with `unavailableReason` excluded from LLM context** — `synthesizeVerdict` was selecting the first structure where `setup != null`, but an unavailable structure (e.g. PMCC requiring two expirations) has a non-null `setup` object with `unavailableReason` set. The LLM was seeing grade-F ghost data (no legs, no credit, no strike) instead of the actual gate-passing structure. Fixed in both `synthesizeVerdict` and `getStructureExpiry` to require `!s.setup.unavailableReason`.
- **Critic prompt: LLM never gave `pass` verdict** — system prompt framing ("your job is to find problems") and the mandatory second sentence ("what should the user check") structurally biased the LLM to give `caution` even for clean picks. Updated prompt with explicit verdict calibration definitions, allows 1–2 sentences, and instructs "do not default to caution."

### Added
- **`checkStructureGrade` critic rule** — fires `warning` when every valid structure for the strategy is grade F. Catches picks like VRT (all buy structures grade F) via a deterministic rule rather than relying solely on LLM analysis. Severity `warning` → forces `flag` verdict and surfaces as an explicit rule flag in the UI.

## [0.32.60] — 2026-06-09

### Fixed
- **`breakevenDistancePct` formula was 100× too high** — `netCredit` is stored per-contract (×100 shares) but the formula was also multiplying by 100, causing every income pick to show e.g. 760% instead of 7.6%. Fixed by removing the `* 100` (dividing per-contract credit by per-share price already yields a percentage). Added formula documentation to `docs/formulas.md#breakeven-distance`.
- **`low_liquidity` critic rule inflating flag count** — severity was `'warning'` for picks at liqScore=5/15 (the gate minimum), which forced verdict to `flag` even when the LLM was unavailable. Downgraded to `'info'` so borderline-liquid picks that passed the gate become `caution` rather than false positives.
- **Grade-F structures passing the liquidity gate** — picks where the Strategy Lab ran but all relevant structures had `unavailableReason` set (e.g. PMCC requiring two expirations) were passing `hasAdequateLiquidity()` via the `best === null → true` fallback. Fixed: now only passes when `labResult` is `null` (validation failed entirely); a lab result with no valid structure returns `false`.

### Changed
- **Critic LLM batching: 25 concurrent → 5×5 serial** — AI critic calls were all fired in parallel across all 25 picks, causing ~50% LLM failure (rate limiting). Now runs one strategy's picks (≤5) in parallel, then the next strategy. Drastically reduces rate-limit failures while still completing all 5 strategies in sequence.
- **Income scoring: −20 penalty for earnings within 45 days** — income candidates (strangles, condors) with an earnings event in the next 45 days are penalised −20 composite points before the liquidity gate. Replaces the current pattern of scoring them highly and then flagging them via the critic; keeps them out of the top 5 unless no clean alternatives exist. Configurable via `loadIncomeEarningsPenalty()` in the brief job.

## [0.32.59] — 2026-06-09

### Fixed
- **Brief funnel log: distinguish liq-failed vs outranked** — the previous log conflated two different exclusion reasons under "gated": tickers that failed the liquidity gate (liq < 5) and tickers that passed the gate but were cut by the 5-pick output cap. Log now shows `liq-failed: FWONA(3/15), CSX(3/15)` separately from `outranked: MSFT(9/15), MPC(11/15)`. `totalGated` now only counts true gate failures, not cap-cuts.

## [0.32.58] — 2026-06-09

### Changed
- **Brief: pre-gate pool widened from 5 → 10 per strategy** — each strategy now sends its top 10 scored candidates to E*Trade validation (was top 5). Post-gate output is still capped at 5 picks per strategy. Gives the liquidity gate more candidates to work with — especially for income, which frequently loses 3+ picks to the gate in low-VIX trending markets. `STAGE_4_CAP` updated from 25 → 50 unique tickers.
- **Brief: $750 price cap** — stocks priced above $750 are excluded from all brief picks before Stage 4 validation. Avoids options with very large notional size (e.g. FIX at $1,860, COST at $935). Applied after scoring so high-priced stocks still contribute to relative-strength benchmarks. Configurable via `MAX_PICK_PRICE` constant in `daily-intelligence-brief-job.ts`.

## [0.32.57] — 2026-06-09

### Changed
- **Brief funnel log: show liquidity score for each gated ticker** — log now reads e.g. `income: 5 pre-gate → 2 final (gated: CSX(liq=4/15), FWONA(liq=2/15), OGE(liq=1/15))`. Extracted `getBestLiquidityScore()` helper; `hasAdequateLiquidity()` delegates to it. No behavior change.

## [0.32.56] — 2026-06-09

### Fixed
- **`sectorMomentum` signal: ~50% null rate fixed** — `SECTOR_ETF` used GICS sector names ("Technology") but Polygon stores lowercase SIC descriptions ("electronic computers", "semiconductors & related devices"). Added `sectorStringToEtf()` keyword-matching fallback that maps Polygon SIC descriptions to SPDR sector ETFs. Coverage goes from ~0% (only GICS exact matches) to ~58% of tickers in `fundamentals_cache`. Affects `sectorMomentum` (bullish/buy) and `sectorWeakness` (bearish) signals.
- **`leverageQuality` signal: always-null fixed for wheel/bearish** — `netDebtToEbitda` has only ~9% coverage in Polygon fundamentals. Falls back to `debtToEquity * 2.5` as an approximation (D/E 1.0 ≈ ND/EBITDA 2.5) when ND/EBITDA is null. Raises signal coverage from 9% to ~30% for wheel and bearish strategies.

### Added
- **Daily brief funnel logging** — `[brief funnel]` console log per strategy at the liquidity gate showing pre-gate count, post-gate count, and names of gated tickers. Diagnostic only — no behavior change. Helps distinguish liquidity-gate scarcity from genuine candidate scarcity.
- **Score badge tooltip in Daily Brief** — hovering the composite score badge shows "Scores are strategy-specific — not comparable across strategies" to prevent cross-strategy score misinterpretation.

## [0.32.55] — 2026-06-09

### Fixed
- **Critic: `strikeOtmPct` formula was inverted** — `(price - strike) / price` produces a negative value when the short strike is OTM (above current price for a call), directly contradicting the "positive = OTM" description sent in the LLM system prompt. Corrected to `(strike - price) / price`. This eliminates the ~3 false bullish flags (e.g. COHR, ALAB, MRVL) produced each brief run.

### Added
- **Critic rule: `data_anomaly_suspected`** — new `info`-severity rule flag emitted when `priceMomentumPct` exceeds 500%. Catches spinoff/reverse-merger tickers (e.g. SNDK after the WD spinoff) where the oldest available bar gives a nonsensical 1-year return, causing the pick to slip through as a false PASS when the LLM is unavailable.
- **Critic rule: `earnings_in_window`** — new `warning`-severity rule flag emitted when a known earnings date falls between today and the structure's expiry. Previously earnings were only passed as LLM context and disappeared when the LLM was rate-limited or unavailable. Now always present in `criticVerdict.flags` regardless of LLM status.

## [0.32.54] — 2026-06-09

### Added
- **Retrospect › Brief Trend: click ticker to view 45-day chart** — clicking any ticker in the grid opens a candlestick popup showing price from the brief date through a 45-calendar-day window (the typical options expiry horizon). Overlays: dashed blue horizontal line at the brief price, `Brief` arrowUp marker on the brief date bar, `D5` arrowDown marker on the Day-5 bar (when available). Click outside the card or press Escape to close. No new IPC — reuses `historical.getPrices`. Data is partial for recent briefs (shows what's available in `historical_prices` through today).

## [0.32.53] — 2026-06-09

### Fixed
- **Brief Trend: critic column blank for all brief dates except today** — two bugs combined: (1) when the Anthropic LLM call inside `synthesizeVerdict` threw (rate-limit, transient API error, expired E*Trade token), the catch block only logged a warning and left `criticVerdict = null` with no fallback. Now falls back to a rule-check-only verdict (`confidence: 'low'`) so the column is never blank. (2) `getBriefPickDrilldown` looked up critic data via `WHERE DATE(generated_at) = ?` (UTC date) against `paper_trades.brief_date` (ET date), which is fragile. Replaced with a `brief_id` join (`MAX(brief_id) … GROUP BY brief_strategy`) that uses the direct FK already stored in `paper_trades`.

## [0.32.52] — 2026-06-09

### Fixed
- **Price Gap Fill: today's close never loaded on the same evening** — the stale-ticker threshold was `MAX(date) < date('now', '-1 day')`, so a ticker whose latest bar was yesterday was considered "fresh" and skipped. Changed threshold to `date('now')` so any ticker missing today's date is fetched. Same fix applied to the reference-ticker freshness check. Reference tickers that exist but are missing today now use a `fromDate` override (3-day lookback) instead of refetching the full 1Y range.

## [0.32.51] — 2026-06-09

### Changed
- **Retrospect › Brief Trend: 5-day trading-day price columns** — replaces the single Day+5 Price column with five individual columns (Day 1 – Day 5) showing the closing price on each of the first 5 trading days after the brief date. Weekends and market holidays are skipped naturally because data comes directly from `historical_prices` (which only contains market-open days). Each cell shows the price when available or ⏳ while that day is still in the future. Return % always reflects brief price → most recent available day; Outcome updates progressively as each day populates. Data caps at Day 5 — no tracking beyond 5 business days.
- **Retrospect › Brief Trend: drop Entry Zone / In Zone columns** — removed the buy-strategy entry zone and in-zone check columns to reduce clutter.
- **Service**: `getBriefPickDrilldown` now queries `historical_prices` directly via ROW_NUMBER() partition instead of `paper_trade_snapshots`; entry-zone lookup removed. `BriefPickDetail` type updated accordingly (`day1-5Price`, `returnPct`, `latestVerdict` replacing old day5 fields).

## [0.32.50] — 2026-06-09

### Added
- **Retrospect: Brief Trend tab** — new tab next to History that lets you drill into any individual brief's picks and compare prediction vs Day+5 outcome. Select a brief date from the dropdown, optionally filter by strategy. Table columns: Ticker (hover = AI rationale), Strategy, Score, Brief Price, Entry Zone (buy strategy only, from nearest analysis snapshot), In Zone? (was brief-day price inside the zone), Day+5 Price with actual days elapsed, Return % colour-coded per strategy direction, Outcome emoji (✅/❌/➖/⏳), Critic verdict badge with critic rationale on hover. Summary bar at top shows hit count, rated pick count, and average Day+5 return. New service methods `getBriefDates()` + `getBriefPickDrilldown()` in `paper-trading-service.ts`; new IPC `paper:brief-dates` + `paper:brief-pick-drilldown`; new `BriefPickDetail` shared type.

## [0.32.49] — 2026-06-09

### Improved
- **Daily Brief banners: hover tooltips** — both header banners now show explanatory tooltips on hover. The B-01 label explains "Day+5 hit-rate" and colour thresholds; each strategy chip shows exact hit counts and avg return. The B-02 label explains "critic pass-rate", trend arrow direction, and colour thresholds; each strategy chip shows the current pass-rate, trend description, and a full per-date pass-rate history (oldest → newest).

## [0.32.48] — 2026-06-09

### Added
- **Daily Brief: critic health trend banner (B-02)** — a second slim bar appears in the brief header showing per-strategy critic pass-rate trend across the last 7 briefs (e.g. `wheel ↑55% · buy →42% · bullish ↓28%`). Trend direction is computed by comparing the older half vs newer half of pass rates (>8pp difference = improving ↑ / declining ↓, otherwise stable →). Colour-coded: green ≥60% / amber ≥40% / red <40%; arrow coloured green (improving) / red (declining) / amber (stable). Only shows when at least one strategy has enough critic data; silently absent otherwise. New `getBriefHealthTrend()` method in `scoring-service.ts` queries `daily_briefs`, deduplicates per calendar-date, parses `picks` JSON for `criticVerdict.verdict` counts. New IPC `scoring:brief-health-trend` + preload entry.

## [0.32.47] — 2026-06-09

### Improved
- **Conviction Alerts moved to My Stocks** — the ⚡ entry-zone alert strip now lives at the top of the My Stocks screen where it belongs, reusing the already-loaded stocks list (no extra API call). Each in-zone stock shows as a colour-coded chip (green = Buy Zone, yellow = Mid Zone) with ticker, zone badge, current price, IV, and IVR. Removed from Daily Brief where it was a detour.

## [0.32.46] — 2026-06-09

### Added
- **Daily Brief: prior-brief performance banner (B-01)** — a slim bar appears directly below the brief toolbar showing last brief's Day+5 hit-rate and average return per strategy (e.g. `wheel 3/5 +1.8% avg · buy 2/4 +3.2% avg`). Colour-coded green ≥60% / amber ≥40% / red <40%. Only visible once Day+5 snapshot data exists for a prior brief; silently absent otherwise. New `getBriefPerformanceSummary()` service method uses a CTE to find the most-recent mature brief_date and aggregate per-strategy Day+5 metrics from `paper_trade_snapshots`. New IPC `paper:brief-performance-summary` + preload entry.

## [0.32.45] — 2026-06-09

### Added
- **My Stocks: AI Advisor** — new 🤖 AI Advisor button reviews all conviction stocks in a single Claude call and returns per-stock action signals + recommended price zones. For each stock it receives: current price, zone status, bands, trend direction, RSI, SMA50/200, P/E, EPS growth, grade, IV/IVR, and days to earnings. Claude returns `add` / `hold` / `reduce` / `remove` action, `keep` / `adjust` zone verdict, recommended Low/Mid/High prices, a short risk flag, and a one-sentence rationale. Results appear in a panel below the table with checkboxes per row; clicking **Apply Selected** (or **Apply All**) updates the zones in one pass (history snapshot written automatically for each change). Stocks with `adjust` verdict are pre-checked; `remove` action stocks start unchecked to prevent accidental deletion.

## [0.32.44] — 2026-06-09

### Improved
- **Filters screen: Strategy Lab button in results grid** — added 🔬 button to each row's action column, alongside the existing Analysis, Validate, Options chain, and Payoff buttons. Clicking navigates directly to Strategy Lab pre-loaded with that ticker.

## [0.32.43] — 2026-06-09

### Fixed
- **My Stocks (ConvictionView): IV showing as thousands percent** — `conviction-service.ts` was multiplying `atm_iv` values by 100 before using them, but `iv_history.atm_iv` is already stored as a percentage (e.g., 31.726 = 31.7% IV). The double-multiply produced values like 3172.6%. Removed the erroneous `* 100` from all three locations: the `list()` display path, the `recommend()` IV rank computation, and the `get()` single-ticker fetch.

## [0.32.42] — 2026-06-09

### Improved
- **Scoring engine: trend direction signals** — three strategies now penalize picks that conflict with the current price trend, making the Daily Brief's recommendations more directionally actionable:
  - **Buy** (`trendAlignment`, weight 10): uptrend=100, sideways=25, bearish=0. A sideways stock costs ~7.5 pts on the composite — enough to push a range-bound name below better-aligned alternatives. Previously sideways and uptrend stocks scored identically on this dimension.
  - **Bullish** (`trendAlignment`, weight 7): same mapping, same penalty logic. Bullish spreads need a directional tailwind.
  - **Wheel** (`notDowntrend`, weight 8): uptrend=100, sideways=75, bearish=10. Avoids selling CSPs into confirmed downtrends (falling-knife assignment risk); sideways remains acceptable for premium selling.
  - **Bearish** and **Income** unchanged — `downtrendScore` and `trendNeutral` already capture direction for those strategies.
- **Seed upgrade**: `seedBaselines()` auto-upgrades `baseline_v1`/`v2` DB configs → `baseline_v3` on startup, so existing installs pick up the new signals without resetting manual customizations.
- **Trend derivation**: when `trendLabel` is unavailable from analysis snapshots, direction is derived from `sma50`/`sma200` stack in `technical_signals` — providing coverage for all ~1055 universe tickers without requiring a prior analysis run.

## [0.32.41] — 2026-06-08

### Fixed
- **DailyBrief watchlist not appearing in dropdown**: after the brief job creates or refreshes the `DailyBrief-MMDD` watchlist, the main process now sends a `watchlists:updated` IPC push to the renderer. `App.tsx` subscribes via `window.api.watchlists.onUpdated` and calls `refreshLists()` immediately — the new watchlist appears in every dropdown without requiring an app restart or manual navigation. New `onUpdated` push listener added to the preload `watchlists` namespace.

## [0.32.40] — 2026-06-08

### Added
- **Daily Brief auto-watchlist**: after each brief run, a watchlist named `DailyBrief-MMDD` is automatically created (or cleared and refreshed if it already exists for today). All final picks from all 5 strategies are added as items; the notes field shows which strategies each ticker was picked for (e.g. `wheel · buy`). The watchlist is immediately available in Watchlists, Screener, Analysis, and anywhere else watchlists are consumed. New public methods `findByName()` and `clearItems()` added to `WatchlistService`.

## [0.32.39] — 2026-06-08

### Improved
- **Daily Brief: collapsible pick cards** — each pick is now a single-line summary row (rank · ticker · price · score · structure grade · critic verdict) that expands on click to reveal signals, strategy lab detail, nav buttons, AI rationale, and full critic analysis. Collapsed by default to reduce scrolling.

## [0.32.38] — 2026-06-08

### Fixed
- **trendNeutral signal (income)**: ADX was only available from watchlist analysis runs. `DailyTechnicalSignalsJob` now computes 14-period Wilder ADX for all ~1055 universe tickers and stores it in `technical_signals.adx` (migration 035). `loadTechnicalSignals()` populates `trendStrengthAdx` from it as a fallback, so income picks are now range-bound filtered even without a prior analysis run.
- **breakoutScore signal (buy)**: `entryZoneLow` was only available from watchlist analysis runs. `DailyTechnicalSignalsJob` now computes the 20-day price low as a support-zone proxy and stores it in `technical_signals.support_level`. `loadTechnicalSignals()` populates `entryZoneLow` from it, enabling the `priceNearSupport` component of `breakoutScore` for all batch-scored tickers.

## [0.32.37] — 2026-06-08

### Improved
- **AI Critic context enrichment**: four grounding improvements to reduce LLM hallucinations and improve verdict accuracy:
  - **DTE pre-computed**: `structure.dte` (calendar days to expiry) is now calculated server-side and passed directly — removes LLM date arithmetic errors (e.g. treating a 39-DTE July expiry as a "12-month hold")
  - **Market context**: VIX level and SPY trend (vs 200MA) now passed to the LLM as `marketContext` — model previously had no visibility into the macro environment
  - **Earnings in window**: `earningsInWindow` field added — queries `earnings_calendar` for any event between today and expiry; non-null result tells the model the exact date, days from now, and confirmation status of the biggest event risk
  - **Pre-computed risk metrics**: `strikeOtmPct` (how far the short strike is from current price) and `breakevenDistancePct` (income only — how far price can move before loss) are now computed server-side, removing another class of LLM arithmetic errors

## [0.32.36] — 2026-06-08

### Fixed
- **AI Critic price hallucination**: critic LLM was overriding correct live prices with stale training-data prices (e.g. flagging AMD at $490 as "fabricated" because it "remembered" AMD at ~$110). Fix: system prompt now explicitly instructs the model that all `marketData` fields are live and authoritative — training knowledge about prices is years out of date and must not be used to contradict provided data. Context also now includes `price52wReturnPct` so the model can calibrate price level from the known 1-year return without needing to recall an absolute price from training.

## [0.32.35] — 2026-06-08

### Fixed
- **Daily Brief scoring — fundamental signals always missing**: `loadFundamentals()` was reading from `screen_results` (the last screener run), so any ticker not in that run had null earningsGrowth, fundamentalScore, revenueGrowth5Y, epsGrowth5Y, leverageQuality etc. — which the AI Critic immediately flagged as `critical_signal_missing`. Root cause: the last screener run used the ETF universe (60 tickers), leaving all ~1000 stock picks with no fundamental data. Fix: `loadFundamentals()` and `loadSectorMomentum()` now read from `fundamentals_cache`, which is populated by the market-sync batch jobs for the full constituent universe (1067 rows, updated daily). `loadTechnicalSignals()` also now provides `rsi`, `smaStack`, and `lastPrice` as fallbacks from the nightly `DailyTechnicalSignalsJob` (1055 tickers), so those signals are no longer watchlist-scoped.

## [0.32.34] — 2026-06-08

### Fixed
- **Earnings Refresh bulk**: filter Finnhub bulk entries to constituent tickers only — bulk was storing 1500+ global entries (random small caps, international) of which only ~100 were S&P500/Russell1000. Counter and per-ticker delta now reflect actual constituent coverage.

## [0.32.33] — 2026-06-08

### Fixed
- **Earnings Refresh per-ticker loop**: Finnhub earnings calendar requires `from`/`to` date parameters — omitting them returns an empty response. Per-ticker calls now include a 365-day window so AAPL, MSFT etc. are correctly retrieved.

## [0.32.32] — 2026-06-08

### Fixed
- **Earnings Refresh Phase 2**: Finnhub's free-tier bulk call has a result cap (~1500 global entries); confirmed tickers like AAPL (Jul 29) were missing because they didn't fit in the bulk response. Added per-ticker Finnhub fallback loop for all constituents still missing a future date after the bulk calls. Rate-limited to 1 call/second (within 60/min free tier). Run notes show both bulk and per-ticker counts.

## [0.32.31] — 2026-06-08

### Changed
- **Earnings Refresh**: removed E*Trade loop entirely — job is now Finnhub-only. Companies without an announced next date simply have nothing to return yet; they appear on the next daily run once published. No more 950+ useless E*Trade no-data calls.

## [0.32.30] — 2026-06-08

### Added
- **Earnings Calendar**: 🗑 Reset button clears all non-manual entries (manual dates kept) — use before a clean Finnhub re-fetch

### Fixed
- **Earnings Refresh Phase 1**: Finnhub now makes two bulk calls (today→+90d and +90d→+180d) instead of one, doubling coverage and avoiding the free-tier result cap that left tickers like ABNB out of the first call. E*Trade Phase 2 delta is computed after both Finnhub calls.

## [0.32.29] — 2026-06-08

### Changed
- **Earnings Refresh**: Finnhub dates stored as `confirmed=true` — calendar shows "✓ Confirmed" instead of "~ Estimated"; Finnhub data quality verified to be reliable (ABNB, ADBE etc.). E*Trade Phase 2 loop still runs for tickers Finnhub didn't cover, but cannot overwrite Finnhub future dates (delta filter excludes them).

## [0.32.28] — 2026-06-08

### Added
- **Finnhub API key in Settings** (API & Data tab) — stored encrypted alongside Polygon/IVolatility keys; saved by the same Save Settings button
- **Earnings Refresh — Finnhub Phase 1**: when a Finnhub key is configured, the batch job now opens with a single bulk call (`today → +90d`) that pre-fills `earnings_calendar` for every ticker Finnhub covers (including ABNB, ADBE, AA, AAL etc. that E*Trade's API silently drops). Source stored as `'finnhub'`, `confirmed=false`. E*Trade Phase 2 then overwrites with confirmed dates for the remaining delta. Run notes show both phases.

## [0.32.27] — 2026-06-08

### Added
- **Test API — Finnhub tab**: API key save/load, date-range earnings calendar fetch (bulk, not per-ticker), constituent coverage counter, results table (Date · Symbol · BMO/AMC · Quarter · EPS Est/Actual · Revenue Est/Actual), raw JSON sample. Pre-implementation validation before wiring Finnhub into the earnings pipeline.

## [0.32.26] — 2026-06-08

### Fixed
- **Earnings Refresh delta filter**: the `force=true` flag passed by "Run All in Sequence" was bypassing the delta query and falling back to all 1000+ tickers. The delta filter now always runs regardless of the force flag — `force` is for non-trading-day guards in other jobs, not earnings caching.

## [0.32.25] — 2026-06-08

### Changed
- **My Stocks actions**: buttons consolidated to single row, icon-only (🎯🔬📐📉✎🕓✕) with tooltips — prevents 2-line wrapping

## [0.32.24] — 2026-06-08

### Added
- **My Stocks actions column**: four navigation buttons added — 🎯 Validate, 🔬 Lab, 📐 Payoff, 📉 Options — alongside the existing Edit / History / Remove buttons

## [0.32.23] — 2026-06-08

### Fixed
- **Earnings Refresh batch job**: switched from full-population iteration to delta mode — a single SQL LEFT JOIN now pre-filters the ticker list to only those with no stored date or a past/today date. The day after a full run, only tickers whose earnings just occurred are fetched instead of all 1000+. Manual entries and tickers with future dates are excluded before the loop even starts.

## [0.32.22] — 2026-06-08

### Fixed
- **Payoff risk matrix**: spot row is now vertically centred in the visible table area on load and whenever the strike list changes — no more scrolling to find current price

## [0.32.21] — 2026-06-08

### Fixed
- **Lizard → Payoff**: legs now always pre-populate when strikes + expiry are available; per-leg premiums default to 0 for snapshots run before v0.32.20 so the structure is pre-filled even on older data

## [0.32.20] — 2026-06-08

### Fixed
- **Lizard → Payoff navigation**: clicking 📐 Payoff from Jade Lizard or Big Lizard grid rows now pre-populates all 3 legs (sell put, sell call, buy call) with correct strikes and mid-premiums. `LizardResult` now stores per-leg premiums (`putPremium`, `shortCallPremium`, `longCallPremium`).

## [0.32.19] — 2026-06-08

### Changed
- **Grid width**: removed fixed `maxWidth` caps from Analysis Engine (1200px), My Stocks (1200px), Batch Jobs (1100px), and Strategy Lab (1000px) — grids now use full available width, eliminating horizontal scrollbars

## [0.32.18] — 2026-06-07

### Added
- **Analysis Engine — Jade Lizard & Big Lizard modes**: two new watchlist-screening tabs that find the best setup for each ticker (30–45 DTE), calculate net credit received, verify the "no upside risk" constraint (credit > spread width), and sort by total premium descending
  - **Jade Lizard** 🦎: short OTM put (~30Δ) + short OTM call (~20Δ) + long call one strike above
  - **Big Lizard** 🐊: short ATM straddle + long call one strike above ATM
  - Columns: Ticker · Price · Exp · DTE · Put Strike · Short Call · Long Call · Net Credit · Spread W · No ↑ Risk · Breakeven↓ · IV Rank · Actions
  - Both use the E*Trade options chain (same pipeline as Wheel/Options Income)

## [0.32.17] — 2026-06-07

### Added
- **Analysis Engine**: Actions column in all five mode grids (Buy, Options, Wheel, Bullish, Bearish) with 📐 Payoff, 📉 Options, and 🔬 Lab buttons — navigate directly to the respective view with the ticker (and strike/expiry where available) pre-filled

## [0.32.16] — 2026-06-07

### Changed
- **Earnings Calendar grid**: cell and chip borders thickened from 1px to 2px

## [0.32.15] — 2026-06-07

### Changed
- **Earnings Calendar grid**: cells and ticker chips now use the Batch Jobs color palette (`#131b2e` cells, `#2d3748` borders, `#89b4fa` blue accent, `#95a5a6` muted text)

## [0.32.14] — 2026-06-07

### Changed
- **Earnings Calendar**: reverted screen chrome (toolbar, background, buttons, list rows) back to app dark theme; calendar cell colors preserved for follow-up tuning

## [0.32.13] — 2026-06-07

### Changed
- **Earnings Calendar**: replaced near-black navy palette with a light blue theme — cell backgrounds `#eff6ff`/`#e0ecff`/`#bfdbfe`, borders `#bfdbfe`/`#93c5fd`, text `#1e3a5f`, toolbar `#dbeafe`

## [0.32.12] — 2026-06-07

### Changed
- **Sidebar**: Portfolio moved above My Stocks in the Personal section

## [0.32.11] — 2026-06-07

### Changed
- **Sidebar**: swapped Personal and Misc section order — Personal now follows Strategy, Misc is last

## [0.32.10] — 2026-06-07

### Changed
- **Sidebar**: moved 🤖 Agent to Intelligence section below 📡 News & Research; moved 🔔 Alerts to the bottom of the menu (below 📋 Watchlists)

## [0.32.9] — 2026-06-07

### Changed
- **Sidebar**: merged ⚡ LEAPS and 🛡️ Collared LEAPS into 🔬 Strategy Lab as in-view tabs — reduces sidebar from 26 to 24 entries; LEAPS and Collared LEAPS are now tab buttons at the top of the Strategy Lab screen

## [0.32.8] — 2026-06-07

### Changed
- **Sidebar**: moved 📡 News & Research from the Screeners section to the Intelligence section, directly below 📅 Earnings

## [0.32.7] — 2026-06-07

### Changed
- **Scoring engine**: removed vestigial `phase2` signal infrastructure — the field existed in `ScoringSignal` but no current baseline used it; all `!s.phase2` guards removed from scoring-service, critic-service, daily-intelligence-brief-job, and TradeScoringView. The "Phase 2" section and badge in the Trade Scoring config UI are gone. All signals are now fully active or disabled by the user toggle with no hidden suppression.
- **Daily Brief AI model**: upgraded from `claude-haiku-4-5-20251001` to `claude-sonnet-4-6` for both the pick rationale synthesis (stage 5) and the AI Critic (stage 5b). Sonnet produces deeper second-order reasoning on signal interactions; cost estimate updated accordingly (~$3/M input, ~$15/M output).

## [0.31.5] — 2026-06-07

### Fixed
- Earnings Refresh Edit modal now shows correct default delay (500ms) instead of IV job's 1100ms
- `registerJob` now accepts `defaultConfig` option — seeded to DB on first registration, backfilled for existing rows where `config_json IS NULL` (upgrade path)

## [0.31.4] — 2026-06-07

### Changed — Earnings Refresh redesign
- **Universe**: now scans all unique tickers from `constituents` (S&P 500 + Russell 1000) instead of portfolio/watchlist/conviction only
- **Smart caching**: a ticker is skipped if it already has a *future* report_date stored — no re-fetch needed until that date passes. Only tickers with past/missing dates are refreshed each run
- **E*Trade only**: removed Polygon `analysis_snapshots` fallback — single source of truth, clearer failure mode
- **Rate limit**: configurable `callDelayMs` (default 500ms) in Edit modal, clamped 200–2000ms. Skipped tickers (cached) incur no delay — only tickers that actually call E*Trade
- **No-data clarity**: if E*Trade is not connected, job returns `skipped` with a message rather than looping 1,000 failed calls

## [0.31.3] — 2026-06-07

### Fixed
- Earnings Refresh: all tickers showed no-data due to a dead placeholder SQL query in `estimateFromPolygon` referencing `constituents.period_of_report_date` (column does not exist). SQLite validates column names at prepare() time even with WHERE 0. Removed the dead query; the analysis_snapshots fallback now runs correctly.

## [0.31.2] — 2026-06-07

### Changed
- Earnings Refresh is now a proper batch job visible in Batch Jobs screen (was a silent fire-and-forget in App.tsx)
- Runs on startup with 60s delay (after E*Trade tokens load) — respects 24h TTL so most launches are all-skips
- Manually triggerable via Run Now; shows per-ticker progress in live log
- Reverted silent App.tsx useEffect (v0.31.1) — batch job is the correct home

## [0.31.1] — 2026-06-07

### Fixed
- Earnings startup refresh (Earnings Refresh batch job) was missing — now fires on app open as a background task. 24h cache TTL means it is a no-op on most launches; only fetches stale or new tickers.

Reverse-chronological. Per spec EP-2.3, this is the index; per-version detail lives in `changelogs/`.

## v0.31.0 — 2026-06-07

Earnings Calendar: full feature shipping as v0.31.0. New migration 034, EarningsService (E*Trade FUNDAMENTAL quote primary, analysis-snapshot estimate fallback, manual override), IPC handlers, preload exposure. Dedicated "📅 Earnings" sidebar view with date groups, refresh, manual entry, and delete. Earnings warning banner in Validate view (fires when earnings ≤45 DTE from ticker selection). Earnings badge on Portfolio open positions (📅 with ! when before expiry). Payoff View: amber earnings annotation below P&L chart; Risk Matrix earnings column highlighted amber with 📅 icon.

## v0.30.7 — 2026-06-07

Risk Matrix critical fix: Black-Scholes was dividing leg.iv by 100 a second time. OptionContract.iv from the E*Trade chain is already a decimal fraction (0.38 = 38%), so the formula was computing sigma = 0.0038 (0.38% IV) instead of 38% — making all OTM options appear worthless and showing +$2.2k everywhere. Formula corrected to use leg.iv directly as sigma.

## v0.30.6 — 2026-06-07

Risk Matrix fix: when no options chain is loaded (manually-entered legs), intermediate date columns are now generated automatically as weekly synthetic intervals between today and the leg's expiry. Previously only the "Today" column existed, making time decay invisible. Synthetic column dates marked with ~ in the header. Footer now shows separate notices for synthetic columns and missing IV.

## v0.30.5 — 2026-06-07

Risk Matrix fix: strike rows now always include leg strikes and extend below them, even when the option strike is outside the ±25% spot range (e.g. TSLA CSP at $290 when stock is at $395). Previously all visible rows were above the strike showing only profit — now the table covers the full risk picture including losses below the strike. Leg strike rows highlighted in amber with "◀ strike" marker.

## v0.30.4 — 2026-06-07

Risk Matrix: click any cell to expand a per-leg breakdown panel showing each leg's entry price, current theoretical value, P&L, and action recommendation (Take profits / Consider closing / Close — loss exceeds premium / Watch / Hold). Click same cell or × to dismiss. Net P&L shown in header. Selected cell highlights blue.

## v0.30.3 — 2026-06-07

Payoff Visualizer: "📈 Chart / ⬛ Risk Matrix" toggle. Risk Matrix is a 2D P&L grid — rows are chain strike prices (±25% of spot), columns are Today + available chain expiry dates (all within 45 DTE; extends to 10 expiries for monthly-only chains). Pre-expiry cells computed via Black-Scholes (r=4.5%, IV from each leg; falls back to 30% when IV missing). Final column uses intrinsic-only math. Color-coded green→red, spot row highlighted, Zone label per row at expiry.

## v0.30.2 — 2026-06-07

Trade Management Alerts (ENH-5): collapsible "⚡ Trade Management" banner above the open positions table showing three rule-based alerts — Take Profits (≥50% gain via E*Trade totalGainPct), Manage Now (≤21 DTE), Delta Drift (|Δ| > 0.45). "View →" expands the relevant position row and scrolls to it. Pure frontend — no new backend code.

## v0.30.1 — 2026-06-07

Portfolio Greeks (ENH-3): "⚡ Refresh Greeks" button fetches live delta/theta/vega for all open CSP/CC positions from the options chain and writes them to the positions table. Portfolio Greeks bar now includes manually entered positions (not just E*Trade-synced ones). Short-position sign convention applied on write: positive theta/negative vega for premium sellers.

## v0.30.0 — 2026-06-07

Conviction List Phase 2: zone-entry toast notifications (FR-CV-01) when a stock transitions into Buy Zone, green count badge on the "⭐ My Stocks" sidebar item (FR-CV-03), and a "⚡ Conviction Alerts" section at the top of the Daily Brief listing any stocks currently in Buy or Mid zone (FR-CV-02).

## v0.27.0 — 2026-06-06

Payoff: InfoTip tooltip now flips to show below the trigger when the element is in the upper half of the viewport. Fixes the metrics bar tooltips being hidden under the title bar after the bar was moved to the top.

## v0.26.9 — 2026-06-06

Payoff layout: Max Profit, Max Loss, Breakeven, Net Credit/Debit, Δ, Θ, V now fit in a single compact horizontal bar above the chart. Chart height reduced (SVG 160→120, tighter padding). Options chain drawer reduced from 70vh to 45vh so chart remains visible below it.

## v0.26.8 — 2026-06-06

Payoff chart: hover tooltip. Mouse over shows a vertical crosshair, a dot on the P&L curve at that price, a faint horizontal hairline, and a tooltip box with exact price and P&L value (color-coded green/red). Tooltip flips to the opposite side when the cursor is in the right half of the chart.

## v0.26.7 — 2026-06-06

Payoff Visualizer: leg strikes are now click-to-edit (underlined, same UX as premium). Changing a sell leg strike snaps to the nearest real chain contract and updates premium + Greeks. For lizard strategies (Jade/Big/Reverse), changing any sell leg automatically recalculates the buy hedge strike using the credit ≥ spread width rule.

## v0.26.6 — 2026-06-06

Jade/Big/Reverse Lizard hedge leg selection: all three layers (Strategy Lab, Payoff auto-fill, Payoff reload) now select the buy call/put at the FURTHEST available strike where `credit ≥ spread width`, guaranteeing no upside/downside risk. Previously all three used nearest-to-percentage-of-spot, which could overshoot the credit due to $5 strike increments. Falls back to nearest OTM when no valid strike exists. `fillLegsFromChain` utility DRYs out Payoff template fill and reload logic.

## v0.26.5 — 2026-06-06

Payoff Visualizer: (1) Strategy Formula Panel — below the recognition badge, shows the key tastytrade rules for the detected strategy with actual computed values and ✓/✗ pass/fail. Covers Jade Lizard, Big Lizard, Reverse variants, Iron Condor, Iron Fly, Short Strangle/Straddle, CSP, Covered Call, vertical spreads, Bull/Bear spreads. (2) Reload Strategy button — appears at the top of the legs section when a template was applied and a chain expiry is selected; re-snaps all legs to the selected expiry using live mid-prices.

## v0.26.4 — 2026-06-06

Payoff Visualizer: fix false "∞ loss" on short-put strategies (CSP, Big Lizard, Jade Lizard, Short Straddle downside, etc.). Max loss is now computed at stock price = $0 (the true floor) rather than the chart's 50% boundary. Left-side slope removed from unlimited detection — stock cannot go below $0 so downside is always bounded. Right-side slope detection preserved for genuinely unlimited positions (naked short calls, short stock). Also fixes false "∞ profit" on long puts.

## v0.26.3 — 2026-06-06

Payoff template selection: spot price is no longer required when a ticker is set. Chain load provides the live spot automatically. Error message updated: only fires when both ticker and spot are absent.

## v0.26.2 — 2026-06-06

Payoff Visualizer: selecting a strategy template now auto-fills real premiums from the live chain when a ticker is set. Skeleton legs appear immediately; chain loads in background; each leg is snapped to the nearest real Friday expiry for that DTE and filled with the live mid-price + Greeks. Spot price updates to chain's live price. Chain panel opens automatically.

## v0.26.1 — 2026-06-06

Payoff Visualizer: templates section replaced with a grouped dropdown covering all 31 Strategy Lab strategies (Jade Lizard, Big Lizard, Reverse variants, Iron Fly, Zebras, Front Ratios, Butterflies, PMCC/PMCP, Calendars, etc.). `recognizeStrategy` expanded to identify all new structures including 3-leg lizard variants, zebras, front ratios, butterfly families (standard + broken-wing), calendar spreads, Poor Man's covered positions, and Short/Long Straddle/Strangle disambiguation.

## v0.26.0 — 2026-06-06

AI Critic — second-opinion engine for the Daily Brief. Every pick now gets a `pass / caution / flag` verdict from an adversarially-prompted Claude haiku call, backed by 6 deterministic rule checks (trend alignment, liquidity, missing signals, score concentration, cross-strategy conflict, market regime). Verdict badge shown inline on each pick card in the Brief UI with expandable flags and rationale. Strategy section headers show aggregate counts. Email now includes a Critic column. See `Requirements/ai-critic.md` for full spec.

## v0.25.0 — 2026-06-05

Options Snapshot now runs against the full S&P 500 + Russell 1000 universe (~1,100 tickers) instead of the top 300. At confirmed 0.57s/ticker this takes ~10-11 min — same as before the performance work but now covers all tickers, giving the Daily Brief `annualizedReturn` and `optionLiquidityScore` for every candidate rather than just the top 300 by IV rank.

## v0.24.9 — 2026-06-05

Options Snapshot speed fix (root cause found): `modeWheel` was making up to 9 E*Trade/Polygon calls per ticker. Two fixes: (1) `findSuitableChain` now checks DTE before calling `getOptionsChain` — cuts from 7 chain fetches to 1-2 per ticker since only the last 1-2 of the 7 generated Fridays fall in the 30-45 DTE window; (2) `forceCache=true` skips `getOptionsIV` (uses `iv_history.atm_iv` instead) and `getEarningsCalendar` (always returns null). Expected: ~2 E*Trade calls/ticker instead of ~9 → similar speed to IV Update.

## v0.24.8 — 2026-06-05

Options Snapshot: bypass Polygon API calls when run as a batch job. `analyzeTicker` now accepts `forceCache: true` which reads quote, fundamentals, and price bars directly from the local DB instead of making 3 Polygon API calls per ticker. Market Sync runs earlier in the sequence so the data is already warm. Eliminates the rate-limiter wait per ticker — expect ~0.4s/ticker vs ~2s/ticker (~4 min for 300 tickers vs ~10 min).

## v0.24.7 — 2026-06-05

Configurable call delay extended to Daily Options Snapshot (same 200–2000ms range, default 1100ms). Edit Job modal shows E*Trade Rate Limit section and run-time estimate for both IV Update and Options Snapshot.

## v0.24.6 — 2026-06-05

PERF-8: Fixed Options Snapshot candidate sort order regression (v0.24.4 introduced alphabetical ordering). Now sorts by most recent IV (atm_iv DESC) → buy_signal_score DESC → alphabetical, so the 300-ticker cap covers the most premium-rich candidates first.

## v0.24.5 — 2026-06-05

PERF-1: IV Update call delay is now configurable in the Edit Job modal (200–2000ms, default 1100ms). Shows live run-time estimate as you adjust. Migration 028 adds `config_json` to `batch_jobs` for per-job settings.

## v0.24.4 — 2026-06-05

Daily Brief and Options Snapshot now score the full S&P 500 + Russell 1000 + ETF universe directly instead of reading from screener results. Scoring engine handles quality ranking per strategy — removes Bearish blind spot and eliminates stale-screener dependency. Daily Screener job still runs for the Screener UI. See [`changelogs/v0.24.4_2026-06-05.md`](changelogs/v0.24.4_2026-06-05.md).

## v0.24.3 — 2026-06-05

New Daily Screener batch job (PERF-7): runs after Market Sync to keep `screen_results` fresh. Two passes — stocks (S&P 500 + Russell 1000, strict, default preset) and ETFs (soft, volume ≥ 500 k + price ≥ $10). Daily Brief and Options Snapshot now merge all today's screener runs instead of reading a potentially stale single row. See [`changelogs/v0.24.3_2026-06-05.md`](changelogs/v0.24.3_2026-06-05.md).

## v0.23.4 — 2026-06-04

Sidebar: Trade Scoring (⚖) moved from Intelligence to Data section, directly below Settings. See [`changelogs/v0.23.4_2026-06-04.md`](changelogs/v0.23.4_2026-06-04.md).

## v0.23.3 — 2026-06-04

E*Trade OAuth split into two non-interactive scripts for Claude Code on phone. `etrade-step1.mjs` fetches request token + prints auth URL + saves state. `etrade-step2.mjs <verifier>` completes the exchange — verifier passed as CLI arg, no readline needed. Original `etrade-login.mjs` kept for direct SSH terminal use. See [`changelogs/v0.23.3_2026-06-04.md`](changelogs/v0.23.3_2026-06-04.md).

## v0.23.2 — 2026-06-04

E*Trade remote token refresh via SSH from phone. New `scripts/etrade-login.mjs` does the full OAuth 1.0a flow in a terminal — reads consumer creds from the running app API (or `~/.tradeanalyzer/etrade-config.json` as fallback), prompts for verifier code, stores tokens immediately if app is running or writes a pending file imported on next launch. New API endpoints `GET /api/v1/etrade/credentials` + `POST /api/v1/etrade/token`. `api-server.ts` now writes `etrade-config.json` and imports pending tokens on every startup. See [`changelogs/v0.23.2_2026-06-04.md`](changelogs/v0.23.2_2026-06-04.md).

## v0.23.1 — 2026-06-04

Two fixes surfaced by Retrospect showing false negatives on day-0 paper trades:

**Retrospect day-0 verdict suppression**: open positions now show Neutral / Hold on day 0 (no full trading day elapsed). Previously `historical_prices` close (updated by the gap-fill job) could predate the brief's captured entry price, making any return % a data-freshness artefact rather than real price movement. Verdict and estimated P&L are now suppressed until `daysHeld ≥ 1`.

**`recentVolatility` scoring signal (Income + Wheel)**: new signal measuring 20-day annualized realized volatility from `historical_prices` (std dev of log returns × √252). `lower_better` — a stock making large recent moves (e.g. ADBE up 16% in 20 days) is a poor candidate for a short strangle or CSP. Income weight 20 (taken from ivRank/premiumRiskRatio/trendNeutral/optionLiquidity); Wheel weight 10. Baseline bumped to `baseline_v2` — existing configs need **Reset to Baseline** in Trade Scoring to pick up the new signal. Signal label `recentVolatility` added to DailyBriefView chip renderer.

## v0.23.0 — 2026-06-03

Paper Trading / Retrospect — closed-loop validation for the Daily Intelligence Brief. Every brief run now auto-captures all post-liquidity-gate picks as paper trades (server-side, no user action required). Unique key `(ticker, brief_strategy, brief_date)` means same-day re-runs update existing records rather than duplicate. New **🔍 Retrospect** screen (Intelligence section) with four tabs: **In Progress** (open positions grouped by brief date, with stock return %, delta-based estimated P&L, Positive/Negative/Neutral verdict, Hold/Close Signal recommendation, expandable legs detail, Close and Delete actions), **Summary** (win rate per strategy, avg return, best/worst trade, strategy accuracy table), **History** (closed/expired trades with outcomes), **Settings** (per-strategy thresholds for negative definition and Close Signal triggers — all configurable, sensible defaults applied). Positions auto-expire on view load when expiry date has passed; exit price auto-filled from `historical_prices`. Daily Brief history bar now shows brief accuracy chip (e.g. `71%`) next to each date when ≥ 3 closed picks exist; selecting a historical date shows an inline accuracy banner. No new Polygon API calls. Migration 025. See [`changelogs/v0.23.0_2026-06-03.md`](changelogs/v0.23.0_2026-06-03.md).

## v0.22.31 — 2026-06-03

Daily Brief email fixes: (1) Strategy order now matches the screen (`wheel → bullish → bearish → income → buy`). (2) "Score" column replaced with "Lab Score" (Strategy Lab `totalScore` 0-100, same system as the grade) instead of `compositeScore` (scoring engine rank used to select picks — a different system causing confusing mismatches like Grade A with Score 18). Both email and PDF updated. See [`changelogs/v0.22.31_2026-06-03.md`](changelogs/v0.22.31_2026-06-03.md).

## v0.22.30 — 2026-06-03

Fix Daily Brief showing stale data from earlier same-day runs. `persistBrief` now deletes all existing records for the same strategy on the same ET day before inserting, so each run is a clean replacement. Fixes mixed-run display (UI showing 2+4 from run 1 while email showed 5+5 from run 2) and the history view inconsistency where selecting today showed different data than the default latest view. DST-safe: uses JS `toLocaleDateString('en-CA', {timeZone: 'America/New_York'})` for the comparison. See [`changelogs/v0.22.30_2026-06-03.md`](changelogs/v0.22.30_2026-06-03.md).

## v0.22.29 — 2026-06-03

Fix two Daily Brief bugs: (1) Email showed 25 picks (pre-liquidity-gate) while UI showed 19 (post-gate) — email now uses the same `persistedPicks` map built from `liquidFiltered` data. (2) Brief history showed tomorrow's date (e.g. 6/4 for a run at 10:30pm ET on 6/3) because `generated_at` is UTC and `.slice(0,10)` gave the UTC date — fixed with `toETDate()` converting to ET before display and grouping. See [`changelogs/v0.22.29_2026-06-03.md`](changelogs/v0.22.29_2026-06-03.md).

## v0.22.28 — 2026-06-03

Daily Intelligence Brief: email delivery with PDF attachment. After the brief is generated, an HTML email is sent with trade-ready tables (ticker, grade, structure, strike, expiry, DTE, credit/debit, ann. return, POP, max loss) and a full PDF is attached (all 25 picks, complete AI rationale, signal breakdown). Uses existing SMTP config from Agent Config → Email. Email failure does not fail the job. New: `EmailService`, `BriefReportBuilder`, `pdfkit` dependency. See [`changelogs/v0.22.28_2026-06-03.md`](changelogs/v0.22.28_2026-06-03.md).

## v0.22.27 — 2026-06-03

Fix batch job stuck on "Running" with non-functional cancel. Two root causes: (1) stale `running` DB state from crashed/killed sessions — fixed by cleaning up `batch_runs` and `batch_jobs` in `BatchService` constructor on every startup. (2) `cancelJob` only signalled the abort but never updated the DB, so the UI never changed until the hung Promise settled — fixed by immediately writing `cancelled` to the DB and freeing `runningJobId` in `cancelJob`, with a guard in `runJob` to skip the final DB write if the signal was aborted. See [`changelogs/v0.22.27_2026-06-03.md`](changelogs/v0.22.27_2026-06-03.md).

## v0.22.26 — 2026-06-03

Daily Options Snapshot + Daily Intelligence Brief: graceful skip when options provider is unavailable. Both jobs now probe `getOptionsExpirations('SPY')` before doing any work. Expired E*Trade token (or any connectivity failure) returns `status: 'skipped'` with a clear reconnect message instead of timing out on every ticker. `DailyOptionsSnapshotJob` now takes `OptionsProvider` as a constructor arg. See [`changelogs/v0.22.26_2026-06-03.md`](changelogs/v0.22.26_2026-06-03.md).

## v0.22.25 — 2026-06-03

Fix Daily Options Snapshot stuck on "Running". Added a 30-second per-ticker timeout (`withTimeout`) around each `analyzeTicker` call. An expired E*Trade token (or any hung HTTP call) was causing the job to hang indefinitely on the first ticker with no way to recover. Timed-out tickers now count as failed and the loop moves on. See [`changelogs/v0.22.25_2026-06-03.md`](changelogs/v0.22.25_2026-06-03.md).

## v0.22.24 — 2026-06-03

Daily IV Capture: overwrite on every run. Removed the "already done today" skip so each run captures the latest snapshot and the 4:30pm job always writes EOD data. `storeReading()` already uses `ON CONFLICT DO UPDATE` so no schema change needed. Supports multiple intraday runs within the 10,000 credit/day MarketData.app limit (~1,500 credits per run). See [`changelogs/v0.22.24_2026-06-03.md`](changelogs/v0.22.24_2026-06-03.md).

## v0.22.23 — 2026-06-03

Daily IV Capture job switched from E*Trade to MarketData.app. Job now runs fully unattended — no OAuth token, no midnight expiry. Calls `getLiveChain(ticker, nearestMonthlyExpFor30Dte())` (single API call per ticker, `?expiration=` param), computes ATM IV inline, stores with `source='marketdata'`. E*Trade code untouched — only `DailyIvCaptureJob` and its constructor wiring in `index.ts` changed. See [`changelogs/v0.22.23_2026-06-03.md`](changelogs/v0.22.23_2026-06-03.md).

## v0.22.22 — 2026-06-03

Test API: MarketData.app live chain support. New **Live (today)** mode on the MarketData.app tab uses `?expiration=` instead of `?date=` (historical-only param that was causing 400 errors). Auto-selects the nearest monthly 3rd-Friday expiration to 30 DTE. New `getLiveChain()` / `getRawLiveChain()` methods on `MarketDataProvider`; `nearestMonthlyExpFor30Dte()` helper exported. New `test-api:get-marketdata-live-chain` IPC handler + `getMarketDataLiveChain` preload bridge. See [`changelogs/v0.22.22_2026-06-03.md`](changelogs/v0.22.22_2026-06-03.md).

## v0.22.21 — 2026-06-02

Quality signals wired into the Trade Scoring Engine and Daily Brief. `scoreFundamentals()` now uses ROIC and FCFToNetIncome alongside ROE/margin/growth. `computeEarningsGrowthScore()` blends 1Y and 5Y CAGR (1.5× weight on 5Y). Four new explicit scoring signals: `leverageQuality` (Wheel, wt 8), `leverageRisk` (Bearish, wt 8), `revenueGrowth5Y` (Bullish wt 10, Buy wt 10), `epsGrowth5Y` (Buy wt 8). AI rationales can now mention ROIC, FCF quality, and 5-year growth context. Note: existing strategy configs in DB are not auto-updated (INSERT OR IGNORE) — call Reset to Baseline in the Scoring Config UI to pick up new signals. See [`changelogs/v0.22.21_2026-06-02.md`](changelogs/v0.22.21_2026-06-02.md).

## v0.22.20 — 2026-06-02

WheelMetrics quality signals — FCFToNetIncome, ROIC, NetDebtToEBITDA, 5-year revenue/EPS CAGR, and VS/GS composite scores with StockGrade added to the fundamentals pipeline. All metrics computed from existing Polygon `/vX/reference/financials` data (no new API calls); quarterly filings limit bumped to 24 (≈6 years) for 5Y CAGR. New screener columns with star grade renderer. See [`changelogs/v0.22.20_2026-06-02.md`](changelogs/v0.22.20_2026-06-02.md).

## v0.22.19 — 2026-06-01

Phase 2 scoring signals — Relative Strength vs SPY + Sector Momentum. Four new signals wired into the Trade Scoring Engine from `historical_prices` only (no new API calls): `relativeStrength` (Bullish wt 15, Buy wt 20), `relativeWeakness` (Bearish wt 15), `sectorMomentum` (Bullish wt 10, Buy wt 10), `sectorWeakness` (Bearish wt 10). `PriceGapFillJob` now bootstraps SPY + 11 SPDR sector ETFs with 6M bars before the main stale-ticker pass so reference data is always available. Sector lookup uses `ScreenResultPayload.sector` → GICS→SPDR map. Relative strength = 90-day excess return vs SPY; sector momentum = 90-day return of the ticker's sector ETF. See [`changelogs/v0.22.19_2026-06-01.md`](changelogs/v0.22.19_2026-06-01.md).

## v0.22.18 — 2026-06-01

Daily Options Snapshot batch job — nightly Wheel analysis run on the top 300 screener candidates to keep `optionLiquidityScore` in `analysis_snapshots` current. Scheduled at 06:00 ET + on startup (5-min delay). Migration 024 makes `analysis_snapshots.watchlist_id` nullable so the batch snapshot has no watchlist affiliation. See [`changelogs/v0.22.18_2026-06-01.md`](changelogs/v0.22.18_2026-06-01.md).

## v0.22.17 — 2026-06-01

Nav: Data Sync moved to Misc (between Test API and History); Batch Jobs is now the default landing page on app launch. Data section simplified to Settings + Batch Jobs. See [`changelogs/v0.22.17_2026-06-01.md`](changelogs/v0.22.17_2026-06-01.md).

## v0.22.16 — 2026-06-01

Trade Scoring Config — full UI redesign. Pill strategy tabs with emoji, scrollable 4-column signal table (toggle, label+direction badge, weight+bar, rationale), Phase 2 divider, green/red total row, sticky footer with version input and Save/Reset buttons. See [`changelogs/v0.22.16_2026-06-01.md`](changelogs/v0.22.16_2026-06-01.md).

## v0.22.15 — 2026-06-01

Daily Brief — hard liquidity gate and specific setup details on pick cards. Picks are now dropped in Stage 6 if the best relevant Strategy Lab structure has `liquidityScore < 5` (catches OI=1 + wide spreads, threshold ≈ 3). Progress message reports gated count. Pick cards now show a second line under the grade badge: `$240 · Jul 17 · $3.25 cr` — the exact strike, expiry, and net premium from the Strategy Lab setup. See [`changelogs/v0.22.15_2026-06-01.md`](changelogs/v0.22.15_2026-06-01.md).

## v0.22.14 — 2026-06-01

Fix Payoff Assess Trade — AI was reading the expiry year (`2026`) as the DTE value, producing responses like *"long 2026 DTE provides ample theta runway"*. DTE is now computed from `leg.expiry` and injected into the prompt as `expiry 2026-07-17 (45 DTE)`. See [`changelogs/v0.22.14_2026-06-01.md`](changelogs/v0.22.14_2026-06-01.md).

## v0.22.13 — 2026-06-01

Daily Brief — Payoff, Validate, and Options quick-nav buttons on pick cards. Each card now has a compact row of three buttons: **📊 Payoff** opens the Payoff Visualizer pre-loaded with the Strategy Lab legs (slug, expiry, all option strikes/premiums/deltas); **✓ Validate** opens the Validate tab for the ticker; **📋 Options** opens the Options Chain pre-filtered to the expiry that Strategy Lab used. All three use the existing `navigate-to-*` CustomEvent deep-link system. See [`changelogs/v0.22.13_2026-06-01.md`](changelogs/v0.22.13_2026-06-01.md).

## v0.22.12 — 2026-06-01

Daily Brief — stock price and Wheel capital requirement on pick cards. Each pick now shows the last known price (`$245.30`). Wheel picks additionally show the CSP buying-power requirement (`~$24,530 cap` = price × 100) so you can gauge capital needs before opening Strategy Lab. `BriefPick.price` added to shared types; populated from `signalData.lastPrice` in the brief job at no extra DB cost. See [`changelogs/v0.22.12_2026-06-01.md`](changelogs/v0.22.12_2026-06-01.md).

## v0.22.11 — 2026-06-01

Fix Strategy Lab scrolling. Root div had no `overflow-y: auto` so `.main`'s `overflow: hidden` clipped the list after ~6–8 rows — C/F grades were rendered but unreachable. Added `overflowY: auto` + `height: 100%` to the root container. See [`changelogs/v0.22.11_2026-06-01.md`](changelogs/v0.22.11_2026-06-01.md).

## v0.22.10 — 2026-06-01

Daily Brief — Strategy Lab grade alignment on pick cards. Each validated pick now shows the grade for the strategy-relevant structure (e.g. `CSP  B`) and the best overall fit when they differ (e.g. `·  Best fit: Reverse Big Lizard  A+`). Makes the gap between stock-level scoring and live-chain execution immediately visible. See [`changelogs/v0.22.10_2026-06-01.md`](changelogs/v0.22.10_2026-06-01.md).

## v0.22.9 — 2026-06-01

Daily Intelligence Brief UI redesign. Previous layout had zero CSS — signal labels, scores, and badges were unstyled inline text. New design: bordered rounded strategy sections with collapsible headers (emoji prefix, pick count pill), two-column pick cards (circular rank badge | ticker · score badge · Validated chip · Strategy Lab button), signal chips with human-readable labels and smart value formatting, italic AI rationale with left-border accent. See [`changelogs/v0.22.9_2026-06-01.md`](changelogs/v0.22.9_2026-06-01.md).

## v0.22.8 — 2026-06-01

Daily Technical Signals batch job. New `DailyTechnicalSignalsJob` runs nightly after price-gap-fill — reads `historical_prices`, computes MACD, RSI, Bollinger Bands, SMA stack, candlestick patterns, and a `buySignalScore` (0–100, mirrors Validate screen logic), then upserts to a new `technical_signals` table. `ScoringService` now reads `buySignalScore` from this table, enabling the scoring engine to include buy-signal strength as a signal for the **Buy** (weight 20) and **Bullish** (weight 15) strategies without any live API calls. See [`changelogs/v0.22.8_2026-06-01.md`](changelogs/v0.22.8_2026-06-01.md).

## v0.22.7 — 2026-06-01

Daily Intelligence Brief & Trade Scoring Engine. New capability: configurable per-strategy scoring engine (5 strategies × expert-backed weights) + post-market batch job that screens the universe, scores candidates, validates top picks via E*Trade Strategy Lab, synthesizes AI rationale (Claude Haiku), and persists a dated brief. Two new sidebar views: **Daily Brief** (ranked picks per strategy, AI rationale, → Strategy Lab button, history dropdown) and **Trade Scoring Config** (weight sliders, signal toggles, version labels, Reset to Baseline). Two new computed signal fields: `priceMomentumPct` (52-week return from `historical_prices`) and `breakoutScore` (MA alignment + price near support). Phase 2 signal slots (`relativeStrengthVsSpy`, `sectorMomentum`) reserved in config as disabled placeholders. See [`changelogs/v0.22.7_2026-06-01.md`](changelogs/v0.22.7_2026-06-01.md).

## v0.22.6 — 2026-06-01

Batch Jobs sequence order — move to edit modal. Removed ▲/▼ buttons from the job table. The `#` column now shows the sequence number read-only. Sequence order is editable as a number field in the Edit Job modal (min 1). Saving updates the single job's `sequence_order` via `updateJobConfig` (no full-list reorder required). See [`changelogs/v0.22.6_2026-06-01.md`](changelogs/v0.22.6_2026-06-01.md).

## v0.22.5 — 2026-06-01

Fix Daily IV Update batch job — all tickers returned "no-data". Two bugs: (1) `etrade-options.ts` looked for `currentPrice` in `OptionChainResponse` but E*Trade returns the underlying price as `nearPrice` — so `underlyingPrice` was always `null`, causing `captureFromEtradeChain` to bail out immediately on every ticker. Fixed by checking `nearPrice` first with `currentPrice` as fallback. (2) `OptionContract.iv` is a decimal fraction (0.285 = 28.5%) but `captureFromEtradeChain` passed it straight to `computeAtmIv` with a wrong "already a percentage" comment — stored IV values would have been 100× too small. Fixed by multiplying by 100 when mapping. See [`changelogs/v0.22.5_2026-06-01.md`](changelogs/v0.22.5_2026-06-01.md).

## v0.22.4 — 2026-06-01

Batch Jobs sequence ordering. Jobs now have a `sequence_order` field; jobs with the same schedule run in that order. `BatchView` job table gains a `#` column with ▲/▼ buttons to move jobs up or down — changes persist to the DB immediately. New migration `021_batch_sequence.sql` adds the column (existing rows numbered by insertion order). `BatchService.reorderJobs(jobIds[])` writes new positions; `batch:reorder` IPC + `window.api.batch.reorderJobs` preload bridge expose it to the renderer. See [`changelogs/v0.22.4_2026-06-01.md`](changelogs/v0.22.4_2026-06-01.md).

## v0.22.3 — 2026-06-01

Single instance lock. Clicking the shortcut while TradeAnalyzer is already running now focuses the existing window instead of launching a second copy. Uses `app.requestSingleInstanceLock()` + `second-instance` event. See [`changelogs/v0.22.3_2026-06-01.md`](changelogs/v0.22.3_2026-06-01.md).

## v0.22.2 — 2026-06-01

Analysis sidebar order + per-tab default sort + Options Income extra columns. **Sidebar:** 📊 Analysis moved above 🔬 Strategy Lab. **Default sort:** Buy → Score desc; Options Income → Premium desc; Wheel → Suitability desc; Bullish/Bearish → Max Loss desc — applied on every tab switch and after each run. **Options Income:** three new columns — Bid, Ask, OI (open interest) — pulled from the selected contract; `OptionsIncomeResult` type and analysis service updated. See [`changelogs/v0.22.2_2026-06-01.md`](changelogs/v0.22.2_2026-06-01.md).

## v0.22.1 — 2026-06-01

Batch Jobs global session toggle. New toggle switch in `BatchView` header enables/disables all automatic batch jobs (startup + scheduled) for the current session. Defaults ON on every launch — never persists. Manual "Run Now" is unaffected. Amber warning banner shown when disabled. See [`changelogs/v0.22.1_2026-06-01.md`](changelogs/v0.22.1_2026-06-01.md).

## v0.22.0 — 2026-06-01

Analysis Engine redesign — one-click runs all 5 modes in sequence. Mode selector removed; replaced with strategy tabs (📈 Buy / 💰 Options Income / 🎯 Wheel / 🐂 Bullish / 🐻 Bearish) that populate after run. Snapshots moved below results, newest first, with per-row delete and Clear All. Each run saves a single combined snapshot (`mode='all'`) containing all 5 mode outputs. New backend: `analyzeWatchlistAllModes()`, `saveAllModesSnapshot()`, `getAllModesSnapshot()` in analysis service; `analysis:run-all` and `analysis:get-all-modes-snapshot` IPC handlers; `runAll`/`getAllModesSnapshot` on `window.api.analysis`. Progress events now include `mode` field. See [`changelogs/v0.22.0_2026-06-01.md`](changelogs/v0.22.0_2026-06-01.md).

## v0.21.1 — 2026-06-01

Batch Jobs UI — moved Run History above Live Activity panel so completed run data is visible without scrolling past the (conditionally shown) live log. See [`changelogs/v0.21.1_2026-06-01.md`](changelogs/v0.21.1_2026-06-01.md).

## v0.21.0 — 2026-06-01

Automated Batch Jobs + Live Progress Log. Three daily background jobs now run automatically: **Daily Market Sync (Stocks)** — runs `screenerService.syncUniverse('both')` at startup (+60s) and 16:30 ET; **Daily Market Sync (ETFs)** — same for the ETF universe (+90s); **Daily Price Gap Fill** — detects tickers missing recent price history and backfills via Polygon (+120s). All three chain sequentially under the existing `BatchService` scheduler. `DailyIvCaptureJob` now auto-renews dormant E*Trade tokens and surfaces a "Reconnect" CTA notification when the midnight-rollover token must be re-authed manually. `BatchView` gains a **Live Activity** panel — streaming per-ticker log with spinner header, animated progress bar, live counters (✓ updated / — skipped / ✗ failed), monospace ticker log (max 300 events, auto-scroll, auto-clears 3s after job completes). App auto-launches on Windows login. Production DB path fixed for packaged exe (`app.getPath('userData')`). `npm run package` fixed: `CSC_IDENTITY_AUTO_DISCOVERY=false` + `win.forceCodeSigning: false` prevent winCodeSign symlink errors; Windows Developer Mode required (one-time). See [`changelogs/v0.21.0_2026-06-01.md`](changelogs/v0.21.0_2026-06-01.md).

## v0.20.0 — 2026-05-31

Strategy Lab — score and explore all 31 tastylive option strategies for any single ticker using entirely fresh live data (no cache). New **🔬 Strategy Lab** sidebar entry in the Strategy section, just above 📚 Knowledge. Two tabs: **Validate** (scores all 31 strategies — IV score, direction score, premium score, liquidity score → letter grade A+/A/B/C/F, sorted best first) and **Explore** (pick any strategy + ticker → build the concrete setup with legs, strikes, P&L summary). Live data path: fresh 90-day bars for direction bias (MA20/MA50), live `getOptionsExpirations` + `getOptionsChain` for the nearest 20–50 DTE expiry, and `iv_history` table for IV rank/percentile. Each strategy card shows expandable score bars, condition flags (✓/~✗), leg table, and action buttons: **→ Explore Strategy** (cross-tab navigation), **📈 View in Payoff** (fires existing `navigate-to-payoff` event), **✨ AI Rationale** (cost-conscious on-demand Claude haiku call ~$0.003–0.005/click). New service `StrategyLabService` with `validate()`, `explore()`, `getContext()`. New IPC file `ipc-strategy-lab.ts` with handlers `strategyLab:validate`, `strategyLab:explore`, `strategyLab:aiRationale`. All 31 strategy types added to `shared/types.ts`. See [`changelogs/v0.20.0_2026-05-31.md`](changelogs/v0.20.0_2026-05-31.md).

## v0.19.2 — 2026-05-31

History screen overhaul + price bulk load. "IV History" sidebar entry renamed to **"History"**. The Gap Fill run button removed from the History screen (it already existed in Data Sync section 3). **History screen** now hosts two sections: IV (key status, coverage summary with gap count, Step 1/2 initial load) and Price History (new Bulk Price Load — fetches 2Y daily OHLCV bars for S&P 500 / Russell 1000 / Both via Polygon, universe selector, progress bar, cancelable, coverage count displayed). **Data Sync** gains section 5 **Price Gap Fill** — finds all tickers already in `historical_prices` whose latest bar is >2 days old and refreshes the last month for each; stale count shown with a ↻ Check button. Three new IPC handlers: `historical:getUniverseTickers`, `historical:getStalePriceTickers`, `historical:getPriceTickerCount`. See [`changelogs/v0.19.2_2026-05-31.md`](changelogs/v0.19.2_2026-05-31.md).

## v0.19.1 — 2026-05-31

Closed positions sync from E*Trade transaction history. New **↓ Import Closed (YTD)** button on the Portfolio Closed tab. `EtradePortfolioService.syncClosedPositions()` fetches the full YTD transaction history via `/v1/accounts/{id}/transactions` (paginated, marker-based), classifies each transaction as open/close/expired/assigned using OCC symbol parsing, pairs open+close legs FIFO per symbol, and inserts matched closed positions into the local DB with dedup guard (ticker + position_type + entry_date + exit_date). New `portfolio:etrade:sync-closed` IPC handler + `window.api.portfolio.etrade.syncClosed()` preload bridge. See [`changelogs/v0.19.1_2026-05-31.md`](changelogs/v0.19.1_2026-05-31.md).

## v0.19.0 — 2026-05-31

Knowledge Base — tastylive strategy guide (TT1469) embedded as a quick-reference view. New `📚 Knowledge` sidebar entry at the bottom of the Strategy section. 31 option strategies extracted from the PDF across 6 categories (Bullish, Bearish, Omnidirectional, Neutral, Neutral-Bullish, Neutral-Bearish). Each strategy stored as a high-resolution PNG (150 DPI) and a structured JSON one-pager in `src/renderer/src/knowledge/`. `KnowledgeView` with collapsible left drawer (search + categorized strategy list with colored section labels and active-highlight), and a content panel with **🖼 Image / 📄 Text** toggle. Image mode shows the original PDF page exactly. Text mode renders structured layout: key params (Direction, IV, DTE, PoP), setup steps, risk/reward grid, Greeks row (color-coded Long/Short/Flat/Dynamic), How It Works cards (Ideal / Not Ideal / Defensive Tactics), Volatility 2-col grid, At Expiration cards, and Takeaways. Sidebar reorganized into labeled sections (Data / Analysis / Strategy / Settings / Personal). See [`changelogs/v0.19.0_2026-05-31.md`](changelogs/v0.19.0_2026-05-31.md).

## v0.18.2 — 2026-05-31

ENH-3 Portfolio Greeks Monitor. Aggregate Greeks summary bar added to `PortfolioView`, visible whenever open positions exist. Shows **Net Δ** (sum of position deltas, stock + options), **Θ/day** (daily theta income in dollars, options only), **Vega** (aggregate vega, options only), **BP Used %** (capital deployed / configured account size — hidden until account size is set), and **Expiration buckets** (count of positions expiring ≤7d / ≤14d / ≤21d, color-coded red/amber/gray). Greeks sourced from existing `PositionEtrade` E*Trade sync data — no new API calls. `accountSize` added to `AppSettings` (default 0); inline "Set account size" prompt saves via `settings.setAll`. Formula documented at `docs/formulas.md#portfolio-greeks`. See [`changelogs/v0.18.2_2026-05-31.md`](changelogs/v0.18.2_2026-05-31.md).

## v0.18.1 — 2026-05-30

**Bug fix: `atm_iv` stored as decimal fraction instead of percentage.** IVolatility API returns IV as decimal fractions (0.285 = 28.5%). The ingest path in `IvHistoryService.backfillIvHistory()` was storing them raw, and the E*Trade auto-capture path was explicitly dividing `OptionContract.iv` (already a %) by 100 before `computeAtmIv`, producing a decimal result. Both paths now store percentages: IVolatility reads are multiplied × 100 before `storeReading()`; E*Trade reads pass `c.iv` directly (no division). Migration 017 (`UPDATE iv_history SET atm_iv = atm_iv * 100`) converts all previously stored decimal rows to percentages. The `Curr IV` column in the Opportunity Dashboard now shows e.g. `30%` instead of `0.3%`. See [`changelogs/v0.18.1_2026-05-30.md`](changelogs/v0.18.1_2026-05-30.md).

## v0.18.0 — 2026-05-30

ENH-2 Opportunity Dashboard. Removed Morning Briefing screen. New `🎯 Opportunity` sidebar view with composite scoring engine: fundamentals 25% (ROE, P/E, D/E, margin, revenue growth) + IV rank 30% + technical 25% (from analysis snapshots) + premium yield 20% (estimated 1.5%/mo). Strategy mode selector (Wheel / CSP / Spreads / Bullish / Bearish) — premium-selling modes rank high IV as favorable; directional modes invert the score. Universe selector (S&P 500 / Russell 1000 / Both). All data pulled from local DB (quote cache, iv_history, screen_results, analysis_snapshots) — no additional API calls. `OpportunityService` with batch SQL queries for IV ranks (one window-function query for entire universe), quote cache lookup, latest screen fundamentals, and latest analysis snapshot scores. `ipc-opportunity.ts` + `window.api.opportunity.run()` preload bridge. `OpportunityView` with score circles, mini score bars, IV rank badges, one-click drill-in to Analysis and Options Chain views. See [`changelogs/v0.18.0_2026-05-30.md`](changelogs/v0.18.0_2026-05-30.md).

## v0.17.0 — 2026-05-30

IV History feature — true IV rank and IV percentile from 252 days of daily 30-day constant-maturity ATM IV. New `iv_history` SQLite table (migration 016). `MarketDataProvider` HTTP client for MarketData.app historical options chains. `IvHistoryService` computes ATM IV via DTE-weighted interpolation between two expirations bracketing 30 days, detects gaps, orchestrates backfill, and queries IV rank/percentile. `IvHistoryView` management screen with token config, coverage summary, Step 1/2 initial load controls, ongoing gap fill, and live progress panel. E*Trade auto-capture: silently stores today's ATM IV whenever an options chain is fetched — free, no extra API call. `window.api.ivHistory.*` preload bridge. `marketdataApiToken` added to secure encrypted storage. Formula docs added at `docs/formulas.md#iv-history`, `#atm-iv-interpolation`, `#trading-days`. See [`changelogs/v0.17.0_2026-05-30.md`](changelogs/v0.17.0_2026-05-30.md).

## v0.16.0 — 2026-05-30

Payoff Visualizer improvements + E*Trade Quote Inspector + IV History design. Payoff: fixed Anthropic API key injection (`new Anthropic({ apiKey })`), fixed `probOfProfit` tool schema type, redesigned assessment panel with structured risks/opportunities/exit guidance cards and collapsible chain drawer. E*Trade Test API: new `etrade:get-raw-quote` IPC handler calls `/v1/market/quote/{symbol}?detailFlag=ALL` and returns full raw JSON; `QuoteInspector` component in `TestApiView` auto-highlights any IV/volatility fields found in the response. Planning: `Requirements/enhancements.md` and `Requirements/iv-history-design.md` capture the full IV rank build plan. See [`changelogs/v0.16.0_2026-05-30.md`](changelogs/v0.16.0_2026-05-30.md).

## v0.15.0 — 2026-05-26

Dual-provider architecture for options data. New `OptionsProvider` interface (`options-provider.ts`) with `getOptionsExpirations`, `getOptionsChain`, `getOptionsIV`, `getOptionsIVAndPremium`. `PolygonDataProvider` implements both `DataProvider` and `OptionsProvider`. New `ETradeDataProvider` implements `OptionsProvider` using the E*Trade Market API with live OAuth tokens. Provider chosen at startup via `optionsProvider` settings key ('polygon'|'etrade'). `LeapsCspService` refactored to take separate `DataProvider` (quotes/fundamentals/bars) and `OptionsProvider` (options calls). Settings UI adds "Options Data Source" dropdown; `window.api.settings.getOptionsProvider/setOptionsProvider` bridge. Fixed 7 pre-existing TypeScript strict-mode errors. Screener filter tests updated to match Polygon-compatible defaults. See [`changelogs/v0.15.0_2026-05-26.md`](changelogs/v0.15.0_2026-05-26.md).

## v0.14.0 — 2026-05-25

LEAPS + CSP Strategy Screener. New `⚡ LEAPS+CSP` sidebar tab. Market gate (SPY trend vs 50d/200d MA, VIX level + 5d change, HYG/IEF ratio) returns PASS/CAUTION/FAIL. Universe loaded from screener cache (no redundant API calls). LEAPS candidates screened by delta 0.70–0.90, DTE 365–730, spread ≤5%, OI ≥100, extrinsic ≤15%. CSP candidates screened by delta −0.15 to −0.30, DTE 25–50, annualised return ≥12%. Cross-ticker pairing: CSP on same OR different ticker. Combined score = LEAPS sub-score × 60% + CSP sub-score × 40%. Grades A+ (≥9.0) / A / B / C / F. Results ranked table with expandable scoring breakdowns, caution flags, alternative CSPs per LEAPS, and "Mark as Opened" tracking. Migration 011. See [`changelogs/v0.14.0_2026-05-25.md`](changelogs/v0.14.0_2026-05-25.md).

## v0.13.0 — 2026-05-25

Backtesting Engine. `BacktestEngine` service with multi-strategy back-test against historical OHLCV data. IPC handlers via `ipc-backtest.ts`. `BacktestView` in renderer. `🔁 Backtest` sidebar tab.

## v0.10.0 — 2026-05-08

Phase 10: Settings Enhancements (Priority 9). Extended AppSettings with soundAlertsEnabled, autoConnectWebSocket, defaultScreenerIndex ('sp500'|'russell1000'|'both'), theme ('dark'|'light'), keyboardShortcuts config. Added Keyboard Shortcuts tab to SettingsView. Theme support via CSS variables and data-theme attribute. Conditional WebSocket auto-connect in main process based on setting. ScreenerView loads default universe from settings. See [`changelogs/v0.10.0_2026-05-08.md`](changelogs/v0.10.0_2026-05-08.md).

## v0.9.0 — 2026-05-08

Phase 9: Morning Briefing Dashboard (Priority 7) + Alerts System (Priority 8). `007_alerts.sql` migration with `alerts` table (price, position types with thresholds). `BriefingService` with market regime detection (SPY trend via 20/50 SMA, VIX classification), action items (expiring positions, delta breaches), top 15 quality setups (ROE>15%, D/E<1.0, MarketCap>$10B). `AlertsService` with price alert checking via WebSocket updates. IPC handlers: `briefing:getFull`, `briefing:refresh` and `alerts:create`, `list`, `delete`, `markTriggered`. `BriefingView` component with MarketRegimeCard (trend/vix badges), ActionItemsList (priority icons), TopSetupsTable (sortable columns). Auto-refresh every 5 minutes. See [`changelogs/v0.9.0_2026-05-08.md`](changelogs/v0.9.0_2026-05-08.md).

## v0.8.0 — 2026-05-08

Phase 8: Portfolio Tracking (Priority 6). `006_portfolio.sql` migration with `positions` table (CSP, CC, Stock types with entry/exit prices, quantities, strike/exp dates). `PortfolioService` with CRUD operations and P&L calculations. IPC handlers: `portfolio:add`, `list`, `update`, `close`, `pnlSummary`. `PortfolioView` component with add position form, Open/Closed tabs, sortable columns, P&L summary cards (total positions, unrealized/realized P&L, capital deployed, win rate). Added to sidebar navigation. See [`changelogs/v0.8.0_2026-05-08.md`](changelogs/v0.8.0_2026-05-08.md).

## v0.7.0 — 2026-05-07

Phase 7: Screener Enhancements (Priority 5). Sortable columns using `useSortable` hook on all 17+ columns (Ticker, Company, Sector, Last Price, Day %, P/E, EPS, Market Cap, Revenue Growth, EPS Growth, D/E, ROE, Margin, FCF, Current Ratio, Volume, Beta, Pass Score). Quick Actions per row: "Add to Watchlist" dropdown and "Run Analysis" button. CSV export for filtered results. Pagination (50 items per page) with page navigation. Cache status indicator in Screener header with auto-refresh warning when data >1 hour old. See [`changelogs/v0.7.0_2026-05-07.md`](changelogs/v0.7.0_2026-05-07.md).

## v0.6.0 — 2026-05-07

Phase 6: Historical Charts (Priority 4). **Database**: `005_historical_data.sql` with `historical_financials` and `historical_prices` tables, indexes, views. **Backend**: `HistoricalDataService` with `getFinancials`, `upsertFinancial`, `getPrices`, `upsertPrice`, `calculateSMA`, `getDateRangeFromTimeRange`; IPC handlers `historical:getFinancials`, `historical:getPrices`, `historical:getPricesWithSMA`, `historical:fetchFinancials`, `historical:fetchPrices`, `historical:fetchAndStore`, `historical:needsRefresh`; Polygon API integration for financials and aggregates. **Frontend**: `HistoricalFinancialChart` (Recharts Area chart with metric selector: Revenue, Net Income, EPS, EBITDA, Total Assets, Shareholders Equity, Free Cash Flow; Quarterly/Annual toggle; CSV export), `HistoricalPriceChart` (line chart with volume, timeframe selector 1M/3M/6M/1Y/2Y/5Y, 50-day SMA overlay, price change indicator; CSV export); integrated into AnalysisView with click-to-open from ticker symbols. See [`changelogs/v0.6.0_2026-05-07.md`](changelogs/v0.6.0_2026-05-07.md).

## v0.5.0 — 2026-05-07

Phase 5: Cache Management + Wheel Columns + Real-Time WebSocket. **Cache Management System**: `cache_metadata` table, `CacheManager` service, staleness tracking with 1-hour threshold, `CacheStatusIndicator` UI component (green/red with timestamp), `useCacheStatus` hook polling every 5 minutes, auto-refresh trigger. **Wheel Strategy Columns**: `WheelCalculator` service with suitability formula (ROE×30% + D/E_Quality×30% + MarketCap×20% + Stability×25%), Target Strike (Current × 0.92), Est. Premium (Strike × 1.2%), integrated into watchlist table with color coding and sortable columns via `useSortable` hook. **Real-Time WebSocket**: `WebSocketService` connecting to `wss://delayed.polygon.io/stocks`, trade/aggregate message handlers, exponential backoff reconnection (3s, 6s, 12s, 24s, 48s), `RealtimePriceTicker` component for Analysis view, live price updates in watchlist with green/red indicators, connection status in status bar. New dependencies: `ws`, `recharts`. See [`changelogs/v0.5.0_2026-05-07.md`](changelogs/v0.5.0_2026-05-07.md).

## v0.4.0 — 2026-05-02

Phase 4: Validation Dashboard Polish + Settings/Diagnostics. Chart: pattern callouts at correct price/time coordinates, entry zone band, target line (amber), stop loss, demand/supply zone labels. Section A: EPS sparkline (SVG). Full Settings panel (SettingsView): General, API & Data, Cache & Limits, Diagnostics self-check, Backup & Restore. Settings IPC (9 handlers). Diagnostics IPC. Bug fix: `detectEveningStar` guard was inverted. See [`changelogs/v0.4.0_2026-05-02.md`](changelogs/v0.4.0_2026-05-02.md).

## v0.3.0 — 2026-05-02

Phase 3: Analysis Engine + Producer/Consumer Pipeline. FR-3 fully implemented — 5 analysis modes (Buy Opportunities, Options Income, Wheel Strategy, Bullish Strategies, Bearish Strategies) over any watchlist with composite scoring, entry/stop/target, annualized returns. FR-4.4 Validate All — batch deep-dive with verdict (Strong/Acceptable/Caution/Avoid), full indicator suite. Pipeline: `TokenBucketRateLimiter` + SQLite-backed `JobQueue` for resumable batch jobs. New `analysis_snapshots` + `job_runs` + `job_progress` DB tables. Full indicator library (`computeSMA`, `computeEMA`, `computeRSI`, `computeATR`, `computeADX`, Bollinger, MACD, swing high/low) documented in `docs/formulas.md`. AnalysisView with mode cards, run/cancel, progress bar, mode-specific results, snapshot history, save-as-watchlist.

See [`changelogs/v0.3.0_2026-05-02.md`](changelogs/v0.3.0_2026-05-02.md).

## v0.2.0 — 2026-05-02

Phase 2: Index Screener. FR-2 fully implemented — S&P 500/Russell 1000 screener with 17 default filters, strict/soft-match modes, presets, run history, save-as-watchlist. Polygon DataProvider + fundamentals computer with all ratios documented in `docs/formulas.md`. Quote auto-refresh (60s) on watchlist view. Structured API + error logging (EP-3/EP-4).

See [`changelogs/v0.2.0_2026-05-02.md`](changelogs/v0.2.0_2026-05-02.md).

## v0.1.2 — 2026-05-02

Fix `rebuild:electron` so it actually swaps the better-sqlite3 binary's ABI (v0.1.1's `electron-builder install-app-deps` was a no-op when a Node binary was already in place). Replaces both rebuild scripts with a small `scripts/rebuild-better-sqlite3.mjs` helper that calls `prebuild-install --force` and derives the Electron target dynamically. `npm run dev` now opens the window cleanly and migrations run.

See [`changelogs/v0.1.2_2026-05-02.md`](changelogs/v0.1.2_2026-05-02.md).

## v0.1.1 — 2026-05-02

Swap DB driver back from `node:sqlite` to `better-sqlite3` 12.x now that VS Build Tools 2022 is installed on the dev box. Drops the `createRequire` workaround and the vitest forks-pool/`node:` externals. Adds paired `rebuild:electron` / `rebuild:node` scripts wired into `predev` / `pretest` so the native binary's ABI always matches the runtime. Tests + typecheck still green; no behavior change.

See [`changelogs/v0.1.1_2026-05-02.md`](changelogs/v0.1.1_2026-05-02.md).

## v0.1.0 — 2026-05-01

Initial scaffold. Section 7 (Engineering Practices) infrastructure in place. Phase 1 (FR-1 — watchlist management) implemented end-to-end with persistence, CSV round-trip, and tests. No market-data integration yet.

See [`changelogs/v0.1.0_2026-05-01.md`](changelogs/v0.1.0_2026-05-01.md).
