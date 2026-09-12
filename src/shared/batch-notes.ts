import type { BatchRun } from './types.js';

/**
 * The Batch view's run-note helpers, in a plain `.ts` module under `src/shared`.
 *
 * They lived in `BatchView.tsx` and were imported from there by
 * `tests/batch-run-notes.test.ts` — which `tsconfig.node.json` compiles without
 * `--jsx`, so `npm run typecheck` failed (TS6142) from the version that added
 * them. Vitest transpiles per file and never noticed, which is how a red
 * typecheck shipped behind a green test run. `src/shared` is in both the node
 * and web projects, so the view and the test can each import it.
 */

/**
 * How much of a run's note the history cell shows before the modal is needed.
 *
 * The text was never lost — `batch_runs.notes` is an unbounded TEXT column and
 * the whole row reaches the renderer — but the cell truncated at 60 characters
 * and offered the rest only through a `title` tooltip. **A native tooltip cannot
 * be selected, scrolled or copied**, so a long note was effectively unreadable:
 * the collector one-shots put a whole gate summary there (bars, tickers, split
 * pages, verdict, finding count), which is exactly the text worth keeping.
 */
const PREVIEW_CHARS = 60;

export function notePreview(run: Pick<BatchRun, 'notes' | 'errorMessage'>): string {
  const text = run.errorMessage ?? run.notes ?? '';
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

/** What Copy puts on the clipboard: both fields, labelled, when a run has both. */
export function runNotesText(run: Pick<BatchRun, 'notes' | 'errorMessage'>): string {
  const parts: string[] = [];
  if (run.errorMessage) parts.push(`Error: ${run.errorMessage}`);
  if (run.notes) parts.push(run.notes);
  return parts.join('\n\n');
}
