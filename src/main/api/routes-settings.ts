import type { FastifyInstance } from 'fastify';
import type { ApiServerServices } from '../api-server.js';
import { apiOk, fromServiceError, apiError } from './helpers.js';
import { TTL_SECONDS } from '../services/cache-service.js';

function getSettingValue(db: ApiServerServices['db'], key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function registerSettingsRoutes(app: FastifyInstance, svc: ApiServerServices): void {
  // GET /settings — read-only; never returns the API key
  app.get('/settings', async (_req, reply) => {
    try {
      const db = svc.db;

      const rateLimitRpm = parseInt(getSettingValue(db, 'rateLimitRpm') ?? '100', 10);
      const quoteCacheTtlSec = parseInt(getSettingValue(db, 'quoteCacheTtlSec') ?? String(TTL_SECONDS.QUOTE), 10);
      const fundamentalsCacheTtlSec = parseInt(getSettingValue(db, 'fundamentalsCacheTtlSec') ?? String(TTL_SECONDS.FUNDAMENTALS), 10);
      const optionsCacheTtlSec = parseInt(getSettingValue(db, 'optionsCacheTtlSec') ?? String(TTL_SECONDS.OPTIONS), 10);
      const logRetentionDays = parseInt(getSettingValue(db, 'logRetentionDays') ?? '30', 10);
      const defaultScreenerIndex = getSettingValue(db, 'defaultScreenerIndex') ?? 'sp500';
      const theme = getSettingValue(db, 'theme') ?? 'dark';
      const autoConnectWebSocket = (getSettingValue(db, 'autoConnectWebSocket') ?? 'true') !== 'false';
      const soundAlertsEnabled = (getSettingValue(db, 'soundAlertsEnabled') ?? 'true') !== 'false';

      return apiOk(reply, {
        rateLimitRpm,
        quoteCacheTtlSec,
        fundamentalsCacheTtlSec,
        optionsCacheTtlSec,
        logRetentionDays,
        defaultScreenerIndex,
        theme,
        autoConnectWebSocket,
        soundAlertsEnabled
        // polygonApiKey intentionally omitted
      });
    } catch (err) {
      const { message, code } = fromServiceError(err);
      return apiError(reply, message, code, 500);
    }
  });
}
