# Remote Access & Web/Mobile Architecture — Future Project Spec

> **Status:** Proposed / not scheduled. This is a forward-looking design doc, not an active build.
> **Author:** drafted from a codebase coupling audit, 2026-06-27.
> **Scope:** Make TradeAnalyzer usable both as the current standalone desktop app **and** accessible remotely (web browser + mobile), from a single codebase.
> **Relationship to other specs:** This is an architecture initiative that sits above the feature specs in `Requirements/spec/`. It depends on the Tradier broker migration tracked in `Requirements/v2-execution/07-broker-alternatives.md`.

---

## 1. User requirements

Captured from the originating request: *"make the architecture such a way I can use it as a standalone app just like now, as well as accessible remotely."*

### 1.1 Functional requirements

- **FR-RA-1 — Standalone parity.** The app MUST continue to run as the current Electron desktop app with no loss of functionality or workflow. Remote access is additive, not a replacement.
- **FR-RA-2 — Remote browser access.** The app MUST be reachable from a standard web browser on another machine, presenting the same feature set as the desktop UI.
- **FR-RA-3 — Mobile access.** The app SHOULD be usable from a phone. Delivery as a responsive/installable web app (PWA) is acceptable and preferred over a native rewrite.
- **FR-RA-4 — Single UI codebase.** The React UI MUST NOT be forked between desktop and remote. One UI, two transports.
- **FR-RA-5 — Live/streaming features survive.** Progress bars, log tails, and push signals (currently 21 streaming channels) MUST continue to work over the remote transport.
- **FR-RA-6 — Trade execution integrity.** Any remote-accessible build MUST preserve the existing risk-governor and approval gates. Remote access MUST NOT widen the trade-execution attack surface without explicit auth (see NFR-RA-3).

### 1.2 Non-functional requirements

- **NFR-RA-1 — No machine-pinned dependencies on the hot path.** The backend MUST be hostable on a server without requiring a GUI broker terminal (TWS/Gateway) on the same box. *(This is why the Tradier REST migration is a prerequisite.)*
- **NFR-RA-2 — Single source of truth for the API.** The set of operations exposed to the UI SHOULD be defined once, not maintained as parallel IPC + HTTP surfaces that drift.
- **NFR-RA-3 — Authenticated remote transport.** Remote access MUST require authentication. Public-internet exposure of trade-execution endpoints is out of scope for v1 of this project; private-network access (VPN/Tailscale) is the supported model.
- **NFR-RA-4 — Reversibility.** The first migration step MUST be provable with zero UI changes, so the approach can be validated (and abandoned) cheaply.

### 1.3 Explicit non-goals

- **No native iOS/Android app.** React Native would require rewriting the entire UI (React components ≠ React Native components) for negligible benefit to a single-user tool.
- **No multi-tenant / multi-user SaaS.** This is a single-operator tool. Public-internet hosting, per-user auth, and credential isolation are out of scope.
- **No DB engine change required.** SQLite (`better-sqlite3`) stays; it simply lives on the backend, which is where it already is.

---

## 2. Current-state audit (evidence base)

Measured 2026-06-27 against the codebase. These numbers drive the effort estimate.

| Dimension | Finding | Implication |
|---|---|---|
| Renderer → backend call sites | 354 across 33 files | All route through **one** object |
| Distinct coupling seam | `window.api` (built in `src/preload/index.ts`) | Decoupling = swap **one** implementation behind **one** typed interface (`export type Api`) |
| Request/response methods | 270 `invoke<>` wrappers | Mechanically portable to HTTP |
| **Streaming/push subscriptions** | **21** `ipcRenderer.on()` channels | The only part needing WebSocket/SSE — the real design work |
| Backing IPC handlers | 291 `ipcMain.handle` across 31 modules | Already thin wrappers over service classes |
| Native dependencies (entire app) | **2**: `better-sqlite3`, `@stoqey/ib` | Both stay server-side; IBKR is the only machine-pinned one |
| Existing HTTP server | `src/main/api-server.ts` — Fastify, token auth, `/api/v1`, 14 route modules | The remote transport pattern **already exists**, calling the same service instances (currently a subset, for TraderAgent) |

### 2.1 Key architectural findings

1. **The UI is already transport-agnostic in shape.** None of the 33 view files touch Electron. They reference `window.api.*`, which is constructed once in `src/preload/index.ts` and exported as a typed `Api` interface. This is the single seam the whole project pivots on.
2. **A working backend HTTP server already exists.** `api-server.ts` proves the "services don't care whether they're called by IPC or HTTP" pattern. The HTTP surface is currently a *subset* of the IPC surface — the gap is the work, not the concept.
3. **There are only two hard problems** (everything else is mechanical volume):
   - The **21 streaming channels** can't use HTTP request/response — they need WebSocket or SSE.
   - **`@stoqey/ib` (IBKR)** needs a persistent host connected to TWS/Gateway, which is hostile to remote hosting. **The Tradier (REST) migration eliminates this**, so it is a hard prerequisite, not optional scope.
4. **`better-sqlite3` is a non-issue.** It is a backend dependency today and remains one. No DB migration needed.

---

## 3. Options considered

### Option A — Headless core with a single HTTP/WS transport *(recommended)*

Collapse today's dual surface (IPC + partial HTTP) into one HTTP/WebSocket API. The React UI talks to `window.api`, which has two interchangeable implementations behind the same `Api` interface:

