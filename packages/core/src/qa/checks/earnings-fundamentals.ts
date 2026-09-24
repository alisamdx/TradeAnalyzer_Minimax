import type { CheckContext, CheckDefinition, Evaluation } from '../check.js';

/**
 * Earnings and fundamentals checks — 03 §3.6.
 *
 * QC-601 is the one with a body count. The existing app stored NVDA's
 * 2026-08-26 report as 2026-11-17 — one quarter late — because it trusted a
 * bulk calendar response that had been truncated at its 1,500-row cap, and the
 * bad write then silently suppressed all three mechanisms that would have
 * corrected it: the nearest-wins guard, the delta filter and the brief's own
 * refresh all skipped on the presence of a stored future date. The earnings
 * penalty never fired and the brief ranked NVDA wheel #1 on the day it printed.
 *
 * So the rule this check enforces is asymmetric, and deliberately so: a date may
 * move **nearer** without limit — a coverage gap hiding the near date is the
 * common case — but it may move **later** only by a little. A large later slip
 * is the truncation signature, not an issuer refining its plans.
 */

/** An issuer refining its date moves it by days; a coverage gap moves it by a quarter. */
const MAX_LATER_SLIP_DAYS = 14;

/**
 * Polygon reference types that are funds rather than issuers: no earnings, no analyst coverage.
 * ETV covers commodity vehicles (GLD, SLV). A ticker with no reference row is not excluded —
 * unknown is not the same as a fund.
 */
export const FUND_TYPES = "('ETF', 'ETV', 'ETN', 'ETS', 'FUND')";

/**
 * Closers for a check's open findings on tickers that are now funds (v1.1.282).
 *
 * QC-603 and QC-905 excluded funds in v1.1.257, and the 47 findings each had already raised on
 * SPY, GLD, DIA and the rest could then never close: an excluded ticker is never evaluated, and
 * a finding its check never looks at stays open by design. The check does hold the evidence here
 * — the ticker's current reference says it is a fund, which is exactly what the rule excludes — so
 * it says so, and the gate records `rule_changed`. Not evaluated in the distribution: no value.
 */
export function fundFindingClosers(ctx: CheckContext, checkId: string, why: string): Evaluation[] {
  return (
    ctx.db
      .prepare(
        `SELECT x.key, r.security_type
           FROM qa_exception x
           JOIN raw_ticker_reference r
             ON r.ticker = x.key
            AND r.row_id = (SELECT MAX(row_id) FROM raw_ticker_reference WHERE ticker = x.key)
          WHERE x.check_id = ? AND x.state IN ('open', 'acknowledged')
            AND r.security_type IN ${FUND_TYPES}`
      )
      .all(checkId) as { key: string; security_type: string }[]
  ).map((r) => ({
    key: r.key,
    fired: false,
    closesAs: { kind: 'rule_changed' as const, note: `${r.key} is a fund (${r.security_type}) — ${why}` }
  }));
}

/**
 * Closers for a subset-scoped check's open findings on tickers that have LEFT the chain subset
 * (v1.1.285).
 *
 * QC-603 and QC-905 judge current subset members only, so a ticker that leaves is never evaluated
 * again and its finding would stay open for ever. EQR: dropped from the S&P 500 and the Russell
 * 1000 on 2026-09-15, out of the subset on 09-17, last bar 08-17. Every future delisting and
 * acquisition does the same. This is not a disappearance: the collector RECORDED the exit — a
 * closed membership range, with the universe's reason beside it — and that record is the evidence.
 * A ticker with no membership row at all is not closed here; that would be absence, not a record.
 *
 * Kind `rule_changed`, read as "the rule no longer applies to this key": none of the four kinds
 * names a scope exit, and `resolution_kind`'s CHECK is baked into a populated table, so a fifth
 * kind waits for the next generation. Funds are skipped — `fundFindingClosers` owns those.
 */
export function departedFindingClosers(ctx: CheckContext, checkId: string): Evaluation[] {
  return (
    ctx.db
      .prepare(
        `SELECT x.key,
                (SELECT MAX(m.valid_to) FROM ref_chain_subset_membership m WHERE m.ticker = x.key) AS left_subset,
                (SELECT MAX(u.valid_to) FROM ref_universe_membership u
                  WHERE u.ticker = x.key AND u.valid_to IS NOT NULL) AS left_universe,
                (SELECT GROUP_CONCAT(DISTINCT u.list_source || ':' || u.change_reason) FROM ref_universe_membership u
                  WHERE u.ticker = x.key AND u.valid_to IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM ref_universe_membership o WHERE o.ticker = x.key AND o.valid_to IS NULL)) AS why
           FROM qa_exception x
          WHERE x.check_id = ? AND x.state IN ('open', 'acknowledged')
            AND EXISTS (SELECT 1 FROM ref_chain_subset_membership m WHERE m.ticker = x.key AND m.valid_to IS NOT NULL)
            AND NOT EXISTS (SELECT 1 FROM ref_chain_subset_membership m WHERE m.ticker = x.key AND m.valid_to IS NULL)
            AND NOT EXISTS (
              SELECT 1 FROM raw_ticker_reference r
               WHERE r.ticker = x.key AND r.security_type IN ${FUND_TYPES}
                 AND r.row_id = (SELECT MAX(row_id) FROM raw_ticker_reference WHERE ticker = x.key))`
      )
      .all(checkId) as { key: string; left_subset: string; left_universe: string | null; why: string | null }[]
  ).map((r) => ({
    key: r.key,
    fired: false,
    closesAs: {
      kind: 'rule_changed' as const,
      note:
        `${r.key} left the chain subset on ${r.left_subset}` +
        (r.why && r.left_universe ? ` (universe exit ${r.left_universe}: ${r.why.split(',').sort().join(', ')})` : '') +
        `; ${checkId} covers subset members only`
    }
  }));
}

