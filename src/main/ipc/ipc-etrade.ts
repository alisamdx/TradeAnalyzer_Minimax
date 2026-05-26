/**
 * E*Trade IPC handlers — used by the Test API screen and future provider integration.
 *
 * Settings keys used (stored in the DB settings table):
 *   etradeConsumerKey    — from E*Trade developer portal
 *   etradeConsumerSecret — from E*Trade developer portal
 *   etradeAccessToken    — live access token (expires midnight ET)
 *   etradeAccessSecret   — live access token secret
 *   etradeRequestToken   — temp during OAuth flow
 *   etradeRequestSecret  — temp during OAuth flow
 */

import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import type { Database } from 'better-sqlite3';
import {
  getRequestToken,
  getAccessToken,
  renewAccessToken,
  type OAuthCredentials,
} from '../services/etrade-auth.js';
import { secureGet, secureSet } from '../services/secure-settings.js';
import {
  getETradeExpirations,
  getETradeOptionsChain,
  type ETradeExpiration,
  type ETradeOptionsChainResult,
} from '../services/etrade-options.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ok<T>(value: T): { ok: true; value: T } { return { ok: true, value }; }
function fail(err: unknown): { ok: false; error: { code: string; message: string } } {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof Error && 'code' in err ? (err as Error & { code: string }).code : 'UNKNOWN';
  return { ok: false, error: { code, message } };
}

function getCredentials(db: Database): OAuthCredentials {
  return {
    consumerKey:    secureGet(db, 'etradeConsumerKey'),
    consumerSecret: secureGet(db, 'etradeConsumerSecret'),
    accessToken:    secureGet(db, 'etradeAccessToken'),
    accessSecret:   secureGet(db, 'etradeAccessSecret'),
  };
}

