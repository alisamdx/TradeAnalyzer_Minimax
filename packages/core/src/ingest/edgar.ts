import type { IngestContext, IngestedRowSpec } from '../collector/capture.js';

/**
 * EDGAR ingestion — filings, XBRL facts and Form 4 insider transactions
 * (02 §9, §12).
 *
 * Every shape here was read from a live response on 2026-09-07 rather than from
 * documentation, and three of them contradict what a reasonable parser would
 * have assumed:
 *
 * - **`filings.recent` is capped at 1,000 entries**, with the remainder in a
 *   `filings.files` overflow list. It is the same truncation shape as Finnhub's
 *   1,500-row calendar. It truncates from the *older* end, so it is reported
 *   (`atProviderCap`) only when the truncation reaches into the window being
 *   stored — measured, per response, from the oldest filing date kept. "Harmless
 *   in the current usage" is not a reason to leave a cap undetected (the Finnhub
 *   one was harmless too, until a window grew), which is why the test is against
 *   the window rather than switched off.
 * - **`fy` and `fp` on a fact belong to the FILING, not to the fact.** Apple's
 *   Q3-2018 revenue carries `fp: "FY"` because it was reported on a 10-K. They
 *   are stored verbatim, and anything wanting the fact's own period must read
 *   `period_start`/`period_end`.
 * - **A Form 4 wraps every value in a `<value>` element** and may put a
 *   `<footnoteId>` beside it, so a price is `transactionPricePerShare > value`,
 *   and a genuinely absent price (awards, gifts) is an empty element rather
 *   than a missing one.
 */

function textOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

// ── submissions: the filing index ──────────────────────────────────────────

interface EdgarRecentFilings {
  accessionNumber?: string[];
  filingDate?: string[];
  reportDate?: string[];
  form?: string[];
  primaryDocument?: string[];
}

export const EDGAR_RECENT_CAP = 1000;

/**
 * Whether a submissions response is truncated **for the window being stored**.
 *
 * EDGAR drops the OLDEST filings past the cap, so a full `recent` list loses
 * nothing on or after `since` as long as its oldest filing is older than
 * `since`. Only then is the cap harmless; when the oldest kept filing is inside
 * the window, filings the phase wanted may have been cut, and that is reported.
 * Without `since` every full list is reported, as before. Flagging every full
 * list made QC-008 (blocking) fire on 16 of 20 filers on gen-001's first day —
 * every large filer, every day — so no pilot day could come out clean.
 */
export function submissionsAtCap(body: string, since?: string): boolean {
  try {
    const parsed = JSON.parse(body) as { filings?: { recent?: EdgarRecentFilings } };
    const recent = parsed.filings?.recent;
    if ((recent?.accessionNumber?.length ?? 0) < EDGAR_RECENT_CAP) return false;
    if (since === undefined) return true;
    const dates = (recent?.filingDate ?? []).filter((d) => typeof d === 'string' && d !== '');
    // No dates to reason from is not evidence of completeness.
    if (dates.length === 0) return true;
    const oldest = dates.reduce((a, b) => (a < b ? a : b));
    return oldest >= since;
  } catch {
    return false;
  }
}

/**
 * `filings.recent` is **parallel arrays**, not an array of objects.
 *
 * Zipping by index is the only way to read it, which makes a short array a
 * silent misalignment rather than an error: if `reportDate` were one element
 * shorter than `form`, every filing after that point would take its neighbour's
 * date and nothing would throw. So the row count is taken from
 * `accessionNumber` — the one field that is a natural key and cannot be blank —
 * and any row whose companion fields are missing is stored with nulls rather
 * than shifted into alignment.
 */
