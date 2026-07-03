import { app, BrowserWindow, shell, powerSaveBlocker, Notification } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { ApiServer } from './api-server.js';
import { openDatabase } from './db/connection.js';
import { runMigrations, currentSchemaVersion } from './db/migrations.js';
import { WatchlistService } from './services/watchlist-service.js';
import { runAutoBackupIfDue, defaultBackupSources } from './services/backup-service.js';
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
import { registerCollaredLeapsIpc } from './ipc/ipc-collared-leaps.js';
import { registerPortfolioIpc } from './ipc/ipc-portfolio.js';
import { ConvictionService } from './services/conviction-service.js';
import { registerConvictionIpc } from './ipc/ipc-conviction.js';
import { registerOpportunityIpc } from './ipc/ipc-opportunity.js';
import { OpportunityService } from './services/opportunity-service.js';
import { registerAlertsIpc } from './ipc/ipc-alerts.js';
import { registerOptionsIpc } from './ipc/ipc-options.js';
import { registerTestApiIpc } from './ipc/ipc-test-api.js';
import { registerETradeIpc, probeETradeConnection } from './ipc/ipc-etrade.js';
import { secureGet, migratePlaintextSecrets } from './services/secure-settings.js';
import type { OptionsProvider } from './services/options-provider.js';
import { ETradeDataProvider } from './services/etrade-data-provider.js';
import { AgentDbService } from './services/agent-db-service.js';
import { registerAgentIpc } from './ipc/ipc-agent.js';
import { BacktestEngine } from './services/backtest-engine.js';
import { registerBacktestIpc } from './ipc/ipc-backtest.js';
import { registerFiltersIpc } from './ipc/ipc-filters.js';
import { registerPayoffIpc } from './ipc/ipc-payoff.js';
import { registerRollIpc } from './ipc/ipc-roll.js';
import { MarketDataProvider } from './services/marketdata-provider.js';
import { IVolatilityProvider } from './services/ivolatility-provider.js';
import { IvHistoryService } from './services/iv-history-service.js';
import { registerIvHistoryIpc } from './ipc/ipc-iv-history.js';
import { registerStrategyLabIpc } from './ipc/ipc-strategy-lab.js';
import { registerPretradeValidatorIpc } from './ipc/ipc-pretrade-validator.js';
import { BatchService } from './services/batch-service.js';
import { DailyIvCaptureJob } from './services/jobs/daily-iv-capture.js';
import { MarketSyncJob } from './services/jobs/market-sync-job.js';
import { ConstituentsRefreshJob } from './services/jobs/constituents-refresh-job.js';
import { PriceGapFillJob } from './services/jobs/price-gap-fill-job.js';
import { DailyScreenerJob } from './services/jobs/daily-screener-job.js';
import { registerBatchIpc } from './ipc/ipc-batch.js';
import { ScoringService } from './services/scoring-service.js';
import { registerScoringIpc } from './ipc/ipc-scoring.js';
import { DailyIntelligenceBriefJob } from './services/jobs/daily-intelligence-brief-job.js';
import { EmailService } from './services/email-service.js';
import { DailyTechnicalSignalsJob } from './services/jobs/daily-technical-signals-job.js';
import { DailyOptionsSnapshotJob } from './services/jobs/daily-options-snapshot-job.js';
import { DailyOptionsPremiumHistoryJob } from './services/jobs/daily-options-premium-history-job.js';
import { DailyPaperSnapshotJob } from './services/jobs/daily-paper-snapshot-job.js';
import { FiltersPrefillJob } from './services/jobs/filters-prefill-job.js';
import { PaperTradingService } from './services/paper-trading-service.js';
import { registerPaperTradingIpc } from './ipc/ipc-paper-trading.js';
import { StrategyLabService } from './services/strategy-lab-service.js';
import { CriticService } from './services/critic-service.js';
import { NewsDataFetcher } from './services/news-data-fetcher.js';
import { NewsAIService } from './services/news-ai-service.js';
import { registerNewsIpc } from './ipc/ipc-news.js';
import { EarningsService } from './services/earnings-service.js';
import { registerEarningsIpc } from './ipc/ipc-earnings.js';
import { EarningsRefreshJob } from './services/jobs/earnings-refresh-job.js';
import { BatchOrchestratorJob } from './services/jobs/batch-orchestrator-job.js';
import { BetaService } from './services/beta-service.js';
import { BriefReplayService } from './services/brief-replay-service.js';
import { registerBriefReplayIpc } from './ipc/ipc-brief-replay.js';
import { ExecutionEngine, type ExecNotifier } from './execution/execution-engine.js';
import { RiskGovernor } from './execution/risk-governor.js';
import { resolveBrokerSettings, createExecutionBroker } from './execution/broker-factory.js';
import { ExecutionControlApi } from './execution/control-api.js';
import { registerExecutionIpc } from './ipc/ipc-execution.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let _apiServer: ApiServer | null = null;
let _etradeKeepAlive: NodeJS.Timeout | null = null;

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

