import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { COLLECTOR_VERSION, DICTIONARY_VERSION } from '@tradeanalyzer/core';
import { closeGeneration, openGeneration } from './generation.js';
import { registerIpc } from './ipc.js';

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

/**
 * The window icon, for development only.
 *
 * A packaged Windows build takes its taskbar and title-bar icon from the
 * executable's own resource, which electron-builder writes from
 * `build/icon.ico` — so setting it here would be redundant there, and the path
 * would not resolve anyway once `out/` is inside `app.asar`. In `dev` there is
 * no executable resource, so without this the window wears the default Electron
 * icon and looks like a different app than the one that gets packaged.
 */
function devWindowIcon(): string | undefined {
  if (app.isPackaged) return undefined;
  const png = join(import.meta.dirname, '../../build/icon.png');
  return existsSync(png) ? png : undefined;
}

function createWindow(): void {
  const icon = devWindowIcon();
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    fullscreen: false,
    autoHideMenuBar: true,
    title: 'TradeAnalyzer 2',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  window.on('ready-to-show', () => {
    // Maximized on open, matching the existing app. `maximize()` rather than
    // `fullscreen: true`: fullscreen hides the title bar and the taskbar, which
    // is wrong for a tool meant to sit alongside the other app all day. The
    // 1400x900 above is only the restore-down size.
    window.maximize();
    window.show();
  });

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

  // The generation is opened before the window, so a failure here is a startup
  // error the operator sees rather than an empty UI that looks like no data.
  const generation = openGeneration();
  console.log(
    `[next] generation ${generation.generationNo} (${generation.status})` +
      `${generation.createdNow ? ' — created' : ''} at ${generation.dbPath}`
  );

  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  closeGeneration();
});