/**
 * EDGAR submissions → `raw_edgar_filing`.
 *
 * **`knownAccessions` is idempotence a level up, and without it a re-pull loses
 * the whole response (v1.1.308).** `raw_edgar_filing` is append-only yet UNIQUE
 * on `accession_no` alone, so re-storing a filing already stored throws inside
 * the capture transaction — and the transaction is the whole response, so
 * `parsed_row_count` comes back **0** and every filing in it is discarded, not
 * just the duplicate. It surfaces as `UNIQUE constraint failed:
 * raw_edgar_filing.accession_no`, which reads as "the parser broke".
 *
 * It fires whenever one trading date has two collector runs, because the
 * filers' rolling slice is keyed on the trading date and so asks the identical
 * twenty. Measured 2026-09-22: run 28 stored HSY's four filings at 17:05 and
 * run 30 asked the same CIK at 20:47, got the same four back, and stored
 * nothing. That cost nothing only because HSY filed nothing in between — a new
 * 10-Q in that window would have been thrown away with the duplicates, and
 * QC-701 would then have reported the filer stale with no trace of why.
 *
 * Passed as a recipe argument rather than read from the database here, so a
 * replay re-runs the parse that actually happened: what was already stored is a
 * fact about capture time, not about replay time. Omitted when empty, so a
 * first-ever pull keeps its digest.
 *
 * This is the narrow fix. The key itself is wrong — every other supersession in
 * the schema is `(natural_key, observed_at)` — but dropping a unique index is
 * not additive and so cannot happen inside a generation (02 §1).
 */
export function makeSubmissionsIngest(opts: {
  readonly cik: string;
  readonly ticker: string;
  /** Only filings on or after this date are stored; the feed carries years. */
  readonly since?: string;
  readonly forms?: ReadonlySet<string>;
  /** Accession numbers already stored, which must not be inserted a second time. */
  readonly knownAccessions?: ReadonlySet<string>;
}) {
  return (body: string, ctx: IngestContext): readonly IngestedRowSpec[] => {
    const parsed = JSON.parse(body) as { filings?: { recent?: EdgarRecentFilings } };
    const recent = parsed.filings?.recent;
    if (!recent?.accessionNumber) return [];

    const rows: IngestedRowSpec[] = [];
    for (const [i, accession] of recent.accessionNumber.entries()) {
      if (!accession) continue;
      const form = recent.form?.[i] ?? '';
      const filedDate = recent.filingDate?.[i] ?? '';
      if (!form || !filedDate) continue;
      if (opts.forms && !opts.forms.has(form)) continue;
      if (opts.since && filedDate < opts.since) continue;
      // A filing is immutable once filed, so an accession already stored is a
      // genuine no-op rather than a fact being dropped.
      if (opts.knownAccessions?.has(accession)) continue;

      rows.push({
        table: 'raw_edgar_filing',
        values: {
          run_id: ctx.runId,
          as_of_date: ctx.asOfDate,
          observed_at: ctx.observedAt,
          capture_rule_id: ctx.captureRuleId,
          cik: opts.cik,
          ticker: opts.ticker,
          accession_no: accession,
          form,
          filed_date: filedDate,
          // Empty string is EDGAR's "no period", and it is mapped to null here
          // rather than stored — an empty date string sorts before every real
          // date and would quietly win any MIN() comparison.
          report_date: textOrNull(recent.reportDate?.[i]),
          primary_doc: textOrNull(recent.primaryDocument?.[i])
        }
      });
    }
    return rows;
  };
}

// ── companyfacts: the XBRL facts ───────────────────────────────────────────

interface EdgarFactPoint {
  start?: string; end?: string; val?: number; accn?: string;
  fy?: number; fp?: string; form?: string; filed?: string; frame?: string;
}

const TAXONOMIES: ReadonlySet<string> = new Set(['us-gaap', 'dei', 'ifrs-full', 'srt', 'invest']);

/**
 * XBRL company facts, stored **unmapped**.
 *
 * The concept name and the unit are kept verbatim because one table legitimately
 * holds USD, shares, USD/shares and pure numbers, and mapping them into our own
 * vocabulary at capture would be a stage-2 derivation performed at ingestion
 * time, where it carries no version and cannot be redone.
 *
 * A restated value in a later filing is a **new row** — the natural key includes
 * `accession_no` — so a study can ask what was known at the time as easily as
 * what is known now.
 */