// ─── Single instance lock ─────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

app.whenReady().then(() => {
  pruneOldLogsOnStartup();

  // Dev: store DB in project folder for portability.
  // Production: store in userData (writable; app.getAppPath() is inside the read-only ASAR in packaged builds).
  const dbPath = app.isPackaged
    ? join(app.getPath('userData'), 'trade-analyzer.sqlite')
    : join(app.getAppPath(), 'data', 'trade-analyzer.sqlite');
  const db = openDatabase(dbPath);
  const ran = runMigrations(db, migrationsDir());
  if (ran.length > 0) {
    console.log(`[migrations] applied ${ran.length} (head=${currentSchemaVersion(db)})`);
  }
  repairWatchlistItems(db);

  // Encrypt any plain-text secrets left from before safeStorage was introduced.
  migratePlaintextSecrets(db);

  // Scheduled auto-backup (EP-11): if enabled in Settings and the interval has elapsed, write a
  // zip to userData/backups/auto. Fire-and-forget so it never blocks startup.
  void runAutoBackupIfDue(
    db,
    app.getVersion(),
    join(app.getPath('userData'), 'backups'),
    defaultBackupSources(app.getAppPath(), app.getPath('userData'))
  )
    .then((r) => {
      if (r.ran) console.log(`[backup] auto-backup written: ${r.zipPath}`);
      else if (r.reason === 'error') console.warn(`[backup] auto-backup failed: ${r.error}`);
    })
    .catch((e) => console.warn('[backup] auto-backup error:', e instanceof Error ? e.message : e));

  // Phase 1 — watchlist service.
  const watchlistService = new WatchlistService(db);
  watchlistService.ensureDefault();

  // Phase 2 — market data services.
  initCacheTables(db);
  const betaService = new BetaService(db);
  const dataProvider = new PolygonDataProvider(
    () => getApiKey(db),
    undefined,
    (ticker) => betaService.getBeta(ticker),
  );
  const quoteCache = new QuoteCache(db);
  new FundamentalsCache(db);

  // Options provider is always E*Trade — Polygon Options subscription is not needed.
  // Polygon DataProvider handles stocks/fundamentals/bars; E*Trade handles all options.
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('optionsProvider', 'etrade')").run();
  const etradeCredsFactory = () => ({
    consumerKey:    secureGet(db, 'etradeConsumerKey'),
    consumerSecret: secureGet(db, 'etradeConsumerSecret'),
    accessToken:    secureGet(db, 'etradeAccessToken'),
    accessSecret:   secureGet(db, 'etradeAccessSecret'),
  });
  const optionsProvider: OptionsProvider = new ETradeDataProvider(etradeCredsFactory);
  console.log('[options] provider = E*Trade (enforced)');

  // Register watchlist IPC with data provider for ticker validation
  registerWatchlistIpc(watchlistService, dataProvider);

  // Constituents service (handles bundled CSV loading + Wikipedia refresh).
  const constituentsService = new ConstituentsService(db);
  // Bootstrap from bundled CSVs on first run so the DB has constituents.
  constituentsService.bootstrapFromBundled('sp500');
  constituentsService.bootstrapFromBundled('russell1000');
  constituentsService.bootstrapFromBundled('etf');

  // Screener service — needs a function to get constituents (local closure).
  const getConstituents = (u: Parameters<typeof constituentsService.getConstituents>[0]) =>
    constituentsService.getConstituents(u);
  const screenerService = new ScreenerService(db, dataProvider, getConstituents);

  registerScreenerIpc(screenerService, constituentsService, watchlistService, quoteCache, new FundamentalsCache(db), dataProvider, db, optionsProvider);

  // Phase 3 — rate limiter + job queue + analysis + validate-all.
  const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 100 });
  const jobQueue = new JobQueue(db);
  const analysisService = new AnalysisService(db, dataProvider, rateLimiter, jobQueue, optionsProvider);
  const validateAllService = new ValidateAllService(db, dataProvider, rateLimiter, jobQueue, optionsProvider);

  registerAnalysisIpc(analysisService, validateAllService, jobQueue, watchlistService);
  registerValidateIpc(validateAllService, watchlistService);
  registerSettingsIpc(db, rateLimiter);
  registerDiagnosticsIpc(db, quoteCache, new FundamentalsCache(db));
  registerCacheIpc(db);

  // Phase 4 - Historical data IPC
  registerHistoricalIpc(db, () => getApiKey(db));

  // Phase 6 - Portfolio tracking IPC (+ Phase 1–3 AI Portfolio Advisor)
  registerPortfolioIpc(db, analysisService, optionsProvider);
  // Conviction IPC registered after emailService is constructed (see below) — it needs it
  // for the "email my stocks" feature.

  // ENH-2 - Opportunity Dashboard
  const opportunityService = new OpportunityService(db, getConstituents);
  registerOpportunityIpc(opportunityService);

  // Phase 8 - Alerts System IPC
  registerAlertsIpc(db);
  const filterTemplatesService = registerFiltersIpc(db, dataProvider, optionsProvider, quoteCache, new FundamentalsCache(db), constituentsService);

  // Payoff Visualizer — saved strategy CRUD
  registerPayoffIpc(db);
  registerRollIpc(optionsProvider);

  // v0.17.0 — IV History: IVolatility.com provides true as-of-date daily IVX snapshots.
  // MarketData.app is kept for Test API diagnostics only (not used for backfill).
  const marketdataProvider = new MarketDataProvider(
    () => { try { return secureGet(db, 'marketdataApiToken'); } catch { return ''; } }
  );
  const ivolatilityProvider = new IVolatilityProvider(
    () => { try { return secureGet(db, 'ivolatilityApiKey'); } catch { return ''; } }
  );
  const ivHistoryService = new IvHistoryService(db, ivolatilityProvider, getConstituents);
  registerIvHistoryIpc(ivHistoryService);
  // Give the screener and filter templates access to iv_history.
  screenerService.setIvHistoryService(ivHistoryService);
  filterTemplatesService.setIvHistoryService(ivHistoryService);

  // Options Chain view (passes IV capture callback for E*Trade auto-capture)
  registerOptionsIpc(optionsProvider, quoteCache, rateLimiter,
    (ticker, contracts, underlyingPx) => ivHistoryService.captureFromEtradeChain(ticker, contracts, underlyingPx));

  // Test API diagnostic screen
  registerTestApiIpc(dataProvider, db, marketdataProvider, ivolatilityProvider);

  // E*Trade auth / credential management IPC
  registerETradeIpc(db);

  // E*Trade keep-alive. Tokens go dormant after ~2h idle; a day of Polygon-only work
  // (screener/filters) lets the token lapse, so the after-close batch would hit a dormant
  // token. Ping E*Trade every ~90 min (well inside the 2h window) to keep it warm — and,
  // with renewal fixed (v1.1.99), auto-revive it if it did lapse. Only acts on a date-valid
  // token; a midnight-expired one is left for manual re-auth (no spam). See CLAUDE.md.
  _etradeKeepAlive = setInterval(() => {
    void probeETradeConnection(db).then(r => {
      if (r.status === 'renewed')      console.log('[etrade] keep-alive revived a dormant token');
      else if (r.status === 'expired') console.warn('[etrade] keep-alive: token needs manual re-auth');
      // ok / no_token / no_credentials / error → stay quiet
    }).catch(() => { /* best-effort keep-alive */ });
  }, 90 * 60 * 1000);

  // Strategy Lab — score / explore all 31 strategies for a single ticker
  registerStrategyLabIpc(db, dataProvider, optionsProvider);

  // Pre-Trade Validator — verdict a hand-built Payoff structure before placing it
  registerPretradeValidatorIpc(db, dataProvider, optionsProvider);

  // v0.21.0 — Batch job scheduler
  // Use a getter so callbacks always send to the current window (created later).
  const getMainWindow = () => BrowserWindow.getAllWindows()[0] ?? null;
  const batchService = new BatchService(
    db,
    (notification) => getMainWindow()?.webContents.send('app:notification', notification),
    (evt) => getMainWindow()?.webContents.send('batch:progress', evt)
  );
  const dailyIvJob = new DailyIvCaptureJob(
    db,
    optionsProvider as ETradeDataProvider,
    ivHistoryService,
    constituentsService
  );
  batchService.registerJob('daily-iv-update', dailyIvJob);

  // Constituents refresh — first sub-job in the orchestrator sequence (sequence 2,
  // right after the orchestrator itself; migration 063 shifted the others by +1) so
  // Market Sync and everything downstream see today's S&P 500 / Russell 1000 membership.
  // Newly added index members get 1Y of Polygon price history bootstrapped immediately.
  const constituentsRefreshJob = new ConstituentsRefreshJob(db, constituentsService, () => getApiKey(db));
  batchService.registerJob('constituents-refresh', constituentsRefreshJob, {
    sequenceOrder: 2,
    dailyScheduleTime: '16:25',   // legacy display only — the orchestrator drives the schedule
    dailyScheduleEnabled: false,
    runOnStartup: false,
  });

  // Market sync jobs — populate quote_cache + fundamentals_cache post-market.
  // Both jobs share the one-at-a-time mutex so they chain sequentially:
  //   16:30 → stocks (~30-40 min) → finishes → ETFs starts automatically
  //   → ETFs done → gap fill starts automatically (same scheduler tick).
  const marketSyncStocksJob = new MarketSyncJob(screenerService, 'both');
  batchService.registerJob('daily-market-sync-stocks', marketSyncStocksJob, {
    dailyScheduleTime: '16:30',
    startupDelaySeconds: 60,   // give IV update (30 s delay) a head start on startup
  });

  const marketSyncEtfsJob = new MarketSyncJob(screenerService, 'etf');
  batchService.registerJob('daily-market-sync-etfs', marketSyncEtfsJob, {
    dailyScheduleTime: '16:30', // same time — runs after stocks finishes (mutex chains them)
    startupDelaySeconds: 90,
  });

  // Daily Screener — runs after both Market Sync jobs so caches are warm.
  // Writes two screen_runs rows (stocks strict + ETFs soft) that the Daily Brief
  // and Options Snapshot read from instead of a stale manual screener run.
  const dailyScreenerJob = new DailyScreenerJob(db, screenerService);
  batchService.registerJob('daily-screener', dailyScreenerJob, {
    dailyScheduleTime: '16:30', // chains after Market Sync ETFs — same schedule slot
    startupDelaySeconds: 110,   // after ETF sync (90 s) with a small buffer
    runOnStartup: false,
  });

  const priceGapFillJob = new PriceGapFillJob(db, () => getApiKey(db));
  batchService.registerJob('daily-price-gap-fill', priceGapFillJob, {
    dailyScheduleTime: '16:30', // same time — chains after screener
    startupDelaySeconds: 120,
  });

  registerBatchIpc(batchService, getMainWindow);
  batchService.startScheduler();
  batchService.runStartupJobs().catch(err => console.error('[batch] startup error:', err));

  // v0.22.7 — Trade Scoring Engine + Daily Intelligence Brief
  const scoringService = new ScoringService(db);
  scoringService.seedBaselines();

  const emailService = new EmailService(
    () => { try { return secureGet(db, 'agentProjectPath') ?? ''; } catch { return ''; } }
  );
  registerScoringIpc(scoringService, emailService);
  registerConvictionIpc(new ConvictionService(db), emailService);

  // v0.32.89 — Brief Replay (point-in-time scoring back-test)
  const briefReplayService = new BriefReplayService(db, scoringService);
  registerBriefReplayIpc(briefReplayService);

  // v2 execution subsystem. The engine is assembled behind the ExecutionBroker seam and
  // starts `stopped`: constructing it opens no broker connection and places no orders.
  // Phase 6: the broker is chosen by the factory — MockExecutionBroker by default, the
  // IbkrExecutionBroker (live TWS/Gateway) when TA_EXEC_BROKER=ibkr. Paper vs live is just
  // the connection port (mode from exec_config), never an engine/UI change.
  const execCfg = new RiskGovernor(db).getConfig();
  const execMode = execCfg.executionMode;
  // Settings-driven selection (07-broker-alternatives §3): the persisted paper/live broker choice,
  // with TA_EXEC_BROKER env still overriding for dev/tests.
  const brokerSettings = resolveBrokerSettings(execMode, process.env, {
    paperBroker: execCfg.paperBroker,
    liveBroker: execCfg.liveBroker,
  });
  const executionBroker = createExecutionBroker(brokerSettings);
  console.log(
    `[execution] broker=${brokerSettings.kind} mode=${execMode}` +
      (brokerSettings.kind === 'ibkr' ? ` @ ${brokerSettings.host}:${brokerSettings.port}` : '') +
      (brokerSettings.kind === 'tradier' ? ` @ ${brokerSettings.tradier.env}` : '')
  );
  // Notifications for unattended operation (spec 08 §2.5): per-action OS push (gated by
  // exec_config.notify_push) + email (when SMTP is configured). The engine gates notify_per_action.
  const execNotifier: ExecNotifier = {
    notify: async (n) => {
      const pushOn =
        (db.prepare('SELECT notify_push AS v FROM exec_config WHERE id = 1').get() as { v: number } | undefined)?.v === 1;
      if (pushOn && Notification.isSupported()) {
        try { new Notification({ title: n.title, body: n.body }).show(); } catch { /* push best-effort */ }
      }
      if (emailService.isConfigured()) {
        try { await emailService.send(n.title, n.html ?? `<p>${n.body}</p>`); }
        catch (e) { console.error('[execution] email notify failed:', e instanceof Error ? e.message : e); }
      }
    },
  };
  // Keep the machine awake while armed (running + unattended + paper) so an all-day run survives
  // OS sleep (spec 08 §2.6); released on disarm/stop.
  let armedBlockerId: number | null = null;
  const onArmedChange = (armed: boolean): void => {
    if (armed && armedBlockerId == null) {
      armedBlockerId = powerSaveBlocker.start('prevent-display-sleep');
      console.log('[execution] armed — OS sleep blocked');
    } else if (!armed && armedBlockerId != null) {
      powerSaveBlocker.stop(armedBlockerId);
      armedBlockerId = null;
      console.log('[execution] disarmed — OS sleep allowed');
    }
  };
  const executionEngine = new ExecutionEngine(db, executionBroker, {
    notifier: execNotifier,
    enableCycleLoop: true, // start the management/entry loop when the engine goes running
    onArmedChange,
  });
  executionEngine.onEvent((evt) => getMainWindow()?.webContents.send('execution:event', evt));
  registerExecutionIpc(executionEngine);

  // Boot reconciliation (force-stopped-on-boot): engine_state is persisted, but the broker
  // connection + cycle loop are process-local and are NOT restored on restart. Without this, a
  // relaunch leaves the engine showing armed+running while actually inert (no connection, no
  // loop) — it would silently take no trades. Reset any persisted running/paused to stopped so
  // the operator must explicitly Start (which reconnects) after every restart.
  if (executionEngine.reconcileStateOnBoot()) {
    console.log('[execution] persisted running/paused state reset to stopped on boot — Start to reconnect');
  }

  // Headless control API on 127.0.0.1:7433 (token-authed, agent.token). Lets an external
  // operator/agent read live engine state — broker (mock vs ibkr), engine-state, automation_mode,
  // armed — and drive control while the window is closed. /exec/state now carries broker +
  // automationMode + armed via the engine facade's getState().
  const executionControlApi = new ExecutionControlApi({
    db,
    core: executionEngine.core,
    governor: executionEngine.governor,
    brokerKind: brokerSettings.kind,
    getStateView: () => executionEngine.getState(),
  });
  executionControlApi.start(7433)
    .then(() => console.log('[execution] control API listening on 127.0.0.1:7433'))
    .catch((e) => console.error('[execution] control API failed to start:', e instanceof Error ? e.message : e));
  app.on('will-quit', () => { void executionControlApi.stop(); });

  const technicalSignalsJob = new DailyTechnicalSignalsJob(db);
  batchService.registerJob('daily-technical-signals', technicalSignalsJob, {
    dailyScheduleTime: '16:30',  // chains after price-gap-fill so bars are fresh
    startupDelaySeconds: 150,    // after gap fill (120 s delay + buffer)
    runOnStartup: false,
  });
  const paperTradingService = new PaperTradingService(db);

  // Earnings calendar service + E*Trade creds factory — needed here by the brief
  // job's per-pick earnings fallback; also used by the earnings IPC/job below.
  const earningsService = new EarningsService(db);
  const getEtradeCreds = (): (import('./services/etrade-auth.js').OAuthCredentials & { tokenDate: string | null }) | null => {
    const accessToken  = secureGet(db, 'etradeAccessToken');
    const accessSecret = secureGet(db, 'etradeAccessSecret');
    if (!accessToken || !accessSecret) return null;
    return {
      consumerKey:    secureGet(db, 'etradeConsumerKey') ?? '',
      consumerSecret: secureGet(db, 'etradeConsumerSecret') ?? '',
      accessToken,
      accessSecret,
      tokenDate: secureGet(db, 'etradeTokenDate'),
    };
  };

  const briefJob = new DailyIntelligenceBriefJob(
    db, dataProvider, optionsProvider, emailService, paperTradingService,
    () => getMainWindow()?.webContents.send('watchlists:updated'),
    earningsService, getEtradeCreds,
  );
  batchService.registerJob('daily-intelligence-brief', briefJob, {
    dailyScheduleTime: '16:30',  // post-market, chains after price-gap-fill
    startupDelaySeconds: 0,      // manual trigger only by default; no startup run
    runOnStartup: false,
  });

  // Nightly Wheel analysis snapshot — keeps optionLiquidityScore fresh for the
  // Trade Scoring Engine so illiquid picks (OI=1) are caught by scoring, not just
  // by the hard gate in Stage 6 of the brief.
  // Runs at 06:00 ET (pre-market — OI reflects yesterday's close, which is stable).
  // Also runs once on startup after a 5-minute delay so E*Trade tokens have time
  // to load; a fresh snapshot beats any stale one from a prior session.
  const optionsSnapshotJob = new DailyOptionsSnapshotJob(db, analysisService, optionsProvider);
  batchService.registerJob('daily-options-snapshot', optionsSnapshotJob, {
    dailyScheduleTime: '06:00',
    startupDelaySeconds: 300,    // 5 min — allow E*Trade auth to initialise
    runOnStartup: true,
    afterCloseOnly: true,        // runs after the brief → skip in the lean intraday slot (spec 08 §4)
  });

  // Daily paper-trade price snapshots — runs after brief so today's prices are present.
  // Idempotent: safe to trigger manually any number of times during the day.
  const paperSnapshotJob = new DailyPaperSnapshotJob(db);
  batchService.registerJob('daily-paper-snapshot', paperSnapshotJob, {
    dailyScheduleTime: '17:00',    // after price-gap-fill (16:00) + brief (16:30)
    startupDelaySeconds: 0,
    runOnStartup: false,
    afterCloseOnly: true,          // forward perf tracking — skip in the lean intraday slot (spec 08 §4)
  });

  // LEAPS + CSP strategy screener
  registerLeapsCspIpc(db, dataProvider, optionsProvider, rateLimiter);

  // Collared LEAPS strategy screener
  registerCollaredLeapsIpc(db, dataProvider, optionsProvider, rateLimiter);

  // Paper Trading / Retrospect
  registerPaperTradingIpc(paperTradingService);

  // v0.13.0 — Backtesting engine
  const backtestEngine = new BacktestEngine(db);
  registerBacktestIpc(backtestEngine);

  // News & Research module
  const newsFetcher = new NewsDataFetcher(() => getApiKey(db), db);
  const newsAiService = new NewsAIService(db);
  registerNewsIpc(newsFetcher, rateLimiter, newsAiService);

  // Earnings calendar (earningsService + getEtradeCreds constructed earlier,
  // before the brief job — see v0.32.82 earnings fallback)
  registerEarningsIpc(earningsService, getEtradeCreds);

  // Earnings Refresh batch job — runs on startup (60s delay) + manually.
  // Covers all tickers across open positions + watchlists + conviction list.
  // 24h TTL is respected per ticker so most launches result in all skips.
  const earningsRefreshJob = new EarningsRefreshJob(db, earningsService, getEtradeCreds);
  batchService.registerJob('earnings-refresh', earningsRefreshJob, {
    runOnStartup: true,
    startupDelaySeconds: 60,          // after E*Trade tokens load from keychain
    dailyScheduleTime: '16:00',       // default schedule time (schedule disabled by default)
    afterCloseOnly: true,             // earnings dates are slow-moving → skip in the lean intraday slot (spec 08 §4)
    defaultConfig: { callDelayMs: 500 }, // conservative default — avoids E*Trade 429s
  });

  // Daily Options Premium History — captures durable, query-friendly option-premium
  // history (wheel CSP + income CSP/CC) for long-term ROC analysis. Registered last
  // among sub-jobs → highest sequence_order (runs at the bottom of the batch sequence,
  // after the 06:00 wheel snapshot so it can reuse that snapshot for wheel rows).
  // No startup run (heavy E*Trade pass); driven by the orchestrator / manual trigger.
  const optionsPremiumHistoryJob = new DailyOptionsPremiumHistoryJob(db, analysisService, optionsProvider);
  batchService.registerJob('daily-options-premium-history', optionsPremiumHistoryJob, {
    dailyScheduleTime: '07:00',   // after the 06:00 wheel snapshot (schedule disabled by default)
    startupDelaySeconds: 0,
    runOnStartup: false,
    afterCloseOnly: true,         // durable capture for future ROC → skip in the lean intraday slot (spec 08 §4)
    defaultConfig: { callDelayMs: 1100, maxTickers: 1500, captureWheel: true, captureIncome: true },
  });

  // Filters Prefill — precomputes every filter template over Universe = All so the
  // Filters view opens pre-populated. Registered after options-premium-history →
  // highest sequence_order (very last in the chain: it needs fresh caches, iv_history,
  // technical_signals, and earnings — and its Wheel (Vetted) leg hits E*Trade chains).
  const filtersPrefillJob = new FiltersPrefillJob(filterTemplatesService);
  batchService.registerJob('filters-prefill', filtersPrefillJob, {
    dailyScheduleTime: '17:30',   // legacy display only — the orchestrator drives the schedule
    dailyScheduleEnabled: false,
    runOnStartup: false,
    afterCloseOnly: true,         // evening slot only — skip in the lean intraday slot (spec 08 §4)
  });

  // Batch Orchestrator — registered last so all sub-jobs are already in batch_jobs.
  // Seeded at sequence_order=1 (migration 037 shifted all others by +1).
  // Reads its own schedule from config_json.scheduleSlots; daily_schedule_time
  // is set to '10:15' only for legacy display fallback.
  const orchestratorJob = new BatchOrchestratorJob(batchService, getEtradeCreds, emailService);
  const orchestratorSeedConfig = {
    scheduleSlots: [] as string[],
    validateEtradeToken: true,
    emailOnStart: true,
    jobs: batchService.getJobs().map(j => ({ id: j.id, enabled: true })),
  };
  batchService.registerJob('batch-orchestrator', orchestratorJob, {
    sequenceOrder: 1,
    runOnStartup: false,
    dailyScheduleEnabled: true,
    dailyScheduleTime: '10:15',
    defaultConfig: orchestratorSeedConfig,
  });

  // v0.12.0 — TraderAgent integration
  const agentDb = new AgentDbService();
  // Open the agent DB if a path is already saved in settings
  const agentDbPathRow = db.prepare("SELECT value FROM settings WHERE key = 'agentDbPath'").get() as { value?: string } | undefined;
  if (agentDbPathRow?.value) agentDb.open(agentDbPathRow.value);
  registerAgentIpc(agentDb, db);

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
    optionsProvider,
    quoteCache,
    fundamentalsCache: new FundamentalsCache(db),
    rateLimiter,
    strategyLabService: new StrategyLabService(dataProvider, optionsProvider),
    criticService: new CriticService(db),
    scoringService,
    batchService,
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

  // Launch automatically when the user logs into Windows.
  app.setLoginItemSettings({ openAtLogin: true });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (_etradeKeepAlive) { clearInterval(_etradeKeepAlive); _etradeKeepAlive = null; }
  _apiServer?.stop().catch(console.error);
});
