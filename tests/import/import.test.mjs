// Unit tests for web/lib/importData.ts (the browser-side importer), run directly by Node's test runner:
//   node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON tests/import/
// Node >= 22.18 (or 23.6) loads the TypeScript module natively. Fixtures are fictional (tests/fixtures/import/README.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { parseImport, parseCsv, dateToTime, describeIssue, IMPORT_LIMITS } = await import(join(ROOT, "web", "lib", "importData.ts"));
const FIX = join(ROOT, "tests", "fixtures", "import");
const load = (name) => parseImport(name, statSync(join(FIX, name)).size, readFileSync(join(FIX, name), "utf8"));
const messages = (r) => r.issues.map(describeIssue).join(" | ");

test("valid CSV: 250 bars in order, exact values, contract fields", () => {
  const r = load("valid_daily_250.csv");
  assert.equal(r.ok, true, r.ok ? "" : messages(r));
  assert.equal(r.format, "csv");
  assert.equal(r.candles.length, 250);
  assert.equal(r.first, "2024-01-02");
  assert.deepEqual(r.candles[0], { date: "2024-01-02", time: 1704153600, open: 269.1098, high: 272.1063, low: 268.5593, close: 271.8281, adjClose: 271.8281, volume: 92657 });
  for (let i = 1; i < r.candles.length; i++) assert.ok(r.candles[i].time > r.candles[i - 1].time);
  assert.deepEqual(r.warnings, []);
});

test("valid JSON: 40 bars", () => {
  const r = load("valid_daily_40.json");
  assert.equal(r.ok, true, r.ok ? "" : messages(r));
  assert.equal(r.format, "json");
  assert.equal(r.candles.length, 40);
});

test("CSV quoting: CRLF, quoted number, quoted commas and escaped quotes; extra column reported", () => {
  const r = load("quoted_crlf.csv");
  assert.equal(r.ok, true, r.ok ? "" : messages(r));
  assert.equal(r.candles.length, 5);
  assert.equal(r.candles[0].open, 99); // the quoted "99.0" parses to the same number
  assert.deepEqual(r.warnings, ["ignored columns: note"]);
  const { records } = parseCsv('a,"b, ""c""",d\r\n1,2,3\r\n', 10);
  assert.deepEqual(records.map((x) => x.fields), [["a", 'b, "c"', "d"], ["1", "2", "3"]]);
});

test("short file is valid (indicator warm-up is a display concern)", () => {
  const r = load("short_15.csv");
  assert.equal(r.ok, true);
  assert.equal(r.candles.length, 15);
});

const rejects = {
  "missing_column.csv": /missing column: volume/,
  "bad_quoting.csv": /quoted field is never closed/,
  "invalid.json": /not valid JSON/,
  "duplicate_dates.csv": /row 4 \(line 5\): duplicate date 2025-02-05/,
  "out_of_order.csv": /row 3 \(line 4\): date 2025-02-04 comes before the previous row's 2025-02-05/,
  "impossible_date.csv": /row 3 \(line 4\): date "2025-02-30" is not a valid YYYY-MM-DD calendar date/,
  "negative_price.csv": /row 2 \(line 3\): open must be greater than 0/,
  "high_below_low.csv": /row 5 \(line 6\): inconsistent prices/,
  "missing_volume.json": /row 3: volume is missing/,
  "nonfinite.csv": /row 3 \(line 4\): close "NaN" is not a plain number/,
  "extreme.csv": /row 3 \(line 4\): high is not a finite number/,
  "text_numbers.json": /row 1: open must be a JSON number, not string/,
  "thousands_separator.csv": /volume "1,234" is not a plain number/,
  "empty.csv": /the file is empty/,
  "unsupported.txt": /unsupported file type/,
  "csv_content.json": /does not contain JSON/,
};
for (const [file, pattern] of Object.entries(rejects)) {
  test(`rejects ${file}`, () => {
    const r = load(file);
    assert.equal(r.ok, false, `${file} was accepted`);
    assert.match(messages(r), pattern);
  });
}

test("rejects JSON text in a .csv file", () => {
  const r = parseImport("x.csv", 10, '[{"date":"2025-01-02"}]');
  assert.equal(r.ok, false);
  assert.match(messages(r), /looks like JSON/);
});

test("rejects oversized files before parsing", () => {
  const r = parseImport("big.csv", IMPORT_LIMITS.maxBytes + 1, "");
  assert.equal(r.ok, false);
  assert.match(messages(r), /limit is 5 MiB/);
});

