# 01 — Purpose and principles

> **Status:** draft v1, 2026-09-05. Derived from `00-discovery-qa.md` (decisions D1–D7, questions Q1–Q21, all closed). Every principle below cites the discovery item it comes from and, where one exists, the failure in the existing app that motivates it.
> **Audience:** the operator and any AI session building the new application. This is the document every later spec section must be consistent with. If a later section conflicts with this one, this one wins until it is revised here.
> **Document map:** 01 purpose and principles (this) → 02 raw domains and data dictionary → 03 quality gate and exceptions → 04 collector → 05 inspector UI → 06 repository and packaging.

---

## 1. Purpose

**Each trading day, produce a complete, point-in-time, auditable record of the market and of the operator's account, from which any trade-selection rule can later be evaluated against what actually happened, with no stored value ever in doubt.**

Three phrases carry the weight:

- **Complete.** Everything that was considered is stored, not only what was chosen. The full option ladder, not the strikes near the money. The rejected candidates, not only the pick. A dataset that keeps only survivors cannot tell you whether the selection was any good (Q2, Q6).
- **Point-in-time.** Every fact is stored as it was known at a stated moment and is never overwritten. The question "what did the data say on the day the decision was made" must always have exactly one answer (D6, Q3).
- **Never in doubt.** Not "100% accurate" — providers are sometimes wrong. Instead: every value traceable to an archived provider response, every gap explicit, every derived number reproducible from raw inputs, and every anomaly detected and flagged before anything reads it (D6).

The application that grows on this foundation exists to help one retail options trader choose entries, mostly cash-secured puts and covered calls under a wheel discipline, and later other structures. Stage 1 builds only the foundation. It does not screen, score, recommend or trade (D3).

### 1.1 What "good" looks like

The operator has not yet placed a real trade on the existing app's recommendations because every close look at the data found a fault. The concrete failures this foundation must make structurally impossible (D7):

| Failure in the existing app | Root cause | Principle that prevents it |
|---|---|---|
| NVDA recommended as wheel #1 on the day it reported earnings | Bulk earnings payload truncated by the provider; a wrong future date, once stored, suppressed three correction mechanisms | P1 (append, never overwrite), P8 (quality gate: capped response = suspect), P4 (reproducible from raw) |
| DINO picked at a price that made no sense to own | Conviction band anchored to the quantity it was tested against, so the gate could never fire; nobody noticed because a gate that never fires looks like a gate nothing violates | P10 (a check is unverified until it has been shown able to fire) |
| Replay always finds a data fault | Unadjusted splits in an incrementally stored price series; option legs frozen on a different price scale from repaired prices | P2 (provenance), P4 (re-derive from raw, never patch derived data in place), P8 (discontinuity check on arrival) |
| Inconsistent P&L trend figures | Closed-position P&L "estimated from last mark" instead of taken from fills; ticker+type matching collapsed distinct lots | P2, P3 (an estimate is not a value; it is a gap with a status), P13 (raw broker records captured from day one) |
| Fields stored null forever | Providers omitting fields, `?? 0` and `?? null` turning "not reported" into "zero" or "unknown" with no way to tell which | P3 (every null has exactly one declared meaning) |
| Percentage stored where a fraction was expected | Conversions scattered across services; E*Trade returns fractions, storage held percentages | P7 (one conversion, at ingestion, per a data dictionary) |
| Morning pick destroyed by the evening run | Same-day rows deleted and rewritten; only one of two acted-upon outputs ever stored | P1, P6 (the capture rule and slot travel with every row) |

---

## 2. Scope

### 2.1 Stage 1 — in scope

- The **fifteen raw domains** (Q5, Q16, Q21): daily bars; end-of-day quotes; option chains; corporate actions (splits, dividends); earnings dates; fundamentals; VIX and macro series; the operator's E*Trade positions, balances and executed orders; ticker reference data; trading calendar; macro event calendar; risk-free rate; **short interest; analyst view (recommendations, estimates); insider transactions** (the last three added by Q21, 02 §12).
- The **universe**: S&P 500 + Russell 1000 + ETFs, ~1,587 tickers, membership versioned (Q1). Option chains for a **rule-based liquidity subset** of the universe, sticky at the ticker level (Q15); **every strike** E*Trade returns, expirations to 90 DTE plus the two nearest monthlies beyond, sticky at the contract level (Q2).
- **One after-close capture** per trading day, designed so additional slots are configuration (Q3).
- A **raw-response archive** for every provider call, the provenance layer (sizing notes; Q20 for account data).
- A **quality gate** on every run and a seven-part **exception workflow** with a daily status email that is sent on green days too (Q9, Q18).
- A **schema-driven inspector UI** in which every stored table is viewable, plus bespoke views where shape matters (D5).
- A segregated record of the **existing app's daily decisions**, complete including rejected candidates (Q6), and a one-time **import from legacy** of user-authored configuration (Q19).
- One-time **backfills**: daily bars from the Polygon API at full plan depth; a one-time external IV-history bootstrap held as a segregated series (Q7, Q17, Q10).
- **Data generations** with first-class reset and raw-archive replay; the first generation is a pilot (Q14).

