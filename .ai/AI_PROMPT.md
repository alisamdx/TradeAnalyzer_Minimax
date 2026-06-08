# AI_PROMPT — session kickoff

> This is a **thin bootstrap pointer**, not a rulebook. It exists so you can start a session by saying *"read `.ai/AI_PROMPT.md`"* instead of retyping the opener. The actual rules live in `CLAUDE.md`; the build state lives in `.ai/AI_CONTEXT.md`. Do **not** copy rules into this file — point to them, so nothing drifts.

## Standing opener

Read `CLAUDE.md` and `.ai/AI_CONTEXT.md` first. Then do the task below.

When done, follow the **Documentation maintenance** rules in `CLAUDE.md`: update the changelog (`CHANGELOG.md` + `changelogs/v{version}_{date}.md`), `.ai/AI_CONTEXT.md`, and the affected `Requirements/spec/` section; bump the version; commit (single Conventional Commit); and run `npm run package`.

## Task

[Describe the task here.]

---

### Where things live (reference)
- **`CLAUDE.md`** — operating rules, conventions, key files, known quirks, the doc-maintenance checklist. *(loads automatically in Claude Code)*
- **`.ai/AI_CONTEXT.md`** — current build state: providers, schema, services, views, quirks.
- **`Requirements/spec/`** — authoritative, rebuild-from-scratch spec (start at `00-index.md`). `Requirements/_legacy/` is frozen.
- **`CHANGELOG.md` + `changelogs/`** — release history.
- **`docs/`** — formulas, architecture, troubleshooting.
