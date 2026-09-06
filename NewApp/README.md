# NewApp — the ground-up rebuild

Everything about the **new TradeAnalyzer application** (new exe, data-first, UI from day one) lives under this folder.
It is deliberately separate from the existing app's documentation:

| Folder | Belongs to |
|---|---|
| `NewApp/` | the **new** application — requirements, design, decisions |
| `Requirements/`, `docs/`, `.ai/`, `UserManual/`, `changelogs/` | the **existing** application (untouched, still the daily driver) |

Start at `NewApp/requirements/00-discovery-qa.md` — the discovery record (decisions D1–D7, questions Q1–Q21, all closed 2026-09-05).
Spec documents in `NewApp/requirements/`: `01-purpose-and-principles.md` (P1–P15, acceptance criteria) → `02-raw-domains-and-data-dictionary.md` (conventions, every table and column) → `03-quality-gate-and-exceptions.md` (check catalogue, exception lifecycle, status email) → `04-collector.md` (run pipeline, archive, one-shot jobs, hand-off) → `05-inspector-ui.md` (schema-driven inspector, bespoke views, exceptions workbench) → `06-repository-and-packaging.md` (workspace, versioning, build order B1–B10, definition of done). **All six drafted (v1, 2026-09-05); every carried open item closed 2026-09-05 except the † thresholds (03 §10) and the pre-pilot measurements (04 §11), which need pilot data. Operator review pending.**

Code for the new app will live in `packages/core` (shared, Electron-free) and `packages/next` (the new exe) when the paper work is done — see Q11.
