// WebSocket Service - real-time price streaming from Polygon.io
// Connects to delayed WebSocket feed, handles reconnection with exponential backoff
// see SPEC: §2.5 Real-Time Streaming, §2.5.1 WebSocket Connection

import { EventEmitter } from 'events';
import WebSocket from 'ws';

export interface TradeMessage {
  type: 'T';
  ticker: string;
  price: number;
  size: number;
  timestamp: number;
}

export interface AggregateMessage {
  type: 'A';
  ticker: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

export type WebSocketMessage = TradeMessage | AggregateMessage;

interface WebSocketServiceEvents {
  'price': [data: { ticker: string; price: number; change: number; changePct: number }];
  'trade': [message: TradeMessage];
  'aggregate': [message: AggregateMessage];
  'connected': [];
  'disconnected': [];
  'error': [error: Error];
}

export class WebSocketService extends EventEmitter {
  private ws: WebSocket | null = null;
  private apiKey: string;
  private subscribedTickers: Set<string> = new Set();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelays = [3000, 6000, 12000, 24000, 48000]; // Exponential backoff
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private getApiKey: () => string;

  constructor(getApiKey: () => string) {
    super();
    this.getApiKey = getApiKey;
    this.apiKey = getApiKey();
  }

  /**
   * Connect to Polygon WebSocket
   */
  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    this.apiKey = this.getApiKey();
    if (!this.apiKey) {
      this.emit('error', new Error('API key not configured'));
      return;
    }

    const wsUrl = `wss://delayed.polygon.io/stocks?apiKey=${this.apiKey}`;
    console.log('[WebSocket] Connecting to Polygon...');

    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      console.log('[WebSocket] Connected');
      this.reconnectAttempts = 0;
      this.emit('connected');

      // Resubscribe to all tickers
      this.subscribedTickers.forEach(ticker => this.subscribe(ticker));
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        const messages = JSON.parse(data.toString());
        if (Array.isArray(messages)) {
          messages.forEach(msg => this.handleMessage(msg));
        } else {
          this.handleMessage(messages);
        }
      } catch (err) {
        console.error('[WebSocket] Failed to parse message:', err);
      }
    });

    this.ws.on('close', () => {
      console.log('[WebSocket] Disconnected');
      this.emit('disconnected');
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error('[WebSocket] Error:', err.message);
      this.emit('error', err);
    });
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(msg: any): void {
    if (msg.ev === 'T') {
      // Trade message
      const tradeMsg: TradeMessage = {
        type: 'T',
        ticker: msg.sym,
        price: msg.p,
        size: msg.s,
        timestamp: msg.t
      };
      this.emit('trade', tradeMsg);

      // Calculate and emit price update
      this.emit('price', {
        ticker: msg.sym,
        price: msg.p,
        change: msg.c || 0,
        changePct: msg.P || 0
      });
    } else if (msg.ev === 'A') {
      // Aggregate message
      const aggMsg: AggregateMessage = {
        type: 'A',
        ticker: msg.sym,
        open: msg.o,
        high: msg.h,
        low: msg.l,
        close: msg.c,
        volume: msg.v,
        timestamp: msg.t
      };
      this.emit('aggregate', aggMsg);
    } else if (msg.status === 'connected') {
      console.log('[WebSocket] Auth confirmed');
    }
  }

  /**
   * Subscribe to ticker updates
   */
  subscribe(ticker: string): void {
    if (!ticker) return;

    const upperTicker = ticker.toUpperCase();
    this.subscribedTickers.add(upperTicker);

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action: 'subscribe', params: `T.${upperTicker},A.${upperTicker}` }));
      console.log(`[WebSocket] Subscribed to ${upperTicker}`);
    }
  }

  /**
   * Unsubscribe from ticker updates
   */
  unsubscribe(ticker: string): void {
    const upperTicker = ticker.toUpperCase();
    this.subscribedTickers.delete(upperTicker);

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action: 'unsubscribe', params: `T.${upperTicker},A.${upperTicker}` }));
      console.log(`[WebSocket] Unsubscribed from ${upperTicker}`);
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('[WebSocket] Max reconnect attempts reached');
      return;
    }

    const delay = this.reconnectDelays[this.reconnectAttempts] || 48000;
    this.reconnectAttempts++;

    console.log(`[WebSocket] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, delay);
  }

  /**
   * Disconnect WebSocket
   */
  disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.reconnectAttempts = this.maxReconnectAttempts; // Prevent auto-reconnect

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Get connection status
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Get subscribed tickers
   */
  getSubscribedTickers(): string[] {
    return Array.from(this.subscribedTickers);
  }
}

export default WebSocketService;
