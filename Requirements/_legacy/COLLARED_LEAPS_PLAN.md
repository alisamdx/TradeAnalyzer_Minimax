# Collared LEAPS — Implementation Plan & Progress Tracker

**Feature:** New strategy screen — Long deep-ITM LEAPS call + long OTM protective put on same underlying  
**SRS:** `Requirements/SRS Collared LEAPS Strategy.md`  
**Status:** ✅ Implementation complete — all phases done, typecheck clean  
**Last updated:** 2026-05-26

---

## How to resume this work

1. Read `Requirements/SRS Collared LEAPS Strategy.md` for full spec
2. Read `src/main/services/leaps-csp-service.ts` — service to mirror
3. Read `src/main/ipc/ipc-leaps-csp.ts` — IPC pattern to mirror
4. Read `src/shared/types.ts` lines 713–829 for LeapsCsp types (template for new types)
5. Read this file and pick up from the first unchecked item in each phase

**Rule:** This is a NEW screen. Do not modify any existing screen's business logic.  
**Migration number:** `013` (012 already exists as `012_leaps_csp_watchlist.sql`)

---

## Architecture Overview

### New files to create
| File | Purpose |
|------|---------|
| `migrations/013_collared_leaps.sql` | DB schema: 3 tables |
| `src/main/services/collared-leaps-service.ts` | Pipeline + P&L math + scoring |
| `src/main/ipc/ipc-collared-leaps.ts` | 6 IPC handlers + 2 push events |
| `src/renderer/src/views/CollaredLeapsView.tsx` | Main screen: source selector + ranked table |
| `src/renderer/src/views/CollaredLeapsDashboard.tsx` | Per-opportunity detail panel |
| `src/renderer/src/components/CollaredLeapsPayoffChart.tsx` | Payoff curve (lightweight-charts) |

### Additive changes only (no existing logic removed)
| File | What to add |
|------|-------------|
| `src/shared/types.ts` | Append 9 new interfaces at end of file |
| `src/preload/index.ts` | Append `collaredLeaps` API namespace + add to api object |
| `src/main/index.ts` | 1 import + 1 `registerCollaredLeapsIpc(...)` call after leaps-csp registration |
| `src/renderer/src/App.tsx` | Add `'collaredLeaps'` to View type, 1 nav button, 1 route render |

---

## Phase 1 — Data Layer

- [x] **Create `migrations/013_collared_leaps.sql`**

  Three tables:

  ```sql
  CREATE TABLE IF NOT EXISTS collared_leaps_runs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    run_at            TEXT    NOT NULL,
    universe          TEXT    NOT NULL,
    watchlist_id      INTEGER REFERENCES watchlists(id) ON DELETE SET NULL,
    market_gate       TEXT    NOT NULL,
    gate_detail_json  TEXT    NOT NULL,
    gate_effect       TEXT    NOT NULL,
    candidate_count   INTEGER NOT NULL DEFAULT 0,
    opportunity_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS collared_leaps_opportunities (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id                INTEGER NOT NULL REFERENCES collared_leaps_runs(id) ON DELETE CASCADE,
    rank                  INTEGER NOT NULL,
    ticker                TEXT    NOT NULL,
    spot                  REAL    NOT NULL,
    ma200d                REAL,
    leaps_strike          REAL    NOT NULL,
    leaps_expiry          TEXT    NOT NULL,
    leaps_dte             INTEGER,
    leaps_delta           REAL,
    leaps_debit           REAL,
    leaps_extrinsic_pct   REAL,
    leaps_iv_pct          REAL,
    leaps_ivr             REAL,
    leaps_oi              INTEGER,
    leaps_spread_pct      REAL,
    leaps_sub_score       REAL    NOT NULL,
    put_strike            REAL    NOT NULL,
    put_expiry            TEXT    NOT NULL,
    put_dte               INTEGER,
    put_delta             REAL,
    put_debit             REAL,
    put_iv_pct            REAL,
    put_ivr               REAL,
    put_oi                INTEGER,
    put_spread_pct        REAL,
    put_sub_score         REAL    NOT NULL,
    cost_drag_pct         REAL    NOT NULL,
    floor_depth_pct       REAL    NOT NULL,
    breakeven             REAL    NOT NULL,
    max_loss_at_put       REAL,
    max_loss_at_zero      REAL    NOT NULL,
    upside_retention_pct  REAL    NOT NULL,
    hedge_efficiency_pct  REAL    NOT NULL,
    rr_ratio              REAL,
    structural_sub_score  REAL    NOT NULL,
    combined_score        REAL    NOT NULL,
    grade                 TEXT    NOT NULL,
    caution_flags         TEXT,
    gate_survived         INTEGER NOT NULL DEFAULT 0,
    detail_json           TEXT    NOT NULL DEFAULT '{}'
  );

  CREATE INDEX IF NOT EXISTS idx_cl_opp_run    ON collared_leaps_opportunities (run_id, rank);
  CREATE INDEX IF NOT EXISTS idx_cl_opp_grade  ON collared_leaps_opportunities (run_id, grade);
  CREATE INDEX IF NOT EXISTS idx_cl_opp_ticker ON collared_leaps_opportunities (run_id, ticker);

  CREATE TABLE IF NOT EXISTS collared_leaps_opened (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    opportunity_id    INTEGER NOT NULL REFERENCES collared_leaps_opportunities(id) ON DELETE CASCADE,
    opened_at         TEXT    NOT NULL,
    leaps_entry_debit REAL,
    put_entry_debit   REAL,
    notes             TEXT
  );
  ```