/** How long a filer whose companyfacts lacked its newest report waits before the fact pull asks again. */
export const FACTS_RETRY_DAYS = 7;

/**
 * How long a newly listed stock may go with no report and no announced date: its first full
 * quarter (<= 90 days) plus the 45-day 10-Q deadline of a non-accelerated filer, which every newly
 * public company is.
 */
const NEW_LISTING_GRACE_DAYS = 135;

/** A report this recent puts the next one about a quarter out, possibly past the 90-day sweep. */
const RECENT_REPORT_GRACE_DAYS = 21;

/** The two independent readings QC-602 exists to compare. Both must be present or it is vacuous. */
const EARNINGS_CROSS_SOURCES = ['finnhub', 'etrade'] as const;

/**
 * The sentinel for "these dates cannot be compared at all", well past any real
 * disagreement. QC-603 uses the same device for a date never observed: an
 * unmeasurable case must never take the threshold's own value, or an empty
 * domain reads as a clean one.
 */
const UNCOMPARABLE_DISAGREEMENT_DAYS = 9999;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * Whether a nearest-report date has been reached by the sweep that observed the
 * move, so the roll to the next quarter is the calendar working rather than a slip.
 *
 * **Inclusive, and that boundary is the whole point (v1.1.307).** It was `<`,
 * so a date landing exactly on the run's own `as_of_date` was not excused —
 * and a ticker reporting *today* is precisely the case where the roll is most
 * certainly legitimate. FERG's FY2026 Q4 sat at 2026-09-22 for seven runs; on
 * 2026-09-22 Finnhub dropped that row and the nearest became the FY2026 Q3 row
 * at 2026-12-07 that had been stored since run 8. Nothing was truncated and no
 * date was lost, yet the check reported **76 days later** — the single largest
 * slip in the generation and the exact bulk-cap signature it exists to catch,
 * manufactured from entirely correct data.
 *
 * The collector runs after the close, so a report dated today has happened
 * (BMO hours ago, AMC within the hour). Nothing is given up by including it:
 * a truncation that dropped a date equal to today would roll to the next
 * quarter anyway, because that date has passed.
 *
 * One spelling, called from both the live reading and the re-judge, which
 * carried their own copies of this comparison.
 */
function rolledAfterReport(previousNearest: string, asOfDate: string): boolean {
  return previousNearest <= asOfDate;
}

export const QC601_EARNINGS_SLIPS_LATER: CheckDefinition = {
  id: 'QC-601',
  domain: 'earnings',
  severity: 'blocking',
  description:
    'For a ticker and source, the NEAREST FUTURE report date is not more than 14 days later than ' +
    'the nearest future date the previous sweep saw. A large later slip is the bulk-cap truncation ' +
    'signature: the cap drops the EARLIEST dates, so a truncated response reports the next quarter ' +
    'as if it were the next report. The asymmetry is the point — nearer is unbounded, later is not. ' +
    'Open findings are re-judged under this rule over the runs they were seen in.',
  readsTables: ['raw_earnings_event', 'qa_exception'],
  testedQuantity: 'later_slip_days',
  testedUnit: 'days',
  thresholds: { maxLaterSlipDays: MAX_LATER_SLIP_DAYS },
  thresholdBasis: 'measured',
  thresholdEvidence:
    'The existing app stored NVDA 2026-08-26 as 2026-11-17, an 83-day slip, from a response sitting ' +
    'exactly at Finnhub\'s 1,500-row cap. Fourteen days is wide enough for an issuer moving its own ' +
    'date and far short of a quarter.',
  remediation: 'R4',
  run(ctx) {
    // The nearest FUTURE report date per sweep, compared sweep to sweep — not
    // the newest row compared to the row before it.
    //
    // A sweep is subdivided into windows, because the bulk calendar truncates at
    // its row cap, so one run writes one row per window per ticker. MU's
    // 2026-09-30 and its 2026-12-15 are two real reports in two windows of the
    // SAME sweep, written 409 ms apart; read as successive observations they
    // reported a 76-day slip on entirely correct data. Seven of the eight
    // findings on 2026-09-17 were that artefact, and it grows as a quarter-end
    // pulls more tickers' second report inside the sweep horizon.
    //
    // Ranking by run also fixes the direction this check was blind in: the last
    // row written for a ticker is always its FARTHEST date, so a truncation that
    // moved the NEAREST one — the fault the check exists for — was masked by the
    // same confusion that manufactured the false ones.
    const rows = ctx.db
      .prepare(
        `WITH nearest AS (
           SELECT ticker, source, run_id, as_of_date, MIN(report_date) AS near_date
             FROM raw_earnings_event
            WHERE report_date >= as_of_date
            GROUP BY ticker, source, run_id
         ),
         ranked AS (
           SELECT ticker, source, run_id, as_of_date, near_date,
                  ROW_NUMBER() OVER (PARTITION BY ticker, source ORDER BY run_id DESC) AS rn
             FROM nearest
         )
         SELECT n.ticker, n.source, n.near_date AS new_date, n.as_of_date AS new_as_of,
                p.near_date AS prev_date
           FROM ranked n
           JOIN ranked p ON p.ticker = n.ticker AND p.source = n.source AND p.rn = 2
          WHERE n.rn = 1 AND n.near_date <> p.near_date`
      )
      .all() as {
      ticker: string; source: string; new_date: string; new_as_of: string; prev_date: string;
    }[];

    const maxSlip = this.thresholds['maxLaterSlipDays'] as number;
    const today = rows.map((r): Evaluation => {
      const slip = daysBetween(r.prev_date, r.new_date);
      // A date the issuer has already reported on rolls to the next quarter, and
      // that roll is the calendar working, not a slip. GIS moved 2026-09-15 ->
      // 2026-12-15 two days after it reported. Clamped like a nearer move and
      // for the same reason: a legitimate move left in the fault's distribution
      // blurs the boundary the threshold is drawn against.
      const rolled = rolledAfterReport(r.prev_date, r.new_as_of);
      return {
        key: `${r.ticker}:${r.source}`,
        // Only a LATER move is measured. A nearer move is legitimate and
        // reporting it as a negative magnitude would put it in the same
        // distribution as the fault and blur the boundary.
        value: rolled ? 0 : Math.max(slip, 0),
        fired: !rolled && slip > (this.thresholds['maxLaterSlipDays'] as number),
        detail:
          `${r.ticker} (${r.source}) nearest report moved ${r.prev_date} -> ${r.new_date}, ${slip} days later`,
        evidence: {
          ticker: r.ticker, source: r.source, previous: r.prev_date, observed: r.new_date,
          slipDays: slip, rolledAfterReport: rolled
        }
      };
    });
    return today.concat(rejudgeSlipFindings(ctx, today, maxSlip));
  }
};

