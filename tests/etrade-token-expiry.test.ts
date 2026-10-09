import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const logged: { operation: string; message: string }[] = [];
vi.mock('../src/main/services/logger.js', () => ({
  logError: (e: { operation: string; message: string }) => { logged.push(e); },
}));

import { isExpiredTokenResponse, ExpiredTokenLatch } from '../src/main/services/etrade-token-latch.js';
import { etClockHHMM, watchdogTargetDate } from '../src/main/services/jobs/collector-daily.js';
import { ETradeTokenAlert, shouldRunMorningCheck } from '../src/main/services/etrade-token-alert.js';

/**
 * 2026-10-08: the token expired at midnight ET and nobody was told. Both batch
 * slots refused to start, the 17:06 collector sent ~2,000 E*Trade calls that all
 * came back 401 (each with a renew in between), and a manual chain re-run that
 * night was halted at 00:14 by the watchdog asking about 2026-10-09.
 */

describe('expired-token latch (collector E*Trade transport)', () => {
  it('trips on token_expired only, never on a dormant token_rejected', () => {
    expect(isExpiredTokenResponse({ status: 401, body: 'oauth_problem=token_expired' })).toBe(true);
    // Dormant: a renew can fix it, so it must keep being retried.
    expect(isExpiredTokenResponse({ status: 401, body: 'oauth_problem=token_rejected' })).toBe(false);
    expect(isExpiredTokenResponse({ status: 200, body: 'oauth_problem=token_expired' })).toBe(false);
    expect(isExpiredTokenResponse({ status: null, body: '' })).toBe(false);
  });

  it('stays tripped for the expired token and clears on a re-auth', () => {
    const latch = new ExpiredTokenLatch();
    expect(latch.isTripped('tok-A')).toBe(false);
    latch.trip('tok-A');
    expect(latch.isTripped('tok-A')).toBe(true);
    expect(latch.isTripped('tok-B')).toBe(false);
  });

  it('checks the latch before any call, and trips it only from the post-renew retry', () => {
    const host = readFileSync(join(__dirname, '../src/main/collector-host/electron-collector-host.ts'), 'utf8');
    const block = host.slice(host.indexOf('async etradeGet('), host.indexOf('async httpGet('));
    const check = block.indexOf('this.expiredToken.isTripped(creds.accessToken)');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(block.indexOf('etradeGetRaw('));
    // Tripped after the renew, from the retry's answer, never from the first call.
    const trip = block.indexOf('isExpiredTokenResponse(retry)');
    expect(trip).toBeGreaterThan(block.indexOf('renewAccessToken('));
    expect(block).not.toContain('isExpiredTokenResponse(first)');
  });
});

describe('collector watchdog target date', () => {
  const prev = (d: string) => (d === '2026-10-09' ? '2026-10-08' : undefined);

  it('asks about the previous trading day when run after midnight (the 2026-10-08 chain)', () => {
    expect(watchdogTargetDate('2026-10-09', '00:14', prev)).toBe('2026-10-08');
  });

  it('asks about today at and after the collector slot', () => {
    expect(watchdogTargetDate('2026-10-09', '19:30', prev)).toBe('2026-10-09');
    expect(watchdogTargetDate('2026-10-09', '17:05', prev)).toBe('2026-10-09');
    expect(watchdogTargetDate('2026-10-09', '17:04', prev)).toBe('2026-10-08');
  });

  it('falls back to today when no previous trading day is known', () => {
    expect(watchdogTargetDate('2026-10-09', '00:14', () => undefined)).toBe('2026-10-09');
  });

  it('formats the ET clock 00-23, so 00:14 never reads as 24:14', () => {
    expect(etClockHHMM(new Date('2026-10-09T04:14:00Z'))).toBe('00:14');
    expect(etClockHHMM(new Date('2026-10-08T23:30:00Z'))).toBe('19:30');
    expect(etClockHHMM(new Date('2026-01-15T05:00:00Z'))).toBe('00:00'); // EST
  });
});

describe('E*Trade token alert', () => {
  beforeEach(() => { logged.length = 0; });

  it('runs the morning check only inside [07:30, 10:15) on a trading day, once', () => {
    const base = { today: '2026-10-08', isTradingDay: true, lastMorningCheck: null };
    expect(shouldRunMorningCheck({ ...base, timeEt: '07:29' })).toBe(false);
    expect(shouldRunMorningCheck({ ...base, timeEt: '07:30' })).toBe(true);
    expect(shouldRunMorningCheck({ ...base, timeEt: '10:14' })).toBe(true);
    expect(shouldRunMorningCheck({ ...base, timeEt: '10:15' })).toBe(false);
    expect(shouldRunMorningCheck({ ...base, timeEt: '08:00', isTradingDay: false })).toBe(false);
    expect(shouldRunMorningCheck({ ...base, timeEt: '08:00', lastMorningCheck: '2026-10-08' })).toBe(false);
  });

  function make(status: string, clock = { today: '2026-10-08', time: '08:00' }) {
    const sent: string[] = [];
    const probe = vi.fn(async () => ({ status, detail: 'HTTP 401: oauth_problem=token_expired' }));
    const alert = new ETradeTokenAlert({
      probe,
      sendEmail: async (subject) => { sent.push(subject); },
      isEmailConfigured: () => true,
      today: () => clock.today,
      timeEt: () => clock.time,
      isTradingDay: () => true,
      appVersion: 'test',
    });
    return { alert, sent, probe, clock };
  }

  it('emails and logs once when the morning probe finds an expired token', async () => {
    const { alert, sent, probe } = make('expired');
    await alert.morningTick();
    await alert.morningTick();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('E*Trade token expired');
    expect(logged.filter((l) => l.operation === 'etrade-token-alert')).toHaveLength(1);
    expect(logged[0]!.message).toContain('Alert email sent');
  });

  it('stays quiet when the token works', async () => {
    const { alert, sent, probe } = make('ok');
    await alert.morningTick();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(0);
  });

  it('sends one email per day across the morning check and the keep-alive, and again the next day', async () => {
    const { alert, sent, clock } = make('expired');
    await alert.morningTick();
    await alert.reportExpired('again');
    expect(sent).toHaveLength(1);
    clock.today = '2026-10-09';
    await alert.reportExpired('next day');
    expect(sent).toHaveLength(2);
  });
});
