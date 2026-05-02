import { describe, it, expect } from 'vitest';
import { parseCsv, buildCsv } from '../src/main/services/csv.js';
import { makeService } from './helpers.js';

describe('CSV parser', () => {
  it('parses a minimal valid file', () => {
    const result = parseCsv('ticker\nAAPL\nMSFT\n');
    expect(result.errors).toEqual([]);
    expect(result.rows.map((r) => r.ticker)).toEqual(['AAPL', 'MSFT']);
  });

  it('uppercases tickers and trims whitespace', () => {
    const result = parseCsv('ticker\n  aapl  \nmsft\n');
    expect(result.rows.map((r) => r.ticker)).toEqual(['AAPL', 'MSFT']);
  });

  it('reads notes and added_date when present', () => {
    const csv = 'ticker,added_date,notes\nAAPL,2026-01-15,core position\nMSFT,2026-02-01,\n';
    const { rows, errors } = parseCsv(csv);
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({
      ticker: 'AAPL',
      addedDate: '2026-01-15',
      notes: 'core position'
    });
    expect(rows[1]!.notes).toBeNull();
  });

  it('handles quoted fields with embedded commas and quotes', () => {
    const csv = 'ticker,notes\nAAPL,"hello, world"\nMSFT,"she said ""hi"""\n';
    const { rows } = parseCsv(csv);
    expect(rows[0]!.notes).toBe('hello, world');
    expect(rows[1]!.notes).toBe('she said "hi"');
  });

  it('handles CRLF line endings and a UTF-8 BOM', () => {
    const csv = '﻿ticker\r\nAAPL\r\nMSFT\r\n';
    const { rows, errors } = parseCsv(csv);
    expect(errors).toEqual([]);
    expect(rows.map((r) => r.ticker)).toEqual(['AAPL', 'MSFT']);
  });

  it('rejects files missing the required ticker header', () => {
    const { errors } = parseCsv('symbol\nAAPL\n');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.reason).toMatch(/Missing required header/);
  });

  it('rejects an empty file', () => {
    const { errors } = parseCsv('');
    expect(errors).toHaveLength(1);
  });

  it('reports rows with empty tickers without aborting (FR-1.10)', () => {
    const csv = 'ticker,notes\nAAPL,a\n,oops\nMSFT,b\n';
    const { rows, errors } = parseCsv(csv);
    expect(rows.map((r) => r.ticker)).toEqual(['AAPL', 'MSFT']);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.row).toBe(3);
  });

  it('ignores trailing blank lines', () => {
    const { rows, errors } = parseCsv('ticker\nAAPL\n\n\n');
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
  });

  it('ignores unknown columns', () => {
    const { rows, errors } = parseCsv('ticker,sector\nAAPL,Tech\n');
    expect(errors).toEqual([]);
    expect(rows[0]!.ticker).toBe('AAPL');
  });
});

describe('CSV builder', () => {
  it('emits header + rows with proper quoting', () => {
    const csv = buildCsv([
      { ticker: 'AAPL', addedDate: '2026-01-15', notes: 'hello, world' },
      { ticker: 'MSFT', addedDate: '2026-02-01', notes: 'she said "hi"' }
    ]);
    expect(csv).toBe(
      'ticker,added_date,notes\nAAPL,2026-01-15,"hello, world"\nMSFT,2026-02-01,"she said ""hi"""\n'
    );
  });

  it('writes empty string for null notes', () => {
    const csv = buildCsv([{ ticker: 'AAPL', addedDate: '2026-01-15', notes: null }]);
    expect(csv).toBe('ticker,added_date,notes\nAAPL,2026-01-15,\n');
  });
});

describe('CSV round-trip (FR-1 acceptance)', () => {
  it('export → parse → bulk-add reproduces the original watchlist', () => {
    const { service } = makeService();
    const original = service.create('Source');
    service.addItem(original.id, 'AAPL', 'core');
    service.addItem(original.id, 'MSFT', 'cloud, AI');
    service.addItem(original.id, 'NVDA', null);

    const items = service.listItems(original.id);
    const csv = buildCsv(
      items.map((i) => ({ ticker: i.ticker, addedDate: i.addedAt, notes: i.notes }))
    );

    const parsed = parseCsv(csv);
    expect(parsed.errors).toEqual([]);

    const target = service.create('Restored');
    const bulk = service.addItemsBulk(
      target.id,
      parsed.rows.map((r) => ({ ticker: r.ticker, notes: r.notes, addedAt: r.addedDate }))
    );
    expect(bulk.skipped).toEqual([]);

    const restored = service.listItems(target.id);
    expect(restored.map((i) => i.ticker).sort()).toEqual(items.map((i) => i.ticker).sort());

    const byTicker = (arr: typeof items) =>
      Object.fromEntries(arr.map((i) => [i.ticker, { notes: i.notes, addedAt: i.addedAt }]));
    expect(byTicker(restored)).toEqual(byTicker(items));
  });
});