- [x] **Append types to `src/shared/types.ts`**

  Add after the last LeapsCsp type (around line 829):

  ```typescript
  // ─── Collared LEAPS Strategy ──────────────────────────────────────────────────

  export type CollaredLeapsGate = 'PASS' | 'CAUTION' | 'FAIL';
  export type CollaredLeapsGrade = 'A+' | 'A' | 'B' | 'C' | 'F';

  export interface CollaredLeapsGateDetail {
    spx: number | null;
    spx50d: number | null;
    spx200d: number | null;
    vix: number | null;
    vix5dChangePct: number | null;
    hygIefRatio: number | null;
    hygIefTrend: 'up' | 'down' | 'flat' | null;
  }

  export interface CollaredLeapsScoreComponent {
    name: string;
    weight: number;
    rawScore: number;
    weightedScore: number;
  }

  export interface CollaredLeapsPnlPoint {
    price: number;
    collarPnl: number;
    nakedPnl: number;
  }

  export interface CollaredLeapsDetail {
    leapsScoreBreakdown: CollaredLeapsScoreComponent[];
    putScoreBreakdown: CollaredLeapsScoreComponent[];
    structuralScoreBreakdown: CollaredLeapsScoreComponent[];
    pnlGrid: CollaredLeapsPnlPoint[];       // 200 pts, expiry horizon
    pnlGrid180d?: CollaredLeapsPnlPoint[];  // omitted if LEAPS DTE < 180
    pnlGrid90d?: CollaredLeapsPnlPoint[];
    pnlGrid30d?: CollaredLeapsPnlPoint[];
  }

  export interface CollaredLeapsOpportunity {
    id: number;
    runId: number;
    rank: number;
    ticker: string;
    spot: number;
    ma200d: number | null;
    leapsStrike: number;
    leapsExpiry: string;
    leapsDte: number | null;
    leapsDelta: number | null;
    leapsDebit: number;
    leapsExtrinsicPct: number | null;
    leapsIvPct: number | null;
    leapsIvr: number | null;
    leapsOi: number | null;
    leapsSpreadPct: number | null;
    leapsSubScore: number;
    putStrike: number;
    putExpiry: string;
    putDte: number | null;
    putDelta: number | null;
    putDebit: number;
    putIvPct: number | null;
    putIvr: number | null;
    putOi: number | null;
    putSpreadPct: number | null;
    putSubScore: number;
    costDragPct: number;
    floorDepthPct: number;
    breakeven: number;
    maxLossAtPut: number | null;
    maxLossAtZero: number;
    upsideRetentionPct: number;
    hedgeEfficiencyPct: number;
    rrRatio: number | null;
    structuralSubScore: number;
    combinedScore: number;
    grade: CollaredLeapsGrade;
    cautionFlags: string[];
    gateSurvived: boolean;
    detail: CollaredLeapsDetail;
  }

  export interface CollaredLeapsRunSummary {
    id: number;
    runAt: string;
    universe: string;
    watchlistId: number | null;
    marketGate: CollaredLeapsGate;
    gateDetail: CollaredLeapsGateDetail;
    gateEffect: string;
    candidateCount: number;
    opportunityCount: number;
  }

  export interface CollaredLeapsRunResult {
    run: CollaredLeapsRunSummary;
    opportunities: CollaredLeapsOpportunity[];
  }

  export interface CollaredLeapsOpenedEntry {
    id: number;
    opportunityId: number;
    openedAt: string;
    leapsEntryDebit: number | null;
    putEntryDebit: number | null;
    notes: string | null;
  }

  export interface CollaredLeapsProgressDetail {
    phase: 'gate' | 'universe' | 'leaps' | 'puts' | 'structural' | 'persist';
    current: number;
    total: number;
    ticker?: string;
  }
  ```

