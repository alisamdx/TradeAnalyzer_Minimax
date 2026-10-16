import type { SqliteLike } from '../db/sqlite-like.js';
import { etDate } from '../time.js';

/**
 * The companyfacts fetch queue — which filers the fact pull asks, and in what order (v1.1.271,
 * batch planning v1.1.322).
 *
 * Its own module so the collector (which fetches) and QC-701 (which reports when a lagging filer
 * will be asked again) read ONE definition. QC-701 used to promise "retried every 7 days" while
 * the queue could not keep that promise, because the two computed it separately.
 */

/** How long a filer whose companyfacts lacked its newest report waits before it is asked again. */
export const FACTS_RETRY_DAYS = 7;

/**
 * Filers fetched per run. Was 10: on 2026-09-23 the queue held 34 filers never fetched, so a
 * retry could not be reached for four runs. companyfacts responses are 3-5 MB and SEC allows
 * 10 requests a second, so 20 is well inside fair access.
 */
export const FACTS_PER_RUN = 20;

/**
 * Slots per run kept for due RETRIES. New filings always sorted first, so with a backlog of new
 * filers a lagging one was never re-asked — IQV and JCI were fetched once, on 2026-09-15, and
 * sat 34th and 35th a week later while their findings said "retried every 7 days".
 */
export const FACTS_RETRY_RESERVE = 3;

/**
 * How long after a filing companyfacts must have been read before a filing missing from it counts
 * as OMITTED rather than behind. Two weeks after filing it is not lag (v1.1.332): SEC's aggregate
 * dropped most 10-Qs filed 2026-07-28/29 while filings either side landed. One definition, read by
 * QC-701, QC-704 and the filing-facts fallback below, so the three cannot disagree about which
 * filings SEC has left out.
 */
export const COMPANYFACTS_OMITTED_AFTER_DAYS = 14;

/**
 * Filings whose own XBRL instance is read per run. Two requests each; instances run 1–12 MB.
 *
 * Was 20 while the instance was only a fallback for what companyfacts omitted. Since v1.1.365 it
 * is the PRIMARY source for every new report filing, so a peak earnings day (~150 universe report
 * filings) must fit, with what does not fit carried to the next run newest-first. 100 filings is
 * 200 calls, ~25 s at the shared 8/s sec.gov pace plus the downloads.
 */
export const FILING_FACTS_PER_RUN = 100;

/** The companyfacts request, as `meta_response.endpoint` records it. */
export const COMPANYFACTS_ENDPOINT = '/api/xbrl/companyfacts/CIK{cik}.json';

/** The two requests of the filing-instance read, as `meta_response.endpoint` records them. */
export const FILING_INDEX_ENDPOINT = '/Archives/edgar/data/{cik}/{accession}/index.json';
export const FILING_INSTANCE_ENDPOINT = '/Archives/edgar/data/{cik}/{accession}/{instance}';

/**
 * Whether a response is an ANSWER from SEC — something that settles the question for a while —
 * rather than a failure to be asked again next run (v1.1.365).
 *
 * A 2xx is an answer, and so is a 404 (no such document: asking again tomorrow will not create
 * it). A 429, a 5xx and a network fault (null status) are not: they say nothing about the filing.
 * Until v1.1.365 every captured response counted as an attempt, so on 2026-10-15, when all 20
 * filing-instance reads came back HTTP 429, each of those filings was put off for a week.
 */
export function isSecAnswer(httpStatus: number | null): boolean {
  return httpStatus !== null && ((httpStatus >= 200 && httpStatus < 300) || httpStatus === 404);
}

/** The last time each accession's own-instance read was ANSWERED, and the last failure since. */
export interface FilingAttempt {
  /** ET date of the latest answered request (index or instance), or null if none was answered. */
  readonly lastAnswered: string | null;
  /** Whether an answered index listed an XBRL instance (`false` = the filing has none). */
  readonly instanceListed: boolean;
  /** HTTP status of the latest request that was NOT an answer, when it is newer than the last answer. */
  readonly lastFailureStatus: number | null | undefined;
  readonly lastFailureAt: string | null;
}

