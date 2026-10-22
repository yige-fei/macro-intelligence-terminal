// OS-P2B: local import of a user-chosen daily OHLCV file (CSV or JSON). Everything here runs in the browser on text the
// user selected; nothing is fetched, uploaded, stored or logged. The output is the existing Candle format, so the chart
// and indicator code is reused unchanged. Values are checked, never repaired: any problem rejects the whole file.
//
// Contract (docs/IMPORT.md):
//  - one .csv or .json file, at most MAX_BYTES and MAX_ROWS daily bars; the content must match the extension;
//  - fields date (YYYY-MM-DD, a real calendar date, 1900–2100), open, high, low, close (finite, MIN_PRICE..MAX_PRICE) and
//    volume (finite, >= 0, <= MAX_VOLUME); other columns/keys are ignored and reported;
//  - dates strictly increasing (no duplicates, no reordering); high >= max(open, close), low <= min(open, close);
//  - CSV: RFC 4180 (comma separator, header row, double-quoted fields with "" escapes, LF or CRLF line ends);
//    numbers are plain decimals (no thousands separators, currency signs or percent);
//  - JSON: an array of objects; prices and volume are JSON numbers (text such as "100" is rejected).

import type { Candle } from "./api";

export const IMPORT_LIMITS = { maxBytes: 5 * 1024 * 1024, maxRows: 20_000, minPrice: 1e-6, maxPrice: 1e9, maxVolume: 1e15, maxIssues: 20 } as const;
export const REQUIRED = ["date", "open", "high", "low", "close", "volume"] as const;
type Field = (typeof REQUIRED)[number];

export type ImportFormat = "csv" | "json";
/** row: 1-based data row (the header is not counted); line: physical line in a CSV file. */
export type ImportIssue = { row: number | null; line?: number; field?: string; message: string };
export type ImportResult =
  | { ok: true; format: ImportFormat; candles: Candle[]; first: string; last: string; warnings: string[] }
  | { ok: false; format: ImportFormat | null; issues: ImportIssue[]; truncated: boolean };

const fail = (issues: ImportIssue[], format: ImportFormat | null = null, truncated = false): ImportResult => ({ ok: false, format, issues, truncated });
const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** UTC-midnight timestamp of a strictly valid YYYY-MM-DD date in 1900–2100, or null. */
export function dateToTime(s: string): number | null {
  const m = DATE.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || y > 2100) return null;
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? t / 1000 : null;
}

/** RFC 4180 records. Rejects (rather than guesses at) anything ambiguous. */
export function parseCsv(text: string, maxRecords: number): { records: Array<{ line: number; fields: string[] }>; issue?: ImportIssue } {
  const records: Array<{ line: number; fields: string[] }> = [];
  let fields: string[] = [];
  let field = "";
  let inQuotes = false, quotedField = false, afterQuote = false;
  let line = 1, recordLine = 1, quoteLine = 1;
  const endField = () => { fields.push(field); field = ""; quotedField = false; afterQuote = false; };
  const endRecord = () => {
    endField();
    records.push({ line: recordLine, fields });
    fields = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; afterQuote = true; }
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === ",") { endField(); continue; }
    if (ch === "\n" || (ch === "\r" && text[i + 1] === "\n")) {
      if (ch === "\r") i++;
      endRecord();
      if (records.length > maxRecords) return { records, issue: { row: null, line, message: `more than ${maxRecords - 1} data rows` } };
      line++;
      recordLine = line;
      continue;
    }
    if (ch === "\r") return { records, issue: { row: null, line, message: "a line ends with a bare carriage return (use LF or CRLF line endings)" } };
    if (afterQuote) return { records, issue: { row: null, line, message: "unexpected character after a closing quote" } };
    if (ch === '"') {
      if (field.length > 0 || quotedField) return { records, issue: { row: null, line, message: "a quote appears inside an unquoted field" } };
      inQuotes = true; quotedField = true; quoteLine = line;
      continue;
    }
    field += ch;
  }
  if (inQuotes) return { records, issue: { row: null, line: quoteLine, message: "a quoted field is never closed" } };
  if (field.length > 0 || fields.length > 0 || quotedField) endRecord();
  if (records.length > maxRecords) return { records, issue: { row: null, line, message: `more than ${maxRecords - 1} data rows` } };
  // Trailing empty lines are tolerated; empty lines elsewhere are not.
  while (records.length > 0 && records.at(-1)!.fields.length === 1 && records.at(-1)!.fields[0] === "") records.pop();
  const blank = records.find((r) => r.fields.length === 1 && r.fields[0] === "");
  if (blank) return { records, issue: { row: null, line: blank.line, message: "empty line inside the data" } };
  return { records };
}