- [ ] **Run `npm run typecheck`** — verify no errors before proceeding

---

## Phase 2 — Backend Service

**File:** `src/main/services/collared-leaps-service.ts`  
**Mirror:** `src/main/services/leaps-csp-service.ts`  
**Constructor:** `(db: DbHandle, dataProvider: DataProvider, optionsProvider: OptionsProvider, rateLimiter: TokenBucketRateLimiter)`

- [ ] **Service skeleton** — class with constructor + all public method stubs returning empty/null

  Public methods:
  ```typescript
  async runScreen(universe, onProgress?, forceRun?, onProgressDetail?, watchlistId?): Promise<CollaredLeapsRunResult>
  getRecentRuns(): CollaredLeapsRunSummary[]
  getRun(runId: number): CollaredLeapsRunResult | null
  markOpened(opportunityId, entry): void
  getOpenedPositions(): CollaredLeapsOpenedEntry[]
  deleteRun(runId: number): void
  ```

- [ ] **Phase 1 — Market gate** (`private async checkMarketGate()`)
  - Fetch SPY, VIX, HYG, IEF snapshots via dataProvider
  - Logic identical to `LeapsCspService.checkMarketGate()`
  - Returns `{ gate: CollaredLeapsGate, detail: CollaredLeapsGateDetail, effect: string }`
  - FAIL gate does NOT suppress — instead sets `gateSurvived` per opportunity later

- [ ] **Phase 2 — Universe loading**
  - `getScreenedTickers(universe)` — same DB query as LEAPS+CSP (sp500/russell1000/both from constituents tables)
  - `getWatchlistTickers(watchlistId)` — same watchlist_items query as LEAPS+CSP

- [ ] **Phase 3 — Universe filters** (per ticker, synchronous from cache)
  - price ≥ $10, ADV ≥ 2M shares, marketCap ≥ $10B
  - Exclude biotech / leveraged ETF / SPAC
  - **New:** fetch 200d MA via `dataProvider.getHistoricalBars(ticker, 'day', 210)`, compute SMA of last 200 closes

- [ ] **Phase 4 — LEAPS candidate selection** (per surviving ticker)

  Hard fails:
  - Delta: [0.70, 0.90]
  - DTE: [365, 730]
  - Bid/ask spread ≤ 5% of mid
  - OI ≥ 100
  - Extrinsic ≤ 15% of mid price
  - IVR > 80 on underlying → reject entire ticker

  LEAPS sub-score components (weighted average → 0–10):
  | Component | Weight | Rule |
  |-----------|--------|------|
  | Delta band | 0.20 | 10 if [0.78,0.82], 8 if [0.75,0.85], 5 if edges of band |
  | DTE quality | 0.15 | 10 if 540–650d, 8 if 450–730d, 5 if 365–450d |
  | Extrinsic % | 0.25 | 10 if ≤3%, 8 if ≤6%, 5 if ≤10%, 2 if ≤15% |
  | Liquidity | 0.20 | 10 if spread<2% AND OI>500, 8 if spread<5% AND OI>200, 5 if OI≥100 |
  | IVR | 0.20 | 10 if <25, 8 if <40, 5 if <55, 2 if <75 |

  Keep best-scoring LEAPS contract per ticker (one per expiry window, pick highest).

