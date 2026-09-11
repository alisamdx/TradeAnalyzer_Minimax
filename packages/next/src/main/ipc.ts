import { ipcMain } from 'electron';
import { unverifiedColumns } from '@tradeanalyzer/core';
import { currentGeneration, openGeneration, resetCurrentGeneration } from './generation.js';
import { columns, query, stats, tables, tree, type QueryRequest } from './inspect.js';
import { chainDates, chainExpirations, chainGrid, chainTickers, contractHistory } from './chains.js';
import { balances, orders, positions, snapshotDates } from './account.js';
import { earningsAnomalies, earningsMonth, earningsMonths, earningsTrail } from './earnings.js';
import { ivSeries, ivTickers } from './iv.js';
import { legacyCandidates, legacyRuns, legacySummary } from './legacy.js';
import {
  acceptException,
  acknowledgeException,
  bulkAcknowledgeExceptions,
  exceptionDetail,
  listExceptions,
  recordReuse,
  resolveException,
  zeroFireChecks
} from './exceptions.js';
import { listRuns, runDetail } from './runs.js';
import { cancelRequest, jobsOverview, previewReset, queueOneShot } from './jobs.js';
import { takePendingLink } from './deeplinks.js';
import type { ExceptionFilterDto, IpcResult, QueryRequestDto } from '../shared/types.js';

/**
 * IPC handlers — 05 §9.
 *
 * Every method returns an `IpcResult`. A thrown error crossing the bridge
 * arrives at the renderer as an opaque string with the stack mangled, so a
 * failure is returned as **data** and the UI can say what actually went wrong
 * rather than showing a spinner forever (P9).
 *
 * That matters most for the operator actions added at B9a: a refused
 * resolution is not an error to hide but the answer to show — "still firing,
 * accept it instead" is the explanation the operator needs, and it arrives
 * here as `core`'s own `OperatorActionRefused` message.
 */

function handle<T>(channel: string, fn: (...args: never[]) => T): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<IpcResult<Awaited<T>>> => {
    try {
      return { ok: true, data: (await fn(...(args as never[]))) as Awaited<T> };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

export function registerIpc(): void {
  handle('generation:current', () => {
    try {
      return currentGeneration();
    } catch {
      return openGeneration();
    }
  });

  handle('dictionary:tables', () => tables());
  handle('dictionary:tree', () => tree());
  handle('dictionary:columns', (table: string) => columns(table));
  handle('dictionary:stats', (table: string) => stats(table));
  handle('dictionary:unverified', () => unverifiedColumns());

  handle('inspect:query', (req: QueryRequestDto) => query(req as QueryRequest));

  handle('chains:dates', () => chainDates());
  handle('chains:tickers', (asOfDate: string) => chainTickers(asOfDate));
  handle('chains:expirations', (ticker: string, asOfDate: string) => chainExpirations(ticker, asOfDate));
  handle('chains:grid', (ticker: string, asOfDate: string, expiration: string) =>
    chainGrid(ticker, asOfDate, expiration)
  );
  handle('chains:contract-history', (osiSymbol: string) => contractHistory(osiSymbol));

  handle('account:snapshot-dates', () => snapshotDates());
  handle('account:positions', (asOfDate: string) => positions(asOfDate));
  handle('account:orders', (limit?: number) => orders(limit));
  handle('account:balances', () => balances());

  handle('earnings:months', () => earningsMonths());
  handle('earnings:month', (month: string) => earningsMonth(month));
  handle('earnings:trail', (ticker: string) => earningsTrail(ticker));
  handle('earnings:anomalies', () => earningsAnomalies());
  handle('iv:tickers', () => ivTickers());
  handle('iv:series', (ticker: string) => ivSeries(ticker));
  handle('legacy:summary', () => legacySummary());
  handle('legacy:runs', () => legacyRuns());
  handle('legacy:candidates', (runId: string) => legacyCandidates(runId));

  // ── B9a: the operator surface (05 §5, §7) ─────────────────────────────────
  handle('exceptions:list', (filter: ExceptionFilterDto) => listExceptions(filter ?? {}));
  handle('exceptions:detail', (id: number) => exceptionDetail(id));
  handle('exceptions:acknowledge', (id: number, note: string | null) => acknowledgeException(id, note));
  handle('exceptions:bulk-acknowledge', (ids: readonly number[], note: string | null) =>
    bulkAcknowledgeExceptions(ids, note)
  );
  handle('exceptions:resolve', (id: number, how: string, note: string) => resolveException(id, how, note));
  handle('exceptions:accept', (id: number, note: string, until: string | null) => acceptException(id, note, until));
  handle('exceptions:record-reuse', (id: number, ticker: string, spliceDate: string | null, note: string) =>
    recordReuse(id, ticker, spliceDate, note)
  );
  handle('exceptions:zero-fire', () => zeroFireChecks());

  handle('runs:list', () => listRuns());
  handle('runs:detail', (runId: number) => runDetail(runId));

  handle('jobs:overview', () => jobsOverview());
  handle('jobs:queue', (kind: string, params: unknown) => queueOneShot(kind, params));
  handle('jobs:cancel', (requestId: number) => cancelRequest(requestId));
  handle('jobs:reset-preview', () => previewReset());
  handle('jobs:reset', (reason: string, confirmation: string) => resetCurrentGeneration(reason, confirmation));

  handle('deeplink:initial', () => takePendingLink());
}