### 2.2 Stage 1 — out of scope

- Any analysis, screening, scoring, recommendation, AI synthesis or order execution (D3). These are later stages that consume stage-1 data only after the pilot exit criterion is met (Q14).
- News, insider transactions, AI outputs as data domains (Q5).
- Derived book analytics: pairing opens to closes, lot construction, realised P&L, assignment-as-conversion (Q13, deferred to stage 2).
- Migration of any provider-sourced history from the existing database (D4, Q19).
- Any change to what the existing app decides, displays or emails (D1).

### 2.3 Relationship to the existing application

- The existing app is **untouched and remains the daily driver** until the new UI is usable. The only permitted changes to it are data-capture additions: hosting the collector as a batch job, opening a second SQLite connection to the new database, and handing its brief's full candidate set and decision trace to the collector (D1, Q4, Q6).
- The two are **separate applications with some shared foundations**: one repository, the existing app at the root, shared Electron-free code in `packages/core`, the new exe in `packages/next` (Q11).
- In stage 1 the **existing app makes every provider call** on behalf of the collector, so there is one E*Trade token holder and one rate limiter (Q4). The new exe reads the new database, write-capable, and does not call providers.

---

## 3. Principles

Each principle has a statement, the reason it exists, and what it requires or forbids. The identifiers (P1…P15) are referenced by later sections and by acceptance criteria in §4.

### P1 — Point-in-time, append-only
**Statement.** Every stored fact carries the moment it was observed and the moment it is about. Nothing is updated or deleted in place. A correction, a re-fetch or a recompute appends a new row that supersedes the old one; the old row stays.
**Why.** The existing app deleted the morning brief when the evening ran, overwrote earnings dates in place so a wrong write silenced its own correction, and re-fetched a three-day price window into a series adjusted on a different basis (D7, Q3).
**Requires.** `observed_at` and an as-of key on every raw row; supersession expressed as a new row with a pointer or a validity range; deletion permitted only as part of a generation reset (P14). **Forbids.** `INSERT OR REPLACE` / `UPDATE` on raw tables; any query that assumes one row per key without stating which version it wants.

### P2 — Provenance to the raw response
**Statement.** Every non-null stored value can be traced to a specific archived provider response, and that response is stored verbatim and compressed on disk, keyed by provider, endpoint, parameters and time.
**Why.** The existing IV history is three sources spliced at two dates with no raw record of any of them; nothing about it can be re-checked (Q7). The estimated-P&L saga could not be diagnosed until the provider's calls were logged at all.
**Requires.** A `source_response_id` (or equivalent) on every raw row; archive written before the row is parsed; account-domain archive encrypted at rest with the OS keychain (Q20). **Forbids.** Storing a value whose response was not archived; logging authentication success bodies (they carry tokens).

### P3 — Every null has exactly one meaning
**Statement.** A column may be null only if the data dictionary declares it nullable and states the single thing null means there. Where more than one meaning is possible ("provider omitted", "outside capture window", "not applicable", "failed validation"), a companion status column carries the meaning and the value column is not consulted alone.
**Why.** `leg.volume ?? 0` turned "not reported" into "did not trade" on 23 of 250 stored legs. An estimated P&L was stored in the same column as a realised one with nothing to tell them apart (D7, Q8).
**Requires.** Data-dictionary entry per column: type, unit, nullable, null meaning. **Forbids.** Defaulting a missing provider field to 0, empty string or any sentinel; storing an estimate in a column whose dictionary entry says "observed".

### P4 — Derived data is a pure function of raw data
**Statement.** Anything not received from a provider is computed from raw rows by versioned code and can be recomputed, byte-identical, from the archive. Derived tables are disposable; the raw archive and raw tables are not.
**Why.** The split repair fixed the price series but not the option legs frozen inside the stored briefs, so the two sat on different scales and inverted a backtest headline. A derived value patched in place cannot be re-derived (D7).
**Requires.** A `derivation_version` on every derived row; a tested **replay** path that rebuilds a fresh database from the archive (Q14). **Forbids.** Hand-editing derived rows; storing derived values inside raw tables; "repair" scripts that mutate rather than recompute.