```
        React UI (unchanged — 354 call sites, talks only to window.api)
                                  │
                  one Api interface, two implementations
        ┌─────────────────────────┴──────────────────────────┐
   standalone: loopback HTTP/WS client          remote: HTTP/WS client (fetch + WebSocket)
        └─────────────────────────┬──────────────────────────┘
                                  │
            Fastify HTTP + WebSocket API  ── same service instances ──>  SQLite + Tradier (REST)
            (in-process inside Electron, OR headless Node on a host)
```

- **Standalone:** Electron boots the Fastify server on loopback and points the window at it.
- **Remote:** the *same* server binds to a Tailscale/LAN interface; any browser/phone loads the same React bundle.
- The React app is byte-identical in both modes; the correct `window.api` implementation is injected at startup.

**Pros:** one UI, one API surface (satisfies NFR-RA-2), remote becomes "bind to a different interface," and IPC can eventually be deleted entirely. **Cons:** must port all 270 methods to HTTP and the 21 events to WebSocket; loopback HTTP has marginally more overhead than IPC (irrelevant at this call volume).

### Option B — Keep IPC for desktop, add a parallel HTTP/WS client for remote

Leave the Electron IPC path exactly as-is. Add a second `window.api` implementation (HTTP/WS) used only in the browser, backed by an expanded Fastify surface.

**Pros:** zero risk to the existing desktop path; smaller blast radius. **Cons:** **violates NFR-RA-2** — two API surfaces (IPC handlers + Fastify routes) must be kept in sync forever, which is the maintenance trap. Acceptable as an interim, not as the end state.

### Option C — Native mobile app (React Native) *(rejected)*

**Rejected.** Full UI rewrite; React components are not portable to React Native. No benefit over a PWA for a single-user tool. Listed only to record the decision.

---

## 4. Recommendation

**Adopt Option A (single HTTP/WS transport), reached via an Option-B-style interim step for safety.**

Rationale: Option A is the only end state that satisfies NFR-RA-2 (single API surface) and makes "remote" nearly free once built. But the migration should be **proven reversibly first** (NFR-RA-4) by routing the existing desktop renderer through the in-process Fastify server over loopback. If the UI works unchanged against HTTP/WS on the desktop, the entire remote path is de-risked without touching a single view.

### 4.1 Prerequisites

- **P1 — Tradier broker migration complete** (`Requirements/v2-execution/07-broker-alternatives.md`). Removes the only machine-pinned dependency (`@stoqey/ib`). **Hard blocker for remote hosting.**

### 4.2 Phased plan

| Phase | Goal | Work | Risk |
|---|---|---|---|
| **0. Prereq** | No machine-pinned broker | Finish Tradier REST adapter | (tracked elsewhere) |
| **1. Prove the seam** | Desktop renderer runs over loopback HTTP/WS with zero UI changes | Build HTTP-backed `window.api` shim for a handful of methods + 1 event; point dev renderer at loopback Fastify | Low — reversible, UI untouched |
| **2. Port request/response** | All 270 methods reachable over HTTP | Expand Fastify to mirror the 291 IPC handlers (mechanical; parallels existing route modules). Consider code-gen from the shared `Api` type | Low, high-volume |
| **3. Port streaming** | All 21 channels over WebSocket/SSE | Design one WS multiplexing scheme; migrate the 21 `ipcRenderer.on` channels (progress, logs, ticker signals, backtest/replay progress) | Medium — the real design work |
| **4. Remote delivery** | Browser + mobile access | Serve the React bundle; make UI responsive; ship as PWA; bind server to Tailscale/LAN interface | Low (code) / Ops |
| **5. Cleanup** | Single transport | Delete IPC path once HTTP/WS proven in daily use | Low |

### 4.3 Effort drivers, ranked

1. **Port 270 methods to Fastify** — the bulk; mechanical, low-risk, automatable.
2. **HTTP-backed `window.api` shim** — one file mirroring `buildApi()` with `fetch`; mechanical.
3. **21 streaming events → WebSocket/SSE** — the genuine design work.
4. **Tradier migration** — prerequisite, already on the roadmap.
5. **Remote auth/TLS** — token mechanism already exists in `api-server.ts`; Tailscale makes TLS a non-issue.

---

## 5. Security considerations

- The desktop app is a single-user trust boundary on `127.0.0.1`. Remote access changes this fundamentally — the app **places real trades**.
- **Supported model (in scope):** private network only. Backend on a home machine or VPS, reached over **Tailscale/VPN**. Gets phone + web access with almost none of the public-internet exposure.
- **Out of scope for v1:** public-internet hosting. That would require hardened auth, TLS termination, server-side broker-credential encryption, rate limiting, and audit logging on internet-facing trade-execution endpoints — a separate security project, not a port.
- The existing `X-Agent-Token` auth (`api-server.ts`) is the starting point for remote auth; it MUST be enforced on the WebSocket upgrade path too, not just HTTP.

---

## 6. Open questions

- **OQ-1:** WebSocket vs SSE for the 21 streaming channels? (SSE is simpler/one-way and fits progress/log streams; WS needed only if the UI must push upstream over the same channel.)
- **OQ-2:** In standalone mode, keep IPC indefinitely or cut over to loopback HTTP/WS (Phase 5)? Cutting over yields a single transport but is strictly more work.
- **OQ-3:** Auto-generate the Fastify route layer and the HTTP `window.api` shim from the shared `Api` type, or hand-write? Code-gen reduces the 270-method drift risk (NFR-RA-2).
- **OQ-4:** PWA scope on mobile — full feature parity, or a read-mostly subset (monitor + approve) with heavy workflows kept desktop-only?

---

## 7. Decision log

- **2026-06-27** — Coupling audit performed; single `window.api` seam confirmed; Option A recommended; Option C (React Native) rejected. Project parked as future work pending Tradier migration.
