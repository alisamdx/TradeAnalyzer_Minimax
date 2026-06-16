// Tests for the shared strategy→structure source of truth.
// Guards the drift that left the critic's copy without an `inflection` entry,
// making it structure-blind on the v2 launch strategy.

import { describe, it, expect } from 'vitest';
import { STRATEGY_RELEVANT_SLUGS, pickRelevantStructure, pickDisplayStructure } from '../src/shared/strategy-structures.js';
import { STRATEGIES } from '../src/main/services/scoring-service.js';

type Score = { slug: string; grade: string; setup: { unavailableReason?: string | null; maxLoss?: number | null } | null };
const valid = (slug: string, grade: string): Score => ({ slug, grade, setup: { unavailableReason: null } });
// Defined-risk (bounded maxLoss) vs unbounded (null maxLoss) structures.
const defined   = (slug: string, grade: string): Score => ({ slug, grade, setup: { unavailableReason: null, maxLoss: -5000 } });
const unbounded = (slug: string, grade: string): Score => ({ slug, grade, setup: { unavailableReason: null, maxLoss: null } });

describe('STRATEGY_RELEVANT_SLUGS — coverage parity', () => {
  it('covers every scoring strategy with a non-empty slug list', () => {
    // This is the guarantee the critic lacked: a strategy missing here means the
    // critic/brief silently run structure-blind on it.
    for (const strategy of STRATEGIES) {
      expect(STRATEGY_RELEVANT_SLUGS[strategy], `missing slugs for ${strategy}`).toBeDefined();
      expect((STRATEGY_RELEVANT_SLUGS[strategy] ?? []).length, `empty slugs for ${strategy}`).toBeGreaterThan(0);
    }
  });

  it('maps inflection to its directional credit spreads', () => {
    expect(STRATEGY_RELEVANT_SLUGS['inflection']).toEqual(['short-put-vertical', 'short-call-vertical']);
  });
});

describe('pickRelevantStructure', () => {
  it('resolves an inflection structure (regression: critic returned null before the fix)', () => {
    const chosen = pickRelevantStructure(
      [valid('short-put-vertical', 'A+'), valid('big-lizard', 'A+')],
      'inflection',
    );
    expect(chosen?.slug).toBe('short-put-vertical'); // big-lizard is not inflection-relevant
  });

  it('for inflection, prefers the higher-graded of the two opposite verticals', () => {
    const chosen = pickRelevantStructure(
      [valid('short-put-vertical', 'B'), valid('short-call-vertical', 'A+')],
      'inflection',
    );
    expect(chosen?.slug).toBe('short-call-vertical');
  });

  it('for non-inflection, returns the first relevant valid structure in lab (best-first) order', () => {
    // Lab scores arrive pre-sorted best-first, so first relevant match = chosen.
    // Non-relevant slugs are skipped even when they sort ahead.
    const chosen = pickRelevantStructure(
      [valid('iron-condor', 'A+'), valid('big-lizard', 'A'), valid('long-call-vertical', 'A')],
      'bullish',
    );
    expect(chosen?.slug).toBe('big-lizard'); // iron-condor not bullish-relevant; big-lizard is first relevant
  });

  it('skips structures with an unavailableReason', () => {
    const chosen = pickRelevantStructure(
      [
        { slug: 'short-naked-put', grade: 'A+', setup: { unavailableReason: 'no chain' } },
        { slug: 'covered-call', grade: 'B', setup: { unavailableReason: null } },
      ],
      'wheel',
    );
    expect(chosen?.slug).toBe('covered-call');
  });

  it('returns null when no relevant structure exists', () => {
    expect(pickRelevantStructure([valid('iron-condor', 'A+')], 'wheel')).toBeNull();
    expect(pickRelevantStructure([], 'inflection')).toBeNull();
    expect(pickRelevantStructure(null, 'wheel')).toBeNull();
  });
});

describe('pickRelevantStructure — defined-risk preference', () => {
  it('income: prefers a defined-risk iron condor over a higher-scored unbounded straddle', () => {
    // Straddle sorts first (best totalScore) but is unbounded; the iron condor is capped-risk.
    const chosen = pickRelevantStructure(
      [unbounded('short-straddle', 'A+'), defined('iron-condor', 'B')],
      'income',
    );
    expect(chosen?.slug).toBe('iron-condor');
  });

  it('bearish: prefers a defined-risk put vertical over an unbounded reverse big lizard', () => {
    const chosen = pickRelevantStructure(
      [unbounded('reverse-big-lizard', 'A+'), defined('long-put-vertical', 'A')],
      'bearish',
    );
    expect(chosen?.slug).toBe('long-put-vertical');
  });

  it('falls back to the unbounded structure when no defined-risk alternative is viable', () => {
    const chosen = pickRelevantStructure([unbounded('short-strangle', 'A+')], 'income');
    expect(chosen?.slug).toBe('short-strangle');
  });

  it('among multiple defined-risk structures, keeps best-first (lab) order', () => {
    const chosen = pickRelevantStructure(
      [unbounded('short-straddle', 'A+'), defined('iron-fly', 'A'), defined('iron-condor', 'B')],
      'income',
    );
    expect(chosen?.slug).toBe('iron-fly'); // first defined-risk in best-first order
  });

  it('is a no-op for inflection (both verticals are already defined-risk)', () => {
    const chosen = pickRelevantStructure(
      [defined('short-put-vertical', 'A'), defined('short-call-vertical', 'A+')],
      'inflection',
    );
    expect(chosen?.slug).toBe('short-call-vertical'); // still higher-graded vertical
  });
});

describe('pickDisplayStructure — selection with display fallback', () => {
  it('returns the chosen valid structure (defined-risk preferred)', () => {
    expect(pickDisplayStructure(
      [unbounded('short-straddle', 'A+'), defined('iron-condor', 'B')], 'income',
    )?.slug).toBe('iron-condor');
  });

  it('falls back to the first relevant structure when none are valid', () => {
    const chosen = pickDisplayStructure(
      [{ slug: 'long-put-vertical', grade: 'F', setup: { unavailableReason: 'no chain' } }],
      'bearish',
    );
    expect(chosen?.slug).toBe('long-put-vertical'); // unavailable, but still labelled
  });

  it('falls back to the top-overall structure when nothing is relevant', () => {
    const chosen = pickDisplayStructure([valid('iron-condor', 'A+')], 'wheel');
    expect(chosen?.slug).toBe('iron-condor'); // not wheel-relevant, but something to render
  });
});