### P5 — Store the considered set, not the survivors
**Statement.** When a process chooses among alternatives, the alternatives it rejected are stored with the reason for rejection, alongside the choice.
**Why.** The brief persisted only its top five of fifteen, so whether its ranking was any good became untestable; the dice's tiebreak turned out to face a choice on 7 of 62 days, a fact that took a study to learn because the eligible set was never stored (D7, Q6).
**Requires.** For the existing app's decisions captured in stage 1: full candidate set, every gate's pass/fail and reason, signal values, priced legs, selection trace (Q6). For the option chain: every strike returned (Q2). **Forbids.** Any capture that filters at ingestion on a criterion a downstream consumer might later want to vary.

### P6 — Capture rules are data
**Statement.** Every snapshot row records which rule produced it: the slot, the expiration window, the ticker subset rule and version, the sticky-set membership reason. Absence is therefore always interpretable as "outside that day's window", never "unknown".
**Why.** A contract that drifts out of a capture window looks identical to one that stopped trading unless the window travels with the data (Q2). The existing app's two slots produced incomparable liquidity scores and stored only one of them (D7, Q3).
**Requires.** `capture_rule_id` and `slot` on every snapshot row; a `capture_rules` table with versioned definitions; membership change log for the universe and the chain subset with date and reason (Q1, Q15). **Forbids.** Changing a capture rule without recording a new rule version.

### P7 — One conversion, at ingestion, per the data dictionary
**Statement.** Storage holds the mathematical form: ratios as decimal fractions, money as decimal USD per share, quantities as integers, dates as `YYYY-MM-DD` trading days in America/New_York, timestamps as ISO-8601 with explicit offset. Provider values are converted exactly once, at ingestion, by code that reads the data dictionary; the raw value stays in the archive. Formatting for display happens only in the UI.
**Why.** IV was stored as a percentage while the provider sent a fraction, and the `* 100` lived in several places; a percentage landed where a number was expected (D7, Q8).
**Requires.** The data dictionary (02) as the single source of unit truth; ingestion tests that assert unit conversion per field; UI formatters that read units from the dictionary. **Forbids.** Any unit conversion outside the ingestion layer; any literal `* 100` or `/ 100` in a query or view.

### P8 — Nothing is used before it passes the gate
**Statement.** Every collector run ends with a quality report stored beside the data: row counts against expected, nulls per field against declared allowances, range checks, cross-source disagreements, discontinuity and volume-regime checks, and "response at a provider cap" detection. Findings are exceptions with a severity. A blocking exception marks that domain's day unusable until resolved or accepted. Nothing is ever deleted because of a finding.
**Why.** A truncated bulk earnings payload was trusted because it arrived; split discontinuities were discovered by hand months after they corrupted every indicator (D7, Q9).
**Requires.** The gate runs inside the collector, not as an optional script; downstream readers check the day's usability flag; a capped or partial response is an exception by default. **Forbids.** Marking a day usable by default; deleting rows to make a check pass.

### P9 — Silence is not a signal
**Statement.** After every collector run a status email is sent, including on green days: per-domain counts against expected, new/open/resolved exception counts, blocking items first. An exception appears in every report until its state changes and is never aged out.
**Why.** The existing app's evening chain was halted 8 of 10 trading days before anyone noticed; a dead scheduler and a clean day look identical when the only signal is an alert (Q18).
**Requires.** The green email; repeat-offender escalation; an exceptions view where state is changed with a note (Q18). **Forbids.** Alert-only reporting; auto-closing exceptions on the next clean run.

### P10 — A check is unverified until it has been shown able to fire
**Statement.** Before any threshold, gate or validation rule is relied upon, the distribution of the tested quantity relative to the threshold is measured on real data and recorded. A rule whose ratio never approaches its boundary is decorative and is marked as such.
**Why.** The conviction "never enter above" band was anchored to spot on the day it was written and so sat at ~0.83 of every strike by construction; it rejected 0 of 39 picks and nobody could tell (D7).
**Requires.** For every quality check in 03: the **distribution of the quantity it tests, recorded on every evaluation whether or not it fired**, reviewed against the threshold at pilot exit (03 §4 `distribution_json`, QC-955). A fire count alone is not enough and never was — zero fires looks identical whether the boundary sits in an empty gap or a mile beyond every real value, which is exactly how the conviction band went unnoticed. Checks that never fired are flagged for review, not assumed correct. Applies with full force to any later stage's trading gates.

