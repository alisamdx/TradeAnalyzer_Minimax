import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDictionary } from '../src/dictionary/apply.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';
import type { CollectorHost, ProviderResponse } from '../src/collector/host.js';
import { resetOffsetCache } from '../src/collector/archive.js';
import { writeLegacyHandoff } from '../src/collector/legacy-handoff.js';
import type { LegacyBriefHandoff } from '../src/ingest/legacy-brief.js';

/**
 * The legacy brief hand-off — 04 §8, Q6 (B8).
 *
 * **B8's gate is the first test: a full brief run appears in `legacy_*` with
 * its losers.** That is the whole reason the contract exists. The existing
 * app's `daily_briefs` stores only survivors, so it cannot answer whether its
 * own ranking was any good — the rejected candidates are the control group,
 * and a pipeline that keeps only what it picked has discarded the only data
 * that could settle the question.
 */

let dir: string;
let raw: Database.Database;

const DATE = '2026-09-09';

function db(): SqliteLike {
  return raw as unknown as SqliteLike;
}

function makeHost(): CollectorHost {
  const empty: ProviderResponse = {
    status: 200, body: '{}', requestedAt: `${DATE}T17:00:00-04:00`, respondedAt: `${DATE}T17:00:01-04:00`
  };
  return {
    openGenerationDb: () => db(),
    archiveRoot: () => join(dir, 'archive'),
    encryptForArchive: (b) => b,
    decryptFromArchive: (b) => b,
    polygonGet: async () => empty,
    etradeGet: async () => empty,
    httpGet: async () => empty,
    nowET: () => `${DATE}T17:40:00-04:00`,
    sendEmail: async () => undefined,
    progress: () => undefined,
    signal: new AbortController().signal,
    hostApp: { name: 'TradeAnalyzer', version: '1.1.216' }
  };
}

function leg(osi: string, over: Partial<LegacyBriefHandoff['candidates'][0]['legs'][0]> = {}) {
  return {
    osiSymbol: osi,
    right: 'put' as const,
    strike: 100,
    expiration: '2026-10-16',
    bid: 1.2,
    ask: 1.3,
    mid: 1.25,
    iv: 0.38,
    delta: -0.3,
    openInterest: 500,
    volume: 42,
    volumeReported: true,
    liquidityScore: 9,
    ...over
  };
}

function handoff(over: Partial<LegacyBriefHandoff> = {}): LegacyBriefHandoff {
  return {
    legacyAppVersion: '1.1.216',
    briefId: 77,
    tradingDate: DATE,
    slot: 'after_close',
    emailedAt: `${DATE}T17:35:00-04:00`,
    candidates: [
      {
        ticker: 'WIN',
        mode: 'wheel',
        consideredRank: 1,
        survived: true,
        compositeScore: 71.5,
        finalDisposition: 'selected',
        gates: [{ name: 'liquidity', passed: true, testedValue: 9, threshold: 8, reason: null }],
        signals: [{ key: 'ivRank', rawValue: 55, normalized: 0.55, weight: 0.3, enabled: true }],
        legs: [leg('WIN   261016P00100000')],
        critic: { verdict: 'pass', rationale: 'fine', contextJson: '{}', model: 'claude-opus-5' }
      },
      {
        ticker: 'LOSE',
        mode: 'wheel',
        consideredRank: 2,
        survived: false,
        compositeScore: 44.0,
        finalDisposition: 'rejected:liquidity',
        gates: [{ name: 'liquidity', passed: false, testedValue: 5, threshold: 8, reason: 'spread too wide' }],
        signals: [{ key: 'ivRank', rawValue: 12, normalized: 0.12, weight: 0.3, enabled: true }],
        legs: [leg('LOSE  261016P00100000')]
      }
    ],
    dice: {
      eligibleCount: 1,
      selectedTicker: 'WIN',
      selectionRule: 'highest composite among eligible',
      eligibilityTraceJson: '{"WIN":"eligible","LOSE":"illiquid"}'
    },
    ...over
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-b8-'));
  raw = new Database(join(dir, 'data.sqlite'));
  applyDictionary(db());
  raw.exec(
    "INSERT INTO meta_generation (generation_no, opened_at, status, db_path, archive_path) " +
      "VALUES (1, '2026-09-09T00:00:00-04:00', 'pilot', 'x', 'y')"
  );
  resetOffsetCache();
});

afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('B8 gate — a full brief run appears in legacy_*, losers included', () => {
  it('records the rejected candidate as well as the selected one', () => {
    const result = writeLegacyHandoff(makeHost(), handoff());
    expect(result.parseStatus).toBe('ok');
    expect(result.candidates).toBe(2);

    const rows = raw
      .prepare('SELECT ticker, survived, final_disposition FROM legacy_brief_candidate ORDER BY considered_rank')
      .all() as { ticker: string; survived: number; final_disposition: string }[];

    // Both. Storing only the survivor is exactly what makes the existing app's
    // own history unable to answer whether its ranking worked.
    expect(rows).toEqual([
      { ticker: 'WIN', survived: 1, final_disposition: 'selected' },
      { ticker: 'LOSE', survived: 0, final_disposition: 'rejected:liquidity' }
    ]);
  });

  it('records the gate that rejected it, with the value and the threshold', () => {
    writeLegacyHandoff(makeHost(), handoff());
    const gate = raw
      .prepare(
        `SELECT g.gate_name, g.passed, g.tested_value, g.threshold, g.reason
           FROM legacy_brief_candidate_gate g
           JOIN legacy_brief_candidate c ON c.row_id = g.candidate_row_id
          WHERE c.ticker = 'LOSE'`
      )
      .get() as Record<string, unknown>;

    // Why it lost, not just that it did — a disposition string alone cannot
    // answer "how close was it".
    expect(gate).toMatchObject({
      gate_name: 'liquidity', passed: 0, tested_value: 5, threshold: 8, reason: 'spread too wide'
    });
  });

  it('keys the run by slot, so the morning and evening briefs are distinguishable', () => {
    const host = makeHost();
    writeLegacyHandoff(host, handoff({ slot: 'morning', briefId: 76 }));
    writeLegacyHandoff(host, handoff({ slot: 'after_close', briefId: 77 }));

    const runs = raw
      .prepare('SELECT legacy_run_id, slot FROM legacy_brief_run ORDER BY slot')
      .all() as { legacy_run_id: string; slot: string }[];

    // The existing app stored one row per day and deleted the other, so 248 of
    // 250 stored picks were evening readings while the morning pick — the one
    // the operator actually read — was produced from data destroyed hours later.
    expect(runs.map((r) => r.slot)).toEqual(['after_close', 'morning']);
    expect(new Set(runs.map((r) => r.legacy_run_id)).size).toBe(2);
  });
});

describe('the units and absences that crossed the border wrong before', () => {
  it('stores an unreported volume as omitted, never as zero', () => {
    const h = handoff();
    const payload: LegacyBriefHandoff = {
      ...h,
      candidates: [
        { ...h.candidates[0]!, legs: [leg('WIN   261016P00100000', { volume: null, volumeReported: false })] }
      ]
    };
    writeLegacyHandoff(makeHost(), payload);

    const row = raw.prepare('SELECT volume, volume_status FROM legacy_brief_leg').get();
    // `leg.volume ?? 0` turned "not reported" into "did not trade" on 23 of 250
    // stored legs in the existing app, and a liquidity gate rejected them for it.
    expect(row).toEqual({ volume: null, volume_status: 'omitted' });
  });

  it('stores a genuine zero volume as zero', () => {
    const h = handoff();
    const payload: LegacyBriefHandoff = {
      ...h,
      candidates: [
        { ...h.candidates[0]!, legs: [leg('WIN   261016P00100000', { volume: 0, volumeReported: true })] }
      ]
    };
    writeLegacyHandoff(makeHost(), payload);
    // The other half of the same distinction: the contract really did not trade.
    expect(raw.prepare('SELECT volume, volume_status FROM legacy_brief_leg').get())
      .toEqual({ volume: 0, volume_status: 'ok' });
  });

  it('stores IV as a fraction', () => {
    writeLegacyHandoff(makeHost(), handoff());
    const row = raw.prepare("SELECT iv FROM legacy_brief_leg WHERE osi_symbol LIKE 'WIN%'").get() as { iv: number };
    // 02 §0.1 stores fractions; the existing app holds percentages. The builder
    // converts once, at the border, and this is the assertion that pins it —
    // a 38 here instead of 0.38 is the same hundredfold error as the bootstrap's.
    expect(row.iv).toBeCloseTo(0.38, 10);
  });
});

describe('provenance and stickiness', () => {
  it('archives the payload as a host_app response, so legacy rows have provenance', () => {
    writeLegacyHandoff(makeHost(), handoff());

    const response = raw
      .prepare("SELECT provider, endpoint, parse_status FROM meta_response WHERE provider = 'host_app'")
      .get() as Record<string, unknown>;
    expect(response).toMatchObject({ provider: 'host_app', endpoint: 'legacy/brief-handoff' });

    // AC-1 for the legacy layer: every row points at the archived payload it
    // was parsed from, so the original survives even if the parse is later
    // found wrong.
    const orphans = raw
      .prepare('SELECT COUNT(*) AS n FROM legacy_brief_candidate WHERE source_response_id IS NULL')
      .get();
    expect(orphans).toEqual({ n: 0 });
  });

  it('pins every recommended contract as sticky, in the same write', () => {
    writeLegacyHandoff(makeHost(), handoff());
    const pins = raw
      .prepare("SELECT osi_symbol, reason, valid_to FROM ref_sticky_contract ORDER BY osi_symbol")
      .all() as { osi_symbol: string; reason: string; valid_to: string | null }[];

    // Both legs, the loser's included: the brief considered it, so tomorrow's
    // chain capture should still be able to price it.
    expect(pins).toHaveLength(2);
    expect(pins.every((p) => p.reason === 'recommended_by_legacy' && p.valid_to === null)).toBe(true);
  });

  it('does not pin a contract twice', () => {
    const host = makeHost();
    writeLegacyHandoff(host, handoff({ slot: 'morning', briefId: 76 }));
    const after = writeLegacyHandoff(host, handoff({ slot: 'after_close', briefId: 77 }));

    // Two open ranges for one contract is exactly the ambiguity a validity
    // range exists to prevent, and the second brief of the day recommends the
    // same names as the first far more often than not.
    expect(after.stickyPinned).toBe(0);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM ref_sticky_contract').get()).toEqual({ n: 2 });
  });

  it('records the dice trace including what was NOT selected', () => {
    writeLegacyHandoff(makeHost(), handoff());
    const dice = raw
      .prepare('SELECT eligible_count, selection_rule, eligibility_trace_json FROM legacy_dice_selection')
      .get() as Record<string, string | number>;
    expect(dice['eligible_count']).toBe(1);
    expect(String(dice['eligibility_trace_json'])).toContain('LOSE');
  });
});
