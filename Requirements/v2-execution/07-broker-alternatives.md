# v2 Execution Subsystem — Broker Alternatives & Selection

> **Status:** design / decision doc (not yet built). Captured 2026-06-22 after IBKR
> approved the live account for **Options Level 1 only** (can't place credit spreads). This
> records the fallback broker options and the settings-driven selection model so a future
> session can pick any path and build it without re-deriving the analysis.
>
> Companion context: `00-overview.md`, `01-architecture.md` (§1.4 the `ExecutionBroker`
> seam), `02-risk-governor.md` (§2.13 live spread-permission preflight). Memory:
> `project_v2_execution_engine`.

---

## 1. The core insight: decouple **paper venue** from **live venue**

The whole v2 design is **paper-soak → then go live on the same adapter**. The capability that
makes IBKR special is **not** Level 3 — it's that IBKR offers a **full paper account reachable
through the identical API as live**. Almost no other retail broker does. The IBKR Level-1 problem
is purely a *live* problem; **the paper soak is not blocked at all** (the IBKR paper account has
full Level-3 perms, verified 2026-06-17).

So think of two independent slots:

| Slot | Needs | Today |
|---|---|---|
| **Paper (soak)** | API-accessible paper/sandbox with realistic fills | **IBKR paper** — works now, no live L3 needed |
| **Live (real money)** | Options **multi-leg** order API + L3 + margin | IBKR (blocked at L1) **or** an alternative |

They need not be the same broker. The `ExecutionBroker` seam + `broker-factory` already select
the implementation, so two adapters can coexist; mode picks which one runs.

---

## 2. Current selection mechanism (what exists)

- **Seam:** `src/main/execution/execution-broker.ts` — the `ExecutionBroker` interface (see §6).
- **Factory:** `src/main/execution/broker-factory.ts` — `resolveBrokerSettings(mode, env)` +
  `createExecutionBroker(settings)`.
- **Selection today is ENV-driven:** broker = `mock` unless `TA_EXEC_BROKER=ibkr`; port derived
  from `executionMode` (paper/live) and `TA_IBKR_GATEWAY`. `index.ts` builds the broker from
  `exec_config.executionMode` + env and logs `[execution] broker=… mode=…`.
- **Gap for this work:** selection is env-only. The user wants a **settings-driven** selector so
  the running app honors a persisted choice (no env editing). See §3.

---

## 3. Proposed settings/config model (shared by all options)

Add a **per-mode broker selection** to `exec_config`, editable in **Execution Settings**, with env
as an optional override (so power users / tests keep the env path).

```
exec_config.paper_broker  TEXT NOT NULL DEFAULT 'ibkr'   -- {mock, ibkr, etrade, tradier}
exec_config.live_broker   TEXT NOT NULL DEFAULT 'ibkr'   -- {mock, ibkr, etrade, tradier}
```

Active broker = `executionMode === 'live' ? live_broker : paper_broker`. This expresses every
option cleanly:

| Option | `paper_broker` | `live_broker` |
|---|---|---|
| 1 — IBKR paper + IBKR live | `ibkr` | `ibkr` |
| 2 — IBKR paper + E\*Trade live | `ibkr` | `etrade` |
| 3 — Tradier (paper + live) | `tradier` | `tradier` |

Resolution precedence (proposed): explicit `TA_EXEC_BROKER` env (override, for dev/tests) →
`exec_config.{paper,live}_broker` by mode → default `ibkr`. `createExecutionBroker` grows cases
for `etrade` / `tradier`. The **live spread-permission preflight (§2.13) and the type-to-confirm
live gate apply regardless of which live adapter is selected** — they're broker-agnostic, so any
new live venue inherits the fail-closed safety.

UI: a dropdown per slot in `ExecutionSettingsView` (Mode group), with the PAPER/LIVE badge already
present. Changing `live_broker` should require the same live-mode confirm gate as other live edits.

**Migration + types:** new migration adds the two columns; `ExecConfig` (src/shared/types.ts)
gains `paperBroker`/`liveBroker`; `RiskGovernor` get/updateConfig map them; factory reads them.

---

## 4. The three options in detail

### Option 1 — IBKR paper + IBKR live  *(no new adapter; settings only)*

**What:** Keep the single `IbkrExecutionBroker` for both modes. Add the §3 settings selector so
the choice is persisted/visible in the UI instead of env-only. This is the do-nothing-risky path
that simply preserves everything already built and makes broker selection first-class.

**Build scope:**
- §3 config model + migration + `ExecConfig` fields + factory wiring + Execution Settings dropdowns.
- No adapter work. No new API integration.

**Gating dependency:** still needs IBKR to approve **live** Options Level 3 (Reg-T margin + spreads).
Request via IBKR Client Portal → Trading Experience & Permissions. Until then, live stays refused by
the §2.13 preflight (correctly).

**Effort:** Low (settings/config only). **Risk:** Low. **Blocker:** IBKR L3 approval timeline.

---

### Option 2 — IBKR paper + E\*Trade live  *(settings + new `ETradeExecutionBroker`)*

**Why E\*Trade is the strongest of the already-owned brokers:** you already have **L3 + margin**
there, the app **already speaks E\*Trade OAuth 1.0a**, and its order API supports **spread/condor
order types** — exactly our structures. The OAuth core already signs any HTTP method
(`buildAuthHeader(method, …)` in `etrade-auth.ts` — base string uses `method.toUpperCase()`); only
the `etradeGet` wrapper is GET-specific. So adding signed order POSTs is a **thin extension, not a
new auth build**.

**Key limitation:** E\*Trade has **no API paper trading** (the `apisb.etrade.com` sandbox returns
canned sample data, not a tradable paper account). Therefore E\*Trade is a **live-only** venue here;
the soak stays on IBKR paper. Consequence: the E\*Trade *live* adapter is never exercised against
real paper fills → **de-risk with the mock for logic + a live "canary"** (1 contract, smallest
spread) before normal sizing.

**E\*Trade order API mapping to the `ExecutionBroker` seam** *(verify exact endpoints/fields against
current E\*Trade API docs at build time — captured from memory):*

| Seam method | E\*Trade mechanism |
|---|---|
| `connect` / `isConnected` | Reuse `etrade-auth` session; "connected" = valid access token. Tokens **expire midnight ET**, dormant after 2h → reuse `renewAccessToken()` / the `withRenew` retry wrapper. Critical for an always-on engine. |
| `qualifyContract` | Build OCC/option product from `{symbol, callPut, expiry Y/M/D, strikePrice}` — no separate qualify call needed (E\*Trade uses product fields, not a conId). Optionally validate via the options chain. |
| `priceCombo` | Price from per-leg quotes (chain), netted credit-positive — same approach as IBKR's `comboQuoteFromLegs`. |
| `getBuyingPower` | `GET /v1/accounts/{accountIdKey}/balance` (margin buying power). |
| `checkSpreadPermission` | You already hold L3 → can return ok, or do a `preview` (below) as the probe; preview validates eligibility without placing. |
| `placeOrder` (combo, idempotent on COID) | **Two-step: `preview` → `place`.** `POST …/orders/preview` with `orderType: SPREADS` (or `IRON_CONDOR`), `priceType: NET_CREDIT/NET_DEBIT`, `limitPrice`, `orderTerm: GOOD_FOR_DAY`, and multiple `Instrument`s (`orderAction` BUY_OPEN/SELL_OPEN/…, `Product`, `quantity`). Returns a **`previewId`** → `POST …/orders/place`. **E\*Trade requests carry a `clientOrderId`** → maps directly to our COID for idempotency. |
| `cancelOrder` | `PUT …/orders/cancel` (by orderId). |
| `onOrderStatus` / `onFill` | **No push/streaming — must POLL** `GET …/orders` (status filter) on the management cycle. Fills + commission come from order details. |
| `getOpenPositions` / `getOrders` | `GET …/portfolio` (positions, regroup legs) and `GET …/orders`. Reuses the existing portfolio plumbing pattern. |

**Build scope:**
- §3 settings (with `etrade` as `live_broker`).
- `etradePost`/`etradeRequest` signed helper (auth core already supports it).
- `ETradeExecutionBroker implements ExecutionBroker` — preview→place combo orders, COID
  idempotency, **polling-based** status/fill (no websocket), positions/orders reads, buying power,
  token renew-and-retry.
- Net-credit sign convention helper (analogue of `comboLimitOrderParams`), unit-tested.
- Reconciliation already broker-agnostic; just feed it E\*Trade truth.
- Live canary procedure documented in `03-lifecycle` before normal sizing.

**Effort:** Low–Medium (auth + data already integrated; main work = order preview/place + polling
loop + leg/sign mapping). **Risk:** Medium — live adapter unvalidated by paper (mitigate w/ canary);
polling latency vs IBKR push; token-expiry handling for unattended runs. **Blocker:** none external
(you already have L3+margin on E\*Trade).

---

### Option 3 — Tradier (paper + live on one API)  *(full new evaluation + build)*

**Why consider it:** Tradier is the closest true **drop-in for the IBKR model** — it has a real
**sandbox/paper environment** *and* production on the **same REST API**, with **multi-leg options
order** support (up to 4 legs). So you could soak *and* go live on one venue (unlike E\*Trade), and
spread-level approval is easy. This is the cleanest long-term answer if IBKR is a persistent pain.

**Tradier API characteristics** *(verify against current Tradier Brokerage API docs at build time):*
- **Auth:** Bearer token (simpler than OAuth 1.0a). Separate tokens for **sandbox** (`sandbox.tradier.com`, paper) and **production** (`api.tradier.com`).
- **Multi-leg orders:** `POST /v1/accounts/{id}/orders` with `class=multileg`, `duration`, `price`, and parallel arrays `option_symbol[N]` / `side[N]` (buy_to_open/sell_to_open/…) / `quantity[N]`. Uses **OCC option symbols** (not conIds).
- **Pricing:** net debit/credit limit on the multileg order.
- **Status/fills:** account **streaming (HTTP streaming/WebSocket)** *and* `GET …/orders` polling — better than E\*Trade.
- **Positions/balances:** `GET …/positions`, `GET …/balances` (buying power).
- **Idempotency:** confirm whether Tradier exposes a client-order tag; if not, the engine's COID
  is tracked app-side and dedup'd on reconcile (we already do this).
- **Paper caveat:** sandbox **simulates** fills and may not perfectly reflect the live book — better
  than nothing, not as faithful as IBKR paper. Note when interpreting soak results.

**Build scope (largest of the three):**
- §3 settings (`tradier` for both slots) + sandbox/production base-URL + token storage (secure-settings).
- `TradierExecutionBroker implements ExecutionBroker` — full lifecycle, OCC-symbol leg mapping,
  multileg order build, streaming **and/or** polling status/fills, positions/balances, permission
  check (or preview), reconciliation.
- New account onboarding (open Tradier account, fund, get L3, generate API tokens).
- Test suite for the pure mapping helpers (OCC symbols, multileg payload, net-price sign).

**Effort:** High (new account + full adapter + new auth/streaming model). **Risk:** Medium — new
venue, sandbox fill fidelity, onboarding time. **Upside:** restores the same-adapter paper→live model
the whole design wants, independent of IBKR.

---

## 5. Comparison & recommended sequencing

| | Opt 1 — IBKR/IBKR | Opt 2 — IBKR/E\*Trade | Opt 3 — Tradier |
|---|---|---|---|
| New adapter to build | none | E\*Trade (live) | Tradier (paper+live) |
| Already integrated | ✅ fully | ⚠️ auth+data only | ❌ none |
| You hold L3 + margin | pending (IBKR live) | ✅ E\*Trade | ❌ (open account) |
| Same adapter paper→live | ✅ | ❌ (paper on IBKR) | ✅ |
| Order status delivery | push | **poll** | push + poll |
| COID idempotency | ✅ | ✅ (`clientOrderId`) | tbc (app-side) |
| Effort | Low | Low–Med | High |
| External blocker | IBKR L3 approval | none | account onboarding |

**Recommended order of pursuit:**
1. **Build §3 settings now-ish (Option 1 substrate).** It's required by *all* paths and preserves
   everything built. Low risk, immediately useful.
2. **Keep soaking on IBKR paper** regardless — not blocked.
3. **If IBKR live L3 approves** → Option 1 is done; flip live.
4. **If IBKR live L3 stalls** → build **Option 2 (E\*Trade live)** — fastest route to live using an
   account you already have, with the canary mitigation.
5. **If IBKR becomes a persistent pain** and you want one clean venue for both → evaluate/build
   **Option 3 (Tradier)** as the durable answer.

---

## 6. Contract any new adapter must implement (`ExecutionBroker`)

From `src/main/execution/execution-broker.ts` (must be **idempotent on `clientOrderId`** and
**fail-closed** when disconnected):

```
connect(): Promise<void>
isConnected(): boolean
onConnectionState(cb: (s: ConnState) => void): void          // 'connected'|'disconnected'|'reauth_needed'
qualifyContract(spec: LegSpec): Promise<QualifiedContract>
priceCombo(legs: LegSpec[]): Promise<ComboQuote>             // credit-positive net, per-share
getBuyingPower(): Promise<BuyingPower>
checkSpreadPermission(probe?: LegSpec[]): Promise<PermissionCheck>   // §2.13 fail-closed preflight
placeOrder(o: OrderRequest): Promise<OrderAck>              // OrderRequest carries clientOrderId, legs, side, netLimit, contracts
cancelOrder(clientOrderId: string): Promise<void>
onOrderStatus(cb: (u: OrderStatusUpdate) => void): void
onFill(cb: (f: Fill) => void): void                         // Fill carries commission
getOpenPositions(): Promise<BrokerPosition[]>               // broker truth for reconciliation
getOrders(): Promise<BrokerOrder[]>
```

Sign conventions, leg→contract mapping, and (for polling brokers) the status/fill **poll loop**
live entirely inside the adapter — the governor, loops, order manager, reconciliation, UI, and the
live preflight are all broker-agnostic and unchanged.

---

## 7. Open questions to resolve at build time
- Confirm E\*Trade exact order endpoints/fields + whether `clientOrderId` is honored for idempotency on **multi-leg** orders.
- Confirm Tradier sandbox fill fidelity and whether it exposes a client-order tag.
- For polling brokers (E\*Trade), set the management-cycle poll cadence so fills are reconciled promptly without hammering rate limits.
- Decide whether `checkSpreadPermission` uses a real preview/whatIf per venue or trusts the known L3 status.
- Webull OpenAPI: only revisit if both E\*Trade and Tradier fall through — multi-leg options support is unproven and it's a fresh build. Robinhood: **excluded** (no official options trading API).