export function filingAttempts(db: SqliteLike): Map<string, FilingAttempt> {
  const rows = db
    .prepare(
      `SELECT json_extract(params_json, '$.accession') AS accession, endpoint, http_status, requested_at
         FROM meta_response WHERE endpoint IN (?, ?)
        ORDER BY requested_at`
    )
    .all(FILING_INDEX_ENDPOINT, FILING_INSTANCE_ENDPOINT) as {
    accession: string; endpoint: string; http_status: number | null; requested_at: string;
  }[];
  const out = new Map<string, { lastAnswered: string | null; instanceListed: boolean; lastFailureStatus: number | null | undefined; lastFailureAt: string | null }>();
  for (const r of rows) {
    const t = Date.parse(r.requested_at);
    if (Number.isNaN(t)) continue;
    const d = etDate(new Date(t));
    const cur = out.get(r.accession) ?? { lastAnswered: null, instanceListed: false, lastFailureStatus: undefined, lastFailureAt: null };
    if (isSecAnswer(r.http_status)) {
      cur.lastAnswered = d;
      cur.lastFailureStatus = undefined;
      cur.lastFailureAt = null;
      // An instance was requested only because the index listed one.
      if (r.endpoint === FILING_INSTANCE_ENDPOINT) cur.instanceListed = true;
    } else {
      cur.lastFailureStatus = r.http_status;
      cur.lastFailureAt = d;
    }
    out.set(r.accession, cur);
  }
  return out;
}