export function makeCompanyFactsIngest(opts: {
  readonly cik: string;
  /** Only facts filed on or after this date; the feed carries a decade. */
  readonly since?: string;
  readonly concepts?: ReadonlySet<string>;
}) {
  return (body: string, ctx: IngestContext): readonly IngestedRowSpec[] => {
    const parsed = JSON.parse(body) as {
      facts?: Record<string, Record<string, { units?: Record<string, EdgarFactPoint[]> }>>;
    };
    const rows: IngestedRowSpec[] = [];

    for (const [taxonomy, concepts] of Object.entries(parsed.facts ?? {})) {
      if (!TAXONOMIES.has(taxonomy)) continue;

      for (const [concept, entry] of Object.entries(concepts)) {
        if (opts.concepts && !opts.concepts.has(concept)) continue;

        for (const [unit, points] of Object.entries(entry.units ?? {})) {
          for (const p of points) {
            if (typeof p.val !== 'number' || !p.end || !p.accn || !p.filed) continue;
            if (opts.since && p.filed < opts.since) continue;

            rows.push({
              table: 'raw_edgar_fact',
              values: {
                run_id: ctx.runId,
                as_of_date: ctx.asOfDate,
                observed_at: ctx.observedAt,
                capture_rule_id: ctx.captureRuleId,
                cik: opts.cik,
                taxonomy,
                concept,
                unit,
                value: p.val,
                // No `start` means an instant — a balance-sheet fact has a point
                // in time, not a period. That is the column's declared null
                // meaning, not a gap.
                period_start: textOrNull(p.start),
                period_end: p.end,
                // `fy`/`fp` describe the FILING. Apple's Q3-2018 revenue reads
                // `fp: FY` because a 10-K reported it.
                fiscal_year: typeof p.fy === 'number' ? p.fy : 0,
                fiscal_period: p.fp ?? '',
                form: p.form ?? '',
                filed_date: p.filed,
                accession_no: p.accn,
                frame: textOrNull(p.frame)
              }
            });
          }
        }
      }
    }
    return rows;
  };
}

// ── the daily form index ───────────────────────────────────────────────────

export interface IndexedFiling {
  readonly formType: string;
  readonly companyName: string;
  readonly cik: string;
  readonly filedDate: string;
  readonly path: string;
  readonly accessionNo: string;
}

export function dailyFormIndexUrl(date: string): string {
  const [y, m, d] = date.split('-') as [string, string, string];
  const quarter = Math.floor((Number(m) - 1) / 3) + 1;
  return `https://www.sec.gov/Archives/edgar/daily-index/${y}/QTR${quarter}/form.${y}${m}${d}.idx`;
}

/**
 * The daily form index — one call that lists every filing EDGAR disseminated
 * that day, so the universe filter is applied locally.
 *
 * Per-ticker polling would be ~300 calls a day to learn that almost nothing was
 * filed. The same argument as the corporate-actions sweep.
 *
 * The file *looks* fixed-width, and reading it that way is the obvious mistake:
 * the column offsets are not documented and a company name long enough to reach
 * the next column would corrupt the CIK. Parsed instead from the two anchors
 * that cannot move — the trailing `edgar/data/...` path, and the two numeric
 * fields immediately before it.
 */
export function parseDailyFormIndex(body: string): readonly IndexedFiling[] {
  const filings: IndexedFiling[] = [];

  for (const line of body.split(/\r?\n/)) {
    const m = /^(\S+)\s+(.+?)\s+(\d+)\s+(\d{8})\s+(edgar\/data\/\S+?)\s*$/.exec(line);
    if (!m) continue;

    const path = m[5] as string;
    const accession = /\/([^/]+)\.txt$/.exec(path)?.[1];
    if (!accession) continue;

    const filed = m[4] as string;
    filings.push({
      formType: m[1] as string,
      companyName: (m[2] as string).trim(),
      cik: (m[3] as string).padStart(10, '0'),
      filedDate: `${filed.slice(0, 4)}-${filed.slice(4, 6)}-${filed.slice(6, 8)}`,
      path,
      accessionNo: accession
    });
  }
  return filings;
}

/**
 * The daily form index → `raw_edgar_filing`, for the universe's report filings (v1.1.325).
 *
 * The index lists every filing EDGAR disseminated that day, so it names each new 10-K and 10-Q
 * within a session of filing, for every filer at once, from the response the insider sweep already
 * fetches. Before this, report filings came only from the submissions sweep's 20-filer rotation,
 * which after two weeks had asked 135 of 1,012 filers — so a filing waited up to a whole rotation
 * (and longer, since the rotation stepped by calendar day and never ran on weekends) before the
 * companyfacts pull could see it.
 *
 * The index carries no period and no primary document, so `report_date` and `primary_doc` are
 * null on these rows. Nothing reads either column.
 *
 * `filers` and `knownAccessions` are narrowed by the caller to this index's own candidates, so a
 * recipe stays small. One accession can appear under several CIKs (co-registrants file one
 * report), and `accession_no` is unique: a repeat would throw inside the capture transaction and
 * take the index — and the day's insider sweep — down with it, so the first CIK wins.
 */
