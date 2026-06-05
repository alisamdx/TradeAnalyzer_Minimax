import type { FastifyInstance } from 'fastify';
import type { ApiServerServices } from '../api-server.js';
import { apiOk, apiError, fromServiceError } from './helpers.js';
import { secureGet, secureSet } from '../services/secure-settings.js';

export function registerETradeRoutes(app: FastifyInstance, svc: ApiServerServices): void {
  // Returns consumer key/secret so the CLI login script can do the OAuth flow
  // without needing a separate config file.
  app.get('/etrade/credentials', async (_req, reply) => {
    try {
      const consumerKey    = secureGet(svc.db, 'etradeConsumerKey');
      const consumerSecret = secureGet(svc.db, 'etradeConsumerSecret');
      if (!consumerKey || !consumerSecret) {
        return apiError(reply, 'E*Trade consumer credentials not configured in Settings', 'NOT_CONFIGURED', 404);
      }
      return apiOk(reply, { consumerKey, consumerSecret });
    } catch (err) {
      const { message, code } = fromServiceError(err);
      return apiError(reply, message, code, 500);
    }
  });

  // Stores a freshly-obtained access token pair (from the CLI login script).
  // Tokens are encrypted via safeStorage before being persisted.
  app.post('/etrade/token', async (req, reply) => {
    try {
      const body = req.body as { accessToken?: string; accessSecret?: string };
      if (!body.accessToken || !body.accessSecret) {
        return apiError(reply, 'accessToken and accessSecret are required', 'INVALID_INPUT', 400);
      }
      secureSet(svc.db, 'etradeAccessToken',  body.accessToken);
      secureSet(svc.db, 'etradeAccessSecret', body.accessSecret);
      return apiOk(reply, { stored: true });
    } catch (err) {
      const { message, code } = fromServiceError(err);
      return apiError(reply, message, code, 500);
    }
  });
}
