import type { CheckContext, CheckDefinition, Evaluation } from '../check.js';
import { FUND_TYPES } from './earnings-fundamentals.js';

/**
 * Cross-cutting checks — 03 §3.1. These run on every table the run wrote.
 *
 * All of them are **predicate** checks: a row either has provenance or it does
 * not. They declare `testedQuantity: null`, and the framework then requires
 * them to return no values — the pairing is enforced, so a magnitude check
 * cannot masquerade as a predicate one to avoid recording its distribution.
 */

const RAW_LAYERS = "('raw', 'ext', 'derived', 'legacy')";

/**
 * The layers whose rows are PARSED from a response. `derived` is not one of
 * them: a derived row is a function of many stored rows, and the dictionary
 * makes its `source_response_id` nullable and always null for exactly that
 * reason (standard-columns.ts). Including it made QC-001 fire on every day the
 * derive phase wrote a row — the one IV30 row a day on gen-001 — so the check
 * contradicted the dictionary it reads and no pilot day could come out clean.
 */
const PARSED_LAYERS = "('raw', 'ext', 'legacy')";

export const QC001_PROVENANCE: CheckDefinition = {
  id: 'QC-001',
  domain: 'cross_cutting',
  severity: 'blocking',
  description:
    'Every raw row written this run points at a meta_response row that exists and parsed. This is ' +
    'AC-1 checked rather than assumed: a row whose response is missing cannot be traced to the ' +
    'bytes it came from, so the value is unexplainable no matter how plausible it looks.',
  readsTables: ['meta_response', 'meta_dictionary'],
  testedQuantity: null,
  testedUnit: null,
  thresholds: {},
  thresholdBasis: 'not_applicable',
  run(ctx) {
    const tables = (
      ctx.db
        .prepare(
          `SELECT DISTINCT table_name FROM meta_dictionary
            WHERE layer IN ${PARSED_LAYERS} AND column_name = 'source_response_id'`
        )
        .all() as { table_name: string }[]
    ).map((r) => r.table_name);

    const out: Evaluation[] = [];
    for (const table of tables) {
      const orphans = ctx.db
        .prepare(
          `SELECT COUNT(*) AS n FROM "${table}" t
            WHERE t.run_id = ?
              AND (t.source_response_id IS NULL
                   OR NOT EXISTS (SELECT 1 FROM meta_response r
                                   WHERE r.source_response_id = t.source_response_id
                                     AND r.parse_status <> 'failed'))`
        )
        .get(ctx.runId) as { n: number };
      out.push({
        key: table,
        fired: orphans.n > 0,
        detail: orphans.n > 0 ? `${orphans.n} row(s) in ${table} have no usable source response` : undefined,
        evidence: { table, orphanRows: orphans.n }
      });
    }
    return out;
  }
};

export const QC004_NULL_DISCIPLINE: CheckDefinition = {
  id: 'QC-004',
  domain: 'cross_cutting',
  severity: 'blocking',
  description:
    'A value column is null exactly when its status column says it is. The database already carries ' +
    'this as a CHECK, so this check is the belt to that braces — it also catches a status column ' +
    'holding a value outside the declared vocabulary, which the CHECK would allow if the dictionary ' +
    'and the table ever drifted.',
  readsTables: ['meta_dictionary'],
  testedQuantity: null,
  testedUnit: null,
  thresholds: {},
  thresholdBasis: 'not_applicable',
  run(ctx) {
    const pairs = ctx.db
      .prepare(
        `SELECT table_name, column_name, status_column FROM meta_dictionary
          WHERE status_column IS NOT NULL AND layer IN ${RAW_LAYERS}`
      )
      .all() as { table_name: string; column_name: string; status_column: string }[];

    const out: Evaluation[] = [];
    for (const p of pairs) {
      const bad = ctx.db
        .prepare(
          `SELECT COUNT(*) AS n FROM "${p.table_name}"
            WHERE run_id = ?
              AND ((("${p.status_column}" = 'ok') AND "${p.column_name}" IS NULL)
                OR (("${p.status_column}" <> 'ok') AND "${p.column_name}" IS NOT NULL))`
        )
        .get(ctx.runId) as { n: number };
      if (bad.n === 0) continue;
      out.push({
        key: `${p.table_name}.${p.column_name}`,
        fired: true,
        detail: `${bad.n} row(s) where ${p.column_name} and ${p.status_column} disagree`,
        evidence: { table: p.table_name, column: p.column_name, statusColumn: p.status_column, rows: bad.n }
      });
    }
    // A clean run still records that the check looked — otherwise `evaluated_total`
    // stays at zero and the check is indistinguishable from one that never ran.
    if (out.length === 0) out.push({ key: 'all', fired: false });
    return out;
  }
};