export function makeFormIndexFilingsIngest(opts: {
  readonly filers: ReadonlyMap<string, string>;
  readonly forms: ReadonlySet<string>;
  readonly knownAccessions?: ReadonlySet<string>;
}) {
  return (body: string, ctx: IngestContext): readonly IngestedRowSpec[] => {
    const rows: IngestedRowSpec[] = [];
    const seen = new Set<string>();
    for (const f of reportFilingsInIndex(body, opts.filers, opts.forms)) {
      if (seen.has(f.accessionNo) || opts.knownAccessions?.has(f.accessionNo)) continue;
      seen.add(f.accessionNo);
      rows.push({
        table: 'raw_edgar_filing',
        values: {
          run_id: ctx.runId,
          as_of_date: ctx.asOfDate,
          observed_at: ctx.observedAt,
          capture_rule_id: ctx.captureRuleId,
          cik: f.cik,
          ticker: opts.filers.get(f.cik) as string,
          accession_no: f.accessionNo,
          form: f.formType,
          filed_date: f.filedDate,
          report_date: null,
          primary_doc: null
        }
      });
    }
    return rows;
  };
}

/** The index's filings of `forms` by a CIK in `filers` — what the recipe above may store. */
export function reportFilingsInIndex(
  body: string,
  filers: ReadonlyMap<string, string>,
  forms: ReadonlySet<string>
): readonly IndexedFiling[] {
  return parseDailyFormIndex(body).filter((f) => forms.has(f.formType) && filers.has(f.cik));
}

// ── Form 4 ─────────────────────────────────────────────────────────────────

function xmlValue(scope: string, tag: string): string | null {
  // Every Form 4 field wraps its content in a `<value>` element, and may put a
  // `<footnoteId/>` beside it — so the value is read from inside the wrapper
  // rather than from the field element's text, which would concatenate both.
  const el = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(scope);
  if (!el) return null;
  const inner = /<value>([\s\S]*?)<\/value>/.exec(el[1] as string);
  const text = (inner ? inner[1] : el[1]) as string;
  const trimmed = text.replace(/<[^>]+>/g, '').trim();
  return trimmed === '' ? null : trimmed;
}