/**
 * QC-601's open findings, judged again under the current sweep-to-sweep rule over the runs they
 * were seen in (v1.1.283).
 *
 * The first rule compared a ticker's newest row with the row before it, and one sweep writes a row
 * per subdivided window — so MU's 2026-09-30 and 2026-12-15, two real reports from two windows of
 * ONE sweep, read as a 76-day slip. Seven of eight findings on 2026-09-17 were that artefact, and
 * nine were still open on 2026-09-18 with nothing able to close them: the current rule compares
 * only the latest two sweeps, so a finding from earlier sweeps is never looked at again.
 *
 * So each open finding gets the current rule applied to every sweep pair in the runs it was seen
 * in: the nearest future date per run, a roll after the issuer reported excused. If no pair would
 * fire, the finding came from the old rule and closes `rule_changed`. If any pair still fires, it
 * is a real slip and stays open, whatever the latest sweep says.
 */
function rejudgeSlipFindings(ctx: CheckContext, today: readonly Evaluation[], maxSlip: number): Evaluation[] {
  const evaluatedToday = new Set(today.map((e) => e.key));
  const open = ctx.db
    .prepare(
      `SELECT key, first_seen_run_id, last_seen_run_id FROM qa_exception
        WHERE check_id = 'QC-601' AND state IN ('open', 'acknowledged')`
    )
    .all() as { key: string; first_seen_run_id: number; last_seen_run_id: number }[];
  const nearestByRun = ctx.db.prepare(
    `SELECT run_id, as_of_date, MIN(report_date) AS near_date
       FROM raw_earnings_event
      WHERE ticker = ? AND source = ? AND report_date >= as_of_date
      GROUP BY run_id
      ORDER BY run_id`
  );

  const out: Evaluation[] = [];
  for (const f of open) {
    if (evaluatedToday.has(f.key)) continue; // today's reading decides it
    const sep = f.key.lastIndexOf(':');
    if (sep <= 0) continue;
    const sweeps = nearestByRun.all(f.key.slice(0, sep), f.key.slice(sep + 1)) as
      { run_id: number; as_of_date: string; near_date: string }[];

    let pairs = 0;
    let fires = false;
    for (let i = 1; i < sweeps.length; i++) {
      const prev = sweeps[i - 1]!;
      const cur = sweeps[i]!;
      if (cur.run_id < f.first_seen_run_id || cur.run_id > f.last_seen_run_id) continue;
      pairs++;
      if (!rolledAfterReport(prev.near_date, cur.as_of_date) && daysBetween(prev.near_date, cur.near_date) > maxSlip) { fires = true; break; }
    }
    if (fires) continue;
    out.push({
      key: f.key,
      fired: false,
      closesAs: {
        kind: 'rule_changed',
        note:
          `re-judged sweep to sweep over runs ${f.first_seen_run_id}–${f.last_seen_run_id} (${pairs} ` +
          `pair${pairs === 1 ? '' : 's'}): the nearest report date never slipped more than ${maxSlip} days — ` +
          'raised by the first rule, which read two windows of one sweep as successive observations'
      }
    });
  }
  return out;
}

