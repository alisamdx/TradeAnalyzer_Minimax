import { openPins, pinForStudy, unpinStudy, type ArchivingOperatorHost } from '@tradeanalyzer/core';
import { currentDb, currentGeneration } from './generation.js';
import { operatorHost } from './operator.js';
import type { PinDto } from '../shared/types.js';

/**
 * Pin for study — 05 §4.2, B9c.
 *
 * The one place this application writes to the response archive: the operator's
 * pin request is archived as a `host_app` response so the sticky row can name
 * what caused it (see `core`'s `study-pin.ts`). It goes to its own file
 * (`archive/host_app/<date>/operator-study-pin.jsonl.gz`), which the collector
 * host never appends to, so the two processes never share an archive file.
 */

function archivingHost(): ArchivingOperatorHost {
  return {
    ...operatorHost(),
    archiveRoot: () => currentGeneration().archivePath,
    encryptForArchive: () => {
      // Only account-domain slugs are encrypted, and an operator request is not
      // one. Refusing beats writing with a key this app does not share with the
      // collector host — a line nobody could ever read back.
      throw new Error('TradeAnalyzer 2 never writes account-domain archive lines.');
    }
  };
}

export function pinsFor(osiSymbol: string): readonly PinDto[] {
  return openPins(currentDb() as never, osiSymbol).map((p) => ({
    pinnedFor: p.reason,
    since: p.validFrom,
    origin: p.originRef
  }));
}

export function pin(osiSymbol: string, note: string): PinDto {
  const p = pinForStudy(currentDb() as never, archivingHost(), { osiSymbol, note });
  return { pinnedFor: p.reason, since: p.validFrom, origin: p.originRef };
}

export function unpin(osiSymbol: string, note: string): void {
  unpinStudy(currentDb() as never, archivingHost(), { osiSymbol, note });
}
