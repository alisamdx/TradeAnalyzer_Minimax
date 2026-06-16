// Tests for the shared strategy→structure source of truth.
// Guards the drift that left the critic's copy without an `inflection` entry,
// making it structure-blind on the v2 launch strategy.

import { describe, it, expect } from 'vitest';
import { STRATEGY_RELEVANT_SLUGS, pickRelevantStructure } from '../src/shared/strategy-structures.js';
import { STRATEGIES } from '../src/main/services/scoring-service.js';

type Score = { slug: string; grade: string; setup: { unavailableReason?: string | null } | null };
const valid = (slug: string, grade: string): Score => ({ slug, grade, setup: { unavailableReason: null } });

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
