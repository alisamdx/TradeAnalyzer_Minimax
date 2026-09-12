import { describe, it, expect } from 'vitest';
import { notePreview, runNotesText } from '../src/shared/batch-notes.js';

/**
 * The Batch view's run-history note was readable only as far as character 60.
 *
 * Nothing was ever lost in storage — `batch_runs.notes` is an unbounded TEXT
 * column and the whole row reaches the renderer — but the cell rendered
 * `notes.slice(0, 60)` and offered the remainder through a `title` tooltip
 * only. **A native tooltip cannot be selected, scrolled or copied**, so for a
 * long note there was no path to the text at all.
 *
 * The note that exposed it is the one that matters most: the collector
 * one-shots write a whole gate summary there, and every operative number in it
 * — the verdict and the finding count — sits past the cut.
 */

/** The real 2026-09-11 backfill note, as the job wrote it. */
const LONG_NOTE =
  'backfill_bars: 1293548 bars for 1089/1089 tickers, 1000 splits over 1 page(s); ' +
  'RED, 512 finding(s) awaiting a ruling.';

describe('batch run notes — the preview', () => {
  it('truncates a long note, and the fixture is genuinely long enough to be truncated', () => {
    // Without this the two assertions below would pass on a short string for
    // the wrong reason — the vacuity trap every fixture in this repo needs.
    expect(LONG_NOTE.length).toBeGreaterThan(60);

    const preview = notePreview({ notes: LONG_NOTE, errorMessage: null });
    expect(preview).toHaveLength(61); // 60 characters plus the ellipsis
    expect(preview.endsWith('…')).toBe(true);
  });

  it('cuts away exactly the part worth reading — why the tooltip was not enough', () => {
    const preview = notePreview({ notes: LONG_NOTE, errorMessage: null });
    expect(preview).not.toContain('RED');
    expect(preview).not.toContain('512');
  });

  it('leaves a short note alone rather than appending a misleading ellipsis', () => {
    const short = 'No queued jobs.';
    expect(notePreview({ notes: short, errorMessage: null })).toBe(short);
  });

  it('shows the error in preference to the note, as the cell always has', () => {
    expect(notePreview({ notes: 'ran fine', errorMessage: 'boom' })).toBe('boom');
  });

  it('renders nothing for a run that recorded neither', () => {
    expect(notePreview({ notes: null, errorMessage: null })).toBe('');
  });
});

describe('batch run notes — what Copy puts on the clipboard', () => {
  it('returns the note in full — the regression this fix exists for', () => {
    expect(runNotesText({ notes: LONG_NOTE, errorMessage: null })).toBe(LONG_NOTE);
  });

  it('keeps both fields, labelled, when a run has an error AND a note', () => {
    const text = runNotesText({ notes: LONG_NOTE, errorMessage: 'Interrupted by app restart' });
    expect(text).toContain('Error: Interrupted by app restart');
    expect(text).toContain(LONG_NOTE);
  });

  it('is empty for a run that recorded neither, rather than emitting stray labels', () => {
    expect(runNotesText({ notes: null, errorMessage: null })).toBe('');
  });
});
