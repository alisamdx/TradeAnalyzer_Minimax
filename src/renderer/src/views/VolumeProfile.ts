// Official lightweight-charts volume profile plugin example
// https://tradingview.github.io/lightweight-charts/plugin-examples/examples/volume-profile/
// Adapted for TradeAnalyzer

import type {
  ISeriesPrimitive,
  ISeriesPrimitivePaneRenderer,
  ISeriesPrimitivePaneView,
  Time,
  BusinessDay,
  UTCTimestamp
} from 'lightweight-charts';

interface VolumeProfileData {
  price: number;
  volume: number;
}

interface VolumeProfileHistogram {
  volume: number;
  color: string;
}

interface VolumeProfileRendererData {
  histograms: VolumeProfileHistogram[];
  width: number;
  barWidth: number;
  firstBar: number;
  barSpacing: number;
}

const defaultOptions = {
  binSize: 20,
  width: 70,
  valueAreaVolume: 70,
  pohColor: 'rgba(255, 165, 0, 0.5)',
  vahColor: 'rgba(41, 98, 255, 0.5)',
  valColor: 'rgba(41, 98, 255, 0.2)',
};

class VolumeProfileRenderer implements ISeriesPrimitivePaneRenderer {
  _data: VolumeProfileRendererData;

  constructor(data: VolumeProfileRendererData) {
    this._data = data;
    console.log('[VolumeProfileRenderer] Constructor data:', data);
  }

  draw(target: any) {
    console.log('[VolumeProfileRenderer] draw called.');
    target.useBitmapCoordinateSpace((scope: any) => {
      const ctx = scope.context;
      const h = scope.bitmapSize.height;
      console.log(`[VolumeProfileRenderer] Canvas height: ${h}`);

      const barWidth = this._data.barWidth;
      const barSpacing = this._data.barSpacing;

      for (let i = 0; i < this._data.histograms.length; i++) {
        const y = i * (barWidth + barSpacing) + barSpacing;
        const bar = this._data.histograms[i];
        if (y > h) break;
        if (bar.volume > 0) {
          ctx.fillStyle = bar.color;
          const w = (this._data.width / 100) * bar.volume;
          ctx.fillRect(scope.bitmapSize.width - w, y, w, barWidth);
          console.log(`[VolumeProfileRenderer] Drawing bar at y=${y}, width=${w}, volume=${bar.volume}`);
        }
      }
    });
  }
}

interface BarDataWithVolume {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export class VolumeProfile implements ISeriesPrimitive {
  _source: any = null;
  _data: BarDataWithVolume[] = [];
  _options: any;

  constructor(data: BarDataWithVolume[], options = {}) {
    this._data = data;
    this._options = { ...defaultOptions, ...options };
  }

  attached(source: any) {
    this._source = source;
  }

  updateAllViews() {
    return this.paneViews();
  }

  paneViews() {
    console.log('[VolumeProfile] paneViews called.');
    const series = this._source.series;
    const chart = this._source.chart;

    const data = this._source.series.data();
    if (data.length === 0) {
      console.log('[VolumeProfile] No series data, returning empty.');
      return [];
    }

    const bars = Array.from(data.values());
    const visibleRange = chart.timeScale().getVisibleLogicalRange();

    if (visibleRange === null) {
      console.log('[VolumeProfile] No visible range, returning empty.');
      return [];
    }
    console.log(`[VolumeProfile] Visible logical range: from ${visibleRange.from}, to ${visibleRange.to}`);


    const from = Math.floor(visibleRange.from);
    const to = Math.ceil(visibleRange.to);

    const volumeData: VolumeProfileData[] = [];
    let totalVolume = 0;
    for (let i = from; i <= to; i++) {
      const bar = bars[i];
      if (!bar) {
        console.log(`[VolumeProfile] Skipping bar at index ${i}: bar is null/undefined.`);
        continue;
      }
      if (bar.high === null || bar.low === null || bar.volume === null || bar.high === undefined || bar.low === undefined || bar.volume === undefined) {
        console.log(`[VolumeProfile] Skipping bar at index ${i}: missing high, low, or volume. Bar:`, bar);
        continue;
      }

      const barHigh = bar.high as number;
      const barLow = bar.low as number;
      const barVolume = bar.volume as number;
      console.log(`[VolumeProfile] Processing bar ${i}: High=${barHigh}, Low=${barLow}, Volume=${barVolume}`);





      if (priceRange <= 0) {
        // If priceRange is 0 or negative, put all volume into a single bin at barLow
        const binPrice = barLow;
        const bin = volumeData.find((v) => v.price === binPrice);
        if (bin) {
          bin.volume += barVolume;
        } else {
          volumeData.push({ price: binPrice, volume: barVolume });
        }
        totalVolume += barVolume;
      } else {
        // Distribute volume across bins
        const numBinsInPriceRange = Math.ceil(priceRange / this._options.binSize);
        const volumePerBin = barVolume / numBinsInPriceRange;

        for (let j = barLow; j < barHigh; j += this._options.binSize) {
          const binPrice = j;
          const bin = volumeData.find((v) => v.price === binPrice);
          if (bin) {
            bin.volume += volumePerBin;
          } else {
            volumeData.push({ price: binPrice, volume: volumePerBin });
          }
          totalVolume += volumePerBin;
        }
      }
    }

    const valueAreaVolume = (totalVolume / 100) * this._options.valueAreaVolume;
    volumeData.sort((a, b) => b.volume - a.volume);
    const poh = volumeData[0];
    let currentVolume = 0;
    const valueArea: VolumeProfileData[] = [];
    for (const v of volumeData) {
      if (currentVolume > valueAreaVolume) break;
      currentVolume += v.volume;
      valueArea.push(v);
    }
    
    volumeData.sort((a, b) => a.price - b.price);

    const priceScale = series.priceScale();
    const histograms: VolumeProfileHistogram[] = [];
    const maxVolume = Math.max(...volumeData.map((d) => d.volume));
    console.log(`[VolumeProfile] Max Volume for scaling: ${maxVolume}`);

    for (let i = 0; i < volumeData.length; i++) {
      const v = volumeData[i];
      if (series.priceToCoordinate(v.price) === null) continue;
      const color =
        poh === v
          ? this._options.pohColor
          : valueArea.includes(v)
          ? this._options.vahColor
          : this._options.valColor;
      histograms.push({
        volume: (v.volume / maxVolume) * 100,
        color: color,
      });
    }
    console.log(`[VolumeProfile] Final histograms count: ${histograms.length}`);
    if (histograms.length > 0) {
      console.log('[VolumeProfile] First histogram bar:', histograms[0]);
    }

    const barWidth = 1;
    const barSpacing = 1;

    return [
      new (class implements ISeriesPrimitivePaneView {
        renderer() {
          console.log('[VolumeProfile] Creating renderer.');
          return new VolumeProfileRenderer({
            histograms: histograms,
            width: 70,
            barWidth: barWidth,
            firstBar: from,
            barSpacing: barSpacing,
          });
        }
      })(),
    ];
  }
}