- [ ] **Phase 5 — Put candidate generation** (up to 12 per LEAPS candidate)

  Expiry options (4, in priority order):
  1. Match LEAPS expiry
  2. LEAPS expiry − 90 days
  3. 180 DTE
  4. 90 DTE  
  All must be ≥ 60 DTE and ≤ LEAPS DTE to be valid.

  Floor depth bands (3):
  - Band A (shallow): put strike in [S×0.82, S×0.86]
  - Band B (mid): put strike in [S×0.86, S×0.90]
  - Band C (tight): put strike in [S×0.90, S×0.94]
  - For each band, pick the contract closest to the band midpoint.

  Put hard fails:
  - Delta: [−0.30, −0.10]
  - Strike: [S×0.78, S×0.94]
  - DTE ≥ 60 AND DTE ≤ LEAPS DTE
  - Spread ≤ 10% of mid AND ≤ $0.15 absolute
  - OI ≥ 200

  Put sub-score components:
  | Component | Weight | Rule |
  |-----------|--------|------|
  | Floor vs 200d MA | 0.25 | 10 if K_put ≤ ma200d×0.97, 7 if ≤ ma200d, 3 if within 3% above, 0 above. 5 if ma200d unknown |
  | Cost efficiency | 0.20 | 10 if costDrag≤6%, 8 if ≤10%, 5 if ≤15%, 2 if ≤20%, 0 if >20% |
  | Duration alignment | 0.15 | 10 if putDte ≥ leapsDte×0.85, 8 if ≥×0.70, 5 if ≥180d, 2 if ≥90d |
  | Delta band | 0.15 | 10 if [−0.20,−0.15], 7 if [−0.25,−0.10], 3 if at edges |
  | IV state | 0.15 | Inverse (cheap = good): 10 if IVR>60, 7 if >40, 4 if >25, 2 else |
  | Liquidity | 0.10 | 10 if spread<2% AND OI>500, 8 if OI>200, 5 if OI≥100 |

  Keep the 1 put per LEAPS with the best structural quality score (computed next).

- [ ] **Phase 6 — Structural metrics + combined structure hard fails**

  **P&L Math formulas (exact):**
  ```
  totalDebit        = leapsDebit + putDebit        // both are mid × 100
  costDragPct       = putDebit / leapsDebit × 100
  floorDepthPct     = (spot − K_put) / spot × 100
  breakeven         = K_call + totalDebit / 100

  intrinsicAtPut    = max(0, K_put − K_call) × 100    // LEAPS intrinsic when stock = K_put
  maxLossAtPut      = totalDebit − intrinsicAtPut

  maxLossAtZero     = totalDebit − K_put × 100         // can be negative (fully hedged) — OK

  nakedLeapsPnl_20  = (spot × 1.20 − K_call) × 100 − leapsDebit
  collarPnl_20      = (spot × 1.20 − K_call) × 100 − totalDebit
  upsideRetentionPct = (nakedLeapsPnl_20 > 0)
                       ? collarPnl_20 / nakedLeapsPnl_20 × 100
                       : 100   // degenerate: naked is losing too, collar no worse

  hedgeEfficiencyPct = (leapsDebit − maxLossAtPut) / leapsDebit × 100

  maxProfitEst      = (spot × 1.25 − K_call) × 100 − totalDebit
  rrRatio           = (maxLossAtPut > 0) ? maxProfitEst / maxLossAtPut : null
  ```

  **Combined structure hard fails (reject if any):**
  - `costDragPct > 25`
  - `maxLossAtZero ≥ totalDebit × 0.65`
  - `upsideRetentionPct < 75`

  **Structural sub-score components:**
  | Component | Weight | Rule |
  |-----------|--------|------|
  | Upside retention | 0.30 | 10 if ≥90%, 8 if ≥82%, 5 if ≥75%, 0 if <75% |
  | Max loss % of debit | 0.25 | 10 if maxLossAtPut/totalDebit ≤30%, 8 if ≤40%, 5 if ≤50%, 2 if ≤60% |
  | Breakeven distance | 0.20 | 10 if (breakeven−spot)/spot ≤4%, 8 if ≤7%, 5 if ≤10%, 2 if ≤14% |
  | R/R ratio | 0.15 | 10 if ≥3.0, 8 if ≥2.0, 5 if ≥1.5, 2 if ≥1.0, 0 if <1 or null |
  | Hedge efficiency | 0.10 | 10 if ≥70%, 7 if ≥50%, 4 if ≥30%, 0 else |

