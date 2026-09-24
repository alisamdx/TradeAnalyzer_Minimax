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
        WHERE endpoint = '/api/xbrl/companyfacts/CIK{cik}.json' AND parse_status = 'ok'`
    )
    .all() as { cik: string; requested_at: string }[];
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

/** When a filer last fetched on `lastFetched` (ET) is next due for a retry. */
export function factsRetryDue(lastFetched: string): string {
  return addDays(lastFetched, FACTS_RETRY_DAYS);
}

/**
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
          AND NOT EXISTS (SELECT 1 FROM raw_edgar_fact x WHERE x.accession_no = f.accession_no)
        GROUP BY f.cik`
    )
    .all() as { cik: string; filed: string }[];
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
