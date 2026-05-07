// RealtimePriceTicker component - displays live price updates
// Shows current price, change amount, and change percentage
// see SPEC: §2.5.3 UI Updates

import React from 'react';

interface PriceData {
  ticker: string;
  price: number;
  change: number;
  changePct: number;
}

interface RealtimePriceTickerProps {
  priceData: PriceData | null;
  ticker?: string;
}

export const RealtimePriceTicker: React.FC<RealtimePriceTickerProps> = ({
  priceData,
  ticker
}) => {
  const displayTicker = priceData?.ticker || ticker || '—';

  if (!priceData) {
    return (
      <div className="realtime-price-ticker">
        <span className="ticker-name">{displayTicker}</span>
        <span className="price">—</span>
      </div>
    );
  }

  const isPositive = priceData.change >= 0;
  const changeColor = isPositive ? '#3fb950' : '#f85149';
  const changeSign = isPositive ? '+' : '';

  return (
    <div className="realtime-price-ticker">
      <span className="ticker-name">{priceData.ticker}</span>
      <span className="price" style={{ color: isPositive ? '#3fb950' : '#f85149' }}>
        ${priceData.price.toFixed(2)}
      </span>
      <span className="change" style={{ color: changeColor }}>
        {changeSign}{priceData.change.toFixed(2)}
      </span>
      <span className="change-pct" style={{ color: changeColor }}>
        ({changeSign}{priceData.changePct.toFixed(2)}%)
      </span>
    </div>
  );
};

export default RealtimePriceTicker;
