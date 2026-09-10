/**
 * A stored timestamp, shown in ET with the full stored string on hover (05 §8).
 *
 * Every timestamp in a generation already carries its America/New_York offset,
 * so this only trims it for reading — it never converts. Converting in the
 * renderer is how a UTC stamp gets shown as if it were ET, a day out every
 * evening, which this project has now written into a forensic record twice.
 */
export function When({ iso }: { iso: string | null }): JSX.Element {
  if (iso === null || iso === '') return <span className="muted">—</span>;
  return <span title={iso}>{iso.slice(0, 16).replace('T', ' ')}</span>;
}

/** A byte count a person can read. */
export function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