export const QC602_EARNINGS_SOURCE_DISAGREEMENT: CheckDefinition = {
  id: 'QC-602',
  domain: 'earnings',
  severity: 'warning',
  description:
    'Finnhub and E*Trade agree within three days on the same ticker\'s next report date, E*Trade read ' +
    'in the run that fetched it. Two independent readings are the cheapest way to catch one feed ' +
    'drifting, and this domain has a documented history of one of them being confidently wrong. A ' +
    'missing second source is itself the finding: with one source every ticker passes unexamined, ' +
    'which is indistinguishable from agreement.',
  readsTables: ['raw_earnings_event', 'qa_exception'],
  testedQuantity: 'source_disagreement_days',
  testedUnit: 'days',
  thresholds: { maxDisagreementDays: 3 },
  thresholdBasis: 'measured',
  thresholdEvidence:
    'All 11 same-run pairs through 2026-09-23: |gap| 1 (1), 2 (7), 4, 7, 11. Before a company announces, ' +
    'both sources publish an estimate and they differ by ~2 days by construction (AAPL, ABT, ADI, ADM, ADP, ' +
    'AFL, AIG); the two announced dates in the sample were E*Trade errors of 4 (ACN) and 7 (ABBV) days. ' +
    'Three separates the two; the drafted 1 fired 10 of 11 and 5 would have missed ACN.',
  run(ctx) {
    // This check self-joined on source = 'etrade', and `raw_earnings_event` has
    // only ever held finnhub rows — the collector does not fetch the second
    // source at all. So it evaluated 0 on every daily run of the generation and
    // could not have fired, the vacuous pass this framework exists to make
    // visible. It was dead on 2026-09-17, the night QC-601 fired eight earnings
    // findings it was the only available corroboration for.
    //
    // Collecting E*Trade earnings is a collection change, not a check change, so
    // until it lands the absence is REPORTED rather than passed over in silence.
    const present = new Set(
      (
        ctx.db
          .prepare('SELECT DISTINCT source FROM raw_earnings_event WHERE report_date >= ?')
          .all(ctx.tradingDate) as { source: string }[]
      ).map((r) => r.source)
    );
    const missing = EARNINGS_CROSS_SOURCES.filter((s) => !present.has(s));
    if (missing.length > 0) {
      return [
        {
          key: 'sources',
          // The largest possible disagreement, never the threshold's own value:
          // "cannot be compared" must not read as "compared and agreed".
          value: UNCOMPARABLE_DISAGREEMENT_DAYS,
          fired: true,
          detail:
            `no cross-source comparison is possible: ${missing.join(' and ')} ` +
            `${missing.length === 1 ? 'has' : 'have'} no future-dated row` +
            `${present.size > 0 ? ` (present: ${[...present].sort().join(', ')})` : ''}`,
          evidence: { present: [...present].sort(), missing }
        } satisfies Evaluation
      ];
    }

    // The NEAREST future date per source, ranked by run — not the last row written.
    //
    // This is QC-601's artefact in the sibling that reads the same table, and it
    // survived the fix there (v1.1.285) because only QC-601's query was changed.
    // A sweep is subdivided into windows, so one run writes one row per window
    // per ticker and the last row written for a ticker is always its FARTHEST
    // date. On 2026-09-21 ACN had Finnhub's 2026-10-01 and its 2026-12-16 from
    // two windows of one sweep, 204 ms apart; ordering by `observed_at` picked
    // the December date and reported "80 days apart" against E*Trade's
    // 2026-09-27. The real disagreement is four days. The finding was true and
    // its number was fiction, which is worse than either alone — it invites a
    // diagnosis of the wrong feed.
    const rows = ctx.db
      .prepare(
        `WITH nearest AS (
           SELECT ticker, source, run_id, MIN(report_date) AS near_date
             FROM raw_earnings_event
            WHERE report_date >= ?
            GROUP BY ticker, source, run_id
         ),
         ranked AS (
           SELECT ticker, source, near_date,
                  ROW_NUMBER() OVER (PARTITION BY ticker, source ORDER BY run_id DESC) AS rn
             FROM nearest
         )
         SELECT f.ticker, f.near_date AS finnhub_date, e.near_date AS etrade_date
           FROM ranked f
           JOIN nearest e ON e.ticker = f.ticker AND e.source = 'etrade' AND e.run_id = ?
          WHERE f.rn = 1 AND f.source = 'finnhub'`
      )
      .all(ctx.tradingDate, ctx.runId) as { ticker: string; finnhub_date: string; etrade_date: string }[];
    // E*Trade is compared ONLY in the run that fetched it (v1.1.317). The overlap sample asks each
    // covered ticker about once every eleven weeks, and until this the check re-compared that one
    // old row every night — so the consecutive-runs escalation promoted AAPL, ABT, ACN and ABBV to
    // blocking on a single observation each, and the findings could not move until E*Trade was
    // asked again months later. A ticker not re-asked this run is simply not evaluated: its open
    // finding stays open, not firing, and cannot escalate.
    const openFindings = openQc602Findings(ctx);
    const closers = qc602Closers(ctx, openFindings, this.thresholds['maxDisagreementDays'] as number, new Set(rows.map((r) => r.ticker)));

    // Both sources present and NO ticker dated by both is the same finding as a missing
    // source (v1.1.270). E*Trade is asked mainly for tickers Finnhub did not date, so without
    // this the check would pass every night on zero comparisons — "no overlap" and "clean
    // overlap" must not look alike.
    if (rows.length === 0) {
      return [
        {
          key: 'sources',
          value: UNCOMPARABLE_DISAGREEMENT_DAYS,
          fired: true,
          detail: 'no cross-source comparison is possible: no ticker has a future date from finnhub and from this run\'s etrade fetch',
          evidence: { present: [...present].sort(), paired: 0 }
        } satisfies Evaluation,
        ...closers
      ];
    }

    const max = this.thresholds['maxDisagreementDays'] as number;
    return rows.map((r): Evaluation => {
      const gap = Math.abs(daysBetween(r.finnhub_date, r.etrade_date));
      const fired = gap > max;
      return {
        key: r.ticker,
        value: gap,
        fired,
        detail: `${r.ticker}: finnhub ${r.finnhub_date} vs etrade ${r.etrade_date} (${gap} days apart)`,
        evidence: { ticker: r.ticker, finnhub: r.finnhub_date, etrade: r.etrade_date, gapDays: gap },
        // A clean evaluation settles an open finding — as `data_corrected` only when the dates
        // actually moved. The same gap judged under a wider threshold is a rule change, not a fix.
        closesAs: fired
          ? undefined
          : (openFindings.get(r.ticker)?.gapDays ?? Infinity) <= max
            ? { kind: 'rule_changed', note: `${gap} days is inside the ${max}-day threshold (v1.1.317): two estimates of an unannounced date differ by ~2 days by construction` }
            : { kind: 'data_corrected', note: `${r.ticker} re-asked: finnhub ${r.finnhub_date} vs etrade ${r.etrade_date} (${gap} days apart)` }
      };
    }).concat(closers);
  }
};

