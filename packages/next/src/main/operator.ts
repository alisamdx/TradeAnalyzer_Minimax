import { app } from 'electron';
import { etTimestamp, type OperatorHost } from '@tradeanalyzer/core';

/**
 * Who the operator is, as far as the audit tables are concerned.
 *
 * Every write from the workbench records an actor (05 §9): `qa_exception_event`
 * stamps `operator` itself, and `meta_job_request.requested_by` takes this
 * name and version, so a queued request always says which build asked for it.
 * The clock is `core`'s ET builder — never `toISOString()`, which is a day out
 * every evening and once put a UTC stamp into a forensic record beside an ET one.
 */
export function operatorHost(): OperatorHost {
  return {
    nowET: () => etTimestamp(),
    hostApp: { name: 'TradeAnalyzer 2', version: app.getVersion() }
  };
}
