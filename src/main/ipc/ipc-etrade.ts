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
 *   etradeTokenDate      — YYYY-MM-DD (ET) when the access token was issued;
 *                          used for startup freshness check without an API call
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

/**
 * Returns today's date in Eastern Time as YYYY-MM-DD.
 * E*Trade access tokens expire at midnight ET every day, so comparing the
 * stored issue date with today's ET date is sufficient to detect expiry
 * without making an extra API round-trip on startup.
 */
function todayET(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
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

export type ETradeProbeStatus =
  | 'ok'             // token is live right now
  | 'renewed'        // token was dormant and was successfully reactivated
  | 'no_credentials' // no consumer key/secret
  | 'no_token'       // credentials saved but never authenticated
  | 'expired'        // crossed midnight ET, or renew+retry still rejected → manual re-auth
  | 'error';         // non-auth failure (network / E*Trade down) — transient

/**
 * LIVE connection probe — unlike the date-based `check-connection`, this actually calls
 * E*Trade (a lightweight SPY quote) so the result reflects whether the token *works right
 * now*. On failure it renews once and retries (renewal works as of v1.1.99), so a dormant
 * token is transparently revived → 'renewed'. Used by both the Settings "Test Connection"
 * button and the keep-alive heartbeat.
 *
 * We renew on ANY first failure, not just auth-shaped ones: a dormant token doesn't reliably
 * return a 401 — it can kill the response stream (undici `terminated`). See CLAUDE.md.
 */
export async function probeETradeConnection(db: Database): Promise<{ status: ETradeProbeStatus; detail?: string }> {
  const creds = getCredentials(db);
  if (!creds.consumerKey || !creds.consumerSecret) return { status: 'no_credentials' };
  if (!creds.accessToken  || !creds.accessSecret)  return { status: 'no_token' };

  // Crossed midnight ET → genuine expiry; renew cannot revive it, so don't waste a call.
  const tokenDate = secureGet(db, 'etradeTokenDate');
  if (tokenDate && tokenDate !== todayET()) return { status: 'expired' };

  const { etradeGet } = await import('../services/etrade-auth.js');
  const probe = () => etradeGet('/v1/market/quote/SPY', {}, getCredentials(db));

  try {
    await probe();
    return { status: 'ok' };
  } catch {
    try { await renewAccessToken(getCredentials(db)); } catch { /* harmless on an active token */ }
    try {
      await probe();
      return { status: 'renewed' };
    } catch (retryErr) {
      const msg = (retryErr instanceof Error ? retryErr.message : String(retryErr)).toLowerCase();
      const authShaped = msg.includes('401') || msg.includes('token') || msg.includes('auth')
        || msg.includes('oauth') || msg.includes('rejected');
      return {
        status: authShaped ? 'expired' : 'error',
        detail: retryErr instanceof Error ? retryErr.message : String(retryErr),
      };
    }
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerETradeIpc(db: Database): void {

  /** Get current auth status + saved credentials (credentials are stored encrypted locally). */
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
      return ok({ status, consumerKey, consumerSecret });
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
        // Record the ET date the token was issued for startup freshness checks.
        secureSet(db, 'etradeTokenDate', todayET());
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
   * Lightweight startup connection check — no API call required.
   *
   * E*Trade tokens expire at midnight Eastern Time on the day they are issued.
   * We stamp the issue date (ET) into 'etradeTokenDate' when the verifier
   * succeeds, then compare it with today's ET date here.  If they match the
   * token is still valid; if they differ (or the stamp is missing) the token
   * has crossed a midnight boundary and needs re-auth.
   *
   * We intentionally avoid calling renewAccessToken() on startup because:
   *   - renewAccessToken is meant for DORMANT tokens (inactive > 2 h).
   *   - Calling it on an ACTIVE token (just obtained) causes E*Trade to return
   *     an error, which would produce a false-positive "expired" result.
   *
   * Returns { status: 'ok' | 'no_credentials' | 'no_token' | 'expired' }
   */
  ipcMain.handle('etrade:check-connection', (_e: IpcMainInvokeEvent) => {
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

      // Compare the stored issue date with today's ET date.
      const tokenDate = secureGet(db, 'etradeTokenDate');
      const today     = todayET();

      if (!tokenDate) {
        // No date stamp — token pre-dates this check (existing session).
        // Assume valid and stamp today so subsequent restarts work correctly.
        secureSet(db, 'etradeTokenDate', today);
        return ok({ status: 'ok' as const });
      }

      if (tokenDate !== today) {
        // Token was issued on a different calendar day — it expired at midnight ET.
        return ok({ status: 'expired' as const });
      }

      // Dates match — token is still valid for today.
      return ok({ status: 'ok' as const });
    } catch (err) { return fail(err); }
  });

  /**
   * LIVE connection test — actually calls E*Trade and renews-and-retries if needed.
   * Returns the true state ('ok' | 'renewed' | 'expired' | 'error' | 'no_token' | 'no_credentials').
   */
  ipcMain.handle('etrade:test-connection', async (_e: IpcMainInvokeEvent) => {
    try { return ok(await probeETradeConnection(db)); } catch (err) { return fail(err); }
  });

  /** Clear access token (force re-auth). */
  ipcMain.handle('etrade:disconnect', (_e: IpcMainInvokeEvent) => {
    try {
      secureSet(db, 'etradeAccessToken',  '');
      secureSet(db, 'etradeAccessSecret', '');
      secureSet(db, 'etradeTokenDate',    '');
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

  /**
   * Fetch a raw stock quote from E*Trade with detailFlag=ALL.
   * Returns the full JSON so the Test API screen can inspect every field
   * E*Trade returns — used to discover whether IV rank/percentile is available.
   */
  ipcMain.handle('etrade:get-raw-quote',
    async (_e: IpcMainInvokeEvent, symbol: string) => {
      try {
        const creds = getCredentials(db);
        if (!creds.accessToken) throw new Error('Not authenticated with E*Trade. Please connect first.');
        const { etradeGet } = await import('../services/etrade-auth.js');
        const raw = await etradeGet(
          `/v1/market/quote/${encodeURIComponent(symbol.toUpperCase())}`,
          { detailFlag: 'ALL', requireEarningsDate: 'true' },
          creds
        );
        return ok({
          rawJson: JSON.stringify(raw, null, 2),
          topLevelKeys: Object.keys(raw),
        });
      } catch (err) { return fail(err); }
    }
  );
}