### P11 — One choke point per capability
**Statement.** Every capability that must apply to all callers lives in the one function all callers pass through: one provider transport per provider, one writer per table, one validator per invariant, one ingestion converter per field.
**Why.** The E*Trade OAuth calls sat outside the instrumented transport for 23 versions; the conviction-band invariant was enforced in the edit form but not in the AI-apply path; the balance snapshot was wired into the scheduled sync but not the button (CLAUDE.md quirks).
**Requires.** Raw tables written only by the collector's ingestion module; invariants enforced by the writer, backed by database CHECK constraints where SQLite allows. **Forbids.** A second code path that writes a raw table; validation that lives only in a UI.

### P12 — Remediation is automatic only when deterministic and additive
**Statement.** The collector may retry, re-fetch a whole range, or re-run a check on its own, and records what it attempted on the exception. It never deletes, overwrites or chooses between ambiguous explanations. Ambiguity (ticker reuse versus a genuine move; a real earnings-date change versus a coverage gap) waits for the operator.
**Why.** Discriminating a split from a repricing from a ticker reuse needed volume evidence and a human; an automatic "fix" would have been wrong two ways out of three (CLAUDE.md quirks, Q18).
**Requires.** Every auto-remediation logged on the exception; a hard list of permitted automatic actions in 03.

### P13 — Everything stored is visible
**Statement.** Every table in the new database is viewable in the inspector without writing code for it: the inspector renders from the data dictionary with sort, filter, null highlighting, unit labels and the run's quality flags. Bespoke views are added where shape matters, never as the only way to see a table.
**Why.** D5. Data that cannot be looked at is data that will be trusted blindly; the operator's method is to look and ask.
**Requires.** A table appears in the inspector the moment its dictionary entry exists; the exceptions view drills to the offending rows.

### P14 — Generations: reset and replay are first-class
**Statement.** The database file and raw archive live under a numbered generation. Reset closes the current generation, keeps it read-only, and opens the next. Replay rebuilds a fresh database from a generation's raw archive with current code. The first generation is a pilot and nothing downstream consumes it until it has run 20 consecutive trading days with zero unresolved blocking exceptions and every domain has been visually inspected.
**Why.** The operator wants the freedom to start over cleanly if the early capture proves flawed, without losing the evidence of what went wrong (Q14). Replay is what makes P4 real.
**Requires.** Reset and replay as tested UI operations; configuration and the legacy import re-runnable so a reset costs data-days only. **Forbids.** Deleting a generation.

### P15 — Secrets and account data are protected
**Statement.** Credentials live in the OS keychain and are never copied between apps; authentication success bodies are never logged or archived; the account-domain raw archive is encrypted at rest; the account key is masked in logs.
**Why.** The API log is a plaintext file with retention; the raw archive would otherwise be the one place complete statements sit (Q19, Q20).
**Requires.** Leak-canary tests as in the existing `etrade-auth-logging` test; a documented DPAPI limitation (archive readable only by the same Windows user; recovery is re-pull, which is why pulls are idempotent).

---

## 4. Acceptance criteria for the foundation

Testable statements. Later sections refine them; stage 1 is complete when all hold on the pilot generation.

