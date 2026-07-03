// Filters Prefill batch job — precomputes every filter template over Universe = All
// (S&P 500 + Russell 1000 + ETFs) and stores the results in filter_template_runs so
// FiltersView shows populated lists instantly instead of requiring a manual scan.
//
// Runs at the END of the evening chain (afterCloseOnly — skipped in the lean intraday
// slot) so quote/fundamentals caches, iv_history, technical_signals, and the earnings
// calendar are all fresh. Wheel (Vetted) and Assignment Risk fetch live E*Trade option
// chains for their survivors, so this job is deliberately last — it is the slowest link.
//
// Each template's stored run is overwritten wholesale (latest-only). A template that
// errors is recorded and the loop continues — one bad scan must not starve the others.

import type { BatchJobHandler, BatchJobResult } from '../batch-service.js';
import type { BatchProgressEvent } from '@shared/types.js';
import { FILTER_TEMPLATES } from '@shared/filter-templates.js';
import type { FilterTemplatesService } from '../filter-templates-service.js';

const PREFILL_UNIVERSE = 'all' as const;

export class FiltersPrefillJob implements BatchJobHandler {
  readonly name = 'Filters Prefill';
  readonly description =
    'Precompute all filter templates over Universe = All (S&P + Russell + ETFs) so the Filters view opens pre-populated.';

  constructor(private readonly service: FilterTemplatesService) {}

  async run(
    onProgress: (evt: BatchProgressEvent) => void,
    signal: AbortSignal,
  ): Promise<BatchJobResult> {
    const templates = FILTER_TEMPLATES;
    const total = templates.length;
    let saved = 0;
    let failed = 0;
    let totalMatches = 0;
    const failures: string[] = [];

    const emit = (message: string, ticker = '', status: BatchProgressEvent['status'] = 'updated') => {
      onProgress({
        jobId: 'filters-prefill', runId: 0, ticker, status,
        attempted: saved + failed, updated: saved, skipped: 0, failed, total, message,
      });
    };

    for (let i = 0; i < total; i++) {
      if (signal.aborted) break;
      const tpl = templates[i]!;
      const step = `[${i + 1}/${total}] ${tpl.label}`;
      emit(`${step} — scanning…`);

      try {
        const results = await this.service.runTemplate(
          tpl.id, 'universe', PREFILL_UNIVERSE, undefined,
          (p) => {
            // Throttle: one renderer event per 25 tickers is plenty for a ~1,600-name scan.
            if (p.current % 25 === 0 || p.current === p.total) {
              emit(`${step} — ${p.ticker} (${p.current}/${p.total})`, p.ticker);
            }
          },
          signal,
        );
        // An aborted scan returns partial results — never overwrite a full stored run with them.
        if (signal.aborted) break;
        this.service.saveRun(tpl.id, PREFILL_UNIVERSE, results);
        saved++;
        totalMatches += results.length;
        emit(`${step} — ${results.length} match${results.length !== 1 ? 'es' : ''} stored`);
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`${tpl.label}: ${msg}`);
        emit(`${step} — FAILED: ${msg}`, '', 'failed');
      }
    }

    if (saved === 0 && failed > 0) {
      return {
        status: 'failed',
        errorMessage: `All ${failed} filter scans failed — ${failures[0]}`,
        tickersAttempted: total, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: failed,
      };
    }

    return {
      status: 'success',
      notes: `${saved}/${total} filters precomputed · ${totalMatches} total matches`
        + (failures.length > 0 ? ` · failed: ${failures.join('; ')}` : ''),
      tickersAttempted: saved + failed,
      tickersUpdated: saved,
      tickersSkipped: total - saved - failed,
      tickersFailed: failed,
    };
  }
}
