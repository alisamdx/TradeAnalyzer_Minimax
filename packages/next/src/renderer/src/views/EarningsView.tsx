import { useEffect, useState } from 'react';
import type {
  EarningsAnomalyDto,
  EarningsMonthDto,
  EarningsTrailDto
} from '../../../shared/types.js';
import { groupSpans, renderCell } from './ViewCells.js';

/**
 * The Earnings view — 05 §4.3.
 *
 * A month calendar of report dates, and — the half that matters — the
 * **observation trail** per ticker: every `report_date` ever observed, by source
 * and `observed_at`, so a date that moved is visible as a trail rather than as a
 * number that happens to be wrong today.
 *
 * The existing app stored NVDA's August report as November, from a bulk response
 * silently truncated at its row cap, and then ranked NVDA wheel #1 on the day it
 * printed. Every mechanism that should have corrected it skipped on the presence
 * of a stored future date. A view that showed only the resolved date would have
 * rendered all of that as an ordinary row; this one draws the jump.
 */

type Tab = 'calendar' | 'anomalies';

export function EarningsView() {
  const [tab, setTab] = useState<Tab>('calendar');
  const [months, setMonths] = useState<readonly string[]>([]);
  const [month, setMonth] = useState<string | null>(null);
  const [calendar, setCalendar] = useState<EarningsMonthDto | null>(null);
  const [anomalies, setAnomalies] = useState<readonly EarningsAnomalyDto[]>([]);
  const [ticker, setTicker] = useState<string | null>(null);
  const [trail, setTrail] = useState<EarningsTrailDto | null>(null);

  useEffect(() => {
    void window.api.earnings.months().then((r) => {
      if (!r.ok) return;
      setMonths(r.data);
      setMonth(r.data.find((m) => m >= new Date().toISOString().slice(0, 7)) ?? r.data[0] ?? null);
    });
    void window.api.earnings.anomalies().then((r) => { if (r.ok) setAnomalies(r.data); });
  }, []);

  useEffect(() => {
    if (!month) return;
    void window.api.earnings.month(month).then((r) => { if (r.ok) setCalendar(r.data); });
  }, [month]);

  useEffect(() => {
    if (!ticker) { setTrail(null); return; }
    void window.api.earnings.trail(ticker).then((r) => { if (r.ok) setTrail(r.data); });
  }, [ticker]);

  if (months.length === 0) {
    return (
      <>
        <h1>Earnings</h1>
        <p className="muted">
          No earnings observations yet. They are swept in phase 8 of the daily run, in windows
          narrow enough to stay under the provider&rsquo;s row cap — a response that arrives at the
          cap is treated as truncated and subdivided, never trusted.
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Earnings</h1>

      <div className="tabs">
        {(['calendar', 'anomalies'] as const).map((t) => (
          <button key={t} className={`tab${tab === t ? ' is-active' : ''}`} onClick={() => setTab(t)}>
            {t}
            {t === 'anomalies' && anomalies.length > 0 ? ` (${anomalies.length})` : ''}
          </button>
        ))}
        {tab === 'calendar' && (
          <label className="tab-selector">
            <span>month</span>
            <select value={month ?? ''} onChange={(e) => setMonth(e.target.value)}>
              {months.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {tab === 'calendar' && calendar && (
        <div className="earnings-calendar">
          {calendar.days.length === 0 && (
            <p className="muted">No report dates observed in {calendar.month}.</p>
          )}
          {calendar.days.map((day) => (
            <section key={day.date} className="earnings-day">
              <h3>{day.date}</h3>
              <div className="earnings-tickers">
                {day.tickers.map((t) => (
                  <button
                    key={`${t.ticker}-${t.source}`}
                    className={`chip chip-button${ticker === t.ticker ? ' is-active' : ''}`}
                    onClick={() => setTicker(t.ticker)}
                    title={`${t.source}; report time ${t.reportTime ?? t.reportTimeStatus}`}
                  >
                    {t.ticker}
                    {/* An absent report time shows its declared meaning, not a
                        blank — 47 % of rows genuinely have none. */}
                    <span className="chip-sub">{t.reportTime ?? '·'}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {tab === 'anomalies' && (
        <table className="grid">
          <thead>
            <tr><th>Ticker</th><th>Kind</th><th>Detail</th></tr>
          </thead>
          <tbody>
            {anomalies.length === 0 && (
              <tr><td colSpan={3} className="muted">No date moved later beyond the limit, and no two sources disagree.</td></tr>
            )}
            {anomalies.map((a, i) => (
              <tr key={`${a.ticker}-${i}`}>
                <td>
                  <button className="link" onClick={() => { setTicker(a.ticker); setTab('calendar'); }}>
                    {a.ticker}
                  </button>
                </td>
                <td><span className="chip">{a.kind.replace(/_/g, ' ')}</span></td>
                <td>{a.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {trail && (
        <section className="trail">
          <h2>
            {trail.ticker} — every observation
            <button className="link" onClick={() => setTicker(null)}>close</button>
          </h2>
          <p className="muted">
            Newest first. &ldquo;Moved&rdquo; compares each observation with the previous one{' '}
            <em>from the same source</em>; a move nearer is a correction and is not flagged, a move
            more than 14 days later is the truncation signature.
          </p>
          <table className="grid">
            <thead>
              <tr>
                {groupSpans(trail.columns).map((g, i) => (
                  <th key={i} colSpan={g.span} className="group-band">{g.group ?? ''}</th>
                ))}
                <th className="group-band" />
              </tr>
              <tr>
                {trail.columns.map((c) => (
                  <th key={c.key} title={c.nullMeaning ?? undefined}>{c.label}</th>
                ))}
                <th>Moved</th>
              </tr>
            </thead>
            <tbody>
              {trail.observations.map((o, i) => (
                <tr key={i} className={o.slipSuspect ? 'row-suspect' : undefined}>
                  {trail.columns.map((c, j) => (
                    <td key={c.key}>{renderCell(c, o.cells[j] as never)}</td>
                  ))}
                  <td>
                    {o.slipDays === null
                      ? ''
                      : `${o.slipDays > 0 ? '+' : ''}${o.slipDays}d`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