export const QC008_PROVIDER_CAP: CheckDefinition = {
  id: 'QC-008',
  domain: 'cross_cutting',
  severity: 'blocking',
  description:
    'A response that came back AT a known provider cap was followed by a subdivided sweep. Finnhub ' +
    'truncates its bulk calendar from the FRONT at 1,500, so a payload at the cap is evidence of ' +
    'truncation, not of a complete answer — trusting one stored an earnings date a quarter late in ' +
    'the existing app and silently suppressed all three mechanisms that would have corrected it. ' +
    'Until v1.1.252 the check fired on every capped response, including a date window whose halves ' +
    'the sweep then re-fetched uncapped in the same run: 3 blocking findings on 2026-09-16 for a ' +
    'sweep that had done exactly what the check asks. A capped `from`/`to` window now passes when ' +
    'uncapped responses to the same endpoint in the same run cover every day of it. Open findings from ' +
    'earlier runs are re-judged against their own run, and a submissions finding on a fund closes since ' +
    'funds left the EDGAR sweep.',
  readsTables: ['meta_response', 'qa_exception', 'raw_ticker_reference'],
  testedQuantity: null,
  testedUnit: null,
  thresholds: {},
  thresholdBasis: 'not_applicable',
  run(ctx) {
    const capped = ctx.db
      .prepare(
        `SELECT source_response_id, endpoint, params_json FROM meta_response
          WHERE run_id = ? AND at_provider_cap = 1`
      )
      .all(ctx.runId) as { source_response_id: number; endpoint: string; params_json: string }[];

    const covered = coveredBySubdivision(ctx);
    const rejudged = rejudgeCapFindings(ctx, new Set(capped.map((r) => String(r.source_response_id))), covered);
    if (capped.length === 0) return [{ key: 'run', fired: false }, ...rejudged];

    return capped.map((r): Evaluation => {
      const isCovered = covered(ctx.runId, r.endpoint, r.params_json);
      return {
        key: String(r.source_response_id),
        fired: !isCovered,
        detail: isCovered
          ? undefined
          : `${r.endpoint} returned exactly the provider cap and was not fully re-covered by uncapped ` +
            'responses in this run — treat as truncated',
        evidence: { endpoint: r.endpoint, params: r.params_json, recoveredBySubdivision: isCovered }
      };
    }).concat(rejudged);
  }
};

/**
 * Whether a capped `from`/`to` response was re-covered, day by day, by uncapped responses to the
 * same endpoint in `runId` — the v1.1.252 rule. A response without a date window is never covered.
 */
function coveredBySubdivision(ctx: CheckContext): (runId: number, endpoint: string, paramsJson: string) => boolean {
  const window = (paramsJson: string): { from: string; to: string } | null => {
    try {
      const p = JSON.parse(paramsJson) as Record<string, unknown>;
      const iso = /^\d{4}-\d{2}-\d{2}$/;
      return typeof p['from'] === 'string' && typeof p['to'] === 'string' && iso.test(p['from']) && iso.test(p['to'])
        ? { from: p['from'], to: p['to'] }
        : null;
    } catch {
      return null;
    }
  };
  const uncapped = ctx.db.prepare(
    `SELECT params_json FROM meta_response
      WHERE run_id = ? AND endpoint = ? AND at_provider_cap = 0 AND parse_status = 'ok'`
  );
  return (runId, endpoint, paramsJson) => {
    const parent = window(paramsJson);
    if (!parent) return false;
    const days = new Set<string>();
    for (const row of uncapped.all(runId, endpoint) as { params_json: string }[]) {
      const child = window(row.params_json);
      if (!child || child.from < parent.from || child.to > parent.to) continue;
      for (let d = child.from; d <= child.to; d = addUtcDays(d, 1)) days.add(d);
    }
    for (let d = parent.from; d <= parent.to; d = addUtcDays(d, 1)) {
      if (!days.has(d)) return false;
    }
    return true;
  };
}

