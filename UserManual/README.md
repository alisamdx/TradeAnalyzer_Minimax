# UserManual

End-user operator's guide for TradeAnalyzer.

| File | Role |
|---|---|
| **`USER_GUIDE.md`** | **Source of truth.** Edit this. |
| `build_pdf.py` | Generator: renders the Markdown to the PDF (reportlab, no native deps). |
| `TradeAnalyzer-User-Guide.pdf` | The deliverable — read this. **Generated; never hand-edit.** |

## Updating

1. Edit `USER_GUIDE.md`.
2. Regenerate the PDF:
   ```
   python UserManual/build_pdf.py
   ```
3. Commit the `.md` and the regenerated `.pdf` together.

The guide is intentionally a **scoped operator's guide** (workflows, setup, screen map) — not an exhaustive every-button manual. Keep it task-oriented. When a user-facing workflow changes materially, update the relevant section here as part of the same commit (see `CLAUDE.md` → Documentation maintenance).
