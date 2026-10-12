import type { SqliteLike } from '../db/sqlite-like.js';
import type { CollectorHost } from './host.js';

/**
 * `ref_provider_symbol_ruling` — the operator's standing answer to "the
 * provider answered for a different symbol than we asked; is that the same
 * issuer?".
 *
 * **Seeded here, before it is read**, for the reason `ref_trading_day` and
 * `ref_macro_series` are: a reference table that exists only if somebody
 * remembered to seed it is one that will be missing on the day it matters.
 *
 * Failing open is deliberate and is the opposite choice from the calendar's.
 * An **unruled** mismatch is still stored and still reported by QC-909, because
 * dropping a row on no evidence would hide a feed gap behind silence, and the
 * whole point of QC-909 is that the decision is visible while it is pending.
 * Only a `different_issuer` ruling stops a write.
 */

export interface SymbolRulingSeed {
  readonly provider: string;
  readonly askedTicker: string;
  readonly answeredSymbol: string;
  readonly decision: 'same_issuer' | 'different_issuer';
  readonly note: string;
}

/**
 * The seven Finnhub aliases QC-909 raised on 2026-09-21, ruled by the operator
 * on 2026-09-22, and two more share-class rulings from 2026-10-12 (HEI.A, FWONK).
 *
 * Five are other listings of one company and their counts are the company's, so
 * they are kept. **FWONA is not** — Liberty Media Formula One, answered for
 * both Liberty Live Group share classes, with identical counts for two tickers
 * that are not it. Those are refused, which leaves LLYVA and LLYVK reading as
 * having no analyst coverage. That is the true statement; the alternative is
 * two tickers silently carrying a third company's ratings.
 *
 * These are seeded rather than typed into the workbench because that is how the
 * decision reached the system, and every one names the date it was made. A
 * later ruling is the operator's to make in TradeAnalyzer 2 and the seed never
 * overwrites a row that exists — the same rule `ref_trading_day` uses for the
 * one closure no generator can produce.
 */
export const DEFAULT_SYMBOL_RULINGS: readonly SymbolRulingSeed[] = [
  { provider: 'finnhub', askedTicker: 'GOOG', answeredSymbol: 'GOOGL', decision: 'same_issuer', note: 'Alphabet class C and class A — one company (operator ruling 2026-09-22).' },
  { provider: 'finnhub', askedTicker: 'BRK.B', answeredSymbol: 'BRK.A', decision: 'same_issuer', note: 'Berkshire Hathaway class B and class A — one company (operator ruling 2026-09-22).' },
  { provider: 'finnhub', askedTicker: 'NWS', answeredSymbol: 'NWSA', decision: 'same_issuer', note: 'News Corp class B and class A — one company (operator ruling 2026-09-22).' },
  { provider: 'finnhub', askedTicker: 'GFL', answeredSymbol: 'GFL.TO', decision: 'same_issuer', note: 'GFL Environmental, Toronto listing of the same company (operator ruling 2026-09-22).' },
  { provider: 'finnhub', askedTicker: 'JHX', answeredSymbol: 'JHX.AX', decision: 'same_issuer', note: 'James Hardie, Australian listing of the same company (operator ruling 2026-09-22).' },
  { provider: 'finnhub', askedTicker: 'LLYVA', answeredSymbol: 'FWONA', decision: 'different_issuer', note: 'FWONA is Liberty Media Formula One, not Liberty Live Group — a different company (operator ruling 2026-09-22).' },
  { provider: 'finnhub', askedTicker: 'LLYVK', answeredSymbol: 'FWONA', decision: 'different_issuer', note: 'FWONA is Liberty Media Formula One, not Liberty Live Group — a different company (operator ruling 2026-09-22).' },
  // 2026-10-12 (v1.1.349). HEI.A is QC-909's open finding (Finnhub answered for HEI since 10-06).
  // FWONK is for QC-603: Finnhub dates FWONA (11-03) and never FWONK, the same Liberty Formula One
  // tracking stock in its Series C form. QC-603 reads a same_issuer sibling's date (v1.1.321).
  { provider: 'finnhub', askedTicker: 'HEI.A', answeredSymbol: 'HEI', decision: 'same_issuer', note: 'HEICO Class A and common — one company (operator ruling 2026-10-12).' },
  { provider: 'finnhub', askedTicker: 'FWONK', answeredSymbol: 'FWONA', decision: 'same_issuer', note: 'Liberty Media Formula One Series C and Series A — one tracking stock, one report (operator ruling 2026-10-12).' }
];

