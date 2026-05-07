// useWebSocket hook - manages WebSocket connection and price updates
// Provides real-time price updates and connection status
// see SPEC: §2.5.3 UI Updates

import { useEffect, useState, useCallback } from 'react';

interface PriceUpdate {
  ticker: string;
  price: number;
  change: number;
  changePct: number;
}

interface UseWebSocketReturn {
  isConnected: boolean;
  priceUpdates: Record<string, PriceUpdate>;
  subscribe: (ticker: string) => void;
  unsubscribe: (ticker: string) => void;
}

export function useWebSocket(): UseWebSocketReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [priceUpdates, setPriceUpdates] = useState<Record<string, PriceUpdate>>({});

  useEffect(() => {
    // Set up event listeners
    const removeConnected = window.api.websocket.onConnected(() => {
      console.log('[useWebSocket] Connected');
      setIsConnected(true);
    });

    const removeDisconnected = window.api.websocket.onDisconnected(() => {
      console.log('[useWebSocket] Disconnected');
      setIsConnected(false);
    });

    const removePrice = window.api.websocket.onPrice((data) => {
      setPriceUpdates(prev => ({
        ...prev,
        [data.ticker]: data
      }));
    });

    const removeError = window.api.websocket.onError((error) => {
      console.error('[useWebSocket] Error:', error);
    });

    // Check initial connection status
    window.api.websocket.isConnected().then(setIsConnected);

    // Cleanup
    return () => {
      removeConnected();
      removeDisconnected();
      removePrice();
      removeError();
    };
  }, []);

  const subscribe = useCallback((ticker: string) => {
    if (ticker) {
      window.api.websocket.subscribe(ticker.toUpperCase());
    }
  }, []);

  const unsubscribe = useCallback((ticker: string) => {
    if (ticker) {
      window.api.websocket.unsubscribe(ticker.toUpperCase());
    }
  }, []);

  return {
    isConnected,
    priceUpdates,
    subscribe,
    unsubscribe
  };
}

export default useWebSocket;
