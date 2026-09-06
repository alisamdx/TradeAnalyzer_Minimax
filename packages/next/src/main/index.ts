import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { COLLECTOR_VERSION, DICTIONARY_VERSION } from '@tradeanalyzer/core';

/**
 * TradeAnalyzer 2 — main process.
 *
 * At B1 this is the shell only: a window, a preload bridge and the userData
 * separation. Generation open/close, the worker thread, the job runner and the
 * deep-link handler arrive with B2 onward (06 §3).
 */

// 06 §3: userData is `trade-analyzer-next`, deliberately NOT the productName
// default ("TradeAnalyzer 2"), so this exe's settings, logs and window state can
// never collide with the existing app's `trade-analyzer/` directory. Both are
// installed and running at the same time all through stage 1.
app.setPath('userData', join(app.getPath('appData'), 'trade-analyzer-next'));

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    autoHideMenuBar: true,
    title: 'TradeAnalyzer 2',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  window.on('ready-to-show', () => window.show());

  // External links open in the real browser, never in an app window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devServerUrl) void window.loadURL(devServerUrl);
  else void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  console.log(
    `[next] TradeAnalyzer 2 v${app.getVersion()} — core ${COLLECTOR_VERSION}, dictionary ${DICTIONARY_VERSION}`
  );
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
