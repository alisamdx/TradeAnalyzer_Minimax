// Tests for the shared strategy→structure source of truth.
// Guards the drift that left the critic's copy without an `inflection` entry,
// making it structure-blind on the v2 launch strategy.

import { describe, it, expect } from 'vitest';
import { STRATEGY_RELEVANT_SLUGS, pickRelevantStructure, pickDisplayStructure, formatStructureLegs } from '../src/shared/strategy-structures.js';
import { STRATEGIES } from '../src/main/services/scoring-service.js';

type Score = { slug: string; grade: string; setup: { unavailableReason?: string | null; maxLoss?: number | null } | null };
const valid = (slug: string, grade: string): Score => ({ slug, grade, setup: { unavailableReason: null } });
// Defined-risk (bounded maxLoss) vs unbounded (null maxLoss) structures.
const defined   = (slug: string, grade: string): Score => ({ slug, grade, setup: { unavailableReason: null, maxLoss: -5000 } });
const unbounded = (slug: string, grade: string): Score => ({ slug, grade, setup: { unavailableReason: null, maxLoss: null } });

describe('formatStructureLegs', () => {
  it('renders a put zebra with the 2× body so it is not mistaken for a single strike', () => {
    expect(formatStructureLegs([
      { action: 'buy', side: 'put', strike: 37.5, qty: 2 },
      { action: 'sell', side: 'put', strike: 35 },
    ])).toEqual(['buy 2× put $37.5', 'sell put $35']);
  });

  it('omits the multiplier for single-quantity legs', () => {
    expect(formatStructureLegs([
      { action: 'buy', side: 'put', strike: 67.5 },
      { action: 'sell', side: 'put', strike: 62.5, qty: 1 },
    ])).toEqual(['buy put $67.5', 'sell put $62.5']);
  });
});

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

describe('pickRelevantStructure — directional-fit preference (de-prioritise pin bets)', () => {
  // Inputs are given best-first (highest totalScore first), mirroring lab output.
  it('bearish: prefers a viable directional vertical over a higher-graded pin butterfly', () => {
    const chosen = pickRelevantStructure(
      [defined('put-butterfly', 'A'), defined('long-put-vertical', 'B')],
      'bearish',
    );
    expect(chosen?.slug).toBe('long-put-vertical'); // butterfly A is a pin bet; vertical B is directional
  });

  it('bearish: KEEPS the butterfly when the only directional alternatives are grade F', () => {
    const chosen = pickRelevantStructure(
      [defined('put-butterfly', 'C'), defined('poor-mans-covered-put', 'F'), defined('long-put-vertical', 'F')],
      'bearish',
    );
    expect(chosen?.slug).toBe('put-butterfly'); // no directional structure grades ≥ C
  });

  it('bearish: KEEPS the butterfly when the best directional is only grade D', () => {
    const chosen = pickRelevantStructure(
      [defined('put-butterfly', 'B'), defined('put-zebra', 'D')],
      'bearish',
    );
    expect(chosen?.slug).toBe('put-butterfly');
  });

  it('bullish: de-prioritises a call butterfly the same way', () => {
    const chosen = pickRelevantStructure(
      [defined('call-butterfly', 'A'), defined('long-call-vertical', 'B')],
      'bullish',
    );
    expect(chosen?.slug).toBe('long-call-vertical');
  });

  it('is a no-op when no butterfly is in the pool (keeps the best non-pin structure)', () => {
    const chosen = pickRelevantStructure(
      [defined('big-lizard', 'A'), defined('long-call-vertical', 'B')],
      'bullish',
    );
    expect(chosen?.slug).toBe('big-lizard'); // big-lizard is not a pin bet — best-first wins
  });

  it('does not apply to non-directional strategies (income iron fly is kept)', () => {
    const chosen = pickRelevantStructure(
      [defined('iron-fly', 'A'), defined('iron-condor', 'B')],
      'income',
    );
    expect(chosen?.slug).toBe('iron-fly'); // income is range-bound; pin-tent structures are fine
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
