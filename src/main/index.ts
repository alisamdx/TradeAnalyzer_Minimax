import { app, BrowserWindow, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from './db/connection.js';
import { runMigrations, currentSchemaVersion } from './db/migrations.js';
import { WatchlistService } from './services/watchlist-service.js';
import { registerWatchlistIpc } from './ipc/ipc-watchlists.js';
import { ConstituentsService } from './services/constituents-service.js';
import { ScreenerService } from './services/screener-service.js';
import { PolygonDataProvider } from './services/polygon-provider.js';
import { QuoteCache, FundamentalsCache, initCacheTables } from './services/cache-service.js';
import { registerScreenerIpc } from './ipc/ipc-screener.js';
import { pruneOldLogsOnStartup } from './services/logger.js';
import { TokenBucketRateLimiter } from './services/rate-limiter.js';
import { JobQueue } from './services/job-queue.js';
import { AnalysisService } from './services/analysis-service.js';
import { ValidateAllService } from './services/validate-all-service.js';
import { registerAnalysisIpc } from './ipc/ipc-analysis.js';

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
  pruneOldLogsOnStartup();

  const dbPath = join(app.getPath('userData'), 'trade-analyzer.sqlite');
  const db = openDatabase(dbPath);
  const ran = runMigrations(db, migrationsDir());
  if (ran.length > 0) {
    console.log(`[migrations] applied ${ran.length} (head=${currentSchemaVersion(db)})`);
  }

  // Phase 1 — watchlist service.
  const watchlistService = new WatchlistService(db);
  watchlistService.ensureDefault();
  registerWatchlistIpc(watchlistService);

  // Phase 2 — market data services.
  initCacheTables(db);
  const dataProvider = new PolygonDataProvider();
  const quoteCache = new QuoteCache(db);
  new FundamentalsCache(db);

  // Constituents service (handles bundled CSV loading + Wikipedia refresh).
  const constituentsService = new ConstituentsService(db);
  // Bootstrap from bundled CSVs on first run so the DB has constituents.
  constituentsService.bootstrapFromBundled('sp500');
  constituentsService.bootstrapFromBundled('russell1000');

  // Screener service — needs a function to get constituents (local closure).
  const getConstituents = (u: Parameters<typeof constituentsService.getConstituents>[0]) =>
    constituentsService.getConstituents(u);
  const screenerService = new ScreenerService(db, dataProvider, getConstituents);

  registerScreenerIpc(screenerService, constituentsService, watchlistService, quoteCache, dataProvider);

  // Phase 3 — rate limiter + job queue + analysis + validate-all.
  const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 100 });
  const jobQueue = new JobQueue(db);
  const analysisService = new AnalysisService(db, dataProvider, rateLimiter, jobQueue);
  const validateAllService = new ValidateAllService(db, dataProvider, rateLimiter, jobQueue);

  registerAnalysisIpc(analysisService, validateAllService, jobQueue, watchlistService);

  // Check for incomplete runs from a previous session and surface in the renderer.
  // The renderer will prompt the user to resume or discard via the job IPC handlers.

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
