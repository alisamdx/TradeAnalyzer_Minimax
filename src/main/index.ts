import { app, BrowserWindow, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { ApiServer } from './api-server.js';
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
import { registerValidateIpc } from './ipc/ipc-validate.js';
import { registerSettingsIpc, registerDiagnosticsIpc } from './ipc/ipc-settings.js';
import { registerCacheIpc } from './ipc/ipc-cache.js';

import { registerHistoricalIpc } from './ipc/ipc-historical.js';
import { registerLeapsCspIpc } from './ipc/ipc-leaps-csp.js';
import { registerPortfolioIpc } from './ipc/ipc-portfolio.js';
import { registerBriefingIpc } from './ipc/ipc-briefing.js';
import { registerAlertsIpc } from './ipc/ipc-alerts.js';
import { registerOptionsIpc } from './ipc/ipc-options.js';
import { registerTestApiIpc } from './ipc/ipc-test-api.js';
import { registerETradeIpc } from './ipc/ipc-etrade.js';
import { secureGet, migratePlaintextSecrets } from './services/secure-settings.js';
import type { OptionsProvider } from './services/options-provider.js';
import { ETradeDataProvider } from './services/etrade-data-provider.js';
import { AgentDbService } from './services/agent-db-service.js';
import { registerAgentIpc } from './ipc/ipc-agent.js';
import { BacktestEngine } from './services/backtest-engine.js';
import { registerBacktestIpc } from './ipc/ipc-backtest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let _apiServer: ApiServer | null = null;

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
    fullscreen: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.cjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    },
    title: `Trade Analyzer - Minmax v${appVersion()}`
  });

  win.on('ready-to-show', () => {
    win.maximize();
    win.show();
  });
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

