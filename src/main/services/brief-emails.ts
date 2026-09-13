// Brief-run email delivery — one logged path for Roll the Dice and the Wheel Shortlist, used by both
// the brief job and the in-app "Email it" buttons.
//
// WHY THIS IS ITS OWN MODULE (v1.1.241). On 2026-09-11 the after-close brief ran at 17:31,
// generated 17 picks, and emailed them; seconds later the dice email did not arrive, and nothing
// anywhere said why. Both sends reported only through `console.log` / `console.warn`, which a
// packaged app does not keep, so the cause was unrecoverable. The same block also sat inside
// `totalPicks > 0`, so a zero-pick brief would have skipped the dice email that its own comment
// promised ("a no-pick day still sends").
//
// So: every outcome goes through an injected logger (the caller points it at logs/errors), the
// three things that can fail — computing the content, building the email, sending it — are separate
// steps that name themselves when they fail, and a failed send is retried once. Pure of Electron
// on purpose, so it is tested directly.

import type { EmailAttachment } from './email-service.js';
import { computeRollTheDice, DEFAULT_MAX_CAPITAL, type DiceResult } from './roll-the-dice.js';
import { buildDiceEmailHtml, diceEmailSubject } from './dice-email-builder.js';
import { computeWheelShortlist } from './wheel-shortlist.js';
import { buildShortlistEmailHtml, shortlistEmailSubject } from './shortlist-email-builder.js';
import type { OptionsProvider } from './options-provider.js';
import type { ShortlistResult } from '@shared/wheel-shortlist.js';

export interface EmailSender {
  send(subject: string, html: string, attachments?: EmailAttachment[]): Promise<void>;
}

export interface EmailOutcomeLog {
  readonly level: 'INFO' | 'ERROR';
  /** e.g. `dice-email:sent`, `shortlist-email:send`, `brief-email:skipped`. */
  readonly operation: string;
  readonly message: string;
  readonly error?: unknown;
}

export type EmailLog = (entry: EmailOutcomeLog) => void;

export type EmailStep = 'compute' | 'build' | 'send';
/** @deprecated kept for the dice call sites; same as `EmailStep`. */
export type DiceEmailStep = EmailStep;

export interface EmailOutcome<T> {
  readonly status: 'sent' | 'failed';
  /** The step that failed; absent on success. */
  readonly step?: EmailStep;
  readonly subject?: string;
  readonly attempts: number;
  readonly result?: T;
  readonly error?: string;
}

export type DiceEmailOutcome = EmailOutcome<DiceResult>;
export type ShortlistEmailOutcome = EmailOutcome<ShortlistResult>;

/** Total send attempts: the first plus one retry. */
export const DICE_SEND_ATTEMPTS = 2;
/** Pause before the retry — long enough for a transient SMTP refusal to clear. */
export const DICE_RETRY_DELAY_MS = 20_000;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** `HH:MM` in New York. Put in the subject so a day's two runs are two emails, not one thread. */
export function etClock(now: Date): string {
  return now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' });
}

interface DeliveryOptions {
  readonly email: EmailSender;
  readonly log: EmailLog;
  /** Who asked — recorded in every log line (`brief`, `manual`). */
  readonly source: string;
  readonly now?: Date;
  readonly retryDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

async function deliver<T>(opts: DeliveryOptions & {
  /** Operation prefix, e.g. `dice-email`. */
  readonly name: string;
  /** Human label for log messages, e.g. `dice email`. */
  readonly label: string;
  readonly compute: () => T | Promise<T>;
  readonly build: (result: T, now: Date) => { subject: string; html: string };
}): Promise<EmailOutcome<T>> {
  const now = opts.now ?? new Date();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tag = `[${opts.source}]`;

  let result: T;
  try {
    result = await opts.compute();
  } catch (err) {
    opts.log({ level: 'ERROR', operation: `${opts.name}:compute`, message: `${tag} ${opts.label} not sent — computing it failed: ${message(err)}`, error: err });
    return { status: 'failed', step: 'compute', attempts: 0, error: message(err) };
  }

  let subject: string;
  let html: string;
  try {
    ({ subject, html } = opts.build(result, now));
  } catch (err) {
    opts.log({ level: 'ERROR', operation: `${opts.name}:build`, message: `${tag} ${opts.label} not sent — building it failed: ${message(err)}`, error: err });
    return { status: 'failed', step: 'build', attempts: 0, result, error: message(err) };
  }

  let lastErr: unknown;
  for (let attempt = 1; attempt <= DICE_SEND_ATTEMPTS; attempt++) {
    try {
      await opts.email.send(subject, html);
      opts.log({ level: 'INFO', operation: `${opts.name}:sent`, message: `${tag} ${opts.label} sent (attempt ${attempt}): ${subject}` });
      return { status: 'sent', subject, attempts: attempt, result };
    } catch (err) {
      lastErr = err;
      if (attempt < DICE_SEND_ATTEMPTS) {
        opts.log({ level: 'ERROR', operation: `${opts.name}:send-retry`, message: `${tag} ${opts.label} send attempt ${attempt} failed, retrying: ${message(err)}`, error: err });
        await sleep(opts.retryDelayMs ?? DICE_RETRY_DELAY_MS);
      }
    }
  }
  opts.log({
    level: 'ERROR', operation: `${opts.name}:send`,
    message: `${tag} ${opts.label} NOT sent after ${DICE_SEND_ATTEMPTS} attempts: ${message(lastErr)} — subject was "${subject}"`,
    error: lastErr,
  });
  return { status: 'failed', step: 'send', subject, attempts: DICE_SEND_ATTEMPTS, result, error: message(lastErr) };
}

const etDateLabel = (now: Date): string =>
  now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' });

export function sendDiceEmail(opts: DeliveryOptions & {
  readonly db: Parameters<typeof computeRollTheDice>[0];
  readonly maxCapital?: number;
}): Promise<DiceEmailOutcome> {
  return deliver({
    ...opts,
    name: 'dice-email',
    label: 'dice email',
    compute: () => computeRollTheDice(opts.db, opts.maxCapital ?? DEFAULT_MAX_CAPITAL),
    build: (r, now) => ({ subject: `${diceEmailSubject(r)} · ${etClock(now)} ET`, html: buildDiceEmailHtml(r, etDateLabel(now)) }),
  });
}

/** The Wheel Shortlist (NewApp 07 §3), priced live, through the same logged path. */
export function sendShortlistEmail(opts: DeliveryOptions & {
  readonly db: Parameters<typeof computeWheelShortlist>[0]['db'];
  readonly provider: Pick<OptionsProvider, 'getOptionsExpirations' | 'getOptionsChain'>;
}): Promise<ShortlistEmailOutcome> {
  return deliver({
    ...opts,
    name: 'shortlist-email',
    label: 'wheel shortlist email',
    compute: () => computeWheelShortlist({ db: opts.db, provider: opts.provider, ...(opts.now ? { now: opts.now } : {}) }),
    build: (r, now) => ({ subject: `${shortlistEmailSubject(r)} · ${etClock(now)} ET`, html: buildShortlistEmailHtml(r, etDateLabel(now)) }),
  });
}
