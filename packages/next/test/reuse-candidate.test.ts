import { describe, it, expect } from 'vitest';
import { reuseCandidateFor, reuseSummary } from '../src/main/exceptions.js';

/**
 * Which findings offer the "Confirm ticker reuse" panel, and what it pre-fills.
 *
 * The pre-filled splice date is the dangerous part. It is an editable field that
 * looks authoritative, and a ticker under reuse carries many findings: SOLS had
 * 21 QC-204 steps on 2026-09-17, twenty of them dated inside the *previous*
 * occupant's history. Open the wrong one and the form offers a date three years
 * early, which closes the membership range in the wrong place — silently, since
 * nothing downstream can tell a mis-dated splice from a correct one.
 */
describe('the reuse panel offer', () => {
  it('offers on each check that is evidence of a splice', () => {
    for (const check of ['QC-204', 'QC-205', 'QC-209', 'QC-210']) {
      expect(reuseCandidateFor(check, 'SOLS 2025-10-30'), check).not.toBeNull();
    }
  });

  it('does not offer on a check that says nothing about identity', () => {
    // QC-603's earnings staleness is keyed by bare ticker too, and a ruling
    // about which company the old bars belonged to does not answer it.
    expect(reuseCandidateFor('QC-603', 'JHX')).toBeNull();
    expect(reuseCandidateFor('QC-409', 'BRK.B-261016P00495000')).toBeNull();
  });

  it('takes the splice date from the key of the finding being ruled on', () => {
    expect(reuseCandidateFor('QC-209', 'SOLS 2025-10-30')).toEqual({
      ticker: 'SOLS', spliceDate: '2025-10-30'
    });
  });

  it('offers the WRONG date from a pre-splice finding — which is why the panel is opened from the splice', () => {
    // Not a bug to fix here: the key is the only date this finding has, and
    // inventing a better one would be a guess. The operator opens the finding
    // at the splice; this test pins the consequence of not doing so, so nobody
    // later "fixes" the pre-fill by inferring a date from somewhere else.
    expect(reuseCandidateFor('QC-204', 'SOLS 2022-07-26')?.spliceDate).toBe('2022-07-26');
  });

  it('offers no date at all for QC-210, whose key is a bare ticker', () => {
    // The honest answer: QC-210's evidence is "some bars predate the listing",
    // not "the splice is here". An empty field asks the operator for the date
    // rather than proposing one the check never measured.
    expect(reuseCandidateFor('QC-210', 'SOLS')).toEqual({ ticker: 'SOLS', spliceDate: null });
  });

  it('offers no date when the key carries something that is not a date', () => {
    expect(reuseCandidateFor('QC-205', 'SOLS not-a-date')?.spliceDate).toBeNull();
  });

  it('returns null for an empty key rather than a candidate with no ticker', () => {
    expect(reuseCandidateFor('QC-204', '')).toBeNull();
  });
});

describe('what the operator reads back after a ruling', () => {
  it('reports how many further findings the ruling settled', () => {
    // The number that says it worked. Without it a ruling that cascaded and one
    // that resolved a single finding, leaving twenty open, read identically.
    const text = reuseSummary({ closed: 1, opened: 1, spliceDate: '2025-10-30', alsoResolved: 43 });
    expect(text).toContain('2025-10-30');
    expect(text).toContain('43 further finding(s)');
  });

  it('says zero out loud rather than omitting it', () => {
    // Zero is a finding: the ruling landed but nothing cascaded, which is what a
    // stale build or a mis-dated splice looks like.
    expect(reuseSummary({ closed: 1, opened: 1, spliceDate: '2026-03-20', alsoResolved: 0 }))
      .toContain('Resolved 0 further finding(s)');
  });

  it('does not claim anything was deleted', () => {
    const text = reuseSummary({ closed: 1, opened: 1, spliceDate: '2025-10-30', alsoResolved: 4 });
    expect(text).toContain('No bars were deleted');
  });
});