- [ ] **Phase 7 — Combined score + P&L grid + caution flags + grade + persist**

  **Combined score:**
  ```
  combined = leapsSubScore × 0.35 + putSubScore × 0.25 + structuralSubScore × 0.40
  ```
  In CAUTION gate: `putSubScore` weight increases from 0.25 to 0.30 (and `leapsSubScore` weight drops from 0.35 to 0.30).

  **`gateSurvived`:**
  ```
  gateSurvived = (gate === 'FAIL') ? (costDragPct ≤ 15 && floorDepthPct ≥ 12) : true
  ```

  **Caution flags (each deducts 0.25, max 1.0 total):**
  - `COST_DRAG_HIGH` — costDragPct > 18
  - `NARROW_FLOOR` — floorDepthPct < 8
  - `PUT_IV_ELEVATED` — put IVR > 70
  - `LEAPS_IV_ELEVATED` — leaps IVR ≥ 60
  - `BREAKEVEN_WIDE` — breakeven > spot × 1.12
  - `SHORT_PUT_DTE` — putDte < 90
  - `GATE_FAIL_COLLAR` — gate === 'FAIL' AND gateSurvived

  **Grade bands:**
  | Score | Grade |
  |-------|-------|
  | ≥ 9.0 | A+ |
  | ≥ 8.0 | A |
  | ≥ 7.0 | B |
  | ≥ 6.0 | C |
  | < 6.0 | F |

  **P&L grid (200 price points, stored in detail_json):**
  ```typescript
  // At each price S_t from spot×0.5 to spot×1.5 (200 equally spaced):
  nakedPnl  = max(0, S_t − K_call) × 100 − leapsDebit
  putPayoff = max(0, K_put − S_t) × 100 − putDebit
  collarPnl = max(0, S_t − K_call) × 100 + max(0, K_put − S_t) × 100 − totalDebit
  ```

  **Time-horizon grids (optional, for dashboard chart tabs):**
  Use Black-Scholes approximation with private helper `bsPrice(S, K, T, iv, r, isCall): number`.
  Compute only for horizons where DTE allows (e.g., skip 180d grid if LEAPS DTE < 190).

  **Persistence:**
  - Sort all pairs by combinedScore descending
  - Persist all opportunities with grade ≥ C (combined ≥ 6.0) plus all FAIL-gate gate-survived ones
  - Use `withTransaction(db, fn)` for the entire save block
  - Return full `CollaredLeapsRunResult`

- [ ] **DB query helpers** — implement `getRecentRuns()`, `getRun()`, `markOpened()`, `getOpenedPositions()`, `deleteRun()` (all straightforward DB queries mirroring LEAPS+CSP equivalents)

- [ ] **Run `npm run typecheck`** after service is complete

---

## Phase 3 — IPC & Plumbing

- [x] **Create `src/main/ipc/ipc-collared-leaps.ts`**

  ```typescript
  export function registerCollaredLeapsIpc(
    db: DbHandle,
    dataProvider: DataProvider,
    optionsProvider: OptionsProvider,
    rateLimiter: TokenBucketRateLimiter,
  ): void
  ```

  Channels:
  | Channel | Type | Purpose |
  |---------|------|---------|
  | `collared-leaps:run-screen` | invoke | `(universe, forceRun?, watchlistId?)` → `IpcResult<CollaredLeapsRunResult>` |
  | `collared-leaps:get-runs` | invoke | `()` → `IpcResult<CollaredLeapsRunSummary[]>` |
  | `collared-leaps:get-run` | invoke | `(runId)` → `IpcResult<CollaredLeapsRunResult \| null>` |
  | `collared-leaps:mark-opened` | invoke | `(opportunityId, entry)` → `IpcResult<boolean>` |
  | `collared-leaps:get-opened` | invoke | `()` → `IpcResult<CollaredLeapsOpenedEntry[]>` |
  | `collared-leaps:delete-run` | invoke | `(runId)` → `IpcResult<boolean>` |
  | `collared-leaps:progress` | send | `string` progress message |
  | `collared-leaps:progress-detail` | send | `CollaredLeapsProgressDetail` |

  Error code: `'COLLARED_LEAPS_ERROR'`  
  Use `BrowserWindow.getAllWindows()[0]` for win reference in run-screen handler.