/**
 * Closers for QC-602 findings on tickers NOT compared this run (v1.1.317). Three cases, each on
 * the finding's own recorded evidence, never on absence:
 *  - both report dates have passed: there is nothing left for the two sources to disagree about;
 *  - the recorded gap is inside the current threshold: it would not fire under today's rule;
 *  - the finding was escalated above its base severity: under the old rule that escalation came
 *    from re-comparing one stale E*Trade row night after night, not from repeated observation.
 * Anything else (a real, still-future disagreement at base severity) stays open until E*Trade is
 * asked again.
 */
interface OpenQc602Finding {
  readonly severity: string;
  readonly baseSeverity: string;
  readonly firstSeenRunId: number;
  readonly finnhub: string | undefined;
  readonly etrade: string | undefined;
  readonly gapDays: number | undefined;
}

function openQc602Findings(ctx: CheckContext): Map<string, OpenQc602Finding> {
  const rows = ctx.db
    .prepare(
      `SELECT key, severity, base_severity, first_seen_run_id, evidence_json
         FROM qa_exception
        WHERE check_id = 'QC-602' AND state IN ('open', 'acknowledged') AND key <> 'sources'`
    )
    .all() as { key: string; severity: string; base_severity: string; first_seen_run_id: number; evidence_json: string }[];
  return new Map(rows.map((r) => {
    const ev = JSON.parse(r.evidence_json) as { finnhub?: string; etrade?: string; gapDays?: number };
    return [r.key, {
      severity: r.severity, baseSeverity: r.base_severity, firstSeenRunId: r.first_seen_run_id,
      finnhub: ev.finnhub, etrade: ev.etrade, gapDays: ev.gapDays
    }];
  }));
}

function qc602Closers(
  ctx: CheckContext, open: ReadonlyMap<string, OpenQc602Finding>, maxGap: number, comparedNow: ReadonlySet<string>
): Evaluation[] {
  const out: Evaluation[] = [];
  for (const [key, ev] of open) {
    if (comparedNow.has(key)) continue;
    if (!ev.finnhub || !ev.etrade || ev.gapDays === undefined) continue;
    const f = { key, severity: ev.severity, base_severity: ev.baseSeverity, first_seen_run_id: ev.firstSeenRunId };
    const later = ev.finnhub > ev.etrade ? ev.finnhub : ev.etrade;
    const note =
      later < ctx.tradingDate
        ? `both report dates have passed (finnhub ${ev.finnhub}, etrade ${ev.etrade})`
        : ev.gapDays <= maxGap
          ? `${ev.gapDays} days is inside the ${maxGap}-day threshold (v1.1.317): two estimates of an unannounced date differ by ~2 days by construction`
          : f.severity !== f.base_severity
            ? `escalated to ${f.severity} by re-comparing one E*Trade observation (run ${f.first_seen_run_id}) every night; ` +
              `QC-602 compares only same-run observations since v1.1.317 — recorded ${ev.gapDays}-day gap kept in evidence`
            : null;
    if (note) out.push({ key: f.key, fired: false, closesAs: { kind: 'rule_changed', note } });
  }
  return out;
}

