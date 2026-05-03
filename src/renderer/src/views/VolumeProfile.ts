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
  }

  draw(target: any) {
    target.useBitmapCoordinateSpace((scope: any) => {
      const ctx = scope.context;
      const h = scope.bitmapSize.height;

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
        }
      }
    });
  }
}

export class VolumeProfile implements ISeriesPrimitive {
  _source: any = null;
  _data: VolumeProfileData[] = [];
  _options: any;

  constructor(options = {}) {
    this._options = { ...defaultOptions, ...options };
  }

  attached(source: any) {
    this._source = source;
  }

  updateAllViews() {
    return this.paneViews();
  }

  paneViews() {
    const series = this._source.series;
    const chart = this._source.chart;

    const data = this._source.series.data();
    if (data.length === 0) {
      return [];
    }

    const bars = Array.from(data.values());
    const visibleRange = chart.timeScale().getVisibleLogicalRange();

    if (visibleRange === null) {
      return [];
    }

    const from = visibleRange.from;
    const to = visibleRange.to;

    const volumeData: VolumeProfileData[] = [];
    let totalVolume = 0;
    for (let i = from; i <= to; i++) {
      const bar = bars[i];
      if (!bar || bar.high === null || bar.low === null || bar.volume === null || bar.high === undefined || bar.low === undefined || bar.volume === undefined) {
        continue;
      }

      const barHigh = bar.high as number;
      const barLow = bar.low as number;
      const barVolume = bar.volume as number;

      const priceRange = barHigh - barLow;

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

    const barWidth = 1;
    const barSpacing = 1;

    return [
      new (class implements ISeriesPrimitivePaneView {
        renderer() {
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
