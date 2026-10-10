import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `premium-roc-report.mjs --json` names its output by date. It used `toISOString()`, which is
 * UTC, so a run at 20:40 ET on 2026-10-09 was saved as `premium-roc-2026-10-10.json`. The
 * dated files are compared run to run, so a wrong date files evidence under the wrong day.
 */
describe('premium-roc-report output filename', () => {
  const src = readFileSync(join(__dirname, '../scripts/premium-roc-report.mjs'), 'utf8');
  // Comments stripped: the fix's own comment names toISOString (CLAUDE.md, source-scan quirk).
  const save = src.slice(src.indexOf("if (args.includes('--json'))")).replace(/\/\/[^\n]*/g, '');

  it('stamps the ET date, never the UTC one', () => {
    expect(save).toContain("timeZone: 'America/New_York'");
    expect(save).not.toContain('toISOString');
  });

  it('the en-CA ET format gives the evening date, not tomorrow', () => {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
    expect(fmt.format(new Date('2026-10-10T00:40:00Z'))).toBe('2026-10-09'); // 20:40 EDT
    expect(fmt.format(new Date('2026-01-16T04:30:00Z'))).toBe('2026-01-15'); // EST
  });
});
