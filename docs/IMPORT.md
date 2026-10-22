# Importing your own price data

You can chart a daily price file from your own computer in the Market workspace. The file stays in your browser: it isn't uploaded, saved or sent anywhere.

## How to use it

1. Open **MARKET**.
2. In a chart panel, click **IMPORT LOCAL DATA** and choose one `.csv` or `.json` file.
3. If the file passes the checks, the chart shows it under the label **USER-IMPORTED DATA — LOCAL FILE**. All the usual chart tools work:
   - candles, bars, line and area charts;
   - indicators;
   - range buttons;
   - zoom (+/−) and dragging to pan.
4. If the file fails a check, a red box explains what's wrong and where (for example "row 4 (line 5): duplicate date 2025-02-05"). Nothing else changes: whatever the chart showed before stays.
5. To go back, click **DEMO SET** or **EVENT OVERLAY**. Your saved chart settings come back exactly as they were. Click **IMPORTED FILE** to return to your file without choosing it again.

Reloading the page forgets the file, and the chart returns to its saved demo dataset.

## What the file must look like

One row per day. These six fields are required:

| Field | What it is | Rules |
|---|---|---|
| `date` | the trading day | `YYYY-MM-DD`, a real calendar date (1900–2100). Every date must be later than the one before. |
| `open`, `high`, `low`, `close` | prices | Plain numbers from 0.000001 to 1,000,000,000. `high` must be at least `open` and `close`; `low` at most `open` and `close`. |
| `volume` | volume | A plain number, 0 or more (up to 10^15) |

**CSV example** (`.csv`):

```csv
date,open,high,low,close,volume
2025-01-02,100,105,98,103,120000
2025-01-03,103,106,101,104,115000
```

**JSON example** (`.json`):

```json
[
  { "date": "2025-01-02", "open": 100, "high": 105, "low": 98, "close": 103, "volume": 120000 },
  { "date": "2025-01-03", "open": 103, "high": 106, "low": 101, "close": 104, "volume": 115000 }
]
```

**CSV details:**
- Commas separate the fields, and the first line is the header. Header names can be in any letter case.
- Fields may be wrapped in double quotes; a quote inside a quoted field is written twice (`""`).
- LF or CRLF line endings are both fine.

**JSON details:** the file is a list of objects, and the numbers must be JSON numbers. `"100"` in quotes is text and is rejected.

**Extra columns or keys** (for example `adj close`) are ignored, and the success message lists them.

## Limits and what gets rejected

**Limits:** at most **5 MiB** and **20,000 rows**. The file must be plain UTF-8 text, and its content must match its extension.

The file is rejected, with the reason, if it has any of these:
- a missing column, an empty or unreadable value, text in a number field, or thousands separators such as `1,234`, currency signs or `NaN`;
- an impossible date (`2025-02-30`), a different date format (`02/01/2025`), or a repeated or out-of-order date;
- a price of 0 or less, or a high or low that doesn't enclose the open and close;
- a negative volume;
- broken CSV quoting, rows with the wrong number of fields, empty lines in the middle, or broken JSON.

**Nothing is repaired or guessed.** One bad row rejects the whole file, so you never see a silently altered chart. Up to 20 problems are listed at once.

**Short files are fine.** An indicator that needs more history than the file has (for example SMA200 needs 200 days) isn't drawn, and the chart says so.

## What the terminal does and doesn't check

**What it checks:**
- The file's structure: columns, dates, order.
- Whether the numbers are consistent with each other.

**What it doesn't check:**
- Whether the prices are **real, accurate or from the source you think**.
- Whether **you're allowed to use or share** the data.

The label "USER-IMPORTED DATA — LOCAL FILE" says exactly that. Importing a file into this terminal grants no licence to that data. Its own terms still apply.

**Other limits:**
- Prices are shown as supplied. There's no adjustment for splits or dividends, no currency conversion and no time-zone handling.
- One file at a time, daily bars only. This isn't a live market feed.
- Event markers from the Release Desk aren't shown on imported data.

## Privacy

**In the browser:**
- The file is read by your browser, through the file you chose, and kept in memory for that tab only.
- It isn't sent to the terminal's local server or to any other site.
- It isn't written to browser storage (localStorage, IndexedDB, cookies) and isn't added to the project.

**Saved settings:** chart settings you change while viewing your file aren't saved either. Your saved demo layout stays exactly as it was.

**What the tests show:** the browser tests import a fictional file, then check that no request is made and no browser storage contains the data. That's evidence for this app's own behaviour, not a guarantee about browser extensions or other software on your computer.

## For developers

**Parser and validator:** `web/lib/importData.ts`. Its unit tests run on Node ≥ 22.18, which loads TypeScript natively:

```bash
node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON tests/import/import.test.mjs
```

**State:** `web/store/imported.ts` is a non-persisted in-memory store.

**Fixtures:** fictional, in `tests/fixtures/import/`.

**Browser checks:** I1–I12 in `tests/browser/smoke.mjs`. They drive the real file chooser, then check:
- the labels;
- the chart tools;
- rejected files and their messages;
- that the saved layout is unchanged;
- the privacy behaviour (no requests, no storage);
- switching back to the demos, and reloading.
