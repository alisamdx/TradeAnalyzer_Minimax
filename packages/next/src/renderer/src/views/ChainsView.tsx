import { useEffect, useState } from 'react';
import type {
  ChainGridDto,
  ContractHistoryDto,
  ExpirationOptionDto
} from '../../../shared/types.js';
import { renderCell } from './ViewCells.js';

/**
 * The Chains view — 05 §4.2.
 *
 * Calls on the left, puts on the right, strikes down the middle. Every column
 * arrives from the main process already labelled and unit-tagged, so this file
 * names none of them: adding a column to the grid is a change to the dictionary
 * and one line of the main-process pick list, never a change here.
 */

const REASON_LABEL: Readonly<Record<string, string>> = {
  within_max_dte: 'in window',
  extra_monthly: 'extra monthly',
  sticky_contract: 'sticky',
  outside: 'declined'
};

export function ChainsView() {
  const [dates, setDates] = useState<readonly string[]>([]);
  const [date, setDate] = useState<string | null>(null);
  const [tickers, setTickers] = useState<readonly string[]>([]);
  const [ticker, setTicker] = useState<string | null>(null);
  const [expirations, setExpirations] = useState<readonly ExpirationOptionDto[]>([]);
  const [expiration, setExpiration] = useState<string | null>(null);
  const [grid, setGrid] = useState<ChainGridDto | null>(null);
  const [history, setHistory] = useState<ContractHistoryDto | null>(null);

  useEffect(() => {
    void window.api.chains.dates().then((r) => {
      if (!r.ok) return;
      setDates(r.data);
      setDate(r.data[0] ?? null);
    });
  }, []);

  useEffect(() => {
    if (!date) return;
    void window.api.chains.tickers(date).then((r) => {
      if (!r.ok) return;
      setTickers(r.data);
      setTicker((t) => (t && r.data.includes(t) ? t : (r.data[0] ?? null)));
    });
  }, [date]);

  useEffect(() => {
    if (!date || !ticker) return;
    void window.api.chains.expirations(ticker, date).then((r) => {
      if (!r.ok) return;
      setExpirations(r.data);
      const captured = r.data.filter((e) => e.contractCount > 0);
      setExpiration((e) =>
        e && captured.some((c) => c.expirationDate === e) ? e : (captured[0]?.expirationDate ?? null)
      );
    });
  }, [date, ticker]);

  useEffect(() => {
    if (!date || !ticker || !expiration) { setGrid(null); return; }
    void window.api.chains.grid(ticker, date, expiration).then((r) => { if (r.ok) setGrid(r.data); });
  }, [date, ticker, expiration]);

  if (dates.length === 0) {
    return (
      <>
        <h1>Chains</h1>
        <p className="muted">
          No chain snapshots yet. The chain phase runs at the end of the daily collection; until it
          has run once there is nothing here to show, which is a different thing from an empty chain.
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Chains</h1>

      <div className="selectors">
        <label>
          <span>Date</span>
          <select value={date ?? ''} onChange={(e) => setDate(e.target.value)}>
            {dates.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        <label>
          <span>Ticker</span>
          <select value={ticker ?? ''} onChange={(e) => setTicker(e.target.value)}>
            {tickers.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
      </div>

      <div className="expiry-strip">
        {expirations.map((e) => (
          <button
            key={e.expirationDate}
            className={
              `expiry${e.expirationDate === expiration ? ' is-active' : ''}` +
              `${e.contractCount === 0 ? ' is-declined' : ''}`
            }
            disabled={e.contractCount === 0}
            onClick={() => setExpiration(e.expirationDate)}
            title={
              e.contractCount === 0
                ? `${e.expiryType} — ${REASON_LABEL[e.windowReason] ?? e.windowReason}; no chain was requested for it`
                : `${e.expiryType} — ${String(e.contractCount)} contracts`
            }
          >
            <span className="expiry-date">{e.expirationDate}</span>
            <span className="expiry-reason">{REASON_LABEL[e.windowReason] ?? e.windowReason}</span>
          </button>
        ))}
      </div>

      {grid && (
        <>
          <p className="muted">
            Underlying {grid.underlyingPrice ?? '—'} as the chain call reported it — the same number
            QC-407 compares against the Polygon snapshot.
          </p>
          <div className="grid-scroll">
            <table className="chain-grid">
              <thead>
                <tr>
                  <th colSpan={grid.columns.length} className="side-head">Calls</th>
                  <th className="strike-head">Strike</th>
                  <th colSpan={grid.columns.length} className="side-head">Puts</th>
                </tr>
                <tr>
                  {grid.columns.map((c) => <th key={`c-${c.key}`}>{c.label}</th>)}
                  <th />
                  {grid.columns.map((c) => <th key={`p-${c.key}`}>{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {grid.rows.map((row) => (
                  <tr key={row.strike} className={row.atm ? 'is-atm' : ''}>
                    {grid.columns.map((c, i) => (
                      <td
                        key={`c-${c.key}`}
                        className={row.call?.stickyReason ? 'is-sticky' : ''}
                        onClick={() => {
                          if (!row.call) return;
                          void window.api.chains
                            .contractHistory(row.call.osiSymbol)
                            .then((r) => { if (r.ok) setHistory(r.data); });
                        }}
                      >
                        {row.call ? renderCell(c, row.call.cells[i]!) : <span className="null-mark null-na">–</span>}
                      </td>
                    ))}
                    <th className="strike">
                      {row.strike}
                      {(row.call?.stickyReason ?? row.put?.stickyReason) && (
                        <span className="pin" title={`pinned: ${row.call?.stickyReason ?? row.put?.stickyReason}`}>
                          ★
                        </span>
                      )}
                    </th>
                    {grid.columns.map((c, i) => (
                      <td
                        key={`p-${c.key}`}
                        className={row.put?.stickyReason ? 'is-sticky' : ''}
                        onClick={() => {
                          if (!row.put) return;
                          void window.api.chains
                            .contractHistory(row.put.osiSymbol)
                            .then((r) => { if (r.ok) setHistory(r.data); });
                        }}
                      >
                        {row.put ? renderCell(c, row.put.cells[i]!) : <span className="null-mark null-na">–</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {history && (
        <section className="panel">
          <h2>
            <span className="mono">{history.osiSymbol}</span>
            <button className="link" onClick={() => setHistory(null)}>close</button>
          </h2>
          <p className="muted">
            Every date the contract was captured. A gap is labelled with its cause — the rule
            declined that expiration, or the ticker was not in the subset — because those are
            different facts and only one of them is a collection problem.
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                {history.columns.map((c) => <th key={c.key}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {history.rows.map((r) => (
                <tr key={r.asOfDate} className={r.captured ? '' : 'is-gap'}>
                  <th>{r.asOfDate}</th>
                  {r.captured ? (
                    history.columns.map((c, i) => <td key={c.key}>{renderCell(c, r.cells[i]!)}</td>)
                  ) : (
                    <td colSpan={history.columns.length} className="gap-reason">{r.gapReason}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
