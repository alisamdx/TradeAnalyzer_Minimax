// IPC handlers for WebSocket streaming
// Exposes WebSocket operations to renderer process
// see SPEC: §2.5 Real-Time Streaming

import { ipcMain, BrowserWindow } from 'electron';
import type { WebSocketService } from '../services/websocket-service.js';

export function registerWebSocketIpc(wsService: WebSocketService): void {
  // Connect to WebSocket
  ipcMain.handle('websocket:connect', () => {
    wsService.connect();
    return true;
  });

  // Disconnect WebSocket
  ipcMain.handle('websocket:disconnect', () => {
    wsService.disconnect();
    return true;
  });

  // Subscribe to ticker
  ipcMain.handle('websocket:subscribe', (_event, ticker: string) => {
    wsService.subscribe(ticker);
    return true;
  });

  // Unsubscribe from ticker
  ipcMain.handle('websocket:unsubscribe', (_event, ticker: string) => {
    wsService.unsubscribe(ticker);
    return true;
  });

  // Get connection status
  ipcMain.handle('websocket:isConnected', () => {
    return wsService.isConnected();
  });

  // Get subscribed tickers
  ipcMain.handle('websocket:getSubscribed', () => {
    return wsService.getSubscribedTickers();
  });

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
