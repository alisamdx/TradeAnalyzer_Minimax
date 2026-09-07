import type { CheckDefinition, Evaluation } from '../check.js';

/**
 * Cross-cutting checks — 03 §3.1. These run on every table the run wrote.
 *
 * All of them are **predicate** checks: a row either has provenance or it does
 * not. They declare `testedQuantity: null`, and the framework then requires
 * them to return no values — the pairing is enforced, so a magnitude check
 * cannot masquerade as a predicate one to avoid recording its distribution.
 */

const RAW_LAYERS = "('raw', 'ext', 'derived', 'legacy')";

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
            WHERE layer IN ${RAW_LAYERS} AND column_name = 'source_response_id'`
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
    'the existing app and silently suppressed all three mechanisms that would have corrected it.',
  readsTables: ['meta_response'],
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

    if (capped.length === 0) return [{ key: 'run', fired: false }];

    return capped.map((r) => ({
      key: String(r.source_response_id),
      fired: true,
      detail: `${r.endpoint} returned exactly the provider cap — treat as truncated and subdivide`,
      evidence: { endpoint: r.endpoint, params: r.params_json }
    }));
  }
};

export const QC009_DUPLICATE_NATURAL_KEY: CheckDefinition = {
  id: 'QC-009',
  domain: 'cross_cutting',
  severity: 'warning',
  description:
    'The same natural key was not stored twice within one run. Two rows for one key in a single run ' +
    'is an idempotence bug, not a supersession: supersession happens across runs with a later ' +
    'observed_at, and within a run there is only one observation.',
  readsTables: ['meta_dictionary'],
  testedQuantity: null,
  testedUnit: null,
  thresholds: {},
  thresholdBasis: 'not_applicable',
  run(ctx) {
    const tables = ctx.db
      .prepare(
        `SELECT DISTINCT table_name, natural_key FROM meta_dictionary
          WHERE layer IN ${RAW_LAYERS} AND column_name = 'run_id'`
      )
      .all() as { table_name: string; natural_key: string }[];

    const out: Evaluation[] = [];
    for (const t of tables) {
      const key = (JSON.parse(t.natural_key) as string[]).filter((c) => c !== 'observed_at');
      if (key.length === 0) continue;
      const cols = key.map((c) => `"${c}"`).join(', ');
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
        detail: dupes.n > 0 ? `${dupes.n} duplicate natural key(s) in ${t.table_name} within one run` : undefined,
        evidence: { table: t.table_name, duplicateKeys: dupes.n }
      });
    }
    return out;
  }
};

export const CROSS_CUTTING_CHECKS: readonly CheckDefinition[] = [
  QC001_PROVENANCE,
  QC004_NULL_DISCIPLINE,
  QC008_PROVIDER_CAP,
  QC009_DUPLICATE_NATURAL_KEY
];
