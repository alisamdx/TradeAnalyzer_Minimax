// Where email outcomes are written: logs/errors, at INFO for a send and ERROR for a failure.
//
// Kept apart from `brief-emails.ts` so that module stays free of Electron and is tested directly.
// Before v1.1.241 both brief-job emails reported only through the console, which a packaged app
// does not keep — so a missing email on 2026-09-11 could not be explained from any file.

import { app } from 'electron';
import { logError } from './logger.js';
import type { EmailOutcomeLog } from './brief-emails.js';

export function logEmailOutcome(entry: EmailOutcomeLog): void {
  const err = entry.error;
  try {
    logError({
      timestamp: new Date().toISOString(),
      appVersion: app.getVersion(),
      errorClass: entry.level === 'INFO' ? 'EmailOutcome' : err instanceof Error ? err.constructor.name : 'EmailError',
      message: entry.message,
      stack: err instanceof Error ? err.stack ?? null : null,
      operation: entry.operation,
      ticker: null,
      correlationId: null,
      level: entry.level,
    });
  } catch {
    // Logging must never be the reason an email path throws.
  }
  (entry.level === 'INFO' ? console.log : console.warn)(entry.message);
}