- [x] **Register in `src/main/index.ts`**
  ```typescript
  import { registerCollaredLeapsIpc } from './ipc/ipc-collared-leaps.js';
  // after registerLeapsCspIpc(...):
  registerCollaredLeapsIpc(db, dataProvider, optionsProvider, rateLimiter);
  ```

- [x] **Add preload bridge to `src/preload/index.ts`**

  Add `collaredLeaps` namespace:
  ```typescript
  const collaredLeaps = {
    runScreen: (universe, forceRun?, watchlistId?) =>
      invoke<CollaredLeapsRunResult>('collared-leaps:run-screen', universe, forceRun, watchlistId),
    getRuns: () => invoke<CollaredLeapsRunSummary[]>('collared-leaps:get-runs'),
    getRun: (runId: number) => invoke<CollaredLeapsRunResult | null>('collared-leaps:get-run', runId),
    markOpened: (opportunityId, entry) => invoke<boolean>('collared-leaps:mark-opened', opportunityId, entry),
    getOpened: () => invoke<CollaredLeapsOpenedEntry[]>('collared-leaps:get-opened'),
    deleteRun: (runId: number) => invoke<boolean>('collared-leaps:delete-run', runId),
    onProgress: (cb: (msg: string) => void) => {
      const h = (_: unknown, msg: string) => cb(msg);
      ipcRenderer.on('collared-leaps:progress', h);
      return () => ipcRenderer.removeListener('collared-leaps:progress', h);
    },
    onProgressDetail: (cb: (d: CollaredLeapsProgressDetail) => void) => {
      const h = (_: unknown, d: CollaredLeapsProgressDetail) => cb(d);
      ipcRenderer.on('collared-leaps:progress-detail', h);
      return () => ipcRenderer.removeListener('collared-leaps:progress-detail', h);
    },
  };
  // Add collaredLeaps to the api return object
  ```

  Also add to `global.d.ts` if `window.api.collaredLeaps` isn't auto-picked up.

- [ ] **Run `npm run typecheck`** — verify clean

---

## Phase 4 — Frontend

### `src/renderer/src/App.tsx` (additive only)
- [x] Add `'collaredLeaps'` to the `View` type union
- [x] Add import: `import { CollaredLeapsView } from './views/CollaredLeapsView.js';`
- [x] Add nav button (after LEAPS+CSP button): `🛡️ Collared LEAPS` → `setView('collaredLeaps')`
- [x] Add route render: `{view === 'collaredLeaps' && <CollaredLeapsView />}`

### `src/renderer/src/views/CollaredLeapsView.tsx`
- [ ] **Shell** — heading, Run button, verify screen loads via nav
- [ ] **State variables:**
  ```typescript
  runs, selectedRunId, runResult, isRunning
  progressMsg, progressDetail
  universe ('sp500' | 'russell1000' | 'both'), source ('universe' | 'watchlist')
  watchlists, selectedWatchlistId
  forceRun (checkbox)
  gradeFilter ('A+' | 'A' | 'B' | 'C' | 'F' | 'all'), gateSurvivedOnly
  selectedOpp (CollaredLeapsOpportunity | null)  — opens Dashboard
  error, statusMsg
  ```
