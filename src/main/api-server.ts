import Fastify from 'fastify';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { Database } from 'better-sqlite3';
import type { WatchlistService } from './services/watchlist-service.js';
import type { ScreenerService } from './services/screener-service.js';
import type { AnalysisService } from './services/analysis-service.js';
import type { ValidateAllService } from './services/validate-all-service.js';
import type { JobQueue } from './services/job-queue.js';
import type { DataProvider } from './services/data-provider.js';
import type { QuoteCache, FundamentalsCache } from './services/cache-service.js';
import type { TokenBucketRateLimiter } from './services/rate-limiter.js';
import { registerHealthRoutes } from './api/routes-health.js';
import { registerWatchlistRoutes } from './api/routes-watchlists.js';
import { registerQuotesRoutes } from './api/routes-quotes.js';
import { registerScreenerRoutes } from './api/routes-screener.js';
import { registerAnalysisRoutes } from './api/routes-analysis.js';
import { registerValidationRoutes } from './api/routes-validation.js';
import { registerFundamentalsRoutes } from './api/routes-fundamentals.js';
import { registerOptionsRoutes } from './api/routes-options.js';
import { registerJobsRoutes } from './api/routes-jobs.js';
import { registerSettingsRoutes } from './api/routes-settings.js';

const DATA_DIR = join(homedir(), '.tradeanalyzer');

function ensureDataDir() {
  mkdirSync(DATA_DIR, { recursive: true });
}

function readOrCreateToken(): string {
  const tokenPath = join(DATA_DIR, 'agent.token');
  if (existsSync(tokenPath)) {
    return readFileSync(tokenPath, 'utf8').trim();
  }
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  writeFileSync(tokenPath, token, { mode: 0o600 });
  return token;
}

function writePort(port: number) {
  writeFileSync(join(DATA_DIR, 'api.port'), String(port));
}

export interface ApiServerServices {
  db: Database;
  watchlistService: WatchlistService;
  screenerService: ScreenerService;
  analysisService: AnalysisService;
  validateAllService: ValidateAllService;
  jobQueue: JobQueue;
  dataProvider: DataProvider;
  quoteCache: QuoteCache;
  fundamentalsCache: FundamentalsCache;
  rateLimiter: TokenBucketRateLimiter;
  appVersion: string;
}

export class ApiServer {
  private fastify = Fastify({ logger: false });
  private token: string;
  private startTime = Date.now();

  constructor(private svc: ApiServerServices) {
    ensureDataDir();
    this.token = readOrCreateToken();
    this.registerRoutes();
  }

  private registerRoutes() {
    const { fastify, svc } = this;

    // Token auth — all routes except /health require Bearer token
    fastify.addHook('onRequest', async (req, reply) => {
      if (req.url === '/health') return;
      const auth = req.headers['authorization'] ?? '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (bearer !== this.token) {
        reply.code(401).send({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' });
      }
    });

    const getUptime = () => (Date.now() - this.startTime) / 1000;

    registerHealthRoutes(fastify, svc, getUptime);
    registerWatchlistRoutes(fastify, svc);
    registerQuotesRoutes(fastify, svc);
    registerScreenerRoutes(fastify, svc);
    registerAnalysisRoutes(fastify, svc);
    registerValidationRoutes(fastify, svc);
    registerFundamentalsRoutes(fastify, svc);
    registerOptionsRoutes(fastify, svc);
    registerJobsRoutes(fastify, svc);
    registerSettingsRoutes(fastify, svc);
  }

  async start(port: number): Promise<void> {
    await this.fastify.listen({ port, host: '127.0.0.1' });
    writePort(port);
    console.log(`[api-server] listening on 127.0.0.1:${port}`);
  }

  async stop(): Promise<void> {
    await this.fastify.close();
  }
}
