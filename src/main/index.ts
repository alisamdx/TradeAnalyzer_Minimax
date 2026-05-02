import { app, BrowserWindow, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from './db/connection.js';
import { runMigrations, currentSchemaVersion } from './db/migrations.js';
import { WatchlistService } from './services/watchlist-service.js';
import { registerWatchlistIpc } from './ipc/ipc-watchlists.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve migrations dir whether running from `out/main/index.js` (built)
// or via electron-vite dev (source). Both layouts have /migrations at repo root.
function migrationsDir(): string {
  // out/main/index.js → repo root is two parents up
  return join(__dirname, '..', '..', 'migrations');
}

function appVersion(): string {
  return app.getVersion();
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    },
    title: `TradeAnalyzer v${appVersion()}`
  });

  win.on('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  }
  return win;
}

app.whenReady().then(() => {
  const dbPath = join(app.getPath('userData'), 'trade-analyzer.sqlite');
  const db = openDatabase(dbPath);
  const ran = runMigrations(db, migrationsDir());
  if (ran.length > 0) {
    console.log(`[migrations] applied ${ran.length} (head=${currentSchemaVersion(db)})`);
  }
  const service = new WatchlistService(db);
  service.ensureDefault();
  registerWatchlistIpc(service);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
