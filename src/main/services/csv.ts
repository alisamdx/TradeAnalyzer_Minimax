// Hand-rolled CSV per FR-1.8 / FR-1.9. Header row required; required column "ticker";
// optional "notes" and "added_date". RFC-4180-ish: handles CRLF, quoted fields, and
// embedded commas/quotes. Pluggable later if we outgrow it.

export interface ParsedRow {
  ticker: string;
  notes: string | null;
  addedDate: string | null;
}

export interface ParseError {
  row: number; // 1-based, includes header
  ticker: string;
  reason: string;
}

export interface ParseResult {
  rows: ParsedRow[];
  errors: ParseError[];
}

const REQUIRED_HEADER = 'ticker';
const OPTIONAL_HEADERS = ['notes', 'added_date'];

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  let inQuotes = false;
  while (i < line.length) {
    const c = line[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cur += c;
      i++;
      continue;
    }
    if (c === ',') {
      out.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (c === '"' && cur.length === 0) {
      inQuotes = true;
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  out.push(cur);
  return out;
}

function escapeCsvCell(v: string): string {
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

export function parseCsv(text: string): ParseResult {
  const errors: ParseError[] = [];
  const rows: ParsedRow[] = [];

  // Strip BOM, normalize line endings, drop trailing blank lines.
  const cleaned = text.replace(/^\xef\xbb\xbf/, '').replace(/\r\n?/g, '\n');
  const lines = cleaned.split('\n');
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();

  if (lines.length === 0) {
    return { rows, errors: [{ row: 0, ticker: '', reason: 'Empty CSV file' }] };
  }

  const headerCells = splitCsvLine(lines[0]!).map((h) => h.trim().toLowerCase());
  const tickerIdx = headerCells.indexOf(REQUIRED_HEADER);
  if (tickerIdx === -1) {
    return {
      rows,
      errors: [{ row: 1, ticker: '', reason: `Missing required header column "${REQUIRED_HEADER}"` }]
    };
  }
  const notesIdx = headerCells.indexOf('notes');
  const dateIdx = headerCells.indexOf('added_date');

  for (const opt of headerCells) {
    if (opt === REQUIRED_HEADER) continue;
    if (OPTIONAL_HEADERS.includes(opt)) continue;
    // Unknown columns are ignored, not an error -- keeps round-trip flexible.
  }

  for (let i = 1; i < lines.length; i++) {
    const lineRaw = lines[i]!;
    if (lineRaw.trim() === '') continue;
    const cells = splitCsvLine(lineRaw);
    const ticker = (cells[tickerIdx] ?? '').trim();
    if (!ticker) {
      errors.push({ row: i + 1, ticker: '', reason: 'Empty ticker' });
      continue;
    }
    const notes = notesIdx >= 0 ? (cells[notesIdx] ?? '').trim() : '';
    const dateStr = dateIdx >= 0 ? (cells[dateIdx] ?? '').trim() : '';
    rows.push({
      ticker: ticker.toUpperCase(),
      notes: notes === '' ? null : notes,
      addedDate: dateStr === '' ? null : dateStr
    });
  }

  return { rows, errors };
}

export function buildCsv(rows: Array<{ ticker: string; addedDate: string; notes: string | null }>): string {
  const lines: string[] = ['ticker,added_date,notes'];
  for (const r of rows) {
    lines.push(
      [escapeCsvCell(r.ticker), escapeCsvCell(r.addedDate), escapeCsvCell(r.notes ?? '')].join(',')
    );
  }
  return lines.join('\n') + '\n';
}
