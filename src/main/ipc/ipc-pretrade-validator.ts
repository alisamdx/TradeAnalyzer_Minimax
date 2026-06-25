// IPC handlers for the Pre-Trade Validator (Payoff view). Decision-support only.
// see Requirements/PRE_TRADE_VALIDATOR_SPEC.md

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { Database } from 'better-sqlite3';
import { PretradeValidatorService } from '../services/pretrade-validator-service.js';
import type { DataProvider } from '../services/data-provider.js';
import type { OptionsProvider } from '../services/options-provider.js';
import type {
  IpcResult, PretradeValidateInput, PretradeValidationResult, PretradeValidationRow,
} from '@shared/types.js';

function ok<T>(value: T): IpcResult<T> { return { ok: true, value }; }
function fail(err: unknown): IpcResult<never> {
  return { ok: false, error: { code: 'PRETRADE_ERROR', message: err instanceof Error ? err.message : String(err) } };
}
function wrapAsync<Args extends unknown[], R>(fn: (...args: Args) => Promise<R> | R) {
  return async (_e: IpcMainInvokeEvent, ...args: Args): Promise<IpcResult<R>> => {
    try { return ok(await fn(...args)); } catch (err) { return fail(err); }
  };
}

export function registerPretradeValidatorIpc(
  db: Database,
  dataProvider: DataProvider,
  optionsProvider: OptionsProvider,
): void {
  const svc = new PretradeValidatorService(dataProvider, optionsProvider);

  ipcMain.handle(
    'pretradeValidator:validate',
    wrapAsync((input: PretradeValidateInput): Promise<PretradeValidationResult> => svc.validate(db, input)),
  );

  ipcMain.handle(
    'pretradeValidator:history',
    wrapAsync((limit?: number): PretradeValidationRow[] => svc.getHistory(db, limit ?? 50)),
  );
}
