// Roll the Dice email delivery — one path for the brief job and the in-app "Email it" button.
//
// WHY THIS IS ITS OWN MODULE (v1.1.241). On 2026-09-11 the after-close brief ran at 17:31,
// generated 17 picks, and emailed them; seconds later the dice email did not arrive, and nothing
// anywhere said why. Both sends reported only through `console.log` / `console.warn`, which a
// packaged app does not keep, so the cause was unrecoverable. The same block also sat inside
// `totalPicks > 0`, so a zero-pick brief would have skipped the dice email that its own comment
// promised ("a no-pick day still sends").
//
// So: every outcome goes through an injected logger (the caller points it at logs/errors), the
// three things that can fail — computing the dice, building the email, sending it — are separate
// steps that name themselves when they fail, and a failed send is retried once. Pure of Electron
// on purpose, so it is tested directly.

import type { EmailAttachment } from './email-service.js';
import { computeRollTheDice, DEFAULT_MAX_CAPITAL, type DiceResult } from './roll-the-dice.js';
import { buildDiceEmailHtml, diceEmailSubject } from './dice-email-builder.js';

export interface EmailSender {
  send(subject: string, html: string, attachments?: EmailAttachment[]): Promise<void>;
}

export interface EmailOutcomeLog {
  readonly level: 'INFO' | 'ERROR';
  /** e.g. `dice-email:sent`, `dice-email:send`, `brief-email:skipped`. */
  readonly operation: string;
  readonly message: string;
  readonly error?: unknown;
}

export type EmailLog = (entry: EmailOutcomeLog) => void;

export type DiceEmailStep = 'compute' | 'build' | 'send';

export interface DiceEmailOutcome {
  readonly status: 'sent' | 'failed';
  /** The step that failed; absent on success. */
  readonly step?: DiceEmailStep;
  readonly subject?: string;
  readonly attempts: number;
  readonly result?: DiceResult;
  readonly error?: string;
}

/** Total send attempts: the first plus one retry. */
export const DICE_SEND_ATTEMPTS = 2;
/** Pause before the retry — long enough for a transient SMTP refusal to clear. */
export const DICE_RETRY_DELAY_MS = 20_000;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** `HH:MM` in New York. Put in the subject so a day's two runs are two emails, not one thread. */
export function etClock(now: Date): string {
  return now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' });
}

export async function sendDiceEmail(opts: {
  readonly email: EmailSender;
  readonly db: Parameters<typeof computeRollTheDice>[0];
  readonly log: EmailLog;
  /** Who asked — recorded in every log line (`brief`, `manual`). */
  readonly source: string;
  readonly maxCapital?: number;
  readonly now?: Date;
  readonly retryDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}): Promise<DiceEmailOutcome> {
  const now = opts.now ?? new Date();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tag = `[${opts.source}]`;

  let result: DiceResult;
  try {
    result = computeRollTheDice(opts.db, opts.maxCapital ?? DEFAULT_MAX_CAPITAL);
  } catch (err) {
    opts.log({ level: 'ERROR', operation: 'dice-email:compute', message: `${tag} dice email not sent — computing the dice failed: ${message(err)}`, error: err });
    return { status: 'failed', step: 'compute', attempts: 0, error: message(err) };
  }

  let subject: string;
  let html: string;
  try {
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
    subject = `${diceEmailSubject(result)} · ${etClock(now)} ET`;
    html = buildDiceEmailHtml(result, dateStr);
  } catch (err) {
    opts.log({ level: 'ERROR', operation: 'dice-email:build', message: `${tag} dice email not sent — building it failed: ${message(err)}`, error: err });
    return { status: 'failed', step: 'build', attempts: 0, result, error: message(err) };
  }

  let lastErr: unknown;
  for (let attempt = 1; attempt <= DICE_SEND_ATTEMPTS; attempt++) {
    try {
      await opts.email.send(subject, html);
      opts.log({ level: 'INFO', operation: 'dice-email:sent', message: `${tag} dice email sent (attempt ${attempt}): ${subject}` });
      return { status: 'sent', subject, attempts: attempt, result };
    } catch (err) {
      lastErr = err;
      if (attempt < DICE_SEND_ATTEMPTS) {
        opts.log({ level: 'ERROR', operation: 'dice-email:send-retry', message: `${tag} dice email send attempt ${attempt} failed, retrying: ${message(err)}`, error: err });
        await sleep(opts.retryDelayMs ?? DICE_RETRY_DELAY_MS);
      }
    }
  }
  opts.log({
    level: 'ERROR', operation: 'dice-email:send',
    message: `${tag} dice email NOT sent after ${DICE_SEND_ATTEMPTS} attempts: ${message(lastErr)} — subject was "${subject}"`,
    error: lastErr,
  });
  return { status: 'failed', step: 'send', subject, attempts: DICE_SEND_ATTEMPTS, result, error: message(lastErr) };
}
