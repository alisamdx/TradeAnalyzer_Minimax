import { ipcMain } from 'electron';
import { unverifiedColumns } from '@tradeanalyzer/core';
import {
  attachReadOnlyWindow,
  currentGeneration,
  detachReadOnlyWindow,
  isReadOnlyContext,
  listGenerations,
  openGeneration,
  openReadOnlyGeneration,
  resetCurrentGeneration,
  runInWindowContext
} from './generation.js';
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
import { questionsFor, retireSavedQuestion, saveQuestionAs } from './questions.js';
import { pin, pinsFor, unpin } from './study.js';
import { inspect, neverFired, pilotStatus, promote, rule, thresholds } from './pilot.js';
import { takePendingLink } from './deeplinks.js';
import { openWindow } from './window-factory.js';
import type {
  ExceptionFilterDto, IpcResult, PilotListDto, QueryRequestDto, QuestionDefinitionDto
} from '../shared/types.js';

/**
 * IPC handlers — 05 §9.
 *
 * Every method returns an `IpcResult`. A thrown error crossing the bridge
 * arrives at the renderer as an opaque string with the stack mangled, so a
 * failure is returned as **data** and the UI can say what actually went wrong
 * rather than showing a spinner forever (P9).
 *
 * That matters most for the operator actions: a refused resolution is not an
 * error to hide but the answer to show — "still firing, accept it instead" is
 * the explanation the operator needs, and it arrives here as `core`'s own
 * `OperatorActionRefused` message.
 *
 * **Every call runs in the calling window's generation** (B9c). A window showing
 * a closed generation read-only gets answers from that file, and every write
 * channel refuses there — before any code that could write is reached, and with
 * SQLite's own read-only refusal behind it.
 */

function handle<T>(channel: string, fn: (...args: never[]) => T): void {
  ipcMain.handle(channel, async (event, ...args): Promise<IpcResult<Awaited<T>>> => {
    try {
      const data = runInWindowContext(event.sender.id, () => fn(...(args as never[])));
      return { ok: true, data: (await data) as Awaited<T> };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** A channel that changes stored state. Refused in a read-only window. */
function handleWrite<T>(channel: string, fn: (...args: never[]) => T): void {
  handle(channel, (...args: never[]) => {
    if (isReadOnlyContext()) {
      const g = currentGeneration();
      throw new Error(
        `This window shows gen-${String(g.generationNo).padStart(3, '0')}, a ${g.status} generation opened read-only. ` +
          'Nothing in it can be changed from here.'
      );
    }
    return fn(...args);
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
  handle('generation:list', () =>
    listGenerations().map((g) => ({
      generationNo: g.generationNo,
      dir: g.dir,
      current: g.current,
      dbPresent: g.dbPresent,
      walPresent: g.walPresent,
      status: g.status,
      openedAt: g.openedAt,
      closedAt: g.closedAt,
      predecessorNo: g.predecessorNo,
      resetReason: g.resetReason,
      problem: g.problem
    }))
  );
  // Opening a window changes nothing stored, so it is not a write channel.
  handle('generation:open-readonly', (generationNo: number) => {
    const ctx = openReadOnlyGeneration(generationNo);
    let window;
    try {
      window = openWindow({ readOnlyGeneration: generationNo });
    } catch (err) {
      ctx.db.close();
      throw err;
    }
    // Attached before the window's renderer can make its first call: the load
    // is asynchronous, this line is not.
    const id = window.webContents.id;
    attachReadOnlyWindow(id, ctx);
    window.on('closed', () => detachReadOnlyWindow(id));
    return ctx.info;
  });

  handle('dictionary:tables', () => tables());
  handle('dictionary:tree', () => tree());
  handle('dictionary:columns', (table: string) => columns(table));
  handle('dictionary:stats', (table: string) => stats(table));
  handle('dictionary:unverified', () => unverifiedColumns());

  handle('inspect:query', (req: QueryRequestDto) => query(req as QueryRequest));

  handle('questions:list', (table: string | null) => questionsFor(table));
  handleWrite('questions:save', (name: string, table: string, definition: QuestionDefinitionDto, note: string | null) =>
    saveQuestionAs(name, table, definition, note)
  );
  handleWrite('questions:retire', (id: number) => retireSavedQuestion(id));

  handle('chains:dates', () => chainDates());
  handle('chains:tickers', (asOfDate: string) => chainTickers(asOfDate));
  handle('chains:expirations', (ticker: string, asOfDate: string) => chainExpirations(ticker, asOfDate));
  handle('chains:grid', (ticker: string, asOfDate: string, expiration: string) =>
    chainGrid(ticker, asOfDate, expiration)
  );
  handle('chains:contract-history', (osiSymbol: string) => contractHistory(osiSymbol));
  handle('chains:pins', (osiSymbol: string) => pinsFor(osiSymbol));
  handleWrite('chains:pin', (osiSymbol: string, note: string) => pin(osiSymbol, note));
  handleWrite('chains:unpin', (osiSymbol: string, note: string) => unpin(osiSymbol, note));

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

  // ── the operator surface (05 §5, §7) ─────────────────────────────────────
  handle('exceptions:list', (filter: ExceptionFilterDto) => listExceptions(filter ?? {}));
  handle('exceptions:detail', (id: number) => exceptionDetail(id));
  handleWrite('exceptions:acknowledge', (id: number, note: string | null) => acknowledgeException(id, note));
  handleWrite('exceptions:bulk-acknowledge', (ids: readonly number[], note: string | null) =>
    bulkAcknowledgeExceptions(ids, note)
  );
  handleWrite('exceptions:resolve', (id: number, how: string, note: string) => resolveException(id, how, note));
  handleWrite('exceptions:accept', (id: number, note: string, until: string | null) => acceptException(id, note, until));
  handleWrite('exceptions:record-reuse', (id: number, ticker: string, spliceDate: string | null, note: string) =>
    recordReuse(id, ticker, spliceDate, note)
  );
  handle('exceptions:zero-fire', () => zeroFireChecks());

  handle('runs:list', () => listRuns());
  handle('runs:detail', (runId: number) => runDetail(runId));

  handle('jobs:overview', () => jobsOverview());
  handleWrite('jobs:queue', (kind: string, params: unknown) => queueOneShot(kind, params));
  handleWrite('jobs:cancel', (requestId: number) => cancelRequest(requestId));
  handle('jobs:reset-preview', () => previewReset());
  handleWrite('jobs:reset', (reason: string, confirmation: string) => resetCurrentGeneration(reason, confirmation));

  // ── pilot exit (03 §8, 05 §6) ────────────────────────────────────────────
  handle('pilot:status', () => pilotStatus());
  handle('pilot:never-fired', () => neverFired());
  handle('pilot:thresholds', () => thresholds());
  handleWrite('pilot:rule', (list: PilotListDto, checkId: string, choice: string, note: string, proposed: number | null) =>
    rule(list, checkId, choice, note, proposed)
  );
  handleWrite('pilot:inspect', (domain: string, note: string | null) => inspect(domain, note));
  handleWrite('pilot:promote', (confirmation: string) => promote(confirmation));

  handle('deeplink:initial', () => takePendingLink());
}
