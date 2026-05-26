// Volume Profile primitive for lightweight-charts v4.
// Renders horizontal volume bars on the right side of the chart,
// aligned to actual price coordinates via series.priceToCoordinate().

import type {
  ISeriesPrimitive,
  ISeriesPrimitivePaneRenderer,
  ISeriesPrimitivePaneView,
  Time,
} from 'lightweight-charts';

export interface BarDataWithVolume {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface RendererBar {
  y: number;       // CSS-pixel y of the top of this bin
  height: number;  // CSS-pixel height of this bin
  volumePct: number; // 0-100 relative to the max bin
  color: string;
}

const defaults = {
  binCount: 24,
  maxWidthPx: 80,
  pocColor: 'rgba(255, 165, 0, 0.75)',
  valueAreaColor: 'rgba(41, 98, 255, 0.45)',
  outsideColor: 'rgba(100, 149, 237, 0.20)',
};

class VolumeProfileRenderer implements ISeriesPrimitivePaneRenderer {
  private _bars: RendererBar[];
  private _maxWidth: number;

  constructor(bars: RendererBar[], maxWidth: number) {
    this._bars = bars;
    this._maxWidth = maxWidth;
  }

  draw(target: any): void {
    target.useBitmapCoordinateSpace((scope: any) => {
      const ctx = scope.context as CanvasRenderingContext2D;
      const rx = scope.horizontalPixelRatio as number;
      const ry = scope.verticalPixelRatio as number;
      const canvasW = scope.bitmapSize.width as number;

      for (const bar of this._bars) {
        if (bar.volumePct <= 0) continue;
        const barW = Math.round((bar.volumePct / 100) * this._maxWidth * rx);
        const barY = Math.round(bar.y * ry);
        const barH = Math.max(1, Math.round(bar.height * ry) - 1);
        ctx.fillStyle = bar.color;
        ctx.fillRect(canvasW - barW, barY, barW, barH);
      }
    });
  }
}

class VolumeProfilePaneView implements ISeriesPrimitivePaneView {
  private _bars: RendererBar[];
  private _maxWidth: number;

  constructor(bars: RendererBar[], maxWidth: number) {
    this._bars = bars;
    this._maxWidth = maxWidth;
  }

  renderer(): ISeriesPrimitivePaneRenderer {
    return new VolumeProfileRenderer(this._bars, this._maxWidth);
  }
}

export class VolumeProfile implements ISeriesPrimitive<Time> {
  private _source: any = null;
  private _data: BarDataWithVolume[];
  private _options: typeof defaults;

  constructor(data: BarDataWithVolume[], options: Partial<typeof defaults> = {}) {
    this._data = data;
    this._options = { ...defaults, ...options };
  }

  attached(source: any): void {
    this._source = source;
  }

  detached(): void {
    this._source = null;
  }

  updateAllViews(): void {}

  paneViews(): ISeriesPrimitivePaneView[] {
    if (!this._source || this._data.length === 0) return [];

    const series = this._source.series;
    const chart = this._source.chart;

    const visibleRange = chart.timeScale().getVisibleLogicalRange();
    if (!visibleRange) return [];

    // Use this._data (which has volume) — series.data() holds candlestick data without volume.
    const from = Math.max(0, Math.floor(visibleRange.from));
    const to = Math.min(this._data.length - 1, Math.ceil(visibleRange.to));

    const visibleBars = this._data.slice(from, to + 1);
    if (visibleBars.length === 0) return [];

    const priceHigh = Math.max(...visibleBars.map((b) => b.high));
    const priceLow = Math.min(...visibleBars.map((b) => b.low));
    const priceRange = priceHigh - priceLow;
    if (priceRange <= 0) return [];

    const { binCount, maxWidthPx, pocColor, valueAreaColor, outsideColor } = this._options;
    const binSize = priceRange / binCount;

    // Accumulate volume per bin using this._data which carries volume
    const bins = new Array<number>(binCount).fill(0);
    for (const bar of visibleBars) {
      const startBin = Math.max(0, Math.floor((bar.low - priceLow) / binSize));
      const endBin = Math.min(binCount - 1, Math.floor((bar.high - priceLow) / binSize));
      const numBins = Math.max(1, endBin - startBin + 1);
      const volPerBin = bar.volume / numBins;
      for (let b = startBin; b <= endBin; b++) {
        const cur = bins[b] ?? 0; bins[b] = cur + volPerBin;
      }
    }

    // Point of Control: bin with highest volume
    const maxBinVol = Math.max(...bins);
    if (maxBinVol <= 0) return [];
    const pocIdx = bins.indexOf(maxBinVol);

    // Value Area: bins containing 70% of total volume (highest-vol first)
    const totalVol = bins.reduce((s, v) => s + v, 0);
    const vaTarget = totalVol * 0.70;
    const sorted = bins.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
    const vaSet = new Set<number>();
    let accVol = 0;
    for (const { v, i } of sorted) {
      if (accVol >= vaTarget) break;
      accVol += v;
      vaSet.add(i);
    }

    // Map bins to canvas y coordinates via priceToCoordinate
    const rendererBars: RendererBar[] = [];
    for (let i = 0; i < binCount; i++) {
      const binTop = priceLow + (i + 1) * binSize;
      const binBot = priceLow + i * binSize;
      const yTop = series.priceToCoordinate(binTop);
      const yBot = series.priceToCoordinate(binBot);
      if (yTop === null || yBot === null) continue;

      const height = Math.max(1, yBot - yTop);
      const color = i === pocIdx ? pocColor : vaSet.has(i) ? valueAreaColor : outsideColor;

      rendererBars.push({
        y: yTop,
        height,
        volumePct: ((bins[i] ?? 0) / maxBinVol) * 100,
        color,
      });
    }

    return [new VolumeProfilePaneView(rendererBars, maxWidthPx)];
  }
}