export interface SymbolRulingSeedResult {
  readonly inserted: number;
  readonly present: number;
}

/**
 * Idempotent: inserts a ruling that is absent and never touches one that is
 * there, so an operator who changes their mind in the workbench keeps that
 * change across runs.
 */
export function ensureSymbolRulings(
  db: SqliteLike,
  host: CollectorHost,
  rulings: readonly SymbolRulingSeed[] = DEFAULT_SYMBOL_RULINGS
): SymbolRulingSeedResult {
  const exists = db.prepare(
    'SELECT 1 AS present FROM ref_provider_symbol_ruling WHERE provider = ? AND asked_ticker = ? AND answered_symbol = ?'
  );
  const insert = db.prepare(
    `INSERT INTO ref_provider_symbol_ruling
       (provider, asked_ticker, answered_symbol, decision, note, ruled_at, ruled_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const now = host.nowET();
  let inserted = 0;

  const write = db.transaction(() => {
    for (const r of rulings) {
      if (exists.get(r.provider, r.askedTicker, r.answeredSymbol) !== undefined) continue;
      insert.run(r.provider, r.askedTicker, r.answeredSymbol, r.decision, r.note, now, 'operator');
      inserted += 1;
    }
  });
  write();

  const present = (
    db.prepare('SELECT COUNT(*) AS n FROM ref_provider_symbol_ruling').get() as { n: number }
  ).n;
  return { inserted, present };
}

/** What an ingest must refuse, as `provider|askedTicker` → the answered symbols it may not accept. */
export type SymbolRefusals = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * Read once per phase rather than per row: the table holds a handful of
 * operator rulings and a query per ticker would be a query per ticker.
 */
export function refusedSymbolAnswers(db: SqliteLike): SymbolRefusals {
  const rows = db
    .prepare(
      `SELECT provider, asked_ticker, answered_symbol FROM ref_provider_symbol_ruling
        WHERE decision = 'different_issuer'`
    )
    .all() as { provider: string; asked_ticker: string; answered_symbol: string }[];
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    const key = `${r.provider}|${r.asked_ticker}`;
    const set = out.get(key) ?? new Set<string>();
    set.add(r.answered_symbol);
    out.set(key, set);
  }
  return out;
}

/**
 * Returns `undefined` rather than an empty set when nothing is refused, so the
 * recipe omits the key entirely and a ticker with no ruling keeps its exact
 * digest — an empty array would still be an argument and would re-digest every
 * already-captured response.
 */
export function refusedFor(
  refusals: SymbolRefusals,
  provider: string,
  askedTicker: string
): ReadonlySet<string> | undefined {
  return refusals.get(`${provider}|${askedTicker}`);
}

/**
 * Spreads to `{}` when nothing is refused, so the key never reaches the recipe
 * as `undefined`. Under `exactOptionalPropertyTypes` an explicit undefined is
 * not the same as an absent key, and here that distinction is the one that
 * keeps every unruled ticker's digest unchanged.
 */
export function withRefusals(
  refusals: SymbolRefusals,
  askedTicker: string,
  provider = 'finnhub'
): { readonly refusedSymbols?: ReadonlySet<string> } {
  const set = refusedFor(refusals, provider, askedTicker);
  return set ? { refusedSymbols: set } : {};
}
