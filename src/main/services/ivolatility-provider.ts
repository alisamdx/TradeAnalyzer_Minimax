// IVolatility.com Data Cloud API client.
// Endpoint: GET https://restapi.ivolatility.com/equities/eod/ivx
// Returns pre-computed constant-maturity ATM IV (IVX) for fixed tenors
// (7, 14, 21, 30, 60, 90, 120, 180, 360 days) as true as-of-date snapshots.
// This is the primary source for IV history backfill.
//
// Authentication: apiKey query parameter stored encrypted in settings ('ivolatilityApiKey').
// The API rejects Authorization: Bearer headers — auth must be passed as ?apiKey=...

const BASE_URL = 'https://restapi.ivolatility.com';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IVxRow {
  date:   string;          // YYYY-MM-DD
  iv7:    number | null;   // 7-day constant-maturity ATM IV (decimal, 0.28 = 28%)
  iv14:   number | null;
  iv21:   number | null;
  iv30:   number | null;   // ← primary target for IV history
  iv60:   number | null;
  iv90:   number | null;
  iv120:  number | null;
  iv180:  number | null;
  iv360:  number | null;
}

export interface IVxResult {
  s:      string;          // 'ok' | 'no_data' | 'error'
  symbol: string;
  rows:   IVxRow[];
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class IVolatilityProvider {
  constructor(private readonly getApiKey: () => string) {}

  /**
   * Returns the raw unparsed API response — used by the Test API screen
   * to inspect actual field names and response structure.
   */
  async getRawIvx(symbol: string, from: string, to: string): Promise<unknown> {
    const key = this.getApiKey();
    if (!key) throw new Error('IVolatility API key not configured.');
    const url = `${BASE_URL}/equities/eod/ivx?symbol=${encodeURIComponent(symbol.toUpperCase())}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&apiKey=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`IVolatility error (${res.status}): ${body.slice(0, 400)}`);
    }
    return res.json();
  }

  /**
   * Fetch and parse the IVX time series for a ticker and date range.
   * Returns daily iv30 (and other tenors) as true as-of-date snapshots.
   */
  async getIvx(symbol: string, from: string, to: string): Promise<IVxResult> {
    const raw = await this.getRawIvx(symbol, from, to);
    return parseIvxResponse(raw, symbol);
  }
}

// ─── Parser ───────────────────────────────────────────────────────────────────
// We don't know the exact field names until we test the API, so we try
// multiple candidate names for each field.  The raw response inspection in
// the Test API screen will reveal the actual names on first run.

function pickNum(row: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'number' && isFinite(v)) return v;
    // Some providers return IV as a percentage string ("28.50") — convert.
    if (typeof v === 'string' && v.trim() !== '') {
      const n = parseFloat(v);
      if (isFinite(n)) return n > 2 ? n / 100 : n; // >2 → treat as pct, normalise to decimal
    }
  }
  return null;
}

function pickDate(row: Record<string, unknown>): string {
  for (const k of ['date', 'tradeDate', 'trade_date', 'Date', 'quoteDate']) {
    const v = row[k];
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  }
  return '';
}

function parseRow(row: Record<string, unknown>): IVxRow {
  return {
    date:  pickDate(row),
    // IVolatility field names use spaced format: "30d IV Mean" / "30d IV Call" / "30d IV Put"
    iv7:   pickNum(row, '7d IV Mean',   '7d IV Call',   'iv7',   'ivx7',   'ivx_7d',   'iv_7',   'iv7d'),
    iv14:  pickNum(row, '14d IV Mean',  '14d IV Call',  'iv14',  'ivx14',  'ivx_14d',  'iv_14',  'iv14d'),
    iv21:  pickNum(row, '21d IV Mean',  '21d IV Call',  'iv21',  'ivx21',  'ivx_21d',  'iv_21',  'iv21d'),
    iv30:  pickNum(row, '30d IV Mean',  '30d IV Call',  'iv30',  'ivx30',  'ivx_30d',  'iv_30',  'iv30d', 'ivxm1', 'iv1m'),
    iv60:  pickNum(row, '60d IV Mean',  '60d IV Call',  'iv60',  'ivx60',  'ivx_60d',  'iv_60',  'iv60d', 'ivxm2', 'iv2m'),
    iv90:  pickNum(row, '90d IV Mean',  '90d IV Call',  'iv90',  'ivx90',  'ivx_90d',  'iv_90',  'iv90d', 'ivxm3', 'iv3m'),
    iv120: pickNum(row, '120d IV Mean', '120d IV Call', 'iv120', 'ivx120', 'ivx_120d', 'iv_120'),
    iv180: pickNum(row, '180d IV Mean', '180d IV Call', 'iv180', 'ivx180', 'ivx_180d', 'iv_180', 'ivxm6', 'iv6m'),
    iv360: pickNum(row, '360d IV Mean', '360d IV Call', 'iv360', 'ivx360', 'ivx_360d', 'iv_360', 'ivx1y', 'iv1y'),
  };
}

export function parseIvxResponse(raw: unknown, symbol: string): IVxResult {
  // Handle multiple possible response envelopes:
  // 1. Top-level array: [{ date, iv30, ... }, ...]
  // 2. { data: [...] }
  // 3. { rows: [...] }
  // 4. { results: [...] }

  let rowsRaw: unknown[] = [];

  if (Array.isArray(raw)) {
    rowsRaw = raw;
  } else if (raw !== null && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const key of ['data', 'rows', 'results', 'records', 'ivx']) {
      if (Array.isArray(obj[key])) { rowsRaw = obj[key] as unknown[]; break; }
    }
  }

  if (rowsRaw.length === 0) {
    return { s: 'no_data', symbol, rows: [] };
  }

  const rows = rowsRaw
    .filter(r => r !== null && typeof r === 'object')
    .map(r => parseRow(r as Record<string, unknown>))
    .filter(r => r.date !== '')
    .sort((a, b) => a.date.localeCompare(b.date));

  return { s: 'ok', symbol, rows };
}