// API key retrieval helper - used by multiple services
function getApiKey(db: ReturnType<typeof openDatabase>): string {
  try {
    const val = secureGet(db, 'polygonApiKey');
    if (val) return val;
  } catch (err) {
    // Table might not exist yet
  }

  if (process.env['POLYGON_API_KEY']) {
    return process.env['POLYGON_API_KEY'];
  }

  try {
    const envPath = join(app.getAppPath(), '.env');
    if (existsSync(envPath)) {
      const text = readFileSync(envPath, 'utf8');
      for (const line of text.split('\n')) {
        const [k, ...rest] = line.split('=');
        if (k?.trim() === 'POLYGON_API_KEY') {
          return rest.join('=').trim().replace(/['"]/g, '');
        }
      }
    }
  } catch {
    // Ignore
  }

  return '';
}

// Repair watchlist_items if it was created before the migration system (missing watchlist_id).
// Uses SQLite's table-rename dance because ALTER TABLE can't add NOT NULL without a default.
function repairWatchlistItems(db: ReturnType<typeof openDatabase>): void {
  type ColInfo = { name: string };
  const cols = db.prepare("PRAGMA table_info(watchlist_items)").all() as ColInfo[];
  if (cols.length === 0 || cols.some(c => c.name === 'watchlist_id')) return;

  console.log('[repair] watchlist_items missing watchlist_id — recreating table');

  // Ensure there is at least one watchlist to attach orphaned items to.
  const firstWatchlist = db.prepare(
    'SELECT id FROM watchlists ORDER BY is_default DESC, id ASC LIMIT 1'
  ).get() as { id: number } | undefined;
  const fallbackId = firstWatchlist?.id ?? null;

  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE watchlist_items_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        watchlist_id INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
        ticker TEXT NOT NULL,
        notes TEXT,
        added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);

    if (fallbackId !== null) {
      // Copy rows that exist in the old table, assigning them all to the fallback watchlist.
      // Only copy columns that definitely exist in the old schema.
      const oldCols = (db.prepare("PRAGMA table_info(watchlist_items)").all() as ColInfo[]).map(c => c.name);
      const ticker  = oldCols.includes('ticker')   ? 'ticker'   : "''";
      const notes   = oldCols.includes('notes')    ? 'notes'    : 'NULL';
      const addedAt = oldCols.includes('added_at') ? 'added_at' : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
      db.exec(`
        INSERT INTO watchlist_items_new (watchlist_id, ticker, notes, added_at)
        SELECT ${fallbackId}, ${ticker}, ${notes}, ${addedAt}
        FROM watchlist_items;
      `);
    }

    db.exec('DROP TABLE watchlist_items;');
    db.exec('ALTER TABLE watchlist_items_new RENAME TO watchlist_items;');
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlist_items_unique
        ON watchlist_items (watchlist_id, upper(ticker));
      CREATE INDEX IF NOT EXISTS idx_watchlist_items_watchlist
        ON watchlist_items (watchlist_id);
    `);
    db.exec('COMMIT');
    console.log('[repair] watchlist_items recreated successfully');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

app.whenReady().then(() => {
  pruneOldLogsOnStartup();

  // Store database in project folder for portability
  const dbPath = join(app.getAppPath(), 'data', 'trade-analyzer.sqlite');
  const db = openDatabase(dbPath);
  const ran = runMigrations(db, migrationsDir());
  if (ran.length > 0) {
    console.log(`[migrations] applied ${ran.length} (head=${currentSchemaVersion(db)})`);
  }
  repairWatchlistItems(db);

  // Encrypt any plain-text secrets left from before safeStorage was introduced.
  migratePlaintextSecrets(db);

  // Phase 1 — watchlist service.
  const watchlistService = new WatchlistService(db);
  watchlistService.ensureDefault();

  // Phase 2 — market data services.
  initCacheTables(db);
  const dataProvider = new PolygonDataProvider(() => getApiKey(db));
  const quoteCache = new QuoteCache(db);
  new FundamentalsCache(db);

  // Options provider selection (read from DB; chosen at startup).
  // 'polygon' → uses PolygonDataProvider (already created above).
  // 'etrade'  → uses ETradeDataProvider with live credentials from DB.
  const optionsProviderSetting = (() => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'optionsProvider'").get() as { value?: string } | undefined;
    return row?.value ?? 'polygon';
  })();

  let optionsProvider: OptionsProvider;
  if (optionsProviderSetting === 'etrade') {
    const etradeCredsFactory = () => ({
      consumerKey:    secureGet(db, 'etradeConsumerKey'),
      consumerSecret: secureGet(db, 'etradeConsumerSecret'),
      accessToken:    secureGet(db, 'etradeAccessToken'),
      accessSecret:   secureGet(db, 'etradeAccessSecret'),
    });
    optionsProvider = new ETradeDataProvider(etradeCredsFactory);
    console.log('[options] provider = E*Trade');
  } else {
    optionsProvider = dataProvider; // PolygonDataProvider implements OptionsProvider
    console.log('[options] provider = Polygon');
  }

  // Register watchlist IPC with data provider for ticker validation
  registerWatchlistIpc(watchlistService, dataProvider);

  // Constituents service (handles bundled CSV loading + Wikipedia refresh).
  const constituentsService = new ConstituentsService(db);
  // Bootstrap from bundled CSVs on first run so the DB has constituents.
  constituentsService.bootstrapFromBundled('sp500');
  constituentsService.bootstrapFromBundled('russell1000');

  // Screener service — needs a function to get constituents (local closure).
  const getConstituents = (u: Parameters<typeof constituentsService.getConstituents>[0]) =>
    constituentsService.getConstituents(u);
  const screenerService = new ScreenerService(db, dataProvider, getConstituents);

  registerScreenerIpc(screenerService, constituentsService, watchlistService, quoteCache, new FundamentalsCache(db), dataProvider);

  // Phase 3 — rate limiter + job queue + analysis + validate-all.
  const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 100 });
  const jobQueue = new JobQueue(db);
  const analysisService = new AnalysisService(db, dataProvider, rateLimiter, jobQueue, optionsProvider);
  const validateAllService = new ValidateAllService(db, dataProvider, rateLimiter, jobQueue);

  registerAnalysisIpc(analysisService, validateAllService, jobQueue, watchlistService);
  registerValidateIpc(validateAllService, watchlistService);
  registerSettingsIpc(db, rateLimiter);
  registerDiagnosticsIpc(db, quoteCache, new FundamentalsCache(db));
  registerCacheIpc(db);

  // Phase 4 - Historical data IPC
  registerHistoricalIpc(db, () => getApiKey(db));

  // Phase 6 - Portfolio tracking IPC
  registerPortfolioIpc(db);

  // Phase 7 - Morning Briefing IPC
  registerBriefingIpc(db, () => getApiKey(db), rateLimiter);

  // Phase 8 - Alerts System IPC
  registerAlertsIpc(db);

  // Options Chain view
  registerOptionsIpc(optionsProvider, quoteCache, rateLimiter);

  // Test API diagnostic screen
  registerTestApiIpc(dataProvider);

  // E*Trade auth / credential management IPC
  registerETradeIpc(db);

  // LEAPS + CSP strategy screener
  registerLeapsCspIpc(db, dataProvider, optionsProvider, rateLimiter);

  // v0.13.0 — Backtesting engine
  const backtestEngine = new BacktestEngine(db);
  registerBacktestIpc(backtestEngine);

  // v0.12.0 — TraderAgent integration
  const agentDb = new AgentDbService();
  // Open the agent DB if a path is already saved in settings
  const agentDbPathRow = db.prepare("SELECT value FROM settings WHERE key = 'agentDbPath'").get() as { value?: string } | undefined;
  if (agentDbPathRow?.value) agentDb.open(agentDbPathRow.value);
  registerAgentIpc(agentDb);

  // Local HTTP API server for the external trading agent.
  const apiPort = (() => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'apiServerPort'").get() as { value?: string } | undefined;
    return parseInt(row?.value ?? '7432', 10) || 7432;
  })();
  _apiServer = new ApiServer({
    db,
    watchlistService,
    screenerService,
    analysisService,
    validateAllService,
    jobQueue,
    dataProvider,
    quoteCache,
    fundamentalsCache: new FundamentalsCache(db),
    rateLimiter,
    appVersion: app.getVersion()
  });
  _apiServer.start(apiPort).catch((err) => {
    console.error('[api-server] failed to start:', err);
  });

  // Check for incomplete runs from a previous session and surface in the renderer.
  // The renderer will prompt the user to resume or discard via the job IPC handlers.

  // In headless mode (TRADEANALYZER_HEADLESS=1) skip creating a window.
  if (process.env['TRADEANALYZER_HEADLESS'] === '1') {
    console.log('[headless] running without UI — API server only');
    return;
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  _apiServer?.stop().catch(console.error);
});
