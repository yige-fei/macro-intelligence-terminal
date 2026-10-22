# Import test fixtures

Every file here is **fictional**: the values come from a seeded random walk or were edited by hand. They contain no real market data.

| Group | Files |
|---|---|
| Valid | `valid_daily_250.csv` (250 weekday bars, 2024), `valid_daily_40.json` (40 bars), `short_15.csv` (too short for most indicators) |
| Valid, harder CSV | `quoted_crlf.csv`: CRLF line ends, mixed-case header, a quoted number, and an extra quoted column with commas and `""` escapes |
| Invalid | One defect each, as the file name says |

The privacy checks search for the first close of `valid_daily_250.csv` (`271.8281`). The browser tests generate the oversized and too-many-rows cases at run time.