export const QC603_EARNINGS_FRESHNESS: CheckDefinition = {
  id: 'QC-603',
  domain: 'earnings',
  severity: 'warning',
  description:
    'A common-stock ticker in the chain subset has a future report date observed recently. A ticker ' +
    'that has quietly dropped out of the calendar is the state in which no earnings penalty can ' +
    'fire, which is indistinguishable from a ticker with no earnings coming. Two cases are not ' +
    'staleness: a ticker that reported in the last 21 days (its next date can sit past the sweep), and ' +
    'one listed within 135 days that has never been dated (its first report is not yet due).',
  readsTables: ['raw_earnings_event', 'ref_chain_subset_membership', 'raw_ticker_reference', 'qa_exception', 'ref_universe_membership'],
  testedQuantity: 'days_since_future_date_observed',
  testedUnit: 'days',
  thresholds: { maxDaysSinceObserved: 7 },
  thresholdBasis: 'working',
  remediation: 'R2',
  run(ctx) {
    // Funds are excluded: an ETF has no earnings. On 2026-09-16, 47 of 68 findings were ETFs in
    // the chain subset (SPY, QQQ, GLD ...) that could never pass.
    const rows = ctx.db
      .prepare(
        `SELECT m.ticker,
                (SELECT MAX(substr(e.observed_at, 1, 10))
                   FROM raw_earnings_event e
                  WHERE e.ticker = m.ticker AND e.report_date >= ?) AS last_seen,
                (SELECT MAX(e.report_date)
                   FROM raw_earnings_event e
                  WHERE e.ticker = m.ticker AND e.report_date < ?) AS last_reported,
                (SELECT r.list_date FROM raw_ticker_reference r
                  WHERE r.ticker = m.ticker ORDER BY r.row_id DESC LIMIT 1) AS list_date
           FROM ref_chain_subset_membership m
          WHERE m.valid_to IS NULL
            AND m.ticker NOT IN (
              SELECT ticker FROM raw_ticker_reference
               WHERE security_type IN ${FUND_TYPES}
                 AND row_id IN (SELECT MAX(row_id) FROM raw_ticker_reference GROUP BY ticker))`
      )
      .all(ctx.tradingDate, ctx.tradingDate) as {
      ticker: string; last_seen: string | null; last_reported: string | null; list_date: string | null;
    }[];

    return rows.map((r): Evaluation => {
      // Just reported: the next date lies about a quarter out and can fall past the sweep's
      // 90-day window. GIS and FPS reported 2026-09-15 and fired the next day. Absent from the
      // calendar here means "not yet in range", not "dropped out".
      const justReported =
        r.last_seen === null &&
        r.last_reported !== null &&
        daysBetween(r.last_reported, ctx.tradingDate) <= RECENT_REPORT_GRACE_DAYS;
      // Newly listed and never dated: its first report is not due yet, so there is no date to
      // have missed (v1.1.274). HONA and SPCX listed in June 2026 and fired from their first run.
      // Bounded by a newly public company's own deadline — a 10-Q is due 45 days after its first
      // full quarter ends — so past ~135 days "never dated" is a coverage gap again and fires.
      const listedDays = r.list_date === null ? null : daysBetween(r.list_date, ctx.tradingDate);
      const newlyListed =
        r.last_seen === null && r.last_reported === null &&
        listedDays !== null && listedDays >= 0 && listedDays <= NEW_LISTING_GRACE_DAYS;
      // Never observed (and not just reported) is the largest possible staleness, never the
      // threshold's own value, or an empty domain would read as a clean one.
      const days = justReported || newlyListed ? 0 : r.last_seen === null ? 9999 : daysBetween(r.last_seen, ctx.tradingDate);
      const fired = days > (this.thresholds['maxDaysSinceObserved'] as number);
      return {
        key: r.ticker,
        value: days,
        fired,
        detail:
          r.last_seen === null
            ? `${r.ticker}: no future report date has ever been observed`
            : `${r.ticker}: future report date last observed ${r.last_seen} (${days} days ago)`,
        evidence: {
          ticker: r.ticker, lastObserved: r.last_seen, lastReported: r.last_reported, justReported,
          listDate: r.list_date, newlyListed
        },
        // Freshness is a claim about NOW, so a clean reading today settles an open finding — and
        // says why (v1.1.282). An exemption is a rule the finding predates; a fresh date is data.
        closesAs: fired
          ? undefined
          : justReported
            ? { kind: 'rule_changed', note: `${r.ticker} reported ${r.last_reported}, inside the ${RECENT_REPORT_GRACE_DAYS}-day just-reported grace` }
            : newlyListed
              ? { kind: 'rule_changed', note: `${r.ticker} listed ${r.list_date}; its first report is not yet due (${NEW_LISTING_GRACE_DAYS}-day new-listing grace)` }
              : { kind: 'data_corrected', note: `${r.ticker}: a future report date was observed ${r.last_seen}` }
      };
    }).concat(
      fundFindingClosers(ctx, 'QC-603', 'funds have no earnings and are excluded from QC-603 since v1.1.257'),
      departedFindingClosers(ctx, 'QC-603')
    );
  }
};

export const QC604_EARNINGS_WEEKEND_DATE: CheckDefinition = {
  id: 'QC-604',
  domain: 'earnings',
  severity: 'warning',
  description:
    'A report date falls on a trading day. A Saturday date is the UTC artefact the existing app ' +
    'shifts by hand: E*Trade dates are UTC, so a Thursday-evening ET report reads as Saturday. It is ' +
    'stored exactly as observed and flagged here rather than silently moved — the shift is a ' +
    'reader-side resolution, and a raw table that quietly corrects its source cannot be replayed.',
  readsTables: ['raw_earnings_event', 'ref_trading_day'],
  testedQuantity: 'non_trading_day_fraction',
  testedUnit: 'fraction',
  thresholds: { maxFraction: 0 },
  thresholdBasis: 'structural',
  run(ctx) {
    const rows = ctx.db
      .prepare(
        `SELECT DISTINCT ticker, report_date, source
           FROM raw_earnings_event
          WHERE report_date >= ?`
      )
      .all(ctx.tradingDate) as { ticker: string; report_date: string; source: string }[];
    if (rows.length === 0) return [];

    // `ref_trading_day` is the authority when it covers the date. When it does
    // not — the calendar is seeded a year at a time — weekday arithmetic in a
    // single time base is the fallback, never a mix of the two.
    const known = new Set(
      (
        ctx.db.prepare('SELECT date FROM ref_trading_day WHERE is_trading_day = 1').all() as {
          date: string;
        }[]
      ).map((r) => r.date)
    );
    const calendarMax = ctx.db
      .prepare('SELECT MAX(date) AS m FROM ref_trading_day')
      .get() as { m: string | null } | undefined;

    const offenders: typeof rows = [];
    for (const r of rows) {
      const inCalendarRange = calendarMax?.m != null && r.report_date <= calendarMax.m;
      const isTrading = inCalendarRange
        ? known.has(r.report_date)
        : ![0, 6].includes(new Date(`${r.report_date}T00:00:00Z`).getUTCDay());
      if (!isTrading) offenders.push(r);
    }

    const fraction = offenders.length / rows.length;
    return [
      {
        key: ctx.tradingDate,
        value: fraction,
        fired: offenders.length > 0,
        detail: `${offenders.length} of ${rows.length} future report dates fall on a non-trading day`,
        evidence: {
          total: rows.length,
          sample: offenders.slice(0, 20).map((o) => `${o.ticker} ${o.report_date} (${o.source})`)
        }
      }
    ];
  }
};

