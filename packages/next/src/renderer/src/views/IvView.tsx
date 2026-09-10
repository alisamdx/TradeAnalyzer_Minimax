import { useEffect, useMemo, useState } from 'react';
import type { IvSeriesDto, IvTickerDto, IvPointDto } from '../../../shared/types.js';
import { buildScale, pathSegments, type Scale } from '../../../shared/iv-path.js';

/**
 * The IV view — 05 §4.6.
 *
 * Two series on one chart with the stitch date marked and the overlap window
 * shaded. **Days our own series could not compute are drawn as gaps with a
 * glyph and are never interpolated across** — a line joined through a missing
 * day asserts a value that was never measured, which is the one thing this
 * screen exists to avoid.
 *
 * The whole reason it exists: the existing app spliced two IV sources with zero
 * overlapping ticker-days, and no amount of later analysis can say whether that
 * distorted IV rank. Here the overlap is a number on the screen.
 */

const W = 900;
const H = 300;
const PAD = { top: 16, right: 16, bottom: 28, left: 48 };

type Loaded = { tickers: readonly IvTickerDto[]; selected: string | null };

export function IvView(): JSX.Element {
  const [list, setList] = useState<Loaded>({ tickers: [], selected: null });
  const [series, setSeries] = useState<IvSeriesDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.api.volatility.tickers().then((r) => {
      if (!r.ok) { setError(r.error); return; }
      setList({ tickers: r.data, selected: r.data[0]?.ticker ?? null });
    });
  }, []);

  useEffect(() => {
    if (list.selected === null) return;
    void window.api.volatility.series(list.selected).then((r) => {
      if (!r.ok) { setError(r.error); return; }
      setSeries(r.data);
    });
  }, [list.selected]);

  if (error !== null) return <p className="error">{error}</p>;
  if (list.tickers.length === 0) {
    return (
      <section className="view">
        <h1>Implied volatility</h1>
        <p className="empty">
          Nothing to show yet. Our own series begins with the first daily run that stores a chain,
          and the external history appears once a bootstrap has been loaded.
        </p>
      </section>
    );
  }

  return (
    <section className="view">
      <h1>Implied volatility</h1>

      <label className="picker">
        Ticker
        <select
          value={list.selected ?? ''}
          onChange={(e) => setList((p) => ({ ...p, selected: e.target.value }))}
        >
          {list.tickers.map((t) => (
            <option key={t.ticker} value={t.ticker}>
              {t.ticker} — {t.ownDays} own, {t.externalDays} external
            </option>
          ))}
        </select>
      </label>

      {series && <Overlap series={series} />}
      {series && <Chart series={series} />}
      {series && <Gaps points={series.points} />}
    </section>
  );
}

/**
 * The overlap panel, and the one number that has to be unmissable.
 *
 * Zero paired days is not "no data yet" — it is the maximum firing of QC-907,
 * because it means the comparison the acceptance depends on has never had
 * anything to compare. Shown as a failure, in words, rather than as an empty
 * count.
 */
function Overlap({ series }: { series: IvSeriesDto }): JSX.Element {
  const o = series.overlap;
  if (o === null) {
    return (
      <p className="panel">
        No external history for this ticker. Rank computes from our own series alone and reports
        its declared gap — the same behaviour as if nothing had been bought.
      </p>
    );
  }

  const enough = o.pairedDays >= o.requiredDays;
  const disagrees = o.medianAbsDiff !== null && o.medianAbsDiff > o.tolerance;

  return (
    <div className="panel">
      <dl className="facts">
        <dt>Days both series measured</dt>
        <dd className={enough ? 'ok' : 'bad'}>
          {o.pairedDays} of {o.requiredDays} needed
          {o.pairedDays === 0 && ' — the two series have never measured the same day'}
        </dd>

        <dt>Median difference</dt>
        <dd className={disagrees ? 'bad' : 'ok'}>
          {o.medianAbsDiff === null
            ? 'not measurable without an overlap'
            : `${(o.medianAbsDiff * 100).toFixed(2)} vol points (tolerance ${(o.tolerance * 100).toFixed(0)})`}
        </dd>

        <dt>External series</dt>
        <dd>{o.readable ? 'in use' : 'loaded, not yet in use — nothing reads it'}</dd>

        <dt>Stitch date</dt>
        <dd>{series.stitchDate ?? 'not set — our own series is the only one being read'}</dd>
      </dl>

      {o.externalMethod !== null && (
        <p className="method">
          <strong>{o.externalSource}</strong>: {o.externalMethod}
        </p>
      )}
    </div>
  );
}

