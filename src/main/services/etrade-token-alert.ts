/**
 * Warn the operator before the morning batch when the E*Trade token is dead (v1.1.344).
 *
 * The token expires at midnight ET and only a manual re-auth revives it. Until
 * this existed, the first sign was the orchestrator refusing to start at 10:16.
 * On 2026-10-08 both batch slots were lost and the collector stored no E*Trade
 * data at all, while the keep-alive heartbeat had seen the expired token all
 * morning and logged it only to the console.
 *
 * Two triggers share one email, sent at most once per ET day:
 *   - a morning check: the first tick inside [07:30, 10:15) ET on a trading day
 *     probes E*Trade once;
 *   - the 90-minute keep-alive, whenever its probe reports `expired`.
 */
import { logError } from './logger.js';

export const MORNING_CHECK_START_ET = '07:30';
export const MORNING_CHECK_END_ET = '10:15';

/** Whether this tick should run the once-a-day morning probe. Pure. */
export function shouldRunMorningCheck(p: {
  timeEt: string;
  today: string;
  isTradingDay: boolean;
  lastMorningCheck: string | null;
}): boolean {
  return (
    p.isTradingDay &&
    p.lastMorningCheck !== p.today &&
    p.timeEt >= MORNING_CHECK_START_ET &&
    p.timeEt < MORNING_CHECK_END_ET
  );
}

export function buildTokenExpiredEmail(today: string, timeEt: string, detail: string | undefined): { subject: string; html: string } {
  const subject = `⚠ E*Trade token expired — re-authenticate before the ${MORNING_CHECK_END_ET} batch (${today})`;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `
<div style="font-family:monospace; padding:20px; max-width:580px; color:#222;">
  <h2 style="margin:0 0 12px; font-size:18px;">E*Trade token expired</h2>
  <p style="margin:0 0 8px;">Checked at ${timeEt} ET on ${today}. A renew was attempted and E*Trade still rejected the token.</p>
  <p style="margin:0 0 8px;">An expired token cannot be renewed. Until you re-authenticate in <b>Settings → E*Trade</b>,
  the batch orchestrator will not start and the collector will store no E*Trade data (chains, quotes, account).</p>
  ${detail ? `<p style="margin:12px 0 0; color:#666; font-size:12px;">E*Trade said: ${esc(detail.slice(0, 300))}</p>` : ''}
</div>`;
  return { subject, html };
}

export class ETradeTokenAlert {
  private lastAlertDate: string | null = null;
  private lastMorningCheck: string | null = null;

  constructor(private readonly deps: {
    readonly probe: () => Promise<{ status: string; detail?: string }>;
    readonly sendEmail: (subject: string, html: string) => Promise<void>;
    readonly isEmailConfigured: () => boolean;
    readonly today: () => string;
    readonly timeEt: () => string;
    readonly isTradingDay: (date: string) => boolean;
    readonly appVersion: string;
  }) {}

  /** Called on a short timer (every few minutes). Probes at most once per day. */
  async morningTick(): Promise<void> {
    const today = this.deps.today();
    if (!shouldRunMorningCheck({
      timeEt: this.deps.timeEt(),
      today,
      isTradingDay: this.deps.isTradingDay(today),
      lastMorningCheck: this.lastMorningCheck,
    })) return;
    this.lastMorningCheck = today;
    const r = await this.deps.probe();
    if (r.status === 'expired') await this.reportExpired(r.detail);
  }

  /** The keep-alive saw an expired token. Emails once per ET day. */
  async reportExpired(detail: string | undefined): Promise<void> {
    const today = this.deps.today();
    if (this.lastAlertDate === today) return;
    this.lastAlertDate = today;

    const timeEt = this.deps.timeEt();
    let outcome = 'not sent (email not configured)';
    if (this.deps.isEmailConfigured()) {
      const { subject, html } = buildTokenExpiredEmail(today, timeEt, detail);
      try {
        await this.deps.sendEmail(subject, html);
        outcome = 'sent';
      } catch (err) {
        outcome = `FAILED: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    logError({
      timestamp: new Date().toISOString(),
      appVersion: this.deps.appVersion,
      errorClass: 'ETradeTokenExpired',
      message: `E*Trade token expired at ${timeEt} ET; manual re-auth needed. Alert email ${outcome}.`,
      stack: null,
      operation: 'etrade-token-alert',
      ticker: null,
      correlationId: null,
      level: 'ERROR',
    });
  }
}