export const QC701_FILING_FRESHNESS: CheckDefinition = {
  id: 'QC-701',
  domain: 'fundamentals',
  severity: 'warning',
  description:
    'A common-stock ticker with a CIK has an XBRL fact whose period ends within 120 days, and is ' +
    'blocking past 180. Each finding names its cause: no newer filing seen (a late filer), a filing ' +
    'still queued for companyfacts, which is our backlog, or SEC companyfacts read after the filing and still ' +
    'missing it (SEC\'s aggregate — IQV and JCI on 2026-09-18, July 10-Qs filed with inline XBRL).',
  readsTables: ['raw_edgar_fact', 'raw_ticker_reference', 'raw_edgar_filing', 'meta_response'],
  testedQuantity: 'days_since_newest_period_end',
  testedUnit: 'days',
  thresholds: { warnAfterDays: 120 },
  thresholdBasis: 'working',
  promoteToBlockingAtValue: 180,
  remediation: 'R2',
  run(ctx) {
    const rows = ctx.db
      .prepare(
        `SELECT r.ticker, r.cik,
                (SELECT MAX(f.period_end) FROM raw_edgar_fact f WHERE f.cik = r.cik) AS newest
           FROM raw_ticker_reference r
          WHERE r.cik IS NOT NULL
            AND r.security_type = 'CS'
            AND r.row_id IN (SELECT MAX(row_id) FROM raw_ticker_reference GROUP BY ticker)
            AND r.ticker IN (SELECT ticker FROM ref_chain_subset_membership WHERE valid_to IS NULL)`
      )
      .all() as { ticker: string; cik: string; newest: string | null }[];

    // Why the facts are old, stated rather than assumed (v1.1.271). The description used to
    // say past 180 days "it is our pipeline, not the filer" — and on 2026-09-18 both findings
    // were neither: IQV and JCI filed their July 10-Qs with inline XBRL, the collector fetched
    // companyfacts AFTER those filings, and SEC's aggregate still did not contain them.
    const pendingFiling = ctx.db.prepare(
      `SELECT form, filed_date FROM raw_edgar_filing f
        WHERE f.cik = ? AND f.form IN ('10-K', '10-Q', '20-F', '40-F')
          AND NOT EXISTS (SELECT 1 FROM raw_edgar_fact x WHERE x.accession_no = f.accession_no)
        ORDER BY f.filed_date DESC LIMIT 1`
    );
    const lastFetch = ctx.db.prepare(
      `SELECT MAX(substr(requested_at, 1, 10)) AS at FROM meta_response
        WHERE endpoint = '/api/xbrl/companyfacts/CIK{cik}.json' AND parse_status = 'ok'
          AND json_extract(params_json, '$.cik') = ?`
    );

    // A filer whose facts have never been pulled is not a stale filer — the
    // fact pull is filing-triggered and works through a queue. Reporting it as
    // 9999 days stale would fill the gate with findings about our own backlog.
    return rows
      .filter((r) => r.newest !== null)
      .map((r) => {
        const days = daysBetween(r.newest as string, ctx.tradingDate);
        const fired = days > (this.thresholds['warnAfterDays'] as number);
        let cause: 'sec_companyfacts_missing' | 'awaiting_fetch' | 'no_newer_filing_seen' | null = null;
        let why = '';
        if (fired) {
          const filing = pendingFiling.get(r.cik) as { form: string; filed_date: string } | undefined;
          const fetched = (lastFetch.get(r.cik) as { at: string | null } | undefined)?.at ?? null;
          if (!filing) {
            cause = 'no_newer_filing_seen';
            why = ' — no newer report filing has been seen (a late filer, or a filing the submissions slice has not reached)';
          } else if (fetched !== null && fetched >= filing.filed_date) {
            cause = 'sec_companyfacts_missing';
            why = ` — SEC companyfacts fetched ${fetched} still has no facts for the ${filing.form} filed ${filing.filed_date}; SEC's aggregate is behind, not the pipeline (retried every ${FACTS_RETRY_DAYS} days)`;
          } else {
            cause = 'awaiting_fetch';
            const last = fetched ? `; companyfacts last read ${fetched}` : '';
            why = ` — the ${filing.form} filed ${filing.filed_date} is queued for companyfacts${last}`;
          }
        }
        return {
          key: r.ticker,
          value: days,
          fired,
          detail: `${r.ticker} (CIK ${r.cik}): newest fact period ends ${r.newest}, ${days} days ago${why}`,
          evidence: { ticker: r.ticker, cik: r.cik, newestPeriodEnd: r.newest, days, ...(cause ? { cause } : {}) }
        } satisfies Evaluation;
      });
  }
};