export interface FactsQueueEntry {
  readonly cik: string;
  /** `fresh`: never fetched, or last fetched before its newest report filing. `retry`: fetched after it, due again. */
  readonly kind: 'fresh' | 'retry';
  /** ET date of the last successful companyfacts fetch, or null. */
  readonly lastFetched: string | null;
  /** Filing date of the newest report filing with no harvested facts. */
  readonly filed: string;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The ET date of each filer's last successful companyfacts fetch.
 *
 * `requested_at` is an ISO instant, and taking its first ten characters gave the UTC date — so an
 * evening ET fetch (2026-09-15 21:46 ET = 09-16 01:46Z) read as the next day and every retry
 * waited one extra day, compared against an ET trading date. Same shape as the weekly-expiry
 * quirk: keep one time base.
 */
export function lastFactsFetchEt(db: SqliteLike): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT json_extract(params_json, '$.cik') AS cik, requested_at
         FROM meta_response
        WHERE endpoint = ? AND parse_status = 'ok'`
    )
    .all(COMPANYFACTS_ENDPOINT) as { cik: string; requested_at: string }[];
  const out = new Map<string, string>();
  for (const r of rows) {
    const t = Date.parse(r.requested_at);
    if (Number.isNaN(t)) continue;
    const d = etDate(new Date(t));
    const prev = out.get(r.cik);
    if (prev === undefined || d > prev) out.set(r.cik, d);
  }
  return out;
}

/** Whole days from `from` to `to`, both ISO dates. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Whether companyfacts, last read on `fetched` (ET), has had long enough to hold a filing made on `filed`. */
export function companyfactsHadTime(filed: string, fetched: string | null): fetched is string {
  return fetched !== null && daysBetween(filed, fetched) >= COMPANYFACTS_OMITTED_AFTER_DAYS;
}

export interface FilingFactsEntry {
  readonly cik: string;
  readonly ticker: string;
  readonly accessionNo: string;
  readonly form: string;
  readonly filed: string;
  /** ET date of the last ANSWERED attempt at this filing's own instance, or null if never answered. */
  readonly lastAttempt: string | null;
}

/**
 * Report filings with no stored facts whose own XBRL instance is due to be read. Newest filing
 * first, because it is the one that decides a filer's freshness.
 *
 * **The instance is the primary source since v1.1.365.** It used to be read only for filings SEC's
 * companyfacts had OMITTED, judged at least `COMPANYFACTS_OMITTED_AFTER_DAYS` after filing — so a
 * filing SEC's aggregate dropped (most 10-Qs filed 2026-07-28/29) went stale for two weeks before
 * anything tried, and its freshness depended on a derived feed that drops filings at random.
 * companyfacts is built FROM these instances; reading the instance the day the filing appears in the
 * daily form index removes the dependency instead of waiting it out.
 *
 * Only ANSWERED attempts (`isSecAnswer`) start the `FACTS_RETRY_DAYS` wait: an index with no
 * instance listed, or a 404. A throttled or failed attempt is due again on the next run.
 */
export function filingFactsQueue(db: SqliteLike, tradingDate: string): FilingFactsEntry[] {
  const filings = db
    .prepare(
      `SELECT f.cik, f.ticker, f.accession_no, f.form, f.filed_date
         FROM raw_edgar_filing f
        WHERE f.form IN ('10-K', '10-Q', '20-F', '40-F') AND f.filed_date <= ?
          AND NOT EXISTS (SELECT 1 FROM raw_edgar_fact x WHERE x.accession_no = f.accession_no)`
    )
    .all(tradingDate) as { cik: string; ticker: string; accession_no: string; form: string; filed_date: string }[];
  if (filings.length === 0) return [];

  const attempts = filingAttempts(db);
  return filings
    .map((f): FilingFactsEntry => ({
      cik: f.cik, ticker: f.ticker, accessionNo: f.accession_no, form: f.form, filed: f.filed_date,
      lastAttempt: attempts.get(f.accession_no)?.lastAnswered ?? null
    }))
    .filter((f) => f.lastAttempt === null || factsRetryDue(f.lastAttempt) <= tradingDate)
    .sort((a, b) => b.filed.localeCompare(a.filed) || a.accessionNo.localeCompare(b.accessionNo));
}

/** When a filer last fetched on `lastFetched` (ET) is next due for a retry. */
export function factsRetryDue(lastFetched: string): string {
  return addDays(lastFetched, FACTS_RETRY_DAYS);
}

/**
 * companyfacts' role since v1.1.365 is HISTORY and CROSS-CHECK, not freshness: the filing's own
 * instance (read first) supplies a new filing's facts, and companyfacts is still read after each
 * report filing so a new filer gets its back history and QC-705 can compare the two sources on the
 * filings both carry. "Pending" therefore means no facts FROM COMPANYFACTS for the filing.
 *
 * Every filer that is due, in priority order: new filings first (newest first), then retries
 * (longest since fetched first). A filer fetched after its newest filing and less than
 * `FACTS_RETRY_DAYS` ago is not due and is not listed.
 */
export function factsQueueEntries(db: SqliteLike, tradingDate: string): FactsQueueEntry[] {
  const pending = db
    .prepare(
      `SELECT f.cik, MAX(f.filed_date) AS filed
         FROM raw_edgar_filing f
        WHERE f.form IN ('10-K', '10-Q', '20-F', '40-F')
          AND NOT EXISTS (SELECT 1 FROM raw_edgar_fact x JOIN meta_response m ON m.source_response_id = x.source_response_id
                           WHERE x.accession_no = f.accession_no AND m.endpoint = ?)
        GROUP BY f.cik`
    )
    .all(COMPANYFACTS_ENDPOINT) as { cik: string; filed: string }[];
  const lastFetch = lastFactsFetchEt(db);

  const fresh: FactsQueueEntry[] = [];
  const retry: FactsQueueEntry[] = [];
  for (const p of pending) {
    const at = lastFetch.get(p.cik) ?? null;
    if (at === null || at < p.filed) fresh.push({ cik: p.cik, kind: 'fresh', lastFetched: at, filed: p.filed });
    else if (factsRetryDue(at) <= tradingDate) retry.push({ cik: p.cik, kind: 'retry', lastFetched: at, filed: p.filed });
  }
  fresh.sort((a, b) => b.filed.localeCompare(a.filed) || a.cik.localeCompare(b.cik));
  retry.sort((a, b) => (a.lastFetched as string).localeCompare(b.lastFetched as string) || a.cik.localeCompare(b.cik));
  return [...fresh, ...retry];
}

/** The due filers in priority order — the queue before any batch is cut from it. */
export function factsQueue(db: SqliteLike, tradingDate: string): readonly { cik: string }[] {
  return factsQueueEntries(db, tradingDate).map(({ cik }) => ({ cik }));
}

/**
 * The filers this run fetches: up to `max`, of which up to `reserve` go to due retries before
 * new filings take the rest. Unused slots on either side go to the other, so a quiet day spends
 * the whole batch on retries and a day with no retries spends it all on new filings.
 */
export function factsBatch(
  db: SqliteLike,
  tradingDate: string,
  max: number = FACTS_PER_RUN,
  reserve: number = FACTS_RETRY_RESERVE
): FactsQueueEntry[] {
  const all = factsQueueEntries(db, tradingDate);
  const fresh = all.filter((e) => e.kind === 'fresh');
  const retry = all.filter((e) => e.kind === 'retry');
  const retryFirst = Math.min(reserve, retry.length, max);
  const freshTake = Math.min(fresh.length, max - retryFirst);
  const retryTake = Math.min(retry.length, max - freshTake);
  return [...fresh.slice(0, freshTake), ...retry.slice(0, retryTake)];
}
