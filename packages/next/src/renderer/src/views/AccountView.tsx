import { useEffect, useState } from 'react';
import type { BalancesDto, OrdersDto, PositionsDto } from '../../../shared/types.js';
import { groupSpans, renderCell } from './ViewCells.js';

/**
 * The Account view — 05 §4.4.
 *
 * Positions as of a date with the diff against the previous snapshot, the order
 * legs that explain each change, executed orders with their legs, and balances
 * over time.
 *
 * **No derived P&L** (Q13). The provider's own gain fields appear under a band
 * that says what they are. Reconstructing P&L from estimates like these is what
 * read an assigned cash-secured put as a $3,736 loss when the fill said it was a
 * $499 gain, and the whole book at -$2,902 when it was +$3,983.
 */

const CHANGE_LABEL: Readonly<Record<string, string>> = {
  unchanged: '',
  appeared: 'new',
  disappeared: 'gone',
  quantity_changed: 'changed'
};

type Tab = 'positions' | 'orders' | 'balances';

export function AccountView() {
  const [tab, setTab] = useState<Tab>('positions');
  const [dates, setDates] = useState<readonly string[]>([]);
  const [date, setDate] = useState<string | null>(null);
  const [positions, setPositions] = useState<PositionsDto | null>(null);
  const [orders, setOrders] = useState<OrdersDto | null>(null);
  const [balances, setBalances] = useState<BalancesDto | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    void window.api.account.snapshotDates().then((r) => {
      if (!r.ok) return;
      setDates(r.data);
      setDate(r.data[0] ?? null);
    });
  }, []);

  useEffect(() => {
    if (!date) return;
    void window.api.account.positions(date).then((r) => { if (r.ok) setPositions(r.data); });
  }, [date]);

  useEffect(() => {
    void window.api.account.orders(100).then((r) => { if (r.ok) setOrders(r.data); });
    void window.api.account.balances().then((r) => { if (r.ok) setBalances(r.data); });
  }, []);

  if (dates.length === 0) {
    return (
      <>
        <h1>Account</h1>
        <p className="muted">
          No account snapshots yet. Positions, balances and fills are collected in phase 5 of the
          daily run; their archived bodies are encrypted at rest, so nothing here is readable outside
          this machine.
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Account</h1>

      <div className="tabs">
        {(['positions', 'orders', 'balances'] as const).map((t) => (
          <button key={t} className={`tab${tab === t ? ' is-active' : ''}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
        {tab === 'positions' && (
          <label className="tab-selector">
            <span>as of</span>
            <select value={date ?? ''} onChange={(e) => setDate(e.target.value)}>
              {dates.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
        )}
      </div>

      {tab === 'positions' && positions && (
        <>
          <p className="muted">
            {positions.previousAsOfDate
              ? `Compared against ${positions.previousAsOfDate}. A change with no executed order leg behind it is left unexplained rather than reconciled away — that absence is QC-802's finding.`
              : 'First snapshot — there is nothing earlier to compare against, which is not the same as nothing having changed.'}
          </p>
          <div className="grid-scroll">
            <table className="data-table">
              <thead>
                <tr className="group-row">
                  <th />
                  {groupSpans(positions.columns).map((g, i) => (
                    <th
                      key={`${g.group ?? 'none'}-${String(i)}`}
                      colSpan={g.span}
                      className={g.group === 'provider estimates' ? 'group group-estimate' : 'group'}
                    >
                      {g.group ?? ''}
                    </th>
                  ))}
                  <th />
                </tr>
                <tr>
                  <th>Change</th>
                  {positions.columns.map((c) => <th key={c.key}>{c.label}</th>)}
                  <th>Explained by</th>
                </tr>
              </thead>
              <tbody>
                {positions.rows.map((r) => (
                  <tr key={r.key} className={`change-${r.change}`}>
                    <th className="change">{CHANGE_LABEL[r.change]}</th>
                    {positions.columns.map((c, i) => (
                      <td
                        key={c.key}
                        className={c.group === 'provider estimates' ? 'estimate' : ''}
                      >
                        {renderCell(c, r.cells[i]!)}
                      </td>
                    ))}
                    <td>
                      {r.change === 'unchanged'
                        ? ''
                        : r.explainedBy.length > 0
                          ? r.explainedBy.join('; ')
                          : <span className="unexplained" title="No executed order leg accounts for this change (QC-802).">unexplained</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'orders' && orders && (
        <div className="grid-scroll">
          <table className="data-table">
            <thead>
              <tr>
                {orders.columns.map((c) => <th key={c.key}>{c.label}</th>)}
                <th>Legs</th>
              </tr>
            </thead>
            <tbody>
              {orders.orders.map((o) => (
                <>
                  <tr key={o.orderId}>
                    {orders.columns.map((c, i) => <td key={c.key}>{renderCell(c, o.cells[i]!)}</td>)}
                    <td>
                      <button
                        className="link"
                        onClick={() => setExpanded((e) => (e === o.orderId ? null : o.orderId))}
                      >
                        {o.legs.length} {o.legs.length === 1 ? 'leg' : 'legs'}
                      </button>
                    </td>
                  </tr>
                  {expanded === o.orderId && (
                    <tr key={`${o.orderId}-legs`} className="legs-row">
                      <td colSpan={orders.columns.length + 1}>
                        <table className="data-table nested">
                          <thead>
                            <tr>{orders.legColumns.map((c) => <th key={c.key}>{c.label}</th>)}</tr>
                          </thead>
                          <tbody>
                            {o.legs.map((leg, li) => (
                              <tr key={li}>
                                {orders.legColumns.map((c, i) => (
                                  <td key={c.key}>{renderCell(c, leg.cells[i]!)}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'balances' && balances && (
        <div className="grid-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                {balances.columns.map((c) => <th key={c.key}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {balances.points.map((p) => (
                <tr key={p.asOfDate}>
                  <th>{p.asOfDate}</th>
                  {balances.columns.map((c, i) => <td key={c.key}>{renderCell(c, p.cells[i]!)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