function numberOrNull(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Reads the reporting owner's relationship into one label.
 *
 * The flags are not exclusive — a filer is routinely both an officer and a
 * director — so they are joined rather than collapsed to the first match, and
 * the officer title is carried when the filing states one.
 */
function filerRole(scope: string): string | null {
  const rel = /<reportingOwnerRelationship>([\s\S]*?)<\/reportingOwnerRelationship>/.exec(scope);
  if (!rel) return null;
  const block = rel[1] as string;
  const flag = (tag: string): boolean => new RegExp(`<${tag}>\\s*(1|true)\\s*</${tag}>`, 'i').test(block);

  const roles: string[] = [];
  if (flag('isDirector')) roles.push('director');
  if (flag('isOfficer')) roles.push('officer');
  if (flag('isTenPercentOwner')) roles.push('ten_percent_owner');
  if (flag('isOther')) roles.push('other');

  const title = /<officerTitle>([\s\S]*?)<\/officerTitle>/.exec(block)?.[1]?.trim();
  if (title) roles.push(title);
  return roles.length > 0 ? roles.join('; ') : null;
}

/**
 * One Form 4's transactions.
 *
 * **`derivatives` widens this parser and is carried in the RECIPE, not read
 * from config.** Until dictionary v20 only non-derivative transactions were
 * captured, because `raw_insider_transaction` had no column to tell an option
 * grant's notional share count from an open-market purchase and pooling them
 * would have made every insider-buying signal wrong undetectably. `v20` adds
 * `security_class`, so both can be stored — but a parser that produces more
 * rows than are already stored breaks replay equality (AC-4/QC-951) for every
 * response captured before it. The flag lives in the recipe args precisely so
 * that does not happen: a pre-v20 response's stored recipe has no
 * `derivatives` key, `parseStoredRecipe` rebuilds this function without it,
 * and its replay reproduces exactly the rows it produced then. That is what
 * `meta_ingest_recipe` is for — a replay is a re-run of the SAME parse, not a
 * reconstruction of it.
 *
 * Why it had to change: QC-906 reads "a fetched Form 4 yielded no rows" as the
 * signature of a schema change, and with derivative-only filings dropped the
 * dominant cause of zero rows was a normal option grant. It fired on 2 of the
 * 2 runs that ever had data (19.1 % and 11.7 % against a 10 % threshold) and
 * had never once passed. All 11 filings it named on 2026-09-21 were correct
 * Form 4s with only derivative transactions — AMCR, AUGO, BILL, CTAS.
 *
 * `line_no` numbers non-derivative transactions first and continues into the
 * derivative ones, so every row written before v20 keeps its number and
 * `(accession_no, line_no)` stays unique.
 *
 * `transaction_code` is stored verbatim — `P`, `S`, `A`, `G`, `F` and the rest.
 * A two-way buy/sell mapping would destroy exactly the distinctions the code
 * exists to make: an `F` (shares withheld for tax) is not a sale, and a table
 * that calls it one manufactures insider selling out of payroll.
 */
export function makeForm4Ingest(opts: {
  readonly accessionNo: string;
  readonly tickerByCik?: ReadonlyMap<string, string>;
  readonly derivatives?: boolean;
}) {
  return (body: string, ctx: IngestContext): readonly IngestedRowSpec[] => {
    const doc = /<ownershipDocument>([\s\S]*?)<\/ownershipDocument>/.exec(body);
    if (!doc) return [];
    const xml = doc[1] as string;

    const issuerCik = (/<issuerCik>([\s\S]*?)<\/issuerCik>/.exec(xml)?.[1] ?? '').trim().padStart(10, '0');
    const symbol = (/<issuerTradingSymbol>([\s\S]*?)<\/issuerTradingSymbol>/.exec(xml)?.[1] ?? '').trim();
    const ticker = opts.tickerByCik?.get(issuerCik) ?? symbol;
    if (!ticker) return [];

    const owner = /<reportingOwner>([\s\S]*?)<\/reportingOwner>/.exec(xml)?.[1] ?? '';
    const filerName = (/<rptOwnerName>([\s\S]*?)<\/rptOwnerName>/.exec(owner)?.[1] ?? '').trim();
    if (!filerName) return [];
    const role = filerRole(owner);

    const rows: IngestedRowSpec[] = [];
    // The transaction's position in the filing, counted BEFORE any line is skipped, so it names
    // the filing's own line and never shifts (v1.1.284). A Form 4 routinely lists several sales by
    // one filer on one day at different prices — Japan Post sold 9,545 @ 116.62 and 4,055 @ 117.02
    // on 2026-09-14 — and without it those are indistinguishable by key.
    let lineNo = 0;
    const collect = (element: string, securityClass: string | null): void => {
      for (const tx of xml.matchAll(new RegExp(`<${element}>([\\s\\S]*?)</${element}>`, 'g'))) {
        lineNo += 1;
        const scope = tx[1] as string;
        const transactionDate = xmlValue(scope, 'transactionDate');
        const code = /<transactionCode>([\s\S]*?)<\/transactionCode>/.exec(scope)?.[1]?.trim() ?? null;
        const shares = numberOrNull(xmlValue(scope, 'transactionShares'));
        if (!transactionDate || !code || shares === null) continue;

        rows.push({
          table: 'raw_insider_transaction',
          values: {
            run_id: ctx.runId,
            as_of_date: ctx.asOfDate,
            observed_at: ctx.observedAt,
            capture_rule_id: ctx.captureRuleId,
            cik: issuerCik,
            ticker,
            filer_name: filerName,
            filer_role: role,
            transaction_date: transactionDate,
            transaction_code: code,
            shares: Math.round(shares),
            // Awards and gifts genuinely report no price. That is the column's
            // declared null meaning; a zero there would read as a free purchase.
            price: numberOrNull(xmlValue(scope, 'transactionPricePerShare')),
            shares_owned_after: (() => {
              const v = numberOrNull(xmlValue(scope, 'sharesOwnedFollowingTransaction'));
              return v === null ? null : Math.round(v);
            })(),
            accession_no: opts.accessionNo,
            line_no: lineNo,
            // Null under the pre-v20 recipe, so a replay of a response captured
            // then reproduces its stored rows exactly — the column did not exist.
            security_class: securityClass
          }
        });
      }
    };

    collect('nonDerivativeTransaction', opts.derivatives === true ? 'non_derivative' : null);
    // Numbered after the non-derivative ones, so every pre-v20 row keeps its line.
    if (opts.derivatives === true) collect('derivativeTransaction', 'derivative');
    return rows;
  };
}
