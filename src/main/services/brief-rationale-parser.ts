// Parses the Stage-5 AI rationale response for the daily brief.
// Pure module (no electron imports) so it is unit-testable.
//
// The model is asked for a JSON array of {ticker, strategy, rationale}. If the
// response hits max_tokens the array is cut mid-object and has no closing `]` —
// the old single-regex approach matched nothing and silently dropped all 25
// rationales. This parser salvages every complete object from a truncated array.

export interface RationaleItem {
  ticker: string;
  strategy: string;
  rationale: string;
}

function isRationaleItem(o: unknown): o is RationaleItem {
  if (!o || typeof o !== 'object') return false;
  const r = o as Record<string, unknown>;
  return typeof r['ticker'] === 'string' &&
    typeof r['strategy'] === 'string' &&
    typeof r['rationale'] === 'string' && r['rationale'].length > 0;
}

export function parseRationaleResponse(text: string): RationaleItem[] {
  // Fast path: a complete, well-formed JSON array.
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      const parsed: unknown = JSON.parse(arrMatch[0]);
      if (Array.isArray(parsed)) return parsed.filter(isRationaleItem);
    } catch {
      // malformed despite brackets — fall through to object salvage
    }
  }

  // Salvage path: pull each complete top-level object out individually.
  // Rationale objects are flat (no nested braces), so a non-greedy
  // brace-to-brace match per object is safe.
  const items: RationaleItem[] = [];
  for (const m of text.matchAll(/\{[^{}]*\}/g)) {
    try {
      const obj: unknown = JSON.parse(m[0]);
      if (isRationaleItem(obj)) items.push(obj);
    } catch {
      // incomplete trailing object — skip
    }
  }
  return items;
}