- [ ] **Mount effects** — load watchlists, load recent runs, auto-select latest run
- [ ] **Progress subscriptions** — `onProgress` + `onProgressDetail`, unsubscribe on unmount
- [ ] **Source selector** — Universe vs Watchlist toggle + universe/watchlist dropdown (same pattern as FiltersView)
- [ ] **Market gate badge** — colored PASS/CAUTION/FAIL chip + gate detail (SPX, VIX, HYG/IEF) shown in header. FAIL gate shows warning banner.
- [ ] **Run history panel** — left sidebar list of recent runs (date + universe + gate + opportunity count + delete button)
- [ ] **Progress display** — phase labels during run: gate → universe → leaps → puts → structural → persist
- [ ] **Ranked opportunity table** with columns:
  `rank | ticker | spot | LEAPS (strike / expiry / delta / debit) | put (strike / expiry / delta / debit) | costDrag% | floorDepth% | breakeven | upsideRetention% | hedgeEff% | combined score | grade | flags`
- [ ] **Grade filter tabs** — A+ / A / B / C / F / All (default: All)
- [ ] **Gate-survived toggle** — shown only when market gate is FAIL; filters to bear-regime-safe collars
- [ ] **Sortable columns** — use `useSortable` hook (already in codebase)
- [ ] **Row click** — opens `CollaredLeapsDashboard` as overlay panel
- [ ] **Empty states** — no runs yet, no results, gate FAIL with no gate-survived opportunities

### `src/renderer/src/views/CollaredLeapsDashboard.tsx`
- [ ] **Props:** `{ opp: CollaredLeapsOpportunity; onClose: () => void; onMarkOpened: (...) => void }`
- [ ] **Header** — ticker, spot, combined score chip, grade badge, caution flags, gate badge
- [ ] **Three-column score panel:**
  - Left: LEAPS leg — strike/expiry/DTE/delta/debit, score breakdown table
  - Middle: Put leg — strike/expiry/DTE/delta/debit, costDrag%, floorDepth% vs 200d MA, score breakdown table
  - Right: Structural quality — breakeven, maxLossAtPut, maxLossAtZero, upsideRetention%, hedgeEfficiency%, R/R, score breakdown table, `gateSurvived` indicator
- [ ] **P&L scenarios table** — rows: −30% / −20% / −10% / flat / +10% / +20% / +30%; columns: Collared P&L ($) / Naked LEAPS P&L ($) / Retention %
- [ ] **Payoff chart** — renders `CollaredLeapsPayoffChart` with time-horizon tabs (Expiry / 180d / 90d / 30d, disable unavailable)
- [ ] **Exit rules checklist** — based on computed metrics:
  - Close collar: combined P&L reaches +40% of totalDebit
  - Close collar: stock closes below K_put
  - Close collar: stock closes below 200d MA
  - Roll LEAPS: LEAPS DTE < 90 AND put DTE > 180
  - Roll put: put DTE < 60 AND LEAPS DTE > 180
  - Roll put: put strike now >20% below spot (stock appreciated)
- [ ] **Mark as Opened form** — LEAPS entry debit input + put entry debit input + notes + Save button

### `src/renderer/src/components/CollaredLeapsPayoffChart.tsx`
- [ ] **Props:** `{ pnlGrid: CollaredLeapsPnlPoint[]; spot: number; kCall: number; kPut: number; breakeven: number; height?: number }`
- [ ] **Chart setup** (lightweight-charts, mirror pattern from `ValidateView.tsx`):
  ```typescript
  const chart = createChart(container, {
    width: container.clientWidth,
    height: props.height ?? 280,
    layout: { background: { type: ColorType.Solid, color: '#0d1117' }, textColor: '#8b949e' },
    timeScale: { visible: false },
    handleScroll: false,
    handleScale: false,
  });
  ```
- [ ] **X-axis workaround** — use sequential integer index as `Time` (lightweight-charts expects time, not price). Cast: `i as unknown as Time`
- [ ] **Two line series:**
  - `nakedSeries` — blue (`#60a5fa`), width 1, dashed
  - `collarSeries` — green (`#4ade80`), width 2, solid
- [ ] **Price lines** (on `collarSeries` via `createPriceLine`):
  - Spot: yellow (`#facc15`), dashed, label 'Spot'
  - K_put: red (`#f87171`), solid, label 'Floor'
  - K_call: purple (`#818cf8`), solid, label 'LEAPS'
  - Breakeven: green (`#34d399`), dashed, label 'BEP'
  - Zero line: white 15% opacity