export const QC702_FACT_SANITY: CheckDefinition = {
  id: 'QC-702',
  domain: 'fundamentals',
  severity: 'warning',
  description:
    'Share count from EDGAR agrees with the provider reference within 25 %. Neither side of this ' +
    'comparison existed in the old schema — its only share-count column is empty in practice and it ' +
    'has no CIK column at all — so the threshold could not be measured before the pilot, and it is a ' +
    'working value rather than a guess dressed as one. ' +
    'v1.1.309: the two sides are observed on DIFFERENT DATES, so a split between them puts them on ' +
    'different scales and the comparison measures the corporate action rather than the data. IESC ' +
    'read 50.0 % on 2026-09-22 — EDGAR 19,924,356 stated 2026-07-27, Polygon 39,848,712 observed ' +
    '2026-09-11, and a 1:2 split on 2026-08-24 sits between them; both numbers are exactly right. ' +
    'The EDGAR figure is now carried across any split in the window before comparing, and the ' +
    'adjustment is named in the finding rather than applied silently.',
  readsTables: ['raw_edgar_fact', 'raw_ticker_reference', 'raw_split'],
  testedQuantity: 'shares_disagreement_fraction',
  testedUnit: 'fraction',
  thresholds: { maxDisagreement: 0.25 },
  thresholdBasis: 'working',
  run(ctx) {
    const rows = ctx.db
      .prepare(
        `WITH latest_ref AS (
           SELECT ticker, cik, shares_outstanding, as_of_date
             FROM raw_ticker_reference
            WHERE cik IS NOT NULL AND shares_outstanding IS NOT NULL
              AND row_id IN (SELECT MAX(row_id) FROM raw_ticker_reference GROUP BY ticker)
         ),
         latest_fact AS (
           SELECT cik, value, period_end,
                  ROW_NUMBER() OVER (PARTITION BY cik ORDER BY period_end DESC, filed_date DESC) AS rn
             FROM raw_edgar_fact
            WHERE taxonomy = 'dei' AND concept = 'EntityCommonStockSharesOutstanding'
              AND unit = 'shares' AND value > 0
         )
         SELECT r.ticker, r.shares_outstanding AS ref_shares, f.value AS fact_shares, f.period_end,
                r.as_of_date AS ref_as_of
           FROM latest_ref r JOIN latest_fact f ON f.cik = r.cik AND f.rn = 1`
      )
      .all() as {
      ticker: string; ref_shares: number; fact_shares: number; period_end: string; ref_as_of: string;
    }[];

    // Splits per ticker, so the EDGAR figure can be carried onto the reference's
    // scale. Read once — the table holds thousands of rows and the comparison
    // runs over dozens of tickers.
    //
    // An incomplete `raw_split` makes this UNDER-adjust and therefore fire,
    // which is the right direction to fail in: a missing corporate action shows
    // up as a loud disagreement rather than as a silent correction.
    const splitsByTicker = new Map<string, { date: string; factor: number }[]>();
    for (const s of ctx.db
      .prepare('SELECT ticker, execution_date, split_from, split_to FROM raw_split WHERE split_from > 0')
      .all() as { ticker: string; execution_date: string; split_from: number; split_to: number }[]) {
      const list = splitsByTicker.get(s.ticker) ?? [];
      list.push({ date: s.execution_date, factor: s.split_to / s.split_from });
      splitsByTicker.set(s.ticker, list);
    }

    return rows.map((r) => {
      // The two sides are observed on different dates, so only a split BETWEEN
      // them separates their scales: one on or before `period_end` is already
      // in the EDGAR figure, and one after the reference observation is in
      // neither.
      const between = (splitsByTicker.get(r.ticker) ?? []).filter(
        (s) => s.date > r.period_end && s.date <= r.ref_as_of
      );
      const factor = between.reduce((acc, s) => acc * s.factor, 1);
      const adjusted = r.fact_shares * factor;
      const disagreement = Math.abs(adjusted - r.ref_shares) / r.ref_shares;
      const carried =
        factor === 1
          ? ''
          : ` [EDGAR carried ×${factor} across ${between.length} split(s) on ${between.map((s) => s.date).join(', ')}]`;
      return {
        key: r.ticker,
        value: disagreement,
        fired: disagreement > (this.thresholds['maxDisagreement'] as number),
        detail:
          `${r.ticker}: EDGAR ${adjusted.toLocaleString()} vs reference ` +
          `${r.ref_shares.toLocaleString()} shares (${(disagreement * 100).toFixed(1)}%)${carried}`,
        evidence: {
          splitFactor: factor,
          splitsBetween: between.map((s) => s.date),
          // As filed AND as compared. Keeping only one of them would make a
          // carried figure impossible to check back against the filing.
          edgarSharesAsFiled: r.fact_shares,
          referenceObservedAt: r.ref_as_of,
          ticker: r.ticker, edgarShares: adjusted, referenceShares: r.ref_shares,
          periodEnd: r.period_end, disagreement
        }
      } satisfies Evaluation;
    });
  }
};

export const EARNINGS_FUNDAMENTALS_CHECKS: readonly CheckDefinition[] = [
  QC601_EARNINGS_SLIPS_LATER,
  QC602_EARNINGS_SOURCE_DISAGREEMENT,
  QC603_EARNINGS_FRESHNESS,
  QC604_EARNINGS_WEEKEND_DATE,
  QC701_FILING_FRESHNESS,
  QC702_FACT_SANITY
];