test("rejects more than 20,000 rows (with and without a final newline)", () => {
  const rows = ["date,open,high,low,close,volume"];
  let d = Date.UTC(1950, 0, 1);
  for (let i = 0; i < IMPORT_LIMITS.maxRows + 1; i++, d += 86_400_000) rows.push(`${new Date(d).toISOString().slice(0, 10)},1,1,1,1,1`);
  for (const text of [rows.join("\n") + "\n", rows.join("\n")]) {
    const r = parseImport("many.csv", text.length, text);
    assert.equal(r.ok, false);
    assert.match(messages(r), /more than 20000 data rows/);
  }
  const ok = rows.slice(0, IMPORT_LIMITS.maxRows + 1).join("\n");
  assert.equal(parseImport("max.csv", ok.length, ok).ok, true);
});

test("CSV grammar errors are reported, never guessed", () => {
  for (const [text, pattern] of [
    ['date,open\n2025-01-02,1"0\n', /quote appears inside an unquoted field/],
    ['date,open\n2025-01-02,"10"x\n', /unexpected character after a closing quote/],
    ["date,open\r2025-01-02,1\r", /bare carriage return/],
    ["date,open,high,low,close,volume\n2025-01-02,1,1,1,1\n", /has 5 fields; the header has 6/],
    ["date,open,high,low,close,volume\n\n2025-01-02,1,1,1,1,1\n", /empty line inside the data/],
    ["date,open,open,low,close,volume\n", /repeats the column "open"/],
    ["date,open,high,low,close,volume\n", /no data rows/],
  ]) {
    const r = parseImport("g.csv", text.length, text);
    assert.equal(r.ok, false, JSON.stringify(text));
    assert.match(messages(r), pattern);
  }
});

test("numeric bounds and binary content", () => {
  const mk = (o, v = 1) => `date,open,high,low,close,volume\n2025-01-02,${o},${o},${o},${o},${v}\n`;
  for (const [text, pattern] of [
    [mk("2e9"), /exceeds/], [mk("0.0000001"), /below/], [mk("0"), /greater than 0/], [mk(1, -1), /volume is negative/], [mk(1, "1e16"), /exceeds/],
    [mk("Infinity"), /not a plain number/], [mk(" "), /is empty/], ["date,open\u0000\n", /not plain UTF-8/],
  ]) {
    const r = parseImport("n.csv", text.length, text);
    assert.equal(r.ok, false, JSON.stringify(text));
    assert.match(messages(r), pattern);
  }
});

test("OHLC consistency: each bound is checked on its own", () => {
  const row = (o, h, l, c) => `date,open,high,low,close,volume\n2025-01-02,${o},${h},${l},${c},1\n`;
  for (const [o, h, l, c] of [[10, 11, 9, 12], [12, 11, 9, 10], [10, 13, 11, 12], [12, 13, 11, 10], [10, 9, 11, 10]]) {
    const text = row(o, h, l, c);
    const r = parseImport("o.csv", text.length, text);
    assert.equal(r.ok, false, `accepted o=${o} h=${h} l=${l} c=${c}`);
    assert.match(messages(r), /inconsistent prices/);
  }
  const ok = row(10, 12, 9, 11);
  assert.equal(parseImport("o.csv", ok.length, ok).ok, true);
});

test("JSON shape errors", () => {
  for (const [text, pattern] of [
    ['{"date":"2025-01-02"}', /must be an array/],
    ["[1,2]", /each row must be an object/],
    ['[{"date":20250102,"open":1,"high":1,"low":1,"close":1,"volume":1}]', /not a valid YYYY-MM-DD/],
    ['[{"date":"2025-01-02","open":null,"high":1,"low":1,"close":1,"volume":1}]', /not null/],
  ]) {
    const r = parseImport("j.json", text.length, text);
    assert.equal(r.ok, false, text);
    assert.match(messages(r), pattern);
  }
});

test("issue list is bounded and marked as truncated", () => {
  const rows = ["date,open,high,low,close,volume"];
  for (let i = 0; i < 50; i++) rows.push(`2025-01-${String((i % 28) + 1).padStart(2, "0")},-1,1,1,1,1`);
  const r = parseImport("t.csv", 1, rows.join("\n"));
  assert.equal(r.ok, false);
  assert.equal(r.truncated, true);
  assert.equal(r.issues.length, IMPORT_LIMITS.maxIssues);
});

test("strict dates", () => {
  assert.equal(dateToTime("2024-02-29"), 1709164800);
  for (const s of ["2023-02-29", "2025-13-01", "2025-1-02", "2025/01/02", "02-01-2025", "1899-12-31", "2025-01-02T00:00"]) assert.equal(dateToTime(s), null, s);
});

test("BOM is accepted", () => {
  const text = "﻿date,open,high,low,close,volume\n2025-01-02,1,1,1,1,1\n";
  assert.equal(parseImport("b.csv", text.length, text).ok, true);
});
