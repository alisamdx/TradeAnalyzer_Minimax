# AI_PROMPT — Standing instructions for any AI session on this repo

You are picking up a multi-phase build of the **TradeAnalyzer_Minimax** desktop app. Before writing code:

1. **Read `AI_CONTEXT.md` first.** It is the source of truth for stack, structure, schema, conventions, and recent decisions. If anything in this prompt conflicts with `AI_CONTEXT.md`, prefer `AI_CONTEXT.md`.
2. **Read `REQUIREMENTS.md`** for the full functional/non-functional spec. Treat every `FR-*` and `NFR-*` as an acceptance test.
3. **Section 7 of `REQUIREMENTS.md` is mandatory infrastructure.** Versioning, changelogs, API/error logs, AI context, tests, migrations, and the git workflow described there must be maintained on every change.

## Hard rules

- **Phased delivery.** Build the requested phase only. Do not jump ahead. Each phase ends with: tests green, changelog entry, `AI_CONTEXT.md` updated, single git commit (Conventional Commits).
- **Never bypass the rate limiter.** All Polygon traffic must go through the producer/consumer pipeline once it exists (Phase ≥ 3). No ad-hoc `fetch` to Polygon from anywhere else.
- **Never invent market data.** If a provider field is missing, surface it as missing — do not synthesize a plausible number.
- **Never log secrets.** API keys live in OS keychain or `.env` and are scrubbed from logs at write time.
- **Every material change updates `CHANGELOG.md` + `changelogs/v{version}_{date}.md` + `AI_CONTEXT.md` in the same commit.** Bump the version per semver (PATCH/MINOR/MAJOR).
- **Every formula in code that derives a financial metric** has a `// see docs/formulas.md#anchor` comment and a corresponding entry in `docs/formulas.md`.
- **Every bug fix ships with a regression test** that fails before the fix and passes after.

## Working agreement

- Prefer the simplest implementation that satisfies all requirements in scope. Don't add features outside the spec; if you think one is needed, add it to `Open Decisions` in `AI_CONTEXT.md` and surface it in the response.
- Keep `AI_CONTEXT.md` under 1,500 lines. When older `Recent Changes` start to push it over, move them to the changelog folder and prune.
- If you discover a non-obvious gotcha, add it to `Known Quirks & Gotchas` in `AI_CONTEXT.md`.
- Use `// TODO(phase-N):` comments to mark deferred work tied to a future phase, with a brief reason.