export interface ETradeStatus {
  hasConsumerKey:    boolean;
  hasConsumerSecret: boolean;
  hasAccessToken:    boolean;
  isConfigured:      boolean;   // consumer key + secret present
  isAuthenticated:   boolean;   // access token present (may be expired)
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerETradeIpc(db: Database): void {

  /** Get current auth status + saved consumer key (never return secrets). */
  ipcMain.handle('etrade:get-status', (_e: IpcMainInvokeEvent) => {
    try {
      const consumerKey    = secureGet(db, 'etradeConsumerKey');
      const consumerSecret = secureGet(db, 'etradeConsumerSecret');
      const accessToken    = secureGet(db, 'etradeAccessToken');
      const status: ETradeStatus = {
        hasConsumerKey:    !!consumerKey,
        hasConsumerSecret: !!consumerSecret,
        hasAccessToken:    !!accessToken,
        isConfigured:      !!(consumerKey && consumerSecret),
        isAuthenticated:   !!(consumerKey && consumerSecret && accessToken),
      };
      return ok({ status, consumerKey });
    } catch (err) { return fail(err); }
  });

  /** Save consumer key + secret (entered by user in settings). */
  ipcMain.handle('etrade:save-credentials',
    (_e: IpcMainInvokeEvent, consumerKey: string, consumerSecret: string) => {
      try {
        secureSet(db, 'etradeConsumerKey',    consumerKey.trim());
        secureSet(db, 'etradeConsumerSecret', consumerSecret.trim());
        // Clear any existing tokens when credentials change
        secureSet(db, 'etradeAccessToken',  '');
        secureSet(db, 'etradeAccessSecret', '');
        return ok(true);
      } catch (err) { return fail(err); }
    }
  );

  /**
   * Step 1 of OAuth: get a request token, open the E*Trade auth URL in the
   * default browser, and return the URL so the UI can show it too.
   */
  ipcMain.handle('etrade:start-auth', async (_e: IpcMainInvokeEvent) => {
    try {
      const consumerKey    = secureGet(db, 'etradeConsumerKey');
      const consumerSecret = secureGet(db, 'etradeConsumerSecret');
      if (!consumerKey || !consumerSecret) {
        throw new Error('E*Trade consumer key and secret must be saved before connecting.');
      }
      const { requestToken, requestSecret, authUrl } = await getRequestToken(consumerKey, consumerSecret);
      // Store request token temporarily for the verifier step
      secureSet(db, 'etradeRequestToken',  requestToken);
      secureSet(db, 'etradeRequestSecret', requestSecret);
      // Open the E*Trade auth page in the user's default browser
      await shell.openExternal(authUrl);
      return ok({ authUrl });
    } catch (err) { return fail(err); }
  });

  /**
   * Step 3 of OAuth: exchange the verifier code the user received in the
   * browser for a live access token. Stores it in settings.
   */
  ipcMain.handle('etrade:submit-verifier',
    async (_e: IpcMainInvokeEvent, verifier: string) => {
      try {
        const consumerKey    = secureGet(db, 'etradeConsumerKey');
        const consumerSecret = secureGet(db, 'etradeConsumerSecret');
        const requestToken   = secureGet(db, 'etradeRequestToken');
        const requestSecret  = secureGet(db, 'etradeRequestSecret');
        if (!consumerKey || !consumerSecret || !requestToken || !requestSecret) {
          throw new Error('Start the auth flow first (etrade:start-auth) before submitting a verifier.');
        }
        const { accessToken, accessSecret } = await getAccessToken(
          consumerKey, consumerSecret, requestToken, requestSecret, verifier.trim()
        );
        secureSet(db, 'etradeAccessToken',  accessToken);
        secureSet(db, 'etradeAccessSecret', accessSecret);
        // Clear temp tokens
        secureSet(db, 'etradeRequestToken',  '');
        secureSet(db, 'etradeRequestSecret', '');
        return ok(true);
      } catch (err) { return fail(err); }
    }
  );

  /** Renew a dormant token (inactive > 2 hours). */
  ipcMain.handle('etrade:renew-token', async (_e: IpcMainInvokeEvent) => {
    try {
      const creds = getCredentials(db);
      if (!creds.accessToken) throw new Error('No access token to renew. Please re-authenticate.');
      await renewAccessToken(creds);
      return ok(true);
    } catch (err) { return fail(err); }
  });

  /**
   * Lightweight connection check: tries to renew/ping the token.
   * Returns { status: 'ok' | 'no_credentials' | 'no_token' | 'expired' | 'error', message? }
   * 'ok'             — token is valid (active or dormant; renewal succeeded)
   * 'no_credentials' — consumer key/secret not saved
   * 'no_token'       — credentials saved but not yet authenticated
   * 'expired'        — token expired at midnight ET; full re-auth required
   * 'error'          — unexpected API error
   */
  ipcMain.handle('etrade:check-connection', async (_e: IpcMainInvokeEvent) => {
    try {
      const consumerKey    = secureGet(db, 'etradeConsumerKey');
      const consumerSecret = secureGet(db, 'etradeConsumerSecret');
      const accessToken    = secureGet(db, 'etradeAccessToken');
      const accessSecret   = secureGet(db, 'etradeAccessSecret');

      if (!consumerKey || !consumerSecret) {
        return ok({ status: 'no_credentials' as const });
      }
      if (!accessToken || !accessSecret) {
        return ok({ status: 'no_token' as const });
      }

      // Ping via renewAccessToken — succeeds for active and dormant tokens;
      // returns 401 with "token_expired" for expired tokens.
      try {
        await renewAccessToken({ consumerKey, consumerSecret, accessToken, accessSecret });
        return ok({ status: 'ok' as const });
      } catch (pingErr) {
        const msg = pingErr instanceof Error ? pingErr.message : String(pingErr);
        if (msg.includes('token_expired') || msg.includes('401')) {
          return ok({ status: 'expired' as const });
        }
        return ok({ status: 'error' as const, message: msg });
      }
    } catch (err) { return fail(err); }
  });

  /** Clear access token (force re-auth). */
  ipcMain.handle('etrade:disconnect', (_e: IpcMainInvokeEvent) => {
    try {
      secureSet(db, 'etradeAccessToken',  '');
      secureSet(db, 'etradeAccessSecret', '');
      return ok(true);
    } catch (err) { return fail(err); }
  });

  /** Get all expiration dates for a symbol. */
  ipcMain.handle('etrade:get-expirations',
    async (_e: IpcMainInvokeEvent, symbol: string) => {
      try {
        const creds = getCredentials(db);
        if (!creds.accessToken) throw new Error('Not authenticated with E*Trade. Please connect first.');
        const expirations = await getETradeExpirations(symbol, creds);
        return ok(expirations);
      } catch (err) { return fail(err); }
    }
  );

  /** Fetch the options chain for a symbol + expiration. */
  ipcMain.handle('etrade:get-options-chain',
    async (_e: IpcMainInvokeEvent, symbol: string, expiration: ETradeExpiration) => {
      try {
        const creds = getCredentials(db);
        if (!creds.accessToken) throw new Error('Not authenticated with E*Trade. Please connect first.');
        const result: ETradeOptionsChainResult = await getETradeOptionsChain(symbol, expiration, creds);
        return ok(result);
      } catch (err) { return fail(err); }
    }
  );
}
