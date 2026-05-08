// IPC handlers for WebSocket streaming
// Exposes WebSocket operations to renderer process
// see SPEC: §2.5 Real-Time Streaming

import { ipcMain, BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type { WebSocketService } from '../services/websocket-service.js';
import type { IpcResult } from '@shared/types.js';

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function fail(err: unknown): IpcResult<never> {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: 'WEBSOCKET_ERROR', message } };
}

function wrap<Args extends unknown[], R>(fn: (...args: Args) => R) {
  return (_e: IpcMainInvokeEvent, ...args: Args): IpcResult<R> => {
    try {
      return ok(fn(...args));
    } catch (err) {
      return fail(err);
    }
  };
}

export function registerWebSocketIpc(wsService: WebSocketService): void {
  // Connect to WebSocket
  ipcMain.handle('websocket:connect', wrap(() => {
    wsService.connect();
    return true;
  }));

  // Disconnect WebSocket
  ipcMain.handle('websocket:disconnect', wrap(() => {
    wsService.disconnect();
    return true;
  }));

  // Subscribe to ticker
  ipcMain.handle('websocket:subscribe', wrap((ticker: string) => {
    wsService.subscribe(ticker);
    return true;
  }));

  // Unsubscribe from ticker
  ipcMain.handle('websocket:unsubscribe', wrap((ticker: string) => {
    wsService.unsubscribe(ticker);
    return true;
  }));

  // Get connection status
  ipcMain.handle('websocket:isConnected', wrap(() => {
    return wsService.isConnected();
  }));

  // Get subscribed tickers
  ipcMain.handle('websocket:getSubscribed', wrap(() => {
    return wsService.getSubscribedTickers();
  }));

  // Forward WebSocket events to renderer
  wsService.on('price', (data) => {
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('websocket:price', data);
    });
  });

  wsService.on('connected', () => {
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('websocket:connected');
    });
  });

  wsService.on('disconnected', () => {
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('websocket:disconnected');
    });
  });

  wsService.on('error', (err) => {
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('websocket:error', err.message);
    });
  });
}