type RawRow = { row: number; line?: number; get: (f: Field) => unknown };

/** Shared checks for CSV and JSON rows. */
function validateRows(rows: RawRow[], format: ImportFormat, fromText: boolean): ImportResult {
  const issues: ImportIssue[] = [];
  const add = (i: ImportIssue) => issues.length < IMPORT_LIMITS.maxIssues && issues.push(i);
  const candles: Candle[] = [];
  let prev: { date: string; time: number } | null = null;
  for (const r of rows) {
    const at = { row: r.row, line: r.line };
    const nums: Partial<Record<Field, number>> = {};
    let bad = false;
    for (const f of ["open", "high", "low", "close", "volume"] as const) {
      const v = r.get(f);
      let n: number;
      if (fromText) {
        const s = String(v ?? "").trim();
        if (s === "") { add({ ...at, field: f, message: `${f} is empty` }); bad = true; continue; }
        if (!NUMBER.test(s)) { add({ ...at, field: f, message: `${f} "${s.slice(0, 24)}" is not a plain number` }); bad = true; continue; }
        n = Number(s);
      } else {
        if (v === undefined) { add({ ...at, field: f, message: `${f} is missing` }); bad = true; continue; }
        if (typeof v !== "number") { add({ ...at, field: f, message: `${f} must be a JSON number, not ${v === null ? "null" : typeof v}` }); bad = true; continue; }
        n = v;
      }
      if (!Number.isFinite(n)) { add({ ...at, field: f, message: `${f} is not a finite number` }); bad = true; continue; }
      const max = f === "volume" ? IMPORT_LIMITS.maxVolume : IMPORT_LIMITS.maxPrice;
      if (f === "volume" ? n < 0 : n <= 0) { add({ ...at, field: f, message: f === "volume" ? "volume is negative" : `${f} must be greater than 0` }); bad = true; continue; }
      if (f !== "volume" && n < IMPORT_LIMITS.minPrice) { add({ ...at, field: f, message: `${f} is below ${IMPORT_LIMITS.minPrice}` }); bad = true; continue; }
      if (n > max) { add({ ...at, field: f, message: `${f} exceeds ${max.toExponential()}` }); bad = true; continue; }
      nums[f] = n;
    }
    const rawDate = r.get("date");
    const date = typeof rawDate === "string" ? rawDate.trim() : "";
    const time = typeof rawDate === "string" ? dateToTime(date) : null;
    if (rawDate === undefined) { add({ ...at, field: "date", message: "date is missing" }); bad = true; }
    else if (time === null) { add({ ...at, field: "date", message: `date "${String(rawDate).slice(0, 24)}" is not a valid YYYY-MM-DD calendar date` }); bad = true; }
    else if (prev && date === prev.date) { add({ ...at, field: "date", message: `duplicate date ${date}` }); bad = true; }
    else if (prev && time < prev.time) { add({ ...at, field: "date", message: `date ${date} comes before the previous row's ${prev.date} (dates must increase)` }); bad = true; }
    if (!bad) {
      const { open, high, low, close, volume } = nums as Record<Field, number>;
      if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) {
        add({ ...at, message: `inconsistent prices: high ${high} and low ${low} must enclose open ${open} and close ${close}` });
        bad = true;
      } else {
        candles.push({ date, time: time!, open, high, low, close, adjClose: close, volume });
      }
    }
    if (time !== null && !(prev && time <= prev.time)) prev = { date, time };
    if (issues.length >= IMPORT_LIMITS.maxIssues) return fail(issues, format, true);
  }
  if (issues.length > 0) return fail(issues, format);
  if (candles.length === 0) return fail([{ row: null, message: "the file contains no data rows" }], format);
  return { ok: true, format, candles, first: candles[0].date, last: candles.at(-1)!.date, warnings: [] };
}