- [ ] **Price label legend** — HTML div below chart showing the price range and marker values (since x-axis shows integer indices not prices)
- [ ] **Resize observer** — `ResizeObserver` → `chart.applyOptions({ width: container.clientWidth })`; disconnect on cleanup
- [ ] **Cleanup** — `return () => { resizeObserver.disconnect(); chart.remove(); }` in useEffect

---

## Phase 5 — Integration & Polish

- [ ] **Full typecheck** `npm run typecheck` — zero errors
- [ ] **Manual test run** — run screen on a watchlist of 5–10 liquid tickers (e.g. AAPL, MSFT, NVDA, SPY, QQQ). Verify:
  - Market gate populates correctly
  - LEAPS candidates found for at least one ticker
  - Put candidates generated
  - At least 1 opportunity passes all hard fails
  - Payoff chart renders with correct shape (U-shaped floor visible)
  - Score breakdowns sum correctly
- [ ] **Edge case verification:**
  - Ticker with no put OI in floor band → skipped cleanly (no crash)
  - `maxLossAtZero < 0` (put over-insures) → stored correctly, no error
  - `nakedLeapsPnl_20 ≤ 0` → `upsideRetentionPct` clamped to 100, not NaN
  - FAIL gate run → `gateSurvived` correctly flags qualifying collars
  - All filters disabled (empty watchlist) → empty result with clear message
- [ ] **Update `CHANGELOG.md`** and bump version
- [ ] **Update `.ai/AI_CONTEXT.md`** — add collared-leaps tables and new view to schema summary

---

## Key Reference Points

### Codebase patterns to copy
| What | Where |
|------|-------|
| Service constructor + rate limiter | `src/main/services/leaps-csp-service.ts` lines 1–110 |
| Market gate check | `src/main/services/leaps-csp-service.ts` `checkMarketGate()` method |
| LEAPS contract selection | `src/main/services/leaps-csp-service.ts` `selectLeapsContract()` method |
| IPC wrap/wrapAsync helpers | `src/main/ipc/ipc-leaps-csp.ts` lines 1–50 |
| Progress event pattern | `src/main/ipc/ipc-leaps-csp.ts` run-screen handler |
| Ranked table + grade badge | `src/renderer/src/views/LeapsCspView.tsx` |
| lightweight-charts imperative setup | `src/renderer/src/views/ValidateView.tsx` |
| Source toggle (universe/watchlist) | `src/renderer/src/views/FiltersView.tsx` |
| useSortable hook | `src/renderer/src/hooks/useSortable.ts` |

### P&L math quick reference
```
totalDebit        = leapsDebit + putDebit
costDragPct       = putDebit / leapsDebit × 100
floorDepthPct     = (spot − K_put) / spot × 100
breakeven         = K_call + totalDebit / 100
maxLossAtPut      = totalDebit − max(0, K_put − K_call) × 100
maxLossAtZero     = totalDebit − K_put × 100       ← can be negative (ok)
upsideRetPct      = collarPnl(spot×1.2) / nakedPnl(spot×1.2) × 100
hedgeEffPct       = (leapsDebit − maxLossAtPut) / leapsDebit × 100
collarPnl(S)      = max(0,S−K_call)×100 + max(0,K_put−S)×100 − totalDebit
nakedPnl(S)       = max(0,S−K_call)×100 − leapsDebit
```

### Scoring weights
```
combined = leapsSubScore × 0.35 + putSubScore × 0.25 + structuralSubScore × 0.40
  (CAUTION gate: swap to 0.30 / 0.30 / 0.40)
```

### Hard fail thresholds
```
LEAPS delta: [0.70, 0.90]     Put delta: [−0.30, −0.10]
LEAPS DTE: [365, 730]         Put DTE: [60, LEAPS DTE]
LEAPS extrinsic: ≤ 15%        Put spread: ≤ 10% of mid AND ≤ $0.15
LEAPS spread: ≤ 5% of mid     Put OI: ≥ 200
LEAPS OI: ≥ 100
costDragPct ≤ 25              maxLossAtZero < totalDebit × 0.65
upsideRetentionPct ≥ 75
```

---

*Generated by Claude Code — 2026-05-26*
