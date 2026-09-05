# NewApp — the ground-up rebuild

Everything about the **new TradeAnalyzer application** (new exe, data-first, UI from day one) lives under this folder.
It is deliberately separate from the existing app's documentation:

| Folder | Belongs to |
|---|---|
| `NewApp/` | the **new** application — requirements, design, decisions |
| `Requirements/`, `docs/`, `.ai/`, `UserManual/`, `changelogs/` | the **existing** application (untouched, still the daily driver) |

Start at `NewApp/requirements/00-discovery-qa.md` — the discovery record (decisions D1–D7, questions Q1–Q20, all closed 2026-09-05).
Spec documents in `NewApp/requirements/`: `01-purpose-and-principles.md` (P1–P15, acceptance criteria) → 02 raw domains and data dictionary → 03 quality gate and exceptions → 04 collector → 05 inspector UI → 06 repository and packaging.

Code for the new app will live in `packages/core` (shared, Electron-free) and `packages/next` (the new exe) when the paper work is done — see Q11.