| ID | Criterion | Principle |
|---|---|---|
| AC-1 | For any non-null value in any raw table, the inspector can open the archived provider response it was parsed from. | P2 |
| AC-2 | No raw table has ever had a row updated or deleted (verified by a trigger or an audit count) except through a generation reset. | P1 |
| AC-3 | Every column in the database has a data-dictionary entry; every nullable column has a stated null meaning; the inspector shows both. | P3, P13 |
| AC-4 | Replaying a generation's raw archive with the same code reproduces every raw and derived table exactly, compared over **dictionary-declared fact columns** — excluding surrogate keys (`row_id`), `run_id` and `meta_` timestamps, which are bookkeeping and restart at 1 in a fresh database. | P4, P14 |
| AC-5 | For the option chain, the number of contracts stored per (ticker, expiration, day) equals the number returned by the provider for that call. | P5 |
| AC-6 | Every snapshot row's `capture_rule_id` resolves to a stored rule whose definition explains why that row is present. | P6 |
| AC-7 | For every field with a unit, an ingestion test asserts the conversion from the provider's representation; no `*100` / `/100` appears outside ingestion. | P7 |
| AC-8 | Every collector run produces a stored quality report; a day with an open blocking exception reads as unusable through the same API downstream readers use. | P8 |
| AC-9 | A status email is sent after every run, including runs with zero findings; an open exception appears in every subsequent email until its state changes. | P9 |
| AC-10 | Every quality check has a recorded fire-count over the pilot, and every check testing a magnitude has that magnitude's distribution recorded against its threshold on every evaluation; checks with zero fires, and thresholds no observation ever approached, are both listed for review at pilot exit. | P10 |
| AC-11 | Each raw table has exactly one writer module; a test fails if any other module references the table in a write statement. | P11 |
| AC-12 | Every automatic remediation is recorded on the exception it addressed; no code path deletes or overwrites data in response to a finding. | P12 |
| AC-13 | Every table appears in the inspector with no table-specific UI code. | P13 |
| AC-14 | Reset creates a new generation and leaves the previous one intact and readable; legacy import and configuration re-run into the new generation without operator re-entry. | P14 |
| AC-15 | Leak-canary tests prove no token, secret or auth success body reaches any log or unencrypted archive; the account archive is unreadable without the OS keychain. | P15 |

---

## 5. Glossary

- **Raw domain.** One of the fifteen categories of provider-sourced data captured as received (after unit conversion only).
- **Raw table.** A table holding raw-domain rows; append-only; one writer.
- **Derived table.** A table computed from raw tables by versioned code; disposable; rebuilt by replay.
- **Snapshot.** The set of rows captured for one domain in one run under one capture rule.
- **Capture rule.** A versioned definition of what a run captures for a domain (universe rule, chain subset rule, expiration window, slot).
- **Sticky set.** Tickers or contracts that remain in the capture set after they would otherwise fall out of the rule (Q2, Q15).
- **Raw archive.** The compressed, verbatim store of provider responses; the provenance layer.
- **Generation.** One database file plus its raw archive, numbered; the unit of reset.
- **Replay.** Rebuilding a database from a generation's raw archive with current code.
- **Quality report.** The per-run record of checks, counts and findings.
- **Exception.** One finding from the quality gate, with severity and a resolution state.
- **Blocking.** The severity that marks a domain's day unusable.
- **External series.** A one-time historical load from a source not used ongoing, stored segregated with source, method and stitch date (Q17, Q10).
- **Stitch date.** The date at which readers switch from an external series to own-captured data.
- **Legacy tables.** The segregated `legacy_*` family holding the existing app's decisions and pre-collector history (Q6, Q19).
- **Pilot.** The first generation, provisional until the exit criterion in P14 is met.

---

## 6. Traceability

| Principle | Discovery source |
|---|---|
| P1 | D6, D7, Q3, Q13 |
| P2 | D6, Q7, Q10, Q17, sizing notes |
| P3 | D7, Q8 |
| P4 | D6, D7, Q14 |
| P5 | Q2, Q6 |
| P6 | Q1, Q2, Q3, Q15 |
| P7 | D7, Q8 |
| P8 | Q9 |
| P9 | Q18 |
| P10 | D7 (DINO), CLAUDE.md quirks |
| P11 | CLAUDE.md quirks, Q4 |
| P12 | Q18 |
| P13 | D5 |
| P14 | Q14 |
| P15 | Q19, Q20 |

## 7. Items carried to later sections — all resolved

Every item this document carried forward was closed by the section that owned it (2026-09-05):

| carried item | closed in |
|---|---|
| Concrete liquidity-screen thresholds for the chain subset, with the admitted count (Q15) | 04 §4.1 (`chain_subset` capture rule) and §4.2 (the admission rule). The **count** those thresholds admit is a measurement, still pending in 04 §11. |
| Choice of the one external IV-history source (Q17) | 04 §7.3 defines the `bootstrap_iv` job and its overlap check; **which** source is a pending item in 04 §11. |
| Expected-count model per domain for the quality gate (Q9) | 02 §15 (the model) → 03 §3 (the checks that read it). |
| The exact list of permitted automatic remediations (P12) | 03 §6 — seven codes R1–R7, plus the operator-only actions that are deliberately not among them. |
| The existing brief job's data-capture hand-off contract (Q6) | 04 §8 (`LegacyBriefHandoff`) → 02 §14 (`legacy_` tables). |

Two of these leave a **measurement** behind rather than a decision — the admitted subset count and the IV source. Both are in the pre-pilot checklist (04 §11) and neither blocks any build step before B7.
