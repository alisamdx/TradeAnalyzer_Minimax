import type { FastifyInstance } from 'fastify';
import { currentSchemaVersion } from '../db/migrations.js';
import type { ApiServerServices } from '../api-server.js';
import { apiOk } from './helpers.js';

function isMarketOpen(): boolean {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  // Convert to Eastern time (UTC-4 EDT / UTC-5 EST — approximate)
  const etOffset = -4 * 60; // EDT approximation
  const etMs = now.getTime() + etOffset * 60_000;
  const et = new Date(etMs);
  const hour = et.getUTCHours();
  const min = et.getUTCMinutes();
  const minutes = hour * 60 + min;
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

export function registerHealthRoutes(
  app: FastifyInstance,
  svc: ApiServerServices,
  getUptime: () => number
): void {
  app.get('/health', async (_request, reply) => {
    const schemaVersion = currentSchemaVersion(svc.db);
    return apiOk(reply, {
      appVersion: svc.appVersion,
      schemaVersion,
      marketOpen: isMarketOpen(),
      uptimeSeconds: getUptime()
    });
  });
}
