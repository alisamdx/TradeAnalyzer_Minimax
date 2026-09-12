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

      const rateLimitRpm = parseInt(getSettingValue(db, 'rateLimitRpm') ?? '500', 10);
      const quoteCacheTtlSec = parseInt(getSettingValue(db, 'quoteCacheTtlSec') ?? String(TTL_SECONDS.QUOTE), 10);
      const fundamentalsCacheTtlSec = parseInt(getSettingValue(db, 'fundamentalsCacheTtlSec') ?? String(TTL_SECONDS.FUNDAMENTALS), 10);
      const optionsCacheTtlSec = parseInt(getSettingValue(db, 'optionsCacheTtlSec') ?? String(TTL_SECONDS.OPTIONS), 10);
      const logRetentionDays = parseInt(getSettingValue(db, 'logRetentionDays') ?? '30', 10);
      const defaultScreenerIndex = getSettingValue(db, 'defaultScreenerIndex') ?? 'both';
      const theme = getSettingValue(db, 'theme') ?? 'dark';
      const soundAlertsEnabled = (getSettingValue(db, 'soundAlertsEnabled') ?? 'true') !== 'false';
      // Included deliberately: it is a courtesy contact the SEC reads off every
      // request, not a secret, and having it here is what makes "did that
      // setting actually save" answerable without opening the database — which
      // from a redirected shell is exactly what must never be done.
      const edgarContact = getSettingValue(db, 'edgarContact') ?? null;

      return apiOk(reply, {
        rateLimitRpm,
        quoteCacheTtlSec,
        fundamentalsCacheTtlSec,
        optionsCacheTtlSec,
        logRetentionDays,
        defaultScreenerIndex,
        theme,
        soundAlertsEnabled,
        edgarContact
        // polygonApiKey intentionally omitted
      });
    } catch (err) {
      const { message, code } = fromServiceError(err);
      return apiError(reply, message, code, 500);
    }
  });
}