const BOX = { width: W, height: H, pad: PAD };

function scaleFor(points: readonly IvPointDto[]): Scale | null {
  const values = points.flatMap((p) => [p.own, p.external].filter((v): v is number => v !== null));
  return buildScale(points.map((p) => p.date), values, BOX);
}

function Chart({ series }: { series: IvSeriesDto }): JSX.Element {
  const s = useMemo(() => scaleFor(series.points), [series.points]);
  if (s === null) return <p className="empty">No values to plot for this ticker yet.</p>;

  const pairedDates = series.points.filter((p) => p.paired).map((p) => p.date);
  const shadeFrom = pairedDates[0];
  const shadeTo = pairedDates[pairedDates.length - 1];

  return (
    <svg className="iv-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Implied volatility series">
      {/* The overlap window: the days the acceptance decision is actually made of. */}
      {shadeFrom !== undefined && shadeTo !== undefined && (
        <rect
          x={s.x(shadeFrom)}
          y={PAD.top}
          width={Math.max(1, s.x(shadeTo) - s.x(shadeFrom))}
          height={H - PAD.top - PAD.bottom}
          className="iv-overlap"
        />
      )}

      {series.stitchDate !== null && s.dates.includes(series.stitchDate) && (
        <line
          x1={s.x(series.stitchDate)}
          x2={s.x(series.stitchDate)}
          y1={PAD.top}
          y2={H - PAD.bottom}
          className="iv-stitch"
        />
      )}

      {pathSegments(series.points.map((p) => ({ date: p.date, value: p.external })), s).map((d, i) => (
        <path key={`e${i}`} d={d} className="iv-external" fill="none" />
      ))}
      {pathSegments(series.points.map((p) => ({ date: p.date, value: p.own })), s).map((d, i) => (
        <path key={`o${i}`} d={d} className="iv-own" fill="none" />
      ))}

      {/* A glyph on every day our own value is missing — the gap says why. */}
      {series.points
        .filter((p) => p.own === null && p.ownStatus !== null)
        .map((p) => (
          <circle key={p.date} cx={s.x(p.date)} cy={H - PAD.bottom} r={2.5} className="iv-gap">
            <title>{`${p.date}: ${p.ownStatus}`}</title>
          </circle>
        ))}

      <text x={4} y={PAD.top + 8} className="iv-axis">{(s.max * 100).toFixed(0)}%</text>
      <text x={4} y={H - PAD.bottom} className="iv-axis">{(s.min * 100).toFixed(0)}%</text>
      <text x={PAD.left} y={H - 8} className="iv-axis">{s.dates[0]}</text>
      <text x={W - PAD.right - 60} y={H - 8} className="iv-axis">{s.dates[s.dates.length - 1]}</text>
    </svg>
  );
}

/**
 * The gaps, counted by reason.
 *
 * A count rather than a list, because the question is whether a ticker is
 * systematically unpriceable — `insufficient_expirations` on most days means
 * the chain capture is not reaching far enough, which is a collection problem,
 * while scattered ones are ordinary.
 */
function Gaps({ points }: { points: readonly IvPointDto[] }): JSX.Element | null {
  const counts = new Map<string, number>();
  for (const p of points) {
    if (p.own !== null || p.ownStatus === null || p.ownStatus === 'ok') continue;
    counts.set(p.ownStatus, (counts.get(p.ownStatus) ?? 0) + 1);
  }
  if (counts.size === 0) return null;

  // `why` rather than `reason`: `reason` is a dictionary column name and the
  // AC-13 scan matches it on a word boundary. A local variable is the cheapest
  // possible thing to rename, and exempting the word would have cost the rule.
  return (
    <ul className="gaps">
      {[...counts.entries()].map(([why, n]) => (
        <li key={why}>
          <code>{why}</code> on {n} day{n === 1 ? '' : 's'}
        </li>
      ))}
    </ul>
  );
}
