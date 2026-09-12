import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  sendDiceEmail, etClock, DICE_SEND_ATTEMPTS, DICE_RETRY_DELAY_MS,
  type EmailOutcomeLog, type EmailSender,
} from '../src/main/services/brief-emails.js';
import { buildDiceEmailHtml, diceEmailSubject } from '../src/main/services/dice-email-builder.js';
import type { DiceResult, DicePick } from '../src/main/services/roll-the-dice.js';
import { openDatabase } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';

// 2026-09-11: the after-close brief emailed 17 picks at ~17:35 and the dice email a few seconds
// later never arrived. Both sends reported only to the console, so the cause was unrecoverable.
// These tests pin the three things that change that: every outcome is logged with the failing
// step, a failed send is retried once, and a zero-pick brief still sends the dice email.

const NOW = new Date('2026-09-11T21:35:12Z'); // 17:35 ET

function db() {
  const d = openDatabase(':memory:');
  runMigrations(d, MIGRATIONS_DIR);
  return d;
}

function sender(failFirst = 0): EmailSender & { sent: { subject: string; html: string }[]; calls: number } {
  const s = {
    sent: [] as { subject: string; html: string }[],
    calls: 0,
    async send(subject: string, html: string) {
      s.calls++;
      if (s.calls <= failFirst) throw new Error(`421 4.7.0 try again later (call ${s.calls})`);
      s.sent.push({ subject, html });
    },
  };
  return s;
}

describe('sendDiceEmail', () => {
  it('sends the no-dice email when there is nothing to pick, and logs that it did', async () => {
    const logs: EmailOutcomeLog[] = [];
    const email = sender();
    const out = await sendDiceEmail({ email, db: db(), log: (e) => logs.push(e), source: 'brief', now: NOW });

    expect(out.status).toBe('sent');
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]!.subject).toContain('No dice today');
    // The run time is in the subject, so the day's two runs are two emails, not one thread.
    expect(email.sent[0]!.subject).toMatch(/· 17:35 ET$/);
    expect(logs).toEqual([expect.objectContaining({ level: 'INFO', operation: 'dice-email:sent' })]);
  });

  it('retries a failed send once, after the delay, and records the failed attempt', async () => {
    const logs: EmailOutcomeLog[] = [];
    const slept: number[] = [];
    const email = sender(1);
    const out = await sendDiceEmail({
      email, db: db(), log: (e) => logs.push(e), source: 'brief', now: NOW,
      sleep: async (ms) => { slept.push(ms); },
    });

    expect(out).toMatchObject({ status: 'sent', attempts: 2 });
    expect(slept).toEqual([DICE_RETRY_DELAY_MS]);
    expect(logs.map((l) => l.operation)).toEqual(['dice-email:send-retry', 'dice-email:sent']);
    expect(logs[0]!.message).toContain('421 4.7.0');
  });

  it('never throws when every attempt fails — it logs the SMTP error and the step', async () => {
    const logs: EmailOutcomeLog[] = [];
    const email = sender(99);
    const out = await sendDiceEmail({ email, db: db(), log: (e) => logs.push(e), source: 'brief', now: NOW, sleep: async () => {} });

    expect(out).toMatchObject({ status: 'failed', step: 'send', attempts: DICE_SEND_ATTEMPTS });
    const final = logs.at(-1)!;
    expect(final).toMatchObject({ level: 'ERROR', operation: 'dice-email:send' });
    // The whole point: the reason is written down, not printed to a console nobody keeps.
    expect(final.message).toContain('try again later');
    expect(final.message).toContain('No dice today');
  });

  it('names the compute step when the dice cannot be computed, and sends nothing', async () => {
    const logs: EmailOutcomeLog[] = [];
    const d = db();
    d.close();
    const email = sender();
    const out = await sendDiceEmail({ email, db: d, log: (e) => logs.push(e), source: 'manual', now: NOW });

    expect(out).toMatchObject({ status: 'failed', step: 'compute', attempts: 0 });
    expect(email.calls).toBe(0);
    expect(logs[0]).toMatchObject({ level: 'ERROR', operation: 'dice-email:compute' });
  });

  it('formats the ET clock from the instant, not the machine timezone', () => {
    expect(etClock(new Date('2026-09-11T14:28:00Z'))).toBe('10:28');
  });
});

describe('the dice email survives a pick with missing fields', () => {
  // A pick read back from `daily_briefs` JSON can lack fields the types call required. Each of
  // these used to be an unguarded `.toFixed()` or `.replace()` that threw and lost the email.
  const partial = {
    ticker: 'ABC', price: 50, strike: 45, expiration: '2026-10-16', dte: 35,
    premiumPerShare: 0.9, creditTotal: 90, capitalRequired: 4500, effectiveCostBasis: 44.1,
    annualizedReturn: null, popEstimate: null, criticRationale: null, aiRationale: null,
    fit: { withinCapital: true, maxCapital: 30_000, conviction: null, ownership: null },
  } as unknown as DicePick; // no grade, no liquidityScore, no compositeScore, no discountToSpotPct

  const result: DiceResult = {
    pick: partial, withinBudget: null, noPickReason: null, briefDate: '2026-09-11', briefAgeDays: 0,
    staleWarning: null, considered: 1, rejections: [],
    runnerUp: { ticker: 'XYZ' } as unknown as DiceResult['runnerUp'],
  };

  it('builds instead of throwing, showing a dash where the value is missing', () => {
    let html = '';
    expect(() => { html = buildDiceEmailHtml(result, 'Fri, Sep 11'); }).not.toThrow();
    expect(html).toContain('liquidity —/15');
    expect(html).toContain('Runner-up was XYZ (—)');
    expect(() => diceEmailSubject(result)).not.toThrow();
  });
});

describe('the brief job wiring', () => {
  const job = readFileSync(resolve('src/main/services/jobs/daily-intelligence-brief-job.ts'), 'utf8');

  it('sends the dice email even when the brief has 0 picks', () => {
    // It sat inside `isConfigured() && totalPicks > 0`, contradicting its own "a no-pick day still sends".
    expect(job).not.toContain('isConfigured() && totalPicks > 0');
    const start = job.indexOf('this.emailService?.isConfigured()');
    expect(start).toBeGreaterThan(-1);
    const dice = job.indexOf('sendDiceEmail(', start);
    expect(dice).toBeGreaterThan(start);
    // The dice call comes after the picks branch closes, i.e. it is not inside it.
    expect(job.slice(start, dice)).toContain("operation: 'brief-email:skipped'");
  });

  it('records email outcomes in the log, not only on the console', () => {
    expect(job).not.toMatch(/console\.(log|warn)\('\[brief\] (dice )?email/);
    expect(job).toContain("operation: 'brief-email:send'");
  });
});