/**
 * QC-008's open findings from EARLIER runs, judged again with what the database holds (v1.1.283).
 *
 * Each finding is keyed by a response from the run that raised it, and the check reads only the
 * current run's responses, so an earlier finding is never looked at again. On 2026-09-18, 18 sat open:
 *
 * - **nine Finnhub calendar windows** raised before v1.1.252, each of which the same run's
 *   subdivided sweep had in fact re-covered day by day. The current rule is applied to the
 *   response's OWN run; covered closes `rule_changed`.
 * - **iShares submissions responses** (IVV, IWD, IWF, IWM, IWO, IYR, and LQD from 2026-09-18 once
 *   its run is an earlier one). EDGAR's sweep no longer asks for funds (v1.1.275), and the ticker's
 *   reference says fund; closes `rule_changed`.
 *
 * What cannot be re-judged here stays open: whether a stock's submissions list reached back far
 * enough depends on the oldest date in the response body, which lives only in the encrypted
 * archive (JEF, JPM — v1.1.275 read them complete by hand; that is the operator's ruling to make).
 */
function rejudgeCapFindings(
  ctx: CheckContext,
  evaluatedToday: ReadonlySet<string>,
  covered: (runId: number, endpoint: string, paramsJson: string) => boolean
): Evaluation[] {
  const open = ctx.db
    .prepare(
      `SELECT x.key, r.run_id, r.endpoint, r.params_json
         FROM qa_exception x
         JOIN meta_response r ON r.source_response_id = CAST(x.key AS INTEGER)
        WHERE x.check_id = 'QC-008' AND x.state IN ('open', 'acknowledged')`
    )
    .all() as { key: string; run_id: number; endpoint: string; params_json: string }[];
  const fund = ctx.db.prepare(
    `SELECT security_type FROM raw_ticker_reference
      WHERE ticker = ? AND security_type IN ${FUND_TYPES}
      ORDER BY row_id DESC LIMIT 1`
  );

  const out: Evaluation[] = [];
  for (const f of open) {
    if (evaluatedToday.has(f.key)) continue; // this run's own response: today's reading decides
    if (covered(f.run_id, f.endpoint, f.params_json)) {
      out.push({
        key: f.key, fired: false,
        closesAs: {
          kind: 'rule_changed',
          note: `${f.endpoint} ${f.params_json}: re-covered day by day by run ${f.run_id}'s own uncapped ` +
            'responses — raised before v1.1.252 counted a subdivided sweep as recovery'
        }
      });
      continue;
    }
    if (f.endpoint.startsWith('/submissions/')) {
      let ticker: unknown;
      try {
        ticker = (JSON.parse(f.params_json) as { ticker?: unknown }).ticker;
      } catch {
        continue;
      }
      const type = typeof ticker === 'string' ? (fund.get(ticker) as { security_type: string } | undefined) : undefined;
      if (type) {
        out.push({
          key: f.key, fired: false,
          closesAs: {
            kind: 'rule_changed',
            note: `${String(ticker)} is a fund (${type.security_type}); EDGAR's filings sweep has not asked for funds since v1.1.275`
          }
        });
      }
    }
  }
  return out;
}

function addUtcDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export const QC009_DUPLICATE_NATURAL_KEY: CheckDefinition = {
  id: 'QC-009',
  domain: 'cross_cutting',
  severity: 'warning',
  description:
    'The same natural key was not stored twice from one response. That is an idempotence bug (a ' +
    'response ingested twice, a parser emitting one key twice); two DIFFERENT responses in one run ' +
    'returning the same key is not: a capped Finnhub window stores its rows and its uncapped halves ' +
    'store them again, which is the subdivision QC-008 requires (330 + 322 such keys on 2026-09-16). ' +
    'Keys come from the CURRENT dictionary version only: meta_dictionary keeps every version, and ' +
    'reading them all kept a superseded key firing after the key was fixed.',
  readsTables: ['meta_dictionary'],
  testedQuantity: null,
  testedUnit: null,
  thresholds: {},
  thresholdBasis: 'not_applicable',
  run(ctx) {
    const tables = ctx.db
      .prepare(
        `SELECT DISTINCT table_name, natural_key FROM meta_dictionary
          WHERE layer IN ${RAW_LAYERS} AND column_name = 'run_id'
            AND dictionary_version = (SELECT MAX(dictionary_version) FROM meta_dictionary)`
      )
      .all() as { table_name: string; natural_key: string }[];

    const out: Evaluation[] = [];
    for (const t of tables) {
      const key = (JSON.parse(t.natural_key) as string[]).filter((c) => c !== 'observed_at');
      if (key.length === 0) continue;
      const cols = [...key, 'source_response_id'].map((c) => `"${c}"`).join(', ');
      const dupes = ctx.db
        .prepare(
          `SELECT COUNT(*) AS n FROM (
             SELECT ${cols} FROM "${t.table_name}" WHERE run_id = ?
             GROUP BY ${cols} HAVING COUNT(*) > 1)`
        )
        .get(ctx.runId) as { n: number };
      out.push({
        key: t.table_name,
        fired: dupes.n > 0,
        detail: dupes.n > 0 ? `${dupes.n} duplicate natural key(s) in ${t.table_name} within one response` : undefined,
        evidence: { table: t.table_name, duplicateKeys: dupes.n }
      });
    }
    return out;
  }
};

export const QC010_LEGACY_HANDOFF_PARSED: CheckDefinition = {
  id: 'QC-010',
  domain: 'cross_cutting',
  severity: 'warning',
  description:
    'A legacy brief hand-off that arrived was ingested. The hand-off is the existing app\'s only ' +
    'contact with the collector and it feeds chain-subset admission — a `recommended_by_legacy` ' +
    'member is admitted by reading `legacy_brief_candidate`. It failed on every attempt from the ' +
    'day the contract shipped (a vocabulary mismatch on `mode`), wrote zero rows each time, and ' +
    'nothing said so: the hand-off runs as a MANUAL run, and a manual run is not gate-evaluated. ' +
    '**Warning, not blocking**: a day the brief did not run is not a collector fault, and the ' +
    'check is silent when no hand-off was attempted — "none arrived" and "one arrived broken" are ' +
    'different facts and must not look alike.',
  readsTables: ['meta_response'],
  testedQuantity: null,
  testedUnit: null,
  thresholds: {},
  thresholdBasis: 'not_applicable',
  run(ctx) {
    // Every hand-off for this trading date, not only this run's: the hand-off
    // lands in its own manual run, so scoping to `run_id` would evaluate nothing
    // on the daily run that actually reaches the gate.
    const handoffs = ctx.db
      .prepare(
        `SELECT r.source_response_id, r.parse_status, r.parsed_row_count, r.parse_error
           FROM meta_response r JOIN meta_run n ON n.run_id = r.run_id
          WHERE r.endpoint = 'legacy/brief-handoff' AND n.trading_date = ?`
      )
      .all(ctx.tradingDate) as {
      source_response_id: number;
      parse_status: string;
      parsed_row_count: number | null;
      parse_error: string | null;
    }[];

    if (handoffs.length === 0) return [];

    return handoffs.map((h) => ({
      key: String(h.source_response_id),
      fired: h.parse_status !== 'ok',
      detail:
        h.parse_status === 'ok'
          ? undefined
          : `the brief hand-off did not ingest (${h.parse_status}): ${h.parse_error ?? 'no reason recorded'}`,
      evidence: {
        sourceResponseId: h.source_response_id,
        parseStatus: h.parse_status,
        parsedRowCount: h.parsed_row_count,
        parseError: h.parse_error
      }
    }));
  }
};

export const CROSS_CUTTING_CHECKS: readonly CheckDefinition[] = [
  QC001_PROVENANCE,
  QC004_NULL_DISCIPLINE,
  QC008_PROVIDER_CAP,
  QC009_DUPLICATE_NATURAL_KEY,
  QC010_LEGACY_HANDOFF_PARSED
];