/** Parses and validates file text. `name` and `size` are the file's own; nothing here reads from disk. */
export function parseImport(name: string, size: number, text: string): ImportResult {
  const ext = /\.(csv|json)$/i.exec(name)?.[1]?.toLowerCase() as ImportFormat | undefined;
  if (!ext) return fail([{ row: null, message: "unsupported file type: choose a .csv or .json file" }]);
  if (size > IMPORT_LIMITS.maxBytes) return fail([{ row: null, message: `the file is ${(size / 1048576).toFixed(1)} MiB; the limit is 5 MiB` }], ext);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // UTF-8 byte-order mark
  if (text.trim() === "") return fail([{ row: null, message: "the file is empty" }], ext);
  if (text.includes("\u0000") || text.includes("�")) return fail([{ row: null, message: "the file is not plain UTF-8 text" }], ext);
  const firstChar = text.trimStart()[0];

  if (ext === "json") {
    if (firstChar !== "[" && firstChar !== "{") return fail([{ row: null, message: "the .json file does not contain JSON (it should be an array of daily bars)" }], ext);
    let data: unknown;
    try { data = JSON.parse(text); } catch (e) { return fail([{ row: null, message: `not valid JSON: ${(e as Error).message.slice(0, 120)}` }], ext); }
    if (!Array.isArray(data)) return fail([{ row: null, message: "the JSON must be an array of daily bars, e.g. [{\"date\": \"2025-01-02\", \"open\": 100, ...}]" }], ext);
    if (data.length > IMPORT_LIMITS.maxRows) return fail([{ row: null, message: `${data.length} rows; the limit is ${IMPORT_LIMITS.maxRows}` }], ext);
    const extra = new Set<string>();
    const rows: RawRow[] = [];
    for (let i = 0; i < data.length; i++) {
      const o = data[i];
      if (o === null || typeof o !== "object" || Array.isArray(o)) return fail([{ row: i + 1, message: "each row must be an object with date, open, high, low, close and volume" }], ext);
      for (const k of Object.keys(o)) if (!(REQUIRED as readonly string[]).includes(k)) extra.add(k);
      rows.push({ row: i + 1, get: (f) => (Object.prototype.hasOwnProperty.call(o, f) ? (o as Record<string, unknown>)[f] : undefined) });
    }
    const res = validateRows(rows, "json", false);
    if (res.ok && extra.size) res.warnings.push(`ignored keys: ${[...extra].slice(0, 10).join(", ")}`);
    return res;
  }

  if (firstChar === "[" || firstChar === "{") return fail([{ row: null, message: "the .csv file looks like JSON; rename it to .json or export it as CSV" }], ext);
  const { records, issue } = parseCsv(text, IMPORT_LIMITS.maxRows + 1);
  if (issue) return fail([issue], ext);
  const header = records[0].fields.map((h) => h.trim().toLowerCase());
  const dup = header.find((h, i) => header.indexOf(h) !== i);
  if (dup !== undefined) return fail([{ row: null, line: records[0].line, message: `the header repeats the column "${dup}"` }], ext);
  const missing = REQUIRED.filter((f) => !header.includes(f));
  if (missing.length) return fail([{ row: null, line: records[0].line, message: `missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")} (required: ${REQUIRED.join(", ")})` }], ext);
  const idx = Object.fromEntries(REQUIRED.map((f) => [f, header.indexOf(f)])) as Record<Field, number>;
  const rows: RawRow[] = [];
  for (let i = 1; i < records.length; i++) {
    const r = records[i];
    if (r.fields.length !== header.length)
      return fail([{ row: i, line: r.line, message: `has ${r.fields.length} fields; the header has ${header.length}` }], ext);
    rows.push({ row: i, line: r.line, get: (f) => r.fields[idx[f]] });
  }
  const res = validateRows(rows, "csv", true);
  const extra = header.filter((h) => !(REQUIRED as readonly string[]).includes(h));
  if (res.ok && extra.length) res.warnings.push(`ignored columns: ${extra.slice(0, 10).join(", ")}`);
  return res;
}

/** Reads one user-selected file (File API) after the size check, then parses it. */
export async function importFile(file: File): Promise<ImportResult> {
  if (file.size > IMPORT_LIMITS.maxBytes) return parseImport(file.name, file.size, "");
  return parseImport(file.name, file.size, await file.text());
}

/** "row 12 (line 13), volume: …" */
export function describeIssue(i: ImportIssue): string {
  const where = i.row !== null ? `row ${i.row}${i.line !== undefined ? ` (line ${i.line})` : ""}` : i.line !== undefined ? `line ${i.line}` : "file";
  return `${where}: ${i.message}`;
}
