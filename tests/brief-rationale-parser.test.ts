// Regression tests for Stage-5 rationale parsing (v0.32.80).
// Bug: max_tokens truncated the JSON array mid-object, the old `\[[\s\S]*\]`
// regex found no closing bracket, and all 25 rationales were dropped silently.

import { describe, it, expect } from 'vitest';
import { parseRationaleResponse } from '../src/main/services/brief-rationale-parser.js';

const item = (t: string, s: string) =>
  `{"ticker":"${t}","strategy":"${s}","rationale":"IVR 72 and RSI 58 support the ${s} setup."}`;

describe('parseRationaleResponse', () => {
  it('parses a complete JSON array', () => {
    const text = `Here are the rationales:\n[${item('AMD', 'wheel')},${item('ALAB', 'buy')}]`;
    const out = parseRationaleResponse(text);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ ticker: 'AMD', strategy: 'wheel' });
  });

  it('salvages complete objects from a truncated array (the max_tokens bug)', () => {
    // Truncated mid-third-object — no closing ] anywhere.
    const text = `[${item('AMD', 'wheel')},\n${item('GLW', 'income')},\n{"ticker":"TER","strategy":"wheel","rat`;
    const out = parseRationaleResponse(text);
    expect(out).toHaveLength(2);
    expect(out.map(o => o.ticker)).toEqual(['AMD', 'GLW']);
  });

  it('returns [] for unparseable text', () => {
    expect(parseRationaleResponse('Sorry, I cannot help with that.')).toEqual([]);
  });

  it('skips malformed or incomplete objects but keeps valid ones', () => {
    const text = `[{"ticker":"AMD"},${item('GLW', 'income')},{"ticker":"X","strategy":"buy","rationale":""}]`;
    const out = parseRationaleResponse(text);
    expect(out).toHaveLength(1);
    expect(out[0]!.ticker).toBe('GLW');
  });

  it('handles prose around the array', () => {
    const text = `I reviewed the picks.\n\n[${item('RGLD', 'income')}]\n\nLet me know if you need more.`;
    expect(parseRationaleResponse(text)).toHaveLength(1);
  });
});
