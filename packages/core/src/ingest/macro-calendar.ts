import type { IngestContext, IngestedRowSpec } from '../collector/capture.js';

/**
 * The macro calendar — 02 §11, `raw_macro_event`.
 *
 * The only two phase-8 sources that are **HTML pages rather than data feeds**,
 * which is why they live in their own module with their own fixtures. Both were
 * fetched and read on 2026-09-07 before a line of parser was written, and every
 * awkward case below is one the live page actually contains — none is defensive
 * guessing.
 *
 * What the FOMC page taught, all three of which a plausible parser gets wrong
 * *silently*:
 *
 * 1. **A meeting that spans a month boundary names both months**: `Apr/May
 *    30-1`, `Jan/Feb 31-1`, `Oct/Nov 31-1`. The decision day is the range's
 *    last day and it belongs to the **second** month. Taking the first month
 *    with the last day yields 2024-04-01 for `Apr/May 30-1` — a real date, off
 *    by a month, and nothing downstream can tell.
 * 2. **Not every entry is a range.** 2025 carries `August 22 (notation vote)`:
 *    one day, plus prose. A regex demanding `d-d` drops it without a word.
 * 3. **The trailing `*` marks the projections (SEP) meeting.** Kept in the
 *    description rather than stripped, because which meetings carry an SEP is
 *    a fact about the event.
 *
 * And the BLS pages: each release has its own page whose table is
 * `Reference Month | Release Date | Release Time`, but the page also serialises
 * its navigation into a `<tr>`. The row filter is therefore **positive** — three
 * cells, and the middle one shaped like `Mon. D, YYYY` — rather than a
 * skip-the-first-row rule, which would break the day the nav markup changes.
 */

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

function monthNumber(name: string): number | null {
  return MONTHS[name.trim().slice(0, 3).toLowerCase()] ?? null;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export interface ParsedMacroEvent {
  readonly eventKey: string;
  readonly eventType: 'FOMC' | 'CPI' | 'PPI' | 'NFP' | 'GDP' | 'PCE' | 'OTHER';
  readonly eventDate: string;
  readonly eventTime: string | null;
  readonly description: string;
}

/**
 * The FOMC meeting calendar.
 *
 * Yields one event per meeting, dated on the **decision day** — the last day of
 * the range, which is when the statement is released and the only day of the two
 * that moves anything.
 */
export function parseFomcCalendar(html: string): readonly ParsedMacroEvent[] {
  const events: ParsedMacroEvent[] = [];

  // Panels are per year, and the years are NOT in order on the page (2026,
  // 2025, … 2021, then 2027). So the year has to come from the panel each
  // meeting sits in; a single flat sweep would attach every meeting to whichever
  // year happened to be parsed last.
  const panels = html.split(/(?=>\s*\d{4}\s+FOMC Meetings\s*<)/);

  for (const panel of panels) {
    const yearMatch = /> *(\d{4}) +FOMC Meetings *</.exec(panel);
    if (!yearMatch) continue;
    const year = Number(yearMatch[1]);

    const meetings = panel.matchAll(
      /fomc-meeting__month[^>]*>([\s\S]*?)<\/div>[\s\S]*?fomc-meeting__date[^>]*>([\s\S]*?)<\/div>/g
    );

    for (const meeting of meetings) {
      const monthText = stripTags(meeting[1] ?? '');
      const dateText = stripTags(meeting[2] ?? '');
      const parsed = fomcDecisionDate(year, monthText, dateText);
      if (!parsed) continue;

      events.push({
        eventKey: `FOMC-${parsed.slice(0, 7)}`,
        eventType: 'FOMC',
        eventDate: parsed,
        // The page publishes no time. Null is the honest answer; 14:00 ET is
        // the usual statement time but it is our belief, not the source's.
        eventTime: null,
        description: `FOMC meeting ${monthText} ${dateText}`.replace(/\s+/g, ' ').trim()
      });
    }
  }
  return events;
}

/**
 * Resolves one meeting's decision day.
 *
 * `monthText` is either a single month (`January`) or a slash pair spanning the
 * boundary (`Apr/May`); `dateText` is `27-28`, `17-18*`, `30-1`, or a bare `22`
 * with prose after it.
 */
function fomcDecisionDate(year: number, monthText: string, dateText: string): string | null {
  const days = [...dateText.matchAll(/\d{1,2}/g)].map((m) => Number(m[0]));
  if (days.length === 0) return null;
  const lastDay = days[days.length - 1] as number;

  const monthParts = monthText.split('/').map((p) => p.trim()).filter((p) => p.length > 0);
  if (monthParts.length === 0) return null;

  // A slash pair means the range crosses the boundary, so the decision day is
  // in the SECOND month. With one month named, it is that month.
  const monthName = monthParts.length > 1
    ? (monthParts[monthParts.length - 1] as string)
    : (monthParts[0] as string);
  const month = monthNumber(monthName);
  if (month === null) return null;

  // `Dec/Jan 31-1` would roll the year too. It has not appeared on the page,
  // but the arithmetic is one line and getting it wrong would be silent.
  const rollsYear = monthParts.length > 1 && (monthNumber(monthParts[0] as string) ?? 0) > month;
  return iso(rollsYear ? year + 1 : year, month, lastDay);
}

const BLS_RELEASES: readonly {
  readonly slug: string;
  readonly type: 'CPI' | 'PPI' | 'NFP';
  readonly label: string;
}[] = [
  { slug: 'cpi', type: 'CPI', label: 'Consumer Price Index' },
  { slug: 'ppi', type: 'PPI', label: 'Producer Price Index' },
  { slug: 'empsit', type: 'NFP', label: 'Employment Situation' }
];

export { BLS_RELEASES };

export function blsScheduleUrl(slug: string): string {
  return `https://www.bls.gov/schedule/news_release/${slug}.htm`;
}

export const FOMC_CALENDAR_URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';

/**
 * One BLS release schedule page.
 *
 * `referenceMonth` — the month the data is *about* — is what makes the event key
 * stable: `CPI-2026-08` is the August CPI whenever it is released, so a
 * rescheduled release is a new observation of the same key rather than a new
 * event, which is the whole point of the `event_key` column.
 */
export function parseBlsSchedule(
  html: string,
  release: { readonly type: 'CPI' | 'PPI' | 'NFP'; readonly label: string }
): readonly ParsedMacroEvent[] {
  const events: ParsedMacroEvent[] = [];

  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...(tr[1] ?? '').matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) =>
      stripTags(c[1] ?? '')
    );
    if (cells.length !== 3) continue;

    const releaseDate = parseBlsDate(cells[1] as string);
    if (releaseDate === null) continue;

    const reference = parseReferenceMonth(cells[0] as string);
    if (reference === null) continue;

    events.push({
      eventKey: `${release.type}-${reference}`,
      eventType: release.type,
      eventDate: releaseDate,
      eventTime: normaliseTime(cells[2] as string),
      description: `${release.label} for ${cells[0]}`
    });
  }
  return events;
}

