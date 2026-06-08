# Requirements

## `spec/` — authoritative specification

**[`spec/`](spec/00-index.md) is the single source of truth.** It is a self-contained, rebuild-from-scratch specification: if the entire codebase were lost, the application could be reconstructed from `spec/` alone. Start at **[`spec/00-index.md`](spec/00-index.md)** for the master table of contents, glossary, and suggested rebuild order.

Depth: functional behavior + data model (full schema) + every formula. UI is described by layout and intent, not pixel-level styling.

| Tier | Sections |
| --- | --- |
| Foundation | 01 overview/architecture · 02 data model · 03 data providers |
| Core | 04 watchlists · 05 screener & filters · 06 analysis engine · 07 validation |
| Options & strategy | 08 options chain & payoff · 09 strategy lab & knowledge · 10 LEAPS screeners |
| Intelligence | 11 IV history · 12 opportunity · 13 scoring engine · 14 daily brief & critic · 15 retrospect · 16 news & research · 17 earnings |
| Portfolio & infra | 18 portfolio · 19 conviction list · 20 batch jobs · 21 backtesting · 22 agent & API |
| Reference | 23 formulas · 24 engineering practices |

## `_legacy/` — archived design docs

[`_legacy/`](_legacy/) holds the original `REQUIREMENTS.md` and the per-feature design docs written during incremental development. They are **outdated and non-authoritative** — kept only for historical design rationale. When `spec/` and a `_legacy/` doc disagree, `spec/` wins.

## Maintenance

`spec/` is regenerated from the current app, not patched piecemeal. When a feature changes materially, update the relevant `spec/` section in the same commit (alongside `CHANGELOG.md` and `.ai/AI_CONTEXT.md`), per `spec/24-engineering-practices.md`.
