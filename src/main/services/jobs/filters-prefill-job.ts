// Filters Prefill batch job — precomputes every filter template over Universe = All
// (S&P 500 + Russell 1000 + ETFs) and stores the results in filter_template_runs so
// FiltersView shows populated lists instantly instead of requiring a manual scan.
//
// Runs at the END of the evening chain (afterCloseOnly — skipped in the lean intraday
// slot) so quote/fundamentals caches, iv_history, technical_signals, and the earnings
// calendar are all fresh. Wheel (Vetted), IV High (Vetted), and Assignment Risk fetch
// live E*Trade option chains for their survivors, so this job is deliberately last —
// it is the slowest link.
//
// Each template's stored run is overwritten wholesale (latest-only). A template that
// errors is recorded and the loop continues — one bad scan must not starve the others.

import type { BatchJobHandler, BatchJobResult } from '../batch-service.js';
import type { BatchProgressEvent, FilterTemplateResult } from '@shared/types.js';
import { FILTER_TEMPLATES } from '@shared/filter-templates.js';
import type { FilterTemplatesService } from '../filter-templates-service.js';
import type { DbHandle } from '../../db/connection.js';
import type { EmailService } from '../email-service.js';
import { buildFiltersPrefillEmailHtml, topIvHigh, sortWheelVetted } from '../filters-prefill-report-builder.js';

// Email caps the IV High list to the top-N by IV Rank — a universe=all scan can match
// hundreds of tickers, and the point of the email is a short actionable list, not a dump.
const IV_HIGH_EMAIL_TOP_N = 10;

const PREFILL_UNIVERSE = 'all' as const;
const JOB_ID = 'filters-prefill';

// Templates the batch precomputes by default. The heavy/unused ones (RSI Overbought,
// IV Low, Assignment Risk, Wheel Opportunity) are omitted to save run time — override
// via batch_jobs.config_json.enabledTemplates (an explicit template-id allowlist).
// iv_rank_high_vetted (v1.1.120) applies Wheel (Vetted)'s downtrend/earnings/liquidity/
// IV-ceiling gates to the IV-High signal — the summary email's IV High list is sourced
// from it, not the loose iv_rank_high (which stays prefilled too, for browsing).
export const DEFAULT_PREFILL_TEMPLATES = [
  'rsi_oversold',
  'iv_rank_high',
  'iv_rank_high_vetted',
  'price_alert',
  'wheel_vetted',
];

export class FiltersPrefillJob implements BatchJobHandler {
  readonly name = 'Filters Prefill';
  readonly description =
    'Precompute filter templates over Universe = All (S&P + Russell + ETFs) so the Filters view opens pre-populated. '
    + 'Which templates run is configurable (config_json.enabledTemplates); defaults skip the ones not in regular use.';

  constructor(
    private readonly service: FilterTemplatesService,
    private readonly db: DbHandle,
    private readonly emailService: EmailService | null = null,
  ) {}

  /** Template-id allowlist from config, falling back to DEFAULT_PREFILL_TEMPLATES. */
  private enabledTemplateIds(): string[] {
    try {
      const row = this.db.prepare(`SELECT config_json FROM batch_jobs WHERE id = ?`).get(JOB_ID) as
        { config_json: string | null } | undefined;
      if (row?.config_json) {
        const cfg = JSON.parse(row.config_json) as Record<string, unknown>;
        const list = cfg['enabledTemplates'];
        if (Array.isArray(list) && list.every(x => typeof x === 'string')) {
          return list as string[];
        }
      }
    } catch { /* fall through to defaults */ }
    return DEFAULT_PREFILL_TEMPLATES;
  }

  async run(
    onProgress: (evt: BatchProgressEvent) => void,
    signal: AbortSignal,
  ): Promise<BatchJobResult> {
    const enabled = new Set(this.enabledTemplateIds());
    const templates = FILTER_TEMPLATES.filter(t => enabled.has(t.id));
    const total = templates.length;
    if (total === 0) {
      return {
        status: 'skipped',
        notes: 'No filter templates enabled for prefill (config_json.enabledTemplates is empty).',
        tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0,
      };
    }
    let saved = 0;
    let failed = 0;
    let totalMatches = 0;
    const failures: string[] = [];
    // Captured for the summary email below — null means the template didn't run this pass
    // (not enabled, or the scan failed), distinct from an empty (but attempted) result set.
    // The email's IV High list is sourced from the VETTED template (downtrend/earnings/
    // liquidity/IV-ceiling gates applied), not the loose iv_rank_high.
    let ivHighVettedResults: FilterTemplateResult[] | null = null;
    let wheelVettedResults: FilterTemplateResult[] | null = null;

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
        if (tpl.id === 'iv_rank_high_vetted') ivHighVettedResults = results;
        if (tpl.id === 'wheel_vetted') wheelVettedResults = results;
        emit(`${step} — ${results.length} match${results.length !== 1 ? 'es' : ''} stored`);
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`${tpl.label}: ${msg}`);
        emit(`${step} — FAILED: ${msg}`, '', 'failed');
      }
    }

    // Summary email — top-10 IV High (Vetted) (ranked, not the full match list) + every
    // Wheel (Vetted) pick (already a small, gated funnel). Only sent when at least one of
    // the two templates actually ran this pass; email failure never fails the job.
    if (this.emailService?.isConfigured() && (ivHighVettedResults !== null || wheelVettedResults !== null)) {
      try {
        const todayEt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        const ivTop = topIvHigh(ivHighVettedResults ?? [], IV_HIGH_EMAIL_TOP_N);
        const wheelSorted = sortWheelVetted(wheelVettedResults ?? []);
        const html = buildFiltersPrefillEmailHtml(
          todayEt,
          { top: ivTop, totalScanned: ivHighVettedResults?.length ?? 0 },
          wheelSorted,
        );
        const subject = `Filters Prefill — ${new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} — `
          + `${ivTop.length} IV High · ${wheelSorted.length} Wheel (Vetted)`;
        await this.emailService.send(subject, html);
      } catch (emailErr) {
        console.warn('[filters-prefill] email send failed:', emailErr instanceof Error ? emailErr.message : String(emailErr));
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
