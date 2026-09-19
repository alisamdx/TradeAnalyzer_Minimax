// Capture-quality checks over spread_chain_capture (v1.1.297) — TradeAnalyzer 2's gate does not
// judge this table, and the 08 §4 enable gate is decided on it.
import { describe, it, expect } from 'vitest';
import { assessCaptureQuality, type PositionCapture } from '../src/main/services/spread-capture-quality.js';

const DAYS = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'];
const q = (a: number, b: number, c: number, d: number) => [a, b, c, d] as const;

const pos = (over: Partial<PositionCapture> = {}): PositionCapture => ({
  ticker: 'EOG', asOfDate: '2026-09-14', expiration: '2026-10-16', status: 'open',
  markDates: ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'],
  quotes: [q(1, 1.1, 0.4, 0.5), q(1.2, 1.3, 0.5, 0.6), q(1.4, 1.5, 0.6, 0.7), q(1.1, 1.2, 0.45, 0.55)],
  ...over,
});

const codes = (r: { findings: Array<{ code: string }> }) => r.findings.map(f => f.code);

describe('assessCaptureQuality', () => {
  it('is quiet when every live position was re-quoted on every capture day', () => {
    const r = assessCaptureQuality([pos()], DAYS, '2026-09-18');
    expect(r.findings).toEqual([]);
    expect(r).toMatchObject({ captureDays: 5, lastCaptureDate: '2026-09-18', marks: 4, gaps: 0, expectedMarks: 4, missingMarks: 0 });
  });

  it('SC-2: an open position skipped on a day the capture DID run — those marks cannot be recovered', () => {
    const r = assessCaptureQuality([pos({ markDates: ['2026-09-15', '2026-09-18'], quotes: [q(1, 1.1, 0.4, 0.5), q(1.2, 1.3, 0.5, 0.6)] })], DAYS, '2026-09-18');
    expect(codes(r)).toEqual(['SC-2']);
    expect(r.findings[0]!.subjects[0]).toContain('2026-09-16');
    expect(r.missingMarks).toBe(2);
  });

  it('does not fire for days before the entry, after expiry, or when nothing captured at all', () => {
    const late = pos({ asOfDate: '2026-09-17', markDates: ['2026-09-18'], quotes: [q(1, 1.1, 0.4, 0.5)] });
    expect(assessCaptureQuality([late], DAYS, '2026-09-18').findings).toEqual([]);
    const expired = pos({ expiration: '2026-09-16', markDates: ['2026-09-15', '2026-09-16'], quotes: [q(1, 1.1, 0.4, 0.5), q(1, 1.2, 0.4, 0.6)], status: 'expired' });
    expect(assessCaptureQuality([expired], DAYS, '2026-09-18').findings).toEqual([]);
  });

  it('SC-1: the capture has stopped while positions are open — but not on a weekend-sized gap', () => {
    expect(codes(assessCaptureQuality([pos()], DAYS, '2026-09-21'))).toEqual([]);       // 3 days: a weekend
    const r = assessCaptureQuality([pos()], DAYS, '2026-09-22');                         // 4 days
    expect(codes(r)).toEqual(['SC-1']);
    expect(r.findings[0]!.detail).toContain('2026-09-18');
    expect(codes(assessCaptureQuality([], [], '2026-09-22'))).toEqual(['SC-1']);
  });

  it('SC-3: too many captures missing one of the two legs', () => {
    const half = pos({ quotes: [q(1, 1.1, 0.4, 0.5), null, q(1.4, 1.5, 0.6, 0.7), null] });
    const r = assessCaptureQuality([half], DAYS, '2026-09-18');
    expect(codes(r)).toEqual(['SC-3']);
    expect(r).toMatchObject({ marks: 2, gaps: 2, gapRate: 0.5 });
  });

  it('SC-4: an open position whose quotes have not moved for three captures', () => {
    const frozen = pos({ quotes: [q(2, 2.1, 1, 1.1), q(1, 1.1, 0.4, 0.5), q(1, 1.1, 0.4, 0.5), q(1, 1.1, 0.4, 0.5)] });
    expect(codes(assessCaptureQuality([frozen], DAYS, '2026-09-18'))).toEqual(['SC-4']);
    // A settled position stops being re-quoted for a good reason.
    expect(codes(assessCaptureQuality([{ ...frozen, status: 'target' }], DAYS, '2026-09-18'))).toEqual([]);
    // Two identical then a move is normal.
    const moved = pos({ quotes: [q(1, 1.1, 0.4, 0.5), q(1, 1.1, 0.4, 0.5), q(1.4, 1.5, 0.6, 0.7), q(1.5, 1.6, 0.7, 0.8)] });
    expect(codes(assessCaptureQuality([moved], DAYS, '2026-09-18'))).toEqual([]);
  });
});