/** `Dec. 18, 2025` and `Dec 04, 2026` — the abbreviation's period is optional. */
function parseBlsDate(text: string): string | null {
  const m = /^([A-Z][a-z]{2})\.? (\d{1,2}), (\d{4})$/.exec(text.trim());
  if (!m) return null;
  const month = monthNumber(m[1] as string);
  if (month === null) return null;
  return iso(Number(m[3]), month, Number(m[2]));
}

/** `November 2025` -> `2025-11`. */
function parseReferenceMonth(text: string): string | null {
  const m = /^([A-Za-z]+) (\d{4})$/.exec(text.trim());
  if (!m) return null;
  const month = monthNumber(m[1] as string);
  if (month === null) return null;
  return `${m[2]}-${String(month).padStart(2, '0')}`;
}

/** `08:30 AM` -> `08:30`. Stored as ET, which is what BLS publishes. */
function normaliseTime(text: string): string | null {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(text.trim());
  if (!m) return null;
  let hour = Number(m[1]) % 12;
  if ((m[3] as string).toUpperCase() === 'PM') hour += 12;
  return `${String(hour).padStart(2, '0')}:${m[2]}`;
}

function toRows(
  events: readonly ParsedMacroEvent[],
  sourceUrl: string,
  ctx: IngestContext
): readonly IngestedRowSpec[] {
  return events.map((e) => ({
    table: 'raw_macro_event',
    values: {
      run_id: ctx.runId,
      as_of_date: ctx.asOfDate,
      observed_at: ctx.observedAt,
      capture_rule_id: ctx.captureRuleId,
      event_key: e.eventKey,
      event_type: e.eventType,
      event_date: e.eventDate,
      event_time: e.eventTime,
      description: e.description,
      source_url: sourceUrl
    }
  }));
}

export function ingestFomcCalendar(body: string, ctx: IngestContext): readonly IngestedRowSpec[] {
  return toRows(parseFomcCalendar(body), FOMC_CALENDAR_URL, ctx);
}

export function makeBlsScheduleIngest(release: {
  readonly slug: string;
  readonly type: 'CPI' | 'PPI' | 'NFP';
  readonly label: string;
}) {
  return (body: string, ctx: IngestContext): readonly IngestedRowSpec[] =>
    toRows(parseBlsSchedule(body, release), blsScheduleUrl(release.slug), ctx);
}
